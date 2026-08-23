import type { DataType } from '@huggingface/transformers';

export type Backend = 'webgpu' | 'wasm';

export interface ModelSpec {
  id: string;
  /** Hugging Face repo the ONNX weights are pulled from. */
  repo: string;
  label: string;
  blurb: string;
  /** Multilingual models can also translate to English. */
  multilingual: boolean;
  /**
   * Download size in MB, measured from the repo. It differs per backend
   * because the GPU path uses an fp32 encoder — int8 weights fall back to the
   * CPU for many ops on WebGPU, which would defeat the point.
   */
  sizeMB: Record<Backend, number>;
  dtype: Record<Backend, Record<string, DataType>>;
  /** Discourage this model on the CPU backend — it is painfully slow there. */
  webgpuRecommended: boolean;
}

export const MODELS: ModelSpec[] = [
  {
    id: 'tiny.en',
    repo: 'Xenova/whisper-tiny.en',
    label: 'Tiny (English)',
    blurb: 'Fastest. Good for clear speech and quick notes.',
    multilingual: false,
    sizeMB: { wasm: 38, webgpu: 114 },
    dtype: {
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    },
    webgpuRecommended: false,
  },
  {
    id: 'base',
    repo: 'Xenova/whisper-base',
    label: 'Base (multilingual)',
    blurb: 'A good default. Handles 99 languages and accents better than Tiny.',
    multilingual: true,
    sizeMB: { wasm: 73, webgpu: 196 },
    dtype: {
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    },
    webgpuRecommended: false,
  },
  {
    id: 'small',
    repo: 'Xenova/whisper-small',
    label: 'Small (multilingual)',
    blurb: 'Noticeably more accurate on noisy audio and proper nouns.',
    multilingual: true,
    sizeMB: { wasm: 237, webgpu: 558 },
    dtype: {
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    },
    webgpuRecommended: true,
  },
  {
    id: 'large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    label: 'Large v3 Turbo',
    blurb: 'The most accurate option. Large download; needs a capable device.',
    multilingual: true,
    sizeMB: { wasm: 723, webgpu: 670 },
    dtype: {
      wasm: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      webgpu: { encoder_model: 'q4f16', decoder_model_merged: 'q4' },
    },
    webgpuRecommended: true,
  },
];

export const DEFAULT_MODEL_ID = 'base';

export function getModel(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}

/** Languages Whisper handles well, offered for the "force a language" control. */
export const LANGUAGES: Record<string, string> = {
  auto: 'Detect automatically',
  english: 'English',
  spanish: 'Spanish',
  french: 'French',
  german: 'German',
  italian: 'Italian',
  portuguese: 'Portuguese',
  dutch: 'Dutch',
  polish: 'Polish',
  russian: 'Russian',
  ukrainian: 'Ukrainian',
  turkish: 'Turkish',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  hindi: 'Hindi',
  bengali: 'Bengali',
  urdu: 'Urdu',
  chinese: 'Chinese',
  japanese: 'Japanese',
  korean: 'Korean',
  vietnamese: 'Vietnamese',
  thai: 'Thai',
  indonesian: 'Indonesian',
  swedish: 'Swedish',
  norwegian: 'Norwegian',
  danish: 'Danish',
  finnish: 'Finnish',
  greek: 'Greek',
  czech: 'Czech',
  romanian: 'Romanian',
  hungarian: 'Hungarian',
};
