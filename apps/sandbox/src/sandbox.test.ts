import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  appTokenSecretName,
  SANDBOX_CONTAINERS,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxInstanceType,
} from "@appflare/schema";
import { Sandbox as SandboxBase } from "@cloudflare/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxBuilds } from "./index";
import {
  BUILD_DENIED_HOSTS,
  LargeSandbox,
  LargeSelfDeployingSandbox,
  openBuildSandbox,
  openSelfDeployingSandbox,
  refuseDeniedHostsOverHttps,
  Sandbox,
  SelfDeployingSandbox,
  sandboxClassName,
} from "./sandbox";

// The containers cannot run in tests. These pin which container class each
// run opens, and that build containers refuse HTTPS requests that name the
// Cloudflare API; the refusal itself runs the Worker's real ContainerProxy.

const CLASSES = ["Sandbox", "LargeSandbox", "SelfDeployingSandbox", "LargeSelfDeployingSandbox"];

/**
 * Durable Object namespaces standing in for the four container classes. Each
 * records the calls that reach its stubs; a call that would need a running
 * container fails, as if the container could not be reached.
 */
function fakeNamespaces() {
  const calls: string[] = [];
  const namespaces = Object.fromEntries(
    CLASSES.map((className) => [
      className,
      {
        idFromName: (name: string) => ({ name, toString: () => name }),
        get: (id: { name: string }) =>
          new Proxy(
            {},
            {
              get(_target, method) {
                if (typeof method !== "string" || method === "then") return undefined;
                return async () => {
                  calls.push(`${className} ${id.name} ${method}`);
                  if (method === "configure" || method === "destroy") return undefined;
                  throw new Error("no container in tests");
                };
              },
            },
          ),
      },
    ]),
  );
  return { calls, namespaces };
}

describe("sandboxClassName", () => {
  it("runs builds and self-deploying runs in classes of their own, on the size asked for", () => {
    expect(sandboxClassName("build", "standard-1")).toBe("Sandbox");
    expect(sandboxClassName("build", "standard-2")).toBe("LargeSandbox");
    expect(sandboxClassName("self-deploying", "standard-1")).toBe("SelfDeployingSandbox");
    expect(sandboxClassName("self-deploying", "standard-2")).toBe("LargeSelfDeployingSandbox");
    for (const c of SANDBOX_CONTAINERS) {
      expect(sandboxClassName(c.use, c.instance_type)).toBe(c.class_name);
    }
  });

  it("exports a class for every container the manager deploys", async () => {
    const index = await import("./index");
    for (const c of SANDBOX_CONTAINERS) {
      expect(typeof (index as Record<string, unknown>)[c.class_name]).toBe("function");
    }
  });
});

describe("opening a container", () => {
  const sizes: SandboxInstanceType[] = ["standard-1", "standard-2"];

  it("opens builds in the build classes and self-deploying runs in theirs", async () => {
    const { calls, namespaces } = fakeNamespaces();
    const fakeEnv = { ...env, ...namespaces } as unknown as Env;
    for (const size of sizes) {
      await openBuildSandbox(fakeEnv, `build-${size}`, size).destroy();
      await openSelfDeployingSandbox(fakeEnv, `self-${size}`, size).destroy();
    }
    expect(calls.filter((c) => c.endsWith(" destroy"))).toEqual([
      "Sandbox build-standard-1 destroy",
      "SelfDeployingSandbox self-standard-1 destroy",
      "LargeSandbox build-standard-2 destroy",
      "LargeSelfDeployingSandbox self-standard-2 destroy",
    ]);
  });

  it("gives a self-deploying run of the entrypoint a self-deploying container", async () => {
    const installId = "01J8SELFDEPLOY";
    const { calls, namespaces } = fakeNamespaces();
    const builds = new SandboxBuilds(createExecutionContext(), {
      ...env,
      ...namespaces,
      [appTokenSecretName(installId)]: "app-token-value",
    } as unknown as Env);
    const outcome = await builds.deploySelfManaged({
      protocol: SANDBOX_PROTOCOL_VERSION,
      installId,
      runId: "deploy-1.0.0",
      accountId: "0123456789abcdef0123456789abcdef",
      tool: "alchemy",
      repo: "acme/widget",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "v1.0.0",
      packageManager: "pnpm",
      command: ["pnpm", "alchemy", "deploy"],
      stage: "appflare-test",
      stageArg: "--stage",
      tokenEnv: ["CLOUDFLARE_API_TOKEN"],
      accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
      vars: {},
      secretNames: [],
      expectedWorkers: ["widget"],
      instanceType: "standard-2",
    });
    expect(outcome).toMatchObject({ ok: false, step: "checkout" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith("LargeSelfDeployingSandbox "))).toBe(true);
  });
});

describe("refuseDeniedHostsOverHttps", () => {
  it("sends HTTPS to the Cloudflare API, and nothing else, to a proxy that refuses it", async () => {
    const intercepted: Array<{ host: string; fetcher: Fetcher }> = [];
    const ctx = {
      id: { toString: () => "do-id" },
      exports,
      container: {
        async interceptOutboundHttps(host: string, fetcher: Fetcher) {
          intercepted.push({ host, fetcher });
        },
      },
    } as unknown as DurableObjectState;
    await refuseDeniedHostsOverHttps(ctx, "Sandbox");
    expect(BUILD_DENIED_HOSTS).toEqual(["api.cloudflare.com"]);
    expect(intercepted.map((i) => i.host)).toEqual(["api.cloudflare.com"]);

    // The Worker's own ContainerProxy, as the container's runtime calls it.
    const [refuse] = intercepted;
    if (refuse === undefined) throw new Error("nothing was intercepted");
    const api = await refuse.fetcher.fetch(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      {
        headers: { authorization: "Bearer stolen" },
      },
    );
    expect(api.status).toBe(520);
    expect(await api.text()).toBe("Origin is disallowed");
    // Whatever else reached it would be refused too.
    const other = await refuse.fetcher.fetch("https://registry.npmjs.org/");
    expect(other.status).toBe(520);
    await other.body?.cancel();
  });

  it("fails without a container, so a build never runs without the refusal", async () => {
    const ctx = { id: { toString: () => "do-id" }, exports } as unknown as DurableObjectState;
    await expect(refuseDeniedHostsOverHttps(ctx, "Sandbox")).rejects.toThrow(
      "this Durable Object has no container",
    );
  });
});

describe("the container classes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs `onStart` of a class on a stand-in object holding only a fake `ctx`. */
  async function start(cls: typeof SandboxBase<Env>): Promise<string[]> {
    vi.spyOn(SandboxBase.prototype, "onStart").mockResolvedValue(undefined);
    const hosts: string[] = [];
    const ctx = {
      id: { toString: () => "do-id" },
      exports,
      container: {
        async interceptOutboundHttps(host: string) {
          hosts.push(host);
        },
      },
    };
    const instance = Object.assign(Object.create(cls.prototype) as SandboxBase<Env>, { ctx });
    await instance.onStart();
    return hosts;
  }

  it("refuse the Cloudflare API over HTTPS each time a build container starts", async () => {
    expect(await start(Sandbox)).toEqual(["api.cloudflare.com"]);
    expect(await start(LargeSandbox)).toEqual(["api.cloudflare.com"]);
  });

  it("run no command in a build container whose refusal cannot be set up", async () => {
    vi.spyOn(SandboxBase.prototype, "onStart").mockResolvedValue(undefined);
    for (const cls of [Sandbox, LargeSandbox]) {
      // Every request that reaches the container, on any port.
      const reached: string[] = [];
      const container = {
        running: true,
        monitor: () => new Promise<never>(() => {}),
        getTcpPort: (port: number) => ({
          async fetch(url: string) {
            reached.push(`${port} ${url}`);
            return new Response("ok");
          },
        }),
        async interceptOutboundHttps() {
          throw new Error("HTTPS interception is unavailable");
        },
      };
      const ctx = {
        id: { toString: () => "do-id" },
        exports,
        container,
        blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
      };
      const state = { getState: async () => ({ status: "running" }), setHealthy: async () => {} };
      // A stand-in holding only what the SDK's start reads.
      const sandbox: Sandbox = Object.assign(Object.create(cls.prototype), {
        ctx,
        container,
        state,
      });
      // The SDK's own start, which the RPC transport waits for each time it
      // connects to the container, before the first command: it runs onStart
      // and fails with it.
      await expect(sandbox.startAndWaitForPorts({ ports: 3000 })).rejects.toThrow(
        "HTTPS interception is unavailable",
      );
      // Only the SDK's readiness check reached the container.
      expect(reached).toHaveLength(1);
    }
  });

  it("leave a self-deploying container's HTTPS alone: its installer deploys through the API", async () => {
    expect(await start(SelfDeployingSandbox)).toEqual([]);
    expect(await start(LargeSelfDeployingSandbox)).toEqual([]);
    expect(Object.getPrototypeOf(SelfDeployingSandbox)).toBe(SandboxBase);
  });
});
