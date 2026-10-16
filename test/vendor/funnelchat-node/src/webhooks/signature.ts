/**
 * Verification of the `X-Funnelchat-Signature` header of a webhook delivery.
 *
 * It replicates exactly the algorithm of the developer portal (`snippets/verificar-firma.js` of
 * developers-portal, contract C3 v4):
 *
 *   X-Funnelchat-Signature: t=<unix>,v1=<hex(hmac_sha256(secret, "<t>." + raw body))>
 *
 * - the header is split by `,` and each part by its first `=`; keys and values are trimmed;
 * - `t` must be digits only; there can be several `v1` (any match is enough);
 * - `t` farther than `toleranceSeconds` (300 by default) from the local clock is rejected;
 * - the HMAC uses the full secret as shown (a `whsec_` prefix is part of it) over the raw bytes
 *   of the body, and is compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookVerificationError, type WebhookVerificationFailure } from '../core/errors.js';

/** Name of the signature header. */
export const SIGNATURE_HEADER = 'X-Funnelchat-Signature';
/** Default tolerance between `t` and the local clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The body exactly as it arrived: never parsed and re-serialized. */
export type RawBody = string | Uint8Array | ArrayBuffer;

export interface VerifyOptions {
  /** Maximum distance between `t` and the local clock, in seconds. Default: 300. */
  toleranceSeconds?: number;
}

type CheckResult = { ok: true } | { ok: false; reason: WebhookVerificationFailure; message: string };

const fail = (reason: WebhookVerificationFailure, message: string): CheckResult => ({ ok: false, reason, message });

function toBytes(body: unknown): Buffer | null {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return null;
}

/** Runs every check and says which one failed. */
export function checkSignature(rawBody: unknown, signatureHeader: unknown, secret: unknown, options: VerifyOptions = {}): CheckResult {
  if (typeof secret !== 'string' || secret === '') {
    return fail('missing_secret', 'Falta el secreto de la suscripción.');
  }
  const body = toBytes(rawBody);
  if (body === null) {
    return fail(
      'invalid_body',
      'El cuerpo tiene que ser el crudo (string, Buffer o Uint8Array), tal como llegó. Si usás Express, leelo con express.raw({ type: "application/json" }) y no con express.json().',
    );
  }
  if (typeof signatureHeader !== 'string' || signatureHeader === '') {
    return fail('missing_header', `Falta la cabecera ${SIGNATURE_HEADER}.`);
  }

  let t: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') t = value;
    if (key === 'v1') signatures.push(value);
  }
  if (t === null || !/^\d+$/.test(t) || signatures.length === 0) {
    return fail('malformed_header', `La cabecera ${SIGNATURE_HEADER} no tiene la forma t=<unix>,v1=<hex>.`);
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > tolerance) {
    return fail('timestamp_out_of_tolerance', `La firma tiene más de ${tolerance} segundos de diferencia con el reloj local.`);
  }

  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex'), 'utf8');
  const matched = signatures.some((v1) => {
    const candidate = Buffer.from(v1, 'utf8');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  return matched ? { ok: true } : fail('signature_mismatch', 'La firma no coincide con el cuerpo y el secreto.');
}

/**
 * `true` when the delivery is authentic and recent. Same contract as the portal snippet: it never
 * throws, any problem is `false`. Use {@link constructEvent} to know which check failed.
 */
export function verify(rawBody: RawBody, signatureHeader: string | null | undefined, secret: string, options?: VerifyOptions): boolean {
  return checkSignature(rawBody, signatureHeader, secret, options).ok;
}

/** Throws {@link WebhookVerificationError} unless the delivery is authentic and recent. */
export function assertSignature(rawBody: RawBody, signatureHeader: string | null | undefined, secret: string, options?: VerifyOptions): void {
  const result = checkSignature(rawBody, signatureHeader, secret, options);
  if (!result.ok) throw new WebhookVerificationError(result.reason, result.message);
}
