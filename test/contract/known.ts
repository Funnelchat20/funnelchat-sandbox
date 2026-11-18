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
  // Ninguna desde la spec del 18-11 (portal fe4df8d, instantáneas v3 de los tres dominios): lo que la spec decía distinto
  // de producción se corrigió en la spec, y lo que el sandbox hacía distinto, en el sandbox.
};
