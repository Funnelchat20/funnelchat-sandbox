/**
 * Webhook subscriptions: the unified subscriptions of accounts (`/api/v1/webhooks`), the same routes the SDKs and
 * the n8n trigger use.
 *
 * In production since accounts v1.4.24. The catalog (`/webhooks/events`) and the types a subscription accepts are
 * generated/catalog.json, transcribed from the spec by `npm run generate`.
 *
 * Workspaces (accounts v1.5.97): a subscription belongs to the workspace of the key that created it, a key only sees
 * and changes the subscriptions of its workspace (another workspace's answers `404`), and the cap of 50 counts per
 * workspace. A subscription only gets the events of its workspace.
 */
import type { SandboxApp } from '../app.js';
import { body, listContext, noContent, ok, type HandlerContext, type HandlerTable } from '../http/context.js';
import { ApiError, validationFailed } from '../http/errors.js';
import { paginate } from '../http/paginate.js';
import { deliveryResource, subscriptionResource, subscriptionWithSecret } from '../state/resources.js';
import type { Subscription } from '../state/store.js';
import { sees } from '../state/workspaces.js';
import { uuid, webhookSecret } from '../util.js';
import { catalogResponse, isSubscribable } from '../webhooks/catalog.js';

/** accounts `WebhookSubscriptionController::SUBSCRIPTION_LIMIT`: per workspace. */
const SUBSCRIPTION_LIMIT = 50;

function getSubscription(ctx: HandlerContext, id: unknown): Subscription {
  const subscription = ctx.app.store.subscriptions.get(String(id));
  // One of another workspace is out of the query (`inActiveWorkspace`): the same `404 not_found`.
  if (!subscription || !sees(ctx.workspace, subscription.workspaceId)) throw new ApiError(404, 'not_found', 'Suscripción de webhook no encontrada.');
  return subscription;
}

/**
 * accounts `WebhookSubscriptionTestController::untestableReason()`: a `disabled` subscription is not tested, and its
 * `422` says why.
 */
function untestableReason(subscription: Subscription): string | null {
  if (subscription.status !== 'disabled') return null;
  if (subscription.disabledReason === 'too_many_failures') return 'La suscripción está deshabilitada por entregas fallidas consecutivas. Reactívala antes de probarla.';
  return 'La suscripción está deshabilitada. Habilítala antes de probarla.';
}

const ofWorkspace = (ctx: HandlerContext): Subscription[] => [...ctx.app.store.subscriptions.values()].filter((s) => sees(ctx.workspace, s.workspaceId));

/**
 * The rules of `StoreWebhookSubscriptionRequest` that the schema does not express, and the destination check, with
 * accounts' messages. Laravel checks every rule at once, so the server adds these to the schema's errors too.
 */
export function subscriptionBodyErrors(app: SandboxApp, value: unknown): Record<string, string[]> {
  const b = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
      errors[`events.${i}`] = ['Uno de los tipos de evento no existe o no se puede suscribir. Consulta GET api/v1/webhooks/events.'];
    } else if (events.indexOf(type) !== i) {
      errors[`events.${i}`] = ['Los tipos de evento no pueden repetirse.'];
    }
  });
  return errors;
}

function checkSubscriptionBody(app: SandboxApp, b: Record<string, unknown>): void {
  const errors = subscriptionBodyErrors(app, b);
  if (Object.keys(errors).length) throw validationFailed(errors);
}

function filtersOf(value: unknown): Subscription['filters'] {
  const ids = (value as { campaign_ids?: unknown } | null | undefined)?.campaign_ids;
  return Array.isArray(ids) && ids.length ? { campaign_ids: ids.map(String) } : {};
}

/** The routes whose body `subscriptionBodyErrors` completes. */
export const SUBSCRIPTION_BODY_ROUTES = new Set(['POST /api/v1/webhooks', 'PUT /api/v1/webhooks/{id}']);

export const webhookHandlers: HandlerTable = {
  'GET /api/v1/webhooks/events': () => ok(catalogResponse()),

  'GET /api/v1/webhooks': (ctx) => {
    const list = ofWorkspace(ctx).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (ctx.query.perPage !== undefined || ctx.query.per_page !== undefined) return ok(paginate(list, listContext(ctx), subscriptionResource));
    return ok(list.map(subscriptionResource));
  },

  'POST /api/v1/webhooks': (ctx) => {
    const b = body(ctx);
    checkSubscriptionBody(ctx.app, b);
    // The cap, in the common format: `422 validation_failed` with the message, and no field to point at.
    if (ofWorkspace(ctx).length >= SUBSCRIPTION_LIMIT) {
      throw new ApiError(422, 'validation_failed', `Alcanzaste el límite de ${SUBSCRIPTION_LIMIT} suscripciones de webhook.`);
    }
    const now = new Date();
    const subscription: Subscription = {
      id: uuid(),
      workspaceId: ctx.workspace.id,
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
    ctx.app.logger.info(`subscription created ${subscription.id} → ${subscription.url} (${subscription.events.join(', ')})`);
    return ok(subscriptionWithSecret(subscription), 201);
  },

  'GET /api/v1/webhooks/{id}': (ctx) => ok(subscriptionResource(getSubscription(ctx, ctx.path.id))),

  'PUT /api/v1/webhooks/{id}': (ctx) => {
    const subscription = getSubscription(ctx, ctx.path.id);
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
    const subscription = getSubscription(ctx, ctx.path.id);
    ctx.app.store.subscriptions.delete(subscription.id);
    ctx.app.store.deliveries = ctx.app.store.deliveries.filter((d) => d.subscriptionId !== subscription.id);
    return noContent();
  },

  'POST /api/v1/webhooks/{id}/rotate-secret': (ctx) => {
    const subscription = getSubscription(ctx, ctx.path.id);
    subscription.secret = webhookSecret();
    subscription.secretRotatedAt = new Date();
    subscription.updatedAt = subscription.secretRotatedAt;
    return ok(subscriptionWithSecret(subscription));
  },

  'POST /api/v1/webhooks/{id}/test': async (ctx: HandlerContext) => {
    const subscription = getSubscription(ctx, ctx.path.id);
    const reason = untestableReason(subscription);
    if (reason) throw new ApiError(422, 'validation_failed', reason);
    return ok(await ctx.app.webhooks.test(subscription));
  },

  'GET /api/v1/webhooks/{id}/deliveries': (ctx) => {
    const subscription = getSubscription(ctx, ctx.path.id);
    const q = ctx.query;
    const list = ctx.app.store.deliveries
      .filter((d) => d.subscriptionId === subscription.id && (!q.event_type || d.eventType === q.event_type) && (!q.event_id || d.eventId === q.event_id))
      .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime() || b.id - a.id);
    return ok(paginate(list, listContext(ctx), deliveryResource));
  },
};
