/**
 * `Idempotency-Key` of `POST /devices` and `POST /connect-links` (contract A1 of the sign-up by API, 22-10):
 *
 * - optional, up to 255 characters, kept 24 hours per account;
 * - the same key with the same body (and the same route) gives back the same answer, without creating anything;
 * - the same key with another body answers `422 idempotency_key_mismatch`;
 * - a key whose call is still running answers `409 operation_in_progress`.
 *
 * Only a successful answer is kept: a rejection (quota, validation) can be retried with the same key once fixed.
 */
import { createHash } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import type { HandlerContext, HandlerResult } from './context.js';
import { ApiError, fieldError } from './errors.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const TTL_MS = 24 * 60 * 60 * 1000;
const running = new WeakMap<SandboxApp, Set<string>>();

/** The same JSON whatever the order of its keys. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

export async function idempotent(ctx: HandlerContext, run: () => HandlerResult | Promise<HandlerResult>): Promise<HandlerResult> {
  const key = ctx.headers['idempotency-key'];
  if (key === undefined) return run();
  if (key.trim() === '' || key.length > 255) {
    throw fieldError(IDEMPOTENCY_HEADER, `El header ${IDEMPOTENCY_HEADER} debe tener entre 1 y 255 caracteres.`);
  }
  const { store } = ctx.app;
  const now = Date.now();
  for (const [k, answer] of store.idempotency) if (now - answer.storedAt.getTime() >= TTL_MS) store.idempotency.delete(k);

  const fingerprint = createHash('sha256')
    .update(JSON.stringify([ctx.op.method, ctx.op.path, canonical(ctx.body ?? null)]))
    .digest('hex');
  const stored = store.idempotency.get(key);
  if (stored) {
    if (stored.fingerprint !== fingerprint) {
      throw new ApiError(422, 'idempotency_key_mismatch', `Ya usaste este ${IDEMPOTENCY_HEADER} con otro cuerpo. Usa una clave nueva para otra operación.`);
    }
    return { status: stored.status, body: structuredClone(stored.body) };
  }

  const inFlight = running.get(ctx.app) ?? new Set<string>();
  running.set(ctx.app, inFlight);
  if (inFlight.has(key)) throw new ApiError(409, 'operation_in_progress', `Una operación con este ${IDEMPOTENCY_HEADER} todavía está en curso.`);
  inFlight.add(key);
  try {
    const result = await run();
    if (result.status >= 200 && result.status < 300) {
      store.idempotency.set(key, { fingerprint, status: result.status, body: structuredClone(result.body), storedAt: new Date() });
    }
    return result;
  } finally {
    inFlight.delete(key);
  }
}
