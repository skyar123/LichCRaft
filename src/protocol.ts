import type { Backend } from './models';

export interface Chunk {
  timestamp: [number, number | null];
  text: string;
}

export type MainToWorker =
  | { type: 'load'; modelId: string; backend: Backend; ortBase: string }
  | {
      type: 'transcribe';
      audio: Float32Array;
      language: string;
      task: 'transcribe' | 'translate';
      returnTimestamps: boolean | 'word';
    }
  | { type: 'cancel' };

export type WorkerToMain =
  | { type: 'ready'; backend: Backend; modelId: string }
  | { type: 'download'; file: string; loaded: number; total: number; progress: number }
  | { type: 'download-done'; file: string }
  | { type: 'status'; message: string }
  | { type: 'partial'; text: string; chunkStart: number | null }
  | { type: 'result'; text: string; chunks: Chunk[]; durationMs: number }
  | { type: 'error'; message: string };
