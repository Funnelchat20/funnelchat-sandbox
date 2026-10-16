# funnelchat-sandbox

Un servidor local que imita la API pública de Funnelchat y manda webhooks firmados, sin efectos reales. Sirve para desarrollar y probar tu integración sin una cuenta real, sin WhatsApp y sin gastar nada: nada sale a WhatsApp, todo queda en memoria.

- Las mismas rutas, los mismos cuerpos y los mismos errores que la API, sacados de la especificación unificada del portal.
- Un estado en memoria para un flujo real: contactos, conversaciones y mensajes, etiquetas, campos personalizados, plantillas y suscripciones de webhooks.
- El envío responde al instante con el mensaje en cola y después avisa `sent`, `delivered` y `read` por `message.status_changed`.
- Webhooks firmados con el algoritmo exacto del portal, con sus reintentos.
- Las reglas de WhatsApp que hoy aplica la API: la ventana de 24 horas en números oficiales, los frenos contra spam y el ritmo por número.

> **Estado: v0, en desarrollo.** La API pública está en v0 y cambia sin aviso. El paquete todavía no está publicado en npm (está marcado `private` para que no se publique por accidente). Algunas piezas vienen de ramas sin mergear: están en [Pendiente de la especificación](#pendiente-de-la-especificación).

## Arrancarlo

Necesitás Node 20.11 o posterior.

```bash
git clone git@github.com:Funnelchat20/funnelchat-sandbox.git
cd funnelchat-sandbox
npm install
npm run build
npx funnelchat-sandbox
```

```
funnelchat-sandbox 0.1.0 en http://127.0.0.1:4010
  API:    http://127.0.0.1:4010/api/v1/...   (Authorization: Bearer 1|fc_live_sandbox, o cualquier clave bien formada)
  panel:  http://127.0.0.1:4010/_sandbox
  números de ejemplo: 3 (oficial, con ventana de 24 h) y 4 (QR, sin ventana); contacto 2001; plantilla 45
```

Cuando se publique, alcanza con `npx funnelchat-sandbox` desde cualquier carpeta.

**Con Docker:**

```bash
docker build -t funnelchat-sandbox .
docker run --rm -p 4010:4010 funnelchat-sandbox
# con tu configuración:
docker run --rm -p 4010:4010 -v "$PWD/funnelchat-sandbox.config.json:/app/funnelchat-sandbox.config.json:ro" funnelchat-sandbox
```

Dentro del contenedor escucha en `0.0.0.0`. Si tu receptor de webhooks corre en tu máquina, desde el contenedor es `http://host.docker.internal:<puerto>` (en Linux, agregá `--add-host=host.docker.internal:host-gateway`).

**Desde tus tests**, sin otro proceso:

```ts
import { createSandbox } from 'funnelchat-sandbox';

const sandbox = createSandbox({ config: { port: 0, log: false, statusDelays: { sent: 0.05, delivered: 0.05, read: 0.05 } } });
const { url } = await sandbox.listen(); // port 0: un puerto libre
// … apuntá tu SDK a `url` …
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

Las opciones ganan sobre el archivo. El archivo tiene las mismas opciones y, además, suscripciones que se crean al arrancar (y después de cada reinicio) con un secreto fijo, para que tu receptor siga funcionando cuando reiniciás el sandbox:

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

## Apuntar los SDKs al sandbox

Cambiá solo la URL base. Lo demás es igual que contra la API real.

**Node** ([funnelchat-node](https://github.com/Funnelchat20/funnelchat-node)):

```ts
import { Funnelchat } from '@funnelchat/sdk';

const funnelchat = new Funnelchat({ apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010' });
```

**PHP** ([funnelchat-php](https://github.com/Funnelchat20/funnelchat-php)):

```php
$funnelchat = new \Funnelchat\Funnelchat(apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010');
```

**El nodo de n8n** ([n8n-nodes-funnelchat](https://github.com/Funnelchat20/n8n-nodes-funnelchat)): en la rama `feat/inicial` @ `618d148` la credencial solo ofrece los entornos «Producción» y «Staging»; **todavía no tiene una URL base propia**, así que hoy no se puede apuntar al sandbox. Mientras tanto, para probar un flujo de n8n contra el sandbox:

- los pedidos, con el nodo «HTTP Request»: URL `http://localhost:4010/api/v1/...` (o `http://host.docker.internal:4010/...` si n8n corre en Docker) y la cabecera `Authorization: Bearer 1|fc_live_sandbox`;
- los eventos, con un nodo «Webhook» de n8n: creá la suscripción a su URL con `POST /api/v1/webhooks` (el sandbox acepta `http`) y verificá la firma con el secreto que te devuelve.

Cuando la credencial tenga una URL base, va a alcanzar con poner `http://localhost:4010` ahí.

## Qué hay adentro

Cada sesión arranca con esto:

| Qué | Id | Para qué |
|---|---|---|
| Número oficial (WhatsApp Cloud API) | `3` | Tiene ventana de 24 horas y ritmo. `provider: 2`. |
| Número por QR | `4` | Sin ventana y sin ritmo. `provider: 1`. |
| Contacto «Contacto de ejemplo» | `2001` | Teléfono `5491100000000`. |
| Etiqueta «Cliente» | `4001` | |
| Plantilla `bienvenida`, aprobada, del número 3 | `45` | Una variable: «Hola {{1}}, gracias por escribirnos…». |

`POST /_sandbox/reset` vuelve a esto y cancela todo lo que estaba programado.

**Con estado** (lo que creás, cambiás o borrás queda): contactos (`/api/v1/contacts…`, con sus etiquetas, campos y la ventana `meta-window`), conversaciones (`/api/v1/conversations…`), mensajes (envío, historial, reacciones, reenvío, tarjetas y la consulta por id), etiquetas, campos personalizados, plantillas, números (`GET /api/v1/devices`) y suscripciones de webhooks con su historial.

**Todo lo demás** de la especificación (difusiones, flujos, kanban, grupos, campañas, alertas…) responde un ejemplo armado del esquema de la respuesta: las operaciones de la especificación no traen ejemplos propios. Igual se validan la clave, la ruta, la query y el cuerpo.

**La validación** sigue la especificación y lee los valores como Laravel (`"5"` sirve como entero, `"1"` como booleano). Un error de validación es un `422` con los mensajes de Laravel por campo; un parámetro de ruta que no corresponde, un `404`; una ruta que no existe, `404 route_not_found`:

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
    "created_at": "2026-10-16T12:00:00Z",
    "updated_at": "2026-10-16T12:00:00Z"
  }
}
```

- **En cola no es enviado.** Después, a 1, 3 y 6 segundos (configurable), el mensaje pasa a `sent`, `delivered` y `read`, y cada cambio llega por `message.status_changed` con el mismo `message_id`, `previous_status` (`null` en el primero) y tu `client_reference`. `queued` nunca aparece en el evento.
- El estado actual se lee con `GET /api/v1/contacts/{contact}/messages/{message}` (el mismo objeto) y en el historial `GET /api/v1/contacts/{contactId}/messages`.
- Lo mismo vale para `POST /api/v1/message/send-message` (`{message}`), las plantillas (`POST /api/v1/devices/{device}/templates/{template}/send-template`, `{message}`), las tarjetas (`{messages: [...]}`, uno por tarjeta) y el reenvío (cada ítem trae su `message`).
- Una nota (`"note": true`) se guarda con `status: null` y no se envía.
- El `id` de cada evento es el mismo para el mismo mensaje y el mismo estado: deduplicá por `id`.

> Esta respuesta es **pendiente de la especificación**: la está terminando conversations (rama `feat/envio-devuelve-id`, sin mergear). La instantánea del portal todavía documenta `204` sin cuerpo, y los SDKs tienen `send` sin valor de retorno: el de Node devuelve el cuerpo igual; el de PHP lo descarta hasta que se regenere.

### Las reglas

Se aplican a cada envío con clave, en este orden, como en la API. El primero que rechaza gana; no se guarda ni se envía nada.

| Regla | Respuesta | Cuándo |
|---|---|---|
| Número sin conexión | `422 device_unavailable` | Después de `POST /_sandbox/devices/{id}/disconnect`. |
| Destinatario | `422 recipient_mismatch` | El `phone` o `whatsapp_id` del cuerpo no es el del contacto de la ruta. |
| Destinatario | `422 recipient_unsupported` | El contacto es un grupo, una lista o un canal (`whatsapp_id` con `@g.us`, `@broadcast`…). |
| Ritmo | `429 rate_limited` con `Retry-After` | Número oficial: más de 10 mensajes por minuto al mismo contacto, o más de 60 por segundo. Por QR no hay límite. |
| Ventana de 24 horas | `422 window_closed` | Número oficial, texto libre (no plantilla) y el contacto no escribió en las últimas 24 horas. |
| Frenos contra spam | `422 antiblock_duplicate_content` | El tercer envío del mismo contenido a un contacto que no respondió. |
| Frenos contra spam | `422 antiblock_unanswered_limit` | El sexto envío seguido a un contacto que no respondió. |

Un mensaje entrante del contacto abre la ventana de ese número y reinicia los frenos. Los mensajes de error son los de la API. Para apagar una regla: `--no-window`, `--no-antiblock`, `--no-rate-limit`.

### Forzar fallas

**Que el envío responda un error** (`reject`), con cualquiera de los códigos de la tabla de arriba:

```bash
curl … -H 'X-Sandbox-Reject: rate_limited'   # 429 con Retry-After: 6
```

**Que el envío se acepte y termine `failed`** (`fail`):

| Valor | Qué llega |
|---|---|
| Un motivo de Funnelchat: `window_closed`, `insufficient_balance`, `device_unavailable`, `recipient_unreachable`, `template_not_found`, `template_unresolved_placeholder`, `not_queued`, `not_sent` | Un solo `failed` con `previous_status: null` y `error: {code: null, title: <texto>, reason: <motivo>}`. |
| Un código de Meta, por ejemplo `131047`, `131026`, `131049` | `sent` y después `failed` con `error: {code: 131047, title: "Re-engagement message", reason: null}`. |

```bash
curl … -H 'X-Sandbox-Fail: window_closed'
```

Si no podés mandar cabeceras (por ejemplo desde n8n), armá las próximas fallas antes:

```bash
curl -s http://localhost:4010/_sandbox/failures -H 'Content-Type: application/json' \
  -d '{"mode": "fail", "code": "131047", "count": 1, "contact_id": 2001}'
```

`GET /_sandbox/failures` lista las armadas y `DELETE /_sandbox/failures` las borra. También podés mover un mensaje a mano: `POST /_sandbox/messages/{id}/status` con `{"status": "delivered"}` (o `"failed"` con `"error": "131026"`); nunca retrocede.

## Webhooks

Te suscribís con las mismas rutas que usan los SDKs y el trigger de n8n (las suscripciones unificadas de accounts):

| Ruta | Qué hace |
|---|---|
| `POST /api/v1/webhooks` | Crea una suscripción. La respuesta (`201`) trae `secret` **una sola vez**. |
| `GET /api/v1/webhooks`, `GET /api/v1/webhooks/{id}` | Las lista o muestra, sin el secreto. |
| `PUT /api/v1/webhooks/{id}` | Cambia `url`, `events`, `description`, `filters` y, opcional, `status` (`active` o `paused`). El secreto no cambia. |
| `DELETE /api/v1/webhooks/{id}` | La borra (`204`). |
| `POST /api/v1/webhooks/{id}/rotate-secret` | Un secreto nuevo; el anterior deja de valer. |
| `POST /api/v1/webhooks/{id}/test` | Manda un `webhook.test` firmado ahora y responde `{succeeded, response_status, error, duration_ms, delivery_id}`. |
| `GET /api/v1/webhooks/{id}/deliveries` | El historial: un registro por intento, lo más reciente primero. |
| `GET /api/v1/webhooks/events` | El catálogo, con `status` (`active` o `planned`) de cada tipo. |

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

- **La firma** es la del portal: `v1` es el HMAC-SHA256, con el secreto completo (con `whsec_`), de `"<t>." + cuerpo crudo`. Verificala con `Funnelchat.webhooks.verify` (Node), `Webhook::verify` (PHP) o los snippets del portal. Los tests del sandbox la verifican con el `verify` del SDK de Node y con `verificar-firma.js` del portal, sobre los vectores de `tests/test_firmas.py`.
- **Los reintentos** son los del portal: hasta 4 intentos, esperando 60 s, 300 s y 1800 s (con `--retry-delays` los acortás). Se reintenta ante un error de red, un timeout (10 s), un `5xx` o un `429`; cualquier otro `4xx` o un `3xx` es definitivo. Cada intento lleva el mismo cuerpo y el mismo `id`, una firma nueva y otro `X-Funnelchat-Delivery`.
- **Cinco entregas fallidas seguidas** deshabilitan la suscripción (`status: disabled`, `disabled_reason: too_many_failures`), como en accounts. Un `PUT` con `"status": "active"` la vuelve a prender.
- El sandbox acepta URLs `http` y locales, para que apuntes a tu máquina. La API real solo acepta `https` públicas: probalo con `--require-https`.

## Simular lo que llega

Estas rutas no piden clave: son del sandbox, no de la API.

| Ruta | Qué simula |
|---|---|
| `POST /_sandbox/inbound/message` | Un contacto te escribe: `{"phone": "5491100000000", "device_id": 3, "text": "Hola"}` (o `contact_id`; opcional `name`, `type`, `file` y `occurred_at`). Si el teléfono es nuevo crea el contacto (`contact.created`); después emite `message.received` y abre la ventana de 24 horas de ese número. |
| `POST /_sandbox/groups/participant-joined`, `…/participant-left` | Alguien entra o sale de un grupo: `{"group": {"uid": "…@g.us", "name": "…"}, "participant": {"phone": "…", "name": "…"}}`. |
| `POST /_sandbox/contacts/{id}/tags` con `{"tag_id": 4001}`, `DELETE /_sandbox/contacts/{id}/tags/{tag}` | Alguien etiqueta al contacto en el panel: `contact.tag_added` y `contact.tag_removed`. |
| `POST /_sandbox/devices/{id}/disconnect`, `…/connect` | El número se desconecta o se conecta: `device.disconnected` y `device.connected`. Desconectado, los envíos responden `422 device_unavailable`. |
| `POST /_sandbox/templates/{id}/status` | Meta aprueba o rechaza una plantilla: `{"status": "REJECTED", "reason": "…"}` emite `template.status_changed`. |
| `POST /_sandbox/events/{tipo}` | Cualquier evento del catálogo, con su ejemplo; lo que mandes en `{"data": {…}}` lo pisa. `GET /_sandbox/events` los lista. |
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
    const { message } = (await funnelchat.messages.send(event.data.contact.id, {
      device_id: event.data.device_id!,
      phone: event.data.contact.phone.replace('+', ''),
      text: '¡Gracias por escribirnos!',
      client_reference: `respuesta-${event.data.message.id}`,
    })) as unknown as { message: { id: number; status: string } };
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

- **No manda nada a WhatsApp** y no cobra: los estados `sent`, `delivered` y `read` los inventa el sandbox, con las demoras que configures.
- **Una sola cuenta y todos los permisos:** cualquier clave bien formada entra, no se revoca y no hay `403 permission_denied` ni `route_not_available`. Las claves de API no se crean acá.
- **No hay topes diarios de llamadas** (`429 daily_cap_exceeded`), ni MAC (`429 mac_*`), ni saldo: para probar esos casos, forzá la falla.
- **El estado es solo memoria:** se pierde al cerrar el proceso o con `POST /_sandbox/reset`. Para que tu receptor no pierda el secreto, poné la suscripción en el archivo de configuración.
- **Las rutas sin estado** responden un ejemplo armado del esquema, siempre el mismo, aunque no corresponda a tus datos.
- **Los mensajes de validación** son los de Laravel en castellano, armados desde el esquema: pueden no coincidir palabra por palabra con los de la API (decidí por el código HTTP y por `error`, no por `message`). El `422` de validación de la API real hoy es el de Laravel, `{message, errors}`, sin `error`; el sandbox suma `"error": "validation_failed"`.
- **Las URLs de webhook** pueden ser `http` y locales, sin la protección contra destinos internos de la API real (probá con `--require-https`). No expongas el sandbox a internet: las rutas `/_sandbox` no piden clave y el sandbox le hace `POST` a cualquier URL que le suscriban.
- **El catálogo** sale de la especificación: `label` es el tipo y `is_critical` siempre `false`. `message.status_changed` figura `planned`, como en la API real, pero el sandbox lo emite.
- **No hay grupos ni campañas con estado:** sus eventos se disparan desde `/_sandbox`, y sus rutas responden ejemplos.
- **Formatos de archivo, enlaces y botones** no se verifican: un `file` se guarda tal cual y su tipo sale de la extensión.
- **El ritmo y los frenos** usan los números del contrato 1014 y del portal; la API real puede afinarlos.

## Pendiente de la especificación

Esto ya está en la API, o en una rama sin mergear, pero la instantánea de la especificación todavía no lo trae. Está en dos capas aparte que la próxima regeneración reemplaza sola cuando la instantánea lo traiga:

- `spec/pending.json`: la capa pendiente del SDK de Node, copiada sin cambios (`funnelchat-node` `feat/inicial` @ `88557ce`).
- `spec/pending-sandbox.json`: lo que suma el sandbox, con sus fuentes adentro. En el código, lo pendiente está marcado `PENDING OF THE SPEC`.

| Qué | De dónde sale | Estado |
|---|---|---|
| Suscripciones de webhooks: `/api/v1/webhooks`, `/{id}`, `rotate-secret`, `test`, `deliveries`, y los eventos de accounts | accounts `origin/main` (capa del SDK, @ `c34cba2c`; revisado de nuevo en @ `18bdc8a4`) | En producción desde el 13-10 (accounts #978). |
| El envío con clave y sus errores (`window_closed`, `antiblock_*`, `recipient_*`, `rate_limited`), y `client_reference` | conversations `feat/armar-funnelchat-f1` @ `eadef46c` (PR #2284), contrato 1014 C2 | **Sin mergear.** Hasta que se despliegue, la API real responde `403 route_not_available` a los envíos con clave. |
| La forma de `message.status_changed` | conversations `feat/armar-funnelchat-f1` @ `eadef46c` (PR #2284), contrato 1014 C1 | **Sin mergear.** Figura `planned`: la API real todavía no lo emite. |
| `device_id` en `message.received` | conversations `feat/armar-funnelchat-f1` @ `eadef46c` (PR #2284) | **Sin mergear.** |
| La respuesta del envío con el mensaje en cola (`{message: {id, status: "queued", …}}`), `GET /api/v1/contacts/{contact}/messages/{message}`, `error.reason` y `422 device_unavailable` | conversations `feat/envio-devuelve-id` @ `d3ac33994` (change de OpenSpec `api-send-queued-with-message-id`) | **Sin mergear y en desarrollo:** al 16-10 es una rama local, sin push ni PR. La forma puede cambiar. |

## Cómo regenerar

Todo lo generado sale de un solo script:

```bash
# Con una instantánea nueva del portal:
npm run generate -- --spec ../developers-portal-worktrees/<rama>/out/specs/funnelchat.json

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

**La instantánea actual** es la del portal, rama `feat/openapi-unificada` @ `0ef4abb` (PR developers-portal #11, sin mergear), del 15-10: 191 rutas y 230 operaciones de conversations `9d723d52c`, communities `fab0bb10` y accounts `c234b6f8`. El detalle está en `spec/procedencia.json`.

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
spec/            la especificación, su procedencia y las dos capas pendientes
scripts/         generate.mjs, el único generador
generated/       la especificación unida (no se edita)
src/openapi/     rutas, validación y ejemplos desde la especificación
src/handlers/    las rutas con estado
src/messaging/   reglas de envío, fallas forzadas y estados del mensaje
src/webhooks/    firma, catálogo, entregas y reintentos
src/sandbox/     las rutas /_sandbox y el panel
test/            vitest
```
