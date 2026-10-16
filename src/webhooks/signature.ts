/**
 * The signature of every delivery, exactly as the portal documents it and platform-gate `Signature::for()` writes
 * it (developers-portal `content/webhooks.md`, `snippets/verificar-firma.js`; contract C3 v4):
 *
 *   X-Funnelchat-Signature: t=<unix>,v1=<hex(hmac_sha256(secret, "<t>." + raw body))>
 *
 * The HMAC uses the full secret as shown (the `whsec_` prefix is part of it) over the exact bytes that are sent.
 * Each attempt is signed again with a fresh `t` over the same bytes.
 */
import { createHmac } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-Funnelchat-Signature';
export const EVENT_HEADER = 'X-Funnelchat-Event';
export const DELIVERY_HEADER = 'X-Funnelchat-Delivery';
export const USER_AGENT = 'Funnelchat-Webhooks/1';

export function signature(secret: string, body: string | Uint8Array, timestamp: number): string {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new TypeError('El timestamp tiene que ser un entero de segundos.');
  const v1 = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
