/**
 * The hosted sign-up page of a link, outside `/api/v1` and never with a key, as accounts serves it and api-edge routes
 * it (`/connect/*`; contract of the sign-up by API, A1, A2 and amendment v0.1 of 23-10):
 *
 *   GET  /connect/{token}            the page; opening it does not use the link (a messenger's preview cannot burn it)
 *   POST /connect/{token}/start      the button: claims the link
 *   POST /connect/{token}/complete   [part 2] the end of the Meta sign-up: claims it too
 *   GET  /connect/reopen             where the address bar is left once the token is removed from it
 *
 * The real page shows the QR (`POST /connect/{token}/qr`) or runs Meta's Embedded Signup. The test page of the
 * sandbox "connects" at once on `start` or `complete`. What happens is chosen in the body (JSON or form) or the query:
 *
 *   outcome=completed|failed           completed by default
 *   error_code=<code>                  for failed; qr_timeout (QR) or meta_error (Meta) by default
 *   connection=coexistence|dedicated   Meta, when the link allows both; the first allowed by default
 *   number=<digits>                    the phone that connects; a fake one by default
 *
 * Then it redirects (`303`) to `return_url` with the result, or answers a page that says it. Any request with
 * `Authorization` or `X-Api-Key` gets `403 credentials_not_allowed`.
 */
import { randomBytes } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import { parseQuery } from '../http/query.js';
import type { ConnectLink } from '../state/store.js';
import { digits, isRecord } from '../util.js';
import { completeLink, findLinkByToken, LINK_ERROR_CODES, returnUrlFor, type LinkOutcome } from './numbers.js';

export interface PageAnswer {
  status: number;
  html?: string;
  body?: unknown;
  headers: Record<string, string>;
}

/** The security headers of the real page (amendment v0.1), with the nonce of its CSP. */
function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex',
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
  };
}

const PATH = /^\/connect\/([A-Za-z0-9_-]{1,200})(?:\/(start|complete|qr))?\/?$/;

export const isConnectPath = (pathname: string): boolean => pathname === '/connect' || pathname.startsWith('/connect/');

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, title: string, text: string, extra = ''): PageAnswer {
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Funnelchat</title>
<style nonce="${nonce}">
  :root { --bg: #f6f7f9; --card: #fff; --text: #1d2433; --muted: #5b6475; --line: #dfe3ea; --accent: #0b6e4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a202a; --text: #e6e9ef; --muted: #9aa4b5; --line: #2b3340; --accent: #3fb68b; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 8px; }
  label { display: block; margin: 6px 0; }
  button { margin: 8px 0; padding: 10px 16px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  small { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p>${escape(text)}</p>
${extra}<small>Funnelchat sandbox: a test page. Nothing is connected to WhatsApp.</small>
</main>
</body>
</html>
`;
  return { status, html, headers: securityHeaders(nonce) };
}

function json(status: number, body: unknown): PageAnswer {
  return { status, body, headers: securityHeaders(randomBytes(16).toString('base64')) };
}

/** The page of a pending link: a button that claims it, and the token out of the address bar. */
function linkPage(token: string, link: ConnectLink): PageAnswer {
  const choice =
    link.type === 'meta' && (link.allowedConnectionTypes?.length ?? 0) > 1
      ? (link.allowedConnectionTypes ?? [])
          .map(
            (c, i) =>
              `<label><input type="radio" name="connection" value="${c}"${i === 0 ? ' checked' : ''}> ${c === 'coexistence' ? 'Keep using the WhatsApp Business app (coexistence)' : 'A number only for the API'}</label>`,
          )
          .join('\n')
      : '';
  const answer = page(
    200,
    link.type === 'qr' ? 'Connect your WhatsApp by QR' : 'Connect your WhatsApp Business number',
    'In the sandbox the button connects at once: there is no QR to scan and no Meta sign-up.',
    `<form method="post" action="/connect/${token}/start">\n${choice}\n<button type="submit">Connect</button>\n</form>\n`,
  );
  const nonce = /'nonce-([^']+)'/.exec(answer.headers['Content-Security-Policy'] as string)?.[1] ?? '';
  answer.html = (answer.html as string).replace('</body>', `<script nonce="${nonce}">history.replaceState(null, '', '/connect/reopen');</script>\n</body>`);
  return answer;
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
    return json(403, { error: 'credentials_not_allowed', message: 'Esta página no acepta credenciales. Abre el link en un navegador, sin API key.' });
  }
  if (pathname.replace(/\/+$/, '') === '/connect/reopen' && method === 'GET') {
    return page(200, 'Open the link again', 'For your security the link left the address bar. Open it again from the message you received.');
  }
  const match = PATH.exec(pathname);
  if (!match || match[2] === 'qr') return page(404, 'This link does not exist', 'Check that you copied the whole link.');
  const token = match[1] as string;
  const action = match[2];
  const expected = action ? 'POST' : 'GET';
  if (method !== expected) {
    const answer = page(405, 'Not allowed', 'Open the link in a browser.');
    return { ...answer, headers: { ...answer.headers, Allow: expected } };
  }
  const link = findLinkByToken(app, token);
  if (!link) return page(404, 'This link does not exist', 'Check that you copied the whole link.');
  if (link.status !== 'pending') return closed(link);
  if (link.type === 'meta' && !app.store.numbers.metaConnect) {
    return page(503, 'Not available yet', 'Connecting official numbers by link is not available yet.');
  }
  if (!action) return linkPage(token, link);

  const input = { ...parseQuery(search), ...(isRecord(body) ? body : {}) };
  completeLink(app, link, outcomeOf(input));
  app.logger.info(`sign-up link ${link.id}: ${link.status}${link.errorCode ? ` (${link.errorCode})` : ''}${link.deviceId ? ` → number ${link.deviceId}` : ''}`);

  const back = returnUrlFor(link);
  if (back) {
    const { headers: pageHeaders } = page(303, 'Done', 'Going back.');
    return { status: 303, headers: { ...pageHeaders, Location: back } };
  }
  // Read again: completeLink changed it.
  const status = link.status as ConnectLink['status'];
  return status === 'completed'
    ? page(200, 'Done: your number is connected', 'You can close this page.')
    : page(200, 'The number could not be connected', `Reason: ${link.errorCode ?? 'unknown'}. Ask whoever sent the link for a new one.`);
}
