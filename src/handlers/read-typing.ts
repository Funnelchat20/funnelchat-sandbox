/**
 * Mark as read and «typing…» (conversations v1.19.7 `MarkMessageReadController`, `TypingIndicatorController`,
 * `ReadTypingService`): neither sends a message. They answer `204`, or a `422` with `error` and the API's message.
 *
 * - Read: only a message the contact sent (`message_not_inbound`), with its id in WhatsApp (`message_not_markable`:
 *   on an official number, a `wamid.`), of the last 30 days (`message_expired`). The conversation is read, except
 *   for the messages that arrived after it. QR and official numbers can.
 * - Typing: only official numbers (`provider_unsupported`), over the last message the contact sent through that
 *   number (`device_id`, or the number of its last message) in the last 24 hours (`no_recent_inbound`).
 *
 * The per-second ceilings (`429 rate_limited`) and the provider's refusals (`502 provider_error`) are not imitated.
 */
import { body, type HandlerContext, type HandlerTable } from '../http/context.js';
import { ApiError, objectNotFound } from '../http/errors.js';
import { contactIsIndividual } from '../messaging/rules.js';
import type { Contact, Device } from '../state/store.js';
import { sees } from '../state/workspaces.js';
import { getContact } from './contacts.js';

const READ: Record<string, string> = {
  recipient_unsupported:
    'No se marcó como leído: el contacto es un grupo, una lista de difusión o un canal. Por la API solo se marcan como leídos mensajes de personas individuales.',
  message_not_inbound: 'No se marcó como leído: ese mensaje no lo envió el contacto. Solo se pueden marcar como leídos los mensajes recibidos.',
  message_not_markable:
    'No se marcó como leído: no se conoce el identificador de este mensaje en WhatsApp o el número que lo recibió ya no está en tu cuenta (por ejemplo, llegó por la aplicación del celular de un número en coexistencia).',
  message_expired: 'No se marcó como leído: WhatsApp solo permite marcar como leídos los mensajes recibidos en los últimos 30 días.',
};

const TYPING: Record<string, string> = {
  recipient_unsupported:
    'No se mostró «escribiendo…»: el contacto es un grupo, una lista de difusión o un canal. Por la API solo se muestra en conversaciones con personas individuales.',
  provider_unsupported:
    'Los números conectados por código QR no permiten mostrar «escribiendo…» por la API. Solo los números de WhatsApp Cloud (API oficial) lo permiten.',
  no_recent_inbound:
    'No se mostró «escribiendo…»: el contacto no te escribió por este número en las últimas 24 horas. Funnelchat solo lo muestra sobre un mensaje que el contacto te mandó en ese plazo.',
};

const DAY = 24 * 60 * 60 * 1000;

/** A number of the account the key reaches; `ReadTypingAccess::notFound()` otherwise. */
function reachableDevice(ctx: HandlerContext, id: number | null): Device | undefined {
  const device = id === null ? undefined : ctx.app.store.devices.get(id);
  if (device && !sees(ctx.workspace, device.workspaceId)) throw objectNotFound();
  return device;
}

const inbound = (ctx: HandlerContext, contact: Contact) =>
  [...ctx.app.store.messages.values()].filter((m) => m.contactId === contact.id && !m.own).sort((a, b) => b.id - a.id);

export const readTypingHandlers: HandlerTable = {
  'POST /api/v1/contacts/{contact}/messages/{message}/read': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const message = ctx.app.store.messages.get(Number(ctx.path.message));
    if (!message || message.contactId !== contact.id) throw objectNotFound();
    const refuse = (code: string) => new ApiError(422, code, READ[code] as string);
    if (!contactIsIndividual(contact)) throw refuse('recipient_unsupported');
    if (message.own) throw refuse('message_not_inbound');
    const device = reachableDevice(ctx, message.deviceId);
    if (!device || !message.uid || (device.kind === 'cloud' && !message.uid.startsWith('wamid.'))) throw refuse('message_not_markable');
    if (Date.now() - message.createdAt.getTime() > 30 * DAY) throw refuse('message_expired');
    // The conversation is read, except for the messages that arrived after this one.
    const newer = inbound(ctx, contact).filter((m) => m.id > message.id).length;
    if (newer === 0) {
      contact.unreadMessages = 0;
      contact.manuallyUnread = false;
    } else contact.unreadMessages = Math.min(contact.unreadMessages, newer);
    return { status: 204 };
  },

  'POST /api/v1/contacts/{contact}/typing': (ctx) => {
    const contact = getContact(ctx.app, ctx.path.contact, ctx.workspace);
    const b = body(ctx);
    const refuse = (code: string) => new ApiError(422, code, TYPING[code] as string);
    let device: Device | undefined;
    if (b.device_id !== undefined && b.device_id !== null) {
      device = reachableDevice(ctx, Number(b.device_id));
      if (!device) throw objectNotFound();
    }
    if (!contactIsIndividual(contact)) throw refuse('recipient_unsupported');
    const messages = inbound(ctx, contact);
    if (!device) {
      device = reachableDevice(ctx, messages[0]?.deviceId ?? null);
      if (!device) throw refuse('no_recent_inbound');
    }
    if (device.kind !== 'cloud') throw refuse('provider_unsupported');
    const target = messages.find((m) => m.deviceId === device.id && m.uid.startsWith('wamid.') && Date.now() - m.createdAt.getTime() < DAY);
    if (!target) throw refuse('no_recent_inbound');
    return { status: 204 };
  },
};
