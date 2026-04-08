#!/usr/bin/env node
// Tvoice CLI entry point.
// Usage: npx tvoice [--port 3000] [--tunnel cloudflare|tailscale|none] [--no-tunnel]

import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { createRequire } from 'node:module';
import { startServer } from '../src/server/index.js';
import { loadConfig, saveConfig } from '../src/server/config.js';
import { startTunnel, stopTunnel } from '../src/server/tunnel.js';
import { mintLoginToken } from '../src/server/auth.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();

program
  .name('tvoice')
  .description(pkg.description)
  .version(pkg.version)
  .option('-p, --port <number>', 'port to listen on (default: 3000)', (v) => parseInt(v, 10))
  .option('-h, --host <string>', 'host to bind on (default: 127.0.0.1)')
  .option('-t, --tunnel <backend>', 'tunnel backend: cloudflare | tailscale | none (default: cloudflare)')
  .option('--no-tunnel', 'disable tunneling, serve on localhost only')
  .option('--print-login', 'print login URL and exit')
  .parse(process.argv);

const opts = program.opts();

async function main() {
  const cfg = await loadConfig();

  // CLI flags override config (only when explicitly provided — undefined means "use config")
  if (opts.port !== undefined) cfg.port = opts.port;
  if (opts.host !== undefined) cfg.host = opts.host;
  if (opts.tunnel === false) cfg.tunnel = 'none';
  else if (typeof opts.tunnel === 'string') cfg.tunnel = opts.tunnel;

  await saveConfig(cfg);

  // Banner
  console.log('');
  console.log(chalk.cyan.bold('  ▛▀▖  ') + chalk.white('Tvoice') + chalk.gray(` v${pkg.version}`));
  console.log(chalk.gray('  ▌ ▌  Mobile-first terminal for AI coding agents'));
  console.log('');

  // Start HTTP/WS server first
  const { server, close: closeServer } = await startServer(cfg);

  // Start tunnel
  let publicUrl = `http://${cfg.host}:${cfg.port}`;
  let tunnelInstance = null;

  if (cfg.tunnel !== 'none') {
    process.stdout.write(chalk.gray(`  Starting ${cfg.tunnel} tunnel... `));
    try {
      tunnelInstance = await startTunnel(cfg);
      publicUrl = tunnelInstance.url;
      console.log(chalk.green('ok'));
    } catch (err) {
      console.log(chalk.yellow('skipped'));
      console.log(chalk.gray(`    ${err.message}`));
      console.log(chalk.gray('    Falling back to local URL. Use --tunnel none to silence this.'));
    }
  }

  // Mint a one-time login token (10min TTL) and embed in the URL
  const token = await mintLoginToken(cfg, { ttl: 10 * 60 });
  const loginUrl = `${publicUrl}/login?t=${encodeURIComponent(token)}`;

  if (opts.printLogin) {
    console.log(loginUrl);
    await shutdown(closeServer, tunnelInstance);
    process.exit(0);
  }

  // Display URL + QR code
  console.log('');
  console.log(chalk.white('  Scan this QR code with your phone:'));
  console.log('');
  qrcode.generate(loginUrl, { small: true }, (qr) => {
    const indented = qr.split('\n').map((line) => '  ' + line).join('\n');
    console.log(indented);
  });
  console.log('');
  console.log(chalk.white('  Or open:'));
  console.log(chalk.cyan('  ' + loginUrl));
  console.log('');
  console.log(chalk.gray('  Login token expires in 10 minutes.'));
  console.log(chalk.gray('  After login, your session cookie is valid for 7 days.'));
  console.log(chalk.gray('  Ctrl+C to stop.'));
  console.log('');

  // Graceful shutdown
  const handleShutdown = async (signal) => {
    console.log('');
    console.log(chalk.gray(`  Received ${signal}, shutting down...`));
    await shutdown(closeServer, tunnelInstance);
    process.exit(0);
  };
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

async function shutdown(closeServer, tunnelInstance) {
  try {
    if (tunnelInstance) await stopTunnel(tunnelInstance);
  } catch (err) {
    // ignore
  }
  try {
    await closeServer();
  } catch (err) {
    // ignore
  }
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
