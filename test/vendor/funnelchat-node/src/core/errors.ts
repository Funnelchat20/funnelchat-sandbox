/**
 * Errors thrown by the SDK.
 *
 *   FunnelchatError                 base class of everything the SDK throws
 *   ├── APIError                    the API answered with a non-2xx status
 *   │   ├── BadRequestError         400
 *   │   ├── AuthenticationError     401
 *   │   ├── PermissionDeniedError   403
 *   │   ├── NotFoundError           404
 *   │   ├── ConflictError           409
 *   │   ├── UnprocessableEntityError 422
 *   │   ├── RateLimitError          429
 *   │   └── InternalServerError     5xx
 *   ├── APIConnectionError          no response (network error)
 *   │   └── APIConnectionTimeoutError
 *   ├── APIUserAbortError           the caller aborted the request with its own AbortSignal
 *   └── WebhookVerificationError    a webhook delivery failed signature verification
 */

/** Base class of every error thrown by the SDK. */
export class FunnelchatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Validation details of a Laravel `422`: field name -> messages. */
export type FieldErrors = Record<string, string[]>;

export interface APIErrorInit {
  status: number;
  body: unknown;
  headers: Headers;
  method: string;
  url: string;
}

/**
 * The API answered with a non-2xx status.
 *
 * - `status`: the HTTP status.
 * - `code`: the stable `error` code of the body (`window_closed`, `rate_limited`,
 *   `route_not_available`…), or `undefined` when the body has none (for example a Laravel
 *   validation `422`, which carries `errors` instead).
 * - `message`: the `message` of the body, meant for people. Decide by `status` and `code`.
 * - `retryAfter`: seconds from the `Retry-After` header, when present.
 */
export class APIError extends FunnelchatError {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfter: number | undefined;
  /** Per-field validation messages of a `422`, when the API sends them. */
  readonly errors: FieldErrors | undefined;
  /** The parsed body (or the raw text when it is not JSON). */
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  /** URL of the request, without the query string. */
  readonly url: string;

  constructor(init: APIErrorInit) {
    const body = init.body;
    const record = isRecord(body) ? body : undefined;
    const code = typeof record?.error === 'string' && record.error !== '' ? record.error : undefined;
    const apiMessage = typeof record?.message === 'string' && record.message !== '' ? record.message : undefined;
    const fallback = typeof body === 'string' && body.trim() !== '' && body.length <= 300 ? body.trim() : undefined;
    super(apiMessage ?? code ?? fallback ?? `La API respondió ${init.status}.`);
    this.status = init.status;
    this.code = code;
    this.retryAfter = parseRetryAfter(init.headers.get('retry-after'));
    this.errors = isRecord(record?.errors) ? (record.errors as FieldErrors) : undefined;
    this.body = body;
    this.headers = init.headers;
    this.method = init.method;
    this.url = init.url;
  }

  /** Builds the subclass that matches the status. */
  static from(init: APIErrorInit): APIError {
    const { status } = init;
    if (status === 400) return new BadRequestError(init);
    if (status === 401) return new AuthenticationError(init);
    if (status === 403) return new PermissionDeniedError(init);
    if (status === 404) return new NotFoundError(init);
    if (status === 409) return new ConflictError(init);
    if (status === 422) return new UnprocessableEntityError(init);
    if (status === 429) return new RateLimitError(init);
    if (status >= 500) return new InternalServerError(init);
    return new APIError(init);
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
/** `403`: the key lacks the permission, or the route is not open to keys (`route_not_available`). */
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
/** `422`: validation (`errors`) or a WhatsApp rule (`window_closed`, `antiblock_*`, `recipient_*`…). */
export class UnprocessableEntityError extends APIError {}
/** `429`: rate limit. `retryAfter` says how many seconds to wait. */
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}

/** The request never got a response: DNS, connection refused, reset, TLS… */
export class APIConnectionError extends FunnelchatError {
  constructor(message = 'No se pudo conectar con la API de Funnelchat.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The request took longer than `timeoutMs`. */
export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`La API de Funnelchat no respondió en ${timeoutMs} ms.`, options);
  }
}

/** The caller aborted the request with its own `AbortSignal`. Never retried. */
export class APIUserAbortError extends FunnelchatError {
  constructor(options?: { cause?: unknown }) {
    super('La solicitud se canceló.', options);
  }
}

export type WebhookVerificationFailure =
  | 'missing_secret'
  | 'invalid_body'
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'invalid_json'
  | 'invalid_event';

/** A webhook delivery did not pass verification. `reason` says which check failed. */
export class WebhookVerificationError extends FunnelchatError {
  readonly reason: WebhookVerificationFailure;

  constructor(reason: WebhookVerificationFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Seconds to wait from a `Retry-After` header: delta-seconds (`"30"`) or an HTTP date.
 * `undefined` when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
