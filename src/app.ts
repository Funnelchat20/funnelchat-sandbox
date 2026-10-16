import { randomBytes } from 'node:crypto';
import { type SandboxConfig } from './config.js';
import { seed, Store, type Subscription } from './state/store.js';
import { uuid, webhookSecret } from './util.js';
import { isSubscribable } from './webhooks/catalog.js';
import { Webhooks } from './webhooks/dispatcher.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

const stamp = (): string => new Date().toISOString().slice(11, 19);

export const consoleLogger: Logger = {
  info: (message) => process.stdout.write(`${stamp()} ${message}\n`),
  warn: (message) => process.stderr.write(`${stamp()} aviso: ${message}\n`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

/** Timers of the sandbox (message states, retries, template approvals): all cleared on reset and on close. */
export class Scheduler {
  #timers = new Set<ReturnType<typeof setTimeout>>();

  after(ms: number, task: () => unknown): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => console.error('[sandbox] tarea programada falló:', error));
    }, Math.max(0, ms));
    timer.unref?.();
    this.#timers.add(timer);
  }

  get pending(): number {
    return this.#timers.size;
  }

  clearAll(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}

/** Everything a request handler needs: configuration, state, webhooks and timers. */
export class SandboxApp {
  store: Store;
  readonly scheduler = new Scheduler();
  readonly webhooks: Webhooks;
  /** Grows on every reset, so work started before a reset does not touch the new state. */
  generation = 0;

  constructor(
    readonly config: SandboxConfig,
    readonly logger: Logger = config.log ? consoleLogger : silentLogger,
  ) {
    this.store = new Store(config.historyLimit);
    this.webhooks = new Webhooks(this);
    this.populate();
  }

  private populate(): void {
    seed(this.store);
    for (const preset of this.config.subscriptions) {
      const unknown = preset.events.filter((e) => !isSubscribable(e));
      if (unknown.length) this.logger.warn(`suscripción de la configuración con tipos que no están en el catálogo: ${unknown.join(', ')}`);
      const now = new Date();
      const subscription: Subscription = {
        id: preset.id ?? uuid(),
        url: preset.url,
        description: preset.description ?? 'Suscripción de la configuración del sandbox',
        events: [...new Set(preset.events)],
        filters: {},
        status: 'active',
        disabledReason: null,
        consecutiveFailures: 0,
        secret: preset.secret ?? webhookSecret(),
        lastDeliveryAt: null,
        lastSuccessAt: null,
        secretRotatedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.store.subscriptions.set(subscription.id, subscription);
    }
  }

  /** `POST /_sandbox/reset`: empty state, the example data again, timers cancelled. */
  reset(): void {
    this.scheduler.clearAll();
    this.generation++;
    this.store = new Store(this.config.historyLimit);
    this.store.eventSalt = randomBytes(16).toString('hex');
    this.populate();
  }

  close(): void {
    this.scheduler.clearAll();
    this.generation++;
  }
}
