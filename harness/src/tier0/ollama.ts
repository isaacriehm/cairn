/**
 * Minimal Ollama HTTP client. Avoids pulling another dep just for two POSTs.
 * Server defaults to http://localhost:11434 (Ollama's listen). The harness
 * exposes `OLLAMA_HOST` env override per `.env.example`.
 */

export interface OllamaGenerateRequest {
  host: string;
  model: string;
  prompt: string;
  system?: string;
  /** Set to "json" to ask the model for valid JSON output. */
  format?: "json";
  timeoutMs?: number;
}

export interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  total_duration?: number;
}

export async function ollamaGenerate(
  req: OllamaGenerateRequest,
): Promise<OllamaGenerateResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);
  try {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      stream: false,
    };
    if (req.system !== undefined) body["system"] = req.system;
    if (req.format !== undefined) body["format"] = req.format;
    const res = await fetch(`${req.host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as OllamaGenerateResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function ollamaIsAvailable(host: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaHasModel(host: string, model: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: { name: string }[] };
    if (!json.models) return false;
    return json.models.some((m) => m.name === model || m.name.startsWith(`${model}:`));
  } catch {
    return false;
  }
}
