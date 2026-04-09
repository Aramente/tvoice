#!/usr/bin/env node
// Tvoice CLI entry point.
// Usage: npx tvoice [--port 3000] [--tunnel cloudflare|tailscale|none] [--no-tunnel]

import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { createRequire } from 'node:module';
import { startServer } from '../src/server/index.js';
import { loadConfig } from '../src/server/config.js';
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
  .option('--allow-lan', 'allow binding to a non-loopback host (DANGEROUS: any device on your LAN can attempt to log in)')
  .option('--reset-totp', 'disable 2FA from the host machine (recovery if the authenticator is lost)')
  .option('--print-login', 'print login URL and exit')
  .parse(process.argv);

const opts = program.opts();

// ---------- Pre-flight safety checks ----------

function refuseRoot() {
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    console.error('');
    console.error(chalk.red.bold('  Tvoice refuses to run as root.'));
    console.error('');
    console.error(chalk.gray('  Anyone who connects to a Tvoice server gets an interactive shell as'));
    console.error(chalk.gray('  the user that started the server. Running tvoice as root would mean'));
    console.error(chalk.gray('  that shell is a root shell. That is almost certainly not what you'));
    console.error(chalk.gray('  want, even on a single-user machine.'));
    console.error('');
    console.error(chalk.gray('  Run as your normal user instead:'));
    console.error(chalk.cyan('    npx tvoice'));
    console.error('');
    process.exit(2);
  }
}

function isLoopbackHost(host) {
  if (!host) return true;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function refuseNonLoopbackBind(host, allowLan) {
  if (isLoopbackHost(host)) return;
  if (allowLan) return;
  console.error('');
  console.error(chalk.red.bold(`  Tvoice refuses to bind to ${host} without --allow-lan.`));
  console.error('');
  console.error(chalk.gray('  Binding to a non-loopback host means anyone on the same network as'));
  console.error(chalk.gray('  this machine can reach the server and attempt to log in. The login'));
  console.error(chalk.gray('  token + JWT cookie are still required, but you have moved the attack'));
  console.error(chalk.gray('  surface from "this Mac only" to "everyone on the LAN".'));
  console.error('');
  console.error(chalk.gray('  Recommended alternatives:'));
  console.error(chalk.cyan('    npx tvoice                       ') + chalk.gray('# Cloudflare Tunnel — works from anywhere'));
  console.error(chalk.cyan('    npx tvoice --tunnel tailscale    ') + chalk.gray('# Private tailnet (recommended)'));
  console.error(chalk.cyan('    npx tvoice --no-tunnel           ') + chalk.gray('# Localhost only'));
  console.error('');
  console.error(chalk.gray('  If you really mean it, re-run with --allow-lan.'));
  console.error('');
  process.exit(2);
}

function deploymentBanner(cfg, allowLan) {
  // Mode-specific risk banner — not just decorative, this is the place
  // where the user actually reads the deployment posture.
  console.log('');
  if (cfg.tunnel === 'tailscale') {
    console.log(chalk.green('  ✓ Tailscale serve mode'));
    console.log(chalk.gray('    Reachable only from devices in your tailnet (recommended).'));
  } else if (cfg.tunnel === 'cloudflare') {
    console.log(chalk.yellow('  ! Cloudflare Quick Tunnel mode'));
    console.log(chalk.gray('    Public HTTPS URL — anyone with the link can hit the server.'));
    console.log(chalk.gray('    The URL is random. The login token is required (15 min, single use).'));
    console.log(chalk.gray("    Don't leave this running unattended. Ctrl+C to stop."));
  } else if (cfg.tunnel === 'none' && allowLan) {
    console.log(chalk.red('  ⚠ LAN mode — bound to ' + cfg.host));
    console.log(chalk.gray('    Anyone on your local network can reach this server.'));
    console.log(chalk.gray('    Login token + cookie are still enforced, but the attack surface'));
    console.log(chalk.gray('    is everyone in WiFi range. Prefer --tunnel tailscale.'));
  } else {
    console.log(chalk.cyan('  · Localhost-only mode'));
    console.log(chalk.gray("    Reachable from this Mac only. Phone access requires a tunnel —"));
    console.log(chalk.gray('    re-run with --tunnel cloudflare or --tunnel tailscale.'));
  }
  console.log('');
}

async function main() {
  refuseRoot();
  const cfg = await loadConfig();

  // --reset-totp is a host-side recovery path for users who lost their
  // authenticator. The user already has filesystem access to this Mac,
  // so requiring a TOTP code here would be circular.
  if (opts.resetTotp) {
    const { saveConfig } = await import('../src/server/config.js');
    cfg.totpEnabled = false;
    cfg.totpSecret = null;
    cfg.totpPending = null;
    await saveConfig(cfg);
    console.log(chalk.green('  ✓ 2FA has been disabled on this host.'));
    console.log(chalk.gray('  You can re-enable it from the PWA drawer after logging in.'));
    process.exit(0);
  }

  // CLI flags override the in-memory config for this run only. We deliberately
  // do NOT persist them — the config file is for generated secrets and
  // explicit user preferences, not for "whatever flag I passed last time".
  if (opts.port !== undefined) cfg.port = opts.port;
  if (opts.host !== undefined) cfg.host = opts.host;
  if (opts.tunnel === false) cfg.tunnel = 'none';
  else if (typeof opts.tunnel === 'string') cfg.tunnel = opts.tunnel;

  refuseNonLoopbackBind(cfg.host, opts.allowLan);

  // Banner
  console.log('');
  console.log(chalk.cyan.bold('  ▛▀▖  ') + chalk.white('Tvoice') + chalk.gray(` v${pkg.version}`));
  console.log(chalk.gray('  ▌ ▌  Mobile-first terminal for AI coding agents'));

  deploymentBanner(cfg, opts.allowLan);

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

  // Mint a one-time login token (15min TTL) and embed in the URL
  const token = await mintLoginToken(cfg, { ttl: 15 * 60 });
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
  const expiryDate = new Date(Date.now() + 15 * 60 * 1000);
  const expiryStr = expiryDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  console.log(chalk.gray(`  Login token expires at ${expiryStr} (in 15 minutes).`));
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
