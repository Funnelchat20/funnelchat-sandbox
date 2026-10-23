/**
 * The in-memory state of the sandbox: one account, its two example numbers, and what a real integration touches
 * (numbers and sign-up links, contacts, conversations and messages, tags, custom fields, templates and webhook
 * subscriptions). Everything is
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

/** How a number is connected (contract A3 `device.connection`): QR, official in coexistence, or official dedicated. */
export type Connection = 'qr' | 'coexistence' | 'dedicated';

/** The aggregated health of an official number (accounts `MetaHealthStatusService`). */
export type HealthState = 'available' | 'limited' | 'blocked' | 'unknown';

export interface Device {
  id: number;
  alias: string;
  /** Digits only, without `+`. `null` while a number created by QR has not been scanned. */
  number: string | null;
  /** WhatsAppProviderEnum of accounts: 1 Z-API (QR), 2 WhatsApp Cloud (official). */
  provider: 1 | 2;
  kind: DeviceKind;
  connected: boolean;
  /** Official numbers only: it shares the number with the WhatsApp Business app. */
  coexistence: boolean;
  /** Official numbers only: it came from the pool of US numbers. */
  fromPool: boolean;
  /** Free text of the integrator, up to 255 characters, not unique. */
  externalReference: string | null;
  /** Official numbers only (`null` for QR). */
  health: HealthState | null;
  /** The sign-up link that connected it last: `connect_link_id` of every `device.*` event. */
  lastConnectLinkId: number | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  firstConnectedAt: Date | null;
  createdAt: Date;
}

export type ConnectLinkStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'revoked';

/** A sign-up link (contract A1 `connect-links`): it creates (or reconnects) a number when the page completes. */
export interface ConnectLink {
  id: number;
  type: 'meta' | 'qr';
  status: ConnectLinkStatus;
  /** sha256 of the token: the raw token is only in the `url` of the create answer. */
  tokenHash: string;
  allowedConnectionTypes: ('coexistence' | 'dedicated')[] | null;
  provisionUsNumber: boolean;
  /** Reconnects this number; otherwise `null` until the link completes, then the number it created. */
  deviceId: number | null;
  reconnect: boolean;
  /** `qr` only: adds QR to this number in coexistence. Not part of the public resource. */
  sameNumberAs: number | null;
  externalReference: string | null;
  returnUrl: string | null;
  errorCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}

/** An answer kept under an `Idempotency-Key` for 24 hours. */
export interface IdempotentAnswer {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  storedAt: Date;
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

/** One version of a WhatsApp form (conversations `whatsapp_forms`); its family is the stable form. */
export interface FormVersion {
  id: number;
  familyId: number;
  /** Unique per number; a new version is `<label>__v<n>`. */
  name: string;
  category: string;
  status: 'draft' | 'published';
  version: number;
  definition: Record<string, unknown>;
  /** The number it was created with (`primary`). */
  deviceId: number;
  /** The other numbers (`whatsapp_form_copies`). */
  copies: Map<number, { status: 'draft' | 'publishing' | 'published' | 'failed'; error: string | null }>;
  metaFlowId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormFamily {
  id: number;
  /** The published version a send uses. */
  currentVersionId: number | null;
}

/** One send of a form to a contact, and its answers (conversations `whatsapp_form_runs`). */
export interface FormRun {
  id: number;
  familyId: number;
  versionId: number;
  contactId: number;
  deviceId: number;
  messageId: number;
  status: 'pending' | 'completed';
  answers: Record<string, unknown> | null;
  sentAt: Date;
  respondedAt: Date | null;
}

export interface RequestLogEntry {
  id: number;
  at: Date;
  /** The `X-Request-Id` of the answer. */
  requestId: string;
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
  /**
   * `reject`: the send answers an error right away. `fail`: it is accepted and then ends `failed`. `edge`: the next
   * API call (any route) gets an error of the edge.
   */
  mode: 'reject' | 'fail' | 'edge';
  code: string;
  remaining: number;
  contactId: number | null;
  /** `edge` only: the call reached the domain and was applied; only the answer was lost. */
  applied?: boolean;
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
  forms = new Map<number, FormVersion>();
  formFamilies = new Map<number, FormFamily>();
  formRuns = new Map<number, FormRun>();
  connectLinks = new Map<number, ConnectLink>();
  /** When each `POST /connect-links` arrived in the last minute: the per-minute limit. */
  linkAttempts: number[] = [];
  /** Answers by `Idempotency-Key`, per resource (`devices`, `connect-links`): one account. */
  idempotency = new Map<string, IdempotentAnswer>();

  /** The number quota of the account and the switch of the Meta sign-up (`POST /_sandbox/numbers`). */
  numbers = { limit: 5, included: true, trial: false, metaConnect: true, linksPerMinute: 10 };

  /** Last inbound message per `contactId:deviceId`: the 24-hour window. */
  lastInbound = new Map<string, Date>();
  /** API-key sends per contact since its last inbound message: the antiblock counters. */
  unanswered = new Map<number, { at: Date; hash: string }[]>();
  /** Recent API-key sends per number and per `deviceId:contactId`: the pace. */
  pace = new Map<string, number[]>();

  /** The MAC state of the account (`POST /_sandbox/mac`): the 24-hour lockout, and contacts active or inactive in the cycle. */
  mac = { lockout: false, activeContacts: new Set<number>(), inactiveContacts: new Set<number>() };

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
    formFamily: new Sequence(8001),
    formVersion: new Sequence(8101),
    formRun: new Sequence(1),
    device: new Sequence(5),
    connectLink: new Sequence(1),
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
    coexistence: false,
    fromPool: false,
    externalReference: null,
    health: 'available',
    lastConnectLinkId: null,
    wabaId: '100000000000001',
    phoneNumberId: '100000000000003',
    firstConnectedAt: now,
    createdAt: now,
  });
  store.devices.set(4, {
    id: 4,
    alias: 'Número QR de ejemplo',
    number: '5491100000002',
    provider: 1,
    kind: 'qr',
    connected: true,
    coexistence: false,
    fromPool: false,
    externalReference: null,
    health: null,
    lastConnectLinkId: null,
    wabaId: null,
    phoneNumberId: null,
    firstConnectedAt: now,
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
