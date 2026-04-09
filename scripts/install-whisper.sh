#!/usr/bin/env bash
# install-whisper.sh — one-command install of whisper.cpp + ffmpeg + the
# base multilingual model for Tvoice's voice-to-text feature.
#
# Usage:
#   bash scripts/install-whisper.sh
#
# What it does:
#   1. Installs ffmpeg via Homebrew if not present
#   2. Tries `brew install whisper-cpp`. If that fails (permissions),
#      builds whisper.cpp from source and installs to ~/.local/bin
#   3. Downloads ggml-base.bin (~142 MB) to ~/.tvoice/models/
#
# Prerequisites: Homebrew, git, cmake (Xcode CLT), curl.
# Platform: macOS only. Linux users: install ffmpeg + whisper.cpp
# via your package manager and download the model manually.

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[0;90m'
RESET='\033[0m'

info()  { echo -e "${CYAN}  →${RESET} $1"; }
ok()    { echo -e "${GREEN}  ✓${RESET} $1"; }
fail()  { echo -e "${RED}  ✗${RESET} $1"; }
dim()   { echo -e "${DIM}    $1${RESET}"; }

echo ""
echo -e "  ${CYAN}Tvoice voice setup${RESET}"
echo ""

# ---------- ffmpeg ----------
if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg already installed ($(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3))"
else
  info "Installing ffmpeg via Homebrew..."
  if brew install ffmpeg 2>&1 | tail -3; then
    ok "ffmpeg installed"
  else
    fail "ffmpeg install failed. Try: brew install ffmpeg"
    exit 1
  fi
fi

# ---------- whisper-cpp ----------
find_whisper() {
  for cmd in whisper-cli whisper-cpp whisper; do
    if command -v "$cmd" &>/dev/null; then
      echo "$cmd"
      return
    fi
  done
  if [ -x "$HOME/.local/bin/whisper-cli" ]; then
    echo "$HOME/.local/bin/whisper-cli"
    return
  fi
  return 1
}

if WHISPER_BIN=$(find_whisper); then
  ok "whisper.cpp already installed ($WHISPER_BIN)"
else
  info "Attempting brew install whisper-cpp..."
  if brew install whisper-cpp 2>&1 | tail -3; then
    ok "whisper-cpp installed via Homebrew"
  else
    dim "Homebrew install failed (probably a permissions issue)."
    info "Building whisper.cpp from source..."

    TMPDIR_BUILD="$(mktemp -d)"
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$TMPDIR_BUILD/whisper.cpp" 2>&1 | tail -1
    cd "$TMPDIR_BUILD/whisper.cpp"
    cmake -B build -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -1
    cmake --build build --config Release -j 2>&1 | tail -1

    mkdir -p "$HOME/.local/bin" "$HOME/.local/lib"
    cp build/bin/whisper-cli "$HOME/.local/bin/"
    chmod +x "$HOME/.local/bin/whisper-cli"

    # Copy shared libraries
    cp build/src/libwhisper* "$HOME/.local/lib/" 2>/dev/null || true
    cp build/ggml/src/libggml* "$HOME/.local/lib/" 2>/dev/null || true
    cp build/ggml/src/ggml-blas/libggml-blas* "$HOME/.local/lib/" 2>/dev/null || true
    cp build/ggml/src/ggml-metal/libggml-metal* "$HOME/.local/lib/" 2>/dev/null || true

    # Patch rpath so the binary finds its libs in ~/.local/lib
    install_name_tool -add_rpath "$HOME/.local/lib" "$HOME/.local/bin/whisper-cli" 2>/dev/null || true

    rm -rf "$TMPDIR_BUILD"

    if "$HOME/.local/bin/whisper-cli" --help &>/dev/null; then
      ok "whisper-cli built and installed to ~/.local/bin/"
      dim "Make sure ~/.local/bin is in your PATH:"
      dim "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    else
      fail "Build succeeded but whisper-cli doesn't run. Check the output above."
      exit 1
    fi
  fi
fi

# ---------- Model ----------
MODEL_DIR="$HOME/.tvoice/models"
MODEL_FILE="$MODEL_DIR/ggml-base.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

if [ -f "$MODEL_FILE" ]; then
  ok "Model already present ($(du -h "$MODEL_FILE" | cut -f1 | tr -d ' '))"
else
  info "Downloading ggml-base.bin (~142 MB)..."
  mkdir -p "$MODEL_DIR"
  if curl -L --fail --progress-bar -o "$MODEL_FILE" "$MODEL_URL"; then
    ok "Model downloaded to $MODEL_FILE"
  else
    fail "Model download failed. Try manually:"
    dim "curl -L -o \"$MODEL_FILE\" \"$MODEL_URL\""
    exit 1
  fi
fi

echo ""
ok "Voice setup complete. Tap the mic button in Tvoice to test."
echo ""
