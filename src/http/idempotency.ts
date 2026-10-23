/**
 * `Idempotency-Key` of `POST /devices` and `POST /connect-links`, as accounts did it (contract of the sign-up by API,
 * amendment v0.1, 23-10):
 *
 * - optional, 1 to 255 characters; a malformed one answers `422 invalid_idempotency_key`;
 * - kept 24 hours per account and per resource (`devices`, `connect-links`); the fingerprint covers method, path and
 *   body;
 * - only a `2xx` is replayed, with `Idempotent-Replayed: true`; a rejection is evaluated again;
 * - the same key with another body answers `422 idempotency_key_mismatch`; while it runs, `409 operation_in_progress`.
 */
import { createHash } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import type { HandlerContext, HandlerResult } from './context.js';
import { ApiError } from './errors.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
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

export async function idempotent(ctx: HandlerContext, resource: 'devices' | 'connect-links', run: () => HandlerResult | Promise<HandlerResult>): Promise<HandlerResult> {
  const key = ctx.headers['idempotency-key'];
  if (key === undefined) return run();
  if (key.length < 1 || key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ApiError(422, 'invalid_idempotency_key', `El header ${IDEMPOTENCY_HEADER} debe tener entre 1 y 255 caracteres visibles, sin espacios.`);
  }
  const { store } = ctx.app;
  const now = Date.now();
  for (const [k, answer] of store.idempotency) if (now - answer.storedAt.getTime() >= TTL_MS) store.idempotency.delete(k);

  const slot = `${resource}|${key}`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([ctx.op.method, ctx.pathname, canonical(ctx.body ?? null)]))
    .digest('hex');
  const stored = store.idempotency.get(slot);
  if (stored) {
    if (stored.fingerprint !== fingerprint) {
      throw new ApiError(422, 'idempotency_key_mismatch', `Ya usaste este ${IDEMPOTENCY_HEADER} con otro cuerpo. Usa una clave nueva para otra operación.`);
    }
    return { status: stored.status, body: structuredClone(stored.body), headers: { ...stored.headers, [REPLAYED_HEADER]: 'true' } };
  }

  const inFlight = running.get(ctx.app) ?? new Set<string>();
  running.set(ctx.app, inFlight);
  if (inFlight.has(slot)) throw new ApiError(409, 'operation_in_progress', `Una operación con este ${IDEMPOTENCY_HEADER} todavía está en curso.`);
  inFlight.add(slot);
  try {
    const result = await run();
    if (result.status >= 200 && result.status < 300) {
      store.idempotency.set(slot, { fingerprint, status: result.status, body: structuredClone(result.body), headers: { ...result.headers }, storedAt: new Date() });
    }
    return result;
  } finally {
    inFlight.delete(slot);
  }
}
