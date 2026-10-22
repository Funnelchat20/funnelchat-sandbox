/**
 * The sandbox's own routes (`/_sandbox/...`): no API key, not part of the API. They simulate what in real life comes
 * from WhatsApp or from the panel (an incoming message, a group, a tag), force failures and inspect the state.
 */
import type { SandboxApp } from '../app.js';
import { parseEdge } from '../http/edge.js';
import { ApiError, EDGE_ERRORS, fieldError, notFound, validationFailed } from '../http/errors.js';
import { createContact, eventContact } from '../handlers/contacts.js';
import { completeForm } from '../handlers/forms.js';
import { setTemplateStatus } from '../handlers/messages.js';
import { createMessage, transition } from '../messaging/lifecycle.js';
import { FAILURE_REASONS, REJECTIONS, failureFor, parseForced } from '../messaging/rules.js';
import { contactResource, deliveryResource, deviceResource, publicMessage } from '../state/resources.js';
import type { ArmedFailure, Contact, TemplateStatus } from '../state/store.js';
import { digits, isRecord, iso8601, isoSeconds, toE164 } from '../util.js';
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

function emitted(result: { envelope: { id: string; type: string }; subscriptions: number }) {
  return { id: result.envelope.id, type: result.envelope.type, subscriptions: result.subscriptions };
}

function state(app: SandboxApp): Record<string, unknown> {
  const { store, config } = app;
  return {
    devices: [...store.devices.values()].map(deviceResource),
    counts: {
      contacts: store.contacts.size,
      messages: store.messages.size,
      tags: store.tags.size,
      custom_fields: store.customFields.size,
      templates: store.templates.size,
      forms: store.formFamilies.size,
      form_runs: store.formRuns.size,
      subscriptions: store.subscriptions.size,
      deliveries: store.deliveries.length,
      requests: store.requests.length,
      scheduled_tasks: app.scheduler.pending,
    },
    // Never the secrets: they were shown once, when the subscription was created or rotated.
    subscriptions: [...store.subscriptions.values()].map((s) => ({
      id: s.id,
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
    contact = app.store.findContactByPhone(phone) ?? createContact(app, { phone, name: b.name ?? null });
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
    { occurredAt },
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

function participantEvent(app: SandboxApp, req: SandboxRequest, type: string): SandboxResponse {
  const b = obj(req.body);
  const entry = catalogEntry(type);
  const example = obj(entry ? emittedData(entry) : {});
  const participant = obj(b.participant);
  const phone = participant.phone ?? b.phone;
  const data = deepMerge(example, {
    ...(isRecord(b.group) ? { group: b.group } : {}),
    ...(isRecord(b.campaign) ? { campaign: b.campaign } : {}),
    participant: {
      ...obj(example.participant),
      // communities `PlatformEventParticipant`: the phone in digits, without `+`.
      ...(phone !== undefined ? { identity: digits(phone), identity_type: 'phone' } : {}),
      ...(participant.name !== undefined || b.name !== undefined ? { name: participant.name ?? b.name } : {}),
    },
  });
  return { status: 202, body: { event: emitted(app.webhooks.emit(type, data)) } };
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/_sandbox\/?$/, handle: () => ({ status: 200, html: panelHtml() }) },
  { method: 'GET', pattern: /^\/_sandbox\/state$/, handle: (app) => ({ status: 200, body: state(app) }) },
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
      const data = deepMerge(emittedData(entry), obj(req.body).data);
      return { status: 202, body: { event: emitted(app.webhooks.emit(entry.type, data)), data } };
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
      const event = app.webhooks.emit('contact.tag_added', { contact: eventContact(contact), tag: { id: tag.id, name: tag.name }, source: 'manual' });
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
      const event = app.webhooks.emit('contact.tag_removed', { contact: eventContact(contact), tag: { id: tag.id, name: tag.name }, source: 'manual' });
      return { status: 200, body: { contact: contactResource(app.store, contact), event: emitted(event) } };
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
    method: 'POST',
    pattern: /^\/_sandbox\/devices\/(\d+)\/(connect|disconnect)$/,
    handle: (app, _req, [id, action]) => {
      const device = deviceOf(app, id);
      const connected = action === 'connect';
      if (device.connected === connected) return { status: 200, body: { device: deviceResource(device), event: null } };
      device.connected = connected;
      const at = new Date();
      const data = connected
        ? { device: { id: device.id, name: device.alias, number: device.number }, connected_at: isoSeconds(at) }
        : { device: { id: device.id, name: device.alias, number: device.number }, disconnected_at: isoSeconds(at) };
      const event = app.webhooks.emit(connected ? 'device.connected' : 'device.disconnected', data, { occurredAt: at });
      return { status: 200, body: { device: deviceResource(device), event: emitted(event) } };
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
