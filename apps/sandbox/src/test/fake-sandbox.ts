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
  /** What `appflare-pack` writes to the output directory: file name to bytes. */
  packOutput: Record<string, Uint8Array>;
  failures?: FakeFailure[];
}

export class FakeSandbox implements BuildSandbox {
  readonly commands: string[] = [];
  readonly written = new Map<string, string>();
  readonly envs: Readonly<Record<string, string>>[] = [];
  mount: { binding: string; path: string; prefix: string } | null = null;
  destroyed = false;
  #head = "";
  #out = new Map<string, Uint8Array>();
  readonly #failures: FakeFailure[];

  constructor(private readonly options: FakeSandboxOptions) {
    this.#failures = [...(options.failures ?? [])];
  }

  async gitCheckout(repoUrl: string, options: { branch: string }): Promise<void> {
    this.commands.push(`<gitCheckout ${repoUrl} ${options.branch}>`);
    if (this.options.cloneFails) throw new Error("Remote branch not found");
    this.#head = this.options.refHead;
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
    if (command.includes("rev-parse HEAD")) return ok(this.#head ? `${this.#head}\n` : "");
    if (command.includes(" fetch -q --depth 1 origin ")) {
      this.#head = this.options.fetchHead ?? /origin ([0-9a-f]{40})/.exec(command)?.[1] ?? "";
      return ok();
    }
    if (command.startsWith("appflare-pack ")) {
      this.#out = new Map(Object.entries(this.options.packOutput));
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
    this.destroyed = true;
  }
}
