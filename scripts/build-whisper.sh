#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=1.9.5
TAG_OBJECT=d2a764c648779feb36d44363f212a29b00aad1af
COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
REPO=https://github.com/ggml-org/whisper.cpp.git
SOURCE="$ROOT/vendor-build/whisper.cpp-$VERSION"
BUILD="$ROOT/vendor-build/whisper-build-$VERSION-arm64"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Requires Apple Silicon macOS.' >&2; exit 1; }
if ! command -v cmake >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { echo 'Install CMake and rerun this script.' >&2; exit 1; }
  brew install cmake
fi
mkdir -p "$ROOT/vendor-build" "$ROOT/bin"
# Keep source and intermediates ignored without changing the project .gitignore.
printf '*\n' > "$ROOT/vendor-build/.gitignore"
if [[ ! -d "$SOURCE/.git" ]]; then
  REMOTE="$(git ls-remote --tags "$REPO" "refs/tags/v$VERSION")"
  [[ "$REMOTE" == "$TAG_OBJECT"$'\t'"refs/tags/v$VERSION" ]] || { echo 'Pinned release tag missing or changed.' >&2; exit 1; }
  git clone --depth 1 --branch "v$VERSION" "$REPO" "$SOURCE"
fi
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == "$COMMIT" ]] || { echo 'Source does not match pinned commit.' >&2; exit 1; }
cmake -S "$SOURCE" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
  -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_CURL=OFF -DWHISPER_FFMPEG=OFF -DWHISPER_COMMON_FFMPEG=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DGGML_BLAS=OFF -DGGML_BACKEND_DL=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$BUILD" --config Release --target whisper-cli --parallel "$(sysctl -n hw.logicalcpu)"
BINARY="$BUILD/bin/whisper-cli"
# macOS system libraries/frameworks remain dynamic; whisper and ggml are static.
otool -L "$BINARY"
if ! otool -L "$BINARY" | awk 'NR > 1 { if ($1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\//) bad=1 } END { exit bad }'; then
  echo 'Refusing binary with a non-system runtime dependency.' >&2
  exit 1
fi
[[ "$(lipo -archs "$BINARY")" == arm64 ]] || { echo 'Expected arm64 binary.' >&2; exit 1; }
install -m 755 "$BINARY" "$ROOT/bin/whisper-cli"
echo "Built $ROOT/bin/whisper-cli (whisper.cpp v$VERSION, $COMMIT)"
