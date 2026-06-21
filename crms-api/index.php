<?php

declare(strict_types=1);

define('ROOT', __DIR__);

// PHP built-in dev server: serve existing static files (e.g. uploaded images)
// directly, and route everything else through this front controller. Apache
// handles this via .htaccess in production, but the CLI server needs it here.
if (PHP_SAPI === 'cli-server') {
    $requestPath = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    if ($requestPath !== '/' && is_file(ROOT . $requestPath)) {
        return false;
    }
}

require ROOT . '/core/helpers.php';

$isProduction = (env('APP_ENV') === 'production');
$lifetime = isset($_COOKIE['crms_remember']) ? 60 * 60 * 24 * 30 : 0;

session_set_cookie_params([
    'lifetime' => $lifetime,
    'secure'   => $isProduction,
    'httponly' => true,
    'samesite' => $isProduction ? 'Strict' : 'Lax',
]);
session_start();

require ROOT . '/core/Database.php';
require ROOT . '/core/QueryBuilder.php';
require ROOT . '/core/Model.php';
require ROOT . '/core/Controller.php';
require ROOT . '/core/Validator.php';
require ROOT . '/core/Router.php';
require ROOT . '/core/Csrf.php';
require ROOT . '/middleware/CorsMiddleware.php';
require ROOT . '/middleware/AuthMiddleware.php';
require ROOT . '/middleware/RateLimitMiddleware.php';
require ROOT . '/middleware/CsrfMiddleware.php';

set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'success' => false,
        'message' => env('APP_ENV') === 'development'
            ? $e->getMessage() . ' in ' . basename($e->getFile()) . ':' . $e->getLine()
            : 'Internal server error',
    ]);
    exit;
});

CorsMiddleware::handle();
CsrfMiddleware::handle();
require ROOT . '/database/schema.php';
require ROOT . '/config/routes.php';
Router::dispatch();