import type { SandboxInstanceType } from "@appflare/schema";
import { getSandbox, Sandbox as SandboxBase } from "@cloudflare/sandbox";

/**
 * The container a build runs in. The build steps (build.ts) talk to this
 * small interface only: in production it wraps a Cloudflare Sandbox
 * (`@cloudflare/sandbox`), in tests a scripted fake, because the container
 * itself cannot run outside Cloudflare.
 */
export interface BuildSandbox {
  /** Shallow-clones `repoUrl` at `branch` (a branch or tag) into `targetDir`; throws on failure. */
  gitCheckout(
    repoUrl: string,
    options: { branch: string; targetDir: string; depth: number; cloneTimeoutMs: number },
  ): Promise<void>;
  /** Runs a command line to completion, streaming its output to `onOutput`. */
  exec(command: string, options: ExecOptions): Promise<ExecOutcome>;
  writeFile(path: string, content: string): Promise<void>;
  /** Mounts `prefix` of the Worker's R2 binding `binding` at `mountPath`, without credentials. */
  mountBucket(binding: string, mountPath: string, prefix: string): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;
  /** Stops the container and discards its disk. */
  destroy(): Promise<void>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  onOutput: (chunk: string) => void;
}

export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The Sandbox Durable Object that runs `standard-1` containers. A build runs
 * third-party code; it gets the internet (to clone and install) and holds no
 * credentials: no Cloudflare token or key is ever put in a build's
 * container, so there is nothing in it that could act on an account.
 *
 * A self-deploying run (self-managed.ts) uses the same containers for the
 * app's own installer, and is the one exception: its installer command, and
 * only that command, gets the app's own token (never the manager's) in its
 * environment, because deploying is what the installer is for. Its checkout,
 * dependency install and build run without it, like a build.
 *
 * `deniedHosts` refuses plain-HTTP requests to the Cloudflare API only.
 * @cloudflare/containers matches hosts of HTTPS traffic only when it
 * intercepts HTTPS (`interceptHttps`, off by default), so outbound HTTPS,
 * including to api.cloudflare.com, is not blocked.
 */
export class Sandbox extends SandboxBase<Env> {
  // TODO: turn on `interceptHttps` so `deniedHosts` covers HTTPS too. It makes
  // every HTTPS client in the container (git, npm, pnpm, yarn, bun, Node's
  // fetch) trust /etc/cloudflare/certs/cloudflare-containers-ca.crt; that can
  // only be tested in a running container, which the tests here cannot start.
  // Self-deploying runs need api.cloudflare.com over HTTPS, so they would then
  // move to a container class of their own that allows it, ideally one whose
  // outbound handler adds the app token to Cloudflare API requests so the
  // token never enters the container at all.
  override deniedHosts = ["api.cloudflare.com"];
}

/** The same, bound to the `standard-2` container class for entries that ask for it. */
export class LargeSandbox extends Sandbox {}

/** How long an idle build container lives: a build never pauses this long. */
const SLEEP_AFTER = "15m";

/** The Sandbox for one build, on the requested container size. */
export function openBuildSandbox(
  env: Env,
  id: string,
  instanceType: SandboxInstanceType,
): BuildSandbox {
  const namespace = instanceType === "standard-2" ? env.LargeSandbox : env.Sandbox;
  const sandbox = getSandbox(namespace, id, {
    sleepAfter: SLEEP_AFTER,
    // Every command names its own directory and environment; no shell state
    // carries over from one command to the next.
    enableDefaultSession: false,
    // One subrequest per SDK call, and no 32 MiB limit on what a call returns.
    transport: "rpc",
  });
  return {
    async gitCheckout(repoUrl, options) {
      const result = await sandbox.gitCheckout(repoUrl, options);
      if (!result.success) {
        throw new Error(`git clone of ${repoUrl} at ${options.branch} failed`);
      }
    },
    async exec(command, options) {
      // Kept from the stream as well, in case a streamed result carries no
      // buffered output; bounded, since only short outputs are ever parsed.
      const streamed = { stdout: "", stderr: "" };
      const result = await sandbox.exec(command, {
        cwd: options.cwd,
        env: options.env ? { ...options.env } : undefined,
        timeout: options.timeoutMs,
        stream: true,
        onOutput: (stream, data) => {
          streamed[stream] = (streamed[stream] + data).slice(-256 * 1024);
          options.onOutput(data);
        },
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout || streamed.stdout,
        stderr: result.stderr || streamed.stderr,
      };
    },
    async writeFile(path, content) {
      await sandbox.writeFile(path, content);
    },
    async mountBucket(binding, mountPath, prefix) {
      await sandbox.mountBucket(binding, mountPath, { prefix });
    },
    async unmountBucket(mountPath) {
      await sandbox.unmountBucket(mountPath);
    },
    async destroy() {
      await sandbox.destroy();
    },
  };
}
