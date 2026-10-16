/**
 * Contacts, their tags and custom fields, conversations, tags and custom fields (conversations domain).
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, ok, type HandlerContext, type HandlerTable } from '../http/context.js';
import { fieldError, notFound } from '../http/errors.js';
import { cursorPaginate, paginate } from '../http/paginate.js';
import {
  contactCustomFieldResource,
  contactResource,
  contactTagResource,
  customFieldResource,
  tagResource,
} from '../state/resources.js';
import type { Contact } from '../state/store.js';
import { digits, toE164 } from '../util.js';

export function getContact(app: SandboxApp, id: unknown): Contact {
  const contact = app.store.contacts.get(Number(id));
  if (!contact) throw notFound('El contacto no existe en esta cuenta.');
  return contact;
}

/** `{id, name, phone}` of a contact in an event: the phone with `+`. */
export function eventContact(contact: Contact): Record<string, unknown> {
  return { id: contact.id, name: contact.name, phone: toE164(contact.phone) };
}

export interface NewContact {
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
    deviceId: input.deviceId === undefined || input.deviceId === null ? null : Number(input.deviceId),
    adviserId: null,
    pausedAt: null,
    tags: new Map(),
    customFields: new Map(),
    createdAt: now,
    updatedAt: now,
  };
  app.store.contacts.set(id, contact);
  app.webhooks.emit('contact.created', { contact: { ...eventContact(contact), email: contact.email } });
  return contact;
}

function sortContacts(list: Contact[], orderBy: unknown, direction: unknown): Contact[] {
  const key = typeof orderBy === 'string' ? orderBy : 'id';
  const desc = direction === undefined ? key === 'id' || key.endsWith('_at') : direction === 'desc';
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
        return c.id;
    }
  };
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : a.id - b.id;
    return desc ? -cmp : cmp;
  });
}

function idList(value: unknown): number[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map(Number).filter((n) => Number.isInteger(n));
}

function matchesMode(has: (id: number) => boolean, ids: number[], mode: unknown): boolean {
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
  if (typeof b.device_id === 'number') contact.deviceId = b.device_id;
  contact.updatedAt = new Date();
}

/** `active_conversation` and `adviser_id` emit `conversation.closed` and `conversation.assigned`. */
function applyConversationUpdate(app: SandboxApp, contact: Contact, b: Record<string, unknown>): void {
  if (typeof b.active_conversation === 'boolean') {
    const wasActive = contact.activeConversation;
    contact.activeConversation = b.active_conversation;
    if (wasActive && !b.active_conversation) app.webhooks.emit('conversation.closed', { contact: eventContact(contact) });
  }
  if ('adviser_id' in b) {
    const previous = contact.adviserId;
    contact.adviserId = b.adviser_id === null || b.adviser_id === undefined ? null : Number(b.adviser_id);
    if (contact.adviserId !== null && contact.adviserId !== previous) {
      app.webhooks.emit('conversation.assigned', { contact: eventContact(contact), assignee: { type: 'human', name: `Agente ${contact.adviserId}` } });
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

function conversationFilter(app: SandboxApp, q: Record<string, unknown>): (c: Contact) => boolean {
  return (c) =>
    hasMessages(app, c) &&
    (q.contactId === undefined || c.id === Number(q.contactId)) &&
    (q.deviceId === undefined || [...app.store.messages.values()].some((m) => m.contactId === c.id && m.deviceId === Number(q.deviceId))) &&
    (q.activeConversation === undefined || c.activeConversation === truthy(q.activeConversation)) &&
    (q.unreadMessages === undefined || (c.unreadMessages > 0 || c.manuallyUnread) === truthy(q.unreadMessages)) &&
    (q.favorites === undefined || !truthy(q.favorites) || c.favorite) &&
    (q.perName === undefined || (c.name ?? '').toLowerCase().includes(String(q.perName).toLowerCase()));
}

const count = (app: SandboxApp, predicate: (c: Contact) => boolean) => ({ count: [...app.store.contacts.values()].filter(predicate).length });

export const contactHandlers: HandlerTable = {
  'GET /api/v1/contacts': (ctx) => {
    const list = sortContacts([...ctx.app.store.contacts.values()].filter(contactFilter(ctx.query)), ctx.query.orderBy, ctx.query.orderByMethod);
    return ok(paginate(list, listContext(ctx), (c) => contactResource(ctx.app.store, c)));
  },

  'POST /api/v1/contacts': (ctx) => {
    const b = body(ctx);
    if (!b.phone && !b.whatsapp_id) throw fieldError('phone', 'El campo phone es obligatorio cuando whatsapp_id no está presente.');
    const phone = digits(b.phone);
    if (phone && ctx.app.store.findContactByPhone(phone)) throw fieldError('phone', 'El valor del campo phone ya está en uso.');
    const contact = createContact(ctx.app, { name: b.name, email: b.email, phone: b.phone, whatsappId: b.whatsapp_id, image: b.image, deviceId: b.deviceId });
    return ok(contactResource(ctx.app.store, contact));
  },

  'POST /api/v1/contacts/update-or-create': (ctx) => {
    const b = body(ctx);
    const phone = digits(b.phone);
    if (!phone) throw fieldError('phone', 'El campo phone es obligatorio.');
    const existing = ctx.app.store.findContactByPhone(phone);
    if (existing) {
      if ('name' in b && b.name !== null) existing.name = text(b.name);
      if ('email' in b && b.email !== null) existing.email = text(b.email);
      existing.updatedAt = new Date();
      return ok(contactResource(ctx.app.store, existing));
    }
    return ok(contactResource(ctx.app.store, createContact(ctx.app, { name: b.name, email: b.email, phone })));
  },

  'GET /api/v1/contacts/{contact}': (ctx) => ok(contactResource(ctx.app.store, getContact(ctx.app, ctx.path.contact))),

  'PUT /api/v1/contacts/{contact}': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
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
    const contact = getContact(ctx.app, ctx.path.contact);
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
    const contact = getContact(ctx.app, ctx.path.contact);
    const items = [...contact.tags.entries()].flatMap(([id, at]) => {
      const tag = ctx.app.store.tags.get(id);
      return tag ? [{ tag, at }] : [];
    });
    return ok(paginate(items, listContext(ctx), ({ tag, at }) => contactTagResource(ctx.app.store, tag, at)));
  },

  'GET /api/v1/contacts/{contact}/custom-fields': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
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
        const field = ctx.app.store.customFields.get(Number(item.customFieldId));
        if (!field) return { message: 'No autorizado: el campo personalizado no pertenece al usuario autenticado.', status: 403 };
        const contact = ctx.app.store.contacts.get(Number(item.contactId));
        if (!contact) return { message: 'No autorizado: el contacto no pertenece al usuario autenticado.', status: 403 };
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
      const contact = ctx.app.store.contacts.get(Number(item.contactId));
      if (!contact || !ctx.app.store.customFields.has(Number(item.customFieldId))) {
        return 'No autorizado: el contacto o el campo personalizado no pertenece al usuario autenticado.';
      }
      contact.customFields.delete(Number(item.customFieldId));
      return 'Custom field value detached successfully.';
    });
    return ok({ messages });
  },

  'GET /api/v1/contacts/{contact}/meta-window': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact);
    const device = ctx.app.store.devices.get(Number(ctx.query.device_id));
    // A number outside the account answers "closed" without saying whether it exists, like the API.
    if (!device) return ok({ is_open: false, meta_device_id: null });
    const open = ctx.app.store.windowOpen(contact.id, device.id);
    return ok({ is_open: open, meta_device_id: open && device.kind === 'cloud' ? device.phoneNumberId : null });
  },

  // --- conversations ------------------------------------------------------------------------------------------

  'GET /api/v1/conversations': (ctx) => {
    const direction = ctx.query.orderBy === 'asc' ? 1 : -1;
    const list = [...ctx.app.store.contacts.values()]
      .filter(conversationFilter(ctx.app, ctx.query))
      .sort((a, b) => direction * (lastMessageAt(ctx.app, a) - lastMessageAt(ctx.app, b)) || b.id - a.id);
    return ok(cursorPaginate(list, listContext(ctx), (c) => contactResource(ctx.app.store, c)));
  },
  'GET /api/v1/conversations/count/unread': (ctx) => ok(count(ctx.app, (c) => c.unreadMessages > 0 || c.manuallyUnread)),
  'GET /api/v1/conversations/count/open': (ctx) => ok(count(ctx.app, (c) => c.activeConversation)),
  'GET /api/v1/conversations/count/closed': (ctx) => ok(count(ctx.app, (c) => !c.activeConversation && hasMessages(ctx.app, c))),
  'GET /api/v1/conversations/count/all': (ctx) => ok(count(ctx.app, (c) => hasMessages(ctx.app, c))),
  'POST /api/v1/conversations/mark-all-read': (ctx) => {
    let updated = 0;
    for (const c of ctx.app.store.contacts.values()) {
      if (c.unreadMessages > 0 || c.manuallyUnread) {
        c.unreadMessages = 0;
        c.manuallyUnread = false;
        updated++;
      }
    }
    return ok({ message: 'Todas las conversaciones han sido marcadas como leídas', updated_count: updated });
  },
  'POST /api/v1/conversations/mark-all-unread': (ctx) => {
    const ids: Record<string, number> = {};
    for (const c of ctx.app.store.contacts.values()) {
      if (hasMessages(ctx.app, c) && !(c.unreadMessages > 0 || c.manuallyUnread)) {
        c.manuallyUnread = true;
        ids[String(Object.keys(ids).length)] = c.id;
      }
    }
    return ok({ message: 'Todas las conversaciones elegibles fueron marcadas como no leídas', marked_count: Object.keys(ids).length, limit_reached: false, contact_ids: ids });
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
        const cmp = va < vb ? -1 : va > vb ? 1 : a.id - b.id;
        return desc ? -cmp : cmp;
      });
    return ok(paginate(list, listContext(ctx), (t) => tagResource(ctx.app.store, t)));
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
    return ok(paginate(list, listContext(ctx), (f) => customFieldResource(ctx.app.store, f)));
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
  const tag = ctx.app.store.tags.get(Number(ctx.path.tag));
  if (!tag) throw notFound('La etiqueta no existe en esta cuenta.');
  return tag;
}

function getCustomField(ctx: HandlerContext) {
  const field = ctx.app.store.customFields.get(Number(ctx.path.customField));
  if (!field) throw notFound('El campo personalizado no existe en esta cuenta.');
  return field;
}
