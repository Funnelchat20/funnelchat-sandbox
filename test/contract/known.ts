/**
 * Las diferencias conocidas entre el sandbox y la spec publicada (spec/funnelchat.json), cada una con su porqué. Ver
 * test/contract.test.ts. La clave es la que arma la prueba; el texto empieza por quién tiene razón:
 *
 * - `spec:` la spec publicada dice algo que producción no hace, y el sandbox sigue a producción (conversations y accounts
 *   en origin/main). Se corrige en la spec, no aquí.
 * - `sandbox:` el sandbox difiere de producción y de la spec. Pendiente: fuera de este cambio.
 * - `sin verificar:` el sandbox difiere de la spec y todavía no se contrastó con el backend.
 */
export const KNOWN: Record<string, string> = {
  // --- Lo que este cambio hizo fiel a producción: la spec publicada todavía dice otra cosa ---------------------------
  'POST /api/v1/contacts → 201 no declarado':
    'spec: un contacto nuevo responde 201 (ContactController::store devuelve un JsonResource de un modelo recién creado); la spec solo declara 200.',
  'POST /api/v1/contacts/update-or-create → 201 no declarado':
    'spec: crear responde 201 y actualizar 200 (ContactController::updateOrCreate, JsonResource con wasRecentlyCreated); la spec solo declara 200.',
  'POST /api/v1/templates → 201 no declarado':
    'spec: crear una plantilla responde 201 (MessageTemplateController::store, `new Template` + save()); la spec solo declara 200.',
  'POST /api/v1/templates acepta un pedido que la spec no':
    'spec: `params` es un objeto {body: {"1": campo}, samples: {body: {"1": ejemplo}}} (TemplateParams, TemplateParamsComplete); la spec lo tipa como lista de textos, que producción rechaza con 422.',
  'POST /api/v1/templates → 422 cuerpo':
    'spec: un `device_id` que no es de la cuenta responde 422 {error: "validation_failed", message: "Device not found", error_code: "device_not_found"} sin `errors` (StoreMessageTemplateRequest); la spec no lo documenta.',
  'GET /api/v1/templates/{template} → 200 cuerpo':
    'spec: `params` sale en la forma canónica, un objeto (TemplateResource + TemplateParams::canonicalize); la spec dice lista o "".',

  // --- El sandbox difiere de producción (anotado, fuera de este cambio) ----------------------------------------------
  'GET /api/v1/contacts → 200 cuerpo':
    'sandbox: ContactResource escribe `email`, `whatsapp_id` e `image` con `?? \'\'` (texto vacío); el sandbox manda null. Además `custom_fields[].description` es null en el sandbox.',
  'GET /api/v1/contacts/{contact} → 200 cuerpo': 'sandbox: igual que GET /contacts: `email`, `whatsapp_id` e `image` son "" en producción, null en el sandbox.',
  'POST /api/v1/contacts/update-or-create → 200 cuerpo': 'sandbox: igual que GET /contacts: `whatsapp_id`, `image` y `custom_fields[].description`.',
  'GET /api/v1/contacts/{contact}/custom-fields → 200 cuerpo':
    'sandbox: `type` es el entero del campo en ContactCustomFieldResource y el sandbox lo manda como texto; `description` puede ser null en producción también (la spec dice texto: sin verificar).',
  'GET /api/v1/contacts/{contact}/tags → 200 cuerpo': 'sandbox: ContactTagResource trae `is_system` y `description ?? \'\'`; el sandbox no trae `is_system` y manda null.',
  'GET /api/v1/tags → 200 cuerpo': 'sandbox: TagResource trae `is_system` y `description ?? \'\'`; el sandbox no trae `is_system` y manda null.',
  'GET /api/v1/tags/{tag} → 200 cuerpo': 'sandbox: igual que GET /tags (`is_system`, `description`).',
  'POST /api/v1/tags → 200 cuerpo': 'sandbox: igual que GET /tags (`is_system`, `description`). Además producción responde 201 al crear y no duplica un nombre que ya existe.',
  'GET /api/v1/contacts/{contactId}/messages → 200 cuerpo':
    'sandbox: con una clave, `user_id` sale como id opaco `usr_` (KeyPublicIds::NAMES); el sandbox manda el entero 1 (también en plantillas y números).',
  'GET /api/v1/devices → 200 cuerpo':
    'sandbox: DeviceResource de accounts trae `phone_number_id` y `user_id` opaco; el resumen de `health` y la forma de la lista: sin verificar.',
  'GET /api/v1/devices/{device} → 200 cuerpo': 'sandbox: igual que GET /devices (`phone_number_id`, `user_id`; `health`: sin verificar).',
  'PUT /api/v1/devices/{device} → 200 cuerpo': 'sandbox: igual que GET /devices (`phone_number_id`, `user_id`; `health`: sin verificar).',
  'GET /api/v1/connect-links → 200 cuerpo': 'sandbox: ConnectLinkResource de accounts trae `url`; el sandbox solo la muestra al crear el link.',
  'GET /api/v1/connect-links/{link} → 200 cuerpo': 'sandbox: igual que GET /connect-links (`url`).',
  'POST /api/v1/contacts/{contact}/message → 422 cuerpo':
    'sandbox: una nota con `options` responde {error: "A note cannot carry interactive options."}; con una clave, ApiKeyErrorPhrases lo vuelve {error: "validation_failed", message: "A note cannot…"}.',

  // --- Sin verificar contra el backend --------------------------------------------------------------------------------
  'DELETE /api/v1/devices/{device} → 200 cuerpo': 'sin verificar: la spec dice que el cuerpo es un texto; el sandbox responde un objeto.',
  'GET /api/v1/devices/{device}/groups → 200 cuerpo': 'sin verificar: un grupo del número que solo está en WhatsApp sale con un `device_id` que no es un id opaco.',
  'GET /api/v1/forms/templates → 200 cuerpo': 'sin verificar: la spec pide `id`, `definition` y `sort` en cada plantilla de formulario; el sandbox no los trae.',
  'GET /api/v1/groups → 200 cuerpo': 'sin verificar: la spec tipa `order`, `participants_numbers` y `participants_count` como texto; el sandbox los manda como números.',
  'GET /api/v1/groups/{group} → 200 cuerpo': 'sin verificar: igual que GET /groups.',
  'GET /api/v1/tags/{tag}/contacts → 200 cuerpo': 'sin verificar: la spec dice que `data` es una lista de textos; el sandbox manda contactos.',
  'DELETE /api/v1/forms/{id} → 404 no declarado': 'sin verificar: un formulario que no existe responde 404 (binding); la spec no declara 404.',
  'GET /api/v1/forms/{id} → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'PUT /api/v1/forms/{id} → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/forms/{id}/numbers → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'POST /api/v1/forms/{id}/numbers → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'POST /api/v1/forms/{id}/numbers/retry → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'POST /api/v1/forms/{id}/publish → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'POST /api/v1/forms/{id}/sync → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'POST /api/v1/forms/{id}/versions → 404 no declarado': 'sin verificar: un formulario que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/forms/families/{familyId}/definition → 404 no declarado': 'sin verificar: una familia que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/forms/families/{familyId}/responses → 404 no declarado': 'sin verificar: una familia que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/forms/families/{familyId}/responses/{runId} → 404 no declarado': 'sin verificar: una familia que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/forms/families/{familyId}/versions → 404 no declarado': 'sin verificar: una familia que no existe responde 404; la spec no declara 404.',
  'GET /api/v1/groups/actions/{action} → 404 no declarado': 'sin verificar: una acción que no existe responde 404 action_not_found; la spec no declara 404.',
  'POST /api/v1/groups/{group}/import → 404 no declarado': 'sin verificar: importar con un número que no es de la cuenta responde 404 device_not_found; la spec no declara 404.',
  'PUT /api/v1/webhooks/{id} → 404 no declarado': 'sin verificar: una suscripción que no existe responde 404; la spec no declara 404 en PUT.',
};
