// Tunnel wrapper. Currently supports cloudflared (free quick tunnel) and
// tailscale serve. Falls back gracefully if the required binary is missing.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function startTunnel(cfg) {
  switch (cfg.tunnel) {
    case 'cloudflare':
      return startCloudflared(cfg);
    case 'tailscale':
      return startTailscale(cfg);
    case 'none':
      return null;
    default:
      throw new Error(`unknown tunnel backend: ${cfg.tunnel}`);
  }
}

export async function stopTunnel(instance) {
  if (!instance) return;
  if (instance.proc) {
    try {
      instance.proc.kill('SIGTERM');
    } catch { /* ignore */ }
  }
  if (instance.cleanup) {
    try { await instance.cleanup(); } catch { /* ignore */ }
  }
}

async function startCloudflared(cfg) {
  await ensureBinary('cloudflared', [
    'Install: brew install cloudflared',
    'Or download: https://github.com/cloudflare/cloudflared/releases',
  ]);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://${cfg.host}:${cfg.port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let resolved = false;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const settleTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        reject(new Error('cloudflared did not report a URL within 30s'));
      }
    }, 30_000);

    const onChunk = (chunk) => {
      const s = chunk.toString();
      const m = s.match(urlRe);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(settleTimeout);
        resolve({ proc, url: m[0] });
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(settleTimeout);
        reject(err);
      }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(settleTimeout);
        reject(new Error(`cloudflared exited early with code ${code}`));
      }
    });
  });
}

async function startTailscale(cfg) {
  const TS_PORT = cfg.tailscalePort || 8443;

  // Resolve the tailscale CLI binary. On macOS, the top-level `tailscale`
  // command is a broken Swift wrapper on some setups — it crashes with a
  // BundleIdentifier fatal error when called outside the app launcher.
  // resolveTailscaleCli tries the PATH command first, falls back to calling
  // the binary inside the .app bundle directly.
  const tsCli = await resolveTailscaleCli();

  // Probe the device name via `tailscale status --json`
  let hostname = null;
  try {
    const { stdout } = await execFileP(tsCli, ['status', '--json']);
    const parsed = JSON.parse(stdout);
    hostname = parsed?.Self?.DNSName?.replace(/\.$/, '');
  } catch { /* continue */ }

  // Use a dedicated HTTPS port (8443 by default) so we never collide with an
  // existing `tailscale serve --https=443` mapping. This is important for
  // users who already serve ttyd or another tool on the primary HTTPS port.
  try {
    await execFileP(tsCli, [
      'serve',
      '--bg',
      `--https=${TS_PORT}`,
      `http://${cfg.host}:${cfg.port}`,
    ]);
  } catch (err) {
    throw new Error(`tailscale serve failed: ${err.stderr || err.message}`);
  }

  const url = hostname
    ? `https://${hostname}:${TS_PORT}`
    : `https://localhost:${TS_PORT}`;
  return {
    proc: null,
    url,
    cleanup: async () => {
      try {
        await execFileP(tsCli, ['serve', `--https=${TS_PORT}`, 'off']);
      } catch { /* ignore */ }
    },
  };
}

async function resolveTailscaleCli() {
  // macOS cask: the top-level `tailscale` on PATH is almost always a symlink
  // to the Swift binary inside the .app. Calling it via the symlink crashes
  // with "BundleIdentifiers.swift:41: Fatal error: The current bundleIdentifier
  // is unknown to the registry" because Swift's runtime can't walk up to the
  // enclosing bundle. Calling the SAME binary via its absolute path inside
  // the bundle works perfectly. So on macOS we prefer the bundle path.
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    candidates.push('tailscale'); // in case of non-cask install
  } else {
    candidates.push('tailscale');
  }

  for (const cli of candidates) {
    try {
      const { stdout } = await execFileP(cli, ['version']);
      // Defensive check: reject output that contains the Swift fatal error
      if (/bundleIdentifier is unknown/i.test(stdout)) continue;
      return cli;
    } catch (err) {
      // Also reject stderr-contained fatal errors (swift writes to stderr)
      if (err.stderr && /bundleIdentifier is unknown/i.test(err.stderr)) continue;
      // Otherwise keep trying
    }
  }

  throw new Error(
    'tailscale CLI not found or not working.\n' +
    '  Install: brew install --cask tailscale && open -a Tailscale\n' +
    '  Or see: https://tailscale.com/download'
  );
}

async function ensureBinary(name, hints) {
  try {
    await execFileP(name, ['--version']).catch(() =>
      execFileP(name, ['version'])
    );
  } catch {
    const msg = [`${name} not found on PATH.`, ...hints].join('\n');
    throw new Error(msg);
  }
}
