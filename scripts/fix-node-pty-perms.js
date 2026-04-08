#!/usr/bin/env node
// Restore the executable bit on node-pty's prebuilt spawn-helper binaries.
//
// Background: npm's tarball extraction drops the +x bit on some systems when
// unpacking node-pty's prebuilds. When that happens, pty.fork() fails with
// "posix_spawnp failed" at runtime even though the binary is present. This
// script is run automatically via the `postinstall` hook in package.json.
//
// It is idempotent and silent on success.

import { chmod, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const prebuildsDir = resolve(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  let entries;
  try {
    entries = await readdir(prebuildsDir);
  } catch (err) {
    // node-pty not installed yet — this can happen during postinstall ordering
    if (err.code === 'ENOENT') return;
    throw err;
  }

  let fixed = 0;
  for (const dir of entries) {
    const helper = join(prebuildsDir, dir, 'spawn-helper');
    try {
      const s = await stat(helper);
      if (!s.isFile()) continue;
      // Check if any x bit is already set; if so, skip
      if ((s.mode & 0o111) !== 0) continue;
      await chmod(helper, 0o755);
      fixed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Only log errors that aren't "file doesn't exist" (windows dirs
        // don't have spawn-helper — that's expected)
        console.warn(`[tvoice] could not chmod ${helper}: ${err.message}`);
      }
    }
  }

  if (fixed > 0) {
    console.log(`[tvoice] fixed executable bit on ${fixed} node-pty spawn-helper binar${fixed === 1 ? 'y' : 'ies'}`);
  }
}

main().catch((err) => {
  console.warn('[tvoice] fix-node-pty-perms failed:', err.message);
  // Don't fail the install over this — many environments won't need it
  process.exit(0);
});
