/**
 * Groups (communities domain), as communities v2.35.7 answers them to an API key: the list and one group with state,
 * and the send of a message to a group, a group action that answers `202` with an `action_id` and is followed with
 * `GET /groups/actions/{action}`.
 *
 * Groups without the panel (v2.35.7): `GET /devices/{device}/groups` is the number's live list on WhatsApp (in the
 * sandbox, its groups whether the account has them or not); `POST /groups/{group}/import` follows one of them (imports
 * it to the account, so `group_participant.joined` / `.left` start), and a send to a group the account does not have
 * imports it first. Only QR numbers; 5 imports per number per minute; importing needs `communities:operate`.
 *
 * The group actions are behind communities' kill switch (`API_GROUP_ACTIONS_ENABLED`), on in production since the
 * user confirmed it on 04-11. The sandbox starts the same way (`groupActions: true`); `--no-group-actions` imitates
 * the switch off, where every key gets the gate's `403 route_not_available` before anything is validated.
 *
 * Workspaces: a key lists and reaches only the groups of its workspace (and, from the default one, those without a
 * workspace); one of another workspace answers `404`, and so does a number of another workspace on a send.
 */
import { randomUUID } from 'node:crypto';
import type { SandboxApp } from '../app.js';
import { body, listContext, ok, type HandlerContext, type HandlerTable } from '../http/context.js';
import { ApiError, RawApiError } from '../http/errors.js';
import { paginate } from '../http/paginate.js';
import type { Device, Group, GroupAction } from '../state/store.js';
import { sees, type WorkspaceScope } from '../state/workspaces.js';
import { iso8601, randomAlnum } from '../util.js';

/** The group action routes behind the kill switch (communities `ApiRouteCatalog::GROUP_ACTION_KEYS`) that the sandbox serves. */
export const GROUP_ACTION_ROUTES = new Set(['POST /api/v1/groups/{group}/messages', 'GET /api/v1/groups/actions/{action}']);

/** `2026-10-01 12:00:00`: `toDateTimeString()` in UTC, the dates of `GroupResource`. */
const dateTime = (date: Date): string => date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

const connectedNumbers = (app: SandboxApp, scope: WorkspaceScope): Device[] =>
  [...app.store.devices.values()].filter((d) => d.connected && d.number !== null && sees(scope, d.workspaceId));

/**
 * communities v2.35.5 `GroupResource`, in its order. `list` is the shape of `GET /groups` (admins with their
 * connection, `ownNumbers`); `show` the one of `GET /groups/{group}` (no connection computed, `ownNumbers: null`).
 * For a key, the numbers of other workspaces count as not connected and `deviceId` is `null` if the number is not
 * one of its workspace. `read_rate` is off in production (`FEATURE_GROUP_READ_RATE_ENABLED`).
 */
export function groupResource(app: SandboxApp, group: Group, scope: WorkspaceScope, mode: 'list' | 'show'): Record<string, unknown> {
  const mine = connectedNumbers(app, scope);
  const numberOf = (phone: string) => mine.find((d) => d.number === phone);
  const admins = group.participants.filter((p) => p.admin);
  const device = app.store.devices.get(group.deviceId);
  const owner = admins[0]?.phone ?? null;
  return {
    id: group.id,
    admins_numbers: admins.map((a) => a.phone),
    admins:
      mode === 'list'
        ? admins.map((a) => ({ phone: a.phone, lid: null, isConnected: numberOf(a.phone) !== undefined, accessDenied: false, displayPhone: a.phone }))
        : admins.map((a) => ({ phone: a.phone, lid: null, isConnected: false, displayPhone: a.phone, accessDenied: false })),
    admins_count: admins.length,
    owner,
    owner_display_phone: owner,
    owner_connected: owner !== null && numberOf(owner) !== undefined,
    clicks: 0,
    communityUid: null,
    newsletterUid: null,
    description: group.description,
    deviceId: device && sees(scope, device.workspaceId) ? device.id : null,
    image: null,
    isFull: false,
    isApi: false,
    link: group.link,
    campaign_link: '',
    campaign_custom_domain: null,
    name: group.name,
    order: null,
    participants_numbers: group.participants.length,
    participants_count: group.participants.length,
    read_rate: null,
    read_rate_messages_count: 0,
    status: 0,
    uid: group.uid,
    updatedAt: dateTime(group.updatedAt),
    createdAt: dateTime(group.createdAt),
    scheduled_message_count: 0,
    type: 1,
    manual_import: false,
    participantMode: false,
    ownNumbers:
      mode === 'list'
        ? mine.flatMap((d) => {
            const participant = group.participants.find((p) => p.phone === d.number);
            return participant ? [{ deviceId: d.id, phone: d.number, role: participant.admin ? 'admin' : 'participant' }] : [];
          })
        : null,
    adminOnlyMessage: false,
    origin: 0,
    lastSyncAt: dateTime(group.updatedAt),
  };
}

/** The uid of a group with or without `@g.us`, as communities accepts it: always with it here. */
const withSuffix = (uid: unknown): string => {
  const text = String(uid);
  return text.endsWith('@g.us') ? text : `${text}@g.us`;
};

/** A group of the account (imported) by its uid, in any workspace. */
const accountGroup = (app: SandboxApp, uid: unknown): Group | undefined =>
  [...app.store.groups.values()].find((g) => g.imported && g.uid === withSuffix(uid));

/** The group a key reaches by its `uid`: in the account and in its workspace. */
export function groupOf(app: SandboxApp, uid: unknown, scope: WorkspaceScope): Group | undefined {
  const group = accountGroup(app, uid);
  return group && sees(scope, group.workspaceId) ? group : undefined;
}

/** The groups a number is in on WhatsApp, imported or not: what the provider lists. */
const groupsOnWhatsApp = (app: SandboxApp, device: Device): Group[] =>
  device.number === null ? [] : [...app.store.groups.values()].filter((g) => g.participants.some((p) => p.phone === device.number));

const isAdminOf = (device: Device, group: Group): boolean => group.participants.some((p) => p.admin && p.phone === device.number);

/** The fixed Spanish texts of communities `BoundKeyListings` for a key's list: `422 validation_failed` with `errors`. */
function checkListQuery(q: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  if (q.perPage !== undefined) {
    const n = Number(q.perPage);
    if (!Number.isInteger(n) || n < 1) errors.perPage = ['`perPage` tiene que ser un número entero entre 1 y 100.'];
    else if (n > 100) errors.perPage = ['Con una API key, `perPage` admite como máximo 100 elementos por página.'];
  }
  if (q.orderBy !== undefined && !['created_at', 'id', 'name', 'updated_at'].includes(String(q.orderBy))) {
    errors.orderBy = ['`orderBy` solo acepta: created_at, id, name, updated_at.'];
  }
  if (q.orderByMethod !== undefined && !['asc', 'desc'].includes(String(q.orderByMethod))) errors.orderByMethod = ['`orderByMethod` solo acepta: asc, desc.'];
  const first = Object.values(errors)[0];
  if (first) throw new ApiError(422, 'validation_failed', first[0] as string, { errors });
}

const groupError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new ApiError(status, code, message, extra, headers);
const groupNotFound = () => groupError(404, 'group_not_found', 'No encontramos ese grupo en tu cuenta.');
const deviceNotConnected = () => groupError(422, 'device_not_connected', 'El número está desconectado. Reconectalo e intentá de nuevo.');

/** communities `ApiGroupActionTargetResolver::findDevice()` (and `resolveImportDevice()`, which also wants it connected). */
function importDevice(ctx: HandlerContext, deviceId: unknown, connected: boolean): Device {
  const device = ctx.app.store.devices.get(Number(deviceId));
  if (!device || !sees(ctx.workspace, device.workspaceId)) throw groupError(404, 'device_not_found', 'No encontramos ese número en tu cuenta.');
  if (connected && (!device.connected || device.number === null)) throw deviceNotConnected();
  return device;
}

const IMPORTS_PER_MINUTE = 5;
const GROUP_UID = /^[0-9]{10,25}(-[0-9]+)?(@g\.us)?$/;

/**
 * communities v2.35.7 `ApiGroupImporter`, in its order: the permission (`communities:operate`), the shape of the uid,
 * a QR number; a group already in the account answers as it is (one of another workspace, `group_not_found`); a new
 * one counts in the 5 per number per minute, is read from WhatsApp (`group_not_found` if the number is not in it) and
 * lands in the key's workspace. For a send, the number must be its admin. Two imports at a time cannot happen in the
 * sandbox: `X-Sandbox-Reject: import_in_progress` gives the `409` of the second.
 */
function importGroup(ctx: HandlerContext, device: Device, uid: string, forSend: boolean): { group: Group; imported: boolean; isAdmin: boolean } {
  const { app } = ctx;
  if (ctx.permissions !== null && !ctx.permissions.includes('communities:operate')) {
    throw groupError(403, 'import_permission_required', 'Ese grupo no está en tu cuenta. Para importarlo, la API key necesita el permiso «Grupos y campañas → Administrar grupos».');
  }
  if (uid.endsWith('@newsletter')) throw groupError(422, 'unsupported_group_type', 'Esta operación solo funciona con grupos comunes: no admite comunidades, grupos de avisos ni canales.');
  if (!GROUP_UID.test(uid)) throw groupNotFound();
  if (device.kind === 'cloud') {
    throw groupError(422, 'provider_unsupported', 'Importar grupos solo está disponible con números QR: con un número oficial no se puede leer la lista de grupos.', { provider: 'official' });
  }
  const existing = accountGroup(app, uid);
  if (existing) {
    if (!sees(ctx.workspace, existing.workspaceId)) throw groupNotFound();
    return { group: existing, imported: false, isAdmin: isAdminOf(device, existing) };
  }
  const now = Date.now();
  const recent = (app.store.groupImports.get(device.id) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= IMPORTS_PER_MINUTE) {
    const retryAfter = Math.max(1, Math.ceil((60_000 - (now - (recent[0] as number))) / 1000));
    throw groupError(
      429,
      'import_rate_limited',
      `Este número ya importó ${IMPORTS_PER_MINUTE} grupos en el último minuto. Esperá ${retryAfter} segundos e intentá de nuevo.`,
      { retry_after: retryAfter },
      { 'Retry-After': String(retryAfter) },
    );
  }
  app.store.groupImports.set(device.id, [...recent, now]);
  if (ctx.headers['x-sandbox-reject'] === 'import_in_progress') {
    throw groupError(409, 'import_in_progress', 'Ese grupo se está importando en otro pedido. Intentá de nuevo en unos segundos.');
  }
  const live = groupsOnWhatsApp(app, device).find((g) => g.uid === withSuffix(uid));
  if (!live) throw groupNotFound();
  const isAdmin = isAdminOf(device, live);
  if (forSend && !isAdmin) throw groupError(422, 'device_not_group_admin', 'El número no es administrador de este grupo, por eso no puede ejecutar la operación.');
  live.imported = true;
  live.deviceId = device.id;
  live.workspaceId = ctx.workspace.id;
  live.updatedAt = new Date();
  return { group: live, imported: true, isAdmin };
}

const MEDIA_EXTENSIONS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png'],
  video: ['mp4', 'mov', 'gif'],
  audio: ['aac', 'oga', 'ogg', 'mp3', 'm4a', 'opus', 'wav'],
  document: ['pdf', 'doc', 'docx'],
};

/** communities `SendGroupMessageRequest`: the rules by `type`, with Laravel's messages in Spanish. */
function checkSendBody(b: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  const type = typeof b.type === 'string' ? b.type : '';
  const present = (key: string) => b[key] !== undefined && b[key] !== null && b[key] !== '';
  const prohibited = (key: string) => {
    if (present(key)) errors[key] = [`El campo ${key} está prohibido.`];
  };
  if (type === 'text') {
    if (!present('text')) errors.text = ['El campo text es obligatorio.'];
    else if (typeof b.text !== 'string' || b.text.length > 4096) errors.text = ['El campo text no debe tener más de 4096 caracteres.'];
  } else prohibited('text');
  if (type in MEDIA_EXTENSIONS) {
    const url = String(b.media_url ?? '');
    if (!present('media_url')) errors.media_url = ['El campo media url es obligatorio.'];
    else if (url.length > 255) errors.media_url = ['La URL del archivo puede tener hasta 255 caracteres.'];
    else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      const extension = parsed?.pathname.split('.').pop()?.toLowerCase() ?? '';
      const ok = parsed !== null && parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.port === '' || parsed.port === '443');
      if (!ok || !(MEDIA_EXTENSIONS[type] as string[]).includes(extension)) {
        errors.media_url = ['El archivo debe ser una URL https con una extensión admitida para ese tipo de mensaje.'];
      }
    }
  } else prohibited('media_url');
  if (type !== 'image' && type !== 'video') prohibited('caption');
  else if (present('caption') && String(b.caption).length > 1024) errors.caption = ['El campo caption no debe tener más de 1024 caracteres.'];
  if (type !== 'document') prohibited('file_name');
  if (Object.keys(errors).length) throw new ApiError(422, 'validation_failed', summarize(errors), { errors });
}

function summarize(errors: Record<string, string[]>): string {
  const all = Object.values(errors).flat();
  const rest = all.length - 1;
  return rest > 0 ? `${all[0]} (y ${rest} ${rest === 1 ? 'error' : 'errores'} más)` : (all[0] as string);
}

/**
 * communities `ApiGroupActionTargetResolver`, in its order: the number (of the account and of the key's workspace),
 * the group, the number connected, the provider (an official number needs the `cloud_api_groups` beta, which the
 * sandbox account does not have), and a QR number must be an admin of the group.
 */
function resolveTarget(ctx: HandlerContext, deviceId: unknown, uid: unknown): { device: Device; group: Group } {
  const { app } = ctx;
  const device = importDevice(ctx, deviceId, false);
  const inAccount = accountGroup(app, uid);
  // A group the account does not have is imported first, with a QR number (communities v2.35.7); one of another
  // workspace, and any with an official number, is `group_not_found`.
  const importIt = !inAccount && device.kind === 'qr';
  if (!importIt && (!inAccount || !sees(ctx.workspace, inAccount.workspaceId))) throw groupNotFound();
  if (!device.connected || device.number === null) throw deviceNotConnected();
  const group = importIt ? importGroup(ctx, device, String(uid), true).group : (inAccount as Group);
  if (device.kind === 'cloud') {
    throw groupError(422, 'provider_unsupported', 'Esta operación no está disponible para números del proveedor official en tu cuenta: requiere la beta `cloud-api-groups`.', {
      provider: 'official',
      requires: 'cloud-api-groups',
    });
  }
  if (!group.participants.some((p) => p.admin && p.phone === device.number)) {
    throw groupError(422, 'device_not_group_admin', 'El número no es administrador de este grupo, por eso no puede ejecutar la operación.');
  }
  return { device, group };
}

/** communities `ApiGroupActionResource`. */
function actionResource(app: SandboxApp, action: GroupAction, scope: WorkspaceScope): Record<string, unknown> {
  const group = app.store.groups.get(action.groupId);
  const device = app.store.devices.get(action.deviceId);
  return {
    action_id: action.uuid,
    type: action.type,
    status: action.status,
    device_id: device && sees(scope, device.workspaceId) ? device.id : null,
    group: group ? (sees(scope, group.workspaceId) ? { uid: group.uid, name: group.name } : null) : null,
    result: action.result === null ? null : Object.keys(action.result).length ? action.result : {},
    reason: action.reason,
    created_at: iso8601(action.createdAt),
    started_at: action.startedAt ? iso8601(action.startedAt) : null,
    completed_at: action.completedAt ? iso8601(action.completedAt) : null,
    failed_at: action.failedAt ? iso8601(action.failedAt) : null,
  };
}

/**
 * The send runs like communities' job: `running` when it starts (the delay of `sent`), then `completed` with the id of
 * the message in WhatsApp (the delay of `delivered`). Settled, it emits `group_action.completed` once, to the workspace
 * of the key that called.
 */
function scheduleSend(app: SandboxApp, action: GroupAction): void {
  const { sent, delivered } = app.config.statusDelays;
  const generation = app.generation;
  const later = (seconds: number, task: () => void) =>
    app.scheduler.after(seconds * 1000, () => {
      if (generation === app.generation && app.store.groupActions.get(action.uuid) === action) task();
    });
  later(sent, () => {
    action.status = 'running';
    action.startedAt = new Date();
    later(delivered ?? 0, () => {
      const group = app.store.groups.get(action.groupId);
      const now = new Date();
      if (!group) {
        action.status = 'failed';
        action.failedAt = now;
        action.reason = 'group_not_found';
        app.webhooks.emit(
          'group_action.failed',
          { campaign: null, pipeline: null, group: null, action: { uuid: action.uuid, type: action.type }, reason: action.reason },
          { occurredAt: now, workspaceId: action.workspaceId },
        );
        return;
      }
      action.status = 'completed';
      action.completedAt = now;
      action.result = { message: { uid: `3EB0${randomAlnum(16).toUpperCase()}` } };
      app.webhooks.emit(
        'group_action.completed',
        { action: { uuid: action.uuid, type: action.type }, group: { uid: group.uid, name: group.name }, campaign: null, result: action.result },
        { occurredAt: now, workspaceId: action.workspaceId },
      );
    });
  });
}

export const groupHandlers: HandlerTable = {
  // Sorted by `created_at` descending by default; with a key, 25 per page (up to 100) and a closed sort.
  'GET /api/v1/groups': (ctx) => {
    const q = ctx.query;
    checkListQuery(q);
    const name = q.name ? String(q.name).toLowerCase() : null;
    const key = String(q.orderBy ?? 'created_at');
    const desc = (q.orderByMethod ?? 'desc') === 'desc';
    const value = (g: Group): string | number =>
      key === 'name' ? g.name.toLowerCase() : key === 'id' ? g.id : key === 'updated_at' ? g.updatedAt.getTime() : g.createdAt.getTime();
    const list = [...ctx.app.store.groups.values()]
      .filter((g) => g.imported && sees(ctx.workspace, g.workspaceId))
      .filter((g) => !name || g.name.toLowerCase().includes(name))
      // Every group of the sandbox is a common group (`type` 1), enabled (`status` 0) and without a campaign.
      .filter(() => q.type === undefined || String(q.type) === '1')
      .filter(() => q.status === undefined || String(q.status) === '0')
      .filter((g) => q.deviceId === undefined || g.deviceId === Number(q.deviceId))
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return desc ? -cmp : cmp;
      });
    const page = paginate(list, listContext(ctx), (g) => groupResource(ctx.app, g, ctx.workspace, 'list'));
    return ok({ ...page, meta: { ...(page.meta as Record<string, unknown>), cloud_api_groups_enabled: false } });
  },

  // By `uid`. One that is not of the key's workspace answers the `404 not_found` of Laravel's model binding.
  'GET /api/v1/groups/{group}': (ctx) => {
    const group = groupOf(ctx.app, ctx.path.group, ctx.workspace);
    if (!group) throw new ApiError(404, 'not_found', `No query results for model [App\\Modules\\Shared\\Models\\Group] ${String(ctx.path.group)}`);
    return ok(groupResource(ctx.app, group, ctx.workspace, 'show'));
  },

  'POST /api/v1/groups/{group}/messages': (ctx) => {
    const b = body(ctx);
    checkSendBody(b);
    const { device, group } = resolveTarget(ctx, b.device_id, ctx.path.group);
    const action: GroupAction = {
      uuid: randomUUID(),
      type: 'send_message',
      status: 'queued',
      deviceId: device.id,
      groupId: group.id,
      workspaceId: ctx.workspace.id,
      result: null,
      reason: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
    };
    ctx.app.store.groupActions.set(action.uuid, action);
    scheduleSend(ctx.app, action);
    return ok({ action_id: action.uuid, status: 'queued' }, 202);
  },

  // Follow a group: import it to the account. `201` imported now, `200` already in the account; `is_admin` from WhatsApp.
  'POST /api/v1/groups/{group}/import': (ctx) => {
    const device = importDevice(ctx, body(ctx).device_id, true);
    const result = importGroup(ctx, device, String(ctx.path.group), false);
    return ok({ data: { uid: result.group.uid, name: result.group.name, imported: result.imported, is_admin: result.isAdmin } }, result.imported ? 201 : 200);
  },

  // The number's groups on WhatsApp, live (`GroupMinResource`): `device_id` only for one the account already has.
  'GET /api/v1/devices/{device}/groups': (ctx) => {
    const device = ctx.app.store.devices.get(Number(ctx.path.device));
    if (!device || !sees(ctx.workspace, device.workspaceId)) throw new RawApiError(404, { error: 'Device not found' });
    if (!device.connected) throw new RawApiError(400, { error: 'An error has occurred' });
    const name = ctx.query.name ? String(ctx.query.name).toLowerCase() : null;
    const items = (device.kind === 'qr' ? groupsOnWhatsApp(ctx.app, device) : [])
      .filter((g) => !name || g.name.toLowerCase().includes(name))
      .map((g) => {
        const own = g.imported && sees(ctx.workspace, g.workspaceId) ? ctx.app.store.devices.get(g.deviceId) : undefined;
        const deviceId = g.imported && sees(ctx.workspace, g.workspaceId) ? (own && sees(ctx.workspace, own.workspaceId) ? own.id : null) : '';
        return { uid: g.uid, name: g.name, description: g.description, device_id: deviceId, alias: '', number: '', communityUid: '' };
      });
    const page = Math.max(1, Number(ctx.query.page ?? 1));
    const perPage = Math.max(1, Number(ctx.query.pageSize ?? 250));
    const data = items.slice((page - 1) * perPage, page * perPage);
    return ok({ data, meta: { current_page: page, last_page: Math.max(1, Math.ceil(items.length / perPage)), per_page: perPage, total: items.length } });
  },

  'GET /api/v1/groups/actions/{action}': (ctx) => {
    const action = ctx.app.store.groupActions.get(String(ctx.path.action));
    if (!action || action.workspaceId !== ctx.workspace.id) throw groupError(404, 'action_not_found', 'No encontramos esa acción en tu cuenta.');
    return ok({ data: actionResource(ctx.app, action, ctx.workspace) });
  },
};

export interface NewGroup {
  name: string;
  device: Device;
  participants?: { phone: string; name: string | null }[];
  /** `false`: only on WhatsApp, for the number to import (follow). */
  imported?: boolean;
  /** `false`: the number is only a participant. */
  admin?: boolean;
}

/**
 * `POST /_sandbox/groups`: a group of the number on WhatsApp, in the number's workspace; in the account too unless
 * `imported: false` (then it waits in the number's live list to be imported).
 */
export function createGroup(app: SandboxApp, input: NewGroup): Group {
  const now = new Date();
  const id = app.store.ids.group.next();
  const group: Group = {
    id,
    uid: `120363${String(id).padStart(12, '0')}@g.us`,
    name: input.name,
    description: '',
    deviceId: input.device.id,
    workspaceId: input.device.workspaceId,
    imported: input.imported ?? true,
    participants: [
      { phone: input.device.number as string, name: null, admin: input.admin ?? true },
      ...(input.participants ?? []).filter((p) => p.phone !== input.device.number).map((p) => ({ ...p, admin: false })),
    ],
    link: `https://chat.whatsapp.com/Sandbox${randomAlnum(20)}`,
    createdAt: now,
    updatedAt: now,
  };
  app.store.groups.set(id, group);
  return group;
}

/** The data of `group_participant.joined` / `.left` (communities `GroupWebhookService`): a group without a campaign. */
export function participantData(group: Group, participant: { phone: string; name: string | null }): Record<string, unknown> {
  return {
    group: { uid: group.uid, name: group.name },
    campaign: null,
    participant: { identity: participant.phone, identity_type: 'phone', name: participant.name },
  };
}

