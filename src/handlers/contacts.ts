/**
 * Contacts, their tags and custom fields, conversations, tags and custom fields (conversations domain).
 *
 * Workspaces (conversations v1.19.7, `ConfineApiKeyToWorkspace`): a key lists only the contacts and conversations of
 * its workspace (and, from the default one, those without a workspace); a contact of another workspace answers
 * conversations' bare `abort(404)`, `{"message": ""}`, and a contact a key creates lands in its workspace. Tags and
 * custom fields are not confined in the sandbox.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, ok, type HandlerContext, type HandlerTable } from '../http/context.js';
import { ApiError, fieldError, notFound, objectNotFound, validationFailed } from '../http/errors.js';
import { cursorPaginate, linkQuery, paginate } from '../http/paginate.js';
import {
  contactCustomFieldResource,
  contactResource,
  contactTagResource,
  conversationRow,
  customFieldResource,
  tagResource,
} from '../state/resources.js';
import type { Contact, CustomField } from '../state/store.js';
import type { FieldErrors } from '../openapi/validate.js';
import { sees, type WorkspaceScope } from '../state/workspaces.js';
import { digits, iso8601, toE164, asId } from '../util.js';

/**
 * conversations' `abort(404)` for a record or a number outside the key's workspace (`EnsureRecordInWorkspace`,
 * `ApiKeyWorkspace::abortUnlessDeviceAllowed`): the common `404 not_found` of what belongs to another account.
 */
export const outsideWorkspace = () => notFound();

/** A contact by id; with `scope`, one of another workspace answers `outsideWorkspace()`. */
export function getContact(app: SandboxApp, id: unknown, scope?: WorkspaceScope): Contact {
  const contact = app.store.contacts.get(asId(id));
  // The model binding of conversations (`bootstrap/app.php`): `404 not_found`, "Objeto no encontrado.".
  if (!contact) throw objectNotFound();
  if (scope && !sees(scope, contact.workspaceId)) throw outsideWorkspace();
  return contact;
}

/** The workspace of a contact's events (conversations `EventWorkspace`): the contact's. */
export const contactWorkspace = (contact: Contact): number | null => contact.workspaceId;

/** `{id, name, phone}` of a contact in an event: the phone with `+`. */
export function eventContact(contact: Contact): Record<string, unknown> {
  return { id: contact.id, name: contact.name, phone: toE164(contact.phone) };
}

export interface NewContact {
  /** The workspace it lands in: the key's, or the number's for an incoming message. */
  workspaceId: number | null;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  whatsappId?: unknown;
  image?: unknown;
  deviceId?: unknown;
}

const text = (value: unknown): string | null => (value === undefined || value === null || value === '' ? null : String(value));

/** Creates a contact and emits `contact.created`, like conversations' `ContactObserver::created`. */
export function createContact(app: SandboxApp, input: NewContact): Contact {
  const now = new Date();
  const id = app.store.ids.contact.next();
  const phone = digits(input.phone) || null;
  const contact: Contact = {
    id,
    workspaceId: input.workspaceId,
    name: text(input.name),
    email: text(input.email),
    phone,
    whatsappId: text(input.whatsappId),
    image: text(input.image),
    notes: null,
    status: 0,
    activeConversation: false,
    favorite: false,
    unreadMessages: 0,
    manuallyUnread: false,
    deviceId: input.deviceId === undefined || input.deviceId === null ? null : asId(input.deviceId),
    adviserId: null,
    pausedAt: null,
    tags: new Map(),
    customFields: new Map(),
    createdAt: now,
    updatedAt: now,
  };
  app.store.contacts.set(id, contact);
  app.webhooks.emit('contact.created', { contact: { ...eventContact(contact), email: contact.email } }, { workspaceId: contact.workspaceId });
  return contact;
}

const BSUID = /^[A-Za-z]{2}\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]{1,128}$/;

/** `ContactService::isBsuid`: Meta's business-scoped user id, like `US.13491208655302741918`. */
export const isBsuid = (value: string): boolean => BSUID.test(value);

const invalidPhone = (message: string, error: string) => new ApiError(422, 'validation_failed', message, { errors: { phone: [error] } });

/**
 * conversations v1.19.21 `FindOrCreateSendRecipientAction` (send by phone, without `contact_id`): the contact of that
 * phone (or `whatsapp_id`) in the account, or a new one in the key's workspace, with the `422`s of `update-or-create`.
 * One of another workspace answers `404` and nothing is created. The phone is kept in digits (the API also rewrites a
 * few national prefixes, which the sandbox does not).
 */
export function sendRecipient(ctx: HandlerContext, b: Record<string, unknown>): Contact {
  const { app } = ctx;
  const inScope = (contact: Contact): Contact => {
    if (!sees(ctx.workspace, contact.workspaceId)) throw outsideWorkspace();
    return contact;
  };
  if (b.phone !== undefined && b.phone !== null) {
    const phone = digits(b.phone);
    if (phone === '') throw invalidPhone('El número de teléfono proporcionado no es válido.', 'El número de teléfono es inválido.');
    if (phone.length < 7 || phone.length > 15 || !/[1-9]/.test(phone)) {
      throw invalidPhone('La longitud del número de teléfono no es válida.', 'El número de teléfono debe tener una longitud válida.');
    }
    const existing = app.store.findContactByPhone(phone);
    return existing ? inScope(existing) : createContact(app, { workspaceId: ctx.workspace.id, phone });
  }
  const whatsappId = String(b.whatsapp_id);
  const existing = [...app.store.contacts.values()].find((c) => c.whatsappId === whatsappId);
  return existing ? inScope(existing) : createContact(app, { workspaceId: ctx.workspace.id, whatsappId });
}

function sortContacts(list: Contact[], orderBy: unknown, direction: unknown): Contact[] {
  const key = typeof orderBy === 'string' ? orderBy : 'id';
  const desc = direction === undefined ? key === 'id' || key.endsWith('_at') : direction === 'desc';
  // Ids are opaque, so «by id» is the order of creation: the position in the store.
  const rank = new Map(list.map((c, i) => [c.id, i]));
  const value = (c: Contact): string | number => {
    switch (key) {
      case 'name':
        return (c.name ?? '').toLowerCase();
      case 'email':
        return (c.email ?? '').toLowerCase();
      case 'phone':
        return c.phone ?? '';
      case 'favorite':
        return c.favorite ? 1 : 0;
      case 'unread_messages':
        return c.unreadMessages;
      case 'created_at':
        return c.createdAt.getTime();
      case 'updated_at':
        return c.updatedAt.getTime();
      default:
        return rank.get(c.id) ?? 0;
    }
  };
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return desc ? -cmp : cmp;
  });
}

function idList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.filter((id): id is string => typeof id === 'string' && id !== '');
}

function matchesMode(has: (id: string) => boolean, ids: string[], mode: unknown): boolean {
  if (ids.length === 0) return true;
  if (mode === 'all') return ids.every(has);
  if (mode === 'exclude') return !ids.some(has);
  return ids.some(has);
}

function contactFilter(q: Record<string, unknown>): (c: Contact) => boolean {
  const contains = (field: string | null, needle: unknown) =>
    needle === undefined || needle === '' || (field ?? '').toLowerCase().includes(String(needle).toLowerCase());
  const tagIds = idList(q.tag_ids);
  const fieldIds = idList(q.custom_field_ids);
  const from = q.created_from ? new Date(String(q.created_from)) : null;
  const to = q.created_to ? new Date(String(q.created_to)) : null;
  return (c) =>
    contains(c.name, q.name) &&
    contains(c.email, q.email) &&
    // Like the API: the search by phone is a "contains" over the stored digits and does not strip a `+`.
    contains(c.phone, q.phone) &&
    contains(c.whatsappId, q.whatsapp_id) &&
    (q.status === undefined || q.status === '' || String(c.status) === String(q.status)) &&
    (!from || c.createdAt >= from) &&
    (!to || c.createdAt <= to) &&
    (!['1', 'true', true].includes(q.only_with_phone as string) || Boolean(c.phone)) &&
    matchesMode((id) => c.tags.has(id), tagIds, q.tag_mode) &&
    matchesMode((id) => c.customFields.has(id), fieldIds, q.custom_field_mode);
}

function applyContactUpdate(contact: Contact, b: Record<string, unknown>): void {
  if ('name' in b) contact.name = text(b.name);
  if ('email' in b) contact.email = text(b.email);
  if ('phone' in b) contact.phone = digits(b.phone) || null;
  if ('notes' in b) contact.notes = text(b.notes);
  if ('image' in b) contact.image = text(b.image);
  if (typeof b.status === 'number') contact.status = b.status;
  if (typeof b.favorite === 'boolean') contact.favorite = b.favorite;
  if (typeof b.manually_unread === 'boolean') contact.manuallyUnread = b.manually_unread;
  if (typeof b.unread_messages === 'number') contact.unreadMessages = Math.max(0, b.unread_messages);
  if (typeof b.device_id === 'string') contact.deviceId = b.device_id;
  contact.updatedAt = new Date();
}

/** `active_conversation` and `adviser_id` emit `conversation.closed` and `conversation.assigned`. */
function applyConversationUpdate(app: SandboxApp, contact: Contact, b: Record<string, unknown>): void {
  if (typeof b.active_conversation === 'boolean') {
    const wasActive = contact.activeConversation;
    contact.activeConversation = b.active_conversation;
    if (wasActive && !b.active_conversation) app.webhooks.emit('conversation.closed', { contact: eventContact(contact) }, { workspaceId: contact.workspaceId });
  }
  if ('adviser_id' in b) {
    const previous = contact.adviserId;
    contact.adviserId = b.adviser_id === null || b.adviser_id === undefined ? null : asId(b.adviser_id);
    if (contact.adviserId !== null && contact.adviserId !== previous) {
      app.webhooks.emit(
        'conversation.assigned',
        { contact: eventContact(contact), assignee: { type: 'human', name: `Agente ${contact.adviserId}` } },
        { workspaceId: contact.workspaceId },
      );
    }
  }
}

function hasMessages(app: SandboxApp, contact: Contact): boolean {
  for (const m of app.store.messages.values()) if (m.contactId === contact.id) return true;
  return false;
}

function lastMessageAt(app: SandboxApp, contact: Contact): number {
  let last = 0;
  for (const m of app.store.messages.values()) if (m.contactId === contact.id && m.createdAt.getTime() > last) last = m.createdAt.getTime();
  return last;
}

const truthy = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;

/** `ApplyContactCustomFieldValuesAction::MAX_VALUES_PER_CALL`. */
const MAX_CUSTOM_FIELD_VALUES = 100;

/**
 * conversations `CustomFieldValueFormat::violation()`: the format an API key must give a value, by the field's type
 * (0 text, 1 number, 2 date, 3 URL, 4 alphanumeric), with the message of `lang/es/errors.php`.
 */
function customFieldFormatError(field: CustomField, value: string): string | null {
  switch (field.type) {
    case 1:
      return /^-?\d+(\.\d+)?$/.test(value)
        ? null
        : `El campo «${field.name}» es numérico: escribe un número con punto decimal y sin separador de miles, por ejemplo "1500" o "99.90".`;
    case 2: {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      const real = date !== null && date.toISOString().slice(0, 10) === value;
      return real ? null : `El campo «${field.name}» es de fecha: escribe la fecha como AAAA-MM-DD, por ejemplo "2026-11-30".`;
    }
    case 3: {
      let ok = false;
      try {
        const url = new URL(value);
        ok = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
      } catch {
        ok = false;
      }
      return ok ? null : `El campo «${field.name}» es una URL: escribe la dirección completa, con https:// o http://, por ejemplo "https://ejemplo.com/pedido/123".`;
    }
    default:
      return null;
  }
}

/**
 * The optional `custom_fields: [{id, value}]` of `POST /contacts` and `update-or-create` (conversations
 * `ValidatesContactCustomFieldValues`): every item is checked before anything is written. First the rules (`value`
 * required, `id` not repeated), then, only if they pass, the fields: one that is not of the account answers 422 on
 * `custom_fields.N.id`, a value out of its type's format 422 on `custom_fields.N.value`. Returns what to write.
 */
function customFieldValues(ctx: HandlerContext, raw: unknown): { field: CustomField; value: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const items = raw as Record<string, unknown>[];
  const rules: FieldErrors = {};
  const ids = items.map((item) => (item.id === undefined || item.id === null ? null : String(item.id)));
  items.forEach((item, i) => {
    if (ids[i] !== null && ids.filter((id) => id === ids[i]).length > 1) rules[`custom_fields.${i}.id`] = [`El campo custom_fields.${i}.id tiene un valor duplicado.`];
    // `ConvertEmptyStringsToNull` and `TrimStrings`: a value of only spaces is missing.
    if (item.value === undefined || item.value === null || (typeof item.value === 'string' && item.value.trim() === '')) {
      rules[`custom_fields.${i}.value`] = [`El campo custom_fields.${i}.value es requerido.`];
    }
  });
  if (Object.keys(rules).length) throw validationFailed(rules);
  if (items.length > MAX_CUSTOM_FIELD_VALUES) throw fieldError('custom_fields', `El campo custom_fields no debe tener más de ${MAX_CUSTOM_FIELD_VALUES} elementos.`);
  const errors: FieldErrors = {};
  const values: { field: CustomField; value: string }[] = [];
  items.forEach((item, i) => {
    const field = ctx.app.store.customFields.get(asId(item.id));
    if (!field) {
      errors[`custom_fields.${i}.id`] = [`El custom_fields.${i}.id seleccionado no es válido.`];
      return;
    }
    const value = String(item.value);
    const format = customFieldFormatError(field, value);
    if (format) {
      errors[`custom_fields.${i}.value`] = [format];
      return;
    }
    values.push({ field, value });
  });
  if (Object.keys(errors).length) throw validationFailed(errors);
  return values;
}

/** `ApplyContactCustomFieldValuesAction::handle()`: writes the values, in the order sent. */
function applyCustomFieldValues(contact: Contact, values: { field: CustomField; value: string }[]): void {
  if (values.length === 0) return;
  const now = new Date();
  for (const { field, value } of values) {
    const current = contact.customFields.get(field.id);
    contact.customFields.set(field.id, { value, createdAt: current?.createdAt ?? now, updatedAt: now });
  }
  contact.updatedAt = now;
}

/**
 * `POST /contacts/add-tags` and `remove-tags` (conversations `ContactController::addTags()` / `removeTags()`): a list of
 * `{contactId, tag: {id}}`, up to 200. An item whose contact or tag is not of the account (or the contact is outside
 * the key's workspace) is skipped, without an error; a tag the contact already has (or does not have) changes nothing.
 * Each real change emits `contact.tag_added` / `contact.tag_removed` with `source: "manual"`. `200` without a body.
 */
function changeTags(ctx: HandlerContext, action: 'add' | 'remove'): { status: number } {
  const items = Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>[]) : [];
  for (const item of items) {
    const contact = ctx.app.store.contacts.get(asId(item.contactId));
    if (!contact || !sees(ctx.workspace, contact.workspaceId)) continue;
    const tagId = (item.tag as Record<string, unknown> | undefined)?.id;
    const tag = ctx.app.store.tags.get(asId(tagId));
    if (!tag) continue;
    if (action === 'add') {
      if (contact.tags.has(tag.id)) continue;
      contact.tags.set(tag.id, new Date());
    } else if (!contact.tags.delete(tag.id)) {
      continue;
    }
    ctx.app.webhooks.emit(
      action === 'add' ? 'contact.tag_added' : 'contact.tag_removed',
      { contact: eventContact(contact), tag: { id: tag.id, name: tag.name }, source: 'manual' },
      { workspaceId: contact.workspaceId },
    );
  }
  return { status: 200 };
}

function conversationFilter(app: SandboxApp, q: Record<string, unknown>): (c: Contact) => boolean {
  return (c) =>
    hasMessages(app, c) &&
    (q.contactId === undefined || c.id === asId(q.contactId)) &&
    (q.deviceId === undefined || [...app.store.messages.values()].some((m) => m.contactId === c.id && m.deviceId === asId(q.deviceId))) &&
    (q.activeConversation === undefined || c.activeConversation === truthy(q.activeConversation)) &&
    (q.unreadMessages === undefined || (c.unreadMessages > 0 || c.manuallyUnread) === truthy(q.unreadMessages)) &&
    (q.favorites === undefined || !truthy(q.favorites) || c.favorite) &&
    (q.perName === undefined || (c.name ?? '').toLowerCase().includes(String(q.perName).toLowerCase()));
}

/** The contacts a key reaches: those of its workspace. */
const visibleContacts = (ctx: HandlerContext): Contact[] => [...ctx.app.store.contacts.values()].filter((c) => sees(ctx.workspace, c.workspaceId));

const count = (ctx: HandlerContext, predicate: (c: Contact) => boolean) => ({ count: visibleContacts(ctx).filter(predicate).length });

export const contactHandlers: HandlerTable = {
  'GET /api/v1/contacts': (ctx) => {
    const list = sortContacts(visibleContacts(ctx).filter(contactFilter(ctx.query)), ctx.query.orderBy, ctx.query.orderByMethod);
    return ok(paginate(list, listContext(ctx), (c) => contactResource(ctx.app.store, c)));
  },

  // `ContactService::firstOrCreate`: `201` with the new contact, or `200` with the one the account already has with that
  // phone (or `whatsapp_id`); one of another workspace answers 404, like `update-or-create` (conversations v1.19.21).
  'POST /api/v1/contacts': (ctx) => {
    const b = body(ctx);
    if (!b.phone && !b.whatsapp_id) throw fieldError('phone', 'El campo phone es obligatorio cuando whatsapp_id no está presente.');
    if (b.deviceId !== undefined && b.deviceId !== null) {
      const device = ctx.app.store.devices.get(asId(b.deviceId));
      if (!device) throw fieldError('deviceId', 'El valor seleccionado en deviceId no es válido.');
      if (!sees(ctx.workspace, device.workspaceId)) throw outsideWorkspace();
    }
    // `custom_fields` are checked with the rest of the request, whatever the outcome, and written only on a contact
    // this call creates: an existing one is handed back as it is (`ContactController::store`).
    const values = customFieldValues(ctx, b.custom_fields);
    const phone = digits(b.phone);
    const existing = phone
      ? ctx.app.store.findContactByPhone(phone)
      : [...ctx.app.store.contacts.values()].find((c) => c.whatsappId !== null && c.whatsappId === String(b.whatsapp_id));
    if (existing && !sees(ctx.workspace, existing.workspaceId)) throw outsideWorkspace();
    if (existing) return ok(contactResource(ctx.app.store, existing));
    const contact = createContact(ctx.app, { workspaceId: ctx.workspace.id, name: b.name, email: b.email, phone: b.phone, whatsappId: b.whatsapp_id, image: b.image, deviceId: b.deviceId });
    applyCustomFieldValues(contact, values);
    return ok(contactResource(ctx.app.store, contact), 201);
  },

  // `200` with the contact it updated, `201` with the one it created (a Laravel resource of a model just created), and
  // in both cases the `custom_fields` it carries, checked before anything is written (conversations
  // `UpdateOrCreateContactRequest`).
  'POST /api/v1/contacts/update-or-create': (ctx) => {
    const b = body(ctx);
    const values = customFieldValues(ctx, b.custom_fields);
    const phone = digits(b.phone);
    if (!phone) throw fieldError('phone', 'El campo phone es obligatorio.');
    const existing = ctx.app.store.findContactByPhone(phone);
    // One the key does not reach answers 404 (`abortUnlessRecordInScope`).
    if (existing && !sees(ctx.workspace, existing.workspaceId)) throw outsideWorkspace();
    if (existing) {
      if ('name' in b && b.name !== null) existing.name = text(b.name);
      if ('email' in b && b.email !== null) existing.email = text(b.email);
      existing.updatedAt = new Date();
      applyCustomFieldValues(existing, values);
      return ok(contactResource(ctx.app.store, existing));
    }
    const contact = createContact(ctx.app, { workspaceId: ctx.workspace.id, name: b.name, email: b.email, phone });
    applyCustomFieldValues(contact, values);
    return ok(contactResource(ctx.app.store, contact), 201);
  },

  'POST /api/v1/contacts/add-tags': (ctx) => changeTags(ctx, 'add'),
  'POST /api/v1/contacts/remove-tags': (ctx) => changeTags(ctx, 'remove'),

  // The detail adds `opted_out`, `follow_up_date` and `name_mismatch` (see `contactResource`).
  'GET /api/v1/contacts/{contact}': (ctx) => ok(contactResource(ctx.app.store, getContact(ctx.app, ctx.path.contact, ctx.workspace), 'show')),

  'PUT /api/v1/contacts/{contact}': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const b = body(ctx);
    if ('phone' in b && digits(b.phone)) {
      const other = ctx.app.store.findContactByPhone(digits(b.phone));
      if (other && other.id !== contact.id) throw fieldError('phone', 'El valor del campo phone ya está en uso.');
    }
    applyContactUpdate(contact, b);
    applyConversationUpdate(ctx.app, contact, b);
    return ok(contactResource(ctx.app.store, contact));
  },

  'PUT /api/v1/contacts/{contact}/update': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const b = body(ctx);
    applyContactUpdate(contact, pick(b, ['favorite', 'unread_messages', 'device_id', 'notes', 'manually_unread']));
    applyConversationUpdate(ctx.app, contact, b);
    return ok(contactResource(ctx.app.store, contact));
  },

  'POST /api/v1/contacts/delete': (ctx) => {
    const b = body(ctx);
    const ids = b.all === true ? [...ctx.app.store.contacts.keys()] : idList(b.contactIds);
    for (const id of ids) {
      ctx.app.store.contacts.delete(id);
      for (const [mid, m] of ctx.app.store.messages) if (m.contactId === id) ctx.app.store.messages.delete(mid);
    }
    return ok({});
  },

  'GET /api/v1/contacts/{contact}/tags': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const items = [...contact.tags.entries()].flatMap(([id, at]) => {
      const tag = ctx.app.store.tags.get(id);
      return tag ? [{ tag, at }] : [];
    });
    return ok(paginate(items, listContext(ctx), ({ tag, at }) => contactTagResource(ctx.app.store, tag, at)));
  },

  'GET /api/v1/contacts/{contact}/custom-fields': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const items = [...contact.customFields.entries()].flatMap(([id, value]) => {
      const field = ctx.app.store.customFields.get(id);
      if (!field) return [];
      if (ctx.query.name && !field.name.toLowerCase().includes(String(ctx.query.name).toLowerCase())) return [];
      return [{ field, value }];
    });
    return ok(paginate(items, listContext(ctx), ({ field, value }) => contactCustomFieldResource(ctx.app.store, field, value.value, value)));
  },

  'POST /api/v1/contacts/attach-custom-field': (ctx) => {
    const items = Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>[]) : [];
    const now = new Date();
    return ok(
      items.map((item) => {
        // With a key, a field or a contact it cannot see is a 404 item inside the 200 (contract 1113,
        // `ContactController::attachCustomField`); the panel's 403 items are not the API's.
        const field = ctx.app.store.customFields.get(asId(item.customFieldId));
        if (!field) return { message: 'Objeto no encontrado.', status: 404 };
        const contact = ctx.app.store.contacts.get(asId(item.contactId));
        if (!contact || !sees(ctx.workspace, contact.workspaceId)) return { message: 'Contacto no encontrado.', status: 404 };
        const current = contact.customFields.get(field.id);
        contact.customFields.set(field.id, { value: String(item.value ?? ''), createdAt: current?.createdAt ?? now, updatedAt: now });
        contact.updatedAt = now;
        return { message: 'Custom field value attached successfully.', status: 201 };
      }),
    );
  },

  'POST /api/v1/contacts/detach-custom-field': (ctx) => {
    const items = Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>[]) : [];
    const messages = items.map((item) => {
      const contact = ctx.app.store.contacts.get(asId(item.contactId));
      if (!contact || !ctx.app.store.customFields.has(asId(item.customFieldId))) {
        return 'No autorizado: el contacto o el campo personalizado no pertenece al usuario autenticado.';
      }
      contact.customFields.delete(asId(item.customFieldId));
      return 'Custom field value detached successfully.';
    });
    return ok({ messages });
  },

  'GET /api/v1/contacts/{contact}/meta-window': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const device = ctx.app.store.devices.get(asId(ctx.query.device_id));
    // A number outside the account answers "closed" without saying whether it exists, like the API; one of another
    // workspace, 404.
    if (!device) return ok({ is_open: false, meta_device_id: null, expires_at: null });
    if (!sees(ctx.workspace, device.workspaceId)) throw outsideWorkspace();
    // A QR number has no 24-hour window: always open.
    if (device.kind !== 'cloud') return ok({ is_open: true, meta_device_id: null, expires_at: null });
    const open = ctx.app.store.windowOpen(contact.id, device.id);
    const last = ctx.app.store.lastInbound.get(`${contact.id}:${device.id}`);
    return ok({
      is_open: open,
      meta_device_id: open ? device.phoneNumberId : null,
      expires_at: open && last ? iso8601(new Date(last.getTime() + 24 * 60 * 60 * 1000)) : null,
    });
  },

  // --- conversations ------------------------------------------------------------------------------------------

  // The rows are not contacts: see `conversationRow()`. With a key the page is the cursor one of the key listings
  // (`KeyListingPage::fromCursor`): `links.first` is the first page, and `meta.total` the count of the filtered list
  // when there is no cursor (`null` above 5000, and with a cursor).
  'GET /api/v1/conversations': (ctx) => {
    const direction = ctx.query.orderBy === 'asc' ? 1 : -1;
    const list = visibleContacts(ctx)
      .filter(conversationFilter(ctx.app, ctx.query))
      .reverse()
      .sort((a, b) => direction * (lastMessageAt(ctx.app, a) - lastMessageAt(ctx.app, b)));
    const page = cursorPaginate(list, listContext(ctx), (c) => conversationRow(ctx.app.store, c));
    const meta = page.meta as Record<string, unknown>;
    const links = page.links as Record<string, unknown>;
    links.first = `${meta.path as string}?${linkQuery(listContext(ctx), { perPage: meta.per_page as number }, ['cursor']).toString()}`;
    const hasCursor = ctx.query.cursor !== undefined && ctx.query.cursor !== '';
    meta.total = hasCursor || list.length > 5000 ? null : list.length;
    return ok(page);
  },
  'GET /api/v1/conversations/count/unread': (ctx) => ok(count(ctx, (c) => c.unreadMessages > 0 || c.manuallyUnread)),
  'GET /api/v1/conversations/count/open': (ctx) => ok(count(ctx, (c) => c.activeConversation)),
  'GET /api/v1/conversations/count/closed': (ctx) => ok(count(ctx, (c) => !c.activeConversation && hasMessages(ctx.app, c))),
  'GET /api/v1/conversations/count/all': (ctx) => ok(count(ctx, (c) => hasMessages(ctx.app, c))),
  'POST /api/v1/conversations/mark-all-read': (ctx) => {
    let updated = 0;
    for (const c of visibleContacts(ctx)) {
      if (c.unreadMessages > 0 || c.manuallyUnread) {
        c.unreadMessages = 0;
        c.manuallyUnread = false;
        updated++;
      }
    }
    return ok({ message: 'Todas las conversaciones han sido marcadas como leídas', updated_count: updated });
  },
  'POST /api/v1/conversations/mark-all-unread': (ctx) => {
    // `pluck('contacts.id')->toArray()`: a list of the contacts marked in this call.
    const ids: string[] = [];
    for (const c of visibleContacts(ctx)) {
      if (hasMessages(ctx.app, c) && !(c.unreadMessages > 0 || c.manuallyUnread)) {
        c.manuallyUnread = true;
        ids.push(c.id);
      }
    }
    return ok({ message: 'Todas las conversaciones elegibles fueron marcadas como no leídas', marked_count: ids.length, limit_reached: false, contact_ids: ids });
  },

  // --- tags ---------------------------------------------------------------------------------------------------

  'GET /api/v1/tags': (ctx) => {
    const name = ctx.query.name ? String(ctx.query.name).toLowerCase() : null;
    const key = ctx.query.orderBy === 'name' ? 'name' : ctx.query.orderBy === 'updated_at' ? 'updatedAt' : 'createdAt';
    const desc = ctx.query.orderByMethod === 'desc';
    const list = [...ctx.app.store.tags.values()]
      .filter((t) => !name || t.name.toLowerCase().includes(name))
      .sort((a, b) => {
        const va = key === 'name' ? a.name.toLowerCase() : a[key].getTime();
        const vb = key === 'name' ? b.name.toLowerCase() : b[key].getTime();
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return desc ? -cmp : cmp;
      });
    // `TagResource::collection()->additional(['with_contact_count' => …])`.
    return ok({ ...paginate(list, listContext(ctx), (t) => tagResource(ctx.app.store, t)), with_contact_count: ctx.query.withContactCount === true });
  },
  'POST /api/v1/tags': (ctx) => {
    const b = body(ctx);
    const now = new Date();
    const id = ctx.app.store.ids.tag.next();
    const tag = { id, name: String(b.name), color: text(b.color), createdAt: now, updatedAt: now };
    ctx.app.store.tags.set(id, tag);
    return ok(tagResource(ctx.app.store, tag));
  },
  'GET /api/v1/tags/{tag}': (ctx) => ok(tagResource(ctx.app.store, getTag(ctx))),
  'PUT /api/v1/tags/{tag}': (ctx) => {
    const tag = getTag(ctx);
    const b = body(ctx);
    tag.name = String(b.name);
    if ('color' in b) tag.color = text(b.color);
    tag.updatedAt = new Date();
    return ok(tagResource(ctx.app.store, tag));
  },
  'POST /api/v1/tags/delete': (ctx) => {
    for (const id of idList(body(ctx).tagIds)) {
      ctx.app.store.tags.delete(id);
      for (const c of ctx.app.store.contacts.values()) c.tags.delete(id);
    }
    return ok({});
  },
  'GET /api/v1/tags/{tag}/contacts': (ctx) => {
    const tag = getTag(ctx);
    const list = [...ctx.app.store.contacts.values()].filter((c) => c.tags.has(tag.id));
    return ok(paginate(list, listContext(ctx), (c) => contactResource(ctx.app.store, c)));
  },

  // --- custom fields --------------------------------------------------------------------------------------------

  'GET /api/v1/custom-fields': (ctx) => {
    const name = ctx.query.name ? String(ctx.query.name).toLowerCase() : null;
    const list = [...ctx.app.store.customFields.values()].filter(
      (f) => (!name || f.name.toLowerCase().includes(name)) && (ctx.query.type === undefined || f.type === Number(ctx.query.type)),
    );
    return ok({ ...paginate(list, listContext(ctx), (f) => customFieldResource(ctx.app.store, f)), with_contact_count: ctx.query.withContactCount === true });
  },
  'POST /api/v1/custom-fields': (ctx) => {
    const b = body(ctx);
    if (![0, 1, 2, 3, 4].includes(Number(b.type))) throw fieldError('type', 'El valor seleccionado en type no es válido.');
    const now = new Date();
    const id = ctx.app.store.ids.customField.next();
    const field = { id, name: String(b.name), type: Number(b.type), createdAt: now, updatedAt: now };
    ctx.app.store.customFields.set(id, field);
    return ok(customFieldResource(ctx.app.store, field));
  },
  'GET /api/v1/custom-fields/{customField}': (ctx) => ok(customFieldResource(ctx.app.store, getCustomField(ctx))),
  'PUT /api/v1/custom-fields/{customField}': (ctx) => {
    const field = getCustomField(ctx);
    const b = body(ctx);
    if (typeof b.name === 'string') field.name = b.name;
    field.updatedAt = new Date();
    return ok(customFieldResource(ctx.app.store, field));
  },
  'POST /api/v1/custom-fields/delete': (ctx) => {
    for (const id of idList(body(ctx).customFieldIds)) {
      ctx.app.store.customFields.delete(id);
      for (const c of ctx.app.store.contacts.values()) c.customFields.delete(id);
    }
    return ok({});
  },
};

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]));
}

function getTag(ctx: HandlerContext) {
  const tag = ctx.app.store.tags.get(asId(ctx.path.tag));
  if (!tag) throw objectNotFound();
  return tag;
}

function getCustomField(ctx: HandlerContext) {
  const field = ctx.app.store.customFields.get(asId(ctx.path.customField));
  if (!field) throw objectNotFound();
  return field;
}
