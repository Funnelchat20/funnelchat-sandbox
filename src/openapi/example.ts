/**
 * A value from a schema: the body of the routes the sandbox keeps no state for ("shape only", see `shape.ts`) and the
 * `data` of an event without an example. The schema's own `example` (or `examples`, `const`, `default`, the first
 * `enum` value) wins when it fits the schema; otherwise a plausible value of its type, within the schema's limits
 * (lengths, bounds, number of items, `pattern`). The same schema always gives the same value, and the value fits it:
 * a list of the same schema it is inside of stays empty, and `anyOf`/`oneOf` take the first branch whose value fits.
 */
import { isRecord } from '../util.js';
import { deref, type Schema } from './spec.js';
import { conforms } from './validate.js';

const EXAMPLE_DATE = '2026-10-01T12:00:00Z';
const MAX_DEPTH = 12;

/** Texts a `pattern` is tried with when the usual value does not match it. */
const PATTERN_CANDIDATES = ['ejemplo', 'Ejemplo', '5491100000000', '120363000000000000@g.us', 'AR', 'https://example.com', 'a', '1'];

function pattern(schema: Schema): RegExp | null {
  if (typeof schema.pattern !== 'string') return null;
  try {
    return new RegExp(schema.pattern, 'u');
  } catch {
    return null;
  }
}

function plainString(schema: Schema, name: string): string {
  switch (schema.format) {
    case 'date-time':
      return EXAMPLE_DATE;
    case 'date':
      return '2026-10-01';
    case 'time':
      return '12:00:00';
    case 'email':
      return 'contacto@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000001';
    default:
      break;
  }
  if (/(^|_)phone$|number$/i.test(name)) return '5491100000000';
  if (/(^|_)(created|updated|deleted|sent|date|time)(_at)?$|_at$/i.test(name)) return EXAMPLE_DATE;
  if (/email/i.test(name)) return 'contacto@example.com';
  if (/url|link/i.test(name)) return 'https://example.com';
  if (/(^|_)name$|^title$|^label$/i.test(name)) return 'Ejemplo';
  if (typeof schema.minLength === 'number' && schema.minLength > 7) return 'x'.repeat(schema.minLength);
  return 'ejemplo';
}

function stringFor(schema: Schema, name: string): string {
  let value = plainString(schema, name);
  const regex = pattern(schema);
  if (regex && !regex.test(value)) value = PATTERN_CANDIDATES.find((candidate) => regex.test(candidate)) ?? value;
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) value = value.padEnd(schema.minLength, 'x');
  return value;
}

function numberFor(schema: Schema, integer: boolean): number {
  const limit = (key: string): number | undefined => (typeof schema[key] === 'number' ? (schema[key] as number) : undefined);
  const [min, max, above, below, step] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].map(limit);
  let value = min !== undefined ? (integer ? Math.ceil(min) : min) : 1;
  if (above !== undefined && value <= above) value = integer ? Math.floor(above) + 1 : above + 1;
  if (max !== undefined && value > max) value = integer ? Math.floor(max) : max;
  if (below !== undefined && value >= below) value = integer ? Math.ceil(below) - 1 : below - 1;
  if (step !== undefined && step > 0 && value % step !== 0) value = Math.ceil(value / step) * step;
  return value;
}

/** The `$ref`s a schema is, directly or as a branch of `allOf`/`anyOf`/`oneOf`. */
function refsOf(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  if (typeof schema.$ref === 'string') return [schema.$ref];
  return (['allOf', 'anyOf', 'oneOf'] as const).flatMap((key) => (Array.isArray(schema[key]) ? (schema[key] as unknown[]).flatMap(refsOf) : []));
}

/** Whether a schema is one of those it is inside of: a tree (folders, actions with sub-actions…). */
const recursive = (schema: unknown, refs: readonly string[]): boolean => refsOf(schema).some((ref) => refs.includes(ref));

/** The value the schema declares (`example`, `examples`, `const`, `default`, `enum`), when it fits the schema. */
function declared(schema: Schema): { value: unknown } | null {
  const candidates: unknown[] = [];
  if ('example' in schema) candidates.push(schema.example);
  if (Array.isArray(schema.examples) && schema.examples.length) candidates.push(schema.examples[0]);
  for (const candidate of candidates) if (conforms(schema, candidate)) return { value: candidate };
  if ('const' in schema) return { value: schema.const };
  if ('default' in schema && schema.default !== null && conforms(schema, schema.default)) return { value: schema.default };
  if (Array.isArray(schema.enum)) {
    const value = schema.enum.find((v) => v !== null);
    if (value !== undefined) return { value };
  }
  return null;
}

function arrayFor(schema: Schema, name: string, depth: number, refs: readonly string[]): unknown[] {
  const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const max = typeof schema.maxItems === 'number' ? schema.maxItems : Infinity;
  const items = schema.items;
  const hasItems = isRecord(items) && Object.keys(items).length > 0;
  const out = Array.isArray(schema.prefixItems) ? (schema.prefixItems as unknown[]).map((part) => valueFor(part, name, depth + 1, refs)) : [];
  if (!hasItems || (out.length && out.length >= min)) return out.slice(0, max);
  // A list of what it is inside of (a folder's folders): empty, unless the schema needs items.
  if (min === 0 && recursive(items, refs)) return out;
  const wanted = Math.min(Math.max(out.length + 1, min), max);
  const item = valueFor(items, name, depth + 1, refs);
  for (let i = 0; out.length < wanted; i++) {
    if (schema.uniqueItems === true && i > 0 && typeof item === 'number') out.push(item + i);
    else if (schema.uniqueItems === true && i > 0 && typeof item === 'string') out.push(`${item}${i}`);
    else out.push(item);
  }
  return out;
}

function objectFor(schema: Schema, depth: number, refs: readonly string[]): Record<string, unknown> {
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
    // An optional property of the same schema it is inside of (a parent, a next step): left out.
    if (!required.has(key) && recursive(child, refs)) continue;
    out[key] = valueFor(child, key, depth + 1, refs);
  }
  return out;
}

function valueFor(schemaInput: unknown, name: string, depth: number, refs: readonly string[]): unknown {
  const schema = deref<Schema>(schemaInput);
  if (!isRecord(schema) || depth > MAX_DEPTH) return null;
  const inside = isRecord(schemaInput) && typeof schemaInput.$ref === 'string' ? [...refs, schemaInput.$ref] : refs;

  const own = declared(schema);
  if (own) return own.value;
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as unknown[]).map((part) => valueFor(part, name, depth + 1, inside));
    const objects = parts.filter(isRecord);
    return objects.length ? Object.assign({}, ...objects) : (parts[0] ?? null);
  }
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const isNull = (v: unknown) => deref<Schema>(v)?.type === 'null';
    // A value first, `null` after, and a branch that would start the schema over last.
    const ordered = [
      ...variants.filter((v) => !isNull(v) && !recursive(v, inside)),
      ...variants.filter(isNull),
      ...variants.filter((v) => !isNull(v) && recursive(v, inside)),
    ];
    let first: unknown;
    for (const [i, variant] of ordered.entries()) {
      const value = valueFor(variant, name, depth + 1, inside);
      if (i === 0) first = value;
      if (conforms(schema, value)) return value;
    }
    return first ?? null;
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [schema.type as string] : [];
  const type = types.find((t) => t !== 'null') ?? (schema.properties ? 'object' : schema.items || schema.prefixItems ? 'array' : types[0]);
  switch (type) {
    case 'object':
      return objectFor(schema, depth, inside);
    case 'array':
      return arrayFor(schema, name, depth, inside);
    case 'integer':
      return numberFor(schema, true);
    case 'number':
      return numberFor(schema, false);
    case 'boolean':
      return true;
    case 'string':
      return stringFor(schema, name);
    default:
      return null;
  }
}

/** A value that fits `schema`; `name` is the property it is for, which picks a plausible text (a phone, a date…). */
export function exampleFor(schema: unknown, name = ''): unknown {
  return valueFor(schema, name, 0, []);
}
