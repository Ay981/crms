<?php

declare(strict_types=1);

require_once ROOT . '/models/Booking.php';
require_once ROOT . '/models/Car.php';
require_once ROOT . '/models/Promo.php';
require_once ROOT . '/models/User.php';

class BookingController extends Controller
{
    // POST /bookings
    public function store(): void
    {
        $data   = $this->body();
        $errors = Validator::make($data, [
            'car_id'     => 'required|integer',
            'start_date' => 'required|date',
            'end_date'   => 'required|date',
        ]);

        if ($errors) {
            $this->error('Validation failed', 422, $errors);
        }

        $start = $data['start_date'];
        $end   = $data['end_date'];
        $days  = daysBetween($start, $end);

        if (strtotime($start) < strtotime('today')) {
            $this->error('Start date cannot be in the past', 422);
        }
        if (strtotime($end) <= strtotime($start)) {
            $this->error('End date must be after start date', 422);
        }
        if ($days < 1) {
            $this->error('Minimum rental is 1 day', 422);
        }

        $user = User::find($this->userId());
        if (!$user || (int) $user['license_verified'] !== 1) {
            $this->error('Your driver license must be verified before booking', 403);
        }

        DB::beginTransaction();

        try {
            // Lock car row — prevents race conditions on simultaneous bookings
            $car = DB::table('cars')
                ->where('id', (int) $data['car_id'])
                ->lockForUpdate()
                ->first();

            if (!$car) {
                DB::rollback();
                $this->error('Car not found', 404);
            }
            if ($car['status'] === 'maintenance') {
                DB::rollback();
                $this->error('This car is currently under maintenance', 422);
            }
            // Overlap check: existing booking overlaps if start < new_end AND end > new_start
            $conflict = DB::table('bookings')
                ->where('car_id', (int) $data['car_id'])
                ->whereIn('status', ['pending', 'confirmed', 'active'])
                ->where('start_date', '<', $end)
                ->where('end_date', '>', $start)
                ->first();

            if ($conflict) {
                DB::rollback();
                $this->error('Car is not available for the selected dates', 422);
            }

            // Promo code (optional)
            $discount  = 0;
            $promoId   = null;

            if (!empty($data['promo_code'])) {
                $promo = DB::table('promos')
                    ->where('code', trim($data['promo_code']))
                    ->where('active', 1)
                    ->lockForUpdate()
                    ->first();

                if (!$promo) {
                    DB::rollback();
                    $this->error('Invalid promo code', 422);
                }
                if (strtotime($promo['valid_from']) > time() || strtotime($promo['valid_until']) < time()) {
                    DB::rollback();
                    $this->error('Promo code has expired or is not yet active', 422);
                }
                if ($promo['times_used'] >= $promo['max_uses']) {
                    DB::rollback();
                    $this->error('Promo code has reached its usage limit', 422);
                }

                $discount = (int) $promo['discount_percentage'];
                $promoId  = (int) $promo['id'];

                // Increment usage atomically
                DB::table('promos')
                    ->where('id', $promoId)
                    ->update(['times_used' => $promo['times_used'] + 1]);
            }

            // Calculate totals — always server-side, never trust the client
            $baseTotal    = round((float) $car['daily_rate'] * $days, 2);
            $discountAmt  = round($baseTotal * $discount / 100, 2);
            $finalTotal   = round($baseTotal - $discountAmt, 2);

            $booking = Booking::create([
                'user_id'              => $this->userId(),
                'car_id'               => (int) $car['id'],
                'promo_id'             => $promoId,
                'reference_number'     => generateRef(),
                'start_date'           => $start,
                'end_date'             => $end,
                'expected_return_date' => $end,
                'status'               => 'pending',
                'base_total'           => $baseTotal,
                'discount_amount'      => $discountAmt,
                'final_total'          => $finalTotal,
            ]);

            DB::commit();
            $this->success($booking, 'Booking created successfully', 201);
        } catch (Throwable $e) {
            DB::rollback();
            throw $e;
        }
    }

    // GET /bookings/mine
    public function mine(): void
    {
        $page = max(1, (int) ($_GET['page'] ?? 1));

        $bookings = DB::table('bookings')
            ->select([
                'bookings.*',
                'cars.brand',
                'cars.model',
                'cars.year',
                'cars.image_url',
                'cars.category',
                'cars.seats',
                'cars.transmission',
                'cars.penalty_rate',
            ])
            ->join('cars', 'bookings.car_id', 'cars.id')
            ->where('bookings.user_id', $this->userId())
            ->orderBy('bookings.created_at', 'DESC')
            ->paginate(10, $page);

        $this->success($bookings);
    }

    // DELETE /bookings/:id
    public function cancel(string $id): void
    {
        $booking = Booking::find((int) $id);

        if (!$booking) {
            $this->error('Booking not found', 404);
        }
        if ((int) $booking['user_id'] !== $this->userId()) {
            $this->error('You can only cancel your own bookings', 403);
        }
        if (!in_array($booking['status'], ['pending', 'confirmed'], true)) {
            $this->error('Only pending or confirmed bookings can be cancelled', 422);
        }

        DB::table('bookings')->where('id', (int) $id)->update(['status' => 'cancelled']);

        // Free up the car
        DB::table('cars')
            ->where('id', (int) $booking['car_id'])
            ->where('status', 'rented')
            ->update(['status' => 'available']);

        $this->success(null, 'Booking cancelled successfully');
    }

    // PUT /bookings/:id/extend
    public function extend(string $id): void
    {
        $data    = $this->body();
        $errors  = Validator::make($data, [
            'new_end_date' => 'required|date',
            'condition'    => 'required|in:good,excellent,damaged',
        ]);
        if ($errors) {
            $this->error('Validation failed', 422, $errors);
        }
        if ($data['condition'] === 'damaged' && trim((string) ($data['damage_description'] ?? '')) === '') {
            $this->error('Damage description is required when the vehicle is marked damaged', 422);
        }

        $booking = Booking::find((int) $id);
        if (!$booking) {
            $this->error('Booking not found', 404);
        }
        if ((int) $booking['user_id'] !== $this->userId()) {
            $this->error('Forbidden', 403);
        }
        if ($booking['status'] !== 'active') {
            $this->error('Only active bookings can be extended', 422);
        }
        if (strtotime($data['new_end_date']) <= strtotime($booking['end_date'])) {
            $this->error('New end date must be after current end date', 422);
        }

        // Check no conflict in the extended period
        $conflict = DB::table('bookings')
            ->where('car_id', (int) $booking['car_id'])
            ->where('id', '!=', (int) $id)
            ->whereIn('status', ['pending', 'confirmed', 'active'])
            ->where('start_date', '<', $data['new_end_date'])
            ->where('end_date', '>', $booking['end_date'])
            ->first();

        if ($conflict) {
            $this->error('Car is already booked during the extended period', 422);
        }

        $car      = Car::find((int) $booking['car_id']);
        $newDays  = daysBetween($booking['start_date'], $data['new_end_date']);
        $newBase  = round((float) $car['daily_rate'] * $newDays, 2);
        $newFinal = round($newBase - (float) $booking['discount_amount'], 2);

        DB::table('bookings')->where('id', (int) $id)->update([
            'end_date'             => $data['new_end_date'],
            'expected_return_date' => $data['new_end_date'],
            'base_total'           => $newBase,
            'final_total'          => $newFinal,
        ]);

        $this->success(Booking::find((int) $id), 'Booking extended successfully');
    }

    // GET /bookings  (admin)
    public function index(): void
    {
        $page = max(1, (int) ($_GET['page'] ?? 1));

        $query = DB::table('bookings')
            ->select([
                'bookings.*',
                'cars.brand',
                'cars.model',
                'cars.image_url',
                'cars.daily_rate',
                'cars.penalty_rate',
                'users.name as customer_name',
                'users.email as customer_email',
            ])
            ->join('cars', 'bookings.car_id', 'cars.id')
            ->join('users', 'bookings.user_id', 'users.id')
            ->orderBy('bookings.created_at', 'DESC');

        if (!empty($_GET['status'])) {
            $query = $query->where('bookings.status', $_GET['status']);
        }

        $this->success($query->paginate(15, $page));
    }

    // PUT /bookings/:id/confirm  (admin)
    public function confirm(string $id): void
    {
        $booking = Booking::find((int) $id);

        if (!$booking) {
            $this->error('Booking not found', 404);
        }
        if ($booking['status'] !== 'pending') {
            $this->error('Only pending bookings can be confirmed', 422);
        }

        DB::table('bookings')->where('id', (int) $id)->update(['status' => 'confirmed']);
        DB::table('cars')->where('id', (int) $booking['car_id'])->update(['status' => 'rented']);

        $this->success(Booking::find((int) $id), 'Booking confirmed');
    }

    // PUT /bookings/:id/return  (admin)
    public function logReturn(string $id): void
    {
        $data   = $this->body();
        $errors = Validator::make($data, [
            'actual_return_date' => 'required|date',
            'condition'          => 'required|in:good,excellent,damaged',
        ]);
        if ($errors) {
            $this->error('Validation failed: ' . implode('; ', $errors), 422, $errors);
        }

        $booking = Booking::find((int) $id);
        if (!$booking) {
            $this->error('Booking not found', 404);
        }
        if (!in_array($booking['status'], ['confirmed', 'active'], true)) {
            $this->error('Only confirmed or active bookings can be returned. Current status: ' . $booking['status'], 422);
        }

        if (strtotime($data['actual_return_date']) < strtotime($booking['start_date'])) {
            $this->error('Actual return date cannot be before the booking start date', 422);
        }

        DB::beginTransaction();

        try {
            $car = DB::table('cars')
                ->where('id', (int) $booking['car_id'])
                ->lockForUpdate()
                ->first();

            if (!$car) {
                DB::rollback();
                $this->error('Car not found', 404);
            }

            $expected = strtotime($booking['expected_return_date']);
            $actual   = strtotime($data['actual_return_date']);
            $lateDays = max(0, (int) round(($actual - $expected) / 86400));
            $penalty  = round($lateDays * (float) $car['penalty_rate'], 2);

            $isEarlyReturn = $actual < $expected;
            $billableEnd   = $isEarlyReturn ? $data['actual_return_date'] : $booking['end_date'];
            $billableDays  = max(1, daysBetween($booking['start_date'], $billableEnd));
            $discountRate  = (float) $booking['base_total'] > 0
                ? (float) $booking['discount_amount'] / (float) $booking['base_total']
                : 0.0;
            $baseTotal     = $isEarlyReturn
                ? round((float) $car['daily_rate'] * $billableDays, 2)
                : (float) $booking['base_total'];
            $discountAmt   = $isEarlyReturn
                ? round($baseTotal * $discountRate, 2)
                : (float) $booking['discount_amount'];
            $final         = round($baseTotal - $discountAmt + $penalty, 2);

            DB::table('bookings')->where('id', (int) $id)->update([
                'end_date'           => $isEarlyReturn ? $data['actual_return_date'] : $booking['end_date'],
                'actual_return_date' => $data['actual_return_date'],
                'condition'          => $data['condition'],
                'base_total'         => $baseTotal,
                'discount_amount'    => $discountAmt,
                'penalty_amount'     => $penalty,
                'final_total'        => $final,
                'status'             => 'completed',
            ]);

            // Car status based on condition
            $newCarStatus = $data['condition'] === 'damaged' ? 'maintenance' : 'available';
            DB::table('cars')->where('id', (int) $car['id'])->update(['status' => $newCarStatus]);

            // Create damage report if needed
            if ($data['condition'] === 'damaged') {
                DB::table('damage_reports')->insert([
                    'booking_id'  => (int) $id,
                    'car_id'      => (int) $car['id'],
                    'description' => $data['damage_description'] ?? 'Damage reported on return',
                    'repair_cost' => (float) ($data['repair_cost'] ?? 0),
                    'resolved'    => 0,
                ]);
            }

            // Notify everyone waiting for this car once it can be booked again.
            if ($newCarStatus === 'available') {
                DB::table('waitlist')
                    ->where('car_id', (int) $car['id'])
                    ->where('notified', 0)
                    ->update(['notified' => 1]);
            }

            DB::commit();
        } catch (Throwable $e) {
            DB::rollback();
            throw $e;
        }

        $this->success(Booking::find((int) $id), 'Return logged successfully');
    }
}
