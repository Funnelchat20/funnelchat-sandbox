/**
 * What happens to a message after the API accepts it: `queued` in the answer, then `sent` → `delivered` → `read`
 * with configurable delays, each change announced with `message.status_changed` (contract 1014 C1, and the
 * delta of conversations feat/envio-devuelve-id: `queued` never appears in the event, a message Funnelchat stops
 * sends one `failed` with `previous_status = null`, and `error` carries `reason`).
 */
import type { SandboxApp } from '../app.js';
import type { Message, MessageError, PublicStatus } from '../state/store.js';
import { deterministicEventId, isoSeconds, randomAlnum } from '../util.js';

const ORDER: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export interface NewMessage {
  contactId: number;
  deviceId: number | null;
  own: boolean;
  type: string;
  text?: string | null;
  file?: string | null;
  clientReference?: string | null;
  templateId?: number | null;
  viaApi: boolean;
  status: PublicStatus | null;
  createdAt?: Date;
}

export function createMessage(app: SandboxApp, input: NewMessage): Message {
  const now = input.createdAt ?? new Date();
  const message: Message = {
    id: app.store.ids.message.next(),
    contactId: input.contactId,
    deviceId: input.deviceId,
    own: input.own,
    type: input.type,
    text: input.text ?? null,
    file: input.file ?? null,
    status: input.status,
    error: null,
    clientReference: input.clientReference ?? null,
    uid: input.own ? `wamid.SANDBOX${randomAlnum(24)}` : `false_${randomAlnum(20)}`,
    viaApi: input.viaApi,
    templateId: input.templateId ?? null,
    reactions: [],
    createdAt: now,
    updatedAt: now,
  };
  app.store.messages.set(message.id, message);
  const contact = app.store.contacts.get(message.contactId);
  if (contact) {
    contact.updatedAt = now;
    if (!message.own && message.type !== 'note') {
      contact.unreadMessages++;
      contact.activeConversation = true;
    }
    if (message.own && message.type !== 'note') contact.activeConversation = true;
  }
  return message;
}

/**
 * Moves a message to a new public state and announces it. A step back (or the same state) changes nothing and
 * emits nothing, like the real API. Returns whether it changed.
 */
export function transition(app: SandboxApp, message: Message, status: 'sent' | 'delivered' | 'read' | 'failed', error?: MessageError): boolean {
  if (message.status === 'failed' || message.status === status) return false;
  if (status !== 'failed' && message.status !== null && message.status !== 'queued' && (ORDER[status] ?? 0) <= (ORDER[message.status] ?? 0)) {
    return false;
  }
  const previous = message.status === 'queued' ? null : message.status;
  const now = new Date();
  message.status = status;
  message.error = status === 'failed' ? (error ?? { code: null, title: null, reason: null }) : null;
  message.updatedAt = now;

  const data: Record<string, unknown> = {
    message_id: message.id,
    contact_id: message.contactId,
    device_id: message.deviceId,
    status,
    previous_status: previous,
  };
  if (status === 'failed') data.error = { ...message.error };
  data.occurred_at = isoSeconds(now);
  data.client_reference = message.clientReference;

  // The event id is deterministic per (message, state): a repeated emission does not mint a second one.
  const id = deterministicEventId(app.store.eventSalt, `message.status_changed|${message.id}|${status}`);
  app.webhooks.emit('message.status_changed', data, { id, occurredAt: now });
  return true;
}

/** Schedules the states of an accepted message: the normal path, or the forced failure. */
export function scheduleLifecycle(app: SandboxApp, message: Message, failure: { error: MessageError; afterSent: boolean } | null): void {
  const { sent, delivered, read } = app.config.statusDelays;
  const generation = app.generation;
  const later = (seconds: number, task: () => void) =>
    app.scheduler.after(seconds * 1000, () => {
      if (generation !== app.generation || app.store.messages.get(message.id) !== message) return;
      task();
    });

  if (failure && !failure.afterSent) {
    later(sent, () => transition(app, message, 'failed', failure.error));
    return;
  }
  later(sent, () => {
    if (!transition(app, message, 'sent')) return;
    if (delivered === null && !failure) return;
    later(delivered ?? 0, () => {
      if (failure) {
        transition(app, message, 'failed', failure.error);
        return;
      }
      if (!transition(app, message, 'delivered') || read === null) return;
      later(read, () => transition(app, message, 'read'));
    });
  });
}
