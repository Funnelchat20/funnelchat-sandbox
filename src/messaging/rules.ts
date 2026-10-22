/**
 * The rules the real API applies to a send with an API key (conversations v1.18.10, in production: `ApiKeySendAcceptor`,
 * `ApiRecipientBinding`, `ApiSendGuard`, `ApiSendRateLimiter`, `AntiBlockGuardService`, `MacService` and
 * `lang/es/public_api.php`), in their order: number without connection → recipient → pace → 24-hour window → spam
 * brakes → the MAC lockout. The first rejection wins, nothing is stored and nothing is sent.
 *
 * Also the failures you can force: `reject` answers one of those errors right away; `fail` accepts the message and
 * then ends it `failed`, with a reason of Funnelchat or a real error code of Meta.
 */
import { createHash } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import { ApiError, fieldError } from '../http/errors.js';
import type { Contact, Device, MessageError } from '../state/store.js';
import { digits } from '../util.js';

/** Errors of a rejected send: code → HTTP status and the message of conversations' `lang/es/public_api.php`. */
export const REJECTIONS: Record<string, { status: number; message: string }> = {
  rate_limited: {
    status: 429,
    message: 'Superaste el límite de envíos de este número por segundo o de mensajes a este contacto por minuto. Espera unos segundos y vuelve a intentarlo.',
  },
  window_closed: {
    status: 422,
    message: 'No se envió: pasaron más de 24 horas desde el último mensaje del contacto. Para retomar la conversación, envía una plantilla aprobada.',
  },
  antiblock_duplicate_content: {
    status: 422,
    message: 'No se envió: ya se envió este mismo contenido al contacto varias veces sin que respondiera. Espera su respuesta o cambia el contenido.',
  },
  antiblock_unanswered_limit: {
    status: 422,
    message: 'No se envió: el contacto no respondió los últimos mensajes. Espera su respuesta antes de seguir enviando.',
  },
  recipient_mismatch: {
    status: 422,
    message: 'No se envió: el teléfono o el identificador de WhatsApp indicado no corresponde al contacto de la ruta. Usa los datos de ese mismo contacto.',
  },
  recipient_unsupported: {
    status: 422,
    message: 'No se envió: el destinatario del contacto es un grupo, una lista de difusión o un canal. Por la API solo se puede escribir a personas individuales.',
  },
  device_unavailable: {
    status: 422,
    message: 'No se envió: el número no está conectado con WhatsApp. Revisa la conexión del número en Funnelchat.',
  },
  not_sent: {
    status: 422,
    message: 'No se envió el mensaje. Revisa el contacto y el número, y vuelve a intentarlo.',
  },
  recipient_unreachable: {
    status: 422,
    message: 'No se envió: el contacto no tiene un teléfono ni un identificador de WhatsApp al que este número pueda escribir.',
  },
  // The MAC (monthly active contacts) of the account: literal in ConversationController / MessageController, no Retry-After.
  mac_lockout_24h: {
    status: 429,
    message: 'Tu cuenta está en bloqueo de 24h por agotamiento de MACs.',
  },
  mac_limit_reached: {
    status: 429,
    message: 'Agotaste tus MACs disponibles. El mensaje fue guardado pero no se pudo enviar.',
  },
};

/** `error.reason` of a message Funnelchat accepted and then stopped, with its title (`public_api.send_failure`, es). */
export const FAILURE_REASONS: Record<string, string> = {
  device_unavailable: 'El número no estaba conectado con WhatsApp al momento de enviar.',
  insufficient_balance: 'Saldo insuficiente en tu billetera de WhatsApp.',
  window_closed: 'La ventana de 24 horas se cerró antes del envío: envía una plantilla.',
  recipient_unreachable: 'El contacto no tiene un teléfono al que este número pueda escribir.',
  template_not_found: 'La plantilla ya no existe.',
  template_unresolved_placeholder: 'La plantilla tiene variables que no se pudieron completar.',
  not_queued: 'No se pudo poner el mensaje en cola.',
  not_sent: 'Funnelchat no pudo enviar el mensaje.',
};

/** Frequent error codes of the WhatsApp Cloud API, with the `title` Meta sends. */
export const META_ERRORS: Record<number, string> = {
  130472: "User's number is part of an experiment",
  131000: 'Something went wrong',
  131021: 'Recipient cannot be sender',
  131026: 'Message undeliverable',
  131042: 'Business eligibility payment issue',
  131047: 'Re-engagement message',
  131048: 'Spam rate limit hit',
  131049: 'This message was not delivered to maintain healthy ecosystem engagement.',
  131051: 'Unsupported message type',
  131053: 'Media upload error',
  131056: '(Business Account, Consumer Account) pair rate limit hit',
};

/** Seconds of `Retry-After` for a forced `rate_limited`: Meta's pair rate is one message every 6 seconds. */
export const FORCED_RETRY_AFTER = 6;

export function rejection(code: string, retryAfter?: number): ApiError {
  const known = REJECTIONS[code] as { status: number; message: string };
  const headers: Record<string, string> = code === 'rate_limited' ? { 'Retry-After': String(retryAfter ?? FORCED_RETRY_AFTER) } : {};
  return new ApiError(known.status, code, known.message, {}, headers);
}

/** What a forced `fail` turns into: a reason of Funnelchat, or a Meta code (`true` = 131026). */
export function failureFor(code: string | number | true): { error: MessageError; afterSent: boolean } {
  if (code === true) return failureFor(131026);
  const text = String(code).trim();
  if (text in FAILURE_REASONS) {
    // Stopped by Funnelchat before the provider: one `failed` with `previous_status = null`.
    return { error: { code: null, title: FAILURE_REASONS[text] as string, reason: text }, afterSent: false };
  }
  const numeric = Number(text);
  // Rejected by the provider after it accepted the send: `sent`, then `failed`.
  return { error: { code: numeric, title: META_ERRORS[numeric] ?? null, reason: null }, afterSent: true };
}

/** Checks the value of a forced failure; throws a 422 that says what is accepted. */
export function parseForced(mode: 'reject' | 'fail', value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (mode === 'reject') {
    if (text in REJECTIONS) return text;
    throw fieldError(field, `${field} must be one of: ${Object.keys(REJECTIONS).join(', ')}.`);
  }
  if (text === '' || text === 'true' || text === 'failed') return '131026';
  if (text in FAILURE_REASONS || /^\d{1,9}$/.test(text)) return text;
  throw fieldError(field, `${field} must be a reason (${Object.keys(FAILURE_REASONS).join(', ')}) or a numeric code of Meta (for example 131047).`);
}

/** The forced failure of this send, if any: a header of the request, or the next armed one that applies. */
export function takeForcedFailure(app: SandboxApp, headers: Record<string, string | undefined>, contactId: number): { mode: 'reject' | 'fail'; code: string } | null {
  const reject = headers['x-sandbox-reject'];
  if (reject) return { mode: 'reject', code: parseForced('reject', reject, 'X-Sandbox-Reject') };
  const fail = headers['x-sandbox-fail'];
  if (fail) return { mode: 'fail', code: parseForced('fail', fail, 'X-Sandbox-Fail') };
  const armed = app.store.failures.find((f) => f.mode !== 'edge' && f.remaining > 0 && (f.contactId === null || f.contactId === contactId));
  if (!armed) return null;
  armed.remaining--;
  if (armed.remaining <= 0) app.store.failures = app.store.failures.filter((f) => f !== armed);
  return { mode: armed.mode as 'reject' | 'fail', code: armed.code };
}

export type SendProfile = 'free_form' | 'template';

/**
 * The MAC gate of `MacService::evaluateOutboundGate`: while the account is in its 24-hour lockout, a send to a
 * contact that is not active in the cycle answers `429 mac_lockout_24h`; a contact marked inactive by MAC gets the
 * same answer. Templates have no MAC gate with a key.
 */
export function macRejection(app: SandboxApp, contact: Contact): ApiError | null {
  const { mac } = app.store;
  if (mac.inactiveContacts.has(contact.id)) return rejection('mac_lockout_24h');
  if (mac.lockout && !mac.activeContacts.has(contact.id)) return rejection('mac_lockout_24h');
  return null;
}

export interface SendCheck {
  device: Device;
  contact: Contact;
  profile: SendProfile;
  /** `phone` / `whatsapp_id` of the body, when the route takes them. */
  phone?: unknown;
  whatsappId?: unknown;
  /** One hash per message the call produces (a text, each card…), for the spam brakes. */
  contentHashes: string[];
}

export function contentHash(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

const INDIVIDUAL_DOMAINS = ['s.whatsapp.net', 'c.us', 'lid'];

function recipientIdentity(contact: Contact): string | null {
  return contact.whatsappId?.trim() || contact.phone?.trim() || null;
}

function isIndividual(identity: string | null): boolean {
  if (identity === null || !identity.includes('@')) return true;
  return INDIVIDUAL_DOMAINS.includes(identity.slice(identity.lastIndexOf('@') + 1).toLowerCase());
}

/** `ApiRecipientBinding::bodyIdentifiesContact`: the body's phone / whatsapp_id are the contact's. */
function bodyIdentifiesContact(contact: Contact, phone: unknown, whatsappId: unknown): boolean {
  const stored = [digits(contact.phone), digits(contact.whatsappId)].filter((d) => d !== '');
  for (const [field, value] of [['whatsapp_id', whatsappId], ['phone', phone]] as const) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    const exact = field === 'whatsapp_id' && contact.whatsappId !== null && text === contact.whatsappId;
    const d = digits(text);
    if (!exact && (d === '' || !stored.includes(d))) return false;
  }
  return true;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Official numbers (`config/send_guards.php`): up to 60 messages per second, and 10 per calendar minute to the same contact. */
const CLOUD_PER_SECOND = 60;
const CLOUD_PAIR_PER_MINUTE = 10;
/** The brakes of `AntiBlockGuardService` for API keys, per contact in 24 hours. */
const MAX_IDENTICAL = 2;
const MAX_UNANSWERED = 5;

/** Runs the rules in order; returns the rejection, or `null` when the send may go out. Moves no counter. */
export function checkSend(app: SandboxApp, check: SendCheck, now = Date.now()): ApiError | null {
  const { store, config } = app;
  const { device, contact } = check;

  if (!device.connected) return rejection('device_unavailable');
  if (!bodyIdentifiesContact(contact, check.phone, check.whatsappId)) return rejection('recipient_mismatch');
  if (!isIndividual(recipientIdentity(contact))) return rejection('recipient_unsupported');

  if (config.rules.rateLimit && device.kind === 'cloud') {
    const count = check.contentHashes.length;
    const second = (store.pace.get(`${device.id}`) ?? []).filter((t) => now - t < 1000);
    if (second.length + count > CLOUD_PER_SECOND) return rejection('rate_limited', 1);
    // Per calendar minute: `Retry-After` is what is left of it (`max(1, 60 - now % 60)`).
    const minuteStart = now - (now % MINUTE);
    const pair = (store.pace.get(`${device.id}:${contact.id}`) ?? []).filter((t) => t >= minuteStart);
    if (pair.length + count > CLOUD_PAIR_PER_MINUTE) {
      return rejection('rate_limited', Math.max(1, 60 - Math.floor((now % MINUTE) / 1000)));
    }
  }

  if (config.rules.window && check.profile === 'free_form' && device.kind === 'cloud' && !store.windowOpen(contact.id, device.id, new Date(now))) {
    return rejection('window_closed');
  }

  if (config.rules.antiblock) {
    const sent = (store.unanswered.get(contact.id) ?? []).filter((s) => now - s.at.getTime() < DAY);
    const pending = [...sent];
    for (const hash of check.contentHashes) {
      if (pending.filter((s) => s.hash === hash).length >= MAX_IDENTICAL) return rejection('antiblock_duplicate_content');
      if (pending.length >= MAX_UNANSWERED) return rejection('antiblock_unanswered_limit');
      pending.push({ at: new Date(now), hash });
    }
  }
  return null;
}

/** Counts an accepted send for the pace and the spam brakes. */
export function recordSend(app: SandboxApp, check: SendCheck, now = Date.now()): void {
  const { store } = app;
  const { device, contact } = check;
  for (const key of [`${device.id}`, `${device.id}:${contact.id}`]) {
    const list = (store.pace.get(key) ?? []).filter((t) => now - t < MINUTE);
    for (let i = 0; i < check.contentHashes.length; i++) list.push(now);
    store.pace.set(key, list);
  }
  const sent = (store.unanswered.get(contact.id) ?? []).filter((s) => now - s.at.getTime() < DAY);
  for (const hash of check.contentHashes) sent.push({ at: new Date(now), hash });
  store.unanswered.set(contact.id, sent);
}
