import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import type { QueueEntry } from "./types.js";

const log = logger("orchestrator.queue");

export const QUEUE_FILE_REL = ".harness/tasks/active/_queue.yaml";

/**
 * In-memory FIFO with a YAML shadow on disk. Persistence is best-effort —
 * crashes between dequeue and inbox-row-move will replay the task; the
 * orchestrator dedupes by `run_id` before dispatching.
 */
export class TaskQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly seenRunIds = new Set<string>();
  private readonly shadowPath: string;

  constructor(repoRoot: string) {
    this.shadowPath = join(repoRoot, QUEUE_FILE_REL);
  }

  async load(): Promise<void> {
    if (!existsSync(this.shadowPath)) return;
    try {
      const text = await readFile(this.shadowPath, "utf8");
      const parsed = parseYaml(text) as { entries?: QueueEntry[] } | undefined;
      if (parsed && Array.isArray(parsed.entries)) {
        let dropped = 0;
        for (const entry of parsed.entries) {
          // Drop restored entries whose inbox file is gone — those are
          // tasks the orchestrator already abandoned (e.g. dead Discord
          // channel) but the dequeue+persist didn't atomically follow
          // the moveToProcessed. Re-queueing them produces the
          // ENOENT-rename loop the operator hits in the wild.
          if (entry.inbox_file && !existsSync(entry.inbox_file)) {
            dropped++;
            continue;
          }
          if (!this.seenRunIds.has(entry.run_id)) {
            this.entries.push(entry);
            this.seenRunIds.add(entry.run_id);
          }
        }
        log.info(
          { restored: this.entries.length, dropped },
          "queue restored from shadow",
        );
      }
    } catch (err) {
      log.warn({ err: String(err) }, "queue shadow corrupt — starting empty");
    }
  }

  size(): number {
    return this.entries.length;
  }

  enqueue(entry: QueueEntry): boolean {
    if (this.seenRunIds.has(entry.run_id)) return false;
    this.entries.push(entry);
    this.seenRunIds.add(entry.run_id);
    return true;
  }

  /** Returns the next entry without removing it. */
  peek(): QueueEntry | undefined {
    return this.entries[0];
  }

  dequeue(): QueueEntry | undefined {
    return this.entries.shift();
  }

  list(): readonly QueueEntry[] {
    return this.entries;
  }

  async persist(): Promise<void> {
    await mkdir(join(this.shadowPath, ".."), { recursive: true });
    const yaml = stringifyYaml({
      version: 1,
      generated: new Date().toISOString(),
      entries: this.entries,
    });
    await writeFile(this.shadowPath, yaml, "utf8");
  }
}
