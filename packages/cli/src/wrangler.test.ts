import { describe, expect, it } from "vitest";
import { fakeSpawner } from "./test-fixtures.ts";
import {
  createWrangler,
  isWorkerNotFound,
  parseJsonOutput,
  resolveWranglerBin,
  WranglerError,
  wranglerArgs,
  wranglerEnv,
} from "./wrangler.ts";

describe("wranglerArgs", () => {
  it("builds every command the CLI runs", () => {
    expect(wranglerArgs.whoami()).toEqual(["whoami", "--json"]);
    expect(wranglerArgs.deploy("/t/project/wrangler.json")).toEqual([
      "deploy",
      "--config",
      "/t/project/wrangler.json",
      "--strict",
    ]);
    expect(wranglerArgs.secretPut("appflare", "BETTER_AUTH_SECRET")).toEqual([
      "secret",
      "put",
      "BETTER_AUTH_SECRET",
      "--name",
      "appflare",
    ]);
    expect(wranglerArgs.deploymentsList("appflare")).toEqual([
      "deployments",
      "list",
      "--name",
      "appflare",
      "--json",
    ]);
    expect(wranglerArgs.d1List()).toEqual(["d1", "list", "--json"]);
    expect(wranglerArgs.kvList()).toEqual(["kv", "namespace", "list"]);
  });
});

describe("createWrangler", () => {
  it("spawns the dependency's wrangler with node, a private cwd, the neutral config, and the account", async () => {
    const { spawner, calls } = fakeSpawner({
      whoami: () => ({ stdout: "{}" }),
      deploy: () => ({}),
    });
    const wrangler = createWrangler({
      cwd: "/tmp/appflare-x",
      configPath: "/tmp/appflare-x/wrangler.json",
      env: { PATH: "/bin", WRANGLER_SEND_METRICS: "true" },
      spawner,
      bin: "/fake/wrangler.js",
    });
    await wrangler.run(wranglerArgs.whoami());
    wrangler.accountId = "acc-1";
    await wrangler.run(wranglerArgs.deploy("/tmp/appflare-x/project/wrangler.json"), {
      env: { WRANGLER_OUTPUT_FILE_PATH: "/tmp/appflare-x/out.ndjson" },
    });

    expect(calls[0]?.args).toEqual([
      "whoami",
      "--json",
      "--config",
      "/tmp/appflare-x/wrangler.json",
    ]);
    expect(calls[0]?.cwd).toBe("/tmp/appflare-x");
    expect(calls[0]?.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(calls[0]?.stdin).toEqual({ kind: "ignore" });
    // An explicit --config is not doubled.
    expect(calls[1]?.args).toEqual([
      "deploy",
      "--config",
      "/tmp/appflare-x/project/wrangler.json",
      "--strict",
    ]);
    expect(calls[1]?.env).toMatchObject({
      PATH: "/bin",
      CLOUDFLARE_ACCOUNT_ID: "acc-1",
      WRANGLER_OUTPUT_FILE_PATH: "/tmp/appflare-x/out.ndjson",
      // The user's explicit choice wins over the default of wrangler's metrics off.
      WRANGLER_SEND_METRICS: "true",
      WRANGLER_SEND_ERROR_REPORTS: "false",
    });
  });

  it("resolves wrangler from the package's own dependencies", () => {
    expect(resolveWranglerBin()).toMatch(/node_modules[/\\].*wrangler[/\\]bin[/\\]wrangler\.js$/);
  });
});

describe("helpers", () => {
  it("defaults wrangler's own metrics and error reports off", () => {
    expect(wranglerEnv({})).toMatchObject({
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_SEND_ERROR_REPORTS: "false",
    });
  });
  it("recognizes a missing Worker", () => {
    expect(
      isWorkerNotFound({
        code: 1,
        stdout: "",
        stderr: "This Worker does not exist on your account. [code: 10007]",
      }),
    ).toBe(true);
    expect(
      isWorkerNotFound({ code: 1, stdout: "", stderr: "Authentication error [code: 10000]" }),
    ).toBe(false);
  });
  it("parses JSON after leading noise", () => {
    expect(parseJsonOutput("x", "warning: something\n[1,2]\n")).toEqual([1, 2]);
    expect(() => parseJsonOutput("x", "nothing")).toThrow("printed no JSON");
  });
  it("can leave output out of an error", () => {
    const error = new WranglerError(
      "auth token",
      { code: 1, stdout: "SECRET", stderr: "" },
      { showOutput: false },
    );
    expect(error.message).not.toContain("SECRET");
  });
});
