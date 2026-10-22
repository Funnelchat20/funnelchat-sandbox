/**
 * Emission and delivery of events to the webhook subscriptions, like accounts' unified subscriptions
 * (`WebhookEventDispatcher`, `DeliverSubscriptionEventJob`, `SubscriptionWebhookSender`, platform-gate
 * `RetryPolicy`):
 *
 * - one envelope `{id, type, version, occurred_at, data}` per event, serialized once: every subscription and every
 *   retry gets the same bytes and the same `id`;
 * - one signed `POST` per subscription, with `X-Funnelchat-Signature` (a fresh `t` per attempt),
 *   `X-Funnelchat-Event` and `X-Funnelchat-Delivery` (a new UUID per attempt), no redirects, a 10 s timeout;
 * - up to 4 attempts, waiting 60 s, 300 s and 1800 s (configurable); a network error, a timeout, a `5xx` or a
 *   `429` is retried, any other answer that is not `2xx` is final;
 * - a delivery that runs out of attempts counts one consecutive failure; at 5 the subscription is disabled
 *   (`too_many_failures`); a success resets the count;
 * - each attempt checks again that the subscription exists, is `active` and still wants the type.
 */
import type { SandboxApp } from '../app.js';
import type { Delivery, Subscription } from '../state/store.js';
import { isoSeconds, isRecord, randomEventId, truncate, uuid } from '../util.js';
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, USER_AGENT, nowSeconds, signature } from './signature.js';

export interface EmitOptions {
  id?: string;
  occurredAt?: Date;
}

export interface Envelope {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  data: unknown;
}

export interface SendResult {
  status: number | null;
  error: string | null;
  durationMs: number;
  body: string | null;
}

/** Keys no event `data` can carry, at any depth (platform-gate `Event`). */
const FORBIDDEN_KEYS = ['user_id', 'account_id', 'owner_id', 'tokenable_id'];

function assertNoAccountIds(value: unknown, path = 'data'): void {
  if (Array.isArray(value)) value.forEach((v, i) => assertNoAccountIds(v, `${path}.${i}`));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) throw new Error(`A webhook payload cannot carry \`${key}\` (in \`${path}\`).`);
    assertNoAccountIds(child, `${path}.${key}`);
  }
}

function campaignOf(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const campaign = data.campaign;
  if (isRecord(campaign) && typeof campaign.uuid === 'string') return campaign.uuid;
  return typeof data.campaign_uuid === 'string' ? data.campaign_uuid : null;
}

function matchesFilter(subscription: Subscription, data: unknown): boolean {
  const ids = subscription.filters.campaign_ids;
  if (!ids || ids.length === 0) return true;
  const campaign = campaignOf(data);
  return campaign !== null && ids.includes(campaign);
}

function networkCategory(error: unknown): string {
  const e = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const name = e?.name ?? '';
  const code = String(e?.cause?.code ?? e?.code ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'timeout';
  }
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'tls_error';
  return 'connection_failed';
}

export class Webhooks {
  constructor(private readonly app: SandboxApp) {}

  get maxAttempts(): number {
    return this.app.config.webhooks.retryDelays.length + 1;
  }

  /** Builds the envelope, exactly as it is delivered. */
  envelope(type: string, data: unknown, options: EmitOptions = {}): Envelope {
    assertNoAccountIds(data);
    return {
      id: options.id ?? randomEventId(),
      type,
      version: 1,
      occurred_at: isoSeconds(options.occurredAt ?? new Date()),
      data,
    };
  }

  /** Emits one event to every active subscription that wants it. Returns the envelope and how many got it. */
  emit(type: string, data: unknown, options: EmitOptions = {}): { envelope: Envelope; subscriptions: number } {
    const envelope = this.envelope(type, data, options);
    const body = JSON.stringify(envelope);
    let count = 0;
    for (const subscription of this.app.store.subscriptions.values()) {
      if (subscription.status !== 'active' || !subscription.events.includes(type) || !matchesFilter(subscription, data)) continue;
      count++;
      void this.attempt(subscription.id, envelope.id, type, body, 1);
    }
    if (count === 0) this.app.logger.info(`event ${type} (${envelope.id}): no subscription asked for it`);
    return { envelope, subscriptions: count };
  }

  /** One signed POST. Never throws: the result says what happened. */
  async send(subscription: Subscription, type: string, body: string): Promise<SendResult> {
    const started = Date.now();
    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature(subscription.secret, body, nowSeconds()),
          [EVENT_HEADER]: type,
          [DELIVERY_HEADER]: uuid(),
          'User-Agent': USER_AGENT,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, this.app.config.webhooks.timeoutSeconds * 1000)),
      });
      let text: string | null = null;
      try {
        text = truncate(await response.text(), 2000);
      } catch {
        text = null;
      }
      const ok = response.status >= 200 && response.status < 300;
      return { status: response.status, error: ok ? null : 'non_2xx', durationMs: Date.now() - started, body: text };
    } catch (error) {
      return { status: null, error: networkCategory(error), durationMs: Date.now() - started, body: null };
    }
  }

  private shouldRetry(attempt: number, status: number | null): boolean {
    if (attempt >= this.maxAttempts) return false;
    if (status === null) return true;
    return status >= 500 || status === 429;
  }

  private async attempt(subscriptionId: string, eventId: string, type: string, body: string, attempt: number): Promise<void> {
    const { store, config, logger, scheduler } = this.app;
    const subscription = store.subscriptions.get(subscriptionId);
    // It stopped applying (deleted, paused, disabled, unsubscribed): no request and no failure counted.
    if (!subscription || subscription.status !== 'active' || !subscription.events.includes(type)) return;
    const generation = this.app.generation;

    const result = await this.send(subscription, type, body);
    if (generation !== this.app.generation) return; // a reset happened meanwhile

    const now = new Date();
    const succeeded = result.status !== null && result.status >= 200 && result.status < 300;
    const retry = !succeeded && this.shouldRetry(attempt, result.status);
    const delaySeconds = retry ? (config.webhooks.retryDelays[attempt - 1] ?? 0) : null;
    const delivery: Omit<Delivery, 'id'> = {
      subscriptionId,
      eventId,
      eventType: type,
      attempt,
      url: subscription.url,
      responseStatus: result.status,
      succeeded,
      error: result.error,
      durationMs: result.durationMs,
      attemptedAt: now,
      responseBody: result.body,
      requestBody: body,
      nextAttemptAt: delaySeconds === null ? null : new Date(now.getTime() + delaySeconds * 1000),
    };
    store.addDelivery(delivery);
    subscription.lastDeliveryAt = now;

    const outcome = succeeded ? String(result.status) : `${result.status ?? result.error}${result.error && result.status ? ` ${result.error}` : ''}`;
    logger.info(
      `webhook ${type} → ${subscription.url} ${outcome} (attempt ${attempt}/${this.maxAttempts}, ${result.durationMs} ms)` +
        (delaySeconds !== null ? `; retry in ${delaySeconds} s` : ''),
    );

    if (succeeded) {
      subscription.consecutiveFailures = 0;
      subscription.lastSuccessAt = now;
      return;
    }
    if (delaySeconds !== null) {
      scheduler.after(delaySeconds * 1000, () => this.attempt(subscriptionId, eventId, type, body, attempt + 1));
      return;
    }
    // Out of attempts, or a final answer: one consecutive failure.
    subscription.consecutiveFailures++;
    if (subscription.consecutiveFailures >= config.webhooks.maxConsecutiveFailures && subscription.status === 'active') {
      subscription.status = 'disabled';
      subscription.disabledReason = 'too_many_failures';
      subscription.updatedAt = now;
      logger.warn(`subscription ${subscription.id} disabled: ${subscription.consecutiveFailures} failed deliveries in a row`);
    }
  }

  /** `POST /api/v1/webhooks/{id}/test`: one synchronous `webhook.test`, no retries, no counters touched. */
  async test(subscription: Subscription): Promise<Record<string, unknown>> {
    const envelope = this.envelope('webhook.test', { subscription: subscription.id, sent_at: isoSeconds(new Date()) });
    const body = JSON.stringify(envelope);
    const result = await this.send(subscription, 'webhook.test', body);
    const succeeded = result.status !== null && result.status >= 200 && result.status < 300;
    const delivery = this.app.store.addDelivery({
      subscriptionId: subscription.id,
      eventId: envelope.id,
      eventType: 'webhook.test',
      attempt: 1,
      url: subscription.url,
      responseStatus: result.status,
      succeeded,
      error: result.error,
      durationMs: result.durationMs,
      attemptedAt: new Date(),
      responseBody: result.body,
      requestBody: body,
      nextAttemptAt: null,
    });
    this.app.logger.info(`webhook webhook.test → ${subscription.url} ${result.status ?? result.error} (test, ${result.durationMs} ms)`);
    return {
      succeeded,
      response_status: result.status,
      error: result.error,
      duration_ms: result.durationMs,
      delivery_id: delivery.id,
    };
  }
}
