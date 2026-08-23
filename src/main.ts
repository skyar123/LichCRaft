import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { DEFAULT_MODEL_ID, LANGUAGES, MODELS, getModel, type Backend } from './models';
import { SAMPLE_RATE, createRecordingContext, decodeBlob, pickRecorderMimeType } from './audio';
import { EXPORT_MIME, render, type ExportFormat } from './formats';
import { ortAssetBase } from './ort-assets';
import type { Chunk, MainToWorker, WorkerToMain } from './protocol';

registerSW({ immediate: true });

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const ui = {
  backendBadge: $<HTMLSpanElement>('backendBadge'),
  offlineBadge: $<HTMLSpanElement>('offlineBadge'),
  modelSelect: $<HTMLSelectElement>('modelSelect'),
  languageSelect: $<HTMLSelectElement>('languageSelect'),
  taskSelect: $<HTMLSelectElement>('taskSelect'),
  modelHint: $<HTMLParagraphElement>('modelHint'),
  loadBtn: $<HTMLButtonElement>('loadBtn'),
  loadStatus: $<HTMLSpanElement>('loadStatus'),
  loadProgress: $<HTMLDivElement>('loadProgress'),
  loadFill: $<HTMLDivElement>('loadFill'),
  loadLabel: $<HTMLParagraphElement>('loadLabel'),
  recordBtn: $<HTMLButtonElement>('recordBtn'),
  recordLabel: $<HTMLSpanElement>('recordLabel'),
  recordHint: $<HTMLParagraphElement>('recordHint'),
  meterFill: $<HTMLDivElement>('meterFill'),
  fileInput: $<HTMLInputElement>('fileInput'),
  fileLabel: $<HTMLLabelElement>('fileLabel'),
  audioSummary: $<HTMLDivElement>('audioSummary'),
  audioSummaryText: $<HTMLSpanElement>('audioSummaryText'),
  clearAudioBtn: $<HTMLButtonElement>('clearAudioBtn'),
  runBtn: $<HTMLButtonElement>('runBtn'),
  cancelBtn: $<HTMLButtonElement>('cancelBtn'),
  timestampsToggle: $<HTMLInputElement>('timestampsToggle'),
  runStatus: $<HTMLSpanElement>('runStatus'),
  formatSelect: $<HTMLSelectElement>('formatSelect'),
  copyBtn: $<HTMLButtonElement>('copyBtn'),
  downloadBtn: $<HTMLButtonElement>('downloadBtn'),
  output: $<HTMLTextAreaElement>('output'),
  outputMeta: $<HTMLParagraphElement>('outputMeta'),
  error: $<HTMLParagraphElement>('error'),
};

const STORAGE_KEY = 'lichcraft.prefs.v1';

interface State {
  backend: Backend;
  modelReady: boolean;
  /** Tracked separately so a file picked mid-download cannot re-enable Load. */
  loadingModel: boolean;
  decoding: boolean;
  transcribing: boolean;
  recording: boolean;
  audio: Float32Array | null;
  audioName: string;
  chunks: Chunk[];
  text: string;
}

const state: State = {
  backend: 'wasm',
  modelReady: false,
  loadingModel: false,
  decoding: false,
  transcribing: false,
  recording: false,
  audio: null,
  audioName: '',
  chunks: [],
  text: '',
};

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

/* ------------------------------------------------------------------ setup */

async function detectBackend(): Promise<Backend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw) as Partial<{
      model: string;
      language: string;
      task: string;
      format: string;
      timestamps: boolean;
    }>;
    if (prefs.model && MODELS.some((m) => m.id === prefs.model)) ui.modelSelect.value = prefs.model;
    if (prefs.language && prefs.language in LANGUAGES) ui.languageSelect.value = prefs.language;
    if (prefs.task) ui.taskSelect.value = prefs.task;
    if (prefs.format) ui.formatSelect.value = prefs.format;
    if (typeof prefs.timestamps === 'boolean') ui.timestampsToggle.checked = prefs.timestamps;
  } catch {
    /* Preferences are a convenience; ignore a corrupt or blocked store. */
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        model: ui.modelSelect.value,
        language: ui.languageSelect.value,
        task: ui.taskSelect.value,
        format: ui.formatSelect.value,
        timestamps: ui.timestampsToggle.checked,
      }),
    );
  } catch {
    /* Private-mode browsers can refuse writes. Not worth surfacing. */
  }
}

function populateSelects(): void {
  ui.modelSelect.innerHTML = MODELS.map(
    (m) => `<option value="${m.id}">${m.label}</option>`,
  ).join('');
  ui.modelSelect.value = DEFAULT_MODEL_ID;

  ui.languageSelect.innerHTML = Object.entries(LANGUAGES)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');
}

/* ----------------------------------------------------------------- render */

function describeSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function syncModelHint(): void {
  const spec = getModel(ui.modelSelect.value);
  const size = describeSize(spec.sizeMB[state.backend]);
  const warning =
    spec.webgpuRecommended && state.backend === 'wasm'
      ? ' This device has no WebGPU, so expect it to be slow — a smaller model may serve you better.'
      : '';
  ui.modelHint.textContent = `${spec.blurb} One-time download of about ${size}, then it is cached for offline use.${warning}`;

  const multilingual = spec.multilingual;
  ui.languageSelect.disabled = !multilingual;
  ui.taskSelect.disabled = !multilingual;
  if (!multilingual) {
    ui.languageSelect.value = 'auto';
    ui.taskSelect.value = 'transcribe';
  }
}

function isBusy(): boolean {
  return state.loadingModel || state.decoding || state.transcribing;
}

function syncButtons(): void {
  ui.loadBtn.disabled = isBusy();
  ui.recordBtn.disabled = isBusy() && !state.recording;
  ui.fileInput.disabled = isBusy();
  ui.fileLabel.classList.toggle('is-disabled', isBusy());
  ui.runBtn.disabled = !state.modelReady || !state.audio || isBusy() || state.recording;
  const hasText = state.text.trim().length > 0;
  ui.copyBtn.disabled = !hasText;
  ui.downloadBtn.disabled = !hasText;
}

function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = false;
}

function clearError(): void {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

function audioDurationSec(): number {
  return state.audio ? state.audio.length / SAMPLE_RATE : 0;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function setAudio(audio: Float32Array, name: string): void {
  state.audio = audio;
  state.audioName = name;
  ui.audioSummary.hidden = false;
  ui.audioSummaryText.textContent = `${name} · ${formatDuration(audio.length / SAMPLE_RATE)}`;
  syncButtons();
}

function clearAudio(): void {
  state.audio = null;
  state.audioName = '';
  ui.audioSummary.hidden = true;
  syncButtons();
}

/* ------------------------------------------------------------- model load */

const downloads = new Map<string, { loaded: number; total: number }>();

function renderDownloadProgress(): void {
  let loaded = 0;
  let total = 0;
  for (const entry of downloads.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  if (total === 0) return;
  const pct = Math.min(100, (loaded / total) * 100);
  ui.loadProgress.hidden = false;
  ui.loadFill.style.width = `${pct}%`;
  ui.loadLabel.textContent = `Downloading model — ${(loaded / 1048576).toFixed(0)} of ${(
    total / 1048576
  ).toFixed(0)} MB`;
}

function send(message: MainToWorker, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

function requestLoad(): void {
  clearError();
  downloads.clear();
  state.loadingModel = true;
  state.modelReady = false;
  ui.loadStatus.textContent = 'Loading…';
  ui.loadProgress.hidden = true;
  ui.loadFill.style.width = '0%';
  syncButtons();
  send({
    type: 'load',
    modelId: ui.modelSelect.value,
    backend: state.backend,
    ortBase: ortAssetBase(),
  });
}

/* -------------------------------------------------------------- recording */

let recorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let meterRaf = 0;
let meterCleanup: (() => void) | null = null;

async function startRecording(): Promise<void> {
  clearError();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    showError(
      `Microphone access was refused (${err instanceof Error ? err.message : String(err)}). ` +
        'You can still transcribe by choosing an audio file.',
    );
    return;
  }

  const mimeType = pickRecorderMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recordedChunks = [];

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  });

  recorder.addEventListener('stop', () => {
    stopMeter();
    for (const track of stream.getTracks()) track.stop();
    const blob = new Blob(recordedChunks, { type: recorder?.mimeType || 'audio/webm' });
    void ingest(blob, 'Recording');
  });

  startMeter(stream);
  recorder.start();
  state.recording = true;
  ui.recordBtn.classList.add('is-recording');
  ui.recordLabel.textContent = 'Stop';
  ui.recordHint.textContent = 'Recording… tap Stop when you are done.';
  syncButtons();
}

function stopRecording(): void {
  recorder?.stop();
  recorder = null;
  state.recording = false;
  ui.recordBtn.classList.remove('is-recording');
  ui.recordLabel.textContent = 'Record';
  ui.recordHint.textContent = 'Uses your microphone. Audio stays in this tab.';
  syncButtons();
}

function startMeter(stream: MediaStream): void {
  const ctx = createRecordingContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = (): void => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
    ui.meterFill.style.width = `${Math.min(100, peak * 140)}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  tick();

  meterCleanup = () => {
    cancelAnimationFrame(meterRaf);
    source.disconnect();
    void ctx.close();
    ui.meterFill.style.width = '0%';
  };
}

function stopMeter(): void {
  meterCleanup?.();
  meterCleanup = null;
}

/* --------------------------------------------------------------- ingest */

async function ingest(blob: Blob, name: string): Promise<void> {
  state.decoding = true;
  ui.runStatus.textContent = 'Decoding audio…';
  syncButtons();
  try {
    const audio = await decodeBlob(blob);
    if (audio.length === 0) throw new Error('That file contains no audio samples.');
    setAudio(audio, name);
    ui.runStatus.textContent = '';
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    ui.runStatus.textContent = '';
  } finally {
    state.decoding = false;
    syncButtons();
  }
}

/* ----------------------------------------------------------- transcribing */

function runTranscription(): void {
  if (!state.audio) return;
  clearError();
  state.transcribing = true;
  state.text = '';
  state.chunks = [];
  ui.output.value = '';
  ui.outputMeta.textContent = '';
  ui.runStatus.textContent = 'Transcribing…';
  ui.cancelBtn.hidden = false;
  syncButtons();

  // The worker takes ownership of the sample buffer, so hand it a copy and
  // transfer that — the original stays usable for a re-run.
  const copy = state.audio.slice();
  send(
    {
      type: 'transcribe',
      audio: copy,
      language: ui.languageSelect.value,
      task: ui.taskSelect.value as 'transcribe' | 'translate',
      returnTimestamps: ui.timestampsToggle.checked,
    },
    [copy.buffer],
  );
}

function finishRun(): void {
  state.transcribing = false;
  state.loadingModel = false;
  ui.cancelBtn.hidden = true;
  syncButtons();
}

/* -------------------------------------------------------------- exporting */

function currentExport(): { body: string; filename: string; mime: string } {
  const format = ui.formatSelect.value as ExportFormat;
  const edited = ui.output.value;
  // Timed formats need the model's segments; the plain text box is the source
  // of truth for txt so manual edits survive the export.
  const body =
    format === 'txt' ? edited.trim() + '\n' : render(format, edited, state.chunks, audioDurationSec());
  const base = (state.audioName || 'transcript').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-');
  return { body, filename: `${base || 'transcript'}.${format}`, mime: EXPORT_MIME[format] };
}

async function copyTranscript(): Promise<void> {
  const { body } = currentExport();
  try {
    await navigator.clipboard.writeText(body);
    ui.copyBtn.textContent = 'Copied';
  } catch {
    ui.output.select();
    ui.copyBtn.textContent = 'Select + copy';
  }
  setTimeout(() => {
    ui.copyBtn.textContent = 'Copy';
  }, 1600);
}

function downloadTranscript(): void {
  const { body, filename, mime } = currentExport();
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* --------------------------------------------------------------- messages */

worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
  const message = event.data;
  switch (message.type) {
    case 'download': {
      downloads.set(message.file, { loaded: message.loaded, total: message.total });
      renderDownloadProgress();
      break;
    }
    case 'download-done': {
      const entry = downloads.get(message.file);
      if (entry) entry.loaded = entry.total;
      renderDownloadProgress();
      break;
    }
    case 'status': {
      ui.loadStatus.textContent = message.message;
      break;
    }
    case 'ready': {
      state.backend = message.backend;
      state.modelReady = true;
      state.loadingModel = false;
      downloads.clear();
      ui.loadProgress.hidden = true;
      ui.backendBadge.textContent =
        message.backend === 'webgpu' ? 'WebGPU accelerated' : 'CPU (WASM)';
      ui.loadStatus.textContent = `${getModel(message.modelId).label} is ready — cached for offline use.`;
      syncModelHint();
      syncButtons();
      break;
    }
    case 'partial': {
      state.text += message.text;
      ui.output.value = state.text.trimStart();
      ui.output.scrollTop = ui.output.scrollHeight;
      break;
    }
    case 'result': {
      state.text = message.text;
      state.chunks = message.chunks;
      ui.output.value = message.text;
      const seconds = audioDurationSec();
      const speed = seconds > 0 ? seconds / (message.durationMs / 1000) : 0;
      ui.outputMeta.textContent = `${formatDuration(seconds)} of audio in ${(
        message.durationMs / 1000
      ).toFixed(1)}s (${speed.toFixed(1)}× real time) · ${message.chunks.length} segments`;
      ui.runStatus.textContent = 'Done.';
      finishRun();
      break;
    }
    case 'error': {
      showError(message.message);
      ui.runStatus.textContent = '';
      ui.loadStatus.textContent = state.modelReady
        ? ui.loadStatus.textContent
        : 'Model not loaded yet.';
      finishRun();
      break;
    }
  }
});

worker.addEventListener('error', (event) => {
  showError(`The transcription worker failed to start: ${event.message}`);
  finishRun();
});

/* ---------------------------------------------------------------- wiring */

ui.loadBtn.addEventListener('click', requestLoad);

ui.modelSelect.addEventListener('change', () => {
  state.modelReady = false;
  ui.loadStatus.textContent = 'Model not loaded yet.';
  syncModelHint();
  syncButtons();
  savePrefs();
});

for (const el of [ui.languageSelect, ui.taskSelect, ui.formatSelect, ui.timestampsToggle]) {
  el.addEventListener('change', savePrefs);
}

ui.recordBtn.addEventListener('click', () => {
  if (state.recording) stopRecording();
  else void startRecording();
});

ui.fileInput.addEventListener('change', () => {
  const file = ui.fileInput.files?.[0];
  if (file) void ingest(file, file.name);
  ui.fileInput.value = '';
});

ui.clearAudioBtn.addEventListener('click', clearAudio);
ui.runBtn.addEventListener('click', runTranscription);
ui.cancelBtn.addEventListener('click', () => send({ type: 'cancel' }));
ui.copyBtn.addEventListener('click', () => void copyTranscript());
ui.downloadBtn.addEventListener('click', downloadTranscript);
ui.output.addEventListener('input', () => {
  state.text = ui.output.value;
  syncButtons();
});

function syncOnlineBadge(): void {
  ui.offlineBadge.textContent = navigator.onLine ? 'offline-ready' : 'offline — using cache';
  ui.offlineBadge.classList.toggle('badge-warn', !navigator.onLine);
}
window.addEventListener('online', syncOnlineBadge);
window.addEventListener('offline', syncOnlineBadge);

/* ------------------------------------------------------------------ start */

populateSelects();
loadPrefs();
syncOnlineBadge();
syncButtons();

void detectBackend().then((backend) => {
  state.backend = backend;
  ui.backendBadge.textContent = backend === 'webgpu' ? 'WebGPU available' : 'CPU (WASM)';
  syncModelHint();
});
