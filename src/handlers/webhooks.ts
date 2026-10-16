/**
 * Webhook subscriptions: the unified subscriptions of accounts (`/api/v1/webhooks`), the same routes the SDKs and
 * the n8n trigger use.
 *
 * PENDING OF THE SPEC: these routes come from accounts origin/main (in production since 13-10, accounts #978), not
 * from the snapshot; their types are in spec/pending.json (funnelchat-node). The catalog (`/webhooks/events`) is in
 * the snapshot.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, noContent, ok, type HandlerContext, type HandlerTable } from '../http/context.js';
import { ApiError, notFound, validationFailed } from '../http/errors.js';
import { paginate } from '../http/paginate.js';
import { deliveryResource, subscriptionResource, subscriptionWithSecret } from '../state/resources.js';
import type { Subscription } from '../state/store.js';
import { uuid, webhookSecret } from '../util.js';
import { catalogResponse, isSubscribable } from '../webhooks/catalog.js';

/** accounts `WebhookSubscriptionController::SUBSCRIPTION_LIMIT`. */
const SUBSCRIPTION_LIMIT = 50;

function getSubscription(app: SandboxApp, id: unknown): Subscription {
  const subscription = app.store.subscriptions.get(String(id));
  if (!subscription) throw notFound('Suscripción de webhook no encontrada.');
  return subscription;
}

/** The rules of `StoreWebhookSubscriptionRequest` that the schema does not express, and the destination check. */
function checkSubscriptionBody(app: SandboxApp, b: Record<string, unknown>): void {
  const errors: Record<string, string[]> = {};
  const url = String(b.url ?? '');
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    errors.url = ['El campo url debe ser una URL válida.'];
  }
  if (parsed) {
    if (/^https?:\/\/[^/?#]*@/i.test(url)) errors.url = ['La URL del webhook no puede incluir usuario ni contraseña.'];
    else if (app.config.webhooks.requireHttps && parsed.protocol !== 'https:') errors.url = ['La URL del webhook debe ser https.'];
    else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') errors.url = ['La URL del webhook debe ser https.'];
  }
  const events = Array.isArray(b.events) ? (b.events as unknown[]) : [];
  events.forEach((type, i) => {
    if (typeof type !== 'string' || !isSubscribable(type)) {
      errors[`events.${i}`] = ['Uno de los tipos de evento no existe o no se puede suscribir. Consultá GET api/v1/webhooks/events.'];
    } else if (events.indexOf(type) !== i) {
      errors[`events.${i}`] = ['Los tipos de evento no pueden repetirse.'];
    }
  });
  if (Object.keys(errors).length) throw validationFailed(errors);
}

function filtersOf(value: unknown): Subscription['filters'] {
  const ids = (value as { campaign_ids?: unknown } | null | undefined)?.campaign_ids;
  return Array.isArray(ids) && ids.length ? { campaign_ids: ids.map(String) } : {};
}

export const webhookHandlers: HandlerTable = {
  'GET /api/v1/webhooks/events': () => ok(catalogResponse()),

  'GET /api/v1/webhooks': (ctx) => {
    const list = [...ctx.app.store.subscriptions.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (ctx.query.perPage !== undefined || ctx.query.per_page !== undefined) return ok(paginate(list, listContext(ctx), subscriptionResource));
    return ok(list.map(subscriptionResource));
  },

  'POST /api/v1/webhooks': (ctx) => {
    const b = body(ctx);
    checkSubscriptionBody(ctx.app, b);
    if (ctx.app.store.subscriptions.size >= SUBSCRIPTION_LIMIT) {
      throw new ApiError(422, 'subscription_limit_reached', `Alcanzaste el límite de ${SUBSCRIPTION_LIMIT} suscripciones de webhook.`);
    }
    const now = new Date();
    const subscription: Subscription = {
      id: uuid(),
      url: String(b.url),
      description: b.description === undefined || b.description === null ? null : String(b.description),
      events: [...new Set(b.events as string[])],
      filters: filtersOf(b.filters),
      status: 'active',
      disabledReason: null,
      consecutiveFailures: 0,
      secret: webhookSecret(),
      lastDeliveryAt: null,
      lastSuccessAt: null,
      secretRotatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    ctx.app.store.subscriptions.set(subscription.id, subscription);
    ctx.app.logger.info(`suscripción creada ${subscription.id} → ${subscription.url} (${subscription.events.join(', ')})`);
    return ok(subscriptionWithSecret(subscription), 201);
  },

  'GET /api/v1/webhooks/{id}': (ctx) => ok(subscriptionResource(getSubscription(ctx.app, ctx.path.id))),

  'PUT /api/v1/webhooks/{id}': (ctx) => {
    const subscription = getSubscription(ctx.app, ctx.path.id);
    const b = body(ctx);
    checkSubscriptionBody(ctx.app, b);
    subscription.url = String(b.url);
    subscription.description = b.description === undefined || b.description === null ? null : String(b.description);
    subscription.events = [...new Set(b.events as string[])];
    subscription.filters = filtersOf(b.filters);
    if (b.status === 'active' || b.status === 'paused') {
      // Leaving `disabled` (or turning on) clears the reason and the failure count.
      if (b.status === 'active' || subscription.status === 'disabled') {
        subscription.disabledReason = null;
        subscription.consecutiveFailures = 0;
      }
      subscription.status = b.status;
    }
    subscription.updatedAt = new Date();
    return ok(subscriptionResource(subscription));
  },

  'DELETE /api/v1/webhooks/{id}': (ctx) => {
    const subscription = getSubscription(ctx.app, ctx.path.id);
    ctx.app.store.subscriptions.delete(subscription.id);
    ctx.app.store.deliveries = ctx.app.store.deliveries.filter((d) => d.subscriptionId !== subscription.id);
    return noContent();
  },

  'POST /api/v1/webhooks/{id}/rotate-secret': (ctx) => {
    const subscription = getSubscription(ctx.app, ctx.path.id);
    subscription.secret = webhookSecret();
    subscription.secretRotatedAt = new Date();
    subscription.updatedAt = subscription.secretRotatedAt;
    return ok(subscriptionWithSecret(subscription));
  },

  'POST /api/v1/webhooks/{id}/test': async (ctx: HandlerContext) => ok(await ctx.app.webhooks.test(getSubscription(ctx.app, ctx.path.id))),

  'GET /api/v1/webhooks/{id}/deliveries': (ctx) => {
    const subscription = getSubscription(ctx.app, ctx.path.id);
    const q = ctx.query;
    const list = ctx.app.store.deliveries
      .filter((d) => d.subscriptionId === subscription.id && (!q.event_type || d.eventType === q.event_type) && (!q.event_id || d.eventId === q.event_id))
      .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime() || b.id - a.id);
    return ok(paginate(list, listContext(ctx), deliveryResource));
  },
};
