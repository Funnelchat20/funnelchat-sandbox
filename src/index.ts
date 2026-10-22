/**
 * @funnelchat-hq/sandbox as a library: start the sandbox from your own tests.
 *
 * ```ts
 * import { createSandbox } from '@funnelchat-hq/sandbox';
 * const sandbox = createSandbox({ config: { port: 0, log: false } });
 * const { url } = await sandbox.listen();
 * // ... point the SDK at `url` ...
 * await sandbox.close();
 * ```
 */
export { createSandbox, type Sandbox, type CreateSandboxOptions } from './server.js';
export { defaultConfig, mergeConfig, type SandboxConfig, type ConfigInput, type PresetSubscription } from './config.js';
export { signature, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER } from './webhooks/signature.js';
export { catalog, type CatalogEntry } from './webhooks/catalog.js';
export { REJECTIONS, FAILURE_REASONS, META_ERRORS } from './messaging/rules.js';
export { SUPPORTED_EXTENSIONS, SEND_FILE_TYPES } from './messaging/files.js';
export { EDGE_ERRORS } from './http/errors.js';
export { REQUEST_ID_HEADER } from './server.js';
export { FORM_TEMPLATES } from './forms/templates.js';
export { VERSION } from './version.js';
