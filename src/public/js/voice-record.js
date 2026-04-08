// MediaRecorder wrapper with auto-stop on silence detection.
//
// This is the path that actually works inside an iOS Safari PWA, unlike
// the Web Speech API. We capture raw audio, watch the RMS level via an
// AudioContext + AnalyserNode, and stop ourselves after `silenceMs` of
// quiet following at least one detected speech burst. The blob is then
// uploaded to /api/transcribe which hands it to whisper.cpp on the Mac.

const DEFAULT_MAX_MS = 30_000;       // hard cap on recording length
const DEFAULT_SILENCE_MS = 1500;     // stop this long after last speech
const SPEECH_RMS = 0.025;            // threshold for "they're talking"
const MIN_SPEECH_MS = 250;           // ignore clicks / short bursts

export class VoiceRecorder {
  constructor({
    onStart = () => {},
    onLevel = () => {},
    onStop  = () => {},
    onError = () => {},
    silenceMs = DEFAULT_SILENCE_MS,
    maxMs = DEFAULT_MAX_MS,
  } = {}) {
    this.onStart = onStart;
    this.onLevel = onLevel;
    this.onStop  = onStop;
    this.onError = onError;
    this.silenceMs = silenceMs;
    this.maxMs = maxMs;

    this.active = false;
    this.cancelled = false;
    this.stream = null;
    this.recorder = null;
    this.audioCtx = null;
    this.analyser = null;
    this.chunks = [];
    this.rafId = null;
    this.silenceTimer = null;
    this.startedAt = 0;
    this.speechStartedAt = 0;
    this.hadSpeech = false;
    this.mimeType = '';
  }

  async start() {
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.onError(err.message || 'microphone permission denied');
      return;
    }

    // Level metering via AnalyserNode (works on iOS Safari PWAs)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);

    // Pick a MediaRecorder mimeType the platform actually supports. iOS
    // Safari will reject webm;codecs=opus and fall through to mp4.
    this.mimeType = pickMimeType();
    const options = this.mimeType ? { mimeType: this.mimeType } : {};
    try {
      this.recorder = new MediaRecorder(this.stream, options);
    } catch (err) {
      this.onError('MediaRecorder not supported: ' + err.message);
      this._cleanup();
      return;
    }

    this.chunks = [];
    this.cancelled = false;
    this.hadSpeech = false;
    this.startedAt = Date.now();

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this._finalize();
    this.recorder.onerror = (e) => {
      this.onError('recorder error: ' + (e.error?.message || 'unknown'));
      this._cleanup();
    };

    try {
      this.recorder.start();
    } catch (err) {
      this.onError('recorder.start failed: ' + err.message);
      this._cleanup();
      return;
    }

    this.active = true;
    this.onStart();
    this._watchLevel();
  }

  _watchLevel = () => {
    if (!this.active || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    this.onLevel(rms);

    const now = Date.now();
    const elapsed = now - this.startedAt;

    if (rms > SPEECH_RMS) {
      if (!this.hadSpeech) {
        this.speechStartedAt = now;
        this.hadSpeech = true;
      }
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
    } else if (this.hadSpeech && !this.silenceTimer) {
      // A brief silence after real speech → start the auto-stop countdown
      const speechDuration = now - this.speechStartedAt;
      if (speechDuration >= MIN_SPEECH_MS) {
        this.silenceTimer = setTimeout(() => this.stop(), this.silenceMs);
      }
    }

    // Hard time cap
    if (elapsed > this.maxMs) {
      this.stop();
      return;
    }

    this.rafId = requestAnimationFrame(this._watchLevel);
  };

  stop() {
    if (!this.active) return;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
  }

  cancel() {
    if (!this.active) return;
    this.cancelled = true;
    this.chunks = [];
    this.stop();
  }

  _finalize() {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }

    const blob = (!this.cancelled && this.chunks.length > 0)
      ? new Blob(this.chunks, { type: this.mimeType || 'audio/webm' })
      : null;
    this.chunks = [];
    this._cleanup();
    this.onStop(blob, { cancelled: this.cancelled });
  }

  _cleanup() {
    this.active = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.stream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = null;
    }
    this.analyser = null;
    this.recorder = null;
  }
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* ignore */ }
  }
  return '';
}
