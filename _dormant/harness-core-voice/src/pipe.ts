import { spawn } from "node:child_process";

/**
 * Pipe arbitrary audio bytes through ffmpeg → 16 kHz mono Float32 PCM.
 *
 * Audio bytes flow stdin→stdout; nothing touches disk (L12).
 *
 * `ffmpeg` must be on PATH. macOS: `brew install ffmpeg`. Phase 16 init
 * script verifies and prompts to install.
 */
export async function audioToPcm(audio: Buffer): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
        return;
      }
      const concat = Buffer.concat(chunks);
      // Float32Array requires a 4-byte-aligned ArrayBuffer; copy to ensure.
      const aligned = new ArrayBuffer(concat.length);
      new Uint8Array(aligned).set(concat);
      resolve(new Float32Array(aligned));
    });
    ff.stdin.write(audio);
    ff.stdin.end();
  });
}
