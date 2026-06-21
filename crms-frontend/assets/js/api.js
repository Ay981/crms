(() => {
	function resolveBaseUrl() {
		const explicitBaseUrl =
			window.CRMS_API_BASE_URL ||
			localStorage.getItem('CRMS_API_BASE_URL');

		if (explicitBaseUrl) {
			return explicitBaseUrl;
		}

		const { protocol, hostname, port, origin } = window.location;
		const isLocalDevHost = hostname === 'localhost' || hostname === '127.0.0.1';
		const isStaticDevServer = isLocalDevHost && ['5500', '5173', '3000'].includes(port);

		// Match the API host to the page host so the session cookie (SameSite=Lax)
		// is treated as same-site and gets sent. localhost:5500 -> localhost:8082,
		// 127.0.0.1:5500 -> 127.0.0.1:8082. Mixing the two breaks auth.
		if (isStaticDevServer) {
			return `${protocol}//${hostname}:8082`;
		}

		if (protocol === 'file:') {
			return 'http://127.0.0.1:8082';
		}
	

		if (protocol === 'http:' || protocol === 'https:') {
			return `${origin}/api`;
		}

		return 'http://127.0.0.1:8082';
	}

	const configuredBaseUrl = resolveBaseUrl();

	let csrfToken = null;

	function clearCsrfToken() {
		csrfToken = null;
	}

	async function getCsrfToken() {
		if (csrfToken) return csrfToken;
		try {
			const res = await fetch(`${configuredBaseUrl}/auth/csrf`, { credentials: 'include' });
			const payload = await res.json();
			if (payload && payload.data && payload.data.csrf_token) {
				csrfToken = payload.data.csrf_token;
			}
		} catch (e) {
			console.error('Failed to fetch CSRF token', e);
		}
		return csrfToken;
	}

	async function request(path, options = {}) {
		const isFormData = options.body instanceof FormData;
		const method = (options.method || 'GET').toUpperCase();
		
		let csrfHeaders = {};
		if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
			const token = await getCsrfToken();
			if (token) {
				csrfHeaders['X-CSRF-Token'] = token;
			}
		}

		const response = await fetch(`${configuredBaseUrl}${path}`, {
			credentials: 'include',
			headers: {
				...(isFormData ? {} : { 'Content-Type': 'application/json' }),
				...csrfHeaders,
				...(options.headers || {}),
			},
			...options,
		});

		let payload = null;
		try {
			payload = await response.json();
		} catch {
			payload = { success: false, message: 'Invalid server response' };
		}

		if (response.status === 401) {
			window.dispatchEvent(new CustomEvent('crms:unauthorized'));
		}

		if (!response.ok || payload?.success === false) {
			const message = payload?.message || `Request failed (${response.status})`;
			throw new Error(message);
		}

		return payload;
	}

	const API = {
		baseUrl: configuredBaseUrl,
		request,
		resolveUrl(url) {
			if (!url) {
				return '';
			}
			if (/^https?:\/\//i.test(url) || url.startsWith('data:')) {
				return url;
			}
			return `${configuredBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
		},
		login(email, password, rememberMe = false) {
			return request('/auth/login', {
				method: 'POST',
				body: JSON.stringify({ email, password, remember_me: rememberMe }),
			}).then((res) => {
				clearCsrfToken();
				return res;
			});
		},
		register(data) {
			return request('/auth/register', {
				method: 'POST',
				body: JSON.stringify(data),
			});
		},
		uploadImage(file, type = 'car') {
			const formData = new FormData();
			formData.append('image', file);
			formData.append('type', type);

			return request('/upload/image', {
				method: 'POST',
				body: formData,
			});
		},
		async me() {
                        const res = await request('/auth/me', { method: 'GET' });
                        if (res && res.data && res.data.has_notification) {
                                window.UIUtils?.showNotificationBanner?.(res.data.notification_car);
                        }
                        return res;
                },
		logout() {
			return request('/auth/logout', { method: 'POST' }).then((res) => {
				clearCsrfToken();
				return res;
			});
		},
		cars(params = {}) {
			const query = new URLSearchParams();
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== '') {
					query.set(key, value);
				}
			});

			return request(`/cars${query.toString() ? `?${query}` : ''}`, { method: 'GET' });
		},
		car(carId) {
			return request(`/cars/${carId}`, { method: 'GET' });
		},
		carAvailability(carId) {
			return request(`/cars/${carId}/availability`, { method: 'GET' });
		},
		createBooking(data) {
			return request('/bookings', {
				method: 'POST',
				body: JSON.stringify(data),
			});
		},
		myBookings(params = {}) {
			const query = new URLSearchParams();
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== '') {
					query.set(key, value);
				}
			});

			return request(`/bookings/mine${query.toString() ? `?${query}` : ''}`, { method: 'GET' });
		},
		cancelBooking(bookingId) {
			return request(`/bookings/${bookingId}`, { method: 'DELETE' });
		},
		extendBooking(bookingId, newEndDate) {
			return request(`/bookings/${bookingId}/extend`, {
				method: 'PUT',
				body: JSON.stringify({ new_end_date: newEndDate }),
			});
		},
		validatePromo(code) {
			return request('/promos/validate', {
				method: 'POST',
				body: JSON.stringify({ code }),
			});
		},
		favourites() {
			return request('/favourites', { method: 'GET' });
		},
		waitlistMine() {
			return request('/waitlist/mine', { method: 'GET' });
		},
		addFavourite(carId) {
			return request(`/favourites/${carId}`, { method: 'POST' });
		},
		removeFavourite(carId) {
			return request(`/favourites/${carId}`, { method: 'DELETE' });
		},
		joinWaitlist(carId) {
                        return request(`/waitlist/${carId}`, { method: 'POST' });
                },
                leaveWaitlist(carId) {
                        return request(`/waitlist/${carId}`, { method: 'DELETE' });
                },
                submitReview(bookingId, rating, comment) {
                        return request(`/bookings/${bookingId}/review`, {
                                method: 'POST',
                                body: JSON.stringify({ rating, comment }),
                        });
                },
                // Admin endpoints
                adminStats() {
                        return request('/admin/stats', { method: 'GET' });
                },
                adminCustomers(params = {}) {
			const query = new URLSearchParams();
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== '') query.set(key, value);
			});
                        return request(`/admin/customers${query.toString() ? `?${query}` : ''}`, { method: 'GET' });
                },
                adminCustomer(id) {
                        return request(`/admin/customers/${id}`, { method: 'GET' });
                },
                verifyLicense(id) {
                        return request(`/admin/customers/${id}/verify`, { method: 'PUT' });
                },
                addCar(data) {
                        return request('/cars', {
                                method: 'POST',
                                body: JSON.stringify(data),
                        });
                },
                updateCar(id, data) {
                        return request(`/cars/${id}`, {
                                method: 'PUT',
                                body: JSON.stringify(data),
                        });
                },
                deleteCar(id) {
                        return request(`/cars/${id}`, { method: 'DELETE' });
                },
                allBookings(params = {}) {
			const query = new URLSearchParams();
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null && value !== '') query.set(key, value);
			});
                        return request(`/bookings${query.toString() ? `?${query}` : ''}`, { method: 'GET' });
                },
                confirmBooking(id) {
                        return request(`/bookings/${id}/confirm`, { method: 'PUT' });
                },
                returnBooking(id, data) {
                        return request(`/bookings/${id}/return`, {
                                method: 'PUT',
                                body: JSON.stringify(data),
                        });
                },
                promos() {
                        return request('/promos', { method: 'GET' });
                },
                createPromo(data) {
                        return request('/promos', {
                                method: 'POST',
                                body: JSON.stringify(data),
                        });
                },
                updatePromo(id, data) {
                        return request(`/promos/${id}`, {
                                method: 'PUT',
                                body: JSON.stringify(data),
                        });
                },
                damageReports() {
                        return request('/damage-reports', { method: 'GET' });
                },
                resolveDamage(id) {
                        return request(`/damage-reports/${id}/resolve`, { method: 'PUT' });
                },
                // End Admin endpoints

                // AI endpoints
		ai: {
			chat(message, history = []) {
				return request('/ai/chat', {
					method: 'POST',
					body: JSON.stringify({ message, history }),
				});
			},
			recommend(prompt) {
				return request('/ai/recommend', {
					method: 'POST',
					body: JSON.stringify({ prompt }),
				});
			},
			summarizeReviews(carId) {
				return request(`/ai/reviews/${carId}/summary`, { method: 'GET' });
			},
		},
	};

	window.API = API;
})();
