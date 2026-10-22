/**
 * The five starting points of `POST /api/v1/forms` (`template_key`), copied from conversations v1.18.10
 * `database/seeders/WhatsappFormTemplatesSeeder.php`, in their `sort` order.
 */
export interface FormTemplate {
  key: string;
  title: string;
  description: string;
  category: string;
  definition: Record<string, unknown>;
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    key: 'blank',
    title: 'En blanco',
    description: 'Empieza desde cero con una pantalla vacía',
    category: 'OTHER',
    definition: { endpoint: false, screens: [{ id: 'SCREEN_BLNK', title: 'Pantalla 1', cta: 'Enviar', next: 'complete', items: [] }] },
  },
  {
    key: 'lead',
    title: 'Captar un lead',
    description: 'Nombre, email, rubro y volumen de chats',
    category: 'LEAD_GENERATION',
    definition: {
      endpoint: false,
      screens: [
        {
          id: 'SCREEN_LEDA',
          title: 'Tus datos',
          cta: 'Continuar',
          next: 'auto',
          items: [
            { id: 'it_l1', type: 'heading', label: 'Contanos de vos' },
            { id: 'it_l2', type: 'text', name: 'nombre', label: 'Nombre', required: true, map: { target: 'name', policy: 'if_empty' } },
            { id: 'it_l3', type: 'email', name: 'email', label: 'Email', required: true, map: { target: 'email', policy: 'if_empty' } },
          ],
        },
        {
          id: 'SCREEN_LEDB',
          title: 'Tu negocio',
          cta: 'Enviar',
          next: 'complete',
          items: [
            {
              id: 'it_l4',
              type: 'dropdown',
              name: 'rubro',
              label: 'Rubro',
              required: true,
              options: [
                { id: 'op_comercio', title: 'Comercio' },
                { id: 'op_servicios', title: 'Servicios' },
                { id: 'op_educacion', title: 'Educación' },
                { id: 'op_otro', title: 'Otro' },
              ],
            },
            {
              id: 'it_l5',
              type: 'radio',
              name: 'volumen',
              label: 'Chats por mes',
              required: true,
              options: [
                { id: 'op_menos_de_cincuenta', title: 'Menos de 50' },
                { id: 'op_entre_cincuenta_y_quinientos', title: 'Entre 50 y 500' },
                { id: 'op_mas_de_quinientos', title: 'Más de 500' },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'appointment',
    title: 'Agendar una cita',
    description: 'Consulta tu agenda en vivo y muestra los horarios disponibles',
    category: 'APPOINTMENT_BOOKING',
    definition: {
      endpoint: true,
      screens: [
        {
          id: 'SCREEN_CITA',
          title: 'Elige tu cita',
          cta: 'Ver horarios',
          next: 'auto',
          items: [
            { id: 'it_a1', type: 'heading', label: 'Reserva tu turno' },
            {
              id: 'it_a2',
              type: 'dropdown',
              name: 'servicio',
              label: 'Servicio',
              required: true,
              options: [
                { id: 'op_consulta_general', title: 'Consulta general' },
                { id: 'op_especialista', title: 'Especialista' },
              ],
            },
            { id: 'it_a3', type: 'date', name: 'fecha_preferida', label: 'Fecha preferida', required: true },
          ],
          api: { on: true, fail_message: 'No pudimos validar tus datos ahora mismo. Intenta de nuevo.' },
        },
        {
          id: 'SCREEN_HORA',
          title: 'Horario y datos',
          cta: 'Confirmar',
          next: 'complete',
          items: [
            { id: 'it_a4', type: 'body', label: 'Reservaste {{form.servicio}}' },
            { id: 'it_a5', type: 'dropdown', name: 'horario', label: 'Horario', required: true, dyn: true, options: [] },
            { id: 'it_a6', type: 'text', name: 'nombre', label: 'Nombre', required: true, map: { target: 'name', policy: 'if_empty' } },
          ],
        },
      ],
    },
  },
  {
    key: 'nps',
    title: 'Encuesta NPS',
    description: 'Una nota del 0 al 10 que etiqueta al contacto según el grupo',
    category: 'SURVEY',
    definition: {
      endpoint: false,
      screens: [
        {
          id: 'SCREEN_NPSA',
          title: '¿Nos recomendarías?',
          cta: 'Continuar',
          next: 'auto',
          items: [
            { id: 'it_n1', type: 'body', label: 'Del 0 al 10, ¿qué tan probable es que nos recomiendes?' },
            {
              id: 'it_n2',
              type: 'radio',
              name: 'nota',
              label: 'Tu nota',
              required: true,
              options: [
                { id: 'op_detractor', title: 'De 0 a 6' },
                { id: 'op_pasivo', title: 'De 7 a 8' },
                { id: 'op_promotor', title: 'De 9 a 10' },
              ],
            },
          ],
          routes: { field: 'nota', groups: [{ options: ['op_promotor'], to: 'complete' }] },
        },
        {
          id: 'SCREEN_NPSB',
          title: '¿Qué podemos mejorar?',
          cta: 'Enviar',
          next: 'complete',
          items: [{ id: 'it_n3', type: 'textarea', name: 'comentario', label: 'Contanos' }],
        },
      ],
    },
  },
  {
    key: 'signup',
    title: 'Registro',
    description: 'Alta con enlace a los términos y aceptación obligatoria',
    category: 'SIGN_UP',
    definition: {
      endpoint: false,
      screens: [
        {
          id: 'SCREEN_REGI',
          title: 'Crear tu cuenta',
          cta: 'Registrarme',
          next: 'complete',
          items: [
            { id: 'it_r1', type: 'text', name: 'nombre', label: 'Nombre', required: true, map: { target: 'name', policy: 'if_empty' } },
            { id: 'it_r2', type: 'email', name: 'email', label: 'Email', required: true, map: { target: 'email', policy: 'replace' } },
            { id: 'it_r3', type: 'link', label: 'Leer los términos', url: 'https://funnelchat.com/terminos' },
            { id: 'it_r4', type: 'optin', name: 'acepta_terminos', label: 'Acepto los términos', required: true },
          ],
        },
      ],
    },
  },
];
