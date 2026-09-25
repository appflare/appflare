import { INSPECT_OUTPUT_PREFIX, type WranglerFacts } from "@appflare/schema";
import type { BuildSandbox, ExecOptions, ExecOutcome } from "../sandbox";

/**
 * A scripted stand-in for the build container. The real one (a Cloudflare
 * Sandbox) cannot run in tests, so this fake plays the few commands a build
 * issues: git, the install, the build command, the packer (which "writes" the
 * files the test provides), `stat`, and `cp` into the mounted R2 prefix (which
 * writes to the real local bucket, so the verify step reads what was copied).
 */

export interface FakeFailure {
  /** The first command matching this fails. */
  match: RegExp;
  exitCode?: number;
  output?: string;
  /** Throw instead of exiting non-zero: the container is unreachable. */
  throws?: string;
}

export interface FakeSandboxOptions {
  bucket: R2Bucket;
  /** The commit the pin's ref resolves to on clone; the pin by default. */
  refHead: string;
  /** The commit a fetch by SHA checks out. */
  fetchHead?: string;
  cloneFails?: boolean;
  /**
   * What `appflare-pack` writes to the output directory: file name to bytes,
   * or worked out from the catalog manifest the build wrote for the packer.
   */
  packOutput:
    | Record<string, Uint8Array>
    | ((catalogManifest: unknown) => Record<string, Uint8Array>);
  failures?: FakeFailure[];
  /** Output a succeeding command prints, for the first pattern its command line matches. */
  outputs?: Array<{ match: RegExp; output: string }>;
  /** `destroy()` throws this (a container a new version of the Worker reset). */
  destroyThrows?: string;
  /**
   * A fake git host: the commit each branch or tag points at. A clone of a
   * name it does not list fails; a clone without a name takes
   * `defaultBranch`. Without it, every clone lands on `refHead`.
   */
  refs?: Record<string, string>;
  defaultBranch?: string;
  /** Commits a fetch by SHA can find (with `refs`); others fail as git would. */
  commits?: string[];
  /** What `git log -1 --format=%cI` prints. */
  committedAt?: string;
  /** The checkout's files at its root: name to contents (a fixture repository). */
  files?: Record<string, string>;
  /** What `appflare-pack inspect` answers (wrangler's reading of the config). */
  inspect?: WranglerFacts;
}

export class FakeSandbox implements BuildSandbox {
  readonly commands: string[] = [];
  readonly written = new Map<string, string>();
  readonly envs: Readonly<Record<string, string>>[] = [];
  mount: { binding: string; path: string; prefix: string } | null = null;
  destroyed = false;
  #head = "";
  /** The branch a clone without a name checked out (what `--abbrev-ref HEAD` prints). */
  #branch: string | null = null;
  #out = new Map<string, Uint8Array>();
  readonly #failures: FakeFailure[];

  constructor(private readonly options: FakeSandboxOptions) {
    this.#failures = [...(options.failures ?? [])];
  }

  async gitCheckout(repoUrl: string, options: { branch?: string }): Promise<void> {
    this.commands.push(`<gitCheckout ${repoUrl} ${options.branch ?? "(default branch)"}>`);
    if (this.options.cloneFails) throw new Error("Remote branch not found");
    const { refs } = this.options;
    if (refs === undefined) {
      this.#head = this.options.refHead;
      return;
    }
    const name = options.branch ?? this.options.defaultBranch ?? "main";
    const head = refs[name];
    if (head === undefined) throw new Error(`Remote branch ${name} not found in upstream origin`);
    this.#head = head;
    this.#branch = options.branch === undefined ? name : null;
  }

  async exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    this.commands.push(command);
    if (options.env) this.envs.push(options.env);
    const index = this.#failures.findIndex((f) => f.match.test(command));
    if (index >= 0) {
      const [failure] = this.#failures.splice(index, 1);
      if (failure?.throws) throw new Error(failure.throws);
      const output = failure?.output ?? "";
      options.onOutput(output);
      return { exitCode: failure?.exitCode ?? 1, stdout: "", stderr: output };
    }
    const ok = (stdout = ""): ExecOutcome => {
      if (stdout) options.onOutput(stdout);
      return { exitCode: 0, stdout, stderr: "" };
    };
    const printed = this.options.outputs?.find((o) => o.match.test(command));
    if (printed !== undefined) return ok(printed.output);
    if (command.includes("rev-parse --abbrev-ref HEAD")) {
      return ok(`${this.#branch ?? "HEAD"}\n`);
    }
    if (command.includes("rev-parse HEAD")) return ok(this.#head ? `${this.#head}\n` : "");
    if (command.includes("log -1 --format=%cI")) {
      return ok(this.options.committedAt === undefined ? "" : `${this.options.committedAt}\n`);
    }
    if (command.includes(" fetch -q --depth 1 origin ")) {
      const wanted = /origin ([0-9a-f]{40})/.exec(command)?.[1] ?? "";
      const known = this.options.commits ?? Object.values(this.options.refs ?? {});
      if (this.options.refs !== undefined && !known.includes(wanted)) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: remote error: upload-pack: not our ref ${wanted}`,
        };
      }
      this.#head = this.options.fetchHead ?? wanted;
      this.#branch = null;
      return ok();
    }
    if (command.startsWith("ls -1A -- ")) {
      return ok(Object.keys(this.options.files ?? {}).join("\n"));
    }
    if (command.startsWith("head -c ")) {
      const name = /\/([^/']+)'?$/.exec(command)?.[1] ?? "";
      const text = this.options.files?.[name];
      if (text === undefined) {
        return { exitCode: 1, stdout: "", stderr: `head: cannot open '${name}' for reading` };
      }
      return ok(text);
    }
    if (command.startsWith("appflare-pack inspect ")) {
      const facts = this.options.inspect ?? { name: null, vars: [], unsupported: [] };
      return ok(`${INSPECT_OUTPUT_PREFIX}${JSON.stringify(facts)}\n`);
    }
    if (command.startsWith("appflare-pack ")) {
      const { packOutput } = this.options;
      const input = /--manifest (\S+)/.exec(command)?.[1] ?? "";
      this.#out = new Map(
        Object.entries(
          typeof packOutput === "function"
            ? packOutput(JSON.parse(this.written.get(input) ?? "null"))
            : packOutput,
        ),
      );
      return ok("widget@1.2.3\n");
    }
    if (command.includes("stat -c")) {
      return ok([...this.#out].map(([name, bytes]) => `${bytes.byteLength} ${name}`).join("\n"));
    }
    if (command.startsWith("cp -- ")) {
      if (!this.mount) return { exitCode: 1, stdout: "", stderr: "cp: not a directory" };
      const prefix = this.mount.prefix.replace(/^\//, "");
      for (const [name, bytes] of this.#out) {
        if (command.includes(`/${name} `))
          await this.options.bucket.put(`${prefix}/${name}`, bytes);
      }
      return ok();
    }
    return ok(command.includes("install") ? "installed\n" : "");
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.written.set(path, content);
  }

  async mountBucket(binding: string, path: string, prefix: string): Promise<void> {
    this.commands.push(`<mount ${binding} ${prefix} at ${path}>`);
    this.mount = { binding, path, prefix };
  }

  async unmountBucket(path: string): Promise<void> {
    this.commands.push(`<unmount ${path}>`);
    this.mount = null;
  }

  async destroy(): Promise<void> {
    if (this.options.destroyThrows !== undefined) throw new Error(this.options.destroyThrows);
    this.destroyed = true;
  }
}
