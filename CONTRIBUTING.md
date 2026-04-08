# Contributing to Tvoice

Thanks for considering a contribution. Tvoice is a small, opinionated project, but PRs are welcome — especially anything that hardens security, improves the iOS PWA experience, or makes the install path simpler.

## Before you start

1. **Open an issue first** for non-trivial changes. I'd rather talk through the design before you write code than ask you to throw away an afternoon's work because the approach doesn't fit.
2. **Read [SECURITY.md](SECURITY.md).** Tvoice gives its user a shell. Anything that touches auth, the WebSocket handshake, the session manager, or the routes layer needs to be reviewed with that fact in mind.
3. **Run the tests** before you push: `npm test`. The suite runs in under a second and covers auth, routes, ring buffer, security headers, rate limiting, and whisper detection. There are no flaky tests — if a test is failing, the code is wrong, not the test.

## Local development

```bash
git clone https://github.com/Aramente/tvoice.git
cd tvoice
npm install
npm run dev    # localhost only, no tunnel
npm test
```

The dev script binds to `127.0.0.1:3000` and skips the Cloudflare/Tailscale tunnel, so you can iterate without exposing anything. Open the printed login URL in your desktop browser to test the PWA shell, or scan the QR with a phone on your LAN.

## Code style

- ES modules everywhere (`"type": "module"` in `package.json`).
- Pure JS, no TypeScript. Files are small enough that the tradeoff doesn't pay off yet.
- Prefer `async`/`await` over chained promises.
- Keep functions short. If a function is doing two things, split it.
- Comments explain *why*, not *what*. The code already says what it does — comments are for the surprise.
- No emoji in source files unless the user explicitly asked for it.

## Tests

- **Server-side tests use `node:test`.** Example tests are in `tests/`. There are no test runners or assertion libraries beyond Node's built-ins.
- **Every test that boots `startServer` MUST set `TVOICE_CONFIG_DIR`** to a temp directory before importing any server module. There's a precedent for this in every existing test file. If you don't, your test will silently clobber the developer's real `~/.tvoice/config.json`. This was a real bug — see commit `d2ca2af`.
- **Don't mock things you don't have to.** The server is small enough to boot per-test. The whole 32-test suite finishes in under a second.

## Areas where I'd love help

- **Native iOS or Android wrappers** that pre-install the PWA and skip the home-screen install dance
- **Hardening the auth layer**: TOTP, WebAuthn, device-bound cookies, JWT rotation
- **An audit log** writing JSON lines to `~/.tvoice/tvoice.log`
- **Better whisper.cpp install path** — auto-build via the postinstall hook on macOS, with graceful fallback if the toolchain is missing
- **Finer-grained AI output detection** — the current Claude Code heuristic is loose
- **Translations** — the UI strings are all in `index.html` and `app.js`. Pulling them into a single object would unlock i18n
- **A real demo GIF** showing a Claude Code session being driven from a phone

## Pull request checklist

- [ ] Tests pass: `npm test`
- [ ] No new dependencies in `package.json` without a discussion in the issue first
- [ ] No changes to `~/.tvoice/config.json` from tests
- [ ] If you touched the routes, you added a test for the new behavior
- [ ] If you touched anything security-related, you also updated `SECURITY.md`
- [ ] Commit message explains the *why*, not just the *what*

## Code of conduct

Be kind, be technical, be specific. That's it.
