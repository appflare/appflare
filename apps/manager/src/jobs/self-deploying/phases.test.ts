import { catalogManifestSchema } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { baseCatalog } from "../../test/artifact-fixture";
import { healthCheckOfManifest } from "../install/health";
import { JobError } from "../steps";
import {
  discoveredKey,
  expectedWorkers,
  installerRequest,
  installerRunId,
  installerVars,
  recordedCatalog,
} from "./phases";

const catalog = catalogManifestSchema.parse({
  ...baseCatalog(),
  install: {
    tier: "self-deploying",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    health: { path: "/api/health" },
    selfDeploying: {
      tool: "alchemy",
      deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
      destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
      workerNames: ["cut-{{stage}}"],
    },
  },
  vars: [
    { name: "HOME_PAGE", label: "Home", default: "{{workerUrl}}/home" },
    { name: "EMPTY", label: "Empty" },
  ],
});

describe("installer requests", () => {
  it("names runs, Workers and settings after the install", () => {
    expect(installerRunId("deploy", "0.1.9")).toBe("deploy-0.1.9");
    expect(installerRunId("destroy", "1.0.0+build/1")).toBe("destroy-1.0.0+build_1");
    expect(expectedWorkers(catalog, "01J8Z3Q4R5S6T7V8W9X0YZABCD")).toEqual([
      "cut-appflare-x0yzabcd",
    ]);
    expect(
      installerVars(
        catalog,
        {},
        { workerName: "cut-x", workerUrl: "https://cut-x.acme.workers.dev" },
      ),
    ).toEqual({ HOME_PAGE: "https://cut-x.acme.workers.dev/home" });
    expect(
      installerVars(
        catalog,
        { HOME_PAGE: "https://example.com", EMPTY: " " },
        {
          workerName: "cut-x",
          workerUrl: null,
        },
      ),
    ).toEqual({ HOME_PAGE: "https://example.com" });
  });

  it("refuses settings that would set the installer's credentials", () => {
    expect(() =>
      installerRequest({
        action: "deploy",
        installId: "id1",
        accountId: "0123456789abcdef0123456789abcdef",
        catalog,
        pin: catalog.source.sha,
        version: "1.0.0",
        vars: { CLOUDFLARE_API_TOKEN: "sneaky" },
      }),
    ).toThrow(JobError);
  });

  it("keys discovered resources so a later run finds the same rows", () => {
    const base = { worker: "cut-a", binding: "B" };
    expect(discoveredKey({ ...base, kind: "d1", name: "db", cfId: "uuid" })).toBe("uuid");
    expect(discoveredKey({ ...base, kind: "durable_object", name: "Room", cfId: "ns" })).toBe(
      "cut-a.Room",
    );
    expect(discoveredKey({ ...base, kind: "r2", name: "bucket", cfId: "bucket" })).toBe("bucket");
  });
});

describe("a self-deploying install's recorded catalog manifest", () => {
  it("is read back for the uninstall and the health check, with the entry's health mode", () => {
    const json = JSON.stringify(catalog);
    expect(recordedCatalog(json)?.slug).toBe("cut");
    expect(recordedCatalog(JSON.stringify(baseCatalog()))).toBeNull();
    expect(recordedCatalog(null)).toBeNull();
    expect(healthCheckOfManifest(json)).toEqual({ path: "/api/health", mode: "no-server-errors" });
  });
});
