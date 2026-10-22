/**
 * The event catalog of accounts in production (spec/catalog.json, transcribed from accounts v1.4.24): it answers
 * `GET /api/v1/webhooks/events` exactly as accounts does, decides which types a subscription accepts, and gives the
 * `data` the sandbox emits by default for each type (`POST /_sandbox/events/{type}`).
 *
 * The `example` of the catalog is what accounts publishes. For two types it is not what communities emits, and the
 * sandbox emits what communities emits (communities v2.34.52 `GroupMessageReceivedEventPublisher`,
 * `GroupReactionAddedEventPublisher`): `message.uid` instead of `message.id`, and every key of the message. For the
 * planned types accounts publishes `example: null`; the sandbox takes their `data` from the spec, if it has them.
 */
import catalogFile from '../../spec/catalog.json' with { type: 'json' };
import { exampleFor } from '../openapi/example.js';
import { spec, type Schema } from '../openapi/spec.js';
import { isRecord } from '../util.js';

export interface Envelope {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  data: unknown;
}

export interface CatalogEntry {
  type: string;
  area: string;
  /** `active`: accounts accepts and delivers it. `planned`: you can subscribe, but nothing is emitted yet. */
  status: 'active' | 'planned';
  is_critical: boolean;
  label: string;
  description: string;
  subscribable: boolean;
  example: Envelope | null;
}

const GROUP = { uid: '120363000000000000@g.us', name: 'Grupo de ejemplo' };
const PARTICIPANT = { identity: '5491100000000', identity_type: 'phone', name: 'Ana Ejemplo' };

/** What communities emits where the catalog's example differs. */
const EMITTED: Record<string, Record<string, unknown>> = {
  'group.message_received': {
    group: GROUP,
    message: { uid: 'msg-ejemplo-01', type: 'text', text: 'Hola a todos', caption: null, media_url: null, mime_type: null, file_name: null, quoted_uid: null },
    participant: PARTICIPANT,
  },
  'group.reaction_added': { group: GROUP, message: { uid: 'msg-ejemplo-01' }, participant: PARTICIPANT, reaction: '👍' },
};

const eventTypeOfKey = (key: string): string => key.replace(/\s*\(.*\)\s*$/, '');

/** `data` of a type from the spec's `webhooks`, when the catalog has no example. */
function specData(type: string): unknown {
  for (const [key, item] of Object.entries(spec.webhooks ?? {})) {
    if (eventTypeOfKey(key) !== type) continue;
    const content = item.post?.requestBody?.content?.['application/json'];
    if (isRecord(content?.example) && 'data' in content.example) return content.example.data;
    const dataSchema = isRecord(content?.schema) ? ((content.schema as Schema).properties as Record<string, Schema> | undefined)?.data : undefined;
    if (dataSchema) return exampleFor(dataSchema);
  }
  return {};
}

export const catalog: CatalogEntry[] = catalogFile.entries as CatalogEntry[];

export function catalogEntry(type: string): CatalogEntry | undefined {
  return catalog.find((entry) => entry.type === type);
}

export function isSubscribable(type: string): boolean {
  return catalogEntry(type)?.subscribable === true;
}

/** The `data` the sandbox emits for a type when you send nothing: a copy, so callers may change it. */
export function emittedData(entry: CatalogEntry): unknown {
  return structuredClone(EMITTED[entry.type] ?? entry.example?.data ?? specData(entry.type));
}

/** The body of `GET /api/v1/webhooks/events` (accounts `WebhookEventCatalogController`). */
export function catalogResponse(): Record<string, unknown> {
  return {
    data: catalog,
    meta: {
      total: catalog.length,
      active: catalog.filter((e) => e.status === 'active').length,
      ...catalogFile.meta,
    },
  };
}
