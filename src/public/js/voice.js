// Voice input via Web Speech API. Post-processes common technical terms
// that the recognizer butchers (e.g., "get hub" -> "github").

const TECHNICAL_REPLACEMENTS = [
  [/\bget hub\b/gi, 'github'],
  [/\bgit hub\b/gi, 'github'],
  [/\bnode j s\b/gi, 'nodejs'],
  [/\bnode\.? j\.? s\b/gi, 'nodejs'],
  [/\breact j s\b/gi, 'react'],
  [/\bp w a\b/gi, 'pwa'],
  [/\bssh\b/gi, 'ssh'],
  [/\bapi\b/gi, 'api'],
  [/\bjson\b/gi, 'json'],
  [/\bcommit\b/gi, 'commit'],
  [/\bclaude code\b/gi, 'claude'],
  [/\bt mux\b/gi, 'tmux'],
  [/\bcd\b/gi, 'cd'],
  [/\bls\b/gi, 'ls'],
  [/\bnp m\b/gi, 'npm'],
  [/\bnpm\b/gi, 'npm'],
  [/\bnpx\b/gi, 'npx'],
];

export class VoiceInput {
  constructor({ onResult, onState }) {
    this.onResult = onResult || (() => {});
    this.onState = onState || (() => {});
    this.rec = null;
    this.active = false;
    this.supported = typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }

  start(lang = 'en-US') {
    if (!this.supported) {
      this.onState('unsupported');
      return;
    }
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.rec = new Rec();
    this.rec.lang = lang;
    this.rec.interimResults = false;
    this.rec.continuous = false;
    this.rec.maxAlternatives = 1;

    this.rec.onstart = () => {
      this.active = true;
      this.onState('listening');
    };
    this.rec.onerror = (e) => {
      this.active = false;
      // Map SpeechRecognitionErrorEvent codes to helpful explanations
      const err = e.error || 'unknown';
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      let hint = '';
      switch (err) {
        case 'service-not-allowed':
          hint = isIOS
            ? 'iOS Safari blocks Web Speech in PWAs. Use the iPhone keyboard mic button instead.'
            : 'Speech service refused. Check browser permission settings.';
          break;
        case 'not-allowed':
          hint = 'Microphone permission denied. Grant access in your browser settings.';
          break;
        case 'no-speech':
          hint = 'No speech detected.';
          break;
        case 'audio-capture':
          hint = 'No microphone found.';
          break;
        case 'network':
          hint = 'Network error — Web Speech uses a cloud service on some browsers.';
          break;
        default:
          hint = `Voice error: ${err}`;
      }
      this.onState('error', hint);
    };
    this.rec.onend = () => {
      this.active = false;
      this.onState('idle');
    };
    this.rec.onresult = (ev) => {
      let text = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      text = this._postProcess(text.trim());
      if (text) this.onResult(text);
    };

    try {
      this.rec.start();
    } catch (err) {
      this.onState('error', err.message);
    }
  }

  stop() {
    if (this.rec && this.active) {
      try { this.rec.stop(); } catch { /* ignore */ }
    }
  }

  _postProcess(text) {
    let out = text;
    for (const [pat, rep] of TECHNICAL_REPLACEMENTS) {
      out = out.replace(pat, rep);
    }
    return out;
  }
}
