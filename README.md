# Aside

A Mac assistant for questions about your screen and conversations.

Press a shortcut to ask about what's on your screen or what was said on a call. Aside transcribes your microphone and the other side of a call locally with Whisper. When you ask for help, it sends transcript context to Claude in the cloud for an answer.

This is an alpha for Apple Silicon Macs running macOS 14 or later.

## Install

Open the DMG from this repository’s Releases page. Drag Aside into Applications, then open it.

On first launch, choose your existing Claude Code installation or paste an Anthropic API key. Click Listen and grant microphone and Screen Recording permissions when macOS asks.

The packaged app includes a statically built whisper-cli executable and the English Whisper base model. Local audio transcription needs no Homebrew installation or terminal setup.

The current build is unsigned and unnotarized. macOS may block the downloaded app from opening.

## Run from source

Install Node.js, Homebrew, and the Xcode Command Line Tools first. For answers, Aside uses your existing Claude Code CLI installation. Install it and sign in if needed, or add an Anthropic API key in Aside's settings.

```sh
npm ci
npm run setup
npm start
```

Setup installs whisper.cpp through Homebrew if needed and downloads the English Whisper base model. Audio transcription runs on your Mac. The model download is about 142 MiB.

To build the Mac app:

```sh
npm run build
open dist/Aside-darwin-arm64/Aside.app
```

Copy Aside.app into Applications, then drag it to your Dock. This build is also unsigned and unnotarized.

## Use it

| Action | Shortcut |
| --- | --- |
| Ask a question | ⌘⇧↵ |
| Answer using current context | ⌘↵ |
| Start or stop listening | ⌘⇧L |
| Clear the conversation and transcript | ⌘⇧⌫ |
| Show or hide Aside | ⌘\\ |

Listen captures your microphone and system audio. Grant microphone and Screen Recording permissions when macOS asks. Local transcription appears in phrases after pauses or in short chunks, rather than word by word.

Screen controls whether a screenshot goes with the next question. The screenshot comes from the display under your mouse pointer.

Recap drafts decisions, open questions, next steps, and a follow-up message for you to review. It does not send anything.

In Settings, add background about your work, codebase, product, or team. You can also select Deepgram for cloud transcription.

## Where your data goes

With Local Whisper selected, microphone and system audio are processed on your Mac. Temporary audio chunks are removed when processing finishes or listening stops. Transcripts stay in the current app session.

When you request an answer, transcript context and any selected screenshot go to Claude in the cloud. By default, Aside runs your installed Claude Code CLI with tools disabled and session persistence off. Your account's access and usage limits apply. An Anthropic API key uses separate API billing. If you select Deepgram, captured audio goes to Deepgram for transcription.

API keys are stored in Aside's local configuration using Electron safeStorage. No credentials are included in this repository.

Aside requests macOS screen-capture protection for its panel. Behavior varies by macOS and screen-sharing software; check your own setup before relying on it to keep notes out of a recording.

## Development

```sh
npm test
```

The unit tests cover resampling, silence detection, queue limits, process failures, and cleanup. `smoke.cjs` tests the interface against a real Claude response and sends a screenshot. Run it with Aside closed:

```sh
./node_modules/.bin/electron smoke.cjs
```

The speech integration checks use a synthetic spoken sample generated with macOS `say` and `afconvert`:

```sh
node tests/local-real.cjs
./node_modules/.bin/electron tests/local-app.cjs
```

The Electron speech check needs microphone permission and launches system-audio capture. It feeds the synthetic sample through the mic transcription path and checks that its text appears in the interface.

The app uses Electron for the panel, a Swift ScreenCaptureKit helper for system audio, and whisper.cpp for local transcription. The packaged app bundles a statically built whisper-cli executable, the model, and the Swift helper. Source development can fall back to whisper-cli installed through Homebrew.

## Credits and license

Aside is MIT licensed. Aside was built after inspecting the behavior and structure of an installed Cluely app. It is an independent project with no affiliation with Cluely.

Local transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [OpenAI Whisper](https://github.com/openai/whisper). The packaged app includes the Whisper model and a statically built whisper-cli executable. Model weights and third-party binaries are not committed here. Their respective licenses apply. JavaScript dependency versions are recorded in package-lock.json.
