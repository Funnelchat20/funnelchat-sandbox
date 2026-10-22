#!/usr/bin/env node
/**
 * `npx funnelchat-sandbox [opciones]`: starts the sandbox on port 4010 by default.
 */
import { ConfigError, DEFAULT_CONFIG_FILE, DEFAULT_PORT, parseArgs, resolveConfig } from './config.js';
import { createSandbox } from './server.js';
import { VERSION } from './version.js';

const HELP = `funnelchat-sandbox ${VERSION}
Imita la API pública de Funnelchat en tu máquina y manda webhooks firmados. Nada sale a WhatsApp.

Uso: npx funnelchat-sandbox [opciones]

Opciones:
  -p, --port <n>                 Puerto (por defecto ${DEFAULT_PORT}; 0 toma uno libre).
      --host <host>              Dónde escuchar (por defecto 127.0.0.1; en Docker, 0.0.0.0).
  -c, --config <archivo>         Configuración en JSON (por defecto ./${DEFAULT_CONFIG_FILE}, si existe).
      --status-delays <s,d,r>    Segundos hasta sent, delivered y read (por defecto 1,2,3; "-" corta ahí).
      --retry-delays <a,b,c>     Segundos entre reintentos de un webhook (por defecto 60,300,1800).
      --webhook-timeout <s>      Tiempo máximo de tu receptor (por defecto 10).
      --require-https            Solo acepta suscripciones https, como la API real.
      --no-window                No aplica la ventana de 24 horas.
      --no-antiblock             No aplica los frenos contra spam.
      --no-rate-limit            No aplica el ritmo por número.
      --template-approval <s>    Segundos hasta aprobar una plantilla nueva (por defecto 5; "-" la deja pendiente).
  -q, --quiet                    Sin una línea por pedido y por entrega.
  -h, --help                     Esta ayuda.
  -v, --version                  La versión.

Las opciones ganan sobre el archivo de configuración. Panel: http://localhost:${DEFAULT_PORT}/_sandbox`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  const { config, configFile } = resolveConfig(args);
  const sandbox = createSandbox({ config });
  const { url } = await sandbox.listen();

  console.log(`funnelchat-sandbox ${VERSION} en ${url}`);
  if (configFile) console.log(`configuración: ${configFile}`);
  console.log(`  API:    ${url}/api/v1/...   (Authorization: Bearer 1|fc_live_sandbox, o cualquier clave bien formada)`);
  console.log(`  panel:  ${url}/_sandbox`);
  console.log('  números de ejemplo: 3 (oficial, con ventana de 24 h) y 4 (QR, sin ventana); contacto 2001; plantilla 45');
  for (const s of sandbox.app.store.subscriptions.values()) {
    console.log(`  suscripción de la configuración: ${s.id} → ${s.url} (${s.events.join(', ')})`);
  }

  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal}: cerrando el sandbox`);
    void sandbox.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`funnelchat-sandbox: ${error.message}`);
    process.exit(2);
  }
  const code = (error as { code?: string }).code;
  if (code === 'EADDRINUSE') {
    console.error('funnelchat-sandbox: el puerto está ocupado. Prueba con --port <otro>.');
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
