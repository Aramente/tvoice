// Local Whisper bridge. Accepts an audio buffer (whatever MediaRecorder
// produced on the phone — webm or mp4), transcodes it to 16 kHz mono WAV
// via ffmpeg, pipes it through whisper.cpp, and returns the transcribed
// text.
//
// Why this is elegant for Tvoice:
// - MediaRecorder works inside installed iOS PWAs (SpeechRecognition does not)
// - The Mac is already running the tvoice server, so it's already "on" when
//   the user taps the mic button
// - whisper.cpp on an M-series Mac transcribes a 10 s clip in well under 1 s
//   with the base.en model (142 MB)
// - Private: audio never leaves your machine
// - Free: no API keys, no per-minute billing
// - Accurate on technical vocabulary via --prompt biasing

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, access, mkdir, stat as fstat } from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);

const MODEL_DIR = join(homedir(), '.tvoice', 'models');
const DEFAULT_MODEL = 'ggml-base.en.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;

// Technical-vocabulary bias — sent to whisper as --prompt so the decoder
// is nudged toward command-line and developer tokens.
const TECH_PROMPT = [
  'claude', 'tvoice', 'git', 'commit', 'push', 'pull', 'merge', 'rebase',
  'branch', 'diff', 'status', 'checkout', 'stash', 'bisect',
  'npm', 'npx', 'node', 'deno', 'bun', 'tmux',
  'ssh', 'scp', 'rsync', 'curl', 'wget', 'grep', 'sed', 'awk', 'find',
  'ls', 'cd', 'mkdir', 'rm', 'mv', 'cp', 'cat', 'less', 'tail', 'head',
  'docker', 'kubectl', 'terraform', 'ansible',
  'python', 'ruby', 'rust', 'cargo', 'swift', 'xcode',
  'sloow', 'obsidian', 'tailscale', 'cloudflare', 'vercel',
].join(' ');

let cache = {
  binary: undefined,   // string | false
  ffmpeg: undefined,   // string | false
  model: undefined,    // string | false
};

// ---------- Detection ----------

async function which(cmd) {
  try {
    const { stdout } = await execFileP('which', [cmd]);
    return stdout.trim() || false;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary() {
  if (cache.binary !== undefined) return cache.binary;
  // whisper.cpp has been renamed a few times — try the common ones
  for (const name of ['whisper-cli', 'whisper-cpp', 'whisper', 'main']) {
    const p = await which(name);
    if (p) { cache.binary = p; return p; }
  }
  cache.binary = false;
  return false;
}

async function findFfmpeg() {
  if (cache.ffmpeg !== undefined) return cache.ffmpeg;
  const p = await which('ffmpeg');
  cache.ffmpeg = p;
  return p;
}

async function findModel() {
  if (cache.model !== undefined) return cache.model;
  const candidates = [
    join(MODEL_DIR, DEFAULT_MODEL),
    '/opt/homebrew/share/whisper-cpp/models/' + DEFAULT_MODEL,
    '/usr/local/share/whisper-cpp/models/' + DEFAULT_MODEL,
    '/opt/homebrew/opt/whisper-cpp/share/whisper-cpp/models/' + DEFAULT_MODEL,
  ];
  for (const p of candidates) {
    if (await exists(p)) { cache.model = p; return p; }
  }
  cache.model = false;
  return false;
}

export function invalidateCache() {
  cache = { binary: undefined, ffmpeg: undefined, model: undefined };
}

// ---------- Public status ----------

export async function status() {
  const [binary, ffmpeg, model] = await Promise.all([
    findBinary(),
    findFfmpeg(),
    findModel(),
  ]);
  const ready = !!(binary && ffmpeg && model);
  const missing = [];
  if (!binary) missing.push('whisper');
  if (!ffmpeg) missing.push('ffmpeg');
  if (!model)  missing.push('model');
  return {
    ready,
    binary: binary || null,
    ffmpeg: ffmpeg || null,
    model: model || null,
    missing,
    installHint: buildInstallHint(missing),
    modelDownloadable: !binary || !ffmpeg ? false : true,
  };
}

function buildInstallHint(missing) {
  if (missing.length === 0) return null;
  const parts = [];
  if (missing.includes('whisper') || missing.includes('ffmpeg')) {
    const pkgs = [];
    if (missing.includes('whisper')) pkgs.push('whisper-cpp');
    if (missing.includes('ffmpeg'))  pkgs.push('ffmpeg');
    parts.push(`brew install ${pkgs.join(' ')}`);
  }
  if (missing.includes('model')) {
    parts.push(`Tvoice will auto-download the model (~142 MB) on first use, or you can pre-fetch: curl -L -o "${join(MODEL_DIR, DEFAULT_MODEL)}" "${MODEL_URL}"`);
  }
  return parts.join('\n');
}

// ---------- Model auto-download ----------

export async function ensureModel(onProgress = () => {}) {
  const existing = await findModel();
  if (existing) return existing;

  await mkdir(MODEL_DIR, { recursive: true });
  const dest = join(MODEL_DIR, DEFAULT_MODEL);
  const tmp = dest + '.download';

  onProgress({ phase: 'starting', url: MODEL_URL, dest });

  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Model download HTTP ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);

  const out = createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total > 0) onProgress({ phase: 'progress', bytes: got, total });
  }
  await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));

  // Atomic rename
  await execFileP('mv', [tmp, dest]);
  cache.model = dest;
  onProgress({ phase: 'done', path: dest });
  return dest;
}

// ---------- Transcription ----------

export async function transcribe(audioBuffer, {
  language = 'auto',
  prompt = TECH_PROMPT,
  ext = '',
} = {}) {
  const st = await status();
  if (!st.binary || !st.ffmpeg) {
    const err = new Error('Whisper prerequisites missing: ' + st.missing.join(', '));
    err.code = 'NOT_INSTALLED';
    err.hint = st.installHint;
    err.missing = st.missing;
    throw err;
  }

  // Auto-fetch the model on first use if it's not present
  if (!st.model) {
    try {
      await ensureModel();
    } catch (e) {
      const err = new Error('Model download failed: ' + e.message);
      err.code = 'MODEL_DOWNLOAD_FAILED';
      throw err;
    }
  }

  const modelPath = cache.model || await findModel();
  if (!modelPath) {
    const err = new Error('Model unavailable after download');
    err.code = 'MODEL_MISSING';
    throw err;
  }

  const id = randomUUID();
  const inputFile = join(tmpdir(), `tvoice-${id}${ext || '.webm'}`);
  const wavFile   = join(tmpdir(), `tvoice-${id}.wav`);

  try {
    await writeFile(inputFile, audioBuffer);

    // Transcode to 16 kHz mono 16-bit PCM WAV, whisper's expected format
    await execFileP('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-i', inputFile,
      '-ar', '16000',
      '-ac', '1',
      '-sample_fmt', 's16',
      wavFile,
    ]);

    // Run whisper-cli with no timestamps, no special tokens
    const args = [
      '-m', modelPath,
      '-f', wavFile,
      '-nt',       // no timestamps in output
      '-np',       // no progress prints
      '-otxt', 'false', // don't write output file, we read stdout
    ];
    if (language && language !== 'auto') args.push('-l', language);
    if (prompt) args.push('--prompt', prompt);

    // Some whisper.cpp builds don't accept `-otxt false` — just drop it
    // gracefully if it fails the first time.
    let stdout = '';
    try {
      const r = await execFileP(cache.binary, args, { maxBuffer: 2 * 1024 * 1024 });
      stdout = r.stdout;
    } catch (e) {
      // Retry without the problematic flag
      const fallback = args.filter((a, i) => a !== '-otxt' && args[i - 1] !== '-otxt');
      const r = await execFileP(cache.binary, fallback, { maxBuffer: 2 * 1024 * 1024 });
      stdout = r.stdout;
    }

    // Clean up whisper's banner/metadata — only keep lines that look like
    // transcription text. With -nt -np flags set, stdout is usually just
    // the transcription lines with no leading metadata.
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('['));
    const text = lines.join(' ').trim();
    return text;
  } finally {
    await unlink(inputFile).catch(() => {});
    await unlink(wavFile).catch(() => {});
  }
}
