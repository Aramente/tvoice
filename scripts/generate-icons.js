#!/usr/bin/env node
// Generate PNG icons from the canonical SVG. Uses `sharp` if available;
// otherwise emits a helpful error telling the user what to install.
//
// This is optional — Tvoice works without PNG icons on Chrome/Edge/Firefox
// because the manifest references the SVG directly. iOS Safari PWA is
// happier with PNGs on the home screen, which is why we offer this script.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ICONS_DIR = resolve(__dirname, '../src/public/icons');

const sizes = [
  { name: 'icon-192.png',          size: 192, maskable: false },
  { name: 'icon-192-maskable.png', size: 192, maskable: true  },
  { name: 'icon-512.png',          size: 512, maskable: false },
  { name: 'icon-512-maskable.png', size: 512, maskable: true  },
];

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (err) {
    console.error('sharp is not installed. Install it with:');
    console.error('  npm install --no-save sharp');
    console.error('and re-run this script.');
    process.exit(1);
  }

  const svg = await readFile(resolve(ICONS_DIR, 'icon.svg'));

  for (const { name, size, maskable } of sizes) {
    const pipeline = sharp(svg).resize(size, size, { fit: 'contain', background: { r: 10, g: 10, b: 10, alpha: 1 } });
    if (maskable) {
      // Add padding for maskable safe zone (80% inner, 20% padding)
      const inner = Math.round(size * 0.8);
      const padded = await sharp(svg)
        .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const out = await sharp({
        create: { width: size, height: size, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } },
      })
        .composite([{ input: padded, gravity: 'center' }])
        .png()
        .toBuffer();
      await writeFile(resolve(ICONS_DIR, name), out);
    } else {
      const out = await pipeline.png().toBuffer();
      await writeFile(resolve(ICONS_DIR, name), out);
    }
    console.log(`generated ${name} (${size}x${size}${maskable ? ', maskable' : ''})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
