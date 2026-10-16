/**
 * An example value from a schema. The snapshot's operations carry no examples, so for the routes the sandbox does
 * not keep state for, the answer is built from the response schema: `example`, `const`, `default` or the first
 * `enum` value when the schema has one, and a plausible value of its type otherwise.
 */
import { isRecord } from '../util.js';
import { deref, type Schema } from './spec.js';

const EXAMPLE_DATE = '2026-10-01T12:00:00Z';

function stringFor(schema: Schema, name: string): string {
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

export function exampleFor(schemaInput: unknown, name = '', depth = 0): unknown {
  const schema = deref<Schema>(schemaInput);
  if (!schema || depth > 12) return null;
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('const' in schema) return schema.const;
  if ('default' in schema && schema.default !== null) return schema.default;
  if (Array.isArray(schema.enum)) {
    const value = schema.enum.find((v) => v !== null);
    if (value !== undefined) return value;
  }
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const value = exampleFor(part, name, depth + 1);
      if (isRecord(value)) Object.assign(merged, value);
    }
    return merged;
  }
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const pick = variants.find((v) => deref<Schema>(v)?.type !== 'null') ?? variants[0];
    return exampleFor(pick, name, depth + 1);
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [schema.type as string] : [];
  const type = types.find((t) => t !== 'null') ?? (schema.properties ? 'object' : schema.items ? 'array' : types[0]);
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
        out[key] = exampleFor(child, key, depth + 1);
      }
      return out;
    }
    case 'array':
      return schema.items && Object.keys(schema.items as object).length ? [exampleFor(schema.items, name, depth + 1)] : [];
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'string':
      return stringFor(schema, name);
    case 'null':
      return null;
    default:
      return null;
  }
}
