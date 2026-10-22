# funnelchat-sandbox

Un servidor local que imita la API pública de Funnelchat y manda webhooks firmados, sin efectos reales. Sirve para desarrollar y probar tu integración sin una cuenta real, sin WhatsApp y sin gastar nada: nada sale a WhatsApp, todo queda en memoria.

- Las mismas rutas, los mismos cuerpos y los mismos errores que la API en producción (accounts v1.4.24, conversations v1.18.10, communities v2.34.52 y la entrada de la API v0.3.0, desde el 21-10).
- Un estado en memoria para un flujo real: contactos, conversaciones y mensajes, etiquetas, campos personalizados, plantillas, formularios de WhatsApp y suscripciones de webhooks.
- El envío responde al instante con el mensaje en cola y después avisa `sent`, `delivered` y `read` por `message.status_changed`.
- Webhooks firmados con el algoritmo exacto del portal, con sus reintentos, y el catálogo de eventos de producción.
- Las reglas de WhatsApp que aplica la API: la ventana de 24 horas en números oficiales, el ritmo por número, los frenos contra spam y el bloqueo por MAC.
- `X-Request-Id` en cada respuesta, como la API.

> **Estado: v0.** La API pública está en v0 y puede cambiar. Lo que el sandbox no imita está en [Qué no imita](#qué-no-imita).

## Arrancarlo

Necesitas Node 20.11 o posterior.

```bash
npx funnelchat-sandbox
```

O, en tu proyecto, como dependencia de desarrollo:

```bash
npm install --save-dev funnelchat-sandbox
npx funnelchat-sandbox
```

```
funnelchat-sandbox 0.1.0 en http://127.0.0.1:4010
  API:    http://127.0.0.1:4010/api/v1/...   (Authorization: Bearer 1|fc_live_sandbox, o cualquier clave bien formada)
  panel:  http://127.0.0.1:4010/_sandbox
  números de ejemplo: 3 (oficial, con ventana de 24 h) y 4 (QR, sin ventana); contacto 2001; plantilla 45
```

**Desde el código:**

```bash
git clone https://github.com/Funnelchat20/funnelchat-sandbox.git
cd funnelchat-sandbox
npm install
npm run build
npx funnelchat-sandbox
```

**Con Docker** (desde el código):

```bash
docker build -t funnelchat-sandbox .
docker run --rm -p 4010:4010 funnelchat-sandbox
# con tu configuración:
docker run --rm -p 4010:4010 -v "$PWD/funnelchat-sandbox.config.json:/app/funnelchat-sandbox.config.json:ro" funnelchat-sandbox
```

Dentro del contenedor escucha en `0.0.0.0`. Si tu receptor de webhooks corre en tu máquina, desde el contenedor es `http://host.docker.internal:<puerto>` (en Linux, agrega `--add-host=host.docker.internal:host-gateway`).

**Desde tus tests**, sin otro proceso:

```ts
import { createSandbox } from 'funnelchat-sandbox';

const sandbox = createSandbox({ config: { port: 0, log: false, statusDelays: { sent: 0.05, delivered: 0.05, read: 0.05 } } });
const { url } = await sandbox.listen(); // port 0: un puerto libre
// … apunta tu SDK a `url` …
await sandbox.close();
```

### Opciones

| Opción | Qué hace | Por defecto |
|---|---|---|
| `-p`, `--port <n>` | El puerto. `0` toma uno libre. | `4010` |
| `--host <host>` | Dónde escucha. | `127.0.0.1` (en Docker, `0.0.0.0`) |
| `-c`, `--config <archivo>` | Un archivo de configuración en JSON. | `./funnelchat-sandbox.config.json`, si existe |
| `--status-delays <s,d,r>` | Segundos hasta `sent`, de ahí a `delivered` y de ahí a `read`. Un `-` corta ahí (por ejemplo `1,2,-`: nunca se lee). | `1,2,3` |
| `--retry-delays <a,b,c>` | Segundos entre los intentos de una entrega de webhook. | `60,300,1800`, como el portal |
| `--webhook-timeout <s>` | Lo que espera la respuesta de tu receptor. | `10` |
| `--require-https` | Solo acepta suscripciones `https`, como la API real. | apagado |
| `--no-window` | No aplica la ventana de 24 horas. | — |
| `--no-antiblock` | No aplica los frenos contra spam. | — |
| `--no-rate-limit` | No aplica el ritmo por número. | — |
| `--template-approval <s>` | Segundos hasta aprobar una plantilla creada por la API. Un `-` la deja pendiente. | `5` |
| `-q`, `--quiet` | Sin la línea por pedido y por entrega en la consola. | — |

Las opciones ganan sobre el archivo. El archivo tiene las mismas opciones y, además, suscripciones que se crean al arrancar (y después de cada reinicio) con un secreto fijo, para que tu receptor siga funcionando cuando reinicias el sandbox:

```json
{
  "statusDelays": { "sent": 1, "delivered": 2, "read": 3 },
  "webhooks": { "retryDelays": [5, 15, 30], "timeoutSeconds": 10 },
  "rules": { "window": true, "antiblock": true, "rateLimit": true },
  "subscriptions": [
    {
      "url": "http://localhost:3000/hooks/funnelchat",
      "events": ["message.received", "message.status_changed", "contact.created"],
      "secret": "whsec_desarrolloLocalNoUsarEnProduccion"
    }
  ]
}
```

Hay uno completo en [funnelchat-sandbox.config.example.json](funnelchat-sandbox.config.example.json). El archivo `funnelchat-sandbox.config.json` está en el `.gitignore`: no subas un secreto, aunque sea de prueba.

## La clave

Cualquier clave con la forma de una real sirve: `Authorization: Bearer <id>|fc_live_<letras y números>`, por ejemplo `1|fc_live_sandbox`. Sin clave, o con una mal formada, responde `401` como la API:

```json
{ "error": "unauthenticated", "message": "Falta la API key o no es válida." }
```

Todas las claves ven la misma cuenta y tienen todos los permisos.

**Cada respuesta trae `X-Request-Id`**, como la API: un UUID v4 distinto por pedido, también en los errores (`401`, `404 route_not_found`, `422`…) y en las rutas `/_sandbox`. Va solo en la cabecera, nunca en el cuerpo, y el que mandes en el pedido se ignora. El panel lo muestra junto a cada respuesta, para que lo cites como citarías el de la API.


## Apuntar los SDKs al sandbox

Cambia solo la URL base. Lo demás es igual que contra la API real.

**Node** ([funnelchat-node](https://github.com/Funnelchat20/funnelchat-node)):

```ts
import { Funnelchat } from '@funnelchat/sdk';

const funnelchat = new Funnelchat({ apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010' });
```

**PHP** ([funnelchat-php](https://github.com/Funnelchat20/funnelchat-php)):

```php
$funnelchat = new \Funnelchat\Funnelchat(apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010');
```

**El nodo de n8n** ([n8n-nodes-funnelchat](https://github.com/Funnelchat20/n8n-nodes-funnelchat)): en la credencial, **Entorno** «Personalizado» y **URL base** `http://localhost:4010` (o `http://host.docker.internal:4010` si n8n corre en Docker y el sandbox en tu máquina). El trigger crea su suscripción con `POST /api/v1/webhooks`, que el sandbox acepta en `http`. Como n8n no manda cabeceras propias, las fallas se arman antes con [`POST /_sandbox/failures`](#forzar-fallas).


## Qué hay adentro

Cada sesión arranca con esto:

| Qué | Id | Para qué |
|---|---|---|
| Número oficial (WhatsApp Cloud API) | `3` | Tiene ventana de 24 horas y ritmo, y es el único que toma formularios. `provider: 2`. |
| Número por QR | `4` | Sin ventana y sin ritmo. `provider: 1`. |
| Contacto «Contacto de ejemplo» | `2001` | Teléfono `5491100000000`. |
| Etiqueta «Cliente» | `4001` | |
| Plantilla `bienvenida`, aprobada, del número 3 | `45` | Una variable: «Hola {{1}}, gracias por escribirnos…». |

`POST /_sandbox/reset` vuelve a esto y cancela todo lo que estaba programado.

**Con estado** (lo que creas, cambias o borras queda): contactos (`/api/v1/contacts…`, con sus etiquetas, campos y la ventana `meta-window`), conversaciones (`/api/v1/conversations…`), mensajes (envío, historial, reacciones, reenvío, tarjetas y la consulta por id), etiquetas, campos personalizados, plantillas, [formularios de WhatsApp](#formularios-de-whatsapp), números (`GET /api/v1/devices`) y suscripciones de webhooks con su historial.

**Los números** son los de accounts: `GET /api/v1/devices` siempre pagina (`{data, links, meta}`, `perPage` de 1 a 100), y cada número trae `capabilities` con lo que la API puede hacer por él:

```json
{
  "messages": { "text": true, "media": true, "buttons": true, "lists": true, "templates": true, "location": true, "voice_note": true, "polls": false, "events": false, "contact_card": true, "reactions": false },
  "groups": { "create": false, "add_participants": false, "remove_participants": false, "admins": false, "photo": false, "settings": false, "invite_link": false, "send": false, "join_requests": false },
  "statuses": ["sent", "delivered", "read", "failed"]
}
```

El oficial (`3`) no tiene grupos (la cuenta del sandbox no está en la beta de grupos oficiales); el QR (`4`) sí, y no tiene plantillas. `health` es `null` en el QR.

**Las acciones de grupo por API** (crear un grupo, participantes, administradores, nombre, descripción, foto, ajustes, link de invitación, enviar al grupo y las solicitudes de unión) existen en communities pero están apagadas en producción: con cualquier clave responden `403 route_not_available`, igual que aquí. Lo mismo las encuestas y los eventos (`/message/poll`, `/message/event`).

```json
{ "error": "route_not_available", "message": "Esta ruta no está disponible para API keys en el piloto. No es un permiso que falte: ninguna key la habilita." }
```

**Todo lo demás** de la especificación (difusiones, flujos, kanban, grupos, campañas, alertas…) responde un ejemplo armado del esquema de la respuesta: las operaciones de la especificación no traen ejemplos propios. Igual se validan la clave, la ruta, la query y el cuerpo.

**La validación** sigue la especificación y lee los valores como Laravel (`"5"` sirve como entero, `"1"` como booleano). Un error de validación es un `422` con los mensajes de Laravel por campo; una ruta que no existe, `404 route_not_found`:

```json
{
  "error": "validation_failed",
  "message": "El campo device_id es obligatorio. (y 1 error más)",
  "errors": {
    "device_id": ["El campo device_id es obligatorio."],
    "contact_id": ["El campo contact_id es obligatorio."]
  }
}
```

**Lo que no existe en la cuenta** responde como cada dominio: en conversations (contactos, mensajes, etiquetas, campos, formularios) `404 {"message": "Objeto no encontrado."}`, sin `error`; en accounts (números) `404 {"message": "Object not found"}`.

La especificación completa que usa el sandbox está en `GET /_sandbox/openapi.json`.


## Enviar un mensaje

```bash
curl -s http://localhost:4010/api/v1/contacts/2001/message \
  -H 'Authorization: Bearer 1|fc_live_sandbox' -H 'Content-Type: application/json' \
  -d '{"device_id": 4, "contact_id": 2001, "phone": "5491100000000", "text": "¡Hola!", "client_reference": "pedido-8841"}'
```

```json
{
  "message": {
    "id": 9001,
    "contact_id": 2001,
    "device_id": 4,
    "direction": "outbound",
    "type": "text",
    "status": "queued",
    "error": null,
    "client_reference": "pedido-8841",
    "created_at": "2026-10-22T12:00:00Z",
    "updated_at": "2026-10-22T12:00:00Z"
  }
}
```

- **En cola no es enviado.** Después, a 1, 3 y 6 segundos (configurable), el mensaje pasa a `sent`, `delivered` y `read`, y cada cambio llega por `message.status_changed` con el mismo `message_id`, `previous_status` (`null` en el primero) y tu `client_reference`. `queued` nunca aparece en el evento.
- El estado actual se lee con `GET /api/v1/contacts/{contact}/messages/{message}` (el mismo objeto) y en el historial `GET /api/v1/contacts/{contactId}/messages`.
- Lo mismo vale para `POST /api/v1/message/send-message` (`{message}`), las plantillas (`POST /api/v1/devices/{device}/templates/{template}/send-template`, `{message}`), los formularios (`POST /api/v1/contacts/{contact}/message/form`, `{message}`), las tarjetas (`{messages: [...]}`, uno por tarjeta) y el reenvío (un ítem por destino, con su `message`, o `status: "blocked"` y `message: null`).
- `client_reference` es opcional: de 1 a 64 caracteres ASCII visibles, sin espacios. Si no cumple, `422 errors.client_reference`.
- Una nota (`"note": true`) se guarda con `status: null` y no se envía.
- El `id` de cada evento es el mismo para el mismo mensaje y el mismo estado: deduplica por `id`.

### Un archivo por URL

En `POST /contacts/{contact}/message` y `POST /message/send-message`, `file` es una URL `http(s)` (también firmada o sin extensión) o un nombre de archivo. El tipo sale de la extensión, como en conversations: `jpg`, `jpeg` y `png` son `image`; `webp`, `sticker`; `gif` y `mp4`, `video`; `ogg`, `oga`, `mp3`, `aac`, `m4a`, `opus` y `wav`, `audio`; `pdf`, `doc` y `docx`, `document`. Se mira la extensión del camino de la URL y, si no sirve, la de la URL entera (una URL firmada que termina en `.pdf`).

| Caso | Respuesta |
|---|---|
| La URL no dice su formato y no mandaste `file_type` | `422 errors.file_type`: «Tu archivo viene de una URL que no indica su formato: envía file_type con uno de estos valores: image, video, audio, document o sticker.» |
| `file_type: "document"`, la URL no termina en una extensión admitida y falta `file_name` con extensión | `422 errors.file_name`: «Para enviar un documento desde una URL que no termina en una de las extensiones admitidas, envía file_name con su extensión, por ejemplo factura.pdf.» |
| `file` mal formado o de más de 4096 caracteres | `422 errors.file` |
| Una extensión conocida pero no admitida (`.zip`) sin `file_type` | `415`: `{"error": "Unsupported file type: zip", "supported_file_types": [...]}`; en `send-message`, `{"status": "error", "error": "Unsupported file type: zip"}` |

`file_type` (`image`, `video`, `audio`, `document` o `sticker`) siempre gana a la extensión. El sandbox no descarga el archivo.

### Las reglas

Se aplican a cada envío con clave, en este orden, como en la API. El primero que rechaza gana; no se guarda ni se envía nada.

| Regla | Respuesta | Cuándo |
|---|---|---|
| Número sin conexión | `422 device_unavailable` | Después de `POST /_sandbox/devices/{id}/disconnect`. |
| Destinatario | `422 recipient_mismatch` | En `contacts/{contact}/message` y en las plantillas: el `phone` o `whatsapp_id` del cuerpo no es el del contacto de la ruta. |
| Destinatario | `422 recipient_unsupported` | El contacto es un grupo, una lista o un canal (`whatsapp_id` con `@g.us`, `@broadcast`…). |
| Ritmo | `429 rate_limited` con `Retry-After` | Número oficial: más de 60 mensajes por segundo (`Retry-After: 1`), o más de 10 al mismo contacto en el mismo minuto de reloj (`Retry-After`: lo que falta del minuto). Por QR no hay límite. |
| Ventana de 24 horas | `422 window_closed` | Número oficial, texto libre (no plantilla) y el contacto no escribió en las últimas 24 horas. |
| Frenos contra spam | `422 antiblock_duplicate_content` | El tercer envío del mismo contenido a un contacto que no respondió. |
| Frenos contra spam | `422 antiblock_unanswered_limit` | El sexto envío seguido a un contacto que no respondió. |
| MAC | `429 mac_lockout_24h`, sin `Retry-After` | La cuenta está en el bloqueo de 24 horas y el contacto no es activo del ciclo, o el contacto está inactivo por MAC (`POST /_sandbox/mac`). Las plantillas no tienen este freno; en el reenvío, ese destino vuelve `blocked` con `reason: "mac_lockout_24h"`. |

Un mensaje entrante del contacto abre la ventana de ese número y reinicia los frenos. Los mensajes de error son los de la API. Para apagar una regla: `--no-window`, `--no-antiblock`, `--no-rate-limit`.

Algunas rutas tienen sus propios cuerpos, como en conversations: `send-message` responde `404 {"status": "error", "error": "Contacto no encontrado."}` y `403 {"status": "error", "error": "No autorizado"}`; una plantilla que no existe es `404 template_not_found`, una de otro número `422 {"error": "La plantilla no pertenece al número actual", "error_code": "template_waba_mismatch"}`, y una con variables sin completar `422 template_unresolved_placeholder` con `placeholders` y `count`.

### Forzar fallas

**Que el envío responda un error** (`reject`), con cualquiera de los códigos de la tabla de arriba, `not_sent`, `recipient_unreachable` o `mac_limit_reached`:

```bash
curl … -H 'X-Sandbox-Reject: rate_limited'   # 429 con Retry-After: 6
```

**Que el envío se acepte y termine `failed`** (`fail`):

| Valor | Qué llega |
|---|---|
| Un motivo de Funnelchat: `window_closed`, `insufficient_balance`, `device_unavailable`, `recipient_unreachable`, `template_not_found`, `template_unresolved_placeholder`, `not_queued`, `not_sent` | Un solo `failed` con `previous_status: null` y `error: {code: null, title: <el texto de la API>, reason: <motivo>}`. |
| Un código de Meta, por ejemplo `131047`, `131026`, `131049` | `sent` y después `failed` con `error: {code: 131047, title: "Re-engagement message", reason: null}`. |

```bash
curl … -H 'X-Sandbox-Fail: window_closed'
```

**Que la entrada de la API falle** (`edge`), en cualquier ruta de `/api/v1`:

| `X-Sandbox-Edge` | Qué pasa |
|---|---|
| `origin_unreachable` | `502 {"error": "origin_unreachable", "message": "La API no está disponible en este momento."}`. El pedido no llegó: no se aplicó nada. |
| `origin_unreachable_applied` | El mismo `502`, pero la escritura **sí** se aplicó y solo se perdió la respuesta. Así pruebas la regla del portal: un `502` en una escritura se trata como un timeout, y se lee el estado antes de repetirla. |
| `edge_misconfigured` | `500 {"error": "edge_misconfigured", "message": "La API no está disponible en este momento."}` |

Ninguno trae `Retry-After`.

Si no puedes mandar cabeceras (por ejemplo desde n8n), arma las próximas fallas antes:

```bash
curl -s http://localhost:4010/_sandbox/failures -H 'Content-Type: application/json' \
  -d '{"mode": "fail", "code": "131047", "count": 1, "contact_id": 2001}'
curl -s http://localhost:4010/_sandbox/failures -H 'Content-Type: application/json' \
  -d '{"mode": "edge", "code": "origin_unreachable", "applied": true, "count": 1}'
```

`GET /_sandbox/failures` lista las armadas, `GET /_sandbox/failures/codes` los códigos que acepta cada modo y `DELETE /_sandbox/failures` las borra. También puedes mover un mensaje a mano: `POST /_sandbox/messages/{id}/status` con `{"status": "delivered"}` (o `"failed"` con `"error": "131026"`); nunca retrocede.

## Formularios de WhatsApp

Las rutas de conversations, con estado. Un formulario es una familia (`family_id`, la que envías) con versiones (`id`, la que editas). Solo los números oficiales los toman: con el QR, `422 NUMBER_NOT_ELIGIBLE`.

| Ruta | Qué hace |
|---|---|
| `GET /api/v1/forms/templates` | Las cinco plantillas para empezar: `blank`, `lead`, `appointment`, `nps`, `signup`. |
| `POST /api/v1/forms` | `{"device_id": 3, "template_key": "lead"}` (opcional `device_ids`): un borrador. `201` con `data`, `lint` y `numbers`. |
| `GET /api/v1/forms`, `GET /api/v1/forms/{id}` | El listado (una fila por formulario, con `sends` y `responses`) y una versión con `lint`, `versions` y `numbers`. |
| `PUT /api/v1/forms/{id}` | Guarda `definition` (y opcional `name`). Publicado: `409 PUBLISHED`. |
| `DELETE /api/v1/forms/{id}` | Un borrador (`204`). Publicado: `409 PUBLISHED`. |
| `POST /api/v1/forms/{id}/sync`, `…/publish` | Corre el linter y publica. Con errores, `422 LINT` con la lista. Los otros números pasan por `publishing` y quedan `published`. |
| `POST /api/v1/forms/{id}/versions` | Una versión nueva en borrador (`201`), o `200` con `created: false` si ya había una. |
| `GET`, `POST /api/v1/forms/{id}/numbers`, `DELETE …/numbers/{deviceId}`, `POST …/numbers/retry` | Los números del formulario. El principal no se quita: `422 PRIMARY_NUMBER`. |
| `GET /api/v1/forms/families/{familyId}/definition`, `…/versions`, `…/responses`, `…/responses/{runId}` | La definición vigente, las versiones y las respuestas. |
| `POST /api/v1/contacts/{contact}/message/form` | `{"form_id": <family_id>, "device_id": 3}` (opcional `text`, `button_text`, `client_reference`): `200` con el mensaje en cola, `type: "whatsapp_form"`. |

El envío sigue el orden de conversations: `device_unavailable`, `404 form_not_found`, `422 number_not_eligible`, `422 form_not_published`, `422 form_not_on_number`, `422 recipient_unreachable`, `422 window_closed`, y después el ritmo, los frenos y el MAC. La ventana se abre con un mensaje entrante.

**Que el contacto lo complete:**

```bash
curl -s http://localhost:4010/_sandbox/forms/complete -H 'Content-Type: application/json' \
  -d '{"message_id": 9002, "answers": {"nombre": "Ana", "volumen": "op_mas_de_quinientos"}}'
```

Emite `whatsapp_form.completed` una sola vez por envío, con `form` (`id` es el `family_id`, `version_id` la versión enviada), `message_id`, `contact_id`, `device_id` y `answers` (`{key, label, value}`, una por pregunta, en orden). Lo que no mandes en `answers` toma un valor de ejemplo; las opciones van por su id. También sirve `run_id`, o `contact_id` (el último envío pendiente de ese contacto).


## Webhooks

Te suscribes con las mismas rutas que usan los SDKs y el trigger de n8n (las suscripciones unificadas de accounts):

| Ruta | Qué hace |
|---|---|
| `POST /api/v1/webhooks` | Crea una suscripción. La respuesta (`201`) trae `secret` **una sola vez**. |
| `GET /api/v1/webhooks`, `GET /api/v1/webhooks/{id}` | Las lista o muestra, sin el secreto. |
| `PUT /api/v1/webhooks/{id}` | Cambia `url`, `events`, `description`, `filters` y, opcional, `status` (`active` o `paused`). El secreto no cambia. |
| `DELETE /api/v1/webhooks/{id}` | La borra (`204`). |
| `POST /api/v1/webhooks/{id}/rotate-secret` | Un secreto nuevo; el anterior deja de valer. |
| `POST /api/v1/webhooks/{id}/test` | Manda un `webhook.test` firmado ahora y responde `{succeeded, response_status, error, duration_ms, delivery_id}`. |
| `GET /api/v1/webhooks/{id}/deliveries` | El historial: un registro por intento, lo más reciente primero. |
| `GET /api/v1/webhooks/events` | El catálogo de accounts en producción: 54 tipos (49 `active`), con `area`, `status`, `is_critical`, `label`, `description` y `example`. |

**Cada entrega** es un `POST` con el sobre del portal y estas cabeceras:

```
Content-Type: application/json
X-Funnelchat-Signature: t=1792152000,v1=5f0c…
X-Funnelchat-Event: message.received
X-Funnelchat-Delivery: 7c9e6679-7425-40de-944b-e07fc1f90ae7
```

```json
{
  "id": "evt_6f1c2a9b0d3e4f5a6b7c8d9e",
  "type": "message.received",
  "version": 1,
  "occurred_at": "2026-10-16T12:00:00Z",
  "data": {
    "message": { "id": 9002, "type": "text", "text": "Hola, quiero más información", "media": null },
    "contact": { "id": 2001, "name": "Contacto de ejemplo", "phone": "+5491100000000" },
    "receiver": { "phone": "+5491100000001" },
    "device_id": 3
  }
}
```

- **La firma** es la del portal: `v1` es el HMAC-SHA256, con el secreto completo (con `whsec_`), de `"<t>." + cuerpo crudo`. Verifícala con `Funnelchat.webhooks.verify` (Node), `Webhook::verify` (PHP) o los snippets del portal. Los tests del sandbox la verifican con el `verify` del SDK de Node y con `verificar-firma.js` del portal, sobre los vectores de `tests/test_firmas.py`.
- **Los reintentos** son los del portal: hasta 4 intentos, esperando 60 s, 300 s y 1800 s (con `--retry-delays` los acortas). Se reintenta ante un error de red, un timeout (10 s), un `5xx` o un `429`; cualquier otro `4xx` o un `3xx` es definitivo. Cada intento lleva el mismo cuerpo y el mismo `id`, una firma nueva y otro `X-Funnelchat-Delivery`.
- **Cinco entregas fallidas seguidas** deshabilitan la suscripción (`status: disabled`, `disabled_reason: too_many_failures`), como en accounts. Un `PUT` con `"status": "active"` la vuelve a prender.
- El sandbox acepta URLs `http` y locales, para que apuntes a tu máquina. La API real solo acepta `https` públicas: pruébalo con `--require-https`.
- **Los eventos que emite solo el sandbox** son los de su estado: `message.received`, `message.status_changed`, `whatsapp_form.completed`, `contact.*`, `conversation.*`, `template.status_changed`, `device.*` y los que dispares desde `/_sandbox`. Cualquier otro tipo del catálogo se emite con `POST /_sandbox/events/{tipo}`.

## Simular lo que llega

Estas rutas no piden clave: son del sandbox, no de la API.

| Ruta | Qué simula |
|---|---|
| `POST /_sandbox/inbound/message` | Un contacto te escribe: `{"phone": "5491100000000", "device_id": 3, "text": "Hola"}` (o `contact_id`; opcional `name`, `type`, `file` y `occurred_at`). Si el teléfono es nuevo crea el contacto (`contact.created`); después emite `message.received` y abre la ventana de 24 horas de ese número. |
| `POST /_sandbox/groups/participant-joined`, `…/participant-left` | Alguien entra o sale de un grupo: `{"group": {"uid": "…@g.us", "name": "…"}, "participant": {"phone": "…", "name": "…"}}`. |
| `POST /_sandbox/forms/complete` | El contacto completa un formulario enviado: emite `whatsapp_form.completed` (ver [Formularios de WhatsApp](#formularios-de-whatsapp)). |
| `POST /_sandbox/mac`, `GET /_sandbox/mac` | El MAC de la cuenta: `{"lockout": true, "active_contact_ids": [2001], "inactive_contact_ids": []}`. Con `lockout`, los envíos a contactos que no son activos responden `429 mac_lockout_24h`; un contacto inactivo lo recibe siempre. |
| `POST /_sandbox/contacts/{id}/tags` con `{"tag_id": 4001}`, `DELETE /_sandbox/contacts/{id}/tags/{tag}` | Alguien etiqueta al contacto en el panel: `contact.tag_added` y `contact.tag_removed`. |
| `POST /_sandbox/devices/{id}/disconnect`, `…/connect` | El número se desconecta o se conecta: `device.disconnected` y `device.connected`. Desconectado, los envíos responden `422 device_unavailable`. |
| `POST /_sandbox/templates/{id}/status` | Meta aprueba o rechaza una plantilla: `{"status": "REJECTED", "reason": "…"}` emite `template.status_changed`. |
| `POST /_sandbox/events/{tipo}` | Cualquier evento del catálogo, con su ejemplo; lo que mandes en `{"data": {…}}` lo pisa. `GET /_sandbox/events` los lista. `group.message_received` y `group.reaction_added` salen con la forma que emite communities (`message.uid` y todas las claves del mensaje), no con el ejemplo del catálogo de accounts, que usa `message.id`. |
| `POST /_sandbox/window` | Abre o cierra a mano la ventana: `{"contact_id": 2001, "device_id": 3, "open": false}`. |
| `POST /_sandbox/reset` | Vuelve al estado inicial. |
| `GET /_sandbox/state`, `/_sandbox/requests`, `/_sandbox/deliveries` | El estado, los últimos pedidos y las últimas entregas con lo que respondió tu servidor. |

Además, como en la API: crear un contacto emite `contact.created`, cerrar una conversación (`active_conversation: false`) emite `conversation.closed`, asignarla emite `conversation.assigned`, y una plantilla creada por la API pasa de `PENDING` a `APPROVED` a los 5 segundos con `template.status_changed`.

**El panel** está en `http://localhost:4010/_sandbox`: los últimos pedidos, las entregas de webhooks con la respuesta de tu servidor, y un formulario para mandar un mensaje entrante.

## De punta a punta

Un receptor con Express que verifica la firma con el SDK, una suscripción, un mensaje entrante y la respuesta con sus estados.

```bash
npx funnelchat-sandbox --status-delays 1,1,1
```

```ts
// receptor.ts
import express from 'express';
import { Funnelchat, WebhookVerificationError } from '@funnelchat/sdk';

const funnelchat = new Funnelchat({ apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010' });
const app = express();
let secret = '';

app.post('/hooks/funnelchat', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = Funnelchat.webhooks.constructEvent(req.body, req.get('X-Funnelchat-Signature'), secret);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(400);
    throw error;
  }
  res.sendStatus(200);

  if (event.type === 'message.received') {
    // Le contestamos por el mismo número: con el oficial, la ventana ya está abierta.
    const { message } = await funnelchat.messages.send(event.data.contact.id, {
      device_id: event.data.device_id!,
      phone: event.data.contact.phone!.replace('+', ''),
      text: '¡Gracias por escribirnos!',
      client_reference: `respuesta-${event.data.message.id}`,
    });
    console.log('enviado', message.id, message.status); // queued
  }
  if (event.type === 'message.status_changed') {
    console.log('estado', event.data.message_id, event.data.status, event.data.client_reference);
  }
});

app.listen(3000, async () => {
  const subscription = await funnelchat.webhooks.create({
    url: 'http://localhost:3000/hooks/funnelchat',
    events: ['message.received', 'message.status_changed'],
  });
  secret = subscription.secret; // se muestra una sola vez
  console.log('suscripción', subscription.id);
});
```

```bash
# Un contacto escribe a tu número oficial:
curl -s http://localhost:4010/_sandbox/inbound/message -H 'Content-Type: application/json' \
  -d '{"phone": "5491100000000", "device_id": 3, "text": "Hola, ¿tienen stock?"}'
```

En la consola del receptor:

```
enviado 9002 queued
estado 9002 sent respuesta-9001
estado 9002 delivered respuesta-9001
estado 9002 read respuesta-9001
```

Y en `http://localhost:4010/_sandbox` ves cada pedido y cada entrega con lo que respondió tu receptor.

## Qué no imita

- **No manda nada a WhatsApp** y no cobra: los estados `sent`, `delivered` y `read` los inventa el sandbox, con las demoras que configures. En la API real, un mensaje que sigue `queued` después de una hora se lee con `status: null`; en el sandbox siempre avanza.
- **Una sola cuenta y todos los permisos:** cualquier clave bien formada entra, no se revoca y no hay `403 permission_denied`. Las claves de API no se crean aquí, y las suscripciones no se filtran por las áreas de la clave (la API real responde `422` en `events` si la clave no tiene `{área}:read` del evento). El único `403 route_not_available` es el de las rutas que ninguna clave habilita.
- **No hay topes diarios de llamadas** (`429 daily_cap_exceeded`), ni `503 gate_unavailable`, ni saldo: para probar esos casos, fuerza la falla. Del MAC está el bloqueo (`429 mac_lockout_24h`); `429 mac_limit_reached` solo se fuerza, y la API real además guarda en el historial una fila de error por cada envío frenado por MAC, que el sandbox no guarda.
- **El estado es solo memoria:** se pierde al cerrar el proceso o con `POST /_sandbox/reset`. Para que tu receptor no pierda el secreto, pon la suscripción en el archivo de configuración.
- **Las rutas sin estado** responden un ejemplo armado del esquema, siempre el mismo, aunque no corresponda a tus datos.
- **Los mensajes de validación** son los de Laravel en castellano, armados desde el esquema: pueden no coincidir palabra por palabra con los de la API (decide por el código HTTP y por `error`, no por `message`). El `422` de validación de la API real es el de Laravel, `{message, errors}`, sin `error`; el sandbox suma `"error": "validation_failed"`.
- **Las URLs de webhook** pueden ser `http` y locales, sin la protección contra destinos internos de la API real (prueba con `--require-https`). No expongas el sandbox a internet: las rutas `/_sandbox` no piden clave y el sandbox le hace `POST` a cualquier URL que le suscriban.
- **El catálogo** está transcrito del código de accounts v1.4.24 (`spec/catalog.json`), no leído de una respuesta: si accounts lo cambia, hay que transcribirlo de nuevo.
- **No hay grupos ni campañas con estado:** sus eventos se disparan desde `/_sandbox`, las acciones de grupo responden `403 route_not_available` como en producción, y las demás rutas responden ejemplos.
- **Los formularios no hablan con Meta:** `sync` y `publish` salen bien salvo que el linter encuentre un error, y el linter es una versión corta del real (pantallas sin título, sin final, sin preguntas, con conexión al servidor). No hay métricas (`…/metrics`) ni formularios dinámicos.
- **Los archivos no se descargan:** el tipo sale de la extensión o de `file_type`. Las extensiones «conocidas» (las que dan `415` en vez de `422 errors.file_type`) son las comunes; la API usa la lista completa de symfony/mime.
- **El ritmo y los frenos** usan los números de conversations en producción (`config/send_guards.php`, `config/antiblock.php`); el par oficial con QR en coexistencia (15 por segundo compartidos) no está.

## Pendiente de la especificación

La instantánea de la especificación (`spec/funnelchat.json`) es la del portal del 15-10. Lo que salió a producción después, o lo que el portal todavía no documenta, está en dos capas aparte que la próxima regeneración reemplaza sola cuando la instantánea lo traiga:

- `spec/pending.json`: la capa pendiente del SDK de Node, copiada sin cambios (`funnelchat-node` `feat/inicial` @ `88557ce`).
- `spec/pending-sandbox.json`: lo que suma el sandbox, con sus fuentes adentro.

Además, `spec/catalog.json` es el catálogo de eventos de accounts v1.4.24, con su procedencia.

| Qué | De dónde sale | Estado |
|---|---|---|
| Suscripciones de webhooks: `/api/v1/webhooks`, `/{id}`, `rotate-secret`, `test`, `deliveries` | accounts v1.4.24 | En producción. |
| El envío con clave: `200` con el mensaje en cola, `GET /api/v1/contacts/{contact}/messages/{message}`, `client_reference`, `error.reason` y los errores de las reglas | conversations v1.18.10 | En producción desde el 21-10. |
| `message.status_changed` y `device_id` en `message.received` | conversations v1.18.10 | En producción; `message.status_changed` figura `active`. |
| El archivo por URL: `file_type`, `file_name`, sus `422` y el `415` | conversations v1.18.10 (`SendFileType`) | En producción. |
| Los formularios: `/api/v1/forms…`, `POST /api/v1/contacts/{contact}/message/form` y `whatsapp_form.completed` | conversations v1.18.10 | En producción. El portal todavía no los documenta. |
| Las acciones de grupo y las solicitudes de unión, apagadas (`403 route_not_available`) | communities v2.34.52 | En producción, apagadas. |
| `capabilities` y las claves nuevas de los números | accounts v1.4.24 (`DeviceResource`, `DeviceCapabilities`) | En producción. |
| `X-Request-Id` y los errores de la entrada (`route_not_found`, `origin_unreachable`, `edge_misconfigured`) | api-edge v0.3.0, platform-gate v0.8.0 | En producción. |

## Cómo regenerar

Todo lo generado sale de un solo script:

```bash
# Con una instantánea nueva del portal (la genera `npm run datos` en developers-portal):
npm run generate -- --spec ../developers-portal/public/specs/funnelchat.json

# Con una capa pendiente nueva del SDK de Node:
npm run generate -- --pending ../funnelchat-node/spec/pending.json

# Con lo que ya está en spec/ (por ejemplo, después de tocar spec/pending-sandbox.json):
npm run generate

# Para comprobar que generated/ está al día (sirve en CI):
npm run generate:check
```

Qué hace:

1. Con `--spec` o `--pending`, copia el archivo a `spec/` y anota en `spec/procedencia.json` el repositorio, la rama, el commit, la fecha y el `sha256`.
2. Aplica sobre la instantánea `spec/pending.json` y después `spec/pending-sandbox.json`, pero **solo lo que la instantánea no trae**. Al terminar lista lo que ya trae, para que lo borres.
3. Escribe `generated/openapi.json`, la especificación con la que el sandbox valida y responde.

**La instantánea actual** es la del portal del 15-10 (rama `feat/openapi-unificada` @ `0ef4abb`, hoy mergeada): 191 rutas y 230 operaciones de conversations `9d723d52c`, communities `fab0bb10` y accounts `c234b6f8`. El detalle está en `spec/procedencia.json`.

## Desarrollo

```bash
npm install
npm run generate:check   # generated/ está al día
npm run typecheck        # tsc
npm run lint
npm test                 # vitest, sin red: los receptores son servidores locales
npm run build            # dist/ en ESM, con .d.ts
```

Los tests verifican las entregas con copias sin cambios del `verify` del SDK de Node y del snippet del portal (`test/vendor/`, con su procedencia). Si el repo `funnelchat-node` está al lado de este (o en `FUNNELCHAT_NODE_SDK`), además corren contra su código actual, incluido el cliente entero apuntado al sandbox.

```
spec/            la especificación, su procedencia, las dos capas pendientes y el catálogo de eventos
scripts/         generate.mjs, el único generador
generated/       la especificación unida (no se edita)
src/openapi/     rutas, validación y ejemplos desde la especificación
src/handlers/    las rutas con estado (contactos, mensajes, formularios, webhooks) y las cerradas por el portero
src/forms/       las plantillas de los formularios
src/messaging/   reglas de envío, archivo por URL, fallas forzadas y estados del mensaje
src/webhooks/    firma, catálogo, entregas y reintentos
src/sandbox/     las rutas /_sandbox y el panel
test/            vitest
```

## Licencia

[MIT](LICENSE).
