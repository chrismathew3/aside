#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build Aside on macOS with Xcode Command Line Tools installed." >&2
  exit 1
fi

if [[ ! -x bin/whisper-cli ]]; then
  npm run build:whisper
fi
if [[ ! -x bin/whisper-cli ]]; then
  echo 'Missing executable bin/whisper-cli after build:whisper.' >&2
  exit 1
fi

bash ./setup.sh --check

mkdir -p bin
npm run build:audio
node --input-type=module <<'JS'
import { packager } from '@electron/packager';
import path from 'node:path';

const output = await packager({
  dir: process.cwd(),
  name: 'Aside',
  platform: 'darwin',
  arch: 'arm64',
  out: 'dist',
  overwrite: true,
  asar: true,
  prune: true,
  appBundleId: 'com.aside.app',
  appCategoryType: 'public.app-category.productivity',
  extraResource: [path.resolve('bin/whisper-cli'), path.resolve('bin/aside-audio'), path.resolve('models/ggml-base.en.bin'), path.resolve('THIRD_PARTY_NOTICES.md')],
  ignore: [/^\/(?:\.git|\.agents)(?:\/|$)/, /^\/(?:docs|marketing|vendor-build|scripts)(?:\/|$)/i, /^\/[^/]+\.(?:md|mdx|rst|txt)$/i, /^\/setup\.sh$/, /^\/models(?:\/|$)/, /^\/tests(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/native(?:\/|$)/, /^\/bin(?:\/|$)/, /^\/build\.sh$/, /^\/smoke\.cjs$/],
  extendInfo: {
    LSMinimumSystemVersion: '14.0',
    NSMicrophoneUsageDescription: 'Aside transcribes your microphone when you turn on listening.',
    NSScreenCaptureUsageDescription: 'Aside captures system audio while listening and takes a screenshot when you request screen context.',
  },
});
console.log(`Built ${path.join(output[0], 'Aside.app')}`);
JS
