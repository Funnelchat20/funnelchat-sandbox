/**
 * Sign-up links (`/api/v1/connect-links`), from the contract of the sign-up by API (22-10, section A1) while accounts
 * writes it: a link of the account, with no number yet, that creates the number when the hosted page completes
 * (`/connect/{token}`, numbers/page.ts), or reconnects the number of `device_id`.
 *
 * Statuses: `pending` → `completed` | `failed`, or `expired` (past `expires_at`) or `revoked` (`DELETE`). The raw token
 * is only in the `url` of the create answer; the sandbox keeps its sha256.
 */
import { body, listContext, noContent, ok, type HandlerTable } from '../http/context.js';
import { ApiError, notFound, validationFailed } from '../http/errors.js';
import { idempotent } from '../http/idempotency.js';
import { paginate } from '../http/paginate.js';
import { checkQuota, checkSameNumber, newToken, OPEN_LINKS_LIMIT, openLinks, refreshLink, sha256 } from '../numbers/numbers.js';
import { connectLinkResource } from '../state/resources.js';
import type { ConnectLink } from '../state/store.js';
import type { SandboxApp } from '../app.js';
import { uuid } from '../util.js';

const DEFAULT_EXPIRES_IN_MINUTES = 1440;

function linkOf(app: SandboxApp, id: unknown): ConnectLink {
  const link = app.store.connectLinks.get(String(id));
  if (!link) throw notFound('No encontramos ese link de alta en la cuenta.');
  return refreshLink(link);
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

/** The rules between fields that the schema does not express (contract A1). */
function checkLinkBody(app: SandboxApp, b: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  const meta = b.type === 'meta';
  if (meta && !present(b.allowed_connection_types)) {
    errors.allowed_connection_types = ['El campo allowed_connection_types es obligatorio cuando type es meta.'];
  }
  if (!meta && present(b.allowed_connection_types)) {
    errors.allowed_connection_types = ['El campo allowed_connection_types está prohibido cuando type es qr.'];
  }
  if (!meta && b.provision_us_number === true) errors.provision_us_number = ['El campo provision_us_number solo se acepta cuando type es meta.'];
  if (meta && present(b.same_number_as)) errors.same_number_as = ['El campo same_number_as solo se acepta cuando type es qr.'];
  if (present(b.same_number_as) && present(b.device_id)) errors.same_number_as = ['El campo same_number_as está prohibido cuando se envía device_id.'];
  if (present(b.return_url)) {
    let url: URL | null = null;
    try {
      url = new URL(String(b.return_url));
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:') errors.return_url = ['El campo return_url debe ser una URL https.'];
  }
  if (present(b.device_id)) {
    const device = app.store.devices.get(Number(b.device_id));
    if (!device) errors.device_id = ['El campo device_id no corresponde a un número de la cuenta.'];
    else if ((device.kind === 'qr') !== (b.type === 'qr')) errors.device_id = ['El type del link tiene que coincidir con el método del número a reconectar.'];
  }
  if (Object.keys(errors).length) throw validationFailed(errors);
}

export const connectLinkHandlers: HandlerTable = {
  'POST /api/v1/connect-links': (ctx) =>
    idempotent(ctx, () => {
      const { app } = ctx;
      const b = body(ctx);
      checkLinkBody(app, b);
      if (b.type === 'meta' && !app.store.numbers.metaConnect) {
        throw new ApiError(503, 'meta_connect_disabled', 'El alta de números oficiales por link no está disponible todavía.');
      }
      const reconnect = present(b.device_id);
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
      const minutes = b.expires_in_minutes === undefined || b.expires_in_minutes === null ? DEFAULT_EXPIRES_IN_MINUTES : Number(b.expires_in_minutes);
      const link: ConnectLink = {
        id: uuid(),
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
        expiresAt: new Date(now.getTime() + minutes * 60_000),
        createdAt: now,
        completedAt: null,
      };
      app.store.connectLinks.set(link.id, link);
      app.logger.info(`sign-up link ${link.id} (${link.type}) → ${app.publicUrl}/connect/…`);
      const { id, type, status, ...rest } = connectLinkResource(link);
      return ok({ data: { id, type, status, url: `${app.publicUrl}/connect/${token}`, ...rest } }, 201);
    }),

  // Paginated like the other lists, oldest first; filters by `status` and `external_reference`.
  'GET /api/v1/connect-links': (ctx) => {
    const { status, external_reference: reference } = ctx.query;
    const list = [...ctx.app.store.connectLinks.values()]
      .map((link) => refreshLink(link))
      .filter((link) => !status || link.status === status)
      .filter((link) => reference === undefined || reference === '' || link.externalReference === String(reference))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
