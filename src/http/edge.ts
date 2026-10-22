/**
 * Forced errors of the edge (api-edge v0.3.0): `502 origin_unreachable` and `500 edge_misconfigured`, for any API
 * route. The portal's rule for a `502` on a write is to treat it as a timeout — it does not say whether the write
 * was applied — so `origin_unreachable` can also be forced after the domain did the work (`applied`).
 *
 *   X-Sandbox-Edge: origin_unreachable            the call never reached the domain
 *   X-Sandbox-Edge: origin_unreachable_applied    the domain applied it; the answer was lost
 *   X-Sandbox-Edge: edge_misconfigured
 *
 * Or armed for the next calls with `POST /_sandbox/failures` `{"mode": "edge", "code": "…", "applied": true}`.
 */
import type { SandboxApp } from '../app.js';
import { EDGE_ERRORS, fieldError } from './errors.js';

export const EDGE_HEADER_VALUES = ['origin_unreachable', 'origin_unreachable_applied', 'edge_misconfigured'];

/** Checks a forced edge code; throws a 422 that says what is accepted. */
export function parseEdge(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (text in EDGE_ERRORS) return text;
  throw fieldError(field, `${field} tiene que ser uno de: ${Object.keys(EDGE_ERRORS).join(', ')}.`);
}

/** The forced edge error of this call, if any: the header, or the next armed one. */
export function takeEdgeFailure(app: SandboxApp, headers: Record<string, string | undefined>): { code: string; applied: boolean } | null {
  const header = headers['x-sandbox-edge']?.trim();
  if (header) {
    if (header === 'origin_unreachable_applied') return { code: 'origin_unreachable', applied: true };
    if (!EDGE_HEADER_VALUES.includes(header)) {
      throw fieldError('X-Sandbox-Edge', `X-Sandbox-Edge tiene que ser uno de: ${EDGE_HEADER_VALUES.join(', ')}.`);
    }
    return { code: header, applied: false };
  }
  const armed = app.store.failures.find((f) => f.mode === 'edge' && f.remaining > 0);
  if (!armed) return null;
  armed.remaining--;
  if (armed.remaining <= 0) app.store.failures = app.store.failures.filter((f) => f !== armed);
  return { code: armed.code, applied: armed.code === 'origin_unreachable' && armed.applied === true };
}
