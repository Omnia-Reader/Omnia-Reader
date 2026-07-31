export const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' blob: data:",
  "font-src 'self' data: blob: https://fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'self' blob:",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' blob:",
  "worker-src 'self' blob:",
].join('; ');

export const WEB_APPLICATION_SHELL_CONTENT_SECURITY_POLICY = `${WEB_CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`;

export const WEB_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': WEB_CONTENT_SECURITY_POLICY,
  // Omnia does not require cross-origin isolation. Enabling COOP causes
  // Firefox reloads to stall while EPUB/PDF workers and frames are tearing
  // down, so the application relies on CSP frame-ancestors and X-Frame-Options
  // for document isolation instead.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

export const WEB_APPLICATION_SHELL_HEADERS = Object.freeze({
  ...WEB_SECURITY_HEADERS,
  'Content-Security-Policy': WEB_APPLICATION_SHELL_CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
});
