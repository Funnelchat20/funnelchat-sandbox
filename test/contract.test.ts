/**
 * Contract test: the sandbox against the published spec (spec/funnelchat.json, the one the developer portal
 * publishes; its sha256 is checked against spec/procedencia.json).
 *
 * Two passes over a fresh sandbox, every answer checked against that spec:
 *
 * 1. A scenario with real data for the operations with state, in the order an integration calls them (a contact with
 *    its fields and tags, a send with buttons, the conversations, a template with a variable, a subscription…).
 * 2. Every operation of the spec once, on a reset sandbox, with a request built from its schema (path, required query
 *    and body), whatever it answers.
 *
 * For each call: its status must be one the operation declares, its body must fit the schema of that status, and, when
 * the sandbox accepted the request (2xx), the query and the body must fit the operation's parameters and request body:
 * the sandbox must not take what the published spec says is invalid.
 *
 * A difference is either the published spec saying what production does not do (the sandbox follows production:
 * conversations and accounts on origin/main) or the sandbox still differing from both. Each one is in KNOWN with why;
 * any other difference fails, and so does an entry of KNOWN that no longer happens (take it out of the list).
 * `CONTRACT_REPORT=1 npx vitest run test/contract.test.ts` prints every difference with its detail.
 */
import { describe, expect, it } from 'vitest';
import { exampleFor } from '../src/openapi/example.js';
import { matchRoute } from '../src/openapi/spec.js';
import { KNOWN } from './contract/known.js';
import { mismatch, operations, parametersOf, publishedSha256, requestSchemaOf, responseOf, type PublishedOperation } from './contract/published.js';
import { startSandbox, CONTACT, GROUP, OFFICIAL, QR, TAG, TEMPLATE, type Api } from './helpers.js';
import provenance from '../spec/procedencia.json' with { type: 'json' };

type Json = Record<string, unknown>;

interface Call {
  op: PublishedOperation;
  query: Record<string, string>;
  body: unknown;
  status: number;
  response: unknown;
}

const label = (op: PublishedOperation): string => `${op.method.toUpperCase()} ${op.path}`;

/** The differences of one call with the published spec, keyed `METHOD /path …` so KNOWN can name them. */
function differences(call: Call): { key: string; detail: string }[] {
  const out: { key: string; detail: string }[] = [];
  const name = label(call.op);
  const response = responseOf(call.op, call.status);
  if (!response.declared) {
    out.push({ key: `${name} → ${call.status} no declarado`, detail: JSON.stringify(call.response)?.slice(0, 300) ?? '' });
  } else if (call.status === 204) {
    if (call.response !== null) out.push({ key: `${name} → 204 con cuerpo`, detail: JSON.stringify(call.response).slice(0, 300) });
  } else if (response.schema) {
    const problem = mismatch(response.schema, call.response);
    if (problem) out.push({ key: `${name} → ${call.status} cuerpo`, detail: problem });
  }
  if (call.status >= 200 && call.status < 300) {
    const problems: string[] = [];
    for (const param of parametersOf(call.op)) {
      if (param.in !== 'query') continue;
      const paramName = String(param.name).replace(/\[\]$/, '');
      const sent = call.query[paramName];
      if (sent === undefined) {
        if (param.required) problems.push(`query ${paramName} obligatorio y no se mandó`);
        continue;
      }
      const schema = param.schema as Json | undefined;
      if (!schema) continue;
      const problem = mismatch(schema, laravelQuery(schema, sent));
      if (problem) problems.push(`query ${paramName}=${sent}: ${problem}`);
    }
    const schema = requestSchemaOf(call.op);
    if (schema && call.body !== undefined) {
      const problem = mismatch(schema, call.body);
      if (problem) problems.push(`cuerpo: ${problem}`);
    }
    if (problems.length) out.push({ key: `${name} acepta un pedido que la spec no`, detail: `${problems.join(' | ')} · ${JSON.stringify(call.body)?.slice(0, 200)}` });
  }
  return out;
}

/** A query value as the spec types it: a number, `1`/`0` as a boolean, `a[]=x` as a list. Anything else stays a text. */
function laravelQuery(schema: Json, value: string): unknown {
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types.includes('array') && !types.includes('string')) return [laravelQuery((schema.items ?? {}) as Json, value)];
  if ((types.includes('integer') || types.includes('number')) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (types.includes('boolean') && (value === '1' || value === '0')) return value === '1';
  return value;
}

/** Calls the sandbox and keeps the call, with the operation of the published spec it is. */
async function record(api: Api, calls: Call[], method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const [path, search = ''] = url.split('?');
  const { match } = matchRoute(method, path as string);
  if (!match) throw new Error(`${method} ${path} is not an operation of the spec`);
  const op = operations.find((o) => o.method === match.op.method && o.path === match.op.path);
  if (!op) throw new Error(`${method} ${match.op.path} is not in the published spec`);
  const res = await api.call(method, url, body);
  const query = Object.fromEntries([...new URLSearchParams(search)].map(([key, value]) => [key.replace(/\[\]$/, ''), value]));
  calls.push({ op, query, body, status: res.status, response: res.body });
  return res;
}

/** The example records every session has, by the prefix of their opaque ids. */
const EXISTING: Record<string, string> = { dev: OFFICIAL, ctc: CONTACT, tag: TAG, tpl: TEMPLATE, grp: GROUP };

function pathValue(param: Json): string {
  const schema = (param.schema ?? {}) as Json;
  const prefix = typeof schema.pattern === 'string' ? /^\^([a-z]{3})_/.exec(schema.pattern)?.[1] : undefined;
  if (prefix && EXISTING[prefix]) return EXISTING[prefix];
  if (param.name === 'group' || param.name === 'groupUid') return '120363000000000000@g.us';
  return String(exampleFor(schema, String(param.name)));
}

/** A request built from the operation's schema: its path, its required query and a body that fits. */
function generated(op: PublishedOperation): { url: string; body: unknown } {
  const params = parametersOf(op);
  let path = op.path;
  for (const param of params.filter((p) => p.in === 'path')) path = path.replace(`{${String(param.name)}}`, encodeURIComponent(pathValue(param)));
  const query = new URLSearchParams();
  for (const param of params.filter((p) => p.in === 'query' && p.required)) {
    const value = exampleFor(param.schema, String(param.name));
    query.set(String(param.name), typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const schema = requestSchemaOf(op);
  const qs = query.toString();
  return { url: qs ? `${path}?${qs}` : path, body: schema ? exampleFor(schema) : undefined };
}

/** What an integration does with state, with valid data: the success answers of the operations the sandbox keeps. */
async function scenario(api: Api, calls: Call[]): Promise<void> {
  const call = (method: string, url: string, body?: unknown) => record(api, calls, method, url, body);
  await call('GET', '/api/v1/devices');
  await call('GET', `/api/v1/devices/${OFFICIAL}`);

  // A custom field, a tag, and a contact that carries both.
  const field = (await call('POST', '/api/v1/custom-fields', { name: 'Segmento', type: 0 })).body;
  await call('GET', '/api/v1/custom-fields');
  await call('GET', `/api/v1/custom-fields/${field.id}`);
  await call('PUT', `/api/v1/custom-fields/${field.id}`, { name: 'Segmento CRM' });
  const tag = (await call('POST', '/api/v1/tags', { name: 'Mayorista', color: '#1565C0' })).body;
  await call('GET', '/api/v1/tags');
  await call('GET', `/api/v1/tags/${tag.id}`);
  await call('PUT', `/api/v1/tags/${tag.id}`, { name: 'Mayoristas' });
  const created = (await call('POST', '/api/v1/contacts', { phone: '5491155550010', name: 'Ana', custom_fields: [{ id: field.id, value: 'Mayorista' }] })).body;
  await call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550011', name: 'Beto', email: 'beto@example.com', custom_fields: [{ id: field.id, value: 'Minorista' }] });
  await call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550011', name: 'Beto B.' });
  await call('GET', '/api/v1/contacts');
  await call('GET', `/api/v1/contacts/${created.id}`);
  await call('PUT', `/api/v1/contacts/${created.id}`, { name: 'Ana María' });

  await call('POST', '/api/v1/contacts/add-tags', [{ contactId: created.id, tag: { id: tag.id } }]);
  await call('GET', `/api/v1/contacts/${created.id}/tags`);
  await call('GET', `/api/v1/tags/${tag.id}/contacts`);
  await call('POST', '/api/v1/contacts/remove-tags', [{ contactId: created.id, tag: { id: tag.id } }]);
  await call('GET', `/api/v1/contacts/${created.id}/custom-fields`);
  await call('POST', '/api/v1/contacts/attach-custom-field', [{ contactId: created.id, customFieldId: field.id, value: 'VIP' }]);
  await call('POST', '/api/v1/contacts/detach-custom-field', [{ contactId: created.id, customFieldId: field.id }]);
  await call('GET', `/api/v1/contacts/${CONTACT}/meta-window?device_id=${OFFICIAL}`);

  // The contact writes; a reply, a question with buttons, the history and the conversations.
  await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: OFFICIAL, text: 'Hola' });
  const reply = (await call('POST', `/api/v1/contacts/${CONTACT}/message`, { contact_id: CONTACT, phone: '5491100000000', device_id: OFFICIAL, text: '¡Hola! ¿En qué te ayudo?' })).body;
  await call('POST', `/api/v1/contacts/${CONTACT}/message`, {
    contact_id: CONTACT,
    phone: '5491100000000',
    device_id: QR,
    text: '¿Con quién quieres hablar?',
    options: [
      { id: 'ventas', label: 'Ventas' },
      { id: 'soporte', label: 'Soporte' },
    ],
  });
  await call('POST', '/api/v1/message/send-message', { phone: '5491155550012', device_id: QR, text: 'Hola Carla' });
  await call('GET', `/api/v1/contacts/${CONTACT}/messages`);
  await call('GET', `/api/v1/contacts/${CONTACT}/messages/${reply.message.id}`);
  await call('PUT', `/api/v1/contacts/${CONTACT}/messages/${reply.message.id}/reaction`, { emoji: '👍' });
  await call('DELETE', `/api/v1/contacts/${CONTACT}/messages/${reply.message.id}/reaction`);
  await call('GET', '/api/v1/conversations');
  await call('GET', '/api/v1/conversations?activeConversation=1&perPage=10');
  await call('GET', '/api/v1/conversations/count/unread');
  await call('GET', '/api/v1/conversations/count/open');
  await call('GET', '/api/v1/conversations/count/closed');
  await call('GET', '/api/v1/conversations/count/all');
  await call('POST', '/api/v1/conversations/mark-all-read');
  await call('POST', '/api/v1/conversations/mark-all-unread');

  // A template with a variable, as production takes it; the example one, sent.
  const template = (
    await call('POST', '/api/v1/templates', {
      device_id: OFFICIAL,
      name: 'aviso_pedido_listo',
      language_code: 'es',
      category: 'UTILITY',
      type: 'text',
      body: 'Hola {{1}}, tu pedido ya está listo para retirar.',
      params: { body: { '1': '{name}' }, samples: { body: { '1': 'Lucía' } } },
    })
  ).body;
  // What the published spec allows and production refuses: a variable without params.
  await call('POST', '/api/v1/templates', { device_id: OFFICIAL, name: 'sin_params', language_code: 'es', category: 'UTILITY', type: 'text', body: 'Hola {{1}}' });
  await call('GET', '/api/v1/templates');
  await call('GET', `/api/v1/templates/${template.id}`);

  await call('POST', `/api/v1/devices/${OFFICIAL}/templates/${TEMPLATE}/send-template`, { contact_id: CONTACT, phone: '5491100000000', template_variables: { body: { '1': 'Lucía' } } });

  // A subscription.
  await call('GET', '/api/v1/webhooks/events');
  const subscription = (await call('POST', '/api/v1/webhooks', { url: 'https://tu-servidor.example/hooks', events: ['message.received'], description: 'CRM' })).body;
  await call('GET', '/api/v1/webhooks');
  await call('GET', `/api/v1/webhooks/${subscription.id}`);
  await call('PUT', `/api/v1/webhooks/${subscription.id}`, { events: ['message.received', 'message.status_changed'] });
  await call('GET', `/api/v1/webhooks/${subscription.id}/deliveries`);
  await call('DELETE', `/api/v1/webhooks/${subscription.id}`);

  // A number by QR and a sign-up link.
  const link = (await call('POST', '/api/v1/connect-links', { type: 'qr', external_reference: 'cliente-1' })).body;
  await call('GET', '/api/v1/connect-links');
  await call('GET', `/api/v1/connect-links/${link.data.id}`);
  await call('DELETE', `/api/v1/connect-links/${link.data.id}`);

  // Groups of the QR number.
  await call('GET', '/api/v1/groups');
  await call('GET', `/api/v1/groups/${GROUP}`);
  await call('GET', `/api/v1/devices/${QR}/groups`);

  // Cleaning up.
  await call('POST', '/api/v1/tags/delete', { tagIds: [tag.id] });
  await call('POST', '/api/v1/custom-fields/delete', { customFieldIds: [field.id] });
}

describe('contract with the published spec', () => {
  it('spec/funnelchat.json is the file the portal publishes', () => {
    expect(publishedSha256).toBe(provenance.snapshot.sha256);
  });

  it('every answer, and every request the sandbox takes, fits the published spec, apart from the known differences', async () => {
    const api = await startSandbox();
    const calls: Call[] = [];
    await scenario(api, calls);
    for (const op of operations) {
      await api.call('POST', '/_sandbox/reset');
      const request = generated(op);
      await record(api, calls, op.method.toUpperCase(), request.url, request.body);
    }
    // Every operation of the published spec was called at least once.
    expect(new Set(calls.map((c) => label(c.op))).size).toBe(operations.length);

    const found = new Map<string, string>();
    for (const call of calls) for (const { key, detail } of differences(call)) if (!found.has(key)) found.set(key, detail);
    if (process.env.CONTRACT_REPORT) {
      for (const [key, detail] of [...found].sort()) console.warn(`${KNOWN[key] ? 'conocida' : 'NUEVA'}  ${key}\n    ${detail}`);
    }
    const unexpected = [...found.keys()].filter((key) => !(key in KNOWN)).map((key) => `${key}: ${found.get(key)}`);
    const gone = Object.keys(KNOWN).filter((key) => !found.has(key));
    expect(unexpected, 'differences with the published spec that are not in test/contract/known.ts').toEqual([]);
    expect(gone, 'entries of test/contract/known.ts that no longer happen: take them out').toEqual([]);
  }, 60_000);
});
