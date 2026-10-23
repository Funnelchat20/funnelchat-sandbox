/**
 * Sign-up links (`/api/v1/connect-links`), from the contract of the sign-up by API (22-10, section A1) and its
 * amendment v0.1 (23-10, read from accounts `feat/alta-de-numeros-api` `52d49b319`): a link of the account, with no
 * number yet, that creates the number when the hosted page completes (`/connect/{token}`, numbers/page.ts), or
 * reconnects the number of `device_id`.
 *
 * Statuses: `pending` → `completed` | `failed`, or `expired` (past `expires_at`) or `revoked` (`DELETE`). The id is an
 * integer. The raw token is only in the `url` of the create answer; the sandbox keeps its sha256.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, noContent, ok, type HandlerTable } from '../http/context.js';
import { ApiError, invalidRequest, notFound, RawApiError } from '../http/errors.js';
import { idempotent } from '../http/idempotency.js';
import { paginate } from '../http/paginate.js';
import {
  checkQuota,
  checkSameNumber,
  invalidReferenceDevice,
  newToken,
  OPEN_LINKS_LIMIT,
  openLinks,
  refreshLink,
  sha256,
} from '../numbers/numbers.js';
import { connectLinkResource } from '../state/resources.js';
import type { ConnectLink } from '../state/store.js';

const DEFAULT_EXPIRES_IN_MINUTES = 1440;

function linkOf(app: SandboxApp, id: unknown): ConnectLink {
  const link = app.store.connectLinks.get(Number(id));
  if (!link) throw notFound('No encontramos ese link de alta en la cuenta.');
  return refreshLink(link);
}

/** Laravel's `prohibited` lets through a missing field, `null`, `""` and `[]`; anything else (even `false`) is present. */
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/**
 * The rules between fields that the schema does not express, by `type` (amendment v0.1):
 * `allowed_connection_types` required with `meta` and prohibited with `qr`; `provision_us_number` prohibited with
 * `qr`; `same_number_as` prohibited with `meta` and excluding `device_id`; `return_url` only `https`. And, from the
 * amendment v0.2, `provision_us_number: true` needs `dedicated` among `allowed_connection_types` and no `device_id`: a
 * number of the pool is always dedicated, and new.
 */
function checkLinkBody(b: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  const meta = b.type === 'meta';
  if (meta && !present(b.allowed_connection_types)) {
    errors.allowed_connection_types = ['El campo allowed_connection_types es obligatorio cuando type es meta.'];
  }
  if (!meta && present(b.allowed_connection_types)) {
    errors.allowed_connection_types = ['El campo allowed_connection_types está prohibido cuando type es qr.'];
  }
  if (!meta && present(b.provision_us_number)) errors.provision_us_number = ['El campo provision_us_number está prohibido cuando type es qr.'];
  else if (meta && b.provision_us_number === true) {
    const allowed = Array.isArray(b.allowed_connection_types) ? b.allowed_connection_types : [];
    if (present(b.device_id)) errors.provision_us_number = ['El campo provision_us_number no se acepta junto con device_id.'];
    else if (present(b.allowed_connection_types) && !allowed.includes('dedicated')) {
      errors.provision_us_number = ['El campo provision_us_number exige dedicated en allowed_connection_types.'];
    }
  }
  if (meta && present(b.same_number_as)) errors.same_number_as = ['El campo same_number_as está prohibido cuando type es meta.'];
  else if (present(b.same_number_as) && present(b.device_id)) errors.same_number_as = ['El campo same_number_as prohíbe que device_id esté presente.'];
  if (present(b.return_url)) {
    let url: URL | null = null;
    try {
      url = new URL(String(b.return_url));
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:') errors.return_url = ['El campo return_url debe ser una URL https.'];
  }
  if (Object.keys(errors).length) throw invalidRequest(errors);
}

/** `throttle`: N creations per minute per account; one more gets Laravel's own `429`, without `error`. */
function throttle(app: SandboxApp): void {
  const now = Date.now();
  const { store } = app;
  store.linkAttempts = store.linkAttempts.filter((at) => now - at < 60_000);
  if (store.linkAttempts.length >= store.numbers.linksPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((60_000 - (now - (store.linkAttempts[0] as number))) / 1000));
    throw new RawApiError(429, { message: 'Too Many Attempts.' }, { 'Retry-After': String(retryAfter) });
  }
  store.linkAttempts.push(now);
}

export const connectLinkHandlers: HandlerTable = {
  'POST /api/v1/connect-links': (ctx) => {
    throttle(ctx.app);
    return idempotent(ctx, 'connect-links', () => {
      const { app } = ctx;
      const b = body(ctx);
      checkLinkBody(b);
      if (b.type === 'meta' && !app.store.numbers.metaConnect) {
        throw new ApiError(503, 'meta_connect_disabled', 'El alta de números oficiales por link no está disponible todavía.');
      }
      const reconnect = present(b.device_id);
      if (reconnect) {
        const device = app.store.devices.get(Number(b.device_id));
        if (!device) throw invalidReferenceDevice();
        if ((device.kind === 'qr') !== (b.type === 'qr')) {
          throw new ApiError(422, 'connection_type_mismatch', 'El type del link tiene que coincidir con el método del número a reconectar.');
        }
      }
      const sameNumberAs = present(b.same_number_as) ? checkSameNumber(app, b.same_number_as).id : null;
      // A reconnection, or QR on a number in coexistence, takes no new place.
      if (!reconnect && sameNumberAs === null) checkQuota(app);
      if (openLinks(app) >= OPEN_LINKS_LIMIT) {
        throw new ApiError(429, 'too_many_open_links', `Tienes ${OPEN_LINKS_LIMIT} links de alta abiertos. Revoca alguno o espera a que venzan.`, { limit: OPEN_LINKS_LIMIT });
      }
      const now = new Date();
      const deviceId = reconnect ? Number(b.device_id) : null;
      // A new reconnection link for a number revokes the earlier ones of that number.
      if (reconnect) {
        for (const other of app.store.connectLinks.values()) {
          if (other.reconnect && other.deviceId === deviceId && refreshLink(other).status === 'pending') {
            other.status = 'revoked';
            other.errorCode = 'revoked';
          }
        }
      }
      const token = newToken();
      const minutes = present(b.expires_in_minutes) ? Number(b.expires_in_minutes) : DEFAULT_EXPIRES_IN_MINUTES;
      const link: ConnectLink = {
        id: app.store.ids.connectLink.next(),
        type: b.type === 'meta' ? 'meta' : 'qr',
        status: 'pending',
        tokenHash: sha256(token),
        allowedConnectionTypes: b.type === 'meta' ? [...new Set(b.allowed_connection_types as ('coexistence' | 'dedicated')[])] : null,
        provisionUsNumber: b.type === 'meta' && b.provision_us_number === true,
        deviceId,
        reconnect,
        sameNumberAs,
        externalReference: present(b.external_reference) ? String(b.external_reference) : null,
        returnUrl: present(b.return_url) ? String(b.return_url) : null,
        errorCode: null,
        failedAttempts: 0,
        expiresAt: new Date(now.getTime() + minutes * 60_000),
        createdAt: now,
        completedAt: null,
      };
      app.store.connectLinks.set(link.id, link);
      app.logger.info(`sign-up link ${link.id} (${link.type}) → ${app.publicUrl}/connect/…`);
      const { id, type, status, ...rest } = connectLinkResource(link);
      return { status: 201, body: { data: { id, type, status, url: `${app.publicUrl}/connect/${token}`, ...rest } }, headers: { 'Cache-Control': 'no-store' } };
    });
  },

  // Paginated like the other lists, newest first (by id); filters by `status` and `external_reference`.
  'GET /api/v1/connect-links': (ctx) => {
    const { status, external_reference: reference } = ctx.query;
    const list = [...ctx.app.store.connectLinks.values()]
      .map((link) => refreshLink(link))
      .filter((link) => !status || link.status === status)
      .filter((link) => reference === undefined || reference === '' || link.externalReference === String(reference))
      .sort((a, b) => b.id - a.id);
    return ok(paginate(list, listContext(ctx), connectLinkResource));
  },

  'GET /api/v1/connect-links/{link}': (ctx) => ok({ data: connectLinkResource(linkOf(ctx.app, ctx.path.link)) }),

  'DELETE /api/v1/connect-links/{link}': (ctx) => {
    const link = linkOf(ctx.app, ctx.path.link);
    if (link.status !== 'pending') {
      throw new ApiError(409, 'link_not_pending', `El link ya no está pendiente: está ${link.status}.`, { status: link.status });
    }
    link.status = 'revoked';
    link.errorCode = 'revoked';
    return noContent();
  },
};
