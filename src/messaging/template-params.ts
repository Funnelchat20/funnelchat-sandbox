/**
 * The `params` of a template, as conversations reads and writes them (`App\Modules\Message\Support\TemplateParams`,
 * `Rules\TemplateParamsComplete`): one canonical shape, `{"body": {"1": "{name}"}, "samples": {"body": {"1": "Lucía"}}}`,
 * a field (or a fixed text) and a sample for every `{{n}}` of the body. Creating or editing a template whose body has
 * `{{n}}` without both answers `422` on `body`, before anything reaches Meta.
 */
import type { FieldErrors } from '../openapi/validate.js';
import { isRecord } from '../util.js';

export interface TemplateParams {
  body: Record<string, string>;
  samples: { body: Record<string, string> };
}

/** `{{n}}` with n from 1: `{{10}}` is not `{{1}}`, and `{{0}}` is not a variable. */
const PLACEHOLDER = /\{\{([1-9]\d*)\}\}/g;
const PLACEHOLDER_ITEM = /^\{\{([1-9]\d*)\}\}$/;

/** The variables of a text, without repeating, in numeric order: `["1", "2", "10"]`. */
export function placeholderKeys(text: string): string[] {
  const keys = [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
  return keys.sort((a, b) => Number(a) - Number(b));
}

/** PHP's `(string)` of a scalar, `''` for anything else (`TemplateParams::stringify`). */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '';
  return '';
}

const empty = (): TemplateParams => ({ body: {}, samples: { body: {} } });

function aligned(body: Record<string, string>, samples: Record<string, string>): TemplateParams {
  return { body, samples: { body: Object.fromEntries(Object.keys(body).map((key) => [key, samples[key] ?? ''])) } };
}

function entriesOf(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, i) => [String(i), item]);
  return isRecord(value) ? Object.entries(value) : [];
}

/**
 * `TemplateParams::canonicalize()`: the canonical shape from what was sent. A list (`["{{1}}"]`, the old shape) only
 * declares the variables: a `{{n}}` item is a variable without a field, any other text is the field of its position.
 * Samples only exist for the keys of `body`.
 */
export function canonicalParams(raw: unknown): TemplateParams {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return empty();
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return empty();
    const body: Record<string, string> = {};
    value.forEach((item, i) => {
      const placeholder = typeof item === 'string' ? PLACEHOLDER_ITEM.exec(item) : null;
      if (placeholder) body[placeholder[1] as string] = '';
      else body[String(i + 1)] = stringify(item);
    });
    return aligned(body, {});
  }
  if (!isRecord(value) || Object.keys(value).length === 0) return empty();
  const body = Object.fromEntries(entriesOf(value.body).map(([key, v]) => [key, stringify(v)]));
  const samples = Object.fromEntries(entriesOf(isRecord(value.samples) ? value.samples.body : undefined).map(([key, v]) => [key, stringify(v)]));
  return aligned(body, samples);
}

/** Laravel's `blank()`: `null`, or a text that is only spaces. `"0"` is not blank. */
const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

const variables = (keys: string[]): string => keys.map((key) => `{{${key}}}`).join(', ');

/**
 * `TemplateParamsComplete` on `body` (lang/es/templates.php): every `{{n}}` of the body needs its field and its sample.
 * The two messages, in that order, under `body`.
 */
export function templateParamsErrors(bodyText: unknown, rawParams: unknown): FieldErrors {
  const text = typeof bodyText === 'string' ? bodyText : '';
  const keys = placeholderKeys(text);
  if (keys.length === 0) return {};
  const params = canonicalParams(rawParams);
  const messages: string[] = [];
  const noField = keys.filter((key) => blank(params.body[key]));
  if (noField.length) messages.push(`Falta elegir el campo de ${variables(noField)}.`);
  const noSample = keys.filter((key) => blank(params.samples.body[key]));
  if (noSample.length) messages.push(`Falta el valor de ejemplo de ${variables(noSample)}. Meta lo usa para revisar la plantilla.`);
  return messages.length ? { body: messages } : {};
}

/** `file` is `required_unless:type,text` (`StoreMessageTemplateRequest`, `UpdateMessageTemplateRequest`). */
export function templateFileErrors(type: unknown, file: unknown): FieldErrors {
  if (type === 'text') return {};
  if (typeof file === 'string' && file.trim() !== '') return {};
  return { file: ['El campo file es requerido a menos que type esté en text.'] };
}
