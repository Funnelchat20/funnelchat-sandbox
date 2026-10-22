/**
 * The public shape of each object, as the domains' Laravel resources write them (keys, order, date formats).
 */
import { iso8601, isoSeconds, laravelJson, sqlDateTime } from '../util.js';
import type { Contact, CustomField, Delivery, Device, Message, Store, Subscription, Tag, Template } from './store.js';

/** The account the sandbox imitates. REST resources carry it in `user_id`; events never do. */
export const ACCOUNT_USER_ID = 1;

const MESSAGE_TYPE_INT: Record<string, number> = {
  text: 0,
  image: 1,
  video: 2,
  document: 3,
  sticker: 4,
  contact: 5,
  audio: 6,
  note: 7,
  action: 8,
  interactive: 10,
  location: 11,
  button: 15,
  template: 16,
  option_list: 18,
};

/** MessageStatusEnum of conversations: the number the history shows. */
function statusInt(message: Message, device: Device | undefined): number | null {
  switch (message.status) {
    case 'queued':
      return 4;
    case 'sent':
      return 0;
    case 'delivered':
      // Official numbers say DELIVERED; QR ones, RECEIVED (both are "delivered" in the event).
      return device?.kind === 'qr' ? 1 : 10;
    case 'read':
      return 2;
    case 'failed':
      return 9;
    default:
      return message.own ? null : 1;
  }
}

export function contactResource(store: Store, contact: Contact): Record<string, unknown> {
  const messages = store.contactMessages(contact.id).sort((a, b) => b.id - a.id);
  const last = messages[0];
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    whatsapp_id: contact.whatsappId,
    whatsapp_username: null,
    has_phone: Boolean(contact.phone),
    country_code: '',
    status: contact.status,
    image: contact.image,
    notes: contact.notes,
    custom_fields: [...contact.customFields.entries()].flatMap(([id, value]) => {
      const field = store.customFields.get(id);
      return field ? [contactCustomFieldResource(store, field, value.value, value)] : [];
    }),
    created_at: laravelJson(contact.createdAt),
    active_conversation: contact.activeConversation ? 1 : 0,
    favorite: contact.favorite ? 1 : 0,
    unread_messages: contact.unreadMessages,
    manually_unread: contact.manuallyUnread,
    last_message: last
      ? {
          text: last.text ?? '',
          file: last.file ?? '',
          date: sqlDateTime(last.createdAt),
          type: String(MESSAGE_TYPE_INT[last.type] ?? 0),
          own: last.own ? '1' : '0',
          deleted_at: null,
          deleted_scope: null,
        }
      : null,
    device_id: contact.deviceId,
    adviser_id: contact.adviserId,
    paused_at: contact.pausedAt ? laravelJson(contact.pausedAt) : null,
    mac_date: null,
    ai_assistant_name: null,
    stage_since: null,
    is_stagnant: false,
    lead_score: {
      score: 0,
      signals_count: 0,
      category: 'insufficient_data',
      confidence: 'low',
      disqualified: false,
      disqualified_at: null,
      updated_at: null,
    },
  };
}

export function contactCount(store: Store, predicate: (c: Contact) => boolean): number {
  let n = 0;
  for (const contact of store.contacts.values()) if (predicate(contact)) n++;
  return n;
}

export function tagResource(store: Store, tag: Tag): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    description: null,
    color: tag.color,
    created_at: laravelJson(tag.createdAt),
    updated_at: laravelJson(tag.updatedAt),
    contact_count: contactCount(store, (c) => c.tags.has(tag.id)),
  };
}

export function contactTagResource(store: Store, tag: Tag, assignedAt: Date): Record<string, unknown> {
  return {
    ...tagResource(store, tag),
    contact_count: String(contactCount(store, (c) => c.tags.has(tag.id))),
    assigned_at: laravelJson(assignedAt),
    last_updated: laravelJson(assignedAt),
  };
}

export function customFieldResource(store: Store, field: CustomField): Record<string, unknown> {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    description: null,
    contact_count: contactCount(store, (c) => c.customFields.has(field.id)),
    created_at: laravelJson(field.createdAt),
  };
}

export function contactCustomFieldResource(
  store: Store,
  field: CustomField,
  value: string,
  dates: { createdAt: Date; updatedAt: Date },
): Record<string, unknown> {
  return {
    id: field.id,
    name: field.name,
    description: null,
    type: String(field.type),
    value,
    created_at: laravelJson(dates.createdAt),
    updated_at: laravelJson(dates.updatedAt),
    contact_count: String(contactCount(store, (c) => c.customFields.has(field.id))),
  };
}

export function templateResource(template: Template, currentDeviceId?: number): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    text: template.body,
    header: template.header ?? '',
    footer: template.footer ?? '',
    observation: template.rejectionReason ?? '',
    uid: template.uid,
    category: template.category,
    type: template.type,
    status: template.status,
    language_code: template.languageCode,
    upload_session_id: '',
    header_handle: '',
    file: template.file ?? '',
    params: template.params ?? [],
    buttons: template.buttons ?? [],
    user_id: ACCOUNT_USER_ID,
    device_id: template.deviceId,
    created_at: laravelJson(template.createdAt),
    quick_reply_buttons: (template.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY').map((b) => b.text ?? ''),
    waba_id: '100000000000001',
    belongs_to_current_device: currentDeviceId === undefined ? true : template.deviceId === currentDeviceId,
  };
}

/** accounts `DeviceCapabilities::forDevice`: what the public API can do with a number, per provider. */
const MESSAGES_QR = { text: true, media: true, buttons: true, lists: true, templates: false, location: true, voice_note: true, polls: true, events: true, contact_card: true, reactions: true };
const MESSAGES_CLOUD = { text: true, media: true, buttons: true, lists: true, templates: true, location: true, voice_note: true, polls: false, events: false, contact_card: true, reactions: false };
const GROUPS_QR = { create: true, add_participants: 'direct', remove_participants: true, admins: true, photo: true, settings: true, invite_link: true, send: true, join_requests: false };
/** Official numbers without communities' `cloud_api_groups` beta (the sandbox account does not have it). */
const GROUPS_NONE = { create: false, add_participants: false, remove_participants: false, admins: false, photo: false, settings: false, invite_link: false, send: false, join_requests: false };

export function deviceCapabilities(device: Device): Record<string, unknown> {
  const cloud = device.kind === 'cloud';
  return {
    messages: { ...(cloud ? MESSAGES_CLOUD : MESSAGES_QR) },
    groups: { ...(cloud ? GROUPS_NONE : GROUPS_QR) },
    statuses: ['sent', 'delivered', 'read', 'failed'],
  };
}

/** accounts `DeviceHealthSummaryBuilder`: `null` for any number that is not of Meta. */
function deviceHealth(device: Device): Record<string, unknown> | null {
  if (device.kind !== 'cloud') return null;
  return {
    state: device.connected ? 'available' : 'unknown',
    reason: null,
    reason_truncated: false,
    reason_key: null,
    quality_level: 'high',
    name_state: 'approved',
    messaging_limit_tier: 'TIER_1K',
    messaging_limit_per_day: 1000,
    last_fetched_at: iso8601(device.createdAt),
    stale: false,
  };
}

/** accounts v1.4.24 `DeviceResource`, in its order. */
export function deviceResource(device: Device): Record<string, unknown> {
  return {
    id: device.id,
    alias: device.alias,
    image: '',
    color: device.kind === 'cloud' ? '#25D366' : '#128C7E',
    number: device.number,
    normalized_number: device.number,
    first_conecction_at: laravelJson(device.createdAt),
    user_id: ACCOUNT_USER_ID,
    provider: device.provider,
    waba_id: device.wabaId ?? '',
    whatsapp_username: null,
    is_business: device.kind === 'cloud' ? 1 : 0,
    connected: device.connected ? 1 : 0,
    active: 1,
    health: deviceHealth(device),
    number_key: device.number,
    number_key_confirmed: true,
    is_coexistence: false,
    slot_state: 'held',
    pool_suspended: false,
    pool_suspension_reason: null,
    pool_keep: false,
    qr_allowed: device.kind === 'qr',
    can_change_to_meta: false,
    capabilities: deviceCapabilities(device),
  };
}

/** The ten keys of the public message (conversations feat/envio-devuelve-id, `PublicMessageResource`). */
export function publicMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    contact_id: message.contactId,
    device_id: message.deviceId,
    direction: message.own ? 'outbound' : 'inbound',
    type: message.type,
    status: message.status,
    error: message.status === 'failed' ? (message.error ?? { code: null, title: null, reason: null }) : null,
    client_reference: message.clientReference,
    created_at: isoSeconds(message.createdAt),
    updated_at: isoSeconds(message.updatedAt),
  };
}

/** One row of `GET /api/v1/contacts/{contactId}/messages` (conversations `MessageResource`). */
export function historyMessage(store: Store, message: Message): Record<string, unknown> {
  const contact = store.contacts.get(message.contactId);
  const device = message.deviceId === null ? undefined : store.devices.get(message.deviceId);
  return {
    chat_id: contact?.phone ? `${contact.phone}@c.us` : '',
    contact_id: message.contactId,
    content: '',
    device_id: message.deviceId ?? '',
    error_code: message.error?.code === null || message.error?.code === undefined ? '' : String(message.error.code),
    file: message.file ?? '',
    forwarded: 0,
    group_id: '',
    id: message.id,
    origin: message.own ? 1 : '',
    origin_id: '',
    own: message.own ? 1 : 0,
    reference_message: null,
    reference_message_uid: null,
    is_quotable: message.status !== 'queued' && message.status !== 'failed',
    status: statusInt(message, device),
    temporal_uuid: '',
    text: message.text ?? '',
    time: sqlDateTime(message.createdAt),
    type: MESSAGE_TYPE_INT[message.type] ?? 0,
    uid: message.uid,
    info: '',
    user_id: ACCOUNT_USER_ID,
    deleted_at: null,
    deleted_scope: null,
    reactions: message.reactions.map((r) => ({ emoji: r.emoji, own: r.own })),
    file_original_name: null,
    client_reference: message.clientReference,
  };
}

/** accounts `WebhookSubscriptionResource`: never the secret. */
export function subscriptionResource(subscription: Subscription): Record<string, unknown> {
  return {
    id: subscription.id,
    url: subscription.url,
    description: subscription.description,
    events: [...subscription.events],
    filters: { ...subscription.filters },
    status: subscription.status,
    disabled_reason: subscription.disabledReason,
    last_delivery_at: subscription.lastDeliveryAt ? iso8601(subscription.lastDeliveryAt) : null,
    last_success_at: subscription.lastSuccessAt ? iso8601(subscription.lastSuccessAt) : null,
    secret_rotated_at: subscription.secretRotatedAt ? iso8601(subscription.secretRotatedAt) : null,
    created_at: iso8601(subscription.createdAt),
    updated_at: iso8601(subscription.updatedAt),
    migration: null,
  };
}

/** accounts `WebhookSubscriptionCreatedResource`: the only answer (with the rotation) that carries the secret. */
export function subscriptionWithSecret(subscription: Subscription): Record<string, unknown> {
  return {
    ...subscriptionResource(subscription),
    secret: subscription.secret,
    secret_notice: 'Guardá este secreto ahora: es la única vez que se muestra. Con él validás la firma del header de cada entrega.',
  };
}

/** accounts `WebhookSubscriptionDeliveryResource`. */
export function deliveryResource(delivery: Delivery): Record<string, unknown> {
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    attempt: delivery.attempt,
    url: delivery.url,
    response_status: delivery.responseStatus,
    succeeded: delivery.succeeded,
    error: delivery.error,
    duration_ms: delivery.durationMs,
    attempted_at: iso8601(delivery.attemptedAt),
  };
}
