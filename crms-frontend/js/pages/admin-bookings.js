(() => {
	const UI = window.AdminUI;
	UI.init('bookings');
	let bookings = [];
	let activeStatus = 'all';
	let returnBooking = null;
	let returnStep = 'details';

	const body = document.getElementById('bookings-table');
	const search = document.getElementById('booking-search');
	const modal = document.getElementById('return-modal');
	const form = document.getElementById('return-form');
	const condition = document.getElementById('return-condition');
	const backButton = document.querySelector('[data-return-back]');
	const nextButton = document.querySelector('[data-return-next]');
	const submitButton = document.querySelector('[data-return-submit]');
	const confirmList = document.querySelector('[data-return-confirm]');
	const lateAlert = document.getElementById('return-late-alert');

	function syncReturnActions(step) {
		nextButton.textContent = 'Continue';
		submitButton.textContent = 'Confirm return';

		if (step === 'confirm') {
			nextButton.hidden = true;
			nextButton.style.display = 'none';
			submitButton.hidden = false;
			submitButton.style.display = '';
			return;
		}

		nextButton.hidden = false;
		nextButton.style.display = '';
		submitButton.hidden = true;
		submitButton.style.display = 'none';
	}

	function normalizeStatus(status) {
		return status === 'completed' ? 'returned' : status;
	}

	function updateStats() {
		UI.setText('bookings-total', bookings.length);
		UI.setText('bookings-pending', bookings.filter(b => b.status === 'pending').length);
		UI.setText('bookings-active', bookings.filter(b => ['active', 'confirmed'].includes(b.status)).length);
		UI.setText('bookings-returned', bookings.filter(b => b.status === 'completed').length);
	}

	function filtered() {
		const q = search.value.trim().toLowerCase();
		return bookings.filter(booking => {
			const statusOk = activeStatus === 'all' ||
				booking.status === activeStatus ||
				(activeStatus === 'active' && booking.status === 'confirmed');
			const haystack = `${booking.customer_name} ${booking.customer_email} ${booking.brand} ${booking.model} ${booking.reference_number}`.toLowerCase();
			return statusOk && (!q || haystack.includes(q));
		});
	}

	function actions(booking) {
		if (booking.status === 'pending') {
			return `<button class="admin-btn primary" data-confirm="${booking.id}">Confirm</button>`;
		}
		if (['active', 'confirmed'].includes(booking.status)) {
			return `<button class="admin-btn" data-return="${booking.id}">Log return</button>`;
		}
		return '<span class="tone-muted">—</span>';
	}

	function render() {
		const rows = filtered();
		body.innerHTML = rows.length ? rows.map(booking => `
			<tr>
				<td class="tone-muted">#${UI.escape(booking.reference_number || booking.id)}</td>
				<td><strong class="truncate">${UI.escape(booking.customer_name)}</strong></td>
				<td>${UI.escape(booking.brand)} ${UI.escape(booking.model)}</td>
				<td>${UI.date(booking.start_date)}</td>
				<td>${UI.date(booking.end_date)}</td>
				<td><strong>${UI.money(booking.final_total)}</strong></td>
				<td>${UI.status(normalizeStatus(booking.status))}</td>
				<td><div class="admin-row-actions">${actions(booking)}</div></td>
			</tr>
		`).join('') : `<tr><td colspan="8">${UI.empty('No bookings match those filters.')}</td></tr>`;
	}

	async function load() {
		try {
			const res = await window.API.allBookings({ page: 1 });
			bookings = UI.unwrap(res).items;
			updateStats();
			render();
		} catch (error) {
			console.error(error);
			body.innerHTML = `<tr><td colspan="8">${UI.empty(`Unable to load bookings: ${UI.escape(error.message)}`)}</td></tr>`;
		}
	}

	function openReturn(id) {
		returnBooking = bookings.find(booking => String(booking.id) === String(id));
		if (!returnBooking) return;
		document.getElementById('return-summary').innerHTML = `
			<div class="return-summary-thumb" aria-hidden="true"></div>
			<div>
				<strong>${UI.escape(returnBooking.brand)} ${UI.escape(returnBooking.model)}</strong>
				<p>${UI.escape(returnBooking.customer_name)} · ${UI.date(returnBooking.start_date, { year: false })} → ${UI.date(returnBooking.expected_return_date || returnBooking.end_date)}</p>
				<span>${UI.escape(returnBooking.reference_number || `#${returnBooking.id}`)}</span>
			</div>`;
		const returnDateInput = document.getElementById('actual-return-date');
		const today = new Date().toISOString().slice(0, 10);
		const startDate = String(returnBooking.start_date).slice(0, 10);
		returnDateInput.min = startDate;
		returnDateInput.value = today < startDate ? startDate : today;
		document.getElementById('actual-return-time').value = new Date().toTimeString().slice(0, 5);
		setCondition('excellent');
		setReturnStep('details');
		modal.showModal();
	}

	function lateFee() {
		if (!returnBooking) return { lateDays: 0, penalty: 0 };
		const actualValue = document.getElementById('actual-return-date').value;
		const expectedValue = returnBooking.expected_return_date || returnBooking.end_date;
		const actual = new Date(`${actualValue}T00:00:00`);
		const expected = new Date(`${String(expectedValue).slice(0, 10)}T00:00:00`);
		const lateDays = Number.isNaN(actual.getTime()) || Number.isNaN(expected.getTime())
			? 0
			: Math.max(0, Math.round((actual - expected) / 86400000));
		const penalty = lateDays * Number(returnBooking.penalty_rate || 0);
		return { lateDays, penalty };
	}

	function returnChargePreview(actualReturnDate) {
		if (!returnBooking) {
			return { baseTotal: 0, discount: 0, penalty: 0, finalTotal: 0, earlyDays: 0 };
		}

		const expectedValue = returnBooking.expected_return_date || returnBooking.end_date;
		const actual = new Date(`${actualReturnDate}T00:00:00`);
		const expected = new Date(`${String(expectedValue).slice(0, 10)}T00:00:00`);
		const start = new Date(`${String(returnBooking.start_date).slice(0, 10)}T00:00:00`);
		const { penalty } = lateFee();
		const originalBase = Number(returnBooking.base_total || 0);
		const originalDiscount = Number(returnBooking.discount_amount || 0);
		const discountRate = originalBase > 0 ? originalDiscount / originalBase : 0;

		if (Number.isNaN(actual.getTime()) || Number.isNaN(expected.getTime()) || actual >= expected) {
			const baseTotal = originalBase || Number(returnBooking.final_total || 0) + originalDiscount;
			return {
				baseTotal,
				discount: originalDiscount,
				penalty,
				finalTotal: baseTotal - originalDiscount + penalty,
				earlyDays: 0,
			};
		}

		const earlyDays = Math.max(1, Math.ceil((actual - start) / 86400000));
		const baseTotal = Number(returnBooking.daily_rate || 0) * earlyDays;
		const discount = baseTotal * discountRate;
		return {
			baseTotal,
			discount,
			penalty,
			finalTotal: baseTotal - discount + penalty,
			earlyDays,
		};
	}

	function updateLateAlert() {
		const { lateDays, penalty } = lateFee();
		if (!lateDays) {
			lateAlert.hidden = true;
			lateAlert.textContent = '';
			return;
		}
		lateAlert.hidden = false;
		lateAlert.textContent = `Return is ${lateDays} day${lateDays === 1 ? '' : 's'} late. Penalty rate applies: ${UI.money(penalty)} added.`;
	}

	function setCondition(value) {
		condition.value = value;
		document.querySelectorAll('[data-condition-value]').forEach(card => {
			card.classList.toggle('active', card.dataset.conditionValue === value);
		});
		updateLateAlert();
	}

	function buildConfirmation() {
		if (!returnBooking || !confirmList) return;
		const formData = Object.fromEntries(new FormData(form).entries());
		const { lateDays, penalty } = lateFee();
		const charge = returnChargePreview(formData.actual_return_date);
		const repairEstimate = formData.condition === 'damaged' ? Number(formData.repair_cost || 0) : 0;
		const finalTotal = charge.finalTotal + repairEstimate;
		const rows = [
			['Booking ref', returnBooking.reference_number || `#${returnBooking.id}`],
			['Customer', returnBooking.customer_name],
			['Vehicle', `${returnBooking.brand} ${returnBooking.model}`],
			['Actual return date', `${UI.date(formData.actual_return_date)}${formData.actual_return_time ? ` at ${formData.actual_return_time}` : ''}`],
			['Condition', formData.condition],
			['Rental charge', UI.money(charge.baseTotal)],
			['Discount', charge.discount ? `- ${UI.money(charge.discount)}` : UI.money(0)],
			['Late penalty', lateDays ? `+ ${UI.money(penalty)}` : UI.money(0)],
			['Grand total', UI.money(finalTotal)],
		];
		if (formData.condition === 'damaged') {
			rows.splice(6, 0, ['Repair estimate', UI.money(repairEstimate)]);
		}
		confirmList.innerHTML = rows.map(([label, value]) => `<div><dt>${UI.escape(label)}</dt><dd>${UI.escape(value)}</dd></div>`).join('');
	}

	function setReturnStep(step) {
		returnStep = step;
		document.querySelectorAll('[data-return-panel]').forEach(panel => {
			panel.classList.toggle('active', panel.dataset.returnPanel === step);
		});
		const order = ['details', 'damage', 'confirm'];
		const currentIndex = order.indexOf(step);
		document.querySelectorAll('[data-return-step-indicator]').forEach(indicator => {
			const index = order.indexOf(indicator.dataset.returnStepIndicator);
			indicator.classList.toggle('active', index === currentIndex);
			indicator.classList.toggle('done', index < currentIndex || (step === 'confirm' && indicator.dataset.returnStepIndicator === 'damage' && condition.value !== 'damaged'));
			indicator.classList.toggle('skipped', indicator.dataset.returnStepIndicator === 'damage' && condition.value !== 'damaged');
		});
		backButton.textContent = step === 'details' ? 'Close' : 'Back';
		syncReturnActions(step);
		updateLateAlert();
		if (step === 'confirm') buildConfirmation();
	}

	document.querySelector('[data-booking-tabs]')?.addEventListener('click', event => {
		const btn = event.target.closest('[data-status]');
		if (!btn) return;
		activeStatus = btn.dataset.status;
		document.querySelectorAll('[data-status]').forEach(tab => tab.classList.toggle('active', tab === btn));
		render();
	});

	search?.addEventListener('input', render);
	document.getElementById('actual-return-date')?.addEventListener('change', updateLateAlert);
	document.querySelectorAll('[data-condition-value]').forEach(card => {
		card.addEventListener('click', () => setCondition(card.dataset.conditionValue));
	});
	document.querySelectorAll('[data-close-return]').forEach(btn => btn.addEventListener('click', () => modal.close()));
	modal?.addEventListener('close', () => {
		syncReturnActions('details');
	});
	backButton?.addEventListener('click', () => {
		if (returnStep === 'details') {
			modal.close();
			return;
		}
		setReturnStep(returnStep === 'confirm' && condition.value === 'damaged' ? 'damage' : 'details');
	});
	nextButton?.addEventListener('click', () => {
		if (!form.reportValidity()) return;
		if (returnStep === 'details') {
			setReturnStep(condition.value === 'damaged' ? 'damage' : 'confirm');
			return;
		}
		if (returnStep === 'damage') {
			const damageDescription = document.getElementById('damage-description');
			if (!damageDescription.value.trim()) {
				damageDescription.focus();
				UI.toast('Damage description is required');
				return;
			}
			setReturnStep('confirm');
		}
	});

	body?.addEventListener('click', async event => {
		const confirm = event.target.closest('[data-confirm]');
		const ret = event.target.closest('[data-return]');
		if (confirm) {
			try {
				await window.API.confirmBooking(confirm.dataset.confirm);
				UI.toast('Booking confirmed');
				await load();
			} catch (error) {
				UI.toast(error.message);
			}
		}
		if (ret) openReturn(ret.dataset.return);
	});

	form?.addEventListener('submit', async event => {
		event.preventDefault();
		if (!returnBooking) return;
		const data = Object.fromEntries(new FormData(form).entries());
		delete data.actual_return_time;
		delete data.damage_severity;
		if (data.condition !== 'damaged') {
			delete data.damage_description;
			delete data.repair_cost;
		}
		try {
			await window.API.returnBooking(returnBooking.id, data);
			modal.close();
			UI.toast('Return logged');
			await load();
		} catch (error) {
			// Show error message, which includes validation errors from backend
			const message = error.message || 'Failed to log return';
			console.error('[return] Error details:', error);
			UI.toast(message);
		}
	});

	document.querySelector('[data-export-bookings]')?.addEventListener('click', () => UI.toast('CSV export is ready to wire to a backend export endpoint.'));
	load();
})();
