#!/usr/bin/env node
/**
 * The single generation script of the sandbox (`npm run generate`).
 *
 *   node scripts/generate.mjs                    merge spec/* into generated/openapi.json
 *   node scripts/generate.mjs --spec <file>      copy a new unified spec of the portal into spec/funnelchat.json,
 *                                                record where it came from, then merge
 *   node scripts/generate.mjs --pending <file>   copy a new pending layer of funnelchat-node (its spec/pending.json)
 *                                                into spec/pending.json, record where it came from, then merge
 *   node scripts/generate.mjs --check            merge in memory and fail if generated/openapi.json differs
 *
 * Steps:
 *   1. (with --spec / --pending) copy the file and write its entry in spec/procedencia.json
 *      (repository, branch, commit, sha256).
 *   2. Merge, in this order, over a copy of the snapshot:
 *        - spec/pending.json          the "pending of the spec" layer of the Node SDK, unchanged;
 *        - spec/pending-sandbox.json  what the sandbox imitates on top of it (send response with the queued
 *                                     message, message lookup, extra event fields, the sign-up of numbers).
 *      Every pending entry is applied only while the snapshot lacks it; the report lists the entries a new
 *      snapshot made obsolete so they can be deleted.
 *   3. Write generated/openapi.json: the merged spec the server validates and answers with. It is
 *      deterministic (no dates), so --check works in CI.
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
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function parseArgs(argv) {
  const args = { spec: null, pending: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--spec') args.spec = argv[++i];
    else if (arg.startsWith('--spec=')) args.spec = arg.slice('--spec='.length);
    else if (arg === '--pending') args.pending = argv[++i];
    else if (arg.startsWith('--pending=')) args.pending = arg.slice('--pending='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.spec === undefined) throw new Error('--spec needs the path of the file');
  if (args.pending === undefined) throw new Error('--pending needs the path of the file');
  if (args.check && (args.spec || args.pending)) throw new Error('--check does not combine with --spec or --pending');
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

/** Step 1a: copy a new snapshot of the portal and record its provenance. */
function importSpec(source) {
  const sourcePath = resolve(source);
  const bytes = readFileSync(sourcePath);
  const spec = JSON.parse(bytes.toString('utf8'));
  const provenance = readProvenance();
  provenance.snapshot = {
    file: 'spec/funnelchat.json',
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: gitSource(sourcePath),
    imported_at: new Date().toISOString(),
    spec: {
      openapi: spec.openapi ?? null,
      title: spec.info?.title ?? null,
      version: spec.info?.version ?? null,
      paths: Object.keys(spec.paths ?? {}).length,
      operations: countOperations(spec),
      webhooks: Object.keys(spec.webhooks ?? {}).length,
      domains: (spec['x-fc-sources'] ?? []).map((s) => ({ domain: s.domain, sha: s.sha, branch: s.branch, snapshot_at: s.snapshot_at })),
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

function matches(target, condition) {
  if (!condition) return true;
  return Object.entries(condition).every(([key, value]) => JSON.stringify(target?.[key]) === JSON.stringify(value));
}

/** The event type a `webhooks` key stands for: "webhook.test (conversations)" -> "webhook.test". */
const eventTypeOfKey = (key) => key.replace(/\s*\(.*\)\s*$/, '');

function requestSchema(merged, op) {
  let schema = op.requestBody?.content?.['application/json']?.schema;
  if (schema?.$ref) schema = merged.components.schemas[schema.$ref.replace('#/components/schemas/', '')];
  return schema ?? null;
}

/**
 * Step 2: merge one pending layer into `merged` (mutated). Same rules as funnelchat-node's generator for
 * `paths`, `operationPatches` and `webhooks`, plus three kinds the sandbox needs:
 *
 *   - `responsePatches`: replace responses of an operation of the snapshot while it meets `while`;
 *   - `parameterPatches`: add parameters to an operation of the snapshot, only those it lacks (by name and place);
 *   - `webhookPatches`: set properties of an event's `data` (schema and example), while the event meets
 *     `while` or while its `data` lacks `whileMissing`.
 */
function mergeLayer(merged, layer, layerName, report) {
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
      if (merged.paths[path]?.[method]) {
        report.superseded.push(label);
        continue;
      }
      merged.paths[path] ??= {};
      merged.paths[path][method] = item[method];
      report.applied.push(label);
    }
  }

  for (const patch of layer.operationPatches ?? []) {
    const label = tag(`${patch.method.toUpperCase()} ${patch.path} (cuerpo: ${Object.keys(patch.requestBodyProperties ?? {}).join(', ')})`);
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
    if (!schema) {
      report.missing.push(label);
      continue;
    }
    schema.properties ??= {};
    for (const [prop, propSchema] of Object.entries(patch.requestBodyProperties ?? {})) {
      schema.properties[prop] ??= propSchema;
    }
    op['x-fc-pending'] = patch['x-fc-pending'];
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
    for (const status of patch.removeResponses ?? []) delete op.responses[status];
    for (const [status, response] of Object.entries(patch.responses ?? {})) op.responses[status] = response;
    op['x-fc-pending-response'] = patch['x-fc-pending'];
    report.applied.push(label);
  }

  const snapshotTypes = new Map(Object.keys(merged.webhooks).map((key) => [eventTypeOfKey(key), key]));
  for (const [type, item] of Object.entries(layer.webhooks ?? {})) {
    const currentKey = snapshotTypes.get(type);
    const label = tag(`webhook ${type}`);
    if (currentKey) {
      const replaceWhile = item.post?.['x-fc-replace-while'];
      if (!replaceWhile || !matches(merged.webhooks[currentKey].post, replaceWhile)) {
        report.superseded.push(label);
        continue;
      }
      delete merged.webhooks[currentKey];
    }
    merged.webhooks[type] = item;
    snapshotTypes.set(type, type);
    report.applied.push(label);
  }

  for (const patch of layer.webhookPatches ?? []) {
    const label = tag(`webhook ${patch.type} (data: ${Object.keys(patch.dataProperties ?? {}).join(', ')})`);
    const keys = Object.keys(merged.webhooks).filter((key) => eventTypeOfKey(key) === patch.type);
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
        const inExample = exampleData && typeof exampleData === 'object' && patch.whileMissing in exampleData;
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
  const report = { applied: [], superseded: [], missing: [] };
  for (const [name, layer] of layers) mergeLayer(merged, layer, name, report);
  return { merged, report };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.spec) importSpec(args.spec);
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
  const { merged, report } = merge(JSON.parse(specBytes.toString('utf8')), layers);

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
  if (report.missing.length) {
    console.warn(`warning: ${report.missing.length} patches did not find their operation or their event:`);
    for (const label of report.missing) console.warn(`  - ${label}`);
  }

  if (args.check) {
    if (!existsSync(OUT_FILE) || readFileSync(OUT_FILE, 'utf8') !== output) {
      console.error('generated/openapi.json is out of date: run `npm run generate`.');
      process.exit(1);
    }
    console.log('generated/openapi.json is up to date.');
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, output);
  console.log(`generated: ${relative(ROOT, OUT_FILE)}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
