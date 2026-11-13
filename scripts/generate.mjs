#!/usr/bin/env node
/**
 * The single generation script of the sandbox (`npm run generate`).
 *
 *   node scripts/generate.mjs                    merge spec/* into generated/openapi.json
 *   node scripts/generate.mjs --spec <file>      copy a new unified spec of the portal into spec/funnelchat.json,
 *                                                record where it came from, then merge
 *   node scripts/generate.mjs --pending <file>   copy a new pending layer of funnelchat-node (its spec/pending.json)
 *                                                into spec/pending.json, record where it came from, then merge
 *   node scripts/generate.mjs --check            generate in memory and fail if anything in generated/ differs
 *
 * Steps:
 *   1. (with --spec / --pending) copy the file and write its entry in spec/procedencia.json
 *      (repository, branch, commit, sha256).
 *   2. Merge, in this order, over a copy of the snapshot:
 *        - spec/pending.json          the "pending of the spec" layer of the Node SDK;
 *        - spec/pending-sandbox.json  what the sandbox corrects on top of it (extra event fields, `null` in the
 *                                     conditional fields of the sign-up links).
 *      A layer only corrects shapes: the snapshot is the spec the portal publishes, and the tools offer only what it
 *      publishes, so an operation or an event a layer would add is refused and listed. Every other pending entry is
 *      applied only while the snapshot lacks it; the report lists the entries a new snapshot made obsolete so they
 *      can be deleted.
 *   3. Write generated/openapi.json: the merged spec the server validates and answers with.
 *   4. Write generated/catalog.json: the event catalog (`GET /api/v1/webhooks/events`), transcribed from the merged
 *      spec (see buildCatalog).
 *   Both outputs are deterministic (no dates), so --check works in CI.
 *
 * Nothing in generated/ is edited by hand.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_FILE = resolve(ROOT, 'spec/funnelchat.json');
const PENDING_FILE = resolve(ROOT, 'spec/pending.json');
const SANDBOX_PENDING_FILE = resolve(ROOT, 'spec/pending-sandbox.json');
const PROVENANCE_FILE = resolve(ROOT, 'spec/procedencia.json');
const OUT_FILE = resolve(ROOT, 'generated/openapi.json');
const CATALOG_FILE = resolve(ROOT, 'generated/catalog.json');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function parseArgs(argv) {
  const args = { spec: null, pending: null, origin: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--spec') args.spec = argv[++i];
    else if (arg.startsWith('--spec=')) args.spec = arg.slice('--spec='.length);
    else if (arg === '--origin') args.origin = argv[++i];
    else if (arg.startsWith('--origin=')) args.origin = arg.slice('--origin='.length);
    else if (arg === '--pending') args.pending = argv[++i];
    else if (arg.startsWith('--pending=')) args.pending = arg.slice('--pending='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.spec === undefined) throw new Error('--spec needs the path of the file');
  if (args.pending === undefined) throw new Error('--pending needs the path of the file');
  if (args.check && (args.spec || args.pending)) throw new Error('--check does not combine with --spec or --pending');
  if (args.origin && !args.spec) throw new Error('--origin goes with --spec');
  return args;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function countOperations(spec) {
  let n = 0;
  for (const item of Object.values(spec.paths ?? {})) for (const m of HTTP_METHODS) if (item[m]) n++;
  return n;
}

function readProvenance() {
  return existsSync(PROVENANCE_FILE) ? JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8')) : {};
}

function writeProvenance(provenance) {
  const ordered = {
    description:
      'Where each file of spec/ came from. Written by `npm run generate -- --spec <file>` or `-- --pending <file>`; do not edit it by hand. spec/pending-sandbox.json belongs to this repo: its sources are inside it.',
    snapshot: provenance.snapshot ?? null,
    pending: provenance.pending ?? null,
  };
  writeFileSync(PROVENANCE_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Where a file comes from, read from the git checkout that contains it. */
function gitSource(sourcePath) {
  const dir = dirname(sourcePath);
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const relPath = top ? relative(top, sourcePath) : null;
  const tracked = top ? git(top, 'ls-files', '--error-unmatch', relPath) !== null : null;
  const dirty = top ? git(top, 'status', '--porcelain', '--untracked-files=no') : null;
  return {
    repository: top ? git(top, 'remote', 'get-url', 'origin') : null,
    path: relPath,
    branch: top ? git(top, 'branch', '--show-current') : null,
    commit: top ? git(top, 'rev-parse', 'HEAD') : null,
    commit_date: top ? git(top, 'log', '-1', '--format=%cI') : null,
    file_tracked_in_git: tracked,
    tracked_files_clean: dirty === null ? null : dirty === '',
    file_modified_at: statSync(sourcePath).mtime.toISOString(),
  };
}

/**
 * `--origin <file>`: where a spec comes from when it is a build artifact outside a git checkout (for example the
 * portal's `generated/specs/funnelchat-completa.json`): `{repository, branch, commit, commit_date, path,
 * file_tracked_in_git, domains: [{domain, tag, sha}]}`. It fills what git cannot say; git wins where it can.
 */
function readOrigin(originPath) {
  if (!originPath) return { source: {}, domains: [] };
  const origin = JSON.parse(readFileSync(resolve(originPath), 'utf8'));
  const { domains = [], ...source } = origin;
  return { source, domains };
}

/** Step 1a: copy a new snapshot of the portal and record its provenance. */
function importSpec(source, originPath) {
  const sourcePath = resolve(source);
  const bytes = readFileSync(sourcePath);
  const spec = JSON.parse(bytes.toString('utf8'));
  const origin = readOrigin(originPath);
  const fromGit = gitSource(sourcePath);
  const merged = {
    ...Object.fromEntries(Object.entries(fromGit).map(([key, value]) => [key, value ?? origin.source[key] ?? null])),
    ...Object.fromEntries(Object.entries(origin.source).filter(([key]) => !(key in fromGit))),
  };
  const provenance = readProvenance();
  provenance.snapshot = {
    file: 'spec/funnelchat.json',
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: merged,
    imported_at: new Date().toISOString(),
    spec: {
      openapi: spec.openapi ?? null,
      title: spec.info?.title ?? null,
      version: spec.info?.version ?? null,
      paths: Object.keys(spec.paths ?? {}).length,
      operations: countOperations(spec),
      webhooks: Object.keys(spec.webhooks ?? {}).length,
      domains: (spec['x-fc-sources'] ?? []).map((s) => {
        const known = origin.domains.find((d) => d.domain === s.domain) ?? {};
        return { domain: s.domain, tag: s.tag ?? known.tag ?? null, sha: s.sha ?? known.sha ?? null, branch: s.branch ?? known.branch ?? null, snapshot_at: s.snapshot_at ?? known.snapshot_at ?? null };
      }),
    },
  };
  mkdirSync(dirname(SPEC_FILE), { recursive: true });
  writeFileSync(SPEC_FILE, bytes);
  writeProvenance(provenance);
  const src = provenance.snapshot.source;
  console.log(`spec: copied from ${src.path ?? sourcePath} (${src.branch ?? '?'} @ ${src.commit?.slice(0, 7) ?? '?'})`);
}

/** Step 1b: copy a new pending layer of funnelchat-node and record its provenance. */
function importPending(source) {
  const sourcePath = resolve(source);
  const bytes = readFileSync(sourcePath);
  JSON.parse(bytes.toString('utf8'));
  const provenance = readProvenance();
  provenance.pending = {
    file: 'spec/pending.json',
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: gitSource(sourcePath),
    imported_at: new Date().toISOString(),
    note: 'The pending layer of the Node SDK, unchanged. What belongs to the sandbox goes in spec/pending-sandbox.json.',
  };
  writeFileSync(PENDING_FILE, bytes);
  writeProvenance(provenance);
  const src = provenance.pending.source;
  console.log(`pending: copied from ${src.path ?? sourcePath} (${src.branch ?? '?'} @ ${src.commit?.slice(0, 7) ?? '?'})`);
}

/**
 * Whether `target` matches every entry of `condition`, as funnelchat-node's generator reads it: a key is a property
 * of `target`, or, when it starts with `/`, a JSON Pointer into it (RFC 6901), so an entry can wait for one exact
 * place of the snapshot to change.
 */
function matches(target, condition) {
  if (!condition) return true;
  return Object.entries(condition).every(([key, value]) => JSON.stringify(pointer(target, key)) === JSON.stringify(value));
}

function pointer(target, key) {
  if (!key.startsWith('/')) return target?.[key];
  return key
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, part) => node?.[part], target);
}

/** The event type a `webhooks` key stands for: "webhook.test (conversations)" -> "webhook.test". */
const eventTypeOfKey = (key) => key.replace(/\s*\(.*\)\s*$/, '');

function requestSchema(merged, op) {
  let schema = op.requestBody?.content?.['application/json']?.schema;
  if (schema?.$ref) schema = merged.components.schemas[schema.$ref.replace('#/components/schemas/', '')];
  return schema ?? null;
}

/**
 * Step 2: merge one pending layer into `merged` (mutated). Same rules as funnelchat-node's generator for `paths`,
 * `operationPatches` (body properties and `parameters`), `schemaPatches`, `responsePatches` and `webhooks`, plus the
 * kinds the sandbox needs:
 *
 *   - `responsePatches` with `removeResponses`: remove those codes instead of every 2xx;
 *   - `parameterPatches`: add parameters to an operation of the snapshot, only those it lacks (by name and place);
 *   - `operationPatches` with `replace: true`: replace properties of a body the snapshot does have, a correction of
 *     the snapshot (for example, Laravel's conditional `prohibited` letting `null` through), applied every time;
 *   - `webhookPatches`: set properties of an event's `data` (schema and example), while the event meets
 *     `while` or while its `data` lacks `whileMissing`. `type: "*"` patches every event;
 *   - `webhooks`: an event that replaces the portal's and brings no example keeps the portal's example.
 */
function mergeLayer(merged, layer, layerName, report) {
  // `paths` and `webhooks` entries only stand for what the snapshot already has (obsolete, or a correction of an
  // event with `x-fc-replace-while`): one the snapshot lacks is not published, and is refused.
  const tag = (label) => `${label} [${layerName}]`;

  for (const [name, schema] of Object.entries(layer.components?.schemas ?? {})) {
    if (merged.components.schemas[name]) {
      throw new Error(`${layerName}: the schema ${name} already exists; rename it.`);
    }
    merged.components.schemas[name] = schema;
  }

  for (const [path, item] of Object.entries(layer.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (!item[method]) continue;
      const label = tag(`${method.toUpperCase()} ${path}`);
      if (merged.paths[path]?.[method]) report.superseded.push(label);
      else report.refused.push(label);
    }
  }

  for (const patch of layer.operationPatches ?? []) {
    const names = [...Object.keys(patch.requestBodyProperties ?? {}), ...(patch.parameters ?? []).map((p) => p.name)];
    const label = tag(`${patch.method.toUpperCase()} ${patch.path} (cuerpo: ${names.join(', ')})`);
    const op = merged.paths[patch.path]?.[patch.method];
    if (!op) {
      report.missing.push(label);
      continue;
    }
    if (!matches(op, patch.while)) {
      report.superseded.push(label);
      continue;
    }
    const schema = requestSchema(merged, op);
    if (patch.requestBodyProperties && !schema) {
      report.missing.push(label);
      continue;
    }
    const props = Object.entries(patch.requestBodyProperties ?? {});
    const missingProps = props.filter(([prop]) => !(prop in (schema?.properties ?? {})));
    const hasParameter = (p) => (op.parameters ?? []).some((q) => q.name === p.name && q.in === p.in);
    const missingParams = (patch.parameters ?? []).filter((p) => !hasParameter(p));
    // Without `while` or `replace`, a patch only adds what the snapshot lacks: once it has all of it, it can go.
    if (!patch.while && !patch.replace && missingProps.length === 0 && missingParams.length === 0) {
      report.superseded.push(label);
      continue;
    }
    if (schema) {
      schema.properties ??= {};
      for (const [prop, propSchema] of props) {
        if (patch.replace) schema.properties[prop] = propSchema;
        else schema.properties[prop] ??= propSchema;
      }
    }
    if (missingParams.length) op.parameters = [...(op.parameters ?? []), ...missingParams];
    op['x-fc-pending'] = patch['x-fc-pending'];
    report.applied.push(label);
  }

  for (const patch of layer.schemaPatches ?? []) {
    const label = tag(`schema ${patch.schema} (propiedades: ${Object.keys(patch.properties ?? {}).join(', ')})`);
    const schema = merged.components.schemas[patch.schema];
    if (!schema) {
      report.missing.push(label);
      continue;
    }
    schema.properties ??= {};
    const missing = Object.keys(patch.properties ?? {}).filter((prop) => !(prop in schema.properties));
    if (missing.length === 0) {
      report.superseded.push(label);
      continue;
    }
    for (const prop of missing) schema.properties[prop] = patch.properties[prop];
    const required = (patch.required ?? []).filter((prop) => missing.includes(prop));
    if (required.length) schema.required = [...new Set([...(schema.required ?? []), ...required])];
    schema['x-fc-pending'] ??= patch['x-fc-pending'];
    report.applied.push(label);
  }

  for (const patch of layer.parameterPatches ?? []) {
    const label = tag(`${patch.method.toUpperCase()} ${patch.path} (parámetros: ${(patch.parameters ?? []).map((p) => p.name).join(', ')})`);
    const op = merged.paths[patch.path]?.[patch.method];
    if (!op) {
      report.missing.push(label);
      continue;
    }
    op.parameters ??= [];
    const missing = (patch.parameters ?? []).filter((p) => !op.parameters.some((q) => q.name === p.name && q.in === p.in));
    if (missing.length === 0) {
      report.superseded.push(label);
      continue;
    }
    op.parameters.push(...missing.map((p) => ({ ...p, 'x-fc-pending': patch['x-fc-pending'] })));
    report.applied.push(label);
  }

  for (const patch of layer.responsePatches ?? []) {
    const label = tag(`${patch.method.toUpperCase()} ${patch.path} (respuestas: ${Object.keys(patch.responses ?? {}).join(', ')})`);
    const op = merged.paths[patch.path]?.[patch.method];
    if (!op) {
      report.missing.push(label);
      continue;
    }
    if (!matches(op, patch.while)) {
      report.superseded.push(label);
      continue;
    }
    op.responses ??= {};
    // funnelchat-node's rule: every 2xx is replaced. `removeResponses` names the codes to remove instead.
    const remove = patch.removeResponses ?? Object.keys(op.responses).filter((code) => /^2/.test(code));
    for (const status of remove) delete op.responses[status];
    for (const [status, response] of Object.entries(patch.responses ?? {})) op.responses[status] = response;
    op['x-fc-pending'] ??= patch['x-fc-pending'];
    op['x-fc-pending-response'] = patch['x-fc-pending'];
    report.applied.push(label);
  }

  const snapshotTypes = new Map(Object.keys(merged.webhooks).map((key) => [eventTypeOfKey(key), key]));
  for (const [type, item] of Object.entries(layer.webhooks ?? {})) {
    const currentKey = snapshotTypes.get(type);
    const label = tag(`webhook ${type}`);
    if (!currentKey) {
      report.refused.push(label);
      continue;
    }
    const replaceWhile = item.post?.['x-fc-replace-while'];
    if (!replaceWhile || !matches(merged.webhooks[currentKey].post, replaceWhile)) {
      report.superseded.push(label);
      continue;
    }
    // The layer types the event; when it brings no example, the portal's stays: the catalog and the sandbox's
    // default `data` come from it.
    const replacement = structuredClone(item);
    const content = replacement.post?.requestBody?.content?.['application/json'];
    const portalExample = merged.webhooks[currentKey].post?.requestBody?.content?.['application/json']?.example;
    if (content && content.example === undefined && portalExample !== undefined) content.example = portalExample;
    delete merged.webhooks[currentKey];
    merged.webhooks[type] = replacement;
    snapshotTypes.set(type, type);
    report.applied.push(label);
  }

  for (const patch of layer.webhookPatches ?? []) {
    const label = tag(`webhook ${patch.type} (data: ${Object.keys(patch.dataProperties ?? {}).join(', ')})`);
    const keys = Object.keys(merged.webhooks).filter((key) => patch.type === '*' || eventTypeOfKey(key) === patch.type);
    if (keys.length === 0) {
      report.missing.push(label);
      continue;
    }
    let applied = false;
    for (const key of keys) {
      const post = merged.webhooks[key].post;
      const content = post?.requestBody?.content?.['application/json'];
      if (!content) continue;
      const dataSchema = content.schema?.properties?.data;
      const exampleData = content.example?.data;
      if (patch.while && !matches(post, patch.while)) continue;
      if (patch.whileMissing) {
        const inSchema = dataSchema?.properties && patch.whileMissing in dataSchema.properties && !dataSchema.properties[patch.whileMissing]['x-fc-pending'];
        // A typed `data` says it by its schema; only an event shown just by its example says it by the example.
        const inExample = !dataSchema?.properties && exampleData && typeof exampleData === 'object' && patch.whileMissing in exampleData;
        if (inSchema || inExample) continue;
      }
      content.schema ??= { type: 'object', properties: {} };
      content.schema.properties ??= {};
      content.schema.properties.data ??= { type: 'object', properties: {} };
      content.schema.properties.data.properties ??= {};
      for (const [prop, propSchema] of Object.entries(patch.dataProperties ?? {})) {
        content.schema.properties.data.properties[prop] = { ...propSchema, 'x-fc-pending': patch['x-fc-pending'] };
      }
      if (patch.example) content.example = patch.example;
      else if (exampleData && typeof exampleData === 'object') {
        for (const [prop, value] of Object.entries(patch.exampleData ?? {})) exampleData[prop] = value;
      }
      applied = true;
    }
    if (applied) report.applied.push(label);
    else report.superseded.push(label);
  }
}

function merge(spec, layers) {
  const merged = structuredClone(spec);
  merged.components ??= {};
  merged.components.schemas ??= {};
  merged.paths ??= {};
  merged.webhooks ??= {};
  const report = { applied: [], superseded: [], missing: [], refused: [] };
  for (const [name, layer] of layers) mergeLayer(merged, layer, name, report);
  return { merged, report };
}

/**
 * Step 4: the event catalog, `GET /api/v1/webhooks/events`, transcribed from the merged spec:
 *   - the types are the `events` enum of `POST /api/v1/webhooks`, in its order, all subscribable; then the types
 *     `webhooks` documents that the enum lacks, not subscribable (`webhook.test`, which only the test route sends);
 *   - each entry is what `webhooks` documents for the type: `area` (`x-fc-domain`), `status` (`x-fc-status`, `live`
 *     or absent: `active`), `description` and `example`, the envelope. A type that several areas document belongs to
 *     the area of the catalog's own operation, and takes the first of those entries;
 *   - `meta` is the constants of that operation's answer; `total` and `active` are counted when answering.
 * An example is always the whole envelope: a layer's example that brings only `data` takes `id`, `version` and
 * `occurred_at` from the portal's example of the type, or from EXAMPLE_ENVELOPE when the portal has none.
 * A type of the enum without an event in `webhooks`, or a status it does not know, stops the generation.
 */
const EXAMPLE_ENVELOPE = { id: 'evt_000000000000000000000000', version: 1, occurred_at: '2026-10-01T12:00:00Z' };

function envelopeOf(type, example, portalExample) {
  if (!example || typeof example !== 'object') return null;
  if ('type' in example) return example;
  const base = portalExample && typeof portalExample === 'object' && 'type' in portalExample ? portalExample : EXAMPLE_ENVELOPE;
  return { id: base.id, type, version: base.version, occurred_at: base.occurred_at, data: example.data ?? null };
}

function buildCatalog(merged, snapshot, portalVersion, specSha) {
  const subscribe = merged.paths['/api/v1/webhooks']?.post;
  const subscribable = subscribe ? requestSchema(merged, subscribe)?.properties?.events?.items?.enum : null;
  if (!Array.isArray(subscribable)) throw new Error('POST /api/v1/webhooks has no `events` enum: the catalog cannot be transcribed.');
  const catalogOperation = merged.paths['/api/v1/webhooks/events']?.get;
  const metaProperties = catalogOperation?.responses?.['200']?.content?.['application/json']?.schema?.properties?.meta?.properties;
  if (!metaProperties) throw new Error('GET /api/v1/webhooks/events has no `meta` in its answer: the catalog cannot be transcribed.');
  const meta = Object.fromEntries(Object.entries(metaProperties).filter(([, schema]) => 'const' in schema).map(([key, schema]) => [key, schema.const]));

  const byType = new Map();
  for (const [key, item] of Object.entries(merged.webhooks)) {
    const type = eventTypeOfKey(key);
    byType.set(type, [...(byType.get(type) ?? []), item.post ?? {}]);
  }
  const portalExamples = new Map();
  for (const [key, item] of Object.entries(snapshot.webhooks ?? {})) {
    const example = item.post?.requestBody?.content?.['application/json']?.example;
    if (example && !portalExamples.has(eventTypeOfKey(key))) portalExamples.set(eventTypeOfKey(key), example);
  }
  const undocumented = subscribable.filter((type) => !byType.has(type));
  if (undocumented.length) throw new Error(`types of the events enum of POST /api/v1/webhooks without an event in webhooks: ${undocumented.join(', ')}`);

  const types = [...subscribable, ...[...byType.keys()].filter((type) => !subscribable.includes(type))];
  const entries = types.map((type) => {
    const posts = byType.get(type);
    const areas = [...new Set(posts.map((post) => post['x-fc-domain']))];
    const area = areas.length === 1 ? areas[0] : catalogOperation['x-fc-domain'];
    if (!area) throw new Error(`${type}: no x-fc-domain says its area.`);
    const post = posts.find((p) => p['x-fc-domain'] === area) ?? posts[0];
    const status = post['x-fc-status'] ?? 'live';
    if (status !== 'live') throw new Error(`${type}: x-fc-status "${status}" is new; say in scripts/generate.mjs what the catalog shows for it.`);
    return {
      type,
      area,
      status: 'active',
      description: post.description ?? '',
      subscribable: subscribable.includes(type),
      example: envelopeOf(type, post.requestBody?.content?.['application/json']?.example, portalExamples.get(type)),
    };
  });

  return {
    description:
      'GENERATED by scripts/generate.mjs: do not edit it. The event catalog of GET /api/v1/webhooks/events, transcribed from generated/openapi.json: the types are the `events` enum of POST /api/v1/webhooks, and each entry is what the spec documents for the event in `webhooks`.',
    source: { portal_version: portalVersion, 'spec/funnelchat.json': specSha },
    meta,
    entries,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.spec) importSpec(args.spec, args.origin);
  if (args.pending) importPending(args.pending);
  if (!existsSync(SPEC_FILE)) throw new Error('spec/funnelchat.json is missing: run `npm run generate -- --spec <file>`.');

  const specBytes = readFileSync(SPEC_FILE);
  const pendingBytes = existsSync(PENDING_FILE) ? readFileSync(PENDING_FILE) : null;
  const sandboxBytes = existsSync(SANDBOX_PENDING_FILE) ? readFileSync(SANDBOX_PENDING_FILE) : null;

  const provenance = readProvenance();
  if (provenance.snapshot && provenance.snapshot.sha256 !== sha256(specBytes)) {
    console.warn('warning: spec/funnelchat.json does not match the sha256 in spec/procedencia.json (was it edited by hand?).');
  }
  if (pendingBytes && provenance.pending && provenance.pending.sha256 !== sha256(pendingBytes)) {
    console.warn('warning: spec/pending.json does not match the sha256 in spec/procedencia.json: it is the Node SDK\'s layer, change it there and copy it again with --pending.');
  }

  const layers = [];
  if (pendingBytes) layers.push(['pending.json', JSON.parse(pendingBytes.toString('utf8'))]);
  if (sandboxBytes) layers.push(['pending-sandbox.json', JSON.parse(sandboxBytes.toString('utf8'))]);
  const snapshot = JSON.parse(specBytes.toString('utf8'));
  const { merged, report } = merge(snapshot, layers);

  merged['x-fc-sandbox'] = {
    generated_by: 'scripts/generate.mjs',
    note: 'GENERATED: do not edit it. The portal\'s snapshot plus the pending layers.',
    inputs: {
      'spec/funnelchat.json': sha256(specBytes),
      'spec/pending.json': pendingBytes ? sha256(pendingBytes) : null,
      'spec/pending-sandbox.json': sandboxBytes ? sha256(sandboxBytes) : null,
    },
    snapshot_commit: provenance.snapshot?.source?.commit ?? null,
    pending_commit: provenance.pending?.source?.commit ?? null,
    pending_applied: report.applied,
  };
  const output = `${JSON.stringify(merged, null, 1)}\n`;

  console.log(`pending of the spec: ${report.applied.length} entries applied.`);
  if (report.superseded.length) {
    console.log(`the snapshot already has ${report.superseded.length} pending entries; they can be deleted:`);
    for (const label of report.superseded) console.log(`  - ${label}`);
  }
  if (report.refused.length) {
    console.warn(`warning: ${report.refused.length} pending entries add an operation or an event the published spec does not carry; not applied (delete them):`);
    for (const label of report.refused) console.warn(`  - ${label}`);
  }
  if (report.missing.length) {
    console.warn(`warning: ${report.missing.length} patches did not find their operation or their event:`);
    for (const label of report.missing) console.warn(`  - ${label}`);
  }

  const catalog = buildCatalog(merged, snapshot, provenance.snapshot?.source?.portal_version ?? null, sha256(specBytes));
  const subscribable = catalog.entries.filter((entry) => entry.subscribable).length;
  console.log(`event catalog: ${catalog.entries.length} types, ${subscribable} subscribable.`);
  const outputs = [
    [OUT_FILE, output],
    [CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`],
  ];

  if (args.check) {
    const stale = outputs.filter(([file, text]) => !existsSync(file) || readFileSync(file, 'utf8') !== text).map(([file]) => relative(ROOT, file));
    if (stale.length) {
      console.error(`${stale.join(' and ')} out of date: run \`npm run generate\`.`);
      process.exit(1);
    }
    console.log('generated/ is up to date.');
    return;
  }

  for (const [file, text] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`generated: ${relative(ROOT, file)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
