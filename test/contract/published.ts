/**
 * The published spec (spec/funnelchat.json, the one the developer portal publishes) as the contract test reads it: its
 * operations, and a validator of its schemas, apart from the merged spec the sandbox runs on (generated/openapi.json,
 * which carries the pending layers).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

type Json = Record<string, unknown>;

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const raw = readFileSync(new URL('../../spec/funnelchat.json', import.meta.url));

/** The sha256 of the file, to check it is the one spec/procedencia.json says the portal publishes. */
export const publishedSha256 = createHash('sha256').update(raw).digest('hex');

export const published = JSON.parse(raw.toString('utf8')) as { paths: Record<string, Record<string, Json>>; components: Json };

const ID = 'urn:funnelchat:published';
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, discriminator: false, logger: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
for (const format of ['binary', 'int32', 'int64', 'float', 'double', 'password', 'byte', 'phone']) {
  if (!ajv.formats[format]) ajv.addFormat(format, true);
}
ajv.addSchema({ $id: ID, components: published.components }, ID);

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function absolutize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(absolutize);
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, key === '$ref' && typeof value === 'string' && value.startsWith('#/') ? `${ID}${value}` : absolutize(value)]),
  );
}

/** Follows a local `$ref` of the published spec. */
export function deref(value: unknown): Json | undefined {
  let current = value;
  for (let i = 0; i < 20 && isRecord(current) && typeof current.$ref === 'string'; i++) {
    let target: unknown = published;
    for (const part of (current.$ref as string).slice(2).split('/')) target = isRecord(target) ? target[part] : undefined;
    current = target;
  }
  return isRecord(current) ? current : undefined;
}

const cache = new WeakMap<object, ValidateFunction>();

/** `null` when the value fits; otherwise the first errors, short. */
export function mismatch(schema: Json, value: unknown): string | null {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(absolutize(schema) as Json);
    cache.set(schema, fn);
  }
  if (fn(value)) return null;
  return (fn.errors ?? [])
    .filter((e: ErrorObject) => e.keyword !== 'anyOf' && e.keyword !== 'oneOf')
    .slice(0, 3)
    .map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`)
    .join('; ');
}

export interface PublishedOperation {
  method: string;
  path: string;
  operation: Json;
}

export const operations: PublishedOperation[] = Object.entries(published.paths).flatMap(([path, item]) =>
  ['get', 'post', 'put', 'patch', 'delete'].filter((m) => isRecord(item[m])).map((method) => ({ method, path, operation: item[method] as Json })),
);

export function parametersOf(op: PublishedOperation): Json[] {
  return ((op.operation.parameters as unknown[] | undefined) ?? []).map((p) => deref(p)).filter((p): p is Json => p !== undefined);
}

export function requestSchemaOf(op: PublishedOperation): Json | undefined {
  const body = deref(op.operation.requestBody);
  const content = body?.content as Record<string, { schema?: Json }> | undefined;
  return content?.['application/json']?.schema;
}

/** The declared response of a status (or `default`): whether there is one, and its JSON schema if it has one. */
export function responseOf(op: PublishedOperation, status: number): { declared: boolean; schema?: Json } {
  const responses = (op.operation.responses ?? {}) as Json;
  const response = deref(responses[String(status)] ?? responses.default);
  if (!response) return { declared: false };
  const content = response.content as Record<string, { schema?: Json }> | undefined;
  return { declared: true, schema: content?.['application/json']?.schema };
}
