/**
 * The numbers of the account (accounts domain): list, show, edit and delete, and — from the contract of the sign-up by
 * API (22-10, section A1) while accounts writes it — create a number by QR (`POST /devices`) and its QR code
 * (`GET /devices/{device}/qr`), with the shapes and errors of the contract's amendment v0.1 (23-10).
 *
 * The phone of a number created by QR arrives when it is scanned; in the sandbox, with
 * `POST /_sandbox/devices/{id}/connect`.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, ok, type HandlerTable } from '../http/context.js';
import { ApiError, RawApiError } from '../http/errors.js';
import { idempotent } from '../http/idempotency.js';
import { paginate } from '../http/paginate.js';
import { checkPendingNumber, checkQuota, checkSameNumber, createDevice, deleteDevice } from '../numbers/numbers.js';
import { fakeQrDataUri } from '../numbers/qr.js';
import { deviceResource } from '../state/resources.js';
import type { Device } from '../state/store.js';

/** Seconds the QR is good for: ask for it again after them (0 once connected). */
export const QR_EXPIRES_IN = 20;

function deviceOf(app: SandboxApp, id: unknown): Device {
  const device = app.store.devices.get(Number(id));
  // accounts `bootstrap/app.php`: the 404 of a model, in English and without `error`.
  if (!device) throw new RawApiError(404, { message: 'Object not found' });
  return device;
}

const optionalText = (value: unknown): string | null => (value === undefined || value === null ? null : String(value));

export const deviceHandlers: HandlerTable = {
  // With an API key the list always paginates (accounts `PublicApiListings`: `perPage`, 25 by default, up to 100, by
  // id). `external_reference` filters by exact equality.
  'GET /api/v1/devices': (ctx) => {
    const reference = ctx.query.external_reference;
    const list = [...ctx.app.store.devices.values()]
      .filter((d) => reference === undefined || reference === '' || d.externalReference === String(reference))
      .sort((a, b) => a.id - b.id);
    return ok(paginate(list, listContext(ctx), deviceResource));
  },

  'GET /api/v1/devices/{device}': (ctx) => ok(deviceResource(deviceOf(ctx.app, ctx.path.device))),

  // What the sandbox keeps: the alias and the external reference. The rest of the body is accepted and ignored.
  'PUT /api/v1/devices/{device}': (ctx) => {
    const device = deviceOf(ctx.app, ctx.path.device);
    const b = body(ctx);
    if (typeof b.alias === 'string' && b.alias.trim() !== '') device.alias = b.alias;
    if ('external_reference' in b) device.externalReference = optionalText(b.external_reference);
    return ok(deviceResource(device));
  },

  // `200` with an empty body, as today.
  'DELETE /api/v1/devices/{device}': (ctx) => {
    deleteDevice(ctx.app, deviceOf(ctx.app, ctx.path.device));
    return { status: 200 };
  },

  'POST /api/v1/devices': (ctx) =>
    idempotent(ctx, 'devices', () => {
      const b = body(ctx);
      // QR on a number in coexistence takes no new place; any other number checks the quota, and the pool keeps one
      // unconnected QR number per account.
      const target = b.same_number_as === undefined || b.same_number_as === null ? null : checkSameNumber(ctx.app, b.same_number_as);
      if (!target) {
        checkQuota(ctx.app);
        checkPendingNumber(ctx.app);
      }
      const device = createDevice(ctx.app, {
        connection: 'qr',
        alias: optionalText(b.alias) ?? target?.alias ?? null,
        number: target?.number ?? null,
        externalReference: optionalText(b.external_reference) ?? target?.externalReference ?? null,
      });
      return ok({ data: deviceResource(device) }, 201);
    }),

  'GET /api/v1/devices/{device}/qr': (ctx) => {
    const device = deviceOf(ctx.app, ctx.path.device);
    if (device.kind !== 'qr') throw new ApiError(422, 'provider_unsupported', 'El código QR solo existe para números por QR.');
    return ok({
      data: {
        connected: device.connected,
        qr_code: device.connected ? null : fakeQrDataUri(`${device.id}:${Math.floor(Date.now() / (QR_EXPIRES_IN * 1000))}`),
        expires_in: device.connected ? 0 : QR_EXPIRES_IN,
      },
    });
  },
};
