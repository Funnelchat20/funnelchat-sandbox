#!/usr/bin/env node
/**
 * `npx funnelchat-sandbox [options]`: starts the sandbox on port 4010 by default.
 */
import { ConfigError, DEFAULT_CONFIG_FILE, DEFAULT_PORT, parseArgs, resolveConfig } from './config.js';
import { createSandbox } from './server.js';
import { VERSION } from './version.js';

const HELP = `funnelchat-sandbox ${VERSION}
Imitates the Funnelchat public API on your machine and sends signed webhooks. Nothing goes out to WhatsApp.

Usage: npx funnelchat-sandbox [options]

Options:
  -p, --port <n>                 Port (default ${DEFAULT_PORT}; 0 takes a free one).
      --host <host>              Where to listen (default 127.0.0.1; in Docker, 0.0.0.0).
      --public-url <url>         Base URL of the sign-up links (default: where it listens; in Docker, the published one).
  -c, --config <file>            JSON configuration (default ./${DEFAULT_CONFIG_FILE}, if it exists).
      --status-delays <s,d,r>    Seconds until sent, delivered and read (default 1,2,3; "-" stops there).
      --retry-delays <a,b,c>     Seconds between retries of a webhook (default 60,300,1800).
      --webhook-timeout <s>      How long your receiver may take (default 10).
      --require-https            Only accept https subscriptions, like the real API.
      --no-window                Do not apply the 24-hour window.
      --no-antiblock             Do not apply the spam brakes.
      --no-rate-limit            Do not apply the per-number pace.
      --template-approval <s>    Seconds until a new template is approved (default 5; "-" leaves it pending).
  -q, --quiet                    No line per request and per delivery.
  -h, --help                     This help.
  -v, --version                  The version.

Options win over the configuration file. Panel: http://localhost:${DEFAULT_PORT}/_sandbox`;

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

  console.log(`funnelchat-sandbox ${VERSION} at ${url}`);
  if (configFile) console.log(`configuration: ${configFile}`);
  console.log(`  API:    ${url}/api/v1/...   (Authorization: Bearer 1|fc_live_sandbox, or any well-formed key)`);
  console.log(`  panel:  ${url}/_sandbox`);
  console.log('  example numbers: 3 (official, with the 24-hour window) and 4 (QR, no window); contact 2001; template 45');
  for (const s of sandbox.app.store.subscriptions.values()) {
    console.log(`  subscription from the configuration: ${s.id} → ${s.url} (${s.events.join(', ')})`);
  }

  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal}: closing the sandbox`);
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
    console.error('funnelchat-sandbox: the port is in use. Try --port <another>.');
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
