/**
 * Validation of path parameters, query and body against the specification, answered like Laravel's
 * validation (`errors` per field, the same Spanish messages), inside the `{error, message}` body.
 *
 * Values are first coerced the way Laravel reads them: query values arrive as text, and Laravel's
 * `integer` / `numeric` / `boolean` rules accept `"5"`, `"1.5"`, `"1"`… So a numeric text becomes a number and
 * `"1"`/`"0"` a boolean where the schema asks for that type, before Ajv checks the schema. A boolean of the query that
 * is not `1` or `0` (`true`) is refused, like Laravel's `boolean` rule does (see `LENIENT_QUERY_BOOLEANS`).
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { isRecord } from '../util.js';
import { deref, spec, type Operation, type Parameter, type Schema } from './spec.js';

// ajv-formats ships CommonJS with a default export.
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const SPEC_ID = 'urn:funnelchat:openapi';

// `verbose`: each error carries its schema and value, which the conditional rules need (see toFieldErrors).
const ajv = new Ajv2020({ strict: false, allErrors: true, verbose: true, validateFormats: true, discriminator: false, logger: false });
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

const SCHEMA_TEXT = new Set(['description', 'title', 'examples', 'example']);

/** Whether `inner` comes from inside `outer`'s schema, for the same value or a part of it. */
function inside(inner: ErrorObject, outer: ErrorObject): boolean {
  if (inner === outer || !inner.schemaPath.startsWith(`${outer.schemaPath}/`)) return false;
  return inner.instancePath === outer.instancePath || inner.instancePath.startsWith(`${outer.instancePath}/`);
}

const present = (data: unknown, name: string): boolean => isRecord(data) && data[name] !== undefined && data[name] !== null;

/**
 * The fields a branch of a union only asks to be there (Laravel's `required_without`, as Scramble writes it:
 * `{required: [phone], properties: {phone: {not: {type: null}}}}`), or `null` when the branch asks for more than that.
 */
function requiredOnly(branch: unknown): string[] | null {
  const s = deref<Schema>(branch);
  if (!s || !Array.isArray(s.required) || s.required.length === 0) return null;
  for (const [key, value] of Object.entries(s)) {
    if (key === 'required' || SCHEMA_TEXT.has(key)) continue;
    if (key !== 'properties' || !isRecord(value)) return null;
    for (const prop of Object.values(value)) {
      if (!isRecord(prop) || !Object.keys(prop).every((k) => SCHEMA_TEXT.has(k) || (k === 'not' && isRecord(prop.not) && prop.not.type === 'null'))) return null;
    }
  }
  return s.required as string[];
}

/** Whether an error says the value is of another variant of a union: a discriminator (`type: qr`) or its kind. */
function mismatch(error: ErrorObject, union: ErrorObject): boolean {
  const child = error.instancePath.startsWith(`${union.instancePath}/`) && !error.instancePath.slice(union.instancePath.length + 1).includes('/');
  if ((error.keyword === 'const' || error.keyword === 'enum') && child) return true;
  if (error.keyword === 'type' && (error.instancePath === union.instancePath || (child && (error.params as { type?: unknown }).type === 'null'))) return true;
  return false;
}

/**
 * The errors of a failed `anyOf`/`oneOf`, the way Laravel would name them. The published spec writes Laravel's
 * conditional rules as unions: a group of branches that only ask for one field each is `required_without` (each
 * missing field, «obligatorio cuando … no está presente»); any other union answers with the branch the value is
 * closest to (fewest errors, a branch whose discriminator does not match last), field by field.
 */
function unionErrors(union: ErrorObject, inner: ErrorObject[], prefix: string): FieldErrors {
  const branches = Array.isArray(union.schema) ? (union.schema as unknown[]) : [];
  const byBranch: ErrorObject[][] = branches.map(() => []);
  for (const error of inner) {
    const match = /^(\d+)\//.exec(error.schemaPath.slice(union.schemaPath.length + 1));
    if (match) byBranch[Number(match[1])]?.push(error);
  }
  const at = (field: string) => [prefix, attribute(`${union.instancePath}/${field}`)].filter(Boolean).join('.');
  const asks = branches.map(requiredOnly);
  if (asks.length > 1 && asks.every(Boolean)) {
    const out: FieldErrors = {};
    asks.forEach((fields, i) => {
      const others = asks.filter((_, j) => j !== i).flat() as string[];
      for (const field of fields as string[]) {
        if (!present(union.data, field)) (out[at(field)] ??= []).push(`El campo ${field} es obligatorio cuando ${others.join(' / ')} no está presente.`);
      }
    });
    if (Object.keys(out).length) return out;
  }
  const scored = byBranch
    .map((errors, i) => ({ i, errors, score: errors.reduce((n, e) => n + (mismatch(e, union) ? 100 : 1), 0) }))
    .filter((b) => b.errors.length > 0)
    .sort((a, b) => a.score - b.score || a.i - b.i);
  if (scored[0]) return toFieldErrors(scored[0].errors, prefix);
  // A `oneOf` that more than one branch matches: there is no field to name.
  const attr = [prefix, attribute(union.instancePath)].filter(Boolean).join('.');
  return { [attr || 'body']: [`El campo ${attr || 'cuerpo'} no es válido.`] };
}

/** The message of a `required` inside `else` / `then` of an `if` with one `const` (Laravel's `required_unless` / `_if`). */
function conditionalRequired(error: ErrorObject, ifs: ErrorObject[], name: string): string | null {
  for (const cond of ifs) {
    const base = cond.schemaPath.replace(/\/if$/, '');
    const failing = (cond.params as { failingKeyword?: string }).failingKeyword;
    if (!failing || !error.schemaPath.startsWith(`${base}/${failing}/`)) continue;
    const props = isRecord(cond.schema) && isRecord(cond.schema.properties) ? Object.entries(cond.schema.properties) : [];
    if (props.length !== 1) continue;
    const [other, rule] = props[0] as [string, unknown];
    if (!isRecord(rule) || !('const' in rule)) continue;
    const value = String(rule.const);
    return failing === 'else'
      ? `El campo ${name} es obligatorio a menos que ${other} esté en ${value}.`
      : `El campo ${name} es obligatorio cuando ${other} es ${value}.`;
  }
  return null;
}

/** Ajv errors → `{field: [messages]}`: one message per failed rule, unions and conditions as Laravel names them. */
function toFieldErrors(errors: ErrorObject[], prefix = ''): FieldErrors {
  const unions = errors.filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf');
  const outer = unions.filter((u) => !unions.some((o) => inside(u, o)));
  const ifs = errors.filter((e) => e.keyword === 'if');
  const out: FieldErrors = {};
  const add = (path: string, message: string) => {
    const attr = [prefix, attribute(path)].filter(Boolean).join('.');
    const key = attr || 'body';
    out[key] ??= [];
    if (!out[key].includes(message)) out[key].push(message);
  };
  for (const error of errors) {
    if (outer.some((u) => error === u || inside(error, u))) continue;
    if (error.keyword === 'additionalProperties' || error.keyword === 'if') continue;
    if (error.keyword === 'not') {
      // `not: {required: [a, b]}` is `prohibits` (a with b); `not: {anyOf: [{required: [a]}, …]}`, `prohibited`.
      const s = isRecord(error.schema) ? error.schema : {};
      const together = Array.isArray(s.required) ? (s.required as string[]) : null;
      const alone = Array.isArray(s.anyOf) ? (s.anyOf as unknown[]).map(requiredOnly) : null;
      if (together && together.length > 1) {
        const [first, ...rest] = together;
        add(`${error.instancePath}/${first}`, `El campo ${first} prohíbe la presencia de ${rest.join(' / ')}.`);
      } else if (together?.length === 1 || (alone && alone.every(Boolean))) {
        for (const field of (together ?? (alone as string[][]).flat())) {
          if (isRecord(error.data) && field in error.data) add(`${error.instancePath}/${field}`, `El campo ${field} está prohibido.`);
        }
      } else if (s.type === 'null') {
        const attr = [prefix, attribute(error.instancePath)].filter(Boolean).join('.');
        add(error.instancePath, `El campo ${attr || 'cuerpo'} es obligatorio.`);
      }
      continue;
    }
    let path = error.instancePath;
    if (error.keyword === 'required') path = `${path}/${(error.params as { missingProperty: string }).missingProperty}`;
    const attr = [prefix, attribute(path)].filter(Boolean).join('.');
    add(path, (error.keyword === 'required' && conditionalRequired(error, ifs, attr)) || messageFor(error, attr));
  }
  for (const union of outer) {
    for (const [field, messages] of Object.entries(unionErrors(union, errors.filter((e) => inside(e, union)), prefix))) {
      out[field] ??= [];
      for (const m of messages) if (!out[field].includes(m)) out[field].push(m);
    }
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

/**
 * Whether a value fits a schema as JSON Schema reads it, without Laravel's reading of a request (`required` refusing
 * `null`, `""` and `[]`): the check for the bodies the sandbox answers.
 */
export function conforms(schema: Schema, value: unknown): boolean {
  return compile(schema)(value);
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

/**
 * Laravel's `boolean` rule (`bool`) takes `true`, `false`, `1`, `0`, `"1"` and `"0"`: in a query, where every value is a
 * text, only `1` and `0`, so `?activeConversation=true` answers `422` in production (conversations
 * `ConversationController`). Every boolean of a query of the spec is read with that rule except these (`operationId` and
 * name), which the controller reads with `$request->boolean()` and so also take `true` and `false`.
 */
const LENIENT_QUERY_BOOLEANS = new Set(['contact.addTags bulk', 'contact.removeTags bulk']);

/** Whether a query value stays a text for Ajv to refuse: a boolean parameter that is not `1` or `0`. */
function refusedQueryBoolean(op: Operation, name: string, schema: Schema, raw: unknown): boolean {
  const types = typesOf(resolveSchema(schema));
  if (!types.includes('boolean') || types.includes('string') || typeof raw !== 'string') return false;
  if (LENIENT_QUERY_BOOLEANS.has(`${op.operationId ?? ''} ${name}`)) return false;
  return raw.trim() !== '1' && raw.trim() !== '0';
}

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
    const value = refusedQueryBoolean(op, name, param.schema, raw) ? raw : coerce(param.schema, raw);
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
