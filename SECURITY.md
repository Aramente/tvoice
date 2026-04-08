# Security policy

Tvoice gives its user a live shell on the machine it runs on. That's the entire point of the project, and it's also its biggest attack surface. Please read this document carefully before running Tvoice anywhere that isn't your own laptop on your own private network.

## Threat model

Tvoice is designed around a **single trust boundary**: a person running the server on a machine they own, connecting from a phone they own, over a network they already trust (Tailscale tailnet, home LAN, or a Cloudflare Quick Tunnel they bring up themselves). Anyone who crosses that boundary gets a shell.

### What an authenticated attacker can do

If someone defeats Tvoice's auth layer — cookie theft, cookie forwarding, stolen phone, JWT secret disclosure — **they get an interactive shell on your Mac as your user**. That means they can:

- Read and exfiltrate any file your user can read (SSH keys, browser cookies, `~/.aws/credentials`, `~/.npmrc`, saved tokens, your vault, etc.)
- Write, modify, or delete any file your user owns
- Install persistence (cron jobs, LaunchAgents, shell rc files)
- Run arbitrary processes, including long-running ones
- Pivot from your Mac to anything else it can reach on your network

**Treat a valid Tvoice cookie the same way you'd treat root SSH on your primary machine.** It is the same amount of power.

### What Tvoice does to reduce that risk

- **One-time login tokens** minted by the CLI with a 15-minute TTL and burned after first use
- **JWT access cookie**, HttpOnly + SameSite=Strict + Secure over HTTPS, 7-day lifetime
- **Per-IP rate limiting with exponential lockout** on the login endpoint (5 attempts → 10 min lockout)
- **Per-IP rate limiting** on `/api/transcribe` (20 requests/minute — the most expensive endpoint by far)
- **Security headers** on every response: CSP, `Referrer-Policy: no-referrer` (so the login token never leaks via the `Referer` header), `X-Frame-Options: DENY`, `Permissions-Policy` scoped to `microphone=(self)` only
- **Push subscription endpoint allowlist**: the push dispatcher only accepts endpoints under `googleapis.com`, `mozilla.com`, `windows.com`, or `apple.com` — preventing an attacker with a valid cookie from seeding arbitrary URLs and turning the push loop into an HTTP amplifier
- **Language code allowlist** on `/api/transcribe` — prevents injection into the whisper `-l` flag
- **Audio upload ceiling** of 3 MB — caps DoS cost
- **Idle session reaper** kills tmux sessions that have been inactive for more than 7 days

### What Tvoice does **not** do (yet)

- **No multi-factor auth.** A single cookie is the whole auth layer. There's no TOTP, no WebAuthn, no device binding.
- **No audit log.** There's no record of who logged in when, what sessions they created, or what commands they ran. If you're compromised, you won't know until you notice.
- **No JWT secret rotation.** The secret is generated on first run and never rotates automatically.
- **No IP allowlist.** Anyone who can reach the server's port and present a valid cookie is in.
- **No account model.** Tvoice is single-user by design. There is no concept of "your account" vs "my account."
- **No sandboxing of the shell.** Tmux sessions run as the user who started the server. Nothing prevents shell commands from touching anything else.

## Deployment guidance

### Safe

- **Over your own Tailscale tailnet.** This is the recommended deployment. Tailscale's WireGuard mesh gives you device-level identity, automatic TLS via MagicDNS, and the ability to share access with explicit ACLs. An attacker would need to compromise a device that's already in your tailnet.
- **On localhost only** (`--no-tunnel`). No network exposure at all.
- **Over a Cloudflare Quick Tunnel** for a short-lived testing session. The tunnel URL is a random `*.trycloudflare.com` subdomain that isn't indexed anywhere. Still brings the full attack surface to the public internet, though — don't leave it running unattended.

### Risky

- **On a LAN with guests on it.** Anyone on the network can reach the server and attempt login. The rate limiter will slow them down, but your only real protection is the login token / cookie.
- **Behind a reverse proxy on a public domain.** Every bot on the internet will probe it. Doable, but only with a hardened auth layer in front.

### Don't

- **Don't expose Tvoice directly to the public internet without additional authentication.** A lost phone or a stolen cookie is immediate full shell access.
- **Don't run Tvoice as `root`** or any privileged user.
- **Don't run Tvoice on a shared server** where other users share the filesystem with you. The server reads `~/.tvoice/config.json` with mode 600, but a root-level compromise on that box compromises every user's Tvoice instance.
- **Don't host Tvoice as a "SaaS" where strangers can sign up.** There is no per-user isolation. If someone signs up, they share the shell with everyone else. This is not that kind of product.

## Credential handling

Tvoice **does not store any third-party credentials**. It has no concept of your Claude account, your GitHub account, your AWS keys, or anything else. All Tvoice stores in `~/.tvoice/config.json` is:

- A single JWT signing secret (generated on first run, mode 600)
- A Web Push VAPID keypair (generated on first run)
- Your cosmetic settings (font size, theme, saved snippets, voice language)
- Any Web Push subscriptions you've enabled

Whatever shell-level credentials your user has access to (Claude Code OAuth token in `~/.claude/`, `~/.ssh/id_*`, `~/.aws/credentials`, GitHub `gh auth` tokens, environment variables) are **all reachable from a Tvoice shell just like they're reachable from any other terminal you open on the same machine**. Tvoice is a dumb pipe to your existing terminal.

## Reporting a vulnerability

If you believe you've found a security issue in Tvoice, **please don't open a public GitHub issue**. Email the maintainer at the contact on the GitHub profile, or open a private GitHub security advisory at [github.com/Aramente/tvoice/security/advisories/new](https://github.com/Aramente/tvoice/security/advisories/new).

I'll acknowledge your report within 72 hours and work with you on a fix timeline.

## What I'd like to add before calling Tvoice safe for deployments I can't personally audit

- Audit log to `~/.tvoice/tvoice.log` (JSON lines) with login attempts, session creates, and optional per-command logging
- Optional TOTP second factor
- Per-device cookie binding so a cloned cookie on a different device is rejected
- Configurable session timeout (currently fixed at 7 days)
- JWT secret rotation with multi-key support so rotation doesn't log everyone out
- Shorter default rate-limit windows with a DDoS back-off mode
