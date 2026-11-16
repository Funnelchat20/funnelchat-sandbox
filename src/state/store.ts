/**
 * The in-memory state of the sandbox: one account, its workspaces (one, the default, unless you create more), its two
 * example numbers, and what a real integration touches (numbers and sign-up links, contacts, conversations and
 * messages, groups, tags, custom fields, templates and webhook subscriptions). Everything is lost when the process
 * stops or on `POST /_sandbox/reset`.
 */
import { randomBytes } from 'node:crypto';
import { fixedId, newId, type IdPrefix } from '../util.js';

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

/**
 * A workspace of the account (accounts `workspaces`). Every API key belongs to one and only sees and creates there
 * (accounts v1.5.97, workspaces-api-keys). What has no workspace (`null`) counts as the default one's.
 */
export interface Workspace {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: Date;
}

export interface Device {
  id: string;
  /** The workspace the number is in; `null` counts as the default one. */
  workspaceId: number | null;
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
  lastConnectLinkId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  firstConnectedAt: Date | null;
  createdAt: Date;
}

export type ConnectLinkStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'revoked';

/** A sign-up link (contract A1 `connect-links`): it creates (or reconnects) a number when the page completes. */
export interface ConnectLink {
  id: string;
  /** The workspace of the key that created it: the number it creates lands there. */
  workspaceId: number | null;
  type: 'meta' | 'qr';
  status: ConnectLinkStatus;
  /** sha256 of the token: the raw token is only in the `url` of the create answer. */
  tokenHash: string;
  allowedConnectionTypes: ('coexistence' | 'dedicated')[] | null;
  provisionUsNumber: boolean;
  /** `qr` only, without `device_id`: the country of the phone (two letters, lower case), where the session opens. */
  country: string | null;
  /** Reconnects this number; otherwise `null` until the link completes, then the number it created. */
  deviceId: string | null;
  reconnect: boolean;
  /** `qr` only: adds QR to this number in coexistence. Not part of the public resource. */
  sameNumberAs: string | null;
  externalReference: string | null;
  returnUrl: string | null;
  errorCode: string | null;
  /** Failed attempts of Facebook or Meta: at the fifth the link ends `failed`. */
  failedAttempts: number;
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
  id: string;
  /** The workspace the contact is in; `null` counts as the default one. */
  workspaceId: number | null;
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
  deviceId: string | null;
  adviserId: string | null;
  pausedAt: Date | null;
  tags: Map<string, Date>;
  customFields: Map<string, { value: string; createdAt: Date; updatedAt: Date }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  contactId: string;
  deviceId: string | null;
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
  templateId: string | null;
  reactions: { emoji: string; own: boolean }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomField {
  id: string;
  name: string;
  type: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A participant of a group: the phone in digits, and whether it is an admin. */
export interface GroupParticipant {
  phone: string;
  name: string | null;
  admin: boolean;
}

/** A WhatsApp group of a number of the account (communities `groups`). */
export interface Group {
  id: string;
  /** The WhatsApp id of the group, `120363…@g.us`: the `{group}` of the routes and `group.uid` of the events. */
  uid: string;
  name: string;
  description: string;
  /** The number that is in the group (a QR number: the sandbox account has no official groups). */
  deviceId: string;
  /**
   * In the account (communities `groups`): listed by `GET /groups` and announcing who joins and leaves. `false`: a
   * group of the number on WhatsApp only, seen by `GET /devices/{device}/groups` until it is imported.
   */
  imported: boolean;
  /** The workspace the group is in; `null` counts as the default one. */
  workspaceId: number | null;
  participants: GroupParticipant[];
  link: string;
  createdAt: Date;
  updatedAt: Date;
}

/** `queued` → `running` → `completed` | `failed` (communities `ApiGroupAction::publicStatus()`). */
export type GroupActionStatus = 'queued' | 'running' | 'completed' | 'failed';

/** A group action by API (communities `api_group_actions`): here, only `send_message`. */
export interface GroupAction {
  uuid: string;
  type: 'send_message';
  status: GroupActionStatus;
  deviceId: string;
  groupId: string;
  /** The workspace of the key that called (`call_context.workspace_id`). */
  workspaceId: number;
  result: Record<string, unknown> | null;
  reason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
}

export type TemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface Template {
  id: string;
  /** The workspace it belongs to; `null` counts as the default one. */
  workspaceId: number | null;
  uid: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  category: string;
  type: string;
  status: TemplateStatus;
  languageCode: string;
  deviceId: string;
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
  /** The workspace it belongs to: it only gets that workspace's events. `null` counts as the default one. */
  workspaceId: number | null;
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
  id: string;
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
  id: string;
  familyId: string;
  /** Unique per number; a new version is `<label>__v<n>`. */
  name: string;
  category: string;
  status: 'draft' | 'published';
  version: number;
  definition: Record<string, unknown>;
  /** The number it was created with (`primary`). */
  deviceId: string;
  /** The other numbers (`whatsapp_form_copies`). */
  copies: Map<string, { status: 'draft' | 'publishing' | 'published' | 'failed'; error: string | null }>;
  metaFlowId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormFamily {
  id: string;
  /** The published version a send uses. */
  currentVersionId: string | null;
}

/** One send of a form to a contact, and its answers (conversations `whatsapp_form_runs`). */
export interface FormRun {
  id: string;
  familyId: string;
  versionId: string;
  contactId: string;
  deviceId: string;
  messageId: string;
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
  /** `shape-only` when the route has no handler and the answer was the spec's shape: nothing was stored or emitted. */
  simulated: 'shape-only' | null;
  requestBody: unknown;
  responseBody: unknown;
}

/** An event the sandbox emitted, delivered or not: the panel shows them, so a status is seen without a receiver. */
export interface EmittedEvent {
  envelope: { id: string; type: string; version: number; occurred_at: string; data: unknown };
  /** How many subscriptions got it. */
  subscriptions: number;
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
  contactId: string | null;
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

/** The source of the opaque ids of one type: `<prefix>_<23 base62 characters>`. */
class OpaqueIds {
  constructor(readonly prefix: IdPrefix) {}
  next(): string {
    return newId(this.prefix);
  }
}

/** The ids of the two example numbers: they are fixed so the docs and the first calls can name them. */
export const EXAMPLE_DEVICE = { official: fixedId('dev', 'Sandbox0Oficial'), qr: fixedId('dev', 'Sandbox0QR') } as const;

/** The ids of the other example records (contact, tag, template and the two groups): fixed, like the numbers'. */
export const EXAMPLE_ID = {
  contact: fixedId('ctc', 'Sandbox0Contacto'),
  tag: fixedId('tag', 'Sandbox0Cliente'),
  template: fixedId('tpl', 'Sandbox0Bienvenida'),
  group: fixedId('grp', 'Sandbox0Grupo'),
  liveGroup: fixedId('grp', 'Sandbox0ClientesVIP'),
} as const;

export class Store {
  workspaces = new Map<number, Workspace>();
  /**
   * The sandbox keys minted for a workspace (`POST /_sandbox/workspaces`, `/_sandbox/keys`), with their permissions
   * (`null`: every one). Any other key is the default workspace's, with every permission.
   */
  keys = new Map<string, { workspaceId: number; permissions: string[] | null }>();
  /** When each number imported a group in the last minute: communities' 5 per minute. */
  groupImports = new Map<string, number[]>();
  devices = new Map<string, Device>();
  contacts = new Map<string, Contact>();
  messages = new Map<string, Message>();
  tags = new Map<string, Tag>();
  customFields = new Map<string, CustomField>();
  templates = new Map<string, Template>();
  subscriptions = new Map<string, Subscription>();
  deliveries: Delivery[] = [];
  requests: RequestLogEntry[] = [];
  events: EmittedEvent[] = [];
  failures: ArmedFailure[] = [];
  forms = new Map<string, FormVersion>();
  formFamilies = new Map<string, FormFamily>();
  formRuns = new Map<string, FormRun>();
  connectLinks = new Map<string, ConnectLink>();
  groups = new Map<string, Group>();
  groupActions = new Map<string, GroupAction>();
  /** When each `POST /connect-links` arrived in the last minute: the per-minute limit. */
  linkAttempts: number[] = [];
  /** Answers by `Idempotency-Key`, per resource (`devices`, `connect-links`): one account. */
  idempotency = new Map<string, IdempotentAnswer>();

  /** The number quota of the account and the switch of the Meta sign-up (`POST /_sandbox/numbers`). */
  numbers = { limit: 5, included: true, trial: false, metaConnect: false, linksPerMinute: 10 };

  /** Last inbound message per `contactId:deviceId`: the 24-hour window. */
  lastInbound = new Map<string, Date>();
  /** API-key sends per contact since its last inbound message: the antiblock counters. */
  unanswered = new Map<string, { at: Date; hash: string }[]>();
  /** Recent API-key sends per number and per `deviceId:contactId`: the pace. */
  pace = new Map<string, number[]>();

  /** The MAC state of the account (`POST /_sandbox/mac`): the 24-hour lockout, and contacts active or inactive in the cycle. */
  mac = { lockout: false, activeContacts: new Set<string>(), inactiveContacts: new Set<string>() };

  /** Salt of the deterministic event ids: new on every reset, so ids never repeat across sessions. */
  eventSalt = randomBytes(16).toString('hex');

  readonly ids = {
    workspace: new Sequence(1),
    apiKey: new Sequence(101),
    contact: new OpaqueIds('ctc'),
    message: new OpaqueIds('msg'),
    tag: new OpaqueIds('tag'),
    customField: new OpaqueIds('fld'),
    template: new OpaqueIds('tpl'),
    delivery: new OpaqueIds('dlv'),
    request: new Sequence(1),
    failure: new Sequence(1),
    note: new OpaqueIds('not'),
    formFamily: new OpaqueIds('frm'),
    formVersion: new OpaqueIds('frv'),
    formRun: new OpaqueIds('frs'),
    device: new OpaqueIds('dev'),
    /** The place of a number among the ones created: its default alias and the Meta ids of an official one (the example numbers are 3 and 4). */
    deviceOrdinal: new Sequence(5),
    connectLink: new OpaqueIds('lnk'),
    group: new OpaqueIds('grp'),
    /** The number inside the `uid` of the groups the sandbox creates (`120363…@g.us`): the example groups take the first two. */
    groupUid: new Sequence(7003),
  };

  constructor(readonly historyLimit = 200) {}

  /** The default workspace of the account: where what has no workspace belongs. */
  get defaultWorkspace(): Workspace {
    for (const workspace of this.workspaces.values()) if (workspace.isDefault) return workspace;
    throw new Error('The sandbox account has no default workspace.');
  }

  logRequest(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    const full = { id: this.ids.request.next(), ...entry };
    this.requests.push(full);
    if (this.requests.length > this.historyLimit) this.requests.splice(0, this.requests.length - this.historyLimit);
    return full;
  }

  logEvent(entry: EmittedEvent): void {
    this.events.push(entry);
    if (this.events.length > this.historyLimit) this.events.splice(0, this.events.length - this.historyLimit);
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

  contactMessages(contactId: string): Message[] {
    return [...this.messages.values()].filter((m) => m.contactId === contactId);
  }

  windowOpen(contactId: string, deviceId: string, now = new Date()): boolean {
    const last = this.lastInbound.get(`${contactId}:${deviceId}`);
    return last !== undefined && now.getTime() - last.getTime() < 24 * 60 * 60 * 1000;
  }
}

/** The example numbers, contact, tag and template every session starts with. */
export function seed(store: Store, now = new Date()): void {
  const workspaceId = store.ids.workspace.next();
  store.workspaces.set(workspaceId, { id: workspaceId, name: 'Principal', isDefault: true, createdAt: now });

  store.devices.set(EXAMPLE_DEVICE.official, {
    id: EXAMPLE_DEVICE.official,
    workspaceId,
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
  store.devices.set(EXAMPLE_DEVICE.qr, {
    id: EXAMPLE_DEVICE.qr,
    workspaceId,
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

  const contactId = EXAMPLE_ID.contact;
  store.contacts.set(contactId, {
    id: contactId,
    workspaceId,
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

  const groupId = EXAMPLE_ID.group;
  store.groups.set(groupId, {
    id: groupId,
    uid: '120363000000000000@g.us',
    name: 'Grupo de ejemplo',
    description: '',
    deviceId: EXAMPLE_DEVICE.qr,
    workspaceId,
    participants: [
      { phone: '5491100000002', name: null, admin: true },
      { phone: '5491100000000', name: 'Contacto de ejemplo', admin: false },
    ],
    link: 'https://chat.whatsapp.com/SandboxEjemplo0000000000',
    imported: true,
    createdAt: now,
    updatedAt: now,
  });
  // A group number 4 is the admin of on WhatsApp but the account has not imported (followed) yet.
  const liveId = EXAMPLE_ID.liveGroup;
  store.groups.set(liveId, {
    id: liveId,
    uid: '120363000000000001@g.us',
    name: 'Clientes VIP',
    description: '',
    deviceId: EXAMPLE_DEVICE.qr,
    workspaceId,
    participants: [
      { phone: '5491100000002', name: null, admin: true },
      { phone: '5491100000000', name: 'Contacto de ejemplo', admin: false },
    ],
    link: 'https://chat.whatsapp.com/SandboxEjemplo0000000001',
    imported: false,
    createdAt: now,
    updatedAt: now,
  });

  const tagId = EXAMPLE_ID.tag;
  store.tags.set(tagId, { id: tagId, name: 'Cliente', color: '#2E7D32', createdAt: now, updatedAt: now });

  const templateId = EXAMPLE_ID.template;
  store.templates.set(templateId, {
    id: templateId,
    workspaceId,
    uid: '1234567890',
    name: 'bienvenida',
    body: 'Hola {{1}}, gracias por escribirnos. ¿En qué te podemos ayudar?',
    header: null,
    footer: null,
    category: 'UTILITY',
    type: 'text',
    status: 'APPROVED',
    languageCode: 'es',
    deviceId: EXAMPLE_DEVICE.official,
    file: null,
    params: ['Lucía'],
    buttons: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  });
}
