/**
 * The event catalog, from the `webhooks` of the merged spec (the snapshot plus the pending layers). It answers
 * `GET /api/v1/webhooks/events` with the shape of accounts' unified catalog, decides which types a subscription
 * accepts, and gives the example `data` of each type for `POST /_sandbox/events/{type}`.
 */
import { exampleFor } from '../openapi/example.js';
import { spec, type Schema } from '../openapi/spec.js';
import { isRecord } from '../util.js';

export interface CatalogEntry {
  type: string;
  area: string;
  /** `active`: the real API emits it today. `planned`: you can subscribe, but the real API does not emit it yet. */
  status: 'active' | 'planned';
  is_critical: boolean;
  label: string;
  description: string;
  subscribable: boolean;
  /** Taken from a pending layer, not from the snapshot. */
  pending: boolean;
  example: { id: string; type: string; version: number; occurred_at: string; data: unknown };
}

const eventTypeOfKey = (key: string): string => key.replace(/\s*\(.*\)\s*$/, '');

const AREA_ORDER = ['accounts', 'conversations', 'communities'];

function build(): CatalogEntry[] {
  const byType = new Map<string, CatalogEntry>();
  for (const [key, item] of Object.entries(spec.webhooks ?? {})) {
    const type = eventTypeOfKey(key);
    const post = item.post;
    if (!post || byType.has(type)) continue;
    const content = post.requestBody?.content?.['application/json'];
    const rawStatus = post['x-fc-status'];
    const planned = rawStatus === 'planned' || (rawStatus === undefined && /planificad/i.test(post.summary ?? ''));
    const dataSchema = isRecord(content?.schema) ? ((content.schema as Schema).properties as Record<string, Schema> | undefined)?.data : undefined;
    const example = isRecord(content?.example)
      ? (content.example as CatalogEntry['example'])
      : { id: 'evt_000000000000000000000000', type, version: 1, occurred_at: '2026-10-01T12:00:00Z', data: exampleFor(dataSchema) ?? {} };
    const isTest = type === 'webhook.test';
    byType.set(type, {
      type,
      area: isTest ? 'accounts' : String(post['x-fc-domain'] ?? 'accounts'),
      status: planned ? 'planned' : 'active',
      is_critical: false,
      label: type,
      description: String(post.description ?? '').split('\n')[0] ?? '',
      subscribable: !isTest,
      pending: Boolean(post['x-fc-pending']),
      example,
    });
  }
  return [...byType.values()].sort(
    (a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || a.type.localeCompare(b.type),
  );
}

export const catalog: CatalogEntry[] = build();

export function catalogEntry(type: string): CatalogEntry | undefined {
  return catalog.find((entry) => entry.type === type);
}

export function isSubscribable(type: string): boolean {
  return catalogEntry(type)?.subscribable === true;
}

/** The body of `GET /api/v1/webhooks/events` (accounts `WebhookEventCatalogController`). */
export function catalogResponse(): Record<string, unknown> {
  const data = catalog.map(({ pending: _pending, ...entry }) => entry);
  return {
    data,
    meta: {
      total: data.length,
      active: data.filter((e) => e.status === 'active').length,
      envelope_version: 'v1',
      signature_header: 'X-Funnelchat-Signature',
      signature_format: 't=<unix>,v1=<hex hmac-sha256 de "<t>.<cuerpo crudo>" con el secreto del endpoint>',
    },
  };
}
