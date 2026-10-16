/**
 * The in-memory state of the sandbox: one account, its two example numbers, and what a real integration touches
 * (contacts, conversations and messages, tags, custom fields, templates and webhook subscriptions). Everything is
 * lost when the process stops or on `POST /_sandbox/reset`.
 */
import { randomBytes } from 'node:crypto';

export type PublicStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageError {
  code: number | null;
  title: string | null;
  reason: string | null;
}

export type DeviceKind = 'cloud' | 'qr';

export interface Device {
  id: number;
  alias: string;
  /** Digits only, without `+`. */
  number: string;
  /** WhatsAppProviderEnum of accounts: 1 Z-API (QR), 2 WhatsApp Cloud (official). */
  provider: 1 | 2;
  kind: DeviceKind;
  connected: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
  createdAt: Date;
}

export interface Contact {
  id: number;
  name: string | null;
  email: string | null;
  /** Digits only: the API stores the phone without `+`. */
  phone: string | null;
  whatsappId: string | null;
  image: string | null;
  notes: string | null;
  status: number;
  activeConversation: boolean;
  favorite: boolean;
  unreadMessages: number;
  manuallyUnread: boolean;
  deviceId: number | null;
  adviserId: number | null;
  pausedAt: Date | null;
  tags: Map<number, Date>;
  customFields: Map<number, { value: string; createdAt: Date; updatedAt: Date }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: number;
  contactId: number;
  deviceId: number | null;
  own: boolean;
  /** Public type name (`text`, `image`, `template`, `contact`, `note`…). */
  type: string;
  text: string | null;
  file: string | null;
  status: PublicStatus | null;
  error: MessageError | null;
  clientReference: string | null;
  uid: string;
  /** Sent with an API key: it has the queued → sent → delivered → read lifecycle and emits its states. */
  viaApi: boolean;
  templateId: number | null;
  reactions: { emoji: string; own: boolean }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomField {
  id: number;
  name: string;
  type: number;
  createdAt: Date;
  updatedAt: Date;
}

export type TemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface Template {
  id: number;
  uid: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  category: string;
  type: string;
  status: TemplateStatus;
  languageCode: string;
  deviceId: number;
  file: string | null;
  params: string[] | null;
  buttons: { text?: string; type?: string; url?: string; phone_number?: string }[] | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SubscriptionStatus = 'active' | 'paused' | 'disabled';

export interface Subscription {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  filters: { campaign_ids?: string[] };
  status: SubscriptionStatus;
  disabledReason: 'too_many_failures' | 'key_revoked' | null;
  consecutiveFailures: number;
  secret: string;
  lastDeliveryAt: Date | null;
  lastSuccessAt: Date | null;
  secretRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Delivery {
  id: number;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  attempt: number;
  url: string;
  responseStatus: number | null;
  succeeded: boolean;
  error: string | null;
  durationMs: number | null;
  attemptedAt: Date;
  /** Sandbox only (the panel): the start of what the receiver answered, and the delivered body. */
  responseBody: string | null;
  requestBody: string;
  /** Sandbox only: when the next attempt is due, if there is one. */
  nextAttemptAt: Date | null;
}

export interface RequestLogEntry {
  id: number;
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  operation: string | null;
  requestBody: unknown;
  responseBody: unknown;
}

/** A failure armed with `POST /_sandbox/failures` or the `X-Sandbox-*` headers. */
export interface ArmedFailure {
  id: number;
  /** `reject`: the send answers an error right away. `fail`: it is accepted and then ends `failed`. */
  mode: 'reject' | 'fail';
  code: string;
  remaining: number;
  contactId: number | null;
}

class Sequence {
  #next: number;
  constructor(readonly start: number) {
    this.#next = start;
  }
  next(): number {
    return this.#next++;
  }
  bump(atLeast: number): void {
    if (atLeast >= this.#next) this.#next = atLeast + 1;
  }
}

export class Store {
  devices = new Map<number, Device>();
  contacts = new Map<number, Contact>();
  messages = new Map<number, Message>();
  tags = new Map<number, Tag>();
  customFields = new Map<number, CustomField>();
  templates = new Map<number, Template>();
  subscriptions = new Map<string, Subscription>();
  deliveries: Delivery[] = [];
  requests: RequestLogEntry[] = [];
  failures: ArmedFailure[] = [];

  /** Last inbound message per `contactId:deviceId`: the 24-hour window. */
  lastInbound = new Map<string, Date>();
  /** API-key sends per contact since its last inbound message: the antiblock counters. */
  unanswered = new Map<number, { at: Date; hash: string }[]>();
  /** Recent API-key sends per number and per `deviceId:contactId`: the pace. */
  pace = new Map<string, number[]>();

  /** Salt of the deterministic event ids: new on every reset, so ids never repeat across sessions. */
  eventSalt = randomBytes(16).toString('hex');

  readonly ids = {
    contact: new Sequence(2001),
    message: new Sequence(9001),
    tag: new Sequence(4001),
    customField: new Sequence(5001),
    template: new Sequence(45),
    delivery: new Sequence(1),
    request: new Sequence(1),
    failure: new Sequence(1),
    note: new Sequence(1),
  };

  constructor(readonly historyLimit = 200) {}

  logRequest(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    const full = { id: this.ids.request.next(), ...entry };
    this.requests.push(full);
    if (this.requests.length > this.historyLimit) this.requests.splice(0, this.requests.length - this.historyLimit);
    return full;
  }

  addDelivery(entry: Omit<Delivery, 'id'>): Delivery {
    const full = { id: this.ids.delivery.next(), ...entry };
    this.deliveries.push(full);
    // The panel keeps the last `historyLimit` attempts of the whole sandbox; a subscription's history is a view of these.
    if (this.deliveries.length > this.historyLimit * 5) this.deliveries.splice(0, this.deliveries.length - this.historyLimit * 5);
    return full;
  }

  findContactByPhone(phone: string): Contact | undefined {
    for (const contact of this.contacts.values()) if (contact.phone === phone) return contact;
    return undefined;
  }

  contactMessages(contactId: number): Message[] {
    return [...this.messages.values()].filter((m) => m.contactId === contactId);
  }

  windowOpen(contactId: number, deviceId: number, now = new Date()): boolean {
    const last = this.lastInbound.get(`${contactId}:${deviceId}`);
    return last !== undefined && now.getTime() - last.getTime() < 24 * 60 * 60 * 1000;
  }
}

/** The example numbers, contact, tag and template every session starts with. */
export function seed(store: Store, now = new Date()): void {
  store.devices.set(3, {
    id: 3,
    alias: 'Número oficial de ejemplo',
    number: '5491100000001',
    provider: 2,
    kind: 'cloud',
    connected: true,
    wabaId: '100000000000001',
    phoneNumberId: '100000000000003',
    createdAt: now,
  });
  store.devices.set(4, {
    id: 4,
    alias: 'Número QR de ejemplo',
    number: '5491100000002',
    provider: 1,
    kind: 'qr',
    connected: true,
    wabaId: null,
    phoneNumberId: null,
    createdAt: now,
  });

  const contactId = store.ids.contact.next();
  store.contacts.set(contactId, {
    id: contactId,
    name: 'Contacto de ejemplo',
    email: 'contacto@example.com',
    phone: '5491100000000',
    whatsappId: null,
    image: null,
    notes: null,
    status: 0,
    activeConversation: false,
    favorite: false,
    unreadMessages: 0,
    manuallyUnread: false,
    deviceId: null,
    adviserId: null,
    pausedAt: null,
    tags: new Map(),
    customFields: new Map(),
    createdAt: now,
    updatedAt: now,
  });

  const tagId = store.ids.tag.next();
  store.tags.set(tagId, { id: tagId, name: 'Cliente', color: '#2E7D32', createdAt: now, updatedAt: now });

  const templateId = store.ids.template.next();
  store.templates.set(templateId, {
    id: templateId,
    uid: '1234567890',
    name: 'bienvenida',
    body: 'Hola {{1}}, gracias por escribirnos. ¿En qué te podemos ayudar?',
    header: null,
    footer: null,
    category: 'UTILITY',
    type: 'text',
    status: 'APPROVED',
    languageCode: 'es',
    deviceId: 3,
    file: null,
    params: ['Lucía'],
    buttons: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  });
}
