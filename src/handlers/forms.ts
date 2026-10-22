/**
 * WhatsApp forms (conversations v1.18.10: `routes/api/whatsapp-forms.php`, `WhatsappFormController`,
 * `WhatsappFormResource`, `FormService`, `FormSyncService`, `WhatsappFormSendController`, `FormSendAcceptance`):
 * build a form from a template, edit it, publish it, put it on more numbers, send it to a contact and read the
 * answers. Completing one is simulated with `POST /_sandbox/forms/complete`, which emits `whatsapp_form.completed`.
 *
 * A form is a family (`family_id`, the one you send) with versions (`id`, the one you edit). Only official numbers
 * (WhatsApp Cloud) take forms. What the sandbox does not do: talk to Meta (`sync` and `publish` always succeed
 * unless the linter finds an error), run the endpoint of a dynamic form, or count metrics.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, noContent, ok, type HandlerContext, type HandlerResult, type HandlerTable } from '../http/context.js';
import { ApiError, fieldError, objectNotFound } from '../http/errors.js';
import { paginate } from '../http/paginate.js';
import { FORM_TEMPLATES } from '../forms/templates.js';
import { rejection } from '../messaging/rules.js';
import { publicMessage } from '../state/resources.js';
import type { Contact, Device, FormFamily, FormRun, FormVersion, Message } from '../state/store.js';
import { iso8601, isoSeconds, isRecord, laravelJson } from '../util.js';
import { getContact } from './contacts.js';
import { clientReference, send } from './messages.js';

const INPUT_BLOCKS = ['text', 'number', 'email', 'phone', 'textarea', 'date', 'dropdown', 'radio', 'checkbox', 'optin'];

type Item = Record<string, unknown>;
type Screen = { id?: string; title?: string; next?: string; items?: Item[]; api?: { on?: boolean }; routes?: { groups?: { to?: string }[] } };

const screensOf = (definition: Record<string, unknown>): Screen[] => (Array.isArray(definition.screens) ? (definition.screens as Screen[]) : []);

/** `FormDerivations::derive`: the questions, what they save on the contact and the tags they put. */
function derive(definition: Record<string, unknown>) {
  const screens = screensOf(definition);
  const fields: Record<string, unknown>[] = [];
  const mapping: Record<string, unknown> = {};
  const tagRules: Record<string, string>[] = [];
  for (const screen of screens) {
    for (const item of screen.items ?? []) {
      if (!INPUT_BLOCKS.includes(String(item.type ?? '')) || item.name === undefined) continue;
      const name = String(item.name);
      const options = Array.isArray(item.options) ? (item.options as Item[]) : [];
      fields.push({ name, type: item.type, label: item.label ?? '', screen_id: screen.id ?? null, options: options.map((o) => ({ id: o.id ?? '', title: o.title ?? '' })) });
      const map = isRecord(item.map) ? item.map : null;
      if (map && map.target !== undefined && map.target !== null) mapping[name] = { target: map.target, key: map.key ?? null, policy: map.policy ?? 'replace' };
      for (const [value, tag] of Object.entries(isRecord(item.tagMap) ? item.tagMap : {})) {
        if (tag !== null && tag !== '') tagRules.push({ field: name, value, tag: String(tag) });
      }
    }
  }
  const first = screens[0];
  return {
    fields,
    // PHP writes an empty mapping as a list.
    mapping: Object.keys(mapping).length ? mapping : [],
    tag_rules: tagRules,
    first_screen: first?.id ?? null,
    first_screen_dynamic: Boolean(first?.api?.on) || (first?.items ?? []).some((i) => i.dyn === true),
  };
}

interface LintIssue {
  code: string;
  severity: 'error' | 'aviso';
  screenId: string | null;
  itemId: string | null;
  message: string;
}

const issue = (code: string, message: string, screenId: string | null = null, itemId: string | null = null): LintIssue => ({ code, severity: 'error', screenId, itemId, message });

/**
 * A short version of `FormLinter`: the errors that block publishing in the templates and the usual edits. The real
 * linter has many more rules (limits, routes, names, warnings).
 */
function lint(form: FormVersion): LintIssue[] {
  const issues: LintIssue[] = [];
  const screens = screensOf(form.definition);
  for (const screen of screens) if (!screen.title) issues.push(issue('screen_no_title', 'La pantalla no tiene título', screen.id ?? null));
  const ends = screens.some((s) => s.next === 'complete' || (s.routes?.groups ?? []).some((g) => g.to === 'complete'));
  if (!ends) issues.push(issue('no_ending', 'Ningún camino termina en Finalizar'));
  if (derive(form.definition).fields.length === 0) issues.push(issue('no_data', 'El formulario no recoge ningún dato'));
  const dynamic = form.definition.endpoint === true ? screens.find((s) => s.api?.on || (s.items ?? []).some((i) => i.dyn === true)) : undefined;
  if (form.definition.endpoint === true) {
    issues.push(
      issue(
        'endpoint_unavailable',
        'Este formulario necesita conectarse con el servidor y esa parte todavía no está disponible. Quitá la conexión para poder publicarlo.',
        dynamic?.id ?? null,
      ),
    );
  }
  return issues;
}

const labelOf = (form: FormVersion): string => form.name.replace(/__v\d+$/, '');

/** `WhatsappFormResource`, in its order. `list` adds the counts of the listing; `full` the stored columns. */
function formResource(app: SandboxApp, form: FormVersion, view: 'created' | 'full' | 'list'): Record<string, unknown> {
  const derived = derive(form.definition);
  const out: Record<string, unknown> = {
    id: form.id,
    family_id: form.familyId,
    name: form.name,
    label: labelOf(form),
    category: form.category,
    status: form.status,
    version: form.version,
  };
  if (view !== 'list') Object.assign(out, { definition: form.definition, fields: derived.fields, mapping: derived.mapping, tag_rules: derived.tag_rules });
  Object.assign(out, {
    has_endpoint: form.definition.endpoint === true,
    first_screen: derived.first_screen,
    first_screen_dynamic: derived.first_screen_dynamic,
    lint_errors_count: lint(form).filter((i) => i.severity === 'error').length,
  });
  if (view === 'list') {
    const draft = [...app.store.forms.values()].find((f) => f.familyId === form.familyId && f.status === 'draft' && f.id !== form.id);
    if (draft) Object.assign(out, { draft_id: draft.id, draft_version: draft.version });
    const runs = [...app.store.formRuns.values()].filter((r) => r.familyId === form.familyId);
    Object.assign(out, { sends: runs.length, responses: runs.filter((r) => r.status === 'completed').length });
  }
  out.meta_flow_id = form.metaFlowId;
  if (view === 'full') Object.assign(out, { flow_json: null, validation_errors: null });
  out.published_at = form.publishedAt ? iso8601(form.publishedAt) : null;
  out.updated_at = iso8601(form.updatedAt);
  return out;
}

function numbers(form: FormVersion): Record<string, unknown>[] {
  return [
    { device_id: form.deviceId, primary: true, status: form.status === 'published' ? 'published' : 'draft', error: null },
    ...[...form.copies.entries()].map(([deviceId, copy]) => ({ device_id: deviceId, primary: false, status: copy.status, error: copy.error })),
  ];
}

function getForm(app: SandboxApp, id: unknown): FormVersion {
  const form = app.store.forms.get(Number(id));
  if (!form) throw objectNotFound();
  return form;
}

function getFamily(app: SandboxApp, id: unknown): FormFamily {
  const family = app.store.formFamilies.get(Number(id));
  if (!family) throw objectNotFound();
  return family;
}

const versionsOf = (app: SandboxApp, familyId: number): FormVersion[] =>
  [...app.store.forms.values()].filter((f) => f.familyId === familyId).sort((a, b) => b.version - a.version);

/** `MetaCredentialsResolver`: only official numbers of the account, with their WABA. */
function eligibleNumber(app: SandboxApp, id: unknown): Device {
  const device = app.store.devices.get(Number(id));
  if (!device) throw new ApiError(422, 'NUMBER_NOT_ELIGIBLE', 'No encontramos ese número en tu cuenta');
  if (device.kind !== 'cloud') throw new ApiError(422, 'NUMBER_NOT_ELIGIBLE', 'Disponible para números conectados con la API de WhatsApp');
  return device;
}

/** `Identity::slug` + `firstFree`: the name is unique per number; a taken one gets `_2`, `_3`… */
function freeName(app: SandboxApp, base: string, deviceId: number): string {
  const taken = new Set([...app.store.forms.values()].filter((f) => f.deviceId === deviceId).map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

function intField(b: Record<string, unknown>, field: string, required: boolean): number | null {
  const value = b[field];
  if (value === undefined || value === null) {
    if (required) throw fieldError(field, `El campo ${field} es obligatorio.`);
    return null;
  }
  if (!Number.isInteger(value)) throw fieldError(field, `El campo ${field} debe ser un número entero.`);
  if ((value as number) < 1) throw fieldError(field, `El campo ${field} debe ser al menos 1.`);
  return value as number;
}

function lintFailure(issues: LintIssue[]): ApiError {
  return new ApiError(422, 'LINT', 'Corrige los pendientes antes de continuar', { lint: issues });
}

const publishedError = (form: FormVersion) =>
  new ApiError(409, 'PUBLISHED', 'Este formulario está publicado y no se puede editar. Crea una versión nueva para cambiarlo.', { form_id: form.id, version: form.version });

/** `FormSyncService::sync`: the linter, then (in the real API) the upload to Meta. */
function sync(form: FormVersion): void {
  const errors = lint(form).filter((i) => i.severity === 'error');
  if (errors.length) throw lintFailure(lint(form));
  form.metaFlowId ??= String(1_000_000_000_000_000 + form.id);
}

/** The copies of a version on other numbers publish in the background: `publishing`, then `published`. */
function publishCopies(app: SandboxApp, form: FormVersion, only?: number[]): void {
  const generation = app.generation;
  for (const [deviceId, copy] of form.copies) {
    if (only && !only.includes(deviceId)) continue;
    if (copy.status === 'published') continue;
    copy.status = 'publishing';
    copy.error = null;
    app.scheduler.after(app.config.statusDelays.sent * 1000, () => {
      if (generation === app.generation && form.copies.get(deviceId) === copy && copy.status === 'publishing') copy.status = 'published';
    });
  }
}

/** The answers of a run, for the event (`PublicFormAnswers::fromRun`): one per question, in order. */
export function publicAnswers(form: FormVersion, given: Record<string, unknown>): { key: string; label: string; value: unknown }[] {
  return derive(form.definition).fields.map((field) => {
    const name = String(field.name);
    const label = String(field.label ?? '').trim();
    const value = given[name];
    let out: unknown = null;
    if (typeof value === 'string') out = value.slice(0, 600);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out = value;
    else if (Array.isArray(value)) out = value.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).map((v) => String(v).slice(0, 600));
    return { key: name, label: label === '' ? name : label, value: out };
  });
}

/** Plausible answers for every question, when `POST /_sandbox/forms/complete` gets none. */
export function exampleAnswers(form: FormVersion): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of derive(form.definition).fields) {
    const options = (field.options as { id: string }[]) ?? [];
    const examples: Record<string, unknown> = {
      text: 'Contacto de ejemplo',
      email: 'contacto@example.com',
      phone: '5491100000000',
      number: 1,
      textarea: 'Comentario de ejemplo',
      date: '2026-10-15',
      optin: true,
      dropdown: options[0]?.id ?? null,
      radio: options[0]?.id ?? null,
      checkbox: options.slice(0, 1).map((o) => o.id),
    };
    out[String(field.name)] = examples[String(field.type)] ?? null;
  }
  return out;
}

const RUN_STATUS: Record<FormRun['status'], { key: string; label: string }> = {
  completed: { key: 'completed', label: 'Completado' },
  pending: { key: 'pending', label: 'Esperando respuesta' },
};

function runContact(app: SandboxApp, run: FormRun): Record<string, unknown> {
  const contact = app.store.contacts.get(run.contactId);
  return { id: run.contactId, name: contact?.name || `Contacto #${run.contactId}`, phone: contact?.phone ?? null };
}

/** `AnswerFormatter::formatAll`: each answer as text, options by their title. */
function formattedValues(form: FormVersion | undefined, run: FormRun): Record<string, string> {
  const out: Record<string, string> = {};
  if (!form) return out;
  for (const field of derive(form.definition).fields) {
    const value = run.answers?.[String(field.name)];
    const title = (id: unknown) => (field.options as { id: string; title: string }[]).find((o) => o.id === id)?.title ?? String(id);
    if (value === undefined || value === null || value === '') out[String(field.name)] = '';
    else if (typeof value === 'boolean') out[String(field.name)] = value ? 'Sí' : 'No';
    else if (Array.isArray(value)) out[String(field.name)] = value.map(title).join(', ');
    else out[String(field.name)] = title(value);
  }
  return out;
}

function runRow(app: SandboxApp, run: FormRun): Record<string, unknown> {
  const version = app.store.forms.get(run.versionId);
  return {
    id: run.id,
    contact: runContact(app, run),
    conversation_id: run.contactId,
    status: RUN_STATUS[run.status],
    origin: 'api',
    version: version?.version ?? null,
    partial: false,
    at: iso8601(run.respondedAt ?? run.sentAt),
    values: formattedValues(version, run),
  };
}

function runDetail(app: SandboxApp, run: FormRun): Record<string, unknown> {
  const version = app.store.forms.get(run.versionId);
  const done = run.status === 'completed';
  const answers = version ? publicAnswers(version, run.answers ?? {}) : [];
  return {
    id: run.id,
    flow_token: `ft_${run.id}`,
    contact: runContact(app, run),
    status: RUN_STATUS[run.status],
    origin: 'api',
    node_id: null,
    automation_run_id: null,
    conversation_id: run.contactId,
    version: version?.version ?? null,
    version_id: run.versionId,
    output_id: done ? 'completed' : 'not_completed',
    output_label: done ? 'Completado' : 'No completado',
    reason: null,
    reason_label: null,
    completed_after_expiry: false,
    partial: false,
    last_screen_id: null,
    sent_at: iso8601(run.sentAt),
    delivered_at: null,
    read_at: null,
    responded_at: run.respondedAt ? iso8601(run.respondedAt) : null,
    expires_at: iso8601(new Date(run.sentAt.getTime() + 24 * 60 * 60 * 1000)),
    answers: answers.map((a) => ({ name: a.key, label: a.label, value: a.value, unknown: false })),
    effects: [],
    response_json: run.answers,
  };
}

/** `FormSendAcceptance::preflight`, in its order, after the number. */
function preflight(app: SandboxApp, familyId: number, device: Device, contact: Contact): FormVersion {
  const family = app.store.formFamilies.get(familyId);
  if (!family) throw new ApiError(404, 'form_not_found', 'No se envió: el formulario no existe en tu cuenta. Revisa el identificador del formulario.');
  if (device.kind !== 'cloud') {
    throw new ApiError(
      422,
      'number_not_eligible',
      'No se envió: los formularios sólo salen por números de la API de WhatsApp de tu cuenta, con su cuenta de WhatsApp Business y su token. Revisa el número.',
    );
  }
  const current = family.currentVersionId === null ? undefined : app.store.forms.get(family.currentVersionId);
  if (!current) throw new ApiError(422, 'form_not_published', 'No se envió: el formulario no tiene ninguna versión publicada. Publícalo antes de enviarlo.');
  if (current.deviceId !== device.id && current.copies.get(device.id)?.status !== 'published') {
    throw new ApiError(422, 'form_not_on_number', 'No se envió: el formulario no está publicado en este número. Agrega el número al formulario y espera a que se publique.');
  }
  if (!contact.phone && !contact.whatsappId) throw rejection('recipient_unreachable');
  if (app.config.rules.window && !app.store.windowOpen(contact.id, device.id)) throw rejection('window_closed');
  return current;
}

/** `SendWhatsappFormRequest::EMOJI`: pictographs, regional indicators and the keycap mark. */
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{20E3}/u;

function sendForm(ctx: HandlerContext): HandlerResult {
  const { app } = ctx;
  const contact = getContact(app, ctx.path.contact);
  const b = body(ctx);
  const formId = intField(b, 'form_id', true) as number;
  intField(b, 'device_id', true);
  if (b.text !== undefined && (typeof b.text !== 'string' || b.text.length < 1 || b.text.length > 1024)) {
    throw fieldError('text', 'El campo text debe tener entre 1 y 1024 caracteres.');
  }
  if (b.button_text !== undefined) {
    if (typeof b.button_text !== 'string' || b.button_text.length < 1 || b.button_text.length > 30) throw fieldError('button_text', 'El campo button_text debe tener entre 1 y 30 caracteres.');
    if (EMOJI.test(b.button_text)) throw fieldError('button_text', 'El formato del campo button_text no es válido.');
  }
  const reference = clientReference(b);
  const device = app.store.devices.get(Number(b.device_id));
  if (!device || !device.connected) throw rejection('device_unavailable');
  const form = preflight(app, formId, device, contact);
  const text = typeof b.text === 'string' ? b.text : labelOf(form);
  const [message] = send(ctx, {
    device,
    contact,
    profile: 'free_form',
    items: [{ type: 'whatsapp_form', text, file: null, hash: `form:${form.familyId}:${text}` }],
    clientReference: reference,
    mac: true,
  });
  const run: FormRun = {
    id: app.store.ids.formRun.next(),
    familyId: form.familyId,
    versionId: form.id,
    contactId: contact.id,
    deviceId: device.id,
    messageId: (message as Message).id,
    status: 'pending',
    answers: null,
    sentAt: new Date(),
    respondedAt: null,
  };
  app.store.formRuns.set(run.id, run);
  return ok({ message: publicMessage(message as Message) });
}

/** `POST /_sandbox/forms/complete`: the contact answers; emits `whatsapp_form.completed` once per run. */
export function completeForm(app: SandboxApp, input: Record<string, unknown>): Record<string, unknown> {
  const runs = [...app.store.formRuns.values()];
  const run =
    input.run_id !== undefined
      ? app.store.formRuns.get(Number(input.run_id))
      : input.message_id !== undefined
        ? runs.find((r) => r.messageId === Number(input.message_id))
        : runs.filter((r) => r.status === 'pending' && (input.contact_id === undefined || r.contactId === Number(input.contact_id))).pop();
  if (!run) throw new ApiError(404, 'not_found', 'No hay un envío de formulario con ese run_id, message_id o contact_id. Enviá uno con POST /api/v1/contacts/{contact}/message/form.');
  const form = app.store.forms.get(run.versionId) as FormVersion;
  if (run.status === 'completed') return { run: runDetail(app, run), event: null };
  if (input.answers !== undefined && !isRecord(input.answers)) throw fieldError('answers', 'answers tiene que ser un objeto {nombre de la pregunta: valor}.');
  run.answers = { ...exampleAnswers(form), ...(isRecord(input.answers) ? input.answers : {}) };
  run.status = 'completed';
  run.respondedAt = new Date();
  const data = {
    form: { id: run.familyId, name: labelOf(form), version_id: form.id },
    message_id: run.messageId,
    contact_id: run.contactId,
    device_id: run.deviceId,
    answers: publicAnswers(form, run.answers),
    occurred_at: isoSeconds(run.respondedAt),
  };
  const result = app.webhooks.emit('whatsapp_form.completed', data, { occurredAt: run.respondedAt });
  return { run: runDetail(app, run), event: { id: result.envelope.id, type: result.envelope.type, subscriptions: result.subscriptions } };
}

export const formHandlers: HandlerTable = {
  'GET /api/v1/forms/templates': () => ok({ data: FORM_TEMPLATES.map(({ key, title, description, category }) => ({ key, title, description, category })) }),

  'GET /api/v1/forms': (ctx) => {
    const q = ctx.query;
    // One row per form: its current version, or the newest.
    const rows = [...ctx.app.store.formFamilies.values()].flatMap((family) => {
      const current = family.currentVersionId === null ? undefined : ctx.app.store.forms.get(family.currentVersionId);
      const row = current ?? versionsOf(ctx.app, family.id)[0];
      return row ? [row] : [];
    });
    const list = rows
      .filter(
        (f) =>
          (!q.q || f.name.toLowerCase().includes(String(q.q).toLowerCase())) &&
          (!q.status || f.status === q.status) &&
          (q.device_id === undefined || f.deviceId === Number(q.device_id) || f.copies.has(Number(q.device_id))),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id);
    return ok(paginate(list, { ...listContext(ctx), query: { ...q, perPage: q.per_page ?? q.perPage } }, (f) => formResource(ctx.app, f, 'list')));
  },

  'POST /api/v1/forms': (ctx) => {
    const { app } = ctx;
    const b = body(ctx);
    const primary = intField(b, 'device_id', true) as number;
    const extra = b.device_ids === undefined ? [] : b.device_ids;
    if (!Array.isArray(extra)) throw fieldError('device_ids', 'El campo device_ids debe ser una lista.');
    if (extra.length > 50) throw fieldError('device_ids', 'El campo device_ids no debe tener más de 50 elementos.');
    const template = FORM_TEMPLATES.find((t) => t.key === b.template_key);
    if (typeof b.template_key !== 'string') throw fieldError('template_key', 'El campo template_key es obligatorio.');
    if (!template) throw fieldError('template_key', 'El valor seleccionado en template_key no es válido.');
    const device = eligibleNumber(app, primary);
    const others = extra.map((id) => eligibleNumber(app, id)).filter((d) => d.id !== device.id);
    const now = new Date();
    const family: FormFamily = { id: app.store.ids.formFamily.next(), currentVersionId: null };
    const form: FormVersion = {
      id: app.store.ids.formVersion.next(),
      familyId: family.id,
      name: freeName(app, template.key, device.id),
      category: template.category,
      status: 'draft',
      version: 1,
      definition: structuredClone(template.definition),
      deviceId: device.id,
      copies: new Map(others.map((d) => [d.id, { status: 'draft' as const, error: null }])),
      metaFlowId: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    app.store.formFamilies.set(family.id, family);
    app.store.forms.set(form.id, form);
    return ok({ data: formResource(app, form, 'created'), lint: lint(form), numbers: numbers(form) }, 201);
  },

  'GET /api/v1/forms/{id}': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    return ok({
      data: formResource(ctx.app, form, 'full'),
      lint: lint(form),
      versions: versionsOf(ctx.app, form.familyId).map((v) => ({ id: v.id, version: v.version, status: v.status, published_at: v.publishedAt ? laravelJson(v.publishedAt) : null })),
      numbers: numbers(form),
    });
  },

  'PUT /api/v1/forms/{id}': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    if (form.status === 'published') throw publishedError(form);
    const b = body(ctx);
    if (!isRecord(b.definition)) throw fieldError('definition', 'El campo definition es obligatorio.');
    const screens = b.definition.screens;
    if (screens !== undefined && !Array.isArray(screens)) throw fieldError('definition.screens', 'El campo definition.screens debe ser una lista.');
    if (Array.isArray(screens) && screens.length > 20) throw fieldError('definition.screens', 'El campo definition.screens no debe tener más de 20 elementos.');
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || b.name.length > 120) throw fieldError('name', 'El campo name no debe tener más de 120 caracteres.');
      form.name = b.name;
    }
    form.definition = b.definition;
    form.updatedAt = new Date();
    return ok({ data: formResource(ctx.app, form, 'full'), lint: lint(form) });
  },

  'DELETE /api/v1/forms/{id}': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    if (form.status === 'published') throw new ApiError(409, 'PUBLISHED', 'Un formulario publicado no se elimina; se depreca.');
    ctx.app.store.forms.delete(form.id);
    if (versionsOf(ctx.app, form.familyId).length === 0) ctx.app.store.formFamilies.delete(form.familyId);
    return noContent();
  },

  'POST /api/v1/forms/{id}/versions': (ctx) => {
    const { app } = ctx;
    const base = getForm(app, ctx.path.id);
    const versions = versionsOf(app, base.familyId);
    const draft = versions.find((v) => v.status === 'draft');
    if (draft) return ok({ data: formResource(app, draft, 'full'), created: false, lint: lint(draft), numbers: numbers(draft) });
    const next = (versions[0]?.version ?? 0) + 1;
    const now = new Date();
    const form: FormVersion = {
      ...base,
      id: app.store.ids.formVersion.next(),
      name: `${labelOf(base)}__v${next}`,
      status: 'draft',
      version: next,
      definition: structuredClone(base.definition),
      copies: new Map([...base.copies.keys()].map((id) => [id, { status: 'draft' as const, error: null }])),
      metaFlowId: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    app.store.forms.set(form.id, form);
    return ok({ data: formResource(app, form, 'full'), created: true, lint: lint(form), numbers: numbers(form) }, 201);
  },

  'POST /api/v1/forms/{id}/sync': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    sync(form);
    form.updatedAt = new Date();
    return ok({ data: formResource(ctx.app, form, 'full'), lint: lint(form), numbers: numbers(form) });
  },

  'POST /api/v1/forms/{id}/publish': (ctx) => {
    const { app } = ctx;
    const form = getForm(app, ctx.path.id);
    if (form.status !== 'published') {
      sync(form);
      const now = new Date();
      form.status = 'published';
      form.publishedAt = now;
      form.updatedAt = now;
      (app.store.formFamilies.get(form.familyId) as FormFamily).currentVersionId = form.id;
      publishCopies(app, form);
    }
    return ok({ data: formResource(app, form, 'full'), lint: lint(form), numbers: numbers(form) });
  },

  'GET /api/v1/forms/{id}/numbers': (ctx) => ok({ numbers: numbers(getForm(ctx.app, ctx.path.id)) }),

  'POST /api/v1/forms/{id}/numbers': (ctx) => {
    const { app } = ctx;
    const form = getForm(app, ctx.path.id);
    const device = eligibleNumber(app, intField(body(ctx), 'device_id', true));
    if (device.id !== form.deviceId && !form.copies.has(device.id)) form.copies.set(device.id, { status: 'draft', error: null });
    if (form.status === 'published') publishCopies(app, form, [device.id]);
    return ok({ numbers: numbers(form) });
  },

  'DELETE /api/v1/forms/{id}/numbers/{deviceId}': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    const deviceId = Number(ctx.path.deviceId);
    if (deviceId === form.deviceId) throw new ApiError(422, 'PRIMARY_NUMBER', 'El número con el que se creó el formulario no se puede quitar.');
    if (!form.copies.delete(deviceId)) throw objectNotFound();
    return ok({ numbers: numbers(form) });
  },

  'POST /api/v1/forms/{id}/numbers/retry': (ctx) => {
    const form = getForm(ctx.app, ctx.path.id);
    const failed = [...form.copies.entries()].filter(([, c]) => c.status === 'failed').map(([id]) => id);
    if (form.status === 'published' && failed.length) publishCopies(ctx.app, form, failed);
    return ok({ numbers: numbers(form) });
  },

  'GET /api/v1/forms/families/{familyId}/definition': (ctx) => {
    const family = getFamily(ctx.app, ctx.path.familyId);
    const current = family.currentVersionId === null ? undefined : ctx.app.store.forms.get(family.currentVersionId);
    if (!current) return ok({ data: null });
    return ok({ data: { family_id: family.id, form_id: current.id, name: current.name, status: current.status, version: current.version, definition: current.definition } });
  },

  'GET /api/v1/forms/families/{familyId}/versions': (ctx) => {
    const family = getFamily(ctx.app, ctx.path.familyId);
    const rows = versionsOf(ctx.app, family.id).map((v) => ({
      id: v.id,
      version: v.version,
      name: v.name,
      status: v.status,
      is_current: v.id === family.currentVersionId,
      published_at: v.publishedAt ? iso8601(v.publishedAt) : null,
      deprecated_at: null,
      meta_flow_id: v.metaFlowId,
      retained_reason: null,
      responses: [...ctx.app.store.formRuns.values()].filter((r) => r.versionId === v.id && r.status === 'completed').length,
      templates: [],
    }));
    return ok(paginate(rows, listContext(ctx), (r) => r));
  },

  'GET /api/v1/forms/families/{familyId}/responses': (ctx) => {
    const family = getFamily(ctx.app, ctx.path.familyId);
    const q = ctx.query;
    const runs = [...ctx.app.store.formRuns.values()]
      .filter((r) => r.familyId === family.id && (q.version_id === undefined || r.versionId === Number(q.version_id)) && (!q.status || RUN_STATUS[r.status].key === q.status))
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id - a.id);
    const current = versionsOf(ctx.app, family.id)[0];
    const columns = current ? derive(current.definition).fields.map((f) => ({ name: f.name, label: f.label || f.name, type: f.type, retired: false })) : [];
    return ok({ ...paginate(runs, { ...listContext(ctx), query: { ...q, perPage: q.per_page ?? q.perPage } }, (r) => runRow(ctx.app, r)), columns });
  },

  'GET /api/v1/forms/families/{familyId}/responses/{runId}': (ctx) => {
    const family = getFamily(ctx.app, ctx.path.familyId);
    const run = ctx.app.store.formRuns.get(Number(ctx.path.runId));
    if (!run || run.familyId !== family.id) throw objectNotFound();
    return ok({ data: runDetail(ctx.app, run) });
  },

  'POST /api/v1/contacts/{contact}/message/form': sendForm,
};
