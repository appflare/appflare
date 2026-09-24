import {
  BUILD_LOG_TAIL_CHARS,
  type BuildProgress,
  buildProgressSchema,
  type RunStep,
} from "@appflare/schema";

/**
 * The log of a build (or of a self-deploying run), kept in R2 next to the
 * build's output so the manager can
 * show live progress without holding a stream open: the running build
 * rewrites `log.txt` (the last {@link BUILD_LOG_TAIL_CHARS} characters of
 * output) at most every few seconds and at every step, with the state in the
 * object's custom metadata. `SandboxBuilds.progress()` reads it back.
 */

type BuildState = BuildProgress["state"];

export interface BuildLogOptions {
  bucket: R2Bucket;
  key: string;
  now: () => number;
  flushIntervalMs: number;
}

export class BuildLog {
  #text = "";
  #stage: RunStep = "checkout";
  #state: BuildState = "running";
  readonly #startedAt: string;
  #lastFlush = 0;
  #inFlight: Promise<void> | null = null;
  #dirty = false;
  readonly #redactions: string[] = [];

  constructor(private readonly options: BuildLogOptions) {
    this.#startedAt = new Date(options.now()).toISOString();
  }

  /** The end of the output so far. */
  get text(): string {
    return this.#text;
  }

  /**
   * Values that must never appear in the log (a self-deploying run's token
   * and secrets): from now on they are replaced wherever they show up in the
   * kept output. Best effort: a value split across two writes to R2 may have
   * its first part written before the rest arrives.
   */
  redact(values: readonly string[]): void {
    for (const value of values) {
      if (value.length >= 4 && !this.#redactions.includes(value)) this.#redactions.push(value);
    }
    this.#text = this.scrub(this.#text);
  }

  /** `text` with every redacted value replaced. */
  scrub(text: string): string {
    let out = text;
    for (const value of this.#redactions) out = out.replaceAll(value, "[redacted]");
    return out;
  }

  /** Adds output; writes the log to R2 when the flush interval has passed. */
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.#text =
      this.#redactions.length === 0 ? this.#text + chunk : this.scrub(this.#text + chunk);
    if (this.#text.length > BUILD_LOG_TAIL_CHARS) {
      this.#text = this.#text.slice(-BUILD_LOG_TAIL_CHARS);
    }
    this.#dirty = true;
    if (this.options.now() - this.#lastFlush >= this.options.flushIntervalMs) {
      void this.flush().catch(() => {
        // Progress is best effort; the final flush reports its own error.
      });
    }
  }

  /** Adds one line of the sandbox Worker's own narration. */
  line(message: string): void {
    const separator = this.#text.length === 0 || this.#text.endsWith("\n") ? "" : "\n";
    this.append(`${separator}${message}\n`);
  }

  /** Starts a step: records it and writes the log at once. */
  async stage(stage: RunStep, title: string): Promise<void> {
    this.#stage = stage;
    this.line(`\n== ${title} ==`);
    await this.flush();
  }

  /** Records the final state and writes the log; waits for any write in flight. */
  async finish(state: Exclude<BuildState, "running">): Promise<void> {
    this.#state = state;
    this.#dirty = true;
    await this.flush();
  }

  /** Writes the log now (one write at a time; a write requested meanwhile follows it). */
  async flush(): Promise<void> {
    while (this.#inFlight) {
      await this.#inFlight;
    }
    if (!this.#dirty && this.#lastFlush !== 0) return;
    this.#dirty = false;
    this.#lastFlush = this.options.now();
    const write = this.options.bucket
      .put(this.options.key, this.#text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: {
          state: this.#state,
          stage: this.#stage,
          startedAt: this.#startedAt,
          updatedAt: new Date(this.#lastFlush).toISOString(),
        },
      })
      .then(() => undefined);
    this.#inFlight = write.finally(() => {
      this.#inFlight = null;
    });
    await this.#inFlight;
  }
}

/** The progress of the build whose log is at `key`, or null when there is none. */
export async function readProgress(bucket: R2Bucket, key: string): Promise<BuildProgress | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  const meta = object.customMetadata ?? {};
  const parsed = buildProgressSchema.safeParse({
    state: meta.state,
    stage: meta.stage,
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    log: await object.text(),
  });
  return parsed.success ? parsed.data : null;
}
