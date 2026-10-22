#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

check_only=false
case "${1:-}" in
  '') ;;
  --check) check_only=true ;;
  *) echo 'Usage: bash setup.sh [--check]' >&2; exit 1 ;;
esac
fail() { echo "Aside setup: $*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'Apple Silicon macOS 14 or later is required.'
[[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ]] || fail 'macOS 14 or later is required.'

find_whisper() {
  local candidate
  for candidate in bin/whisper-cli /opt/homebrew/bin/whisper-cli /usr/local/bin/whisper-cli; do
    if [[ -x "$candidate" ]]; then echo "$candidate"; return 0; fi
  done
  return 1
}
if ! binary="$(find_whisper)"; then
  if "$check_only"; then fail 'Missing whisper-cli. Run npm run setup (requires Homebrew).'; fi
  brew_bin="$(command -v brew || true)"
  if [[ -z "$brew_bin" && -x /opt/homebrew/bin/brew ]]; then brew_bin=/opt/homebrew/bin/brew; fi
  [[ -n "$brew_bin" ]] || fail 'Homebrew is required. Install it from https://brew.sh, then run npm run setup.'
  "$brew_bin" install whisper-cpp
  binary="$(find_whisper)" || fail 'whisper-cpp installed, but whisper-cli was not found in /opt/homebrew/bin or /usr/local/bin.'
fi

model=models/ggml-base.en.bin
sha256=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
verify_model() {
  [[ -f "$1" ]] && [[ "$(shasum -a 256 "$1" | awk '{print $1}')" == "$sha256" ]]
}
if ! verify_model "$model"; then
  if "$check_only"; then fail 'Local model is missing or failed SHA256 verification. Run npm run setup.'; fi
  mkdir -p models
  download="$(mktemp "models/.ggml-base.en.XXXXXX")"
  trap 'rm -f "$download"' EXIT
  curl --fail --location --retry 3 --connect-timeout 30 \
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' \
    --output "$download"
  verify_model "$download" || fail 'Downloaded model failed SHA256 verification; existing model was preserved. Retry npm run setup.'
  mv "$download" "$model"
fi
if ! "$check_only"; then
  npm run build:audio
fi
printf 'Local transcription ready: %s; model SHA256 verified.\n' "$binary"
