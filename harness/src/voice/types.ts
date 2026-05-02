/**
 * Voice transcription contract.
 *
 * Audio NEVER touches disk per L12. Buffers flow:
 *   discord attachment → fetch → Buffer → ffmpeg pipe → Float32Array (16k mono)
 *   → smart-whisper → TranscriptionResult.
 */

export interface TranscriptionSegment {
  from: number;
  to: number;
  text: string;
  /** smart-whisper's "confidence" — average per-token probability. */
  confidence: number;
}

export interface TranscriptionResult {
  text: string;
  /** Average per-segment confidence. Used as `avg_logprob`-equivalent gate. */
  avgLogprob: number;
  segments: TranscriptionSegment[];
  language: string;
  durationMs: number;
}

export interface TranscribeOptions {
  language?: string;
  initialPrompt?: string;
}
