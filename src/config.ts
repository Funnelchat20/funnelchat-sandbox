import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from './util.js';

/** A subscription created when the sandbox starts (and after every reset), with a fixed secret. */
export interface PresetSubscription {
  url: string;
  events: string[];
  description?: string | null;
  /** Optional: a fixed secret, so your receiver keeps working across restarts. One is generated otherwise. */
  secret?: string;
  /** Optional: a fixed id (UUID). */
  id?: string;
}

export interface SandboxConfig {
  port: number;
  host: string;
  /** Seconds from one state to the next of an accepted message: queued → sent → delivered → read. `null` stops there. */
  statusDelays: { sent: number; delivered: number | null; read: number | null };
  webhooks: {
    /** Seconds to wait before attempts 2, 3 and 4 (the portal: 60, 300, 1800). */
    retryDelays: number[];
    /** A delivery counts as failed if the receiver takes longer (the portal: 10 s). */
    timeoutSeconds: number;
    /** Consecutive failed deliveries that disable a subscription (accounts: 5). */
    maxConsecutiveFailures: number;
    /** The real API only accepts public `https` URLs. The sandbox accepts `http` and local addresses unless this is `true`. */
    requireHttps: boolean;
  };
  rules: {
    /** The 24-hour window on official (Cloud) numbers: `422 window_closed`. */
    window: boolean;
    /** The spam brakes: `422 antiblock_duplicate_content` and `422 antiblock_unanswered_limit`. */
    antiblock: boolean;
    /** The pace of official numbers: `429 rate_limited` with `Retry-After`. */
    rateLimit: boolean;
  };
  /** Seconds until a template created through the API goes from `PENDING` to `APPROVED`. `null`: it stays pending. */
  templateApprovalSeconds: number | null;
  /** Subscriptions to create at start and after every reset. */
  subscriptions: PresetSubscription[];
  /**
   * The number quota of the account and the Meta sign-up switch; `POST /_sandbox/numbers` changes them while it runs.
   * QR and Meta of the same phone count once; the two example numbers already use two places.
   */
  numbers: {
    /** Numbers the plan allows: `403 number_limit_reached` beyond it. */
    limit: number;
    /** `false`: the plan has no numbers, `403 numbers_not_included`. */
    included: boolean;
    /** A trial account: one number of the US pool instead of three. */
    trial: boolean;
    /** `false`: `POST /connect-links` with `type: meta` answers `503 meta_connect_disabled`, like production while Meta is off. */
    metaConnect: boolean;
  };
  /**
   * Where the sign-up page is reachable, for the `url` of a link (`<publicUrl>/connect/<token>`). Never taken from the
   * request's `Host`. `null`: the address the sandbox listens on.
   */
  publicUrl: string | null;
  /** How many requests and deliveries the panel keeps. */
  historyLimit: number;
  /** One line per request and per delivery on the console. */
  log: boolean;
}

export const DEFAULT_PORT = 4010;
export const DEFAULT_CONFIG_FILE = 'funnelchat-sandbox.config.json';

export function defaultConfig(): SandboxConfig {
  return {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    statusDelays: { sent: 1, delivered: 2, read: 3 },
    webhooks: { retryDelays: [60, 300, 1800], timeoutSeconds: 10, maxConsecutiveFailures: 5, requireHttps: false },
    rules: { window: true, antiblock: true, rateLimit: true },
    templateApprovalSeconds: 5,
    subscriptions: [],
    numbers: { limit: 5, included: true, trial: false, metaConnect: true },
    publicUrl: null,
    historyLimit: 200,
    log: true,
  };
}

export type ConfigInput = {
  [K in keyof SandboxConfig]?: SandboxConfig[K] extends Record<string, unknown> ? Partial<SandboxConfig[K]> : SandboxConfig[K];
};

export class ConfigError extends Error {}

const nonNegative = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a number of seconds, 0 or more.`);
  }
  return value;
};

const optionalDelay = (value: unknown, name: string): number | null => (value === null ? null : nonNegative(value, name));

/** Merges a partial configuration over a full one, checking every value. */
export function mergeConfig(base: SandboxConfig, input: ConfigInput): SandboxConfig {
  const out: SandboxConfig = structuredClone(base);
  if (!isRecord(input)) throw new ConfigError('The configuration must be a JSON object.');
  for (const key of Object.keys(input)) {
    if (!(key in out)) throw new ConfigError(`Unknown option in the configuration: ${key}.`);
  }
  if (input.port !== undefined) {
    if (!Number.isInteger(input.port) || (input.port as number) < 0 || (input.port as number) > 65535) {
      throw new ConfigError('port must be an integer between 0 and 65535.');
    }
    out.port = input.port as number;
  }
  if (input.host !== undefined) {
    if (typeof input.host !== 'string' || input.host === '') throw new ConfigError('host must be a string.');
    out.host = input.host;
  }
  if (input.statusDelays !== undefined) {
    const d = input.statusDelays;
    if (!isRecord(d)) throw new ConfigError('statusDelays must be an object {sent, delivered, read}.');
    if (d.sent !== undefined) out.statusDelays.sent = nonNegative(d.sent, 'statusDelays.sent');
    if (d.delivered !== undefined) out.statusDelays.delivered = optionalDelay(d.delivered, 'statusDelays.delivered');
    if (d.read !== undefined) out.statusDelays.read = optionalDelay(d.read, 'statusDelays.read');
  }
  if (input.webhooks !== undefined) {
    const w = input.webhooks;
    if (!isRecord(w)) throw new ConfigError('webhooks must be an object.');
    if (w.retryDelays !== undefined) {
      if (!Array.isArray(w.retryDelays)) throw new ConfigError('webhooks.retryDelays must be a list of seconds.');
      out.webhooks.retryDelays = w.retryDelays.map((v, i) => nonNegative(v, `webhooks.retryDelays[${i}]`));
    }
    if (w.timeoutSeconds !== undefined) {
      out.webhooks.timeoutSeconds = nonNegative(w.timeoutSeconds, 'webhooks.timeoutSeconds');
    }
    if (w.maxConsecutiveFailures !== undefined) {
      if (!Number.isInteger(w.maxConsecutiveFailures) || (w.maxConsecutiveFailures as number) < 1) {
        throw new ConfigError('webhooks.maxConsecutiveFailures must be an integer greater than 0.');
      }
      out.webhooks.maxConsecutiveFailures = w.maxConsecutiveFailures as number;
    }
    if (w.requireHttps !== undefined) out.webhooks.requireHttps = Boolean(w.requireHttps);
  }
  if (input.rules !== undefined) {
    const r = input.rules;
    if (!isRecord(r)) throw new ConfigError('rules must be an object {window, antiblock, rateLimit}.');
    for (const key of ['window', 'antiblock', 'rateLimit'] as const) {
      if (r[key] !== undefined) out.rules[key] = Boolean(r[key]);
    }
  }
  if (input.templateApprovalSeconds !== undefined) {
    out.templateApprovalSeconds = optionalDelay(input.templateApprovalSeconds, 'templateApprovalSeconds');
  }
  if (input.subscriptions !== undefined) {
    if (!Array.isArray(input.subscriptions)) throw new ConfigError('subscriptions must be a list.');
    out.subscriptions = input.subscriptions.map((s, i) => {
      if (!isRecord(s) || typeof s.url !== 'string' || !Array.isArray(s.events) || s.events.some((e) => typeof e !== 'string')) {
        throw new ConfigError(`subscriptions[${i}] needs url (a string) and events (a list of types).`);
      }
      if (s.secret !== undefined && (typeof s.secret !== 'string' || s.secret === '')) {
        throw new ConfigError(`subscriptions[${i}].secret must be a string.`);
      }
      return structuredClone(s) as unknown as PresetSubscription;
    });
  }
  if (input.numbers !== undefined) {
    const n = input.numbers;
    if (!isRecord(n)) throw new ConfigError('numbers must be an object {limit, included, trial, metaConnect}.');
    if (n.limit !== undefined) {
      if (!Number.isInteger(n.limit) || (n.limit as number) < 0) throw new ConfigError('numbers.limit must be an integer, 0 or more.');
      out.numbers.limit = n.limit as number;
    }
    for (const key of ['included', 'trial', 'metaConnect'] as const) {
      if (n[key] !== undefined) out.numbers[key] = Boolean(n[key]);
    }
  }
  if (input.publicUrl !== undefined) {
    if (input.publicUrl !== null && (typeof input.publicUrl !== 'string' || !/^https?:\/\/[^/]+/.test(input.publicUrl))) {
      throw new ConfigError('publicUrl must be an http(s) URL, like https://sandbox.example.com, or null.');
    }
    out.publicUrl = input.publicUrl === null ? null : (input.publicUrl as string).replace(/\/+$/, '');
  }
  if (input.historyLimit !== undefined) {
    if (!Number.isInteger(input.historyLimit) || (input.historyLimit as number) < 1) {
      throw new ConfigError('historyLimit must be an integer greater than 0.');
    }
    out.historyLimit = input.historyLimit as number;
  }
  if (input.log !== undefined) out.log = Boolean(input.log);
  return out;
}

/** Reads a JSON configuration file. */
export function readConfigFile(path: string): ConfigInput {
  const full = resolve(path);
  if (!existsSync(full)) throw new ConfigError(`The configuration file ${path} does not exist.`);
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as ConfigInput;
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `1,2,3` → [1, 2, 3]; `-` stands for `null` (stop there) where allowed. */
export function parseSecondsList(value: string, flag: string, allowNull = false): (number | null)[] {
  return value.split(',').map((part) => {
    const text = part.trim();
    if (allowNull && (text === '-' || text === 'null')) return null;
    const n = Number(text);
    if (text === '' || !Number.isFinite(n) || n < 0) throw new ConfigError(`${flag}: "${part}" is not a number of seconds.`);
    return n;
  });
}

export interface CliArgs {
  help: boolean;
  version: boolean;
  configFile: string | null;
  overrides: ConfigInput;
}

/** Parses the command line. Flags win over the configuration file. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false, configFile: null, overrides: {} };
  const o = args.overrides;
  const take = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`${flag} needs a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    let inline: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = take(i, arg);
      i++;
      return v;
    };
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-c':
      case '--config':
        args.configFile = value();
        break;
      case '-p':
      case '--port': {
        const n = Number(value());
        if (!Number.isInteger(n)) throw new ConfigError('--port must be an integer.');
        o.port = n;
        break;
      }
      case '--host':
        o.host = value();
        break;
      case '--public-url':
        o.publicUrl = value();
        break;
      case '--status-delays': {
        const [sent, delivered, read] = parseSecondsList(value(), '--status-delays', true);
        if (sent === null || sent === undefined) throw new ConfigError('--status-delays: the first one (sent) must be a number.');
        o.statusDelays = { sent, delivered: delivered === undefined ? null : delivered, read: read === undefined ? null : read };
        break;
      }
      case '--retry-delays':
        o.webhooks = { ...o.webhooks, retryDelays: parseSecondsList(value(), '--retry-delays') as number[] };
        break;
      case '--webhook-timeout': {
        const [n] = parseSecondsList(value(), '--webhook-timeout');
        o.webhooks = { ...o.webhooks, timeoutSeconds: n as number };
        break;
      }
      case '--require-https':
        o.webhooks = { ...o.webhooks, requireHttps: true };
        break;
      case '--no-window':
        o.rules = { ...o.rules, window: false };
        break;
      case '--no-antiblock':
        o.rules = { ...o.rules, antiblock: false };
        break;
      case '--no-rate-limit':
        o.rules = { ...o.rules, rateLimit: false };
        break;
      case '--template-approval': {
        const [n] = parseSecondsList(value(), '--template-approval', true);
        o.templateApprovalSeconds = n ?? null;
        break;
      }
      case '-q':
      case '--quiet':
        o.log = false;
        break;
      default:
        throw new ConfigError(`Unknown option: ${arg}. Try --help.`);
    }
  }
  return args;
}

/** Defaults < configuration file (`--config`, or ./funnelchat-sandbox.config.json if it exists) < flags. */
export function resolveConfig(args: CliArgs, cwd = process.cwd()): { config: SandboxConfig; configFile: string | null } {
  let config = defaultConfig();
  let configFile = args.configFile;
  if (!configFile && existsSync(resolve(cwd, DEFAULT_CONFIG_FILE))) configFile = resolve(cwd, DEFAULT_CONFIG_FILE);
  if (configFile) config = mergeConfig(config, readConfigFile(configFile));
  config = mergeConfig(config, args.overrides);
  return { config, configFile };
}
