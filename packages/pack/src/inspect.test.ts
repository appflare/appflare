import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSPECT_OUTPUT_PREFIX, parseInspectOutput } from "@appflare/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli-main.ts";
import { inspectWranglerConfig } from "./inspect.ts";

// Real wrangler reads each fixture: the facts must be the same whatever the
// config's format, since the manager refuses on `unsupported`.

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-inspect-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const TOML = `name = "boxes"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[vars]
GREETING = "hello"
LIMIT = 3

[[durable_objects.bindings]]
name = "BOX"
class_name = "Box"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Box"]

[[containers]]
class_name = "Box"
image = "docker.io/example/box:1"
max_instances = 1
`;

describe("inspectWranglerConfig", () => {
  it("reads a TOML config with wrangler and names the containers it declares", () => {
    const dir = project({ "wrangler.toml": TOML, "package.json": "{}" });
    expect(inspectWranglerConfig(dir, "wrangler.toml")).toEqual({
      name: "boxes",
      vars: ["GREETING", "LIMIT"],
      unsupported: ["containers"],
    });
  });

  it("reads a JSONC config the same way, and nothing for a plain Worker", () => {
    const withTail = project({
      "wrangler.jsonc": `{
        // comment
        "name": "tails",
        "main": "src/index.ts",
        "compatibility_date": "2026-09-01",
        "tail_consumers": [{ "service": "logger" }],
      }`,
    });
    expect(inspectWranglerConfig(withTail, "wrangler.jsonc")).toEqual({
      name: "tails",
      vars: [],
      unsupported: ["tail_consumers"],
    });
    const plain = project({
      "wrangler.json": JSON.stringify({
        name: "plain",
        main: "src/index.ts",
        compatibility_date: "2026-09-01",
        kv_namespaces: [{ binding: "KV" }],
      }),
    });
    expect(inspectWranglerConfig(plain, "wrangler.json")).toMatchObject({ unsupported: [] });
  });

  it("reads a config kept only as a template under its real name", () => {
    const dir = project({ "wrangler.toml.example": TOML });
    expect(inspectWranglerConfig(dir, "wrangler.toml.example")).toMatchObject({
      name: "boxes",
      vars: ["GREETING", "LIMIT"],
    });
  });

  it("prints its answer on one line the sandbox Worker parses", async () => {
    const dir = project({ "wrangler.toml": TOML });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(await main(["inspect", dir, "--config", "wrangler.toml"])).toBe(0);
    const printed = out.join("");
    expect(printed.startsWith(INSPECT_OUTPUT_PREFIX)).toBe(true);
    expect(parseInspectOutput(`wrangler warning\n${printed}`)).toMatchObject({
      name: "boxes",
      unsupported: ["containers"],
    });
  });
});
