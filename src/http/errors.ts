import type { FieldErrors } from '../openapi/validate.js';
import { summarize } from '../openapi/validate.js';

/** An error answer of the API: `{error, message}` plus optional extra keys, with optional headers. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

/** An error whose body is not `{error, message}`: some routes of the domains answer their own shape. */
export class RawApiError extends ApiError {
  constructor(
    status: number,
    readonly raw: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    super(status, typeof raw.error === 'string' ? raw.error : 'error', typeof raw.message === 'string' ? raw.message : '', {}, headers);
  }

  override body(): Record<string, unknown> {
    return { ...this.raw };
  }
}

/** `401` of the gate (platform-gate `UnauthenticatedResponse`). */
export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', 'Falta la API key o no es válida.', {}, { 'WWW-Authenticate': 'Bearer' });

/** `404` of the edge for a route that no domain serves (api-edge `route_not_found`). */
export const routeNotFound = () => new ApiError(404, 'route_not_found', 'La ruta no existe en la API.');

export const notFound = (message = 'No encontramos lo que pediste en esta cuenta.') => new ApiError(404, 'not_found', message);

/** `404` of a model binding in conversations (`bootstrap/app.php`): only `message`, `errors.object_not_found`. */
export const objectNotFound = () => new RawApiError(404, { message: 'Objeto no encontrado.' });

/** `403` of the gate for a route no API key enables (platform-gate `RouteNotAvailable`). */
export const routeNotAvailable = () =>
  new ApiError(
    403,
    'route_not_available',
    'Esta ruta no está disponible para API keys en el piloto. No es un permiso que falte: ninguna key la habilita.',
  );

/** The edge's own errors (api-edge v0.3.0 `src/index.ts`): `{error, message}`, no `Retry-After`. */
export const EDGE_ERRORS: Record<string, { status: number; message: string }> = {
  origin_unreachable: { status: 502, message: 'La API no está disponible en este momento.' },
  edge_misconfigured: { status: 500, message: 'La API no está disponible en este momento.' },
};

export const edgeError = (code: string) => {
  const known = EDGE_ERRORS[code] as { status: number; message: string };
  return new ApiError(known.status, code, known.message);
};

export const methodNotAllowed = (method: string, allowed: string[]) =>
  new ApiError(405, 'method_not_allowed', `El método ${method} no está disponible para esta ruta. Usá ${allowed.join(', ')}.`, {}, { Allow: allowed.join(', ') });

/** `422` of a validation: Laravel's `{message, errors}`, inside the `{error, message}` body of the sandbox. */
export const validationFailed = (errors: FieldErrors) => new ApiError(422, 'validation_failed', summarize(errors), { errors });

export const fieldError = (field: string, message: string) => validationFailed({ [field]: [message] });
