/**
 * Sending, the history and the message lookup (conversations domain), and the templates. The numbers are in devices.ts.
 *
 * As conversations v1.18.10 answers them in production: with an API key, every send that registers messages answers
 * `200` right away with the queued message (`{message: {...}}`, `{messages: [...]}` for cards, `message` in each
 * forward item; `ApiKeySendResponse`, `PublicMessageResource`), after the rules of each route, in their order.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, noContent, ok, type HandlerContext, type HandlerResult, type HandlerTable } from '../http/context.js';
import { ApiError, fieldError, notFound, objectNotFound, RawApiError } from '../http/errors.js';
import { cursorPaginate, paginate } from '../http/paginate.js';
import { resolveFile, type UnsupportedStyle } from '../messaging/files.js';
import { createMessage, scheduleLifecycle } from '../messaging/lifecycle.js';
import {
  checkSend,
  contentHash,
  failureFor,
  macRejection,
  recordSend,
  rejection,
  takeForcedFailure,
  type SendCheck,
  type SendProfile,
} from '../messaging/rules.js';
import { historyMessage, publicMessage, templateResource } from '../state/resources.js';
import type { Contact, Device, Message, Template } from '../state/store.js';
import { getContact } from './contacts.js';

export function getDevice(app: SandboxApp, id: unknown, field = 'device_id'): Device {
  const device = app.store.devices.get(Number(id));
  // A number of another account is a validation error on `device_id`, not a 404 (conversations).
  if (!device) throw fieldError(field, `El valor seleccionado en ${field} no es válido.`);
  return device;
}

/** `ClientReference::rules()`: optional, 1 to 64 visible ASCII characters, no spaces. */
const CLIENT_REFERENCE = /^[\x21-\x7E]{1,64}$/;

export function clientReference(b: Record<string, unknown>): string | null {
  const value = b.client_reference;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fieldError('client_reference', 'El campo client_reference debe ser una cadena de caracteres.');
  if (value.length > 64) throw fieldError('client_reference', 'El campo client_reference no debe tener más de 64 caracteres.');
  if (!CLIENT_REFERENCE.test(value)) throw fieldError('client_reference', 'El formato del campo client_reference no es válido.');
  return value;
}

interface Outgoing {
  type: string;
  text: string | null;
  file: string | null;
  templateId?: number | null;
  hash: string;
}

export interface SendInput {
  device: Device;
  contact: Contact;
  profile: SendProfile;
  items: Outgoing[];
  phone?: unknown;
  whatsappId?: unknown;
  clientReference: string | null;
  /** Whether the MAC gate applies: every free-form send with a key; templates do not have it. */
  mac: boolean;
}

/**
 * The common path of every send with an API key: forced failures, the rules, the MAC gate, then one queued
 * message per item with its lifecycle. Notes skip all that: they are stored, never sent.
 */
export function send(ctx: HandlerContext, input: SendInput): Message[] {
  const { app } = ctx;
  const check: SendCheck = {
    device: input.device,
    contact: input.contact,
    profile: input.profile,
    phone: input.phone,
    whatsappId: input.whatsappId,
    contentHashes: input.items.map((i) => i.hash),
  };
  const forced = takeForcedFailure(app, ctx.headers, input.contact.id);
  if (forced?.mode === 'reject') throw rejection(forced.code);
  const refused = checkSend(app, check) ?? (input.mac ? macRejection(app, input.contact) : null);
  if (refused) throw refused;
  recordSend(app, check);

  return input.items.map((item) => {
    const message = createMessage(app, {
      contactId: input.contact.id,
      deviceId: input.device.id,
      own: true,
      type: item.type,
      text: item.text,
      file: item.file,
      clientReference: input.clientReference,
      templateId: item.templateId ?? null,
      viaApi: true,
      status: 'queued',
    });
    scheduleLifecycle(app, message, forced?.mode === 'fail' ? failureFor(forced.code) : null);
    return message;
  });
}

function note(ctx: HandlerContext, contact: Contact, device: Device, text: unknown, reference: string | null): HandlerResult {
  const message = createMessage(ctx.app, {
    contactId: contact.id,
    deviceId: device.id,
    own: true,
    type: 'note',
    text: text === undefined || text === null ? null : String(text),
    clientReference: reference,
    viaApi: true,
    status: null,
  });
  return ok({ message: publicMessage(message) });
}

/**
 * Text, a file (by URL, with `file_type` / `file_name`) or a menu (`options`) to one contact. `style` is the route:
 * `conversation` (`contacts/{contact}/message`, which checks the body's recipient) or `direct` (`send-message`).
 */
function sendToContact(ctx: HandlerContext, contact: Contact, style: UnsupportedStyle): HandlerResult {
  const b = body(ctx);
  const reference = clientReference(b);
  const options = Array.isArray(b.options) ? b.options : null;
  if (b.note === true && options) throw new RawApiError(422, { error: 'A note cannot carry interactive options.' });
  const file = resolveFile(b, style);
  const device = getDevice(ctx.app, b.device_id);
  if (b.note === true) return note(ctx, contact, device, b.text, reference);
  const text = typeof b.text === 'string' && b.text !== '' ? b.text : null;
  if (!text && !file) throw fieldError('text', 'El campo text es obligatorio cuando file no está presente.');
  const type = options ? 'interactive' : (file?.type ?? 'text');
  const [message] = send(ctx, {
    device,
    contact,
    profile: 'free_form',
    items: [{ type, text, file: file?.file ?? null, hash: contentHash('message', text, file?.file ?? null, options) }],
    // `recipient_mismatch` only exists on the routes with the recipient in the body (`ApiRecipientBinding`).
    phone: style === 'conversation' ? b.phone : undefined,
    whatsappId: style === 'conversation' ? b.whatsapp_id : undefined,
    clientReference: reference,
    mac: true,
  });
  return ok({ message: publicMessage(message as Message) });
}

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

function renderTemplate(template: Template, variables: unknown): string {
  const values = Array.isArray(variables) ? variables : [];
  const missing = [...template.body.matchAll(PLACEHOLDER)].map((m) => Number(m[1])).filter((n) => values[n - 1] === undefined || values[n - 1] === null || values[n - 1] === '');
  if (missing.length) {
    const placeholders = [...new Set(missing)].map((n) => `{{${n}}}`);
    throw new ApiError(
      422,
      'template_unresolved_placeholder',
      'No se envió: la plantilla tiene variables que se completan con campos personalizados que no existen en tu cuenta. Revisa las variables de la plantilla.',
      { placeholders: placeholders.slice(0, 20), count: placeholders.length },
    );
  }
  return template.body.replace(PLACEHOLDER, (_, n: string) => String(values[Number(n) - 1]));
}

function getTemplate(app: SandboxApp, id: unknown): Template {
  const template = app.store.templates.get(Number(id));
  if (!template) throw notFound('La plantilla no existe en esta cuenta.');
  return template;
}

function sendTemplate(ctx: HandlerContext): HandlerResult {
  const b = body(ctx);
  const reference = clientReference(b);
  // `template_not_found` goes before everything else (`MessageTemplateController`).
  const template = ctx.app.store.templates.get(Number(ctx.path.template_id ?? ctx.path.template));
  if (!template) throw new ApiError(404, 'template_not_found', 'No se envió: la plantilla no existe en tu cuenta. Revisa el identificador de la plantilla.');
  const device = ctx.app.store.devices.get(Number(ctx.path.device));
  // A number outside the account is refused by `ApiKeySendAcceptor`.
  if (!device) throw rejection('device_unavailable');
  if (template.deviceId !== device.id) throw new RawApiError(422, { error: 'La plantilla no pertenece al número actual', error_code: 'template_waba_mismatch' });
  if (template.status !== 'APPROVED') throw fieldError('template', `La plantilla está ${template.status}: solo se envían plantillas aprobadas.`);
  const contact = ctx.app.store.contacts.get(Number(b.contact_id));
  if (!contact) throw new RawApiError(404, { error: 'Contact not found' });
  if (!device.connected) throw rejection('device_unavailable');
  const variables = (b.template_variables as { body?: unknown } | undefined)?.body;
  const check = checkSend(ctx.app, { device, contact, profile: 'template', phone: b.phone, contentHashes: [] });
  if (check?.code === 'recipient_mismatch') throw check;
  const text = renderTemplate(template, variables);
  const [message] = send(ctx, {
    device,
    contact,
    profile: 'template',
    items: [{ type: 'template', text, file: template.file, templateId: template.id, hash: contentHash('template', template.id, variables) }],
    phone: b.phone,
    clientReference: reference,
    mac: false,
  });
  return ok({ message: publicMessage(message as Message) });
}

export const messageHandlers: HandlerTable = {
  'POST /api/v1/contacts/{contact}/message': (ctx) => sendToContact(ctx, getContact(ctx.app, ctx.path.contact), 'conversation'),

  'POST /api/v1/message/send-message': (ctx) => {
    const b = body(ctx);
    const contact = ctx.app.store.contacts.get(Number(b.contact_id));
    // `MessageController`: its own bodies, `{status: "error", error}`.
    if (!contact) throw new RawApiError(404, { status: 'error', error: 'Contacto no encontrado.' });
    if (!ctx.app.store.devices.has(Number(b.device_id))) throw new RawApiError(403, { status: 'error', error: 'No autorizado' });
    return sendToContact(ctx, contact, 'direct');
  },

  // The spec of the portal names the parameter `{template}`; conversations, `{template_id}`. Same URL.
  'POST /api/v1/devices/{device}/templates/{template}/send-template': sendTemplate,
  'POST /api/v1/devices/{device}/templates/{template_id}/send-template': sendTemplate,

  'POST /api/v1/contacts/{contact}/message/contact-card': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
    const b = body(ctx);
    const reference = clientReference(b);
    const device = getDevice(ctx.app, b.device_id);
    const ids = (b.contact_card_ids as number[] | undefined) ?? [];
    const cards = ids.map((id, i) => {
      const card = ctx.app.store.contacts.get(Number(id));
      if (!card) throw fieldError(`contact_card_ids.${i}`, `El valor seleccionado en contact_card_ids.${i} no es válido.`);
      return card;
    });
    const messages = send(ctx, {
      device,
      contact,
      profile: 'free_form',
      items: cards.map((card) => ({ type: 'contact', text: card.name, file: null, hash: contentHash('card', card.id) })),
      clientReference: reference,
      mac: true,
    });
    return ok({ messages: messages.map(publicMessage) });
  },

  'POST /api/v1/contacts/{contact}/messages/{message}/forward': (ctx) => {
    const origin = getContact(ctx.app, ctx.path.contact);
    const source = ctx.app.store.messages.get(Number(ctx.path.message));
    if (!source || source.contactId !== origin.id) throw objectNotFound();
    const b = body(ctx);
    const reference = clientReference(b);
    const targets = (b.targets as { contact_id: number; device_id: number }[] | undefined) ?? [];
    const resolved = targets.map((t, i) => {
      const contact = ctx.app.store.contacts.get(Number(t.contact_id));
      if (!contact) throw fieldError(`targets.${i}.contact_id`, `El valor seleccionado en targets.${i}.contact_id no es válido.`);
      return { contact, device: getDevice(ctx.app, t.device_id, `targets.${i}.device_id`) };
    });
    // Every destination passes the rules before anything is registered: the forward is all or nothing.
    for (const { contact, device } of resolved) {
      const refused = checkSend(ctx.app, { device, contact, profile: 'free_form', contentHashes: [contentHash('forward', source.id)] });
      if (refused) throw refused;
    }
    return ok(
      resolved.map(({ contact, device }) => {
        // The MAC lockout is not a 429 here: that destination comes back `blocked` (`ForwardMessageAction`).
        const mac = macRejection(ctx.app, contact);
        if (mac) return { contact_id: contact.id, mode: 'native', status: 'blocked', reason: mac.code, message: null };
        const [message] = send(ctx, {
          device,
          contact,
          profile: 'free_form',
          items: [{ type: source.type, text: source.text, file: source.file, hash: contentHash('forward', source.id) }],
          clientReference: reference,
          mac: false,
        });
        return { contact_id: contact.id, mode: 'native', status: 'queued', reason: null, message: publicMessage(message as Message) };
      }),
    );
  },

  'PUT /api/v1/contacts/{contact}/messages/{message}/reaction': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
    const message = ctx.app.store.messages.get(Number(ctx.path.message));
    if (!message || message.contactId !== contact.id) throw objectNotFound();
    message.reactions = [...message.reactions.filter((r) => !r.own), { emoji: String(body(ctx).emoji), own: true }];
    return { status: 202 };
  },

  'DELETE /api/v1/contacts/{contact}/messages/{message}/reaction': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
    const message = ctx.app.store.messages.get(Number(ctx.path.message));
    if (!message || message.contactId !== contact.id) throw objectNotFound();
    message.reactions = message.reactions.filter((r) => !r.own);
    return { status: 202 };
  },

  'GET /api/v1/contacts/{contactId}/messages': (ctx) => {
    const contact = ctx.app.store.contacts.get(Number(ctx.path.contactId));
    if (!contact) throw new RawApiError(404, { message: 'Contacto no encontrado.' });
    const since = ctx.query.updated_since ? new Date(String(ctx.query.updated_since)) : null;
    const list = ctx.app.store
      .contactMessages(contact.id)
      .filter((m) => !since || Number.isNaN(since.getTime()) || m.updatedAt >= since)
      .sort((a, b) => b.id - a.id);
    return ok(cursorPaginate(list, listContext(ctx), (m) => historyMessage(ctx.app.store, m)));
  },

  // One message by id (`ShowMessageController`): every refusal is the same 404.
  'GET /api/v1/contacts/{contact}/messages/{message}': (ctx) => {
    const contact = ctx.app.store.contacts.get(Number(ctx.path.contact));
    const message = ctx.app.store.messages.get(Number(ctx.path.message));
    if (!contact || !message || message.contactId !== contact.id) throw objectNotFound();
    return ok(publicMessage(message));
  },

  // --- templates --------------------------------------------------------------------------------------------

  'GET /api/v1/templates': (ctx) => {
    const q = ctx.query;
    const list = [...ctx.app.store.templates.values()]
      .filter(
        (t) =>
          (!q.name || t.name.includes(String(q.name))) &&
          (!q.uid || t.uid === String(q.uid)) &&
          (!q.status || t.status === q.status) &&
          (!q.category || t.category === q.category) &&
          (!q.language_code || t.languageCode === q.language_code) &&
          (!q.type || t.type === q.type) &&
          (q.deviceId === undefined || q.deviceId === null || t.deviceId === Number(q.deviceId)),
      )
      .sort((a, b) => (q.orderByMethod === 'asc' ? a.id - b.id : b.id - a.id));
    return ok(paginate(list, listContext(ctx), (t) => templateResource(t, q.deviceId === undefined ? undefined : Number(q.deviceId))));
  },

  'POST /api/v1/templates': (ctx) => {
    const b = body(ctx);
    const { app } = ctx;
    if (!/^[a-z0-9_]+$/.test(String(b.name))) throw fieldError('name', 'El nombre solo puede tener minúsculas, números y guiones bajos.');
    const device = [...app.store.devices.values()].find((d) => d.kind === 'cloud');
    if (!device) throw fieldError('name', 'La cuenta no tiene un número oficial para registrar plantillas.');
    const now = new Date();
    const id = app.store.ids.template.next();
    const template: Template = {
      id,
      uid: String(1_000_000_000 + id),
      name: String(b.name),
      body: String(b.body),
      header: typeof b.header === 'string' ? b.header : null,
      footer: typeof b.footer === 'string' ? b.footer : null,
      category: String(b.category),
      type: String(b.type),
      status: 'PENDING',
      languageCode: String(b.language_code),
      deviceId: device.id,
      file: typeof b.file === 'string' ? b.file : null,
      params: Array.isArray(b.params) ? b.params.map(String) : null,
      buttons: Array.isArray(b.buttons) ? (b.buttons as Template['buttons']) : null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    app.store.templates.set(id, template);
    const seconds = app.config.templateApprovalSeconds;
    if (seconds !== null) {
      const generation = app.generation;
      app.scheduler.after(seconds * 1000, () => {
        if (generation === app.generation && app.store.templates.get(id) === template && template.status === 'PENDING') {
          setTemplateStatus(app, template, 'APPROVED', null);
        }
      });
    }
    return ok(templateResource(template));
  },

  'GET /api/v1/templates/{template}': (ctx) => ok(templateResource(getTemplate(ctx.app, ctx.path.template))),

  'PUT /api/v1/templates/{template}': (ctx) => {
    const template = getTemplate(ctx.app, ctx.path.template);
    const b = body(ctx);
    getDevice(ctx.app, b.device_id);
    template.category = String(b.category);
    template.type = String(b.type);
    template.body = String(b.body);
    if ('header' in b) template.header = typeof b.header === 'string' ? b.header : null;
    if ('footer' in b) template.footer = typeof b.footer === 'string' ? b.footer : null;
    if ('params' in b) template.params = Array.isArray(b.params) ? b.params.map(String) : null;
    if ('buttons' in b) template.buttons = Array.isArray(b.buttons) ? (b.buttons as Template['buttons']) : null;
    template.updatedAt = new Date();
    return noContent();
  },

  'GET /api/v1/templates/{template}/quick-reply-buttons': (ctx) => {
    const template = getTemplate(ctx.app, ctx.path.template);
    return ok({ data: (template.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY').map((b) => ({ text: b.text ?? '' })) });
  },

  'DELETE /api/v1/devices/{device}/templates/{template}': (ctx) => {
    const template = getTemplate(ctx.app, ctx.path.template);
    if (template.deviceId !== Number(ctx.path.device)) throw notFound('La plantilla no es de este número.');
    ctx.app.store.templates.delete(template.id);
    return noContent();
  },
};

/** Changes a template's status and emits `template.status_changed`. */
export function setTemplateStatus(app: SandboxApp, template: Template, status: Template['status'], reason: string | null): void {
  const previous = template.status;
  if (previous === status) return;
  template.status = status;
  template.rejectionReason = reason;
  template.updatedAt = new Date();
  app.webhooks.emit('template.status_changed', {
    template: { id: template.id, uid: template.uid, name: template.name, category: template.category },
    previous_status: previous,
    status,
    reason,
  });
}
