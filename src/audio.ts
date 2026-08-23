/**
 * Audio decoding helpers. Everything here runs on the main thread against the
 * Web Audio API and never touches the network — the bytes go straight from the
 * user's file or microphone into a Float32Array.
 */

export const SAMPLE_RATE = 16000;

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor {
  const ctor =
    window.AudioContext ?? (window as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!ctor) throw new Error('This browser has no Web Audio support, so audio cannot be decoded.');
  return ctor;
}

export function createRecordingContext(): AudioContext {
  return new (getAudioContextCtor())();
}

/**
 * Decode any browser-supported audio container (wav, mp3, m4a, ogg, flac,
 * webm...) into the 16 kHz mono Float32Array that Whisper expects.
 */
export async function decodeToMono16k(data: ArrayBuffer): Promise<Float32Array> {
  const Ctor = getAudioContextCtor();
  const ctx = new Ctor();
  let decoded: AudioBuffer;
  try {
    // Safari's callback form is the only one some versions implement, so wrap
    // both and take whichever resolves.
    decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      const promise = ctx.decodeAudioData(data, resolve, reject);
      if (promise instanceof Promise) promise.then(resolve, reject);
    });
  } catch (err) {
    throw new Error(
      `That file could not be decoded (${err instanceof Error ? err.message : String(err)}). ` +
        'Try converting it to WAV or MP3.',
    );
  } finally {
    void ctx.close();
  }

  if (decoded.numberOfChannels === 1 && decoded.sampleRate === SAMPLE_RATE) {
    return decoded.getChannelData(0).slice();
  }
  return resample(decoded);
}

/** Downmix to mono and resample to 16 kHz. */
async function resample(buffer: AudioBuffer): Promise<Float32Array> {
  // Derive the frame count from the source length rather than `duration`, so
  // rounding never drops the final partial frame.
  const frames = Math.max(1, Math.ceil((buffer.length * SAMPLE_RATE) / buffer.sampleRate));
  try {
    const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    // Some older Safari builds refuse an OfflineAudioContext at 16 kHz.
    // Fall back to downmixing and resampling by hand.
    return manualResample(buffer);
  }
}

function manualResample(buffer: AudioBuffer): Float32Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c][i];
    mono[i] = sum / channels.length;
  }

  if (buffer.sampleRate === SAMPLE_RATE) return mono;

  const ratio = buffer.sampleRate / SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, mono.length - 1);
    const frac = pos - left;
    out[i] = mono[left] * (1 - frac) + mono[right] * frac;
  }
  return out;
}

/** Wrap a Blob (a recording or a picked file) in the decode path above. */
export async function decodeBlob(blob: Blob): Promise<Float32Array> {
  return decodeToMono16k(await blob.arrayBuffer());
}

/** Pick a recording container this browser actually supports. */
export function pickRecorderMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ];
  if (typeof MediaRecorder === 'undefined') return undefined;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}
