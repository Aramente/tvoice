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
  .option('--rotate-secret', 'rotate the JWT signing secret (existing cookies remain valid until they expire)')
  .option('--setup', 'first-time setup — generates config, prints a permanent login URL, and exits')
  .option('--mirror', 'auto-attach to tmux sessions created from your phone')
  .option('--new', 'create a new session (visible on phone) and attach in this terminal')
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

  // --setup: one-time guided setup. Generates secrets, starts the server
  // + tunnel, prints a permanent login URL, and explains how to bookmark
  // it for daily use.
  if (opts.setup) {
    console.log('');
    console.log(chalk.cyan.bold('  Tvoice first-time setup'));
    console.log('');

    // Apply tunnel preference
    if (opts.port !== undefined) cfg.port = opts.port;
    if (opts.host !== undefined) cfg.host = opts.host;
    if (opts.tunnel === false) cfg.tunnel = 'none';
    else if (typeof opts.tunnel === 'string') cfg.tunnel = opts.tunnel;

    // Detect if tvoice is already running (e.g. via LaunchAgent).
    // If so, use the existing server instead of starting a second one.
    let publicUrl = null;
    let closeServer = null;
    let tunnelInstance = null;
    let serverAlreadyRunning = false;

    try {
      const probe = await fetch(`http://${cfg.host}:${cfg.port}/health`);
      if (probe.ok) {
        serverAlreadyRunning = true;
        console.log(chalk.green('  1. Server already running on port ' + cfg.port));
      }
    } catch { /* not running */ }

    if (!serverAlreadyRunning) {
      console.log(chalk.gray('  1. Starting server...'));
      const handles = await startServer(cfg);
      closeServer = handles.close;
    }

    // Determine the public URL — check for an active tailscale serve
    // mapping first (covers the LaunchAgent case where the tunnel is
    // already live), otherwise start a new tunnel.
    if (cfg.tunnel === 'tailscale') {
      try {
        const { execFile: ef } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        const efP = p(ef);
        const tsCli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
        const { stdout } = await efP(tsCli, ['status', '--json']).catch(() =>
          efP('tailscale', ['status', '--json'])
        );
        const parsed = JSON.parse(stdout);
        const hostname = parsed?.Self?.DNSName?.replace(/\.$/, '');
        if (hostname) publicUrl = `https://${hostname}:8443`;
      } catch { /* fall through */ }
    }

    if (!publicUrl && !serverAlreadyRunning && cfg.tunnel !== 'none') {
      process.stdout.write(chalk.gray(`  2. Starting ${cfg.tunnel} tunnel... `));
      try {
        tunnelInstance = await startTunnel(cfg);
        publicUrl = tunnelInstance.url;
        console.log(chalk.green('ok'));
      } catch (err) {
        console.log(chalk.yellow('skipped'));
        console.log(chalk.gray(`     ${err.message}`));
      }
    }

    if (!publicUrl) publicUrl = `http://${cfg.host}:${cfg.port}`;

    const token = await mintLoginToken(cfg, { ttl: 15 * 60 });
    const loginUrl = `${publicUrl}/login?t=${encodeURIComponent(token)}`;

    console.log('');
    console.log(chalk.white('  2. Open this URL on your phone to log in:'));
    console.log('');
    qrcode.generate(loginUrl, { small: true }, (qr) => {
      console.log(qr.split('\n').map((l) => '  ' + l).join('\n'));
    });
    console.log('');
    console.log(chalk.cyan('  ' + loginUrl));
    console.log('');
    console.log(chalk.white('  3. After login, bookmark this permanent URL:'));
    console.log(chalk.cyan.bold(`  ${publicUrl}/`));
    console.log('');
    console.log(chalk.gray('  The cookie is set for ~10 years. No token needed'));
    console.log(chalk.gray('  after the first login — just open the bookmark.'));
    console.log('');

    if (serverAlreadyRunning) {
      console.log(chalk.green('  Setup complete. Server is already running as a background service.'));
      process.exit(0);
    }

    console.log(chalk.white('  4. To keep tvoice always on, set up a background service.'));
    console.log(chalk.gray('     See: https://github.com/Aramente/tvoice#run-as-a-background-service-macos'));
    console.log('');
    console.log(chalk.gray('  Server is running. Ctrl+C to stop.'));
    console.log('');

    const handleShutdown = async (signal) => {
      console.log('');
      console.log(chalk.gray(`  ${signal} — shutting down.`));
      await shutdown(closeServer, tunnelInstance);
      process.exit(0);
    };
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    return;
  }

  // --new: create a session via the running server (so the phone sees it),
  // then attach tmux in this terminal. One command, both devices in sync.
  if (opts.new) {
    const { spawn: spawnProc } = await import('node:child_process');
    const port = cfg.port || 3000;
    const host = cfg.host || '127.0.0.1';

    // We need an auth token. Mint one from the config.
    const token = await mintLoginToken(cfg, { ttl: 60 });

    // First consume the token to get a cookie, then use the cookie to create.
    let cookie = '';
    try {
      const loginRes = await fetch(`http://${host}:${port}/login?t=${encodeURIComponent(token)}`, {
        redirect: 'manual',
      });
      cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    } catch (err) {
      console.error(chalk.red('  Cannot reach the tvoice server.'));
      console.error(chalk.gray(`  Is it running? Check: curl http://${host}:${port}/health`));
      process.exit(1);
    }

    try {
      const res = await fetch(`http://${host}:${port}/api/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      const { id, tmuxName } = await res.json();
      console.log(chalk.green(`  ✓ Session ${id} created (${tmuxName})`));
      console.log(chalk.gray('  Attaching... detach with Ctrl+B then D'));
      console.log('');
      const child = spawnProc('tmux', ['attach', '-t', tmuxName], { stdio: 'inherit' });
      child.on('exit', () => process.exit(0));
    } catch (err) {
      console.error(chalk.red('  Failed to create session: ' + err.message));
      process.exit(1);
    }
    return;
  }

  // --mirror: watch for tvoice tmux sessions and auto-attach. When the
  // phone creates a new tab, this Mac terminal instantly mirrors it.
  // When the tmux session detaches or exits, go back to watching.
  if (opts.mirror) {
    const { execFile: ef } = await import('node:child_process');
    const { promisify: p } = await import('node:util');
    const { spawn: spawnProc } = await import('node:child_process');
    const efP = p(ef);
    const prefix = cfg.tmuxPrefix || 'tvoice';

    console.log('');
    console.log(chalk.cyan.bold('  Tvoice mirror mode'));
    console.log(chalk.gray(`  Watching for tmux sessions starting with "${prefix}-"...`));
    console.log(chalk.gray('  Create a tab on your phone — this terminal will follow it.'));
    console.log(chalk.gray('  Ctrl+C to stop.'));
    console.log('');

    const seen = new Set();
    const poll = async () => {
      try {
        const { stdout } = await efP('tmux', ['ls', '-F', '#{session_name}']);
        const sessions = stdout.trim().split('\n').filter((s) => s.startsWith(prefix + '-'));
        for (const name of sessions) {
          if (!seen.has(name)) {
            seen.add(name);
            console.log(chalk.green(`  → Attaching to ${name}`));
            console.log(chalk.gray('    (detach with Ctrl+B then D to return to mirror mode)'));
            console.log('');
            // Attach — this takes over the terminal until detach/exit
            const child = spawnProc('tmux', ['attach', '-t', name], {
              stdio: 'inherit',
            });
            await new Promise((resolve) => child.on('exit', resolve));
            console.log('');
            console.log(chalk.gray(`  Detached from ${name}. Watching for new sessions...`));
            console.log('');
          }
        }
      } catch {
        // tmux not running or no sessions — that's fine, keep polling
      }
    };

    const interval = setInterval(poll, 1500);
    poll();
    process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
    process.on('SIGTERM', () => { clearInterval(interval); process.exit(0); });
    // Keep the process alive
    await new Promise(() => {});
  }

  // --rotate-secret generates a new JWT signing secret. The old secret
  // is stashed as jwtSecretPrev so tokens signed with it remain valid
  // until they naturally expire. The verifier checks both keys.
  if (opts.rotateSecret) {
    const { saveConfig } = await import('../src/server/config.js');
    const { randomBytes } = await import('node:crypto');
    cfg.jwtSecretPrev = cfg.jwtSecret;
    cfg.jwtSecret = randomBytes(32).toString('hex');
    await saveConfig(cfg);
    console.log(chalk.green('  ✓ JWT secret rotated.'));
    console.log(chalk.gray('  Previous secret kept as fallback until existing cookies expire.'));
    process.exit(0);
  }

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
