# Tvoice

[![tests](https://github.com/Aramente/tvoice/actions/workflows/test.yml/badge.svg)](https://github.com/Aramente/tvoice/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/tvoice.svg)](https://www.npmjs.com/package/tvoice)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your Mac terminal, on your phone.** Run AI coding agents from the couch. One command to start, scan a QR code, and your iPhone becomes a full terminal — with a keyboard that actually works on a 6-inch screen, voice-to-text powered by local Whisper, and sessions that survive disconnects.

```
npx tvoice --setup
```

> Tvoice is self-hosted. It runs on **your** Mac. Your credentials (Claude, GitHub, SSH, AWS) stay on **your** machine. Nothing is sent to any cloud — not even voice recordings.

---

## What you get

- **A real terminal on your phone** — xterm.js PWA that you install from the browser, no App Store
- **Special-key toolbar** — ESC, TAB, CTRL, ALT, arrows, all the characters your phone keyboard hides. Sticky modifiers (tap CTRL once, next key is Ctrl'd)
- **Voice input** — tap mic, speak, text appears in your terminal. Runs [whisper.cpp](https://github.com/ggerganov/whisper.cpp) on your Mac, not a cloud API. Works on iOS where Web Speech is blocked
- **Session persistence** — each tab is a tmux session. Lock your phone, switch networks, close the app — reconnect and everything is still there
- **Copy and paste that works** — long-press a word, drag the handles, tap Copy. Just like iOS Notes. Paste modal for getting text into the terminal
- **Use from Mac AND phone simultaneously** — same tmux session, mirrored in real-time. Start on the couch, continue at your desk
- **Push notifications** — get alerted when a long command finishes or an AI agent needs your input
- **Secure by default** — one-time login tokens, device-bound cookies, optional TOTP 2FA, audit log, JWT rotation. Refuses to run as root or bind to public interfaces without explicit opt-in. See [SECURITY.md](SECURITY.md)

## Quick start

### 1. Install and run

```bash
npx tvoice --setup
```

This generates secrets, starts the server, and prints a QR code.

### 2. Scan the QR on your phone

Open it in Safari. The cookie is set — bookmark the URL. It won't expire.

### 3. (Optional) Set up voice

```bash
bash node_modules/tvoice/scripts/install-whisper.sh
# or manually:
brew install ffmpeg whisper-cpp
```

### 4. (Optional) Keep it always on

**macOS** — create a LaunchAgent so tvoice starts at login:

```bash
cat > ~/Library/LaunchAgents/com.tvoice.server.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tvoice.server</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>YOUR_PATH/bin/tvoice.js</string>
    <string>--tunnel</string><string>tailscale</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tvoice.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/tvoice.err.log</string>
  <key>WorkingDirectory</key><string>YOUR_HOME</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>YOUR_HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
</dict></plist>
PLIST

# Replace YOUR_PATH and YOUR_HOME, then:
launchctl load ~/Library/LaunchAgents/com.tvoice.server.plist
```

**Linux** — systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tvoice.service << 'EOF'
[Unit]
Description=Tvoice
After=network-online.target
[Service]
ExecStart=/usr/bin/node YOUR_PATH/bin/tvoice.js --tunnel tailscale
Restart=always
Environment=HOME=%h PATH=/usr/local/bin:/usr/bin:/bin
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now tvoice
```

## Requirements

- **Node.js 18+** (required)
- **tmux** (recommended — enables session persistence)
- **Cloudflare Tunnel** or **Tailscale** (for remote access — otherwise localhost only)
- **whisper-cpp + ffmpeg** (for voice input)

macOS one-liner: `brew install node tmux cloudflared ffmpeg`

## How it works

```
Phone (PWA)                        Your Mac
  xterm.js terminal                  Node.js server (Express + ws)
  special-key toolbar                node-pty → tmux sessions
  voice recorder        ← wss →     whisper.cpp transcription
  push notifications                 JWT auth + audit log
                                     Cloudflare Tunnel / Tailscale
```

Your Mac runs a Node server that spawns tmux-backed terminal sessions. Your phone connects via a WebSocket over an encrypted tunnel (Cloudflare or Tailscale). The PWA renders xterm.js with a mobile-optimized toolbar and gestures. Voice recordings are transcribed locally by whisper.cpp — audio never leaves the machine.

## Networking options

| Flag | How your phone reaches your Mac | Best for |
|---|---|---|
| `--tunnel cloudflare` (default) | Cloudflare Quick Tunnel — random public HTTPS URL | Quick testing from anywhere |
| `--tunnel tailscale` | Tailscale Serve — private mesh, WireGuard encrypted | Daily use (recommended) |
| `--no-tunnel` | localhost only | Desktop browser testing |

## CLI reference

```
npx tvoice [options]

  --setup              First-time setup wizard
  -p, --port <n>       Port (default: 3000)
  -t, --tunnel <type>  cloudflare | tailscale | none
  --no-tunnel          Localhost only
  --allow-lan          Allow binding to 0.0.0.0 (use with caution)
  --reset-totp         Disable 2FA from the host (recovery)
  --rotate-secret      Rotate the JWT signing secret
  --print-login        Print a fresh login URL and exit
  -V, --version        Print version
```

## Security

Tvoice gives the authenticated user a **live shell** on your Mac. Read [SECURITY.md](SECURITY.md) for the full threat model.

**Built-in protections:**
- One-time login tokens (15 min, single use)
- Device-bound JWT cookies (stolen cookies fail on a different browser)
- Optional TOTP two-factor authentication
- JWT secret rotation (`--rotate-secret`)
- Rate limiting on login + voice endpoints
- Append-only audit log (`~/.tvoice/audit.log`)
- Security headers (CSP, Referrer-Policy, X-Frame-Options)
- Refuses to run as root
- Refuses to bind to public interfaces without `--allow-lan`

**Safe:** Tailscale tailnet, localhost.
**Risky:** public Cloudflare tunnel left running unattended, open LAN.
**Don't:** expose directly to the internet without additional auth.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — especially for security hardening, iOS PWA improvements, and whisper install automation.

## License

MIT
