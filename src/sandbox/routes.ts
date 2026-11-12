/**
 * The sandbox's own routes (`/_sandbox/...`): no API key, not part of the API. They simulate what in real life comes
 * from WhatsApp or from the panel (an incoming message, a group, a tag), force failures and inspect the state.
 */
import type { SandboxApp } from '../app.js';
import { parseEdge } from '../http/edge.js';
import { ApiError, EDGE_ERRORS, fieldError, notFound, validationFailed } from '../http/errors.js';
import { createContact, eventContact } from '../handlers/contacts.js';
import { completeForm } from '../handlers/forms.js';
import { createGroup, participantData } from '../handlers/groups.js';
import { simulationOf } from '../handlers/index.js';
import { setTemplateStatus } from '../handlers/messages.js';
import { createMessage, transition } from '../messaging/lifecycle.js';
import { shapeOnlyAnswer } from '../openapi/shape.js';
import { HTTP_METHODS, operations } from '../openapi/spec.js';
import {
  connectDevice,
  disconnectDevice,
  DISCONNECT_REASONS,
  HEALTH_STATES,
  pendingQrIds,
  placesInUse,
  poolLimit,
  refreshLink,
  setHealth,
  type DisconnectReason,
} from '../numbers/numbers.js';
import { FAILURE_REASONS, REJECTIONS, failureFor, parseForced } from '../messaging/rules.js';
import { connectLinkResource, contactResource, deliveryResource, deviceResource, publicMessage } from '../state/resources.js';
import type { ArmedFailure, Contact, Group, HealthState, TemplateStatus } from '../state/store.js';
import { createWorkspace, mintKey, PERMISSION, workspaceView } from '../state/workspaces.js';
import { digits, isRecord, iso8601, toE164 } from '../util.js';
import { catalog, catalogEntry, emittedData } from '../webhooks/catalog.js';
import { panelHtml } from './panel.js';

export interface SandboxRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface SandboxResponse {
  status: number;
  body?: unknown;
  html?: string;
}

type Route = { method: string; pattern: RegExp; handle: (app: SandboxApp, req: SandboxRequest, params: string[]) => SandboxResponse | Promise<SandboxResponse> };

const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = deepMerge(base[key], value);
  return out;
}

function contactOf(app: SandboxApp, id: unknown): Contact {
  const contact = app.store.contacts.get(Number(id));
  if (!contact) throw notFound('The contact does not exist in the sandbox.');
  return contact;
}

function deviceOf(app: SandboxApp, id: unknown) {
  const device = app.store.devices.get(Number(id ?? 3));
  if (!device) throw fieldError('device_id', `There is no number ${id} in the sandbox: the example ones are 3 (official) and 4 (QR).`);
  return device;
}

function emitted(result: { envelope: { id: string; type: string }; subscriptions: number } | null) {
  return result ? { id: result.envelope.id, type: result.envelope.type, subscriptions: result.subscriptions } : null;
}

function numbersState(app: SandboxApp): Record<string, unknown> {
  const { numbers } = app.store;
  return {
    limit: numbers.limit,
    in_use: placesInUse(app),
    pending_device_ids: pendingQrIds(app),
    included: numbers.included,
    trial: numbers.trial,
    pool_limit: poolLimit(app),
    meta_connect: numbers.metaConnect,
    links_per_minute: numbers.linksPerMinute,
  };
}

function state(app: SandboxApp): Record<string, unknown> {
  const { store, config } = app;
  return {
    workspaces: [...store.workspaces.values()].map((w) => workspaceView(store, w)),
    devices: [...store.devices.values()].map((d) => ({ ...deviceResource(d), workspace_id: d.workspaceId ?? store.defaultWorkspace.id })),
    numbers: numbersState(app),
    // Never the tokens: they are only in the `url` of the create answer.
    connect_links: [...store.connectLinks.values()].map((link) => connectLinkResource(refreshLink(link))),
    counts: {
      contacts: store.contacts.size,
      messages: store.messages.size,
      tags: store.tags.size,
      custom_fields: store.customFields.size,
      templates: store.templates.size,
      forms: store.formFamilies.size,
      form_runs: store.formRuns.size,
      groups: store.groups.size,
      group_actions: store.groupActions.size,
      subscriptions: store.subscriptions.size,
      events: store.events.length,
      deliveries: store.deliveries.length,
      requests: store.requests.length,
      scheduled_tasks: app.scheduler.pending,
    },
    // Never the secrets: they were shown once, when the subscription was created or rotated.
    subscriptions: [...store.subscriptions.values()].map((s) => ({
      id: s.id,
      workspace_id: s.workspaceId ?? store.defaultWorkspace.id,
      url: s.url,
      events: s.events,
      status: s.status,
      disabled_reason: s.disabledReason,
      consecutive_failures: s.consecutiveFailures,
    })),
    failures: store.failures,
    mac: macState(app),
    config: {
      statusDelays: config.statusDelays,
      webhooks: config.webhooks,
      rules: config.rules,
      templateApprovalSeconds: config.templateApprovalSeconds,
    },
  };
}

function macState(app: SandboxApp): Record<string, unknown> {
  const { mac } = app.store;
  return { lockout: mac.lockout, active_contact_ids: [...mac.activeContacts], inactive_contact_ids: [...mac.inactiveContacts] };
}

function idsOf(value: unknown, field: string, app: SandboxApp): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw fieldError(field, `${field} must be a list of contact ids.`);
  return value.map((id) => contactOf(app, id).id);
}

function limitOf(query: URLSearchParams): number {
  const n = Number(query.get('limit') ?? 50);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

/** `POST /_sandbox/inbound/message`: a contact writes to one of your numbers. */
function inboundMessage(app: SandboxApp, req: SandboxRequest): SandboxResponse {
  const b = obj(req.body);
  const device = deviceOf(app, b.device_id);
  let contact: Contact | undefined;
  if (b.contact_id !== undefined) contact = contactOf(app, b.contact_id);
  else {
    const phone = digits(b.phone);
    if (!phone) throw fieldError('phone', 'Send phone (the phone of who writes) or contact_id.');
    contact = app.store.findContactByPhone(phone) ?? createContact(app, { workspaceId: device.workspaceId, phone, name: b.name ?? null });
  }
  const occurredAt = b.occurred_at ? new Date(String(b.occurred_at)) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw fieldError('occurred_at', 'occurred_at must be an ISO 8601 date.');
  const type = typeof b.type === 'string' ? b.type : b.file ? 'image' : 'text';
  const text = b.text === undefined ? (b.file ? null : 'Hola, quiero más información') : b.text === null ? null : String(b.text);
  const file = typeof b.file === 'string' ? b.file : null;

  const message = createMessage(app, { contactId: contact.id, deviceId: device.id, own: false, type, text, file, viaApi: false, status: null, createdAt: occurredAt });
  // The contact wrote: the 24-hour window opens and the spam brakes start over.
  const previous = app.store.lastInbound.get(`${contact.id}:${device.id}`);
  if (!previous || previous < occurredAt) app.store.lastInbound.set(`${contact.id}:${device.id}`, occurredAt);
  app.store.unanswered.delete(contact.id);

  const event = app.webhooks.emit(
    'message.received',
    {
      message: { id: message.id, type, text, media: file && type !== 'text' ? { file } : null },
      contact: eventContact(contact),
      receiver: { phone: toE164(device.number) },
      // The number that received the message (conversations v1.18.10 `MessageReceivedPayload`).
      device_id: device.id,
    },
    // Its workspace: the contact's, or the number's (conversations `EventWorkspace`).
    { occurredAt, workspaceId: contact.workspaceId ?? device.workspaceId },
  );
  return {
    status: 201,
    body: {
      message: publicMessage(message),
      contact: contactResource(app.store, contact),
      window: { device_id: device.id, is_open: app.store.windowOpen(contact.id, device.id) },
      event: emitted(event),
    },
  };
}

/** A group of the sandbox by `group_id`, or by `group.uid` / `uid`; the example group (`120363000000000000@g.us`) otherwise. */
function groupFor(app: SandboxApp, b: Record<string, unknown>): Group | undefined {
  if (b.group_id !== undefined) {
    const group = app.store.groups.get(Number(b.group_id));
    if (!group) throw notFound('There is no such group in the sandbox. See GET /_sandbox/groups.');
    return group;
  }
  const uid = isRecord(b.group) ? b.group.uid : b.uid;
  const wanted = uid === undefined ? '120363000000000000@g.us' : String(uid);
  for (const group of app.store.groups.values()) if (group.uid === wanted) return group;
  return undefined;
}

/**
 * Someone joins or leaves a group. A group of the sandbox changes (its participants) and the event goes to its
 * workspace with the shape communities emits (`campaign: null`: the sandbox's groups have no campaign). A `group` the
 * sandbox does not have is emitted as before, from the catalog's example with your changes, to the default workspace.
 */
function participantEvent(app: SandboxApp, req: SandboxRequest, type: 'group_participant.joined' | 'group_participant.left'): SandboxResponse {
  const b = obj(req.body);
  const participant = obj(b.participant);
  const phone = participant.phone ?? b.phone;
  const name = participant.name ?? b.name;
  const group = groupFor(app, b);
  if (group) {
    const identity = digits(phone ?? '5491100000099');
    if (identity.length < 8) throw fieldError('participant.phone', 'participant.phone must be a phone, digits only.');
    const index = group.participants.findIndex((p) => p.phone === identity);
    const current = group.participants[index];
    if (type === 'group_participant.joined' && !current) group.participants.push({ phone: identity, name: name === undefined ? null : String(name), admin: false });
    if (type === 'group_participant.left' && current) group.participants.splice(index, 1);
    group.updatedAt = new Date();
    // Only a group the account has (imported, followed) announces who joins and leaves (communities v2.35.7).
    if (!group.imported) return { status: 202, body: { event: null, participants: group.participants.length, imported: false } };
    const data = participantData(group, { phone: identity, name: name === undefined ? (current?.name ?? null) : String(name) });
    return { status: 202, body: { event: emitted(app.webhooks.emit(type, data, { workspaceId: group.workspaceId })), participants: group.participants.length } };
  }
  const entry = catalogEntry(type);
  const example = obj(entry ? emittedData(entry) : {});
  delete example.workspace_id;
  const data = deepMerge(example, {
    ...(isRecord(b.group) ? { group: b.group } : {}),
    ...(isRecord(b.campaign) ? { campaign: b.campaign } : {}),
    participant: {
      ...obj(example.participant),
      // communities `PlatformEventParticipant`: the phone in digits, without `+`.
      ...(phone !== undefined ? { identity: digits(phone), identity_type: 'phone' } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  });
  return { status: 202, body: { event: emitted(app.webhooks.emit(type, data)) } };
}

/** What `/_sandbox/groups` shows of a group. */
const groupView = (group: Group) => ({
  id: group.id,
  uid: group.uid,
  name: group.name,
  device_id: group.deviceId,
  workspace_id: group.workspaceId,
  imported: group.imported,
  participants: group.participants.map((p) => ({ phone: p.phone, name: p.name, admin: p.admin })),
});

/**
 * `GET /_sandbox/operations`: every operation of the spec and how the sandbox answers it (`stateful`, `closed` or
 * `shape-only`), from the spec and the handlers, never a list kept by hand. A shape-only one says its status and
 * whether its body fits the schema.
 */
function operationsView(app: SandboxApp): Record<string, unknown> {
  const data = [...operations]
    .sort((a, b) => a.path.localeCompare(b.path) || HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method))
    .map((op) => {
      const method = op.method.toUpperCase();
      const simulated = simulationOf(`${method} ${op.path}`, app.config.groupActions);
      const entry = { method, path: op.path, operation_id: op.operation.operationId ?? null, simulated };
      if (simulated !== 'shape-only') return entry;
      const answer = shapeOnlyAnswer(op);
      return { ...entry, status: answer.status, body_from: answer.source, body_fits_schema: answer.fits };
    });
  const count = (simulated: string) => data.filter((d) => d.simulated === simulated).length;
  return { data, meta: { total: data.length, stateful: count('stateful'), shape_only: count('shape-only'), closed: count('closed') } };
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/_sandbox\/?$/, handle: () => ({ status: 200, html: panelHtml() }) },
  { method: 'GET', pattern: /^\/_sandbox\/state$/, handle: (app) => ({ status: 200, body: state(app) }) },
  { method: 'GET', pattern: /^\/_sandbox\/operations$/, handle: (app) => ({ status: 200, body: operationsView(app) }) },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/reset$/,
    handle: (app) => {
      app.reset();
      app.logger.info('state reset');
      return { status: 200, body: { reset: true, ...state(app) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/_sandbox\/requests$/,
    handle: (app, req) => ({
      status: 200,
      body: { data: app.store.requests.slice(-limitOf(req.query)).reverse().map((r) => ({ ...r, at: iso8601(r.at) })) },
    }),
  },
  {
    method: 'GET',
    pattern: /^\/_sandbox\/deliveries$/,
    handle: (app, req) => ({
      status: 200,
      body: {
        data: app.store.deliveries
          .slice(-limitOf(req.query))
          .reverse()
          .map((d) => ({
            ...deliveryResource(d),
            subscription_id: d.subscriptionId,
            next_attempt_at: d.nextAttemptAt ? iso8601(d.nextAttemptAt) : null,
            response_body: d.responseBody,
            request_body: d.requestBody,
          })),
      },
    }),
  },
  {
    method: 'GET',
    pattern: /^\/_sandbox\/emitted$/,
    handle: (app, req) => ({
      status: 200,
      body: { data: app.store.events.slice(-limitOf(req.query)).reverse().map((e) => ({ ...e.envelope, subscriptions: e.subscriptions })) },
    }),
  },
  { method: 'GET', pattern: /^\/_sandbox\/workspaces$/, handle: (app) => ({ status: 200, body: { data: [...app.store.workspaces.values()].map((w) => workspaceView(app.store, w)) } }) },
  {
    // A workspace of the account and a key that only sees it, as the owner does in the panel (Developers → Create key).
    method: 'POST',
    pattern: /^\/_sandbox\/workspaces$/,
    handle: (app, req) => {
      const b = obj(req.body);
      if (typeof b.name !== 'string' || b.name.trim() === '') throw fieldError('name', 'name must be the name of the workspace.');
      const workspace = createWorkspace(app, b.name.trim());
      const key = mintKey(app.store, workspace.id);
      app.logger.info(`workspace ${workspace.id} «${workspace.name}» created, with a key`);
      return { status: 201, body: { workspace: workspaceView(app.store, workspace), key } };
    },
  },
  {
    // Another key for a workspace (the default one without `workspace_id`).
    method: 'POST',
    pattern: /^\/_sandbox\/keys$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const id = b.workspace_id === undefined || b.workspace_id === null ? app.store.defaultWorkspace.id : Number(b.workspace_id);
      if (!app.store.workspaces.has(id)) throw fieldError('workspace_id', 'There is no such workspace in the sandbox. See GET /_sandbox/workspaces.');
      // Optional: the key's permissions, as the panel's checkboxes give them (every one without the list).
      let permissions: string[] | null = null;
      if (b.permissions !== undefined && b.permissions !== null) {
        if (!Array.isArray(b.permissions) || b.permissions.some((p) => typeof p !== 'string' || !PERMISSION.test(p))) {
          throw fieldError('permissions', 'permissions must be a list like ["communities:read", "communities:send"].');
        }
        permissions = [...new Set(b.permissions as string[])];
      }
      return { status: 201, body: { key: mintKey(app.store, id, undefined, permissions), workspace_id: id, permissions } };
    },
  },
  { method: 'POST', pattern: /^\/_sandbox\/inbound\/message$/, handle: inboundMessage },
  {
    method: 'GET',
    pattern: /^\/_sandbox\/events$/,
    handle: () => ({ status: 200, body: { data: catalog.map((e) => ({ type: e.type, area: e.area, status: e.status, subscribable: e.subscribable })) } }),
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/events\/([a-z0-9_.]+)$/,
    handle: (app, req, [type]) => {
      const entry = catalogEntry(type as string);
      if (!entry) throw notFound(`${type} is not in the catalog. See GET /_sandbox/events.`);
      if (!entry.subscribable) throw fieldError('type', `${type} cannot be subscribed to: use POST /api/v1/webhooks/{id}/test.`);
      const b = obj(req.body);
      // The example's `workspace_id` (37, like accounts') never routes: the event goes to `workspace_id` of the body,
      // or of its `data`, if it is a workspace of the sandbox, and to the default one otherwise.
      const example = emittedData(entry);
      if (isRecord(example)) delete example.workspace_id;
      const data = deepMerge(example, b.data);
      const declared = b.workspace_id ?? (isRecord(data) ? data.workspace_id : undefined);
      const result = app.webhooks.emit(entry.type, data, { workspaceId: Number.isInteger(declared) ? (declared as number) : null });
      return { status: 202, body: { event: emitted(result), data: result.envelope.data } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/contacts\/(\d+)\/tags$/,
    handle: (app, req, [id]) => {
      const contact = contactOf(app, id);
      const tag = app.store.tags.get(Number(obj(req.body).tag_id));
      if (!tag) throw fieldError('tag_id', 'The tag does not exist in the sandbox.');
      if (contact.tags.has(tag.id)) return { status: 200, body: { contact: contactResource(app.store, contact), event: null } };
      contact.tags.set(tag.id, new Date());
      const event = app.webhooks.emit('contact.tag_added', { contact: eventContact(contact), tag: { id: tag.id, name: tag.name }, source: 'manual' }, { workspaceId: contact.workspaceId });
      return { status: 201, body: { contact: contactResource(app.store, contact), event: emitted(event) } };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/_sandbox\/contacts\/(\d+)\/tags\/(\d+)$/,
    handle: (app, _req, [id, tagId]) => {
      const contact = contactOf(app, id);
      const tag = app.store.tags.get(Number(tagId));
      if (!tag || !contact.tags.delete(tag.id)) throw notFound('The contact does not have that tag.');
      const event = app.webhooks.emit('contact.tag_removed', { contact: eventContact(contact), tag: { id: tag.id, name: tag.name }, source: 'manual' }, { workspaceId: contact.workspaceId });
      return { status: 200, body: { contact: contactResource(app.store, contact), event: emitted(event) } };
    },
  },
  { method: 'GET', pattern: /^\/_sandbox\/groups$/, handle: (app) => ({ status: 200, body: { data: [...app.store.groups.values()].map(groupView) } }) },
  {
    // A group the number is in, as its admin: what communities finds when it syncs the groups of a QR number.
    method: 'POST',
    pattern: /^\/_sandbox\/groups$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const device = deviceOf(app, b.device_id ?? 4);
      if (device.kind !== 'qr') throw fieldError('device_id', 'Only QR numbers have groups in the sandbox: the account is not in the beta of official groups.');
      if (!device.connected || device.number === null) throw fieldError('device_id', 'The number is not connected: connect it first (POST /_sandbox/devices/{id}/connect).');
      if (typeof b.name !== 'string' || b.name.trim() === '') throw fieldError('name', 'name must be the name of the group.');
      const participants = Array.isArray(b.participants)
        ? b.participants.map((p, i) => {
            const phone = digits(obj(p).phone ?? p);
            if (phone.length < 8) throw fieldError(`participants.${i}`, 'Each participant is {"phone": "549…", "name": "…"} or a phone.');
            const name = obj(p).name;
            return { phone, name: typeof name === 'string' ? name : null };
          })
        : [];
      for (const field of ['imported', 'admin'] as const) {
        if (b[field] !== undefined && typeof b[field] !== 'boolean') throw fieldError(field, `${field} must be true or false.`);
      }
      const group = createGroup(app, { name: b.name.trim(), device, participants, imported: b.imported as boolean | undefined, admin: b.admin as boolean | undefined });
      return { status: 201, body: { group: groupView(group) } };
    },
  },
  { method: 'POST', pattern: /^\/_sandbox\/groups\/participant-joined$/, handle: (app, req) => participantEvent(app, req, 'group_participant.joined') },
  { method: 'POST', pattern: /^\/_sandbox\/groups\/participant-left$/, handle: (app, req) => participantEvent(app, req, 'group_participant.left') },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/messages\/(\d+)\/status$/,
    handle: (app, req, [id]) => {
      const message = app.store.messages.get(Number(id));
      if (!message || !message.own) throw notFound('There is no sent message with that id.');
      const b = obj(req.body);
      const status = String(b.status ?? '');
      if (!['sent', 'delivered', 'read', 'failed'].includes(status)) throw fieldError('status', 'status must be sent, delivered, read or failed.');
      const error = status === 'failed' ? failureFor(parseForced('fail', b.error ?? true, 'error')).error : undefined;
      if (!transition(app, message, status as 'sent', error)) {
        throw new ApiError(409, 'invalid_transition', `The message is ${message.status ?? 'without a status'}: it does not move to ${status} (a status never goes back or repeats).`);
      }
      return { status: 200, body: { message: publicMessage(message) } };
    },
  },
  { method: 'GET', pattern: /^\/_sandbox\/failures$/, handle: (app) => ({ status: 200, body: { data: app.store.failures } }) },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/failures$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const mode = b.mode === 'reject' || b.mode === 'edge' ? b.mode : b.mode === 'fail' || b.mode === undefined ? 'fail' : null;
      if (!mode) {
        throw fieldError('mode', 'mode must be reject (the send answers an error), fail (it is accepted and ends failed) or edge (the next call gets an error of the API edge).');
      }
      const code = mode === 'edge' ? parseEdge(b.code, 'code') : parseForced(mode, b.code ?? (mode === 'fail' ? true : undefined), 'code');
      const count = b.count === undefined ? 1 : Number(b.count);
      if (!Number.isInteger(count) || count < 1) throw fieldError('count', 'count must be an integer greater than 0.');
      const contactId = mode === 'edge' || b.contact_id === undefined || b.contact_id === null ? null : contactOf(app, b.contact_id).id;
      const failure: ArmedFailure = { id: app.store.ids.failure.next(), mode, code, remaining: count, contactId };
      if (mode === 'edge') failure.applied = code === 'origin_unreachable' && b.applied === true;
      app.store.failures.push({ ...failure });
      return { status: 201, body: { failure } };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/_sandbox\/failures$/,
    handle: (app) => {
      app.store.failures = [];
      return { status: 200, body: { data: [] } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/_sandbox\/failures\/codes$/,
    handle: () => ({
      status: 200,
      body: {
        reject: Object.keys(REJECTIONS),
        fail: { reasons: Object.keys(FAILURE_REASONS), meta: 'any numeric code of Meta, for example 131047' },
        edge: Object.keys(EDGE_ERRORS),
      },
    }),
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/forms\/complete$/,
    handle: (app, req) => ({ status: 200, body: completeForm(app, obj(req.body)) }),
  },
  { method: 'GET', pattern: /^\/_sandbox\/mac$/, handle: (app) => ({ status: 200, body: macState(app) }) },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/mac$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const { mac } = app.store;
      if (b.lockout !== undefined) {
        if (typeof b.lockout !== 'boolean') throw fieldError('lockout', 'lockout must be true or false.');
        mac.lockout = b.lockout;
      }
      if (b.active_contact_ids !== undefined) mac.activeContacts = new Set(idsOf(b.active_contact_ids, 'active_contact_ids', app));
      if (b.inactive_contact_ids !== undefined) mac.inactiveContacts = new Set(idsOf(b.inactive_contact_ids, 'inactive_contact_ids', app));
      return { status: 200, body: macState(app) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/window$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const contact = contactOf(app, b.contact_id);
      const device = deviceOf(app, b.device_id);
      if (typeof b.open !== 'boolean') throw fieldError('open', 'open must be true or false.');
      const key = `${contact.id}:${device.id}`;
      if (b.open) app.store.lastInbound.set(key, new Date());
      else app.store.lastInbound.delete(key);
      return { status: 200, body: { contact_id: contact.id, device_id: device.id, is_open: app.store.windowOpen(contact.id, device.id) } };
    },
  },
  {
    // `connect` is the scan of the QR (or the end of the Meta sign-up): it takes `number`, a fake one otherwise.
    // `disconnect` takes `reason` (qr_logged_out for QR and unknown for official numbers by default).
    method: 'POST',
    pattern: /^\/_sandbox\/devices\/(\d+)\/(connect|disconnect)$/,
    handle: (app, req, [id, action]) => {
      const device = deviceOf(app, id);
      const b = obj(req.body);
      if (action === 'connect') {
        const number = b.number === undefined || b.number === null ? null : digits(b.number);
        if (number !== null && number.length < 8) throw fieldError('number', 'number must be a phone, digits only.');
        // The event first: the answer shows the number as it is after the scan.
        const event = emitted(connectDevice(app, device, { number }));
        return { status: 200, body: { device: deviceResource(device), event } };
      }
      const reason = (b.reason ?? (device.kind === 'qr' ? 'qr_logged_out' : 'unknown')) as DisconnectReason;
      if (!DISCONNECT_REASONS.includes(reason)) throw fieldError('reason', `reason must be one of: ${DISCONNECT_REASONS.join(', ')}.`);
      const event = emitted(disconnectDevice(app, device, reason));
      return { status: 200, body: { device: deviceResource(device), event } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/devices\/(\d+)\/health$/,
    handle: (app, req, [id]) => {
      const device = deviceOf(app, id);
      if (device.kind !== 'cloud') throw fieldError('device_id', 'Only official numbers have a health state.');
      const state = obj(req.body).state as HealthState;
      if (!HEALTH_STATES.includes(state)) throw fieldError('state', `state must be one of: ${HEALTH_STATES.join(', ')}.`);
      const event = emitted(setHealth(app, device, state));
      return { status: 200, body: { device: deviceResource(device), event } };
    },
  },
  { method: 'GET', pattern: /^\/_sandbox\/numbers$/, handle: (app) => ({ status: 200, body: numbersState(app) }) },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/numbers$/,
    handle: (app, req) => {
      const b = obj(req.body);
      const { numbers } = app.store;
      for (const [field, key] of [['limit', 'limit'], ['links_per_minute', 'linksPerMinute']] as const) {
        if (b[field] === undefined) continue;
        if (!Number.isInteger(b[field]) || (b[field] as number) < 0) throw fieldError(field, `${field} must be an integer, 0 or more.`);
        numbers[key] = b[field] as number;
      }
      for (const [field, key] of [['included', 'included'], ['trial', 'trial'], ['meta_connect', 'metaConnect']] as const) {
        if (b[field] === undefined) continue;
        if (typeof b[field] !== 'boolean') throw fieldError(field, `${field} must be true or false.`);
        numbers[key] = b[field];
      }
      return { status: 200, body: numbersState(app) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/_sandbox\/templates\/(\d+)\/status$/,
    handle: (app, req, [id]) => {
      const template = app.store.templates.get(Number(id));
      if (!template) throw notFound('The template does not exist in the sandbox.');
      const b = obj(req.body);
      const statuses: TemplateStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'];
      if (!statuses.includes(b.status as TemplateStatus)) throw validationFailed({ status: [`status must be one of: ${statuses.join(', ')}.`] });
      setTemplateStatus(app, template, b.status as TemplateStatus, typeof b.reason === 'string' ? b.reason : null);
      return { status: 200, body: { id: template.id, status: template.status, reason: template.rejectionReason } };
    },
  },
];

/** The answer of a `/_sandbox` route, or `null` when the path is not one. */
export async function handleSandbox(app: SandboxApp, req: SandboxRequest): Promise<SandboxResponse | null> {
  const candidates = ROUTES.filter((r) => r.pattern.test(req.path));
  if (candidates.length === 0) return null;
  const route = candidates.find((r) => r.method === req.method);
  if (!route) {
    throw new ApiError(405, 'method_not_allowed', `Use ${candidates.map((r) => r.method).join(', ')} on ${req.path}.`);
  }
  const params = (route.pattern.exec(req.path) ?? []).slice(1);
  return route.handle(app, req, params);
}
