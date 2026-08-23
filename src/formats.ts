import type { Chunk } from './protocol';

function clock(seconds: number, comma: boolean): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}${comma ? ',' : '.'}${pad(ms, 3)}`;
}

/**
 * The final chunk of a Whisper transcript often has a null end timestamp.
 * Fall back to the audio duration so subtitles stay well-formed.
 */
function endOf(chunk: Chunk, fallback: number): number {
  const [start, end] = chunk.timestamp;
  return end ?? Math.max(fallback, start + 2);
}

export function toPlainText(text: string): string {
  return text.trim() + '\n';
}

export function toSrt(chunks: Chunk[], durationSec: number): string {
  return (
    chunks
      .map((chunk, i) => {
        const start = clock(chunk.timestamp[0], true);
        const end = clock(endOf(chunk, durationSec), true);
        return `${i + 1}\n${start} --> ${end}\n${chunk.text.trim()}\n`;
      })
      .join('\n') + '\n'
  );
}

export function toVtt(chunks: Chunk[], durationSec: number): string {
  const cues = chunks
    .map((chunk) => {
      const start = clock(chunk.timestamp[0], false);
      const end = clock(endOf(chunk, durationSec), false);
      return `${start} --> ${end}\n${chunk.text.trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}

export function toJson(text: string, chunks: Chunk[], durationSec: number): string {
  return JSON.stringify({ text: text.trim(), duration: durationSec, segments: chunks }, null, 2);
}

export type ExportFormat = 'txt' | 'srt' | 'vtt' | 'json';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  txt: 'text/plain',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  json: 'application/json',
};

export function render(
  format: ExportFormat,
  text: string,
  chunks: Chunk[],
  durationSec: number,
): string {
  switch (format) {
    case 'srt':
      return toSrt(chunks, durationSec);
    case 'vtt':
      return toVtt(chunks, durationSec);
    case 'json':
      return toJson(text, chunks, durationSec);
    default:
      return toPlainText(text);
  }
}
