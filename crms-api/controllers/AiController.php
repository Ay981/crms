<?php

declare(strict_types=1);

require_once ROOT . '/models/Car.php';
require_once ROOT . '/models/Review.php';

class AiController extends Controller
{
    // POST /ai/recommend  — smart car recommender
    public function recommend(): void
    {
        $data   = $this->body();
        $prompt = trim($data['prompt'] ?? '');

        if (empty($prompt)) {
            $this->error('Prompt is required', 422);
        }

        $cars = DB::table('cars')
            ->select(['id', 'brand', 'model', 'year', 'category',
                       'seats', 'transmission', 'daily_rate', 'average_rating', 'description'])
            ->where('status', 'available')
            ->get();

        if (empty($cars)) {
            $this->success(['reply' => 'Sorry, there are no available cars at the moment. Please check back soon!']);
        }

        $catalog = implode("\n", array_map(
            fn($car) =>
                "ID:{$car['id']} | {$car['brand']} {$car['model']} ({$car['year']}) | " .
                "{$car['category']} | {$car['seats']} seats | {$car['transmission']} | " .
                "\${$car['daily_rate']}/day | Rating: {$car['average_rating']}/5" .
                ($car['description'] ? " | {$car['description']}" : ''),
            $cars
        ));

        $system = "You are a friendly car rental assistant for CRMS Car Rentals.
Based on the customer's request, recommend the most suitable cars from our available fleet.
Always reference cars by their ID and full name (e.g. 'Car #3 - Toyota Corolla').
Explain briefly WHY each car suits their needs.
Recommend 1-3 cars maximum.
If nothing matches well, say so honestly and suggest what to look for.
Keep your response conversational and helpful, under 200 words.

Available fleet:
{$catalog}";

        $reply = $this->callGemini($system, [['role' => 'user', 'content' => $prompt]]);
        $this->success(['reply' => $reply]);
    }

    // POST /ai/chat  — general booking assistant with conversation history
    public function chat(): void
    {
        $data    = $this->body();
        $message = trim($data['message'] ?? '');
        $history = $data['history'] ?? [];

        if (empty($message)) {
            $this->error('Message is required', 422);
        }

        $cars = DB::table('cars')
            ->select(['id', 'brand', 'model', 'year', 'category',
                       'seats', 'transmission', 'daily_rate', 'average_rating', 'description',  'penalty_rate'])
            ->where('status', 'available')
            ->get();

        $catalog = empty($cars) ? 'No cars available.' : implode("\n", array_map(
            fn($car) =>
                "ID:{$car['id']} | {$car['brand']} {$car['model']} ({$car['year']}) | " .
                "{$car['category']} | {$car['seats']} seats | {$car['transmission']} | " .
                "\${$car['daily_rate']}/day | Rating: {$car['average_rating']}/5 | " .
    
                "Late penalty: \${$car['penalty_rate']}/day",
            $cars
        ));

        $system = "You are a helpful assistant for CRMS Car Rentals.
Help customers with questions about bookings, availability, policies, pricing, and choosing cars.
Based on the customer's request, you can recommend suitable cars from our fleet.
Always reference cars by their ID and full name (e.g. 'Car #3 - Toyota Corolla').
Be concise, friendly, and professional. Keep answers under 150 words.
Do not invent prices or policies. If unsure, say so honestly.

Available fleet:
{$catalog}";

        $messages = [];
        foreach ($history as $msg) {
            if (isset($msg['role'], $msg['content'])) {
                $messages[] = [
                    'role'    => $msg['role'] === 'assistant' ? 'assistant' : 'user',
                    'content' => substr((string) $msg['content'], 0, 500), // cap history length
                ];
            }
        }
        $messages[] = ['role' => 'user', 'content' => $message];

        $reply = $this->callGemini($system, $messages);
        $this->success(['reply' => $reply]);
    }

    // GET /ai/reviews/:carId/summary  — summarise reviews for a car
    public function summarizeReviews(string $carId): void
    {
        $car = DB::table('cars')->where('id', (int) $carId)->first();
        if (!$car) {
            $this->error('Car not found', 404);
        }

        $reviews = DB::table('reviews')
            ->select(['rating', 'comment'])
            ->where('car_id', (int) $carId)
            ->get();

        $withComments = array_filter($reviews, fn($r) => !empty(trim($r['comment'] ?? '')));

        if (count($reviews) < 3) {
            $this->success(['summary' => 'Not enough reviews yet to generate a summary.']);
        }

        $reviewText = implode("\n", array_map(
            fn($r) => "Rating: {$r['rating']}/5 — {$r['comment']}",
            array_slice(array_values($withComments), 0, 20) // cap at 20 reviews
        ));

        $system = "You summarise customer reviews for a car rental listing.
Write 2-3 sentences maximum.
Start with what customers love, then mention any common complaints if present.
Keep a neutral, factual tone. Do not use bullet points.";

        $messages = [[
            'role'    => 'user',
            'content' => "Summarise these reviews for the {$car['brand']} {$car['model']}:\n\n{$reviewText}",
        ]];

        $summary = $this->callGemini($system, $messages);
        $this->success(['summary' => $summary]);
    }

    // ── Private: call Gemini API via cURL ────────────────────────────────

    private function callGemini(string $system, array $messages): string
    {
        $apiKey = env('GEMINI_API_KEY', '');
        if (empty($apiKey) || $apiKey === 'your_key_here') {
            return 'AI assistant is not configured yet. Please set GEMINI_API_KEY in your .env file.';
        }

        $contents = [];
        foreach ($messages as $message) {
            $role = $message['role'] === 'assistant' ? 'model' : 'user';
            $contents[] = [
                'role'  => $role,
                'parts' => [[
                    'text' => (string) $message['content'],
                ]],
            ];
        }

        $payload = json_encode([
            'systemInstruction' => [
                'parts' => [[
                    'text' => $system,
                ]],
            ],
            'contents' => $contents,
            'generationConfig' => [
                'temperature'     => 0.5,
                'maxOutputTokens'  => 512,
            ],
        ]);

        $ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'x-goog-api-key: ' . $apiKey,
            ],
        ]);

        

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

        if (!$response || $httpCode !== 200) {
            throw new RuntimeException("AI service returned HTTP {$httpCode}");
        }

        $data = json_decode($response, true);
        return $data['candidates'][0]['content']['parts'][0]['text'] ?? 'Sorry, I could not generate a response.';
    }
}