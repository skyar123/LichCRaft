/// <reference lib="webworker" />
import {
  env,
  pipeline,
  WhisperTextStreamer,
  type WhisperTokenizer,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import { SAMPLE_RATE } from './audio';
import { getModel, type Backend } from './models';
import type { Chunk, MainToWorker, WorkerToMain } from './protocol';

// Weights come from the Hugging Face CDN and are then cached by the browser.
// There are no local model files bundled with the app, and no other host is
// ever contacted.
env.allowLocalModels = false;
env.useBrowserCache = true;

/**
 * Left unset, transformers.js points onnxruntime-web at jsDelivr — a
 * third-party request on every cold start, and nothing to fall back on
 * offline. Serve the runtime from our own origin instead.
 *
 * The directory URL is computed on the main thread and passed in: resolving it
 * here would be relative to this worker's own bundled script under `assets/`.
 */
function configureRuntime(ortBase: string): void {
  const onnxWasm = env.backends.onnx.wasm;
  if (!onnxWasm) return;
  onnxWasm.wasmPaths = ortBase;
  // Multi-threaded WASM needs SharedArrayBuffer, which needs cross-origin
  // isolation. Asking for threads without it makes ORT throw rather than
  // quietly fall back, so only opt in when the headers are actually present.
  // Oversubscribing cores also makes decoding slower, not faster, on phones.
  onnxWasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1))
    : 1;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerToMain): void {
  ctx.postMessage(message);
}

interface Loaded {
  key: string;
  backend: Backend;
  modelId: string;
  transcriber: AutomaticSpeechRecognitionPipeline;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let cancelRequested = false;

async function build(modelId: string, backend: Backend): Promise<Loaded> {
  const spec = getModel(modelId);
  post({ type: 'status', message: `Preparing ${spec.label}…` });

  const transcriber = (await pipeline('automatic-speech-recognition', spec.repo, {
    device: backend,
    dtype: spec.dtype[backend],
    // ONNX Runtime's extended graph optimizations crash on the quantized
    // Whisper decoders ("TransposeDQWeightsForMatMulNBits Missing required
    // scale ..."), which makes every quantized model fail to load. The
    // transform runs above the basic level, so capping it there sidesteps the
    // bug; the basic passes still do constant folding and redundant-node
    // elimination.
    session_options: { graphOptimizationLevel: 'basic' },
    progress_callback: (item: unknown) => {
      const p = item as { status?: string; file?: string; loaded?: number; total?: number; progress?: number };
      if (p.status === 'progress' && p.file) {
        post({
          type: 'download',
          file: p.file,
          loaded: p.loaded ?? 0,
          total: p.total ?? 0,
          progress: p.progress ?? 0,
        });
      } else if (p.status === 'done' && p.file) {
        post({ type: 'download-done', file: p.file });
      }
    },
  })) as AutomaticSpeechRecognitionPipeline;

  return { key: `${modelId}:${backend}`, backend, modelId, transcriber };
}

async function load(modelId: string, backend: Backend): Promise<Loaded> {
  const key = `${modelId}:${backend}`;
  if (loaded?.key === key) return loaded;
  if (loading) await loading.catch(() => undefined);
  if (loaded?.key === key) return loaded;

  if (loaded) {
    await loaded.transcriber.dispose?.().catch(() => undefined);
    loaded = null;
  }

  loading = (async () => {
    try {
      return await build(modelId, backend);
    } catch (err) {
      if (backend === 'webgpu') {
        // A device without working WebGPU shader support should still be able
        // to transcribe, just more slowly.
        post({
          type: 'status',
          message: 'WebGPU was unavailable, falling back to the CPU backend…',
        });
        return await build(modelId, 'wasm');
      }
      throw err;
    }
  })();

  try {
    loaded = await loading;
    return loaded;
  } finally {
    loading = null;
  }
}

async function transcribe(message: Extract<MainToWorker, { type: 'transcribe' }>): Promise<void> {
  if (!loaded) throw new Error('No model is loaded yet.');
  const { transcriber } = loaded;
  const spec = getModel(loaded.modelId);
  const started = performance.now();

  // Whisper only sees 30 seconds at a time; chunking with an overlap lets it
  // handle recordings of any length without dropping words at the seams.
  const durationSec = message.audio.length / SAMPLE_RATE;
  const chunkLengthS = 30;
  const strideLengthS = 5;

  let chunkStart: number | null = null;
  const streamer = new WhisperTextStreamer(transcriber.tokenizer as WhisperTokenizer, {
    skip_prompt: true,
    on_chunk_start: (start: number) => {
      chunkStart = start;
    },
    callback_function: (text: string) => {
      if (cancelRequested) throw new Error('__cancelled__');
      post({ type: 'partial', text, chunkStart });
    },
  });

  const language =
    message.language === 'auto' || !spec.multilingual ? undefined : message.language;

  const output = (await transcriber(message.audio, {
    return_timestamps: message.returnTimestamps,
    chunk_length_s: durationSec > chunkLengthS ? chunkLengthS : undefined,
    stride_length_s: durationSec > chunkLengthS ? strideLengthS : undefined,
    language,
    task: spec.multilingual ? message.task : undefined,
    streamer,
  })) as { text: string; chunks?: Chunk[] };

  post({
    type: 'result',
    text: (output.text ?? '').trim(),
    chunks: output.chunks ?? [],
    durationMs: performance.now() - started,
  });
}

ctx.addEventListener('message', (event: MessageEvent<MainToWorker>) => {
  const message = event.data;

  if (message.type === 'cancel') {
    cancelRequested = true;
    return;
  }

  void (async () => {
    try {
      if (message.type === 'load') {
        configureRuntime(message.ortBase);
        const result = await load(message.modelId, message.backend);
        post({ type: 'ready', backend: result.backend, modelId: result.modelId });
      } else if (message.type === 'transcribe') {
        cancelRequested = false;
        await transcribe(message);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      post({
        type: 'error',
        message: raw === '__cancelled__' ? 'Transcription cancelled.' : raw,
      });
    }
  })();
});
