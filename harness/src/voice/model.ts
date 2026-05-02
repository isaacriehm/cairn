import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Whisper } from "smart-whisper";
import { logger } from "../logger.js";

const log = logger("voice.model");

/**
 * Whisper model spec is locked at L11: large-v3-turbo Q5_0. Hardcoded path
 * (operator hates env vars; only secrets/brand/domain go in env).
 *
 * Operator install:
 *   brew install whisper-cpp
 *   curl -L -o ~/.local/harness/models/ggml-large-v3-turbo-q5_0.bin \
 *     "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin?download=true"
 *
 * Phase 16 init script automates the curl.
 */
export const WHISPER_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
export const WHISPER_MODELS_DIR = join(homedir(), ".local", "harness", "models");
export const WHISPER_MODEL_PATH = join(WHISPER_MODELS_DIR, WHISPER_MODEL_FILE);

export function whisperModelExists(): boolean {
  return existsSync(WHISPER_MODEL_PATH);
}

let _whisper: Whisper | undefined;

/**
 * Lazy-singleton Whisper. smart-whisper's `offload` parameter offloads the
 * model from RAM after N idle seconds; loading on next call. Default 60s
 * keeps the model warm during a burst of voice notes.
 */
export function getWhisper(): Whisper {
  if (_whisper) return _whisper;
  if (!whisperModelExists()) {
    throw new Error(
      `whisper model not found at ${WHISPER_MODEL_PATH} — run \`harness init\` or download manually`,
    );
  }
  log.info({ path: WHISPER_MODEL_PATH }, "loading whisper model");
  _whisper = new Whisper(WHISPER_MODEL_PATH, { gpu: true, offload: 60 });
  return _whisper;
}

export async function freeWhisper(): Promise<void> {
  if (_whisper) {
    await _whisper.free();
    _whisper = undefined;
  }
}
