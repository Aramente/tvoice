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
  await ensureBinary('tailscale', [
    'Install: brew install --cask tailscale && open -a Tailscale',
    'Or see: https://tailscale.com/download',
  ]);

  // Probe the device name via `tailscale status --json`
  let hostname = null;
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json']);
    const parsed = JSON.parse(stdout);
    hostname = parsed?.Self?.DNSName?.replace(/\.$/, '');
  } catch { /* continue */ }

  // Ensure a serve mapping exists. We use a fresh mapping each run on /tvoice
  // so we don't collide with any other service already on /
  await execFileP('tailscale', [
    'serve',
    '--bg',
    '--https=443',
    '--set-path=/tvoice',
    `http://${cfg.host}:${cfg.port}`,
  ]).catch((err) => {
    throw new Error(`tailscale serve failed: ${err.stderr || err.message}`);
  });

  const url = hostname ? `https://${hostname}/tvoice` : `https://localhost/tvoice`;
  return {
    proc: null,
    url,
    cleanup: async () => {
      try {
        await execFileP('tailscale', [
          'serve',
          '--https=443',
          '--set-path=/tvoice',
          'off',
        ]);
      } catch { /* ignore */ }
    },
  };
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
