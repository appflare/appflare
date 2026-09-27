import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  configPatchSchema,
  UNSUPPORTED_WRANGLER_SECTION_LABELS,
  UNSUPPORTED_WRANGLER_SECTIONS,
} from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  collectBindings,
  IGNORED_WRANGLER_KEYS,
  PipelineDeclarationError,
  READ_WRANGLER_KEYS,
  type ResolvedWranglerConfig,
  SECTIONS_READ_WITH_CATALOG,
  UnsafeBindingError,
  UnsupportedSectionError,
  unsupportedWranglerSections,
  uploadPlacement,
} from "./wrangler-config.ts";

/**
 * The top-level keys of the wrangler config the installed wrangler knows,
 * from the JSON Schema it ships (`config-schema.json`, `RawConfig`).
 */
function wranglerConfigKeys(): string[] {
  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve("wrangler/package.json"));
  const schema = JSON.parse(readFileSync(path.join(dir, "config-schema.json"), "utf8")) as {
    definitions: { RawConfig: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.definitions.RawConfig.properties);
}

describe("the wrangler config keys the packer knows", () => {
  const read: readonly string[] = READ_WRANGLER_KEYS;
  const ignored = Object.keys(IGNORED_WRANGLER_KEYS);
  const refused: readonly string[] = UNSUPPORTED_WRANGLER_SECTIONS;

  it("reads, ignores or refuses every key of wrangler's config schema", () => {
    // A key wrangler gained since: decide whether the packer reads it,
    // leaves it out on purpose, or refuses it, and list it there.
    const known = new Set([...read, ...ignored, ...refused]);
    expect(wranglerConfigKeys().filter((key) => !known.has(key))).toEqual([]);
  });

  it("lists no key wrangler's config schema does not have", () => {
    const keys = new Set(wranglerConfigKeys());
    expect([...read, ...ignored, ...refused].filter((key) => !keys.has(key))).toEqual([]);
  });

  it("puts each key in one list only", () => {
    const all = [...read, ...ignored, ...refused];
    expect(all.filter((key, i) => all.indexOf(key) !== i)).toEqual([]);
  });
});

describe("collectBindings and the sections it does not read", () => {
  const base = { name: "app", main: "index.js" } as const;

  it("refuses vpc_services, naming the key and how to drop it", () => {
    const config = {
      ...base,
      vpc_services: [{ binding: "LIVEKIT", service_id: "0199" }],
    } as ResolvedWranglerConfig;
    expect(() => collectBindings(config)).toThrow(UnsupportedSectionError);
    expect(() => collectBindings(config)).toThrow(
      'the wrangler config declares vpc_services (Workers VPC services), which Appflare cannot install, so the app would run without it; if the app works without it, drop it with the catalog manifest\'s config patch { "vpc_services": null }',
    );
  });

  it("names every refused section at once", () => {
    const config = {
      ...base,
      tail_consumers: [{ service: "logs" }],
      secrets_store_secrets: [{ binding: "KEY", store_id: "s", secret_name: "k" }],
      media: { binding: "MEDIA" },
    } as ResolvedWranglerConfig;
    expect(() => collectBindings(config)).toThrow(
      /tail_consumers \(Tail Workers\), secrets_store_secrets \(Secrets Store secrets\), media \(Media Transformations\).*\{ "tail_consumers": null, "secrets_store_secrets": null, "media": null \}/,
    );
  });

  it("does not count the empty sections wrangler fills in", () => {
    const config = {
      ...base,
      cloudchamber: {},
      logfwdr: { bindings: [] },
      dispatch_namespaces: [],
      vpc_services: [],
      unsafe: {},
    } as unknown as ResolvedWranglerConfig;
    expect(unsupportedWranglerSections(config)).toEqual([]);
    expect(collectBindings(config)).toEqual([]);
  });

  it("records unsafe rate limits and leaves other unsafe bindings to their own refusal", () => {
    const limit = {
      name: "LIMIT",
      type: "ratelimit",
      namespace_id: "1001",
      simple: { limit: 10, period: 60 },
    };
    const withLimit = { ...base, unsafe: { bindings: [limit] } } as ResolvedWranglerConfig;
    expect(unsupportedWranglerSections(withLimit)).toEqual([]);
    expect(collectBindings(withLimit).map((b) => b.type)).toEqual(["ratelimit"]);
    const other = {
      ...base,
      unsafe: { bindings: [{ name: "X", type: "secret_key" }] },
    } as ResolvedWranglerConfig;
    expect(unsupportedWranglerSections(other)).toEqual(["unsafe"]);
    expect(() => collectBindings(other)).toThrow(UnsafeBindingError);
  });
});

describe("pipelines, refused for a repository but read against the catalog manifest", () => {
  it("is left to the catalog manifest's resources.pipelines", () => {
    const config = {
      name: "app",
      main: "index.js",
      pipelines: [{ binding: "EVENTS", stream: "0199" }],
    } as ResolvedWranglerConfig;
    expect(unsupportedWranglerSections(config)).toEqual(["pipelines"]);
    expect(SECTIONS_READ_WITH_CATALOG).toContain("pipelines");
    expect(() => collectBindings(config)).toThrow(PipelineDeclarationError);
  });
});

describe("dropping a refused section with a config patch", () => {
  it("accepts null for each refused section, unsafe included", () => {
    expect(configPatchSchema.safeParse({ vpc_services: null }).success).toBe(true);
    expect(configPatchSchema.safeParse({ unsafe: null, main: "dist/index.js" }).success).toBe(true);
    for (const key of UNSUPPORTED_WRANGLER_SECTIONS) {
      expect(configPatchSchema.safeParse({ [key]: null }).success).toBe(true);
    }
  });

  it("accepts nothing but null there", () => {
    const result = configPatchSchema.safeParse({ vpc_services: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      "vpc_services may only be null, which drops it: Appflare cannot install it",
    ]);
  });

  it("labels every refused section", () => {
    for (const key of UNSUPPORTED_WRANGLER_SECTIONS) {
      expect(UNSUPPORTED_WRANGLER_SECTION_LABELS[key].length).toBeGreaterThan(0);
    }
  });
});

describe("uploadPlacement", () => {
  it("drops mode off, as wrangler uploads no placement for it", () => {
    expect(uploadPlacement({ mode: "off" })).toBeNull();
    expect(uploadPlacement(undefined)).toBeNull();
    expect(uploadPlacement(null)).toBeNull();
    expect(uploadPlacement({})).toBeNull();
  });

  it("keeps smart placement, with its hint", () => {
    expect(uploadPlacement({ mode: "smart" })).toEqual({ mode: "smart" });
    expect(uploadPlacement({ mode: "smart", hint: "wnam" })).toEqual({
      mode: "smart",
      hint: "wnam",
    });
    // A hint makes it smart, as wrangler reads it, even beside mode off.
    expect(uploadPlacement({ mode: "off", hint: "enam" })).toEqual({ mode: "smart", hint: "enam" });
  });

  it("keeps a targeted placement by region, host or hostname", () => {
    expect(uploadPlacement({ region: "aws:us-east-1" })).toEqual({
      mode: "targeted",
      region: "aws:us-east-1",
    });
    expect(uploadPlacement({ host: "db.example.com:5432" })).toEqual({
      mode: "targeted",
      host: "db.example.com:5432",
    });
    expect(uploadPlacement({ hostname: "api.example.com" })).toEqual({
      mode: "targeted",
      hostname: "api.example.com",
    });
  });
});
