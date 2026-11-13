/**
 * The event catalog (generated/catalog.json, transcribed by `npm run generate` from the spec the sandbox serves): it
 * answers `GET /api/v1/webhooks/events`, decides which types a subscription accepts (the `events` enum of
 * `POST /api/v1/webhooks`), and gives the `data` the sandbox emits by default for each type
 * (`POST /_sandbox/events/{type}`).
 *
 * The `example` of an entry is the one of the spec, with `data.workspace_id` = 37 like every example of the API; when
 * the sandbox emits, `workspace_id` is the workspace the event is routed to.
 */
import catalogFile from '../../generated/catalog.json' with { type: 'json' };
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
  /** The area that emits it: `accounts`, `conversations` or `communities`. */
  area: string;
  /** `active`: it is delivered. Every type the portal publishes is. */
  status: 'active' | 'planned';
  description: string;
  /** `false` only for `webhook.test`, which only `POST /api/v1/webhooks/{id}/test` sends. */
  subscribable: boolean;
  example: Envelope | null;
}

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
  return structuredClone(entry.example?.data ?? specData(entry.type));
}

/** The body of `GET /api/v1/webhooks/events`. */
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
