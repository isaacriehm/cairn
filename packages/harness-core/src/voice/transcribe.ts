import { logger } from "../logger.js";
import { getWhisper } from "./model.js";
import { audioToPcm } from "./pipe.js";
import type {
  TranscribeOptions,
  TranscriptionResult,
  TranscriptionSegment,
} from "./types.js";

const log = logger("voice.transcribe");

export async function transcribeBuffer(
  audio: Buffer,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const pcm = await audioToPcm(audio);
  const language = opts.language ?? "en";
  const whisper = getWhisper();
  const task = await whisper.transcribe(pcm, {
    language,
    format: "detail",
    no_timestamps: false,
    print_progress: false,
    print_realtime: false,
    print_special: false,
    print_timestamps: false,
    suppress_blank: true,
    ...(opts.initialPrompt !== undefined ? { initial_prompt: opts.initialPrompt } : {}),
  });
  const detailed = await task.result;
  const segments: TranscriptionSegment[] = detailed.map((d) => ({
    from: d.from,
    to: d.to,
    text: d.text.trim(),
    confidence: typeof d.confidence === "number" ? d.confidence : 0,
  }));
  const text = segments.map((s) => s.text).join(" ").trim();
  const avgLogprob =
    segments.length > 0
      ? segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length
      : 0;
  const durationMs = Date.now() - startedAt;
  log.info(
    { chars: text.length, segments: segments.length, avgLogprob, durationMs },
    "transcribed",
  );
  return { text, avgLogprob, segments, language, durationMs };
}

export async function transcribeUrl(
  attachmentUrl: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const res = await fetch(attachmentUrl);
  if (!res.ok) throw new Error(`attachment fetch ${res.status} for ${attachmentUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return transcribeBuffer(buf, opts);
}
