# Tvoice

[![tests](https://github.com/Aramente/tvoice/actions/workflows/test.yml/badge.svg)](https://github.com/Aramente/tvoice/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)
[![status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

> **Status: alpha.** Tvoice gives you a live shell on your Mac. Read [SECURITY.md](SECURITY.md) before deploying anywhere that isn't your own laptop on your own private network.

Mobile-first PWA terminal for steering AI coding agents from your phone. One command, a QR code, and your phone becomes the command center for Claude Code.

```
npx tvoice
```

Scan the QR code on your phone. You're in. No App Store, no SSH setup, no 20-minute Cloudflare + tmux + ntfy + mosh + Tailscale ceremony. Just a terminal that actually works on a 6-inch screen — with a special-key toolbar, iOS-native-style text selection, collapsible AI output, push notifications when your agent needs input, and **local Whisper voice input that works inside the iOS PWA sandbox**.

## Table of contents

- [Why Tvoice exists](#why-tvoice-exists)
- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [CLI flags](#cli-flags)
- [How auth works](#how-auth-works)
- [How sessions work](#how-sessions-work)
- [The special key toolbar](#the-special-key-toolbar)
- [Voice input](#voice-input-ios-compatible--runs-whispercpp-on-your-mac)
- [AI output rendering](#ai-output-rendering)
- [Push notifications](#push-notifications)
- [Gestures](#gestures)
- [Configuration](#configuration)
- [Development](#development)
- [Architecture](#architecture)
- [Status](#status)
- [Security](#security)
- [License](#license)

## Why Tvoice exists

Every existing way to reach your Mac terminal from your phone fails at something:

- **Termius / Blink Shell / Prompt**: paywalled, native-app locked, subscription-happy, no AI-awareness
- **ttyd / WeTTY / GoTTY**: no mobile UX, no special-key toolbar, login is painful
- **SSH + Tailscale + tmux + mosh + ntfy**: works but takes 20 minutes to set up, and every piece has to be configured by hand
- **Claude Code mobile tab**: still not shipped

Tvoice is the thing I wanted when I was trying to kick off a Claude Code session from the couch and realized I'd have to re-auth Sentry, re-attach tmux, and poke at a 390px-wide terminal through mobile Safari with no Ctrl key.

## What it is

- A **Node.js server** running on your Mac/laptop that spawns tmux-backed terminal sessions
- A **mobile-first PWA** served by that server — xterm.js under the hood, with a special-key toolbar docked above the virtual keyboard, sticky Ctrl/Alt modifiers, swipe-to-switch-tabs, pinch-to-zoom, and AI-aware output rendering
- **Cloudflare Tunnel** integration (or Tailscale Serve) so you can reach your laptop from anywhere
- **Web Push notifications** when a long-running command finishes or an agent needs you to approve a change
- **JWT auth** with a one-time login token encoded in the initial URL, persistent cookie afterwards
- **Voice input** via the Web Speech API with technical-term post-processing
- **Command history** and **snippets** synced across your devices
- **OLED-optimized dark theme** (`#0A0A0A` / `#E0E0E0`) that doesn't smear on OLED or halate for astigmatic viewers

## Quick start

```bash
npx tvoice
```

That's it. If `cloudflared` is installed (`brew install cloudflared`), Tvoice spins up a free Cloudflare Quick Tunnel, mints a one-time login token, and prints a QR code. Scan it with your phone, install the PWA (iOS: Share → Add to Home Screen), done.

If you prefer Tailscale:

```bash
npx tvoice --tunnel tailscale
```

If you're only testing on localhost or your LAN:

```bash
npx tvoice --tunnel none
```

### Requirements

- Node.js **18+**
- `tmux` (optional but strongly recommended — enables session persistence across disconnects)
- `cloudflared` or `tailscale` (optional — for remote access over public internet)

All of these are one `brew install` away on macOS:

```bash
brew install node tmux cloudflared
```

## First-time setup (recommended)

```bash
npx tvoice --setup
```

This walks you through:
1. Generates JWT + VAPID secrets (stored in `~/.tvoice/config.json`, mode 600)
2. Starts the server + tunnel
3. Prints a QR code — scan it on your phone to log in
4. Tells you the **permanent URL** to bookmark

After the first login, the cookie is set and you never need a token again. Just open your bookmark. The cookie is effectively permanent (10 years).

### Run as a background service (macOS)

So tvoice is always on — open the PWA on your phone anytime and your Mac terminal is there:

```bash
# Create a LaunchAgent
cat > ~/Library/LaunchAgents/com.tvoice.server.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tvoice.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/tvoice/bin/tvoice.js</string>
    <string>--tunnel</string>
    <string>tailscale</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tvoice.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/tvoice.err.log</string>
  <key>WorkingDirectory</key><string>/Users/YOU</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>/Users/YOU</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
</dict>
</plist>
EOF

# Edit the paths above, then load it:
launchctl load ~/Library/LaunchAgents/com.tvoice.server.plist
```

### Run as a background service (Linux systemd)

```bash
cat > ~/.config/systemd/user/tvoice.service << 'EOF'
[Unit]
Description=Tvoice terminal server
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/tvoice/bin/tvoice.js --tunnel tailscale
Restart=always
RestartSec=5
Environment=HOME=%h
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tvoice
```

## CLI flags

```
tvoice [options]

Options:
  -p, --port <number>       port to listen on (default: 3000)
  -h, --host <string>       host to bind on (default: 127.0.0.1)
  -t, --tunnel <backend>    tunnel backend: cloudflare | tailscale | none (default: cloudflare)
  --no-tunnel               disable tunneling, serve on localhost only
  --print-login             print login URL and exit (useful for scripting)
  -V, --version             print version
  --help                    show help
```

## How auth works

When you run `npx tvoice`, the CLI:

1. Boots the Express + WebSocket server on the specified port
2. Starts a Cloudflare Quick Tunnel (or Tailscale Serve) and captures the public URL
3. Mints a one-time login token (JWT, 10-minute TTL, single-use)
4. Prints `{publicUrl}/login?t={token}` as both text and a QR code

When you scan the QR:

1. Your phone hits `/login?t=…`
2. The server verifies and burns the token
3. Server issues a 7-day JWT access cookie (`HttpOnly`, `SameSite=Strict`, `Secure` when over HTTPS)
4. You land on the main PWA
5. The WebSocket upgrade handshake verifies the cookie before connecting

If the URL/cookie expires, just re-run `npx tvoice` and scan the new QR.

## How sessions work

Each terminal tab is backed by:

- **One tmux session** named `tvoice-{id}` that owns the real shell
- **One node-pty process** attached to that tmux session, streaming output to the WebSocket

When your phone disconnects (backgrounded app, lock screen, network switch):

- The WebSocket drops
- node-pty is killed
- **The tmux session keeps running** — your work is not lost
- When you reconnect, a new node-pty attaches to the same tmux session, and the server replays recent output from a ring buffer

This means you can start a long `claude` session on your Mac, close your laptop lid, open the PWA on your phone, and resume the same session seamlessly.

If `tmux` is not installed, Tvoice falls back to a direct `$SHELL -l` PTY — sessions still work but don't survive disconnects.

## The special key toolbar

The single most important UI element on mobile. Without it, terminal work on a phone is effectively impossible.

- **Primary row** (always visible): `ESC` `TAB` `CTRL` `ALT` `↑` `↓` `←` `→` `mic` `snip` `▲`
- **Expanded row** (swipe up on primary, or tap `▲`): `/ - | $ ~ _ * " ' : ; =`
- **AI row** (auto-revealed when Claude Code is detected): `yes⏎` `no⏎` `^C` `^Z` `collapse` `jump ai`

Modifiers are **sticky** (Termux pattern): tap `CTRL` once, the next keystroke gets Ctrl'd, then it auto-deactivates. All touch targets are at least 44×44px per Apple HIG.

## AI output rendering

When Claude Code is detected in the output stream, Tvoice:

- Reveals the AI row in the toolbar with one-tap `yes` / `no` buttons
- Highlights the toolbar with a pulsing glow when Claude is awaiting input
- Vibrates the phone (if supported) on awaiting-input transitions
- Marks the current tab with a blue dot (or yellow pulsing when awaiting)

Detection is loose and heuristic-based right now. The plan is to tighten it against real Claude Code output as soon as it's running against a live session.

## Voice input (iOS-compatible — runs whisper.cpp on your Mac)

Web Speech API is blocked inside iOS Safari PWAs, so Tvoice takes a different path: the phone records audio with `MediaRecorder`, streams the blob to a `POST /api/transcribe` endpoint on your Mac, and the server hands it to a locally installed `whisper.cpp` for transcription. Text comes back and gets injected straight into the terminal. Audio never leaves your machine. No API keys. On an M-series Mac with the `base.en` model you'll get transcriptions in well under a second.

### Setup

Two one-time installs on the Mac:

```bash
# ffmpeg is used to transcode MediaRecorder's webm/mp4 to 16 kHz mono WAV
brew install ffmpeg

# whisper.cpp — either brew install it...
brew install whisper-cpp

# ...or build from source if the brew formula doesn't work on your setup:
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper.cpp
cd /tmp/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
cp build/bin/whisper-cli ~/.local/bin/
mkdir -p ~/.local/lib
cp build/src/libwhisper* build/ggml/src/libggml* \
   build/ggml/src/ggml-blas/libggml-blas* \
   build/ggml/src/ggml-metal/libggml-metal* ~/.local/lib/
install_name_tool -add_rpath "$HOME/.local/lib" ~/.local/bin/whisper-cli
```

Then download the `base.en` model (~142 MB) to `~/.tvoice/models/`:

```bash
mkdir -p ~/.tvoice/models
curl -L -o ~/.tvoice/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Tvoice will also auto-download the model to `~/.tvoice/models/` the first time you tap the mic button if it can reach huggingface.co.

### Usage

- Tap the `mic` button in the tvoice header (top-right, next to `+` and `…`)
- A fullscreen listening overlay appears with a pulsing ring that reacts to your voice
- Speak
- Auto-stops after ~1.5 s of silence, or tap "Cancel" to abort
- The server transcribes and the text lands in your terminal
- Hit return to run it

The recognizer gets nudged toward developer vocabulary via a prompt bias that includes `git`, `npm`, `tmux`, `claude`, etc. — so `git status` comes through as two words, not "get status".

## Push notifications

Tap `Enable push notifications` in the menu drawer. On iOS you need to install the PWA to your home screen first (iOS 16.4+).

The server will push a notification when:

- A long-running command finishes (with exit code)
- Claude Code is awaiting input (high priority, with `approve` / `deny` action buttons)
- The connection drops unexpectedly

## Gestures

| Gesture | Action |
|---|---|
| Swipe left/right on terminal | Switch tab |
| Pinch on terminal | Zoom font size |
| Three-finger tap | Paste from clipboard |
| Swipe up on primary toolbar row | Expand toolbar |
| Tap `mic` | Voice input (Web Speech API) |
| Tap `snip` | Open snippets drawer |

## Configuration

Config lives at `~/.tvoice/config.json` and is created automatically on first run. JWT and VAPID secrets are generated there. You can also override everything with environment variables (`TVOICE_PORT`, `TVOICE_HOST`, `TVOICE_TUNNEL`, `TVOICE_JWT_SECRET`, etc. — see `.env.example`).

Per-device snippets, themes, and font size are persisted to the same config file via the `/api/settings` endpoint.

## Development

```bash
git clone https://github.com/Aramente/tvoice.git
cd tvoice
npm install
npm run dev        # localhost only, no tunnel
npm test           # smoke tests via node:test
```

### Running the tests

```bash
npm test
```

The test suite covers server boot, auth token round-trip, login flow, and burn-after-use enforcement. It does not exercise tmux or WebSocket terminal sessions (those need real integration testing).

### Regenerating icons

Tvoice ships with an SVG icon that works on all modern browsers. If you want proper PNG icons for iOS home-screen installation:

```bash
npm install --no-save sharp
node scripts/generate-icons.js
```

This will generate `icon-192.png`, `icon-192-maskable.png`, `icon-512.png`, and `icon-512-maskable.png` in `src/public/icons/`.

## Architecture

```
┌────────────────────────────┐
│  Phone (PWA)               │
│                            │
│  xterm.js                  │
│   + fit/serialize/links    │
│   + AIRenderer overlay     │
│   + KeyToolbar             │
│   + TabManager             │
│   + Gestures               │
│   + VoiceInput             │
│   + PushClient (SW)        │
└────────────┬───────────────┘
             │  wss:// (WebSocket)
             │  via Cloudflare Tunnel
┌────────────┼───────────────┐
│  Mac       │               │
│            ▼               │
│  Express + ws              │
│   + JWT auth               │
│   + SessionManager         │
│   + RingBuffer             │
│   + PushDispatcher (VAPID) │
│            │               │
│            ▼               │
│  node-pty ──► tmux sessions│
│               (one per tab)│
│                            │
│  cloudflared → localhost   │
└────────────────────────────┘
```

## Project layout

```
tvoice/
├── bin/
│   └── tvoice.js          # CLI entry (npx tvoice)
├── src/
│   ├── server/
│   │   ├── index.js           # Express + WS bootstrap
│   │   ├── config.js          # ~/.tvoice/config.json
│   │   ├── auth.js            # JWT, login tokens, rate limit
│   │   ├── session-manager.js # node-pty + tmux lifecycle
│   │   ├── ws-handler.js      # WebSocket protocol
│   │   ├── tunnel.js          # cloudflared / tailscale
│   │   ├── push.js            # Web Push dispatcher
│   │   ├── routes.js          # REST endpoints
│   │   └── ring-buffer.js     # output replay buffer
│   └── public/                # Served PWA
│       ├── index.html
│       ├── login.html
│       ├── manifest.webmanifest
│       ├── sw.js              # Service worker
│       ├── css/               # OLED theme, toolbar, tabs, AI
│       ├── js/
│       │   ├── app.js         # Bootstrap
│       │   ├── terminal.js    # xterm.js wrapper
│       │   ├── toolbar.js     # Special key toolbar
│       │   ├── tabs.js        # Tab manager
│       │   ├── gestures.js    # Touch gestures
│       │   ├── ai-render.js   # AI output detection
│       │   ├── voice.js       # Web Speech API
│       │   ├── reconnect.js   # WebSocket reconnection
│       │   ├── push-client.js # Web Push subscription
│       │   ├── history.js     # Command history
│       │   ├── snippets.js    # Saved snippets
│       │   ├── themes.js      # Color themes
│       │   └── viewport.js    # visualViewport handling
│       └── icons/
├── scripts/
│   ├── generate-vapid.js      # Generate VAPID keys
│   └── generate-icons.js      # Generate PNG icons from SVG (needs sharp)
└── tests/
    └── server.test.js
```

## Status

**Very alpha.** This is a one-shot build — a lot of pieces have never been tested end-to-end against a real Claude Code session on a real phone. Expect bugs. Expect rough edges. File issues, send PRs, make it better.

Things that are most likely to need tightening first:
- AI detection heuristics (the regexes in `ai-render.js`)
- iOS PWA keyboard-dock behavior (the `visualViewport` math)
- Cloudflare Tunnel URL parsing regex
- tmux capture-pane performance under very chatty sessions

## Security

Tvoice gives the authenticated user a live shell on the machine running the server. That's the highest privilege a process can have on your account. Read [SECURITY.md](SECURITY.md) before deploying anywhere that isn't your own laptop on your own private network — especially the threat model and the "what Tvoice does NOT do yet" section.

Short version:
- Single trust boundary: anyone with a valid cookie gets a shell as your user
- Safe deployment: over your own Tailscale tailnet, or localhost only
- Risky: on a LAN with guests, or behind a public reverse proxy
- Don't: expose to the public internet without additional auth in front

To report a vulnerability, open a private GitHub Security Advisory at [github.com/Aramente/tvoice/security/advisories/new](https://github.com/Aramente/tvoice/security/advisories/new) — please don't file a public issue.

## License

MIT. See [LICENSE](LICENSE).

---

Built because running Claude Code from the couch shouldn't require a 20-minute SSH ceremony.
