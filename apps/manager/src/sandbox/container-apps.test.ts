import { CloudflareApiError, type ContainerApplication } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { findSandboxContainerApps } from "./container-apps";

const app = (id: string, name: string, namespaceId?: string): ContainerApplication =>
  ({
    id,
    name,
    ...(namespaceId === undefined ? {} : { durable_objects: { namespace_id: namespaceId } }),
  }) as ContainerApplication;

const NAMESPACES = [
  { id: "ns-sandbox", script: "appflare-sandbox", class: "Sandbox" },
  { id: "ns-future", script: "appflare-sandbox", class: "GpuSandbox" },
  { id: "ns-theirs", script: "someone-else", class: "Box" },
];

/** Namespaces read one by one answer from `reads`: found, gone (404, 10066), or another error. */
function fakeApi(
  apps: ContainerApplication[],
  reads: Record<string, "found" | "gone" | number> = {},
) {
  const calls: string[] = [];
  const api = {
    containers: {
      listApplications: async (opts?: { name?: string }) => {
        calls.push(`apps ${opts?.name ?? "*"}`);
        return apps;
      },
    },
    workers: {
      listDurableObjectNamespaces: async () => {
        calls.push("namespaces");
        return NAMESPACES;
      },
      getDurableObjectNamespace: async (id: string) => {
        calls.push(`namespace ${id}`);
        const read = reads[id] ?? "gone";
        if (read === "found") return { id, script: "x", class: "Y" };
        const status = read === "gone" ? 404 : read;
        const code = read === "gone" ? 10066 : 10013;
        throw new CloudflareApiError({
          status,
          method: "GET",
          path: `/workers/durable_objects/namespaces/${id}`,
          errors: [{ code, message: read === "gone" ? "not found" : "internal error" }],
        });
      },
    },
  } as unknown as Parameters<typeof findSandboxContainerApps>[0];
  return { api, calls };
}

describe("the sandbox Worker's container applications", () => {
  it("are every application backing one of its namespaces, whatever the class", async () => {
    const { api, calls } = fakeApi([
      app("a1", "appflare-sandbox-standard-1", "ns-sandbox"),
      // A class of a newer sandbox release, by a name this version does not know.
      app("a2", "appflare-sandbox-gpu", "ns-future"),
      app("a3", "their-app", "ns-theirs"),
    ]);
    const found = await findSandboxContainerApps(api);
    expect(found.apps.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(found.left).toEqual([]);
    // Two list calls, nothing read one by one.
    expect(calls).toEqual(["apps *", "namespaces"]);
  });

  it("and those by its prefix whose namespace Cloudflare reports gone, whatever the class", async () => {
    const { api, calls } = fakeApi([
      app("o1", "appflare-sandbox-self-deploying-standard-1", "ns-gone"),
      // Left by a removal that stopped after the Worker, of a class this version does not know.
      app("o2", "appflare-sandbox-gpu", "ns-gone-gpu"),
      // A name without the prefix, backing nothing that exists: not looked at.
      app("x1", "something-else", "ns-gone"),
    ]);
    const found = await findSandboxContainerApps(api);
    expect(found.apps.map((a) => a.id)).toEqual(["o1", "o2"]);
    expect(found.left).toEqual([]);
    expect(calls).toEqual(["apps *", "namespaces", "namespace ns-gone", "namespace ns-gone-gpu"]);
  });

  it("leave any other by its prefix, saying why", async () => {
    const { api } = fakeApi(
      [
        app("t1", "appflare-sandbox-self-deploying-standard-2", "ns-theirs"),
        app("n1", "appflare-sandbox-standard-2"),
        // Missing from the list, but found when read.
        app("f1", "appflare-sandbox-standard-1", "ns-late"),
        app("u1", "appflare-sandbox-gpu", "ns-unsure"),
        app("d1", "appflare-sandbox-big", "ns-denied"),
      ],
      { "ns-late": "found", "ns-unsure": 500, "ns-denied": 403 },
    );
    const found = await findSandboxContainerApps(api);
    expect(found.apps).toEqual([]);
    expect(found.left).toEqual([
      {
        id: "t1",
        name: "appflare-sandbox-self-deploying-standard-2",
        reason: "it backs a Durable Object namespace of the Worker someone-else",
      },
      {
        id: "n1",
        name: "appflare-sandbox-standard-2",
        reason: "it backs no Durable Object namespace, so nothing shows it is the sandbox Worker's",
      },
      {
        id: "f1",
        name: "appflare-sandbox-standard-1",
        reason: "the Durable Object namespace it backs (ns-late) still exists",
      },
      {
        id: "u1",
        name: "appflare-sandbox-gpu",
        reason: expect.stringMatching(
          /^Cloudflare did not confirm that the Durable Object namespace it backs \(ns-unsure\) is gone: .*-> 500/,
        ),
      },
      {
        id: "d1",
        name: "appflare-sandbox-big",
        reason: expect.stringMatching(/\(ns-denied\) is gone: .*-> 403/),
      },
    ]);
  });

  it("are read with one call when the account has no application", async () => {
    const { api, calls } = fakeApi([]);
    expect(await findSandboxContainerApps(api)).toEqual({ apps: [], left: [] });
    expect(calls).toEqual(["apps *"]);
  });
});
