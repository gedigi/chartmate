/**
 * Content Security Policy for every app:// response (documents, assets and API replies alike).
 *
 * - No 'unsafe-inline' anywhere: the web bundle has no inline scripts (the theme bootstrap lives in
 *   /theme-init.js) and no inline <style>/style="" markup. React `style` props and KLineChart write styles
 *   through the CSSOM (element.style.x = …), which CSP does not govern, so style-src 'self' suffices.
 * - 'self' is the app://altv origin; nothing else (no http/https/ws, no blob:, no eval).
 * - img-src allows data: for small inline images only.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'camera=()', 'clipboard-read=()', 'display-capture=()', 'geolocation=()',
  'gyroscope=()', 'hid=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'serial=()', 'usb=()',
].join(', ');

/** Headers added to every response served by the app:// handler. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': PERMISSIONS_POLICY,
});
