/**
 * Numbers and sign-up links, as the contract of the sign-up by API describes them (22-10, sections A1 and A3), from
 * the contract while accounts writes it:
 *
 * - the quota of the plan counts phones, not rows: QR and Meta of the same phone count once, and a number created by
 *   QR that was not scanned yet takes its own place;
 * - `same_number_as` adds QR to a number in coexistence without taking a place;
 * - the four `device.*` events carry `device { id, name, number, connection, external_reference }` and
 *   `connect_link_id`: the link that connected the number last, or `null`.
 *
 * Amended by v0.1 of the contract (23-10, read from accounts `feat/alta-de-numeros-api` `52d49b319`): the errors,
 * the integer id of a link, `pending_number_exists`, `connect_link_id` in the four events and the reason
 * `disconnected_by_user`; and by v0.2 (accounts `8852b3fad`, part 2 done): a Meta link survives up to five failed
 * attempts of Facebook or Meta, and the customer cannot choose a connection the link does not allow.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import { ApiError } from '../http/errors.js';
import { eventDevice } from '../state/resources.js';
import type { ConnectLink, Connection, Device, HealthState } from '../state/store.js';
import { isoSeconds } from '../util.js';

/** Closed list of `device.disconnected` `reason` (contract A3). */
export const DISCONNECT_REASONS = ['qr_logged_out', 'meta_account_not_registered', 'shadow_ban_protection', 'provider_error', 'unknown', 'disconnected_by_user'] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number];

export const HEALTH_STATES: HealthState[] = ['available', 'limited', 'blocked', 'unknown'];

/** Closed list of a link's `error_code` (contract A1). */
export const LINK_ERROR_CODES = [
  'link_expired',
  'already_used',
  'revoked',
  'quota_exceeded',
  'trial_number_blocked',
  'facebook_auth_failed',
  'meta_error',
  'number_not_owned',
  'qr_timeout',
  'provider_error',
] as const;

/** Open sign-up links per account (contract A1): one more answers `429 too_many_open_links`. */
export const OPEN_LINKS_LIMIT = 20;

/** Numbers of the US pool per account: 3, and 1 for a trial account (the panel's limits). */
export const poolLimit = (app: SandboxApp): number => (app.store.numbers.trial ? 1 : 3);

/** What occupies a place of the quota: the phone, or the row while it has none. */
const placeOf = (device: Device): string => device.number ?? `device:${device.id}`;

export function placesInUse(app: SandboxApp): number {
  return new Set([...app.store.devices.values()].map(placeOf)).size;
}

/** A QR number never connected yet: the pool keeps at most one per account. */
const isPendingQr = (device: Device): boolean => device.kind === 'qr' && !device.connected && device.firstConnectedAt === null;

export function pendingQrIds(app: SandboxApp): number[] {
  return [...app.store.devices.values()].filter(isPendingQr).map((d) => d.id);
}

/** The two `403` of the quota (accounts `CreateDeviceInPool`), before anything is created. */
export function checkQuota(app: SandboxApp): void {
  const { numbers } = app.store;
  if (!numbers.included) {
    throw new ApiError(403, 'numbers_not_included', 'Tu plan no incluye números de WhatsApp.');
  }
  const used = placesInUse(app);
  if (used >= numbers.limit) {
    throw new ApiError(403, 'number_limit_reached', `Alcanzaste el límite de ${numbers.limit} números de tu plan.`, {
      limit: numbers.limit,
      used,
      pending_device_ids: pendingQrIds(app),
    });
  }
}

/**
 * The pool gives the same unconnected QR number back instead of creating another one; so two customers never get the
 * same QR, the API answers `409 pending_number_exists` with its id.
 */
export function checkPendingNumber(app: SandboxApp): void {
  const [pending] = pendingQrIds(app);
  if (pending !== undefined) {
    throw new ApiError(409, 'pending_number_exists', 'Ya tienes un número por QR sin conectar: conéctalo o bórralo antes de crear otro.', { device_id: pending });
  }
}

/** `device_id` or `same_number_as` that is not a number of the account. */
export const invalidReferenceDevice = () => new ApiError(422, 'invalid_reference_device', 'El número indicado no existe en la cuenta.');

/**
 * `same_number_as`: QR can be added only to an official number in coexistence that has no QR yet. Returns the number
 * whose phone the new QR takes.
 */
export function checkSameNumber(app: SandboxApp, id: unknown): Device {
  const target = app.store.devices.get(Number(id));
  if (!target) throw invalidReferenceDevice();
  if (target.kind === 'qr') {
    throw new ApiError(422, 'method_already_present', 'Ese número ya tiene QR.', { device_id: target.id });
  }
  const sibling = [...app.store.devices.values()].find((d) => d.kind === 'qr' && d.number !== null && d.number === target.number);
  if (sibling) throw new ApiError(422, 'method_already_present', 'Ese número ya tiene QR.', { device_id: sibling.id });
  if (!target.coexistence) {
    throw new ApiError(422, 'qr_requires_coexistence', 'Solo puedes sumar QR a un número oficial que esté en coexistencia con la app de WhatsApp Business.');
  }
  return target;
}

export interface NewDevice {
  connection: Connection;
  alias?: string | null;
  number?: string | null;
  externalReference?: string | null;
  connected?: boolean;
  fromPool?: boolean;
}

export function createDevice(app: SandboxApp, input: NewDevice): Device {
  const id = app.store.ids.device.next();
  const now = new Date();
  const cloud = input.connection !== 'qr';
  const connected = input.connected ?? false;
  const device: Device = {
    id,
    alias: input.alias ?? `Número ${id}`,
    number: input.number ?? null,
    provider: cloud ? 2 : 1,
    kind: cloud ? 'cloud' : 'qr',
    connected,
    coexistence: input.connection === 'coexistence',
    fromPool: input.fromPool ?? false,
    externalReference: input.externalReference ?? null,
    health: cloud ? (connected ? 'available' : 'unknown') : null,
    lastConnectLinkId: null,
    wabaId: cloud ? `1000000000${String(id).padStart(5, '0')}` : null,
    phoneNumberId: cloud ? `2000000000${String(id).padStart(5, '0')}` : null,
    firstConnectedAt: connected ? now : null,
    createdAt: now,
  };
  app.store.devices.set(id, device);
  return device;
}

/** A phone for a number that connects in the sandbox: Argentina for QR and coexistence, the US for the pool. */
export function fakeNumber(device: Device): string {
  const tail = String(device.id).padStart(4, '0').slice(-4);
  return device.fromPool ? `1555010${tail}` : `54911555${tail}`;
}

/**
 * `data` of every `device.*` event: the number, and `connect_link_id`, by default the link that connected it last
 * (`device.connected` passes the link of that connection instead).
 */
const eventData = (device: Device, rest: Record<string, unknown>, connectLinkId = device.lastConnectLinkId) => ({
  device: eventDevice(device),
  ...rest,
  connect_link_id: connectLinkId,
});

/**
 * Connects a number and emits `device.connected`, whose `connect_link_id` is the link of this connection (`null`
 * without one). A link that connects it is remembered for the other three events; a connection without a link does
 * not forget it. Nothing happens if it was already connected.
 */
export function connectDevice(app: SandboxApp, device: Device, options: { number?: string | null; connectLinkId?: number | null } = {}) {
  if (device.connected) return null;
  const at = new Date();
  const connectLinkId = options.connectLinkId ?? null;
  if (connectLinkId !== null) device.lastConnectLinkId = connectLinkId;
  if (options.number) device.number = options.number;
  device.number ??= fakeNumber(device);
  device.connected = true;
  device.firstConnectedAt ??= at;
  if (device.kind === 'cloud' && (device.health === null || device.health === 'unknown')) device.health = 'available';
  return app.webhooks.emit('device.connected', eventData(device, { connected_at: isoSeconds(at) }, connectLinkId), { occurredAt: at });
}

export function disconnectDevice(app: SandboxApp, device: Device, reason: DisconnectReason) {
  if (!device.connected) return null;
  const at = new Date();
  device.connected = false;
  return app.webhooks.emit('device.disconnected', eventData(device, { disconnected_at: isoSeconds(at), reason }), { occurredAt: at });
}

/** Emits `device.health_changed` only when the aggregated state changes. */
export function setHealth(app: SandboxApp, device: Device, state: HealthState) {
  const previous = device.health ?? 'unknown';
  if (previous === state) return null;
  device.health = state;
  const at = new Date();
  return app.webhooks.emit('device.health_changed', eventData(device, { previous_state: previous, state, changed_at: isoSeconds(at) }), { occurredAt: at });
}

/**
 * accounts `RetireDevices::delete`: `device.deleted` before the row goes, the place of the quota freed. The pending
 * links that reconnect it are revoked: nothing is left to reconnect.
 */
export function deleteDevice(app: SandboxApp, device: Device) {
  const at = new Date();
  const event = app.webhooks.emit('device.deleted', eventData(device, { deleted_at: isoSeconds(at) }), { occurredAt: at });
  app.store.devices.delete(device.id);
  for (const link of app.store.connectLinks.values()) {
    if (link.reconnect && link.deviceId === device.id && link.status === 'pending') {
      link.status = 'revoked';
      link.errorCode = 'revoked';
    }
  }
  return event;
}

// --- sign-up links ---------------------------------------------------------------------------------------------

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const newToken = (): string => randomBytes(32).toString('base64url');

/** A pending link past its `expires_at` is `expired` from then on. */
export function refreshLink(link: ConnectLink, now = new Date()): ConnectLink {
  if (link.status === 'pending' && link.expiresAt.getTime() <= now.getTime()) {
    link.status = 'expired';
    link.errorCode = 'link_expired';
  }
  return link;
}

export function findLinkByToken(app: SandboxApp, token: string): ConnectLink | undefined {
  const hash = sha256(token);
  for (const link of app.store.connectLinks.values()) if (link.tokenHash === hash) return refreshLink(link);
  return undefined;
}

export function openLinks(app: SandboxApp): number {
  let n = 0;
  for (const link of app.store.connectLinks.values()) if (refreshLink(link).status === 'pending') n++;
  return n;
}

export interface LinkOutcome {
  /** `completed` (the default) or `failed`. */
  outcome: 'completed' | 'failed';
  /** For `failed`: one of the closed list; by default `qr_timeout` (QR) or `meta_error` (Meta). */
  errorCode?: string | null;
  /** Meta only: what the customer chose when the link allows both. */
  connection?: 'coexistence' | 'dedicated' | null;
  /** The phone that connects, digits only; a fake one otherwise. */
  number?: string | null;
}

/** Failed attempts of a Meta link before it ends `failed` (amendment v0.2). */
export const META_ATTEMPTS = 5;

/** Failures of Facebook or Meta: the link stays `pending` so the customer retries from the page. */
const RETRYABLE = ['facebook_auth_failed', 'meta_error'];

/** What the page says after an attempt: `retry` is not an `error_code` of the link, which stays `pending`. */
export type AttemptResult = 'completed' | 'failed' | 'retry';

function fail(link: ConnectLink, code: string): AttemptResult {
  link.status = 'failed';
  link.errorCode = code;
  link.completedAt = new Date();
  return 'failed';
}

/** A Meta link that allows a single connection cannot be completed with the other one: `422 connection_type_not_allowed`. */
export function connectionAllowed(link: ConnectLink, connection: LinkOutcome['connection']): boolean {
  return link.type !== 'meta' || !connection || (link.allowedConnectionTypes ?? []).includes(connection);
}

/**
 * What the hosted page does at the end, in one step: the sandbox "connects" at once. Creates the number (checking the
 * quota again), or reconnects the one of the link, or adds QR to a number in coexistence; marks the link and emits
 * `device.connected` with `connect_link_id`. The link must be `pending`.
 *
 * A failure of Facebook or Meta on a Meta link (`facebook_auth_failed`, `meta_error`) leaves it `pending` until the
 * fifth one; any other failure (`quota_exceeded`, `trial_number_blocked`, `number_not_owned`, a QR's `qr_timeout`…)
 * closes it at once.
 */
export function completeLink(app: SandboxApp, link: ConnectLink, input: LinkOutcome): AttemptResult {
  if (input.outcome === 'failed') {
    const code = input.errorCode ?? (link.type === 'qr' ? 'qr_timeout' : 'meta_error');
    if (link.type === 'meta' && RETRYABLE.includes(code)) {
      link.failedAttempts++;
      if (link.failedAttempts < META_ATTEMPTS) {
        link.errorCode = null;
        return 'retry';
      }
    }
    return fail(link, code);
  }
  link.status = 'completed';

  if (link.reconnect) {
    const device = link.deviceId === null ? undefined : app.store.devices.get(link.deviceId);
    if (!device) return fail(link, 'provider_error');
    link.completedAt = new Date();
    connectDevice(app, device, { number: input.number, connectLinkId: link.id });
    return 'completed';
  }

  let connection: Connection = 'qr';
  let number = input.number ?? null;
  let fromPool = false;
  if (link.sameNumberAs !== null) {
    const target = app.store.devices.get(link.sameNumberAs);
    if (!target || !target.coexistence) return fail(link, 'provider_error');
    number = target.number;
  } else {
    try {
      checkQuota(app);
    } catch {
      return fail(link, 'quota_exceeded');
    }
  }
  if (link.type === 'meta') {
    const allowed = link.allowedConnectionTypes ?? ['dedicated'];
    connection = input.connection && allowed.includes(input.connection) ? input.connection : (allowed[0] as Connection);
    // A number of the pool is always dedicated.
    if (connection === 'dedicated' && link.provisionUsNumber && !number) {
      const inPool = [...app.store.devices.values()].filter((d) => d.fromPool).length;
      if (inPool >= poolLimit(app)) return fail(link, app.store.numbers.trial ? 'trial_number_blocked' : 'quota_exceeded');
      fromPool = true;
    }
  }

  const device = createDevice(app, { connection, externalReference: link.externalReference, fromPool, number });
  link.deviceId = device.id;
  link.completedAt = new Date();
  connectDevice(app, device, { connectLinkId: link.id });
  return 'completed';
}

/** `return_url?connect_link_id=…&status=…&device_id=…&error_code=…`, without other data. */
export function returnUrlFor(link: ConnectLink): string | null {
  if (!link.returnUrl) return null;
  const url = new URL(link.returnUrl);
  url.searchParams.set('connect_link_id', String(link.id));
  url.searchParams.set('status', link.status === 'completed' ? 'completed' : 'failed');
  if (link.deviceId !== null && link.status === 'completed') url.searchParams.set('device_id', String(link.deviceId));
  if (link.errorCode && link.status !== 'completed') url.searchParams.set('error_code', link.errorCode);
  return url.toString();
}
