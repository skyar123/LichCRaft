# LichCraft

Free, private speech-to-text. OpenAI's Whisper model runs **entirely inside your browser** —
your audio never leaves the device, there is no account, no API key, and no server to pay for.

The same idea as [Aiko](https://sindresorhus.com/aiko), but as a web app, so it works on iPhone,
Android, and desktop from one codebase.

## What it does

- **Record from the mic or drop in a file** — wav, mp3, m4a, ogg, flac, webm. Anything the
  browser can decode is downmixed to the 16 kHz mono Whisper expects, locally.
- **Four model sizes**, from a 38 MB English-only model up to Large v3 Turbo. Pick the trade-off
  between download size, speed, and accuracy.
- **99 languages**, with optional translation to English.
- **Live partial text** as the model decodes, rather than a spinner.
- **Editable transcript**, exported as plain text, SRT, WebVTT, or JSON with timestamps.
- **Installs to the home screen** and works with no network at all once a model is cached.

## Why it is free, and stays free

There is no backend. The app is static files; the model weights come from the Hugging Face CDN
once and are then cached by the browser. Hosting costs nothing on any static host, and there is
no per-minute transcription bill because the inference happens on the user's own hardware.

## Privacy

Audio is read into memory, decoded by the Web Audio API, and handed to the model in a Web Worker
in the same tab. It is never uploaded, and the app has no analytics and no third-party scripts.

The only network requests are:

1. The app's own static files, from wherever you host it.
2. Model weights from `huggingface.co`, on first use of each model.

The ONNX Runtime WASM binaries are **served from your own origin**, not a CDN — transformers.js
would otherwise fetch them from jsDelivr on every cold start, which would both leak a request and
break offline mode. `scripts/smoke-test.mjs` asserts that no unexpected host is contacted.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm run preview  # serve the production build
```

### Tests

```bash
npm run typecheck   # tsc --noEmit
npm run test:e2e    # real browser: loads a model, transcribes a known clip
```

The smoke test caches the Tiny model (~38 MB) under `.fixtures/` on first run, then serves it
to the browser from disk. That keeps the run hermetic and repeatable, and lets it pass on a CI
box behind a restrictive egress proxy — the full pipeline (decode, ONNX Runtime, Whisper,
export) is still exercised; only the Hugging Face download itself is stubbed.

- `CHROMIUM_PATH` — use a pre-provisioned Chromium instead of the one Playwright downloads.
- `HTTPS_PROXY` — if set, the test routes the browser through it and accepts its certificate,
  which sandboxed CI containers generally need. This affects only the throwaway browser the
  test launches, never the app.

## Deploying

Any static host works. Two headers are worth setting, and `public/_headers` already does it for
Netlify-style hosts:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

These enable cross-origin isolation, which lets the CPU backend use multi-threaded WASM. The app
still runs without them, just slower.

## Known workaround

ONNX Runtime's *extended* graph optimizations crash on the quantized Whisper decoders with
`TransposeDQWeightsForMatMulNBits Missing required scale ...`, which makes every quantized model
fail to load. This affects the `Xenova` and `onnx-community` exports alike, so it is a runtime
bug rather than a bad conversion. The app caps the optimization level at `basic`, which skips
the offending transform while keeping constant folding and redundant-node elimination. See
`session_options` in `src/worker.ts`.

## Which model should I pick?

| Model | CPU download | WebGPU download | Notes |
| --- | --- | --- | --- |
| Tiny (English) | ~38 MB | ~114 MB | Fastest. Clear speech, quick notes. |
| Base (multilingual) | ~73 MB | ~196 MB | Good default. 99 languages. |
| Small (multilingual) | ~237 MB | ~558 MB | Better on noisy audio and proper nouns. |
| Large v3 Turbo | ~723 MB | ~670 MB | Most accurate. Wants a capable device. |

The two columns differ because the GPU path uses an fp32 encoder: int8 weights fall back to the
CPU for many operators on WebGPU, which would defeat the point of using the GPU. The app shows
the figure for the backend you are actually on.

WebGPU is used automatically when the browser exposes it (Chrome and Edge today, Safari
increasingly), and the app falls back to the CPU backend otherwise.

## How it fits together

```
index.html ──> src/main.ts        UI, recording, export, worker messaging
                   │
                   ├─ src/audio.ts      decode + downmix + resample to 16 kHz mono
                   ├─ src/formats.ts    txt / srt / vtt / json rendering
                   └─ Worker ──> src/worker.ts   transformers.js pipeline, streaming
                                     └─ src/models.ts   model catalog + per-backend dtypes
```

The model runs in a Web Worker so long transcriptions never freeze the interface.

## Licence

MIT for this app's code. The Whisper weights are OpenAI's, distributed under their own terms,
and the ONNX conversions come from the `Xenova` and `onnx-community` Hugging Face repos.
