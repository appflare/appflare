import type { ArtifactManifest } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { selfUpdateBindings } from "./plan";

/** The `SANDBOX` service binding in the self-update's binding plan. */

const MANIFEST: Pick<ArtifactManifest, "worker" | "assets"> = {
  worker: {
    name: "appflare",
    wranglerConfig: { declared: "wrangler.jsonc", effective: "{}" },
    mainModule: "index.js",
    compatibilityDate: "2026-09-21",
    compatibilityFlags: ["nodejs_compat"],
    modules: [],
    bindings: [
      { type: "d1", name: "DB" },
      { type: "kv_namespace", name: "KV" },
      { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
    ],
    migrations: [],
    crons: [],
    queueConsumers: [],
    observability: null,
    placement: null,
    limits: null,
  },
  assets: { config: {}, binding: "ASSETS", files: [] },
};

const CURRENT = [
  { type: "d1", name: "DB", database_id: "d1-uuid" },
  { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
  { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
  { type: "plain_text", name: "APPFLARE_VERSION", text: "0.1.0" },
];

const SANDBOX = {
  type: "service",
  name: "SANDBOX",
  service: "appflare-sandbox",
  entrypoint: "SandboxBuilds",
};

function plan(current: unknown[], sandboxWorker?: boolean) {
  return selfUpdateBindings({
    current,
    manifest: MANIFEST,
    workerName: "appflare",
    newVersion: "0.2.0",
    ...(sandboxWorker === undefined ? {} : { sandboxWorker }),
  });
}

describe("selfUpdateBindings and the sandbox Worker", () => {
  it("adds SANDBOX when the account has the sandbox Worker", () => {
    const p = plan(CURRENT, true);
    expect(p.problems).toEqual([]);
    expect(p.bindings.filter((b) => b.name === "SANDBOX")).toEqual([SANDBOX]);
  });

  it("adds nothing when there is no sandbox Worker", () => {
    const p = plan(CURRENT, false);
    expect(p.bindings.some((b) => b.name === "SANDBOX")).toBe(false);
    expect(p.warnings).toEqual([]);
  });

  it("keeps an existing SANDBOX once, and keeps it as is when the Worker list was not read", () => {
    expect(plan([...CURRENT, SANDBOX], true).bindings.filter((b) => b.name === "SANDBOX")).toEqual([
      SANDBOX,
    ]);
    expect(plan([...CURRENT, SANDBOX]).bindings.filter((b) => b.name === "SANDBOX")).toEqual([
      SANDBOX,
    ]);
  });

  it("drops SANDBOX with a warning once the sandbox Worker is gone", () => {
    const p = plan([...CURRENT, SANDBOX], false);
    expect(p.bindings.some((b) => b.name === "SANDBOX")).toBe(false);
    expect(p.warnings).toEqual([
      'The sandbox Worker "appflare-sandbox" no longer exists, so the new version has no SANDBOX binding; sandbox tier apps cannot be installed or updated until it is enabled again.',
    ]);
    expect(p.problems).toEqual([]);
  });

  it("refuses a SANDBOX that points at another Worker, or that is not a service binding", () => {
    const foreign = plan([...CURRENT, { ...SANDBOX, service: "billing" }], true);
    expect(foreign.problems).toEqual([
      'The running Worker\'s service binding SANDBOX points at "billing", not at the sandbox Worker ("appflare-sandbox"); Appflare needs SANDBOX for sandbox builds. Remove or rename that binding first.',
    ]);
    expect(foreign.bindings.some((b) => b.name === "SANDBOX")).toBe(false);
    const other = plan([...CURRENT, { type: "plain_text", name: "SANDBOX", text: "x" }], true);
    expect(other.problems).toEqual([
      "The running Worker has a plain_text binding named SANDBOX, which Appflare needs for the service binding to the sandbox Worker.",
    ]);
  });
});
