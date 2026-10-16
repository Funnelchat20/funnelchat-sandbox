/**
 * Validation of path parameters, query and body against the specification, answered like Laravel's
 * validation (`errors` per field, the same Spanish messages), inside the `{error, message}` body.
 *
 * Values are first coerced the way Laravel reads them: query values arrive as text, and Laravel's
 * `integer` / `numeric` / `boolean` rules accept `"5"`, `"1.5"`, `"true"`, `"1"`… So a numeric text becomes a
 * number and `"true"`/`"1"` a boolean where the schema asks for that type, before Ajv checks the schema.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { isRecord } from '../util.js';
import { deref, spec, type Operation, type Parameter, type Schema } from './spec.js';

// ajv-formats ships CommonJS with a default export.
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const SPEC_ID = 'urn:funnelchat:openapi';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, discriminator: false, logger: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
// Formats Scramble writes that ajv-formats does not know: accepted as is.
for (const format of ['binary', 'int32', 'int64', 'float', 'double', 'password', 'byte', 'phone']) {
  if (!ajv.formats[format]) ajv.addFormat(format, true);
}
ajv.addSchema({ $id: SPEC_ID, components: spec.components }, SPEC_ID);

/** Local refs (`#/components/...`) point into the spec document registered above. */
function absolutize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(absolutize);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) out[key] = `${SPEC_ID}${value}`;
    else out[key] = absolutize(value);
  }
  return out;
}

const cache = new WeakMap<object, ValidateFunction>();

function compile(schema: Schema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(absolutize(schema) as Schema);
    cache.set(schema, fn);
  }
  return fn;
}

function typesOf(schema: Schema | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.type)) return schema.type as string[];
  if (typeof schema.type === 'string') return [schema.type];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

function mergeAllOf(schema: Schema): Schema {
  const parts = (schema.allOf as Schema[] | undefined)?.map((s) => resolveSchema(s) ?? {}) ?? [];
  const properties: Record<string, Schema> = { ...(schema.properties as Record<string, Schema> | undefined) };
  for (const part of parts) Object.assign(properties, (part.properties as Record<string, Schema> | undefined) ?? {});
  return { ...schema, type: schema.type ?? (Object.keys(properties).length ? 'object' : undefined), properties };
}

function resolveSchema(schema: unknown): Schema | undefined {
  const s = deref<Schema>(schema);
  if (!s) return undefined;
  return Array.isArray(s.allOf) ? mergeAllOf(s) : s;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Coerces `value` towards `schema` like Laravel reads input. Never turns `null` into something else and never
 * drops data: what cannot be coerced is left for Ajv to report.
 */
export function coerce(schemaInput: unknown, value: unknown, depth = 0): unknown {
  const schema = resolveSchema(schemaInput);
  if (!schema || depth > 30 || value === null || value === undefined) return value;
  const variants = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      const coerced = coerce(variant, value, depth + 1);
      if (compile(variant)(coerced)) return coerced;
    }
    return value;
  }
  const types = typesOf(schema);
  if (types.length === 0) return value;
  if (typeof value === 'string') {
    if ((types.includes('integer') || types.includes('number')) && !types.includes('string') && NUMERIC.test(value.trim())) {
      return Number(value.trim());
    }
    if (types.includes('boolean') && !types.includes('string')) {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
    if (types.includes('array') && !types.includes('string')) return [coerce(schema.items, value, depth + 1)];
    return value;
  }
  if (typeof value === 'number' && types.includes('boolean') && !types.includes('number') && !types.includes('integer')) {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (Array.isArray(value) && types.includes('array')) return value.map((item) => coerce(schema.items, item, depth + 1));
  if (isRecord(value) && types.includes('array') && !types.includes('object')) {
    // `a[0]=x&a[1]=y` arrives as {"0": "x", "1": "y"}.
    const keys = Object.keys(value);
    if (keys.every((k) => /^\d+$/.test(k))) return keys.sort((a, b) => Number(a) - Number(b)).map((k) => coerce(schema.items, value[k], depth + 1));
  }
  if (isRecord(value) && types.includes('object')) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = key in props ? coerce(props[key], child, depth + 1) : child;
    return out;
  }
  return value;
}

export type FieldErrors = Record<string, string[]>;

function attribute(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '.').replace(/~1/g, '/').replace(/~0/g, '~');
}

function limitOf(error: ErrorObject): unknown {
  const p = error.params as Record<string, unknown>;
  return p.limit ?? p.comparison;
}

/** The Spanish message Laravel would show for one failed rule. */
function messageFor(error: ErrorObject, attr: string): string {
  const name = attr || 'cuerpo';
  const limit = limitOf(error);
  switch (error.keyword) {
    case 'required':
      return `El campo ${name} es obligatorio.`;
    case 'type': {
      const type = String((error.params as { type?: unknown }).type ?? '');
      if (type.includes('integer')) return `El campo ${name} debe ser un número entero.`;
      if (type.includes('number')) return `El campo ${name} debe ser un número.`;
      if (type.includes('boolean')) return `El campo ${name} debe tener un valor verdadero o falso.`;
      if (type.includes('array')) return `El campo ${name} debe ser una lista.`;
      if (type.includes('object')) return `El campo ${name} debe ser un objeto.`;
      return `El campo ${name} debe ser una cadena de caracteres.`;
    }
    case 'enum':
    case 'const':
      return `El valor seleccionado en ${name} no es válido.`;
    case 'maxLength':
      return `El campo ${name} no debe tener más de ${limit} caracteres.`;
    case 'minLength':
      return Number(limit) <= 1 ? `El campo ${name} es obligatorio.` : `El campo ${name} debe tener al menos ${limit} caracteres.`;
    case 'maxItems':
      return `El campo ${name} no debe tener más de ${limit} elementos.`;
    case 'minItems':
      return `El campo ${name} debe tener al menos ${limit} elementos.`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `El campo ${name} debe ser al menos ${limit}.`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `El campo ${name} no debe ser mayor que ${limit}.`;
    case 'uniqueItems':
      return `El campo ${name} tiene valores duplicados.`;
    case 'pattern':
      return `El formato del campo ${name} no es válido.`;
    case 'format': {
      const format = String((error.params as { format?: unknown }).format ?? '');
      if (format === 'email') return `El campo ${name} debe ser una dirección de correo válida.`;
      if (format === 'uri' || format === 'url') return `El campo ${name} debe ser una URL válida.`;
      if (format === 'uuid') return `El campo ${name} debe ser un UUID válido.`;
      if (format.startsWith('date') || format === 'time') return `El campo ${name} no es una fecha válida.`;
      return `El formato del campo ${name} no es válido.`;
    }
    default:
      return `El campo ${name} no es válido.`;
  }
}

/** Ajv errors → `{field: [messages]}`, without the noise of the branches of an `anyOf`. */
function toFieldErrors(errors: ErrorObject[], prefix = ''): FieldErrors {
  const unions = errors.filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf').map((e) => e.schemaPath);
  const out: FieldErrors = {};
  for (const error of errors) {
    if (error.keyword === 'additionalProperties' || error.keyword === 'if' || error.keyword === 'not') continue;
    if (unions.some((u) => error.schemaPath !== u && error.schemaPath.startsWith(`${u}/`))) continue;
    let path = error.instancePath;
    if (error.keyword === 'required') path = `${path}/${(error.params as { missingProperty: string }).missingProperty}`;
    const attr = [prefix, attribute(path)].filter(Boolean).join('.');
    const message = messageFor(error, attr);
    const key = attr || 'body';
    out[key] ??= [];
    if (!out[key].includes(message)) out[key].push(message);
  }
  return out;
}

/**
 * Laravel's `required` also fails for `null`, `""` and `[]` when the schema does not allow them. Ajv only checks
 * presence, so this adds those cases for the top-level properties of an object body.
 */
function emptyRequired(schemaInput: unknown, value: unknown): FieldErrors {
  const schema = resolveSchema(schemaInput);
  const out: FieldErrors = {};
  if (!schema || !isRecord(value)) return out;
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  for (const name of (schema.required as string[] | undefined) ?? []) {
    const v = value[name];
    const types = typesOf(resolveSchema(props[name]));
    const empty = (v === null && !types.includes('null')) || v === '' || (Array.isArray(v) && v.length === 0);
    if (name in value && empty) out[name] = [`El campo ${name} es obligatorio.`];
  }
  return out;
}

function mergeErrors(...all: FieldErrors[]): FieldErrors {
  const out: FieldErrors = {};
  for (const errors of all) {
    for (const [field, messages] of Object.entries(errors)) {
      out[field] ??= [];
      for (const m of messages) if (!out[field].includes(m)) out[field].push(m);
    }
  }
  return out;
}

/** Validates a value against a schema; returns the field errors (empty when valid). */
export function validateValue(schema: Schema, value: unknown, prefix = ''): FieldErrors {
  const fn = compile(schema);
  const errors = fn(value) ? {} : toFieldErrors(fn.errors ?? [], prefix);
  return mergeErrors(errors, prefix ? {} : emptyRequired(schema, value));
}

export interface ValidatedRequest {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

export type ValidationOutcome =
  | { ok: true; value: ValidatedRequest }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'invalid'; errors: FieldErrors };

const queryValue = (query: Record<string, unknown>, param: Parameter): unknown => {
  const name = param.name.endsWith('[]') ? param.name.slice(0, -2) : param.name;
  return query[name] ?? query[param.name];
};

/**
 * Validates a request against its operation. A path parameter that does not fit its schema answers `404`, the way
 * a Laravel model binding does; the query and the body answer `422` with the errors per field.
 */
export function validateRequest(
  op: Operation,
  pathParams: Record<string, string>,
  query: Record<string, unknown>,
  body: unknown,
  bodySchema: Schema | undefined,
): ValidationOutcome {
  const params = op.parameters ?? [];
  const path: Record<string, unknown> = { ...pathParams };
  for (const param of params.filter((p) => p.in === 'path')) {
    if (!param.schema || !(param.name in pathParams)) continue;
    const value = coerce(param.schema, pathParams[param.name]);
    if (!compile(param.schema)(value)) return { ok: false, kind: 'not_found' };
    path[param.name] = value;
  }

  let errors: FieldErrors = {};
  const coercedQuery: Record<string, unknown> = { ...query };
  for (const param of params.filter((p) => p.in === 'query')) {
    const name = param.name.endsWith('[]') ? param.name.slice(0, -2) : param.name;
    const raw = queryValue(query, param);
    if (raw === undefined || raw === '') {
      if (param.required) errors = mergeErrors(errors, { [name]: [`El campo ${name} es obligatorio.`] });
      continue;
    }
    // Filters that Laravel reads as nested objects (`tag_filters[0][mode]=all`) are not checked here.
    if (!param.schema || param['x-deepObject-style']) continue;
    const value = coerce(param.schema, raw);
    coercedQuery[name] = value;
    errors = mergeErrors(errors, validateValue(param.schema, value, name));
  }

  let coercedBody = body;
  if (bodySchema) {
    const required = op.requestBody?.required === true;
    if (body === undefined) {
      if (required) {
        const schema = resolveSchema(bodySchema);
        const names = (schema?.required as string[] | undefined) ?? [];
        errors = mergeErrors(
          errors,
          names.length ? Object.fromEntries(names.map((n) => [n, [`El campo ${n} es obligatorio.`]])) : { body: ['El cuerpo es obligatorio.'] },
        );
      }
    } else {
      coercedBody = coerce(bodySchema, body);
      errors = mergeErrors(errors, validateValue(bodySchema, coercedBody));
    }
  }

  if (Object.keys(errors).length) return { ok: false, kind: 'invalid', errors };
  return { ok: true, value: { path, query: coercedQuery, body: coercedBody } };
}

/** Laravel's summary: the first message, plus «(y N errores más)». */
export function summarize(errors: FieldErrors): string {
  const messages = Object.values(errors).flat();
  const first = messages[0] ?? 'Los datos enviados no son válidos.';
  const rest = messages.length - 1;
  if (rest <= 0) return first;
  return `${first} (y ${rest} ${rest === 1 ? 'error más' : 'errores más'})`;
}
