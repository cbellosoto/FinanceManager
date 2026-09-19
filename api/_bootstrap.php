<?php
declare(strict_types=1);

// config.php must live outside any web-served document root. Where exactly
// that is depends on hosting layout, so try the two shapes that come up on
// Hostinger: one directory above this site's public_html (the "domains/
// yourdomain.com/public_html" layout), or two directories above (when this
// site is itself a subfolder of a shared public_html, e.g. public_html/sts/
// for a subdomain, and the account home -- sibling of public_html -- is the
// first directory that isn't served by any vhost).
$configCandidates = [dirname(__DIR__, 2) . '/config.php', dirname(__DIR__, 3) . '/config.php'];
$configPath = null;
foreach ($configCandidates as $candidate) {
  if (is_file($candidate)) { $configPath = $candidate; break; }
}
if ($configPath === null) {
  http_response_code(500);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'config_missing']);
  exit;
}
require $configPath;

// Never let a raw PHP error/warning or an uncaught mysqli exception (mysqli
// throws by default on PHP 8.1+) leak a stack trace or file path to the
// client -- every response from this API must stay valid JSON.
ini_set('display_errors', '0');
set_exception_handler(function (Throwable $e): void {
  http_response_code(500);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['error' => 'server_error']);
  exit;
});

const MAX_BODY_BYTES = 5 * 1024 * 1024; // reject runaway payloads
const REMEMBER_COOKIE = 'stsRemember';
const REMEMBER_DAYS = 30;
const AUTH_RATE_LIMIT_WINDOW_MIN = 10;
const AUTH_RATE_LIMIT_MAX = 20;

function db(): mysqli {
  static $conn = null;
  if ($conn === null) {
    $conn = mysqli_connect(DB_HOST, DB_USER, DB_PASS, DB_NAME);
    if (!$conn) {
      json_out(['error' => 'db_unavailable'], 500);
    }
    $conn->set_charset('utf8mb4');
  }
  return $conn;
}

function json_out($payload, int $status = 200): never {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($payload);
  exit;
}

function json_input(): array {
  $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
  if ($contentLength > MAX_BODY_BYTES) {
    json_out(['error' => 'payload_too_large'], 413);
  }
  $raw = file_get_contents('php://input');
  if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    json_out(['error' => 'payload_too_large'], 413);
  }
  $data = json_decode($raw, true);
  if (!is_array($data)) {
    json_out(['error' => 'invalid_json'], 400);
  }
  return $data;
}

function start_secure_session(): void {
  $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
  session_name('stsSession');
  session_set_cookie_params([
    'lifetime' => 0, // native session cookie; long-lived "stay signed in" is handled separately
    'path' => '/',
    'secure' => $isHttps,
    'httponly' => true,
    'samesite' => 'Strict',
  ]);
  session_start();
}

// A cross-site page can trigger a simple form POST with cookies attached, but
// it cannot add a custom header without triggering a CORS preflight -- and we
// never send an Access-Control-Allow-Origin for any origin, so the browser
// blocks it before the real request is sent. This closes CSRF with no token.
function require_csrf_header(): void {
  if (($_SERVER['HTTP_X_STS_REQUEST'] ?? '') !== '1') {
    json_out(['error' => 'missing_csrf_header'], 403);
  }
}

function client_ip(): string {
  return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function rate_limit_check(string $ip): void {
  $stmt = db()->prepare(
    'SELECT COUNT(*) FROM auth_attempts WHERE ip_address = ? AND attempted_at > (NOW() - INTERVAL ? MINUTE)'
  );
  $windowMin = AUTH_RATE_LIMIT_WINDOW_MIN; // bind_param takes references, so no constants
  $stmt->bind_param('si', $ip, $windowMin);
  $stmt->execute();
  $stmt->bind_result($count);
  $stmt->fetch();
  $stmt->close();
  if ($count >= AUTH_RATE_LIMIT_MAX) {
    json_out(['error' => 'rate_limited'], 429);
  }
}

function log_auth_attempt(string $ip, bool $success, ?string $email): void {
  $stmt = db()->prepare('INSERT INTO auth_attempts (ip_address, success, email) VALUES (?, ?, ?)');
  $successInt = $success ? 1 : 0;
  $stmt->bind_param('sis', $ip, $successInt, $email);
  $stmt->execute();
  $stmt->close();
}

function issue_remember_cookie(string $email): void {
  $token = bin2hex(random_bytes(32));
  $hash = hash('sha256', $token);
  $expiresAt = (new DateTime("+" . REMEMBER_DAYS . " days"))->format('Y-m-d H:i:s');
  $stmt = db()->prepare('INSERT INTO remember_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)');
  $stmt->bind_param('sss', $hash, $email, $expiresAt);
  $stmt->execute();
  $stmt->close();

  $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
  setcookie(REMEMBER_COOKIE, $token, [
    'expires' => time() + REMEMBER_DAYS * 86400,
    'path' => '/',
    'secure' => $isHttps,
    'httponly' => true,
    'samesite' => 'Strict',
  ]);
}

function clear_remember_cookie(): void {
  if (isset($_COOKIE[REMEMBER_COOKIE])) {
    $hash = hash('sha256', $_COOKIE[REMEMBER_COOKIE]);
    $stmt = db()->prepare('DELETE FROM remember_tokens WHERE token_hash = ?');
    $stmt->bind_param('s', $hash);
    $stmt->execute();
    $stmt->close();
  }
  setcookie(REMEMBER_COOKIE, '', ['expires' => time() - 3600, 'path' => '/']);
}

// Session first; if absent, fall back to the remember-me token and silently
// re-establish a session so the user isn't bounced to the login gate just
// because shared hosting garbage-collected their native session early.
function current_user_email(): ?string {
  if (!empty($_SESSION['email'])) {
    return $_SESSION['email'];
  }
  if (!empty($_COOKIE[REMEMBER_COOKIE])) {
    $hash = hash('sha256', $_COOKIE[REMEMBER_COOKIE]);
    $stmt = db()->prepare('SELECT email FROM remember_tokens WHERE token_hash = ? AND expires_at > NOW()');
    $stmt->bind_param('s', $hash);
    $stmt->execute();
    $stmt->bind_result($email);
    $found = $stmt->fetch();
    $stmt->close();
    if ($found && in_array($email, array_map('strtolower', ALLOWED_EMAILS), true)) {
      session_regenerate_id(true);
      $_SESSION['email'] = $email;
      return $email;
    }
  }
  return null;
}

function require_auth(): string {
  $email = current_user_email();
  if ($email === null) {
    json_out(['error' => 'unauthorized'], 401);
  }
  return $email;
}
