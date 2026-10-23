/**
 * The hosted sign-up page of a link: `GET /connect/{token}` and `POST /connect/{token}/complete`, outside `/api/v1`
 * and without an API key, as api-edge exposes them (contract A1 and A2 of the sign-up by API, 22-10).
 *
 * The real page shows the QR (and renews it) or runs Meta's Embedded Signup. The test page of the sandbox "connects"
 * at once, on the first visit, so an end-to-end test needs one request. What happens is chosen in the query (GET) or
 * the body (POST, JSON or form):
 *
 *   outcome=completed|failed        completed by default
 *   error_code=<code>               for failed; qr_timeout (QR) or meta_error (Meta) by default
 *   connection=coexistence|dedicated   Meta, when the link allows both; the first allowed by default
 *   number=<digits>                 the phone that connects; a fake one by default
 *
 * Then it redirects (`303`) to `return_url` with the result, or answers a page that says it. Any request with
 * `Authorization` or `X-Api-Key` gets `403`: the page never accepts a key.
 */
import type { SandboxApp } from '../app.js';
import { parseQuery } from '../http/query.js';
import type { ConnectLink } from '../state/store.js';
import { digits, isRecord } from '../util.js';
import { completeLink, findLinkByToken, LINK_ERROR_CODES, returnUrlFor, type LinkOutcome } from './numbers.js';

export interface PageAnswer {
  status: number;
  html?: string;
  headers: Record<string, string>;
}

/** The security headers of the real page (#1021): no cache, no referrer, a strict CSP. */
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
};

const PATH = /^\/connect\/([A-Za-z0-9_-]{1,200})(\/complete)?\/?$/;

export const isConnectPath = (pathname: string): boolean => pathname === '/connect' || pathname.startsWith('/connect/');

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, title: string, text: string): PageAnswer {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Funnelchat</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1d2433; --muted: #5b6475; --line: #dfe3ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a202a; --text: #e6e9ef; --muted: #9aa4b5; --line: #2b3340; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 8px; }
  small { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p>${escape(text)}</p>
<small>Funnelchat sandbox: a test page. Nothing was connected to WhatsApp.</small>
</main>
</body>
</html>
`;
  return { status, html, headers: { ...SECURITY_HEADERS } };
}

function outcomeOf(input: Record<string, unknown>): LinkOutcome {
  const code = typeof input.error_code === 'string' && (LINK_ERROR_CODES as readonly string[]).includes(input.error_code) ? input.error_code : null;
  const connection = input.connection === 'coexistence' || input.connection === 'dedicated' ? input.connection : null;
  const number = input.number === undefined ? null : digits(input.number) || null;
  return { outcome: input.outcome === 'failed' ? 'failed' : 'completed', errorCode: code, connection, number };
}

function closed(link: ConnectLink): PageAnswer {
  if (link.status === 'expired') return page(410, 'This link expired', 'Ask whoever sent it for a new one.');
  if (link.status === 'revoked') return page(410, 'This link is no longer valid', 'Ask whoever sent it for a new one.');
  return page(410, 'This link was already used', 'A sign-up link works only once. Ask whoever sent it for a new one.');
}

/** The answer of `/connect/...`. */
export function handleConnectPage(app: SandboxApp, method: string, pathname: string, headers: Record<string, string | undefined>, search: URLSearchParams, body: unknown): PageAnswer {
  if (headers.authorization !== undefined || headers['x-api-key'] !== undefined) {
    return page(403, 'Not allowed', 'This page does not accept an API key. Open the link in a browser, without credentials.');
  }
  const match = PATH.exec(pathname);
  if (!match) return page(404, 'This link does not exist', 'Check that you copied the whole link.');
  const complete = match[2] !== undefined;
  if ((complete && method !== 'POST') || (!complete && method !== 'GET')) {
    return { ...page(405, 'Not allowed', 'Open the link in a browser.'), headers: { ...SECURITY_HEADERS, Allow: complete ? 'POST' : 'GET' } };
  }
  const link = findLinkByToken(app, match[1] as string);
  if (!link) return page(404, 'This link does not exist', 'Check that you copied the whole link.');
  if (link.status !== 'pending') return closed(link);

  const input = complete ? (isRecord(body) ? body : {}) : parseQuery(search);
  completeLink(app, link, outcomeOf(input));
  app.logger.info(`sign-up link ${link.id}: ${link.status}${link.errorCode ? ` (${link.errorCode})` : ''}${link.deviceId ? ` → number ${link.deviceId}` : ''}`);

  const back = returnUrlFor(link);
  if (back) return { status: 303, headers: { ...SECURITY_HEADERS, Location: back } };
  // Read again: completeLink changed it.
  const status = link.status as ConnectLink['status'];
  return status === 'completed'
    ? page(200, 'Done: your number is connected', 'You can close this page.')
    : page(200, 'The number could not be connected', `Reason: ${link.errorCode ?? 'unknown'}. Ask whoever sent the link for a new one.`);
}
