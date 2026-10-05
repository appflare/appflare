import {
  SANDBOX_CONTAINERS,
  type SandboxContainer,
  type SandboxInstanceType,
  type SandboxUse,
} from "@appflare/schema";
import { getSandbox, Sandbox as SandboxBase } from "@cloudflare/sandbox";

/**
 * The container a build runs in. The build steps (build.ts) talk to this
 * small interface only: in production it wraps a Cloudflare Sandbox
 * (`@cloudflare/sandbox`), in tests a scripted fake, because the container
 * itself cannot run outside Cloudflare.
 */
export interface BuildSandbox {
  /**
   * Shallow-clones `repoUrl` at `branch` (a branch or tag; the default
   * branch when absent) into `targetDir`; throws on failure.
   */
  gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir: string; depth: number; cloneTimeoutMs: number },
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
 * The hosts a build container's requests are refused for, matched by name:
 * the Cloudflare API. This stops a request addressed to the API by name, not
 * a build set on reaching it. Over HTTPS the runtime matches the server name
 * the client sends (SNI), so a connection to the API's address that sends no
 * name goes through, and any relay on the internet can pass requests on. What
 * keeps a build off an account is that its container never holds a
 * Cloudflare credential.
 */
export const BUILD_DENIED_HOSTS: readonly string[] = ["api.cloudflare.com"];

/**
 * The Sandbox Durable Object that runs builds on `standard-1` containers. A
 * build runs third-party code; it gets the internet (to clone and install)
 * and holds no credentials: no Cloudflare token or key is ever put in a
 * build's container, so there is nothing in it that could act on an account.
 *
 * It also refuses the container's requests addressed to api.cloudflare.com,
 * over HTTP and HTTPS (see {@link BUILD_DENIED_HOSTS} for what that does not
 * stop). `deniedHosts` has @cloudflare/containers send the container's
 * plain-HTTP requests through this Worker's `ContainerProxy`, which answers
 * one for a denied host itself (HTTP 520, "Origin is disallowed"). The
 * library covers HTTPS only with `interceptHttps`, and only by intercepting
 * every HTTPS connection once any host list is set. It is left off, because
 * builds then fail at random: the proxy ends every connection after one
 * response, which Node 22's fetch (undici 6) can crash on mid-download, and
 * GitHub answered a clone through it with 429. Instead, each time the
 * container starts, {@link onStart} intercepts the HTTPS connections that
 * name a denied host (see {@link refuseDeniedHostsOverHttps}); everything
 * else connects directly.
 */
export class Sandbox extends SandboxBase<Env> {
  override deniedHosts = [...BUILD_DENIED_HOSTS];

  // The SDK runs this each time it starts the container or reconnects to it.
  // With the RPC transport (openSandbox) that is before it opens the control
  // connection every command goes over; when this throws, the connection
  // fails, so no command runs without the refusal in place.
  override async onStart(): Promise<void> {
    await super.onStart();
    await refuseDeniedHostsOverHttps(this.ctx, this.constructor.name);
  }
}

/** The same, bound to the `standard-2` container class for entries that ask for it. */
export class LargeSandbox extends Sandbox {}

/**
 * Has the container's HTTPS connections that name a host of
 * {@link BUILD_DENIED_HOSTS} as their TLS server name end at the Worker's
 * `ContainerProxy`, set to refuse everything it is sent, instead of the
 * internet. The runtime terminates TLS for them with a certificate of its own
 * CA, which nothing in the container trusts (the Sandbox SDK adds it to the
 * container's trust store only with `interceptHttps`), so a client fails the
 * handshake; one that skips the certificate check gets HTTP 520. A connection
 * that sends another server name, or none, is not intercepted. Throws when
 * the runtime cannot intercept, so the container runs no command without the
 * refusal.
 */
export async function refuseDeniedHostsOverHttps(
  ctx: DurableObjectState,
  className: string,
): Promise<void> {
  const container = ctx.container;
  if (container === undefined) throw new Error("this Durable Object has no container");
  const refuse = ctx.exports.ContainerProxy({
    props: {
      containerId: ctx.id.toString(),
      className,
      deniedHosts: [...BUILD_DENIED_HOSTS],
      // Whatever reaches it is refused, even a host the list does not name.
      enableInternet: false,
      interceptAll: true,
    },
  });
  for (const host of BUILD_DENIED_HOSTS) {
    await container.interceptOutboundHttps(host, refuse);
  }
}

/**
 * The Sandbox Durable Object of self-deploying runs (self-managed.ts) on
 * `standard-1` containers. The app's own installer deploys the app through
 * the Cloudflare API, so this class does not refuse api.cloudflare.com, and
 * the installer command, and only that command, gets the app's own token
 * (never the manager's) in its environment. The checkout, dependency install
 * and build before it run without the token, like a build. Builds keep
 * classes of their own, which refuse the API by name and never get a token.
 */
export class SelfDeployingSandbox extends SandboxBase<Env> {}

/** The same, bound to the `standard-2` container class for entries that ask for it. */
export class LargeSelfDeployingSandbox extends SelfDeployingSandbox {}

/** The container class (and its binding) that runs `use` on `instanceType`. */
export function sandboxClassName(
  use: SandboxUse,
  instanceType: SandboxInstanceType,
): SandboxContainer["class_name"] {
  const container = SANDBOX_CONTAINERS.find(
    (c) => c.use === use && c.instance_type === instanceType,
  );
  if (container === undefined) throw new Error(`no ${use} container runs on ${instanceType}`);
  return container.class_name;
}

/** How long an idle build container lives: a build never pauses this long. */
const SLEEP_AFTER = "15m";

/** The Sandbox for one build, on the requested container size. */
export function openBuildSandbox(
  env: Env,
  id: string,
  instanceType: SandboxInstanceType,
): BuildSandbox {
  return openSandbox(env[sandboxClassName("build", instanceType)], id);
}

/** The Sandbox for one self-deploying run, on the requested container size. */
export function openSelfDeployingSandbox(
  env: Env,
  id: string,
  instanceType: SandboxInstanceType,
): BuildSandbox {
  return openSandbox(env[sandboxClassName("self-deploying", instanceType)], id);
}

function openSandbox(
  namespace: DurableObjectNamespace<SandboxBase<Env>>,
  id: string,
): BuildSandbox {
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
        throw new Error(
          `git clone of ${repoUrl} at ${options.branch ?? "its default branch"} failed`,
        );
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
