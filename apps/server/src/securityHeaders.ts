import type { FastifyInstance } from 'fastify';
import { isApiPath } from './paths.js';

/**
 * Content Security Policy of the self-hosted web app (the same bundle the desktop app runs under its own, stricter
 * policy): only same-origin scripts, styles, fonts and API calls, data: images, no plugins, no framing, no <base>.
 * The bundle has no inline scripts or inline style markup; React `style` props and the chart write styles through
 * the CSSOM, which style-src does not govern. Trusted Types are required with no policy allowed: the app never
 * writes HTML strings into the DOM.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

/** Every response, API included. */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Pages, static files and their 404s (everything outside /api). */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...COMMON_HEADERS,
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

/** Adds the security headers to every response (including errors and the host guard's refusals). */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(isApiPath(request.url) ? COMMON_HEADERS : PAGE_HEADERS);
    return payload;
  });
}
