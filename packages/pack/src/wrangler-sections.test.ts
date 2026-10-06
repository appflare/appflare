import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  configPatchSchema,
  UNSUPPORTED_WRANGLER_SECTION_LABELS,
  UNSUPPORTED_WRANGLER_SECTIONS,
} from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  AllowedSectionError,
  allowedSections,
  collectBindings,
  GENERATED_WRANGLER_KEYS,
  IGNORED_WRANGLER_KEYS,
  PipelineDeclarationError,
  READ_WRANGLER_KEYS,
  type ResolvedWranglerConfig,
  refuseUnknownWranglerKeys,
  SECTIONS_READ_WITH_CATALOG,
  UnknownWranglerKeyError,
  UnsafeBindingError,
  UnsupportedSectionError,
  unknownWranglerKeys,
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

describe("keys the packer does not know", () => {
  it("lets through every key it reads, ignores, refuses, or a build writes", () => {
    const raw = Object.fromEntries(
      [
        ...READ_WRANGLER_KEYS,
        ...Object.keys(IGNORED_WRANGLER_KEYS),
        ...UNSUPPORTED_WRANGLER_SECTIONS,
        ...Object.keys(GENERATED_WRANGLER_KEYS),
      ].map((key) => [key, {}]),
    );
    expect(unknownWranglerKeys(raw)).toEqual([]);
  });

  it("knows every key wrangler's reader adds to a config it resolves", () => {
    // A build writes the config it resolved (the Cloudflare Vite plugin does),
    // these keys included; the packer must not mistake them for the app's.
    const schemaKeys = new Set(wranglerConfigKeys());
    const resolved = unstable_readConfig({
      config: path.resolve(import.meta.dirname, "..", "fixtures", "hello", "wrangler.jsonc"),
    });
    const added = Object.keys(resolved).filter((key) => !schemaKeys.has(key));
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((key) => !Object.hasOwn(GENERATED_WRANGLER_KEYS, key))).toEqual([]);
  });

  it("finds keys wrangler 4.136.2 does not know, such as k2 and analytics from 4.147", () => {
    const raw = {
      name: "app",
      main: "src/index.ts",
      k2: [{ binding: "STREAM" }],
      analytics: { binding: "SQL" },
      // Declares nothing, so nothing would be dropped.
      later: null,
    };
    expect(unknownWranglerKeys(raw)).toEqual(["k2", "analytics"]);
    expect(() => refuseUnknownWranglerKeys(raw, "apps/api/wrangler.jsonc", "4.136.2")).toThrow(
      UnknownWranglerKeyError,
    );
    expect(() => refuseUnknownWranglerKeys(raw, "apps/api/wrangler.jsonc", "4.136.2")).toThrow(
      'the wrangler config apps/api/wrangler.jsonc sets "k2" and "analytics", which the packer does not know: ' +
        "wrangler 4.136.2, which it builds with, would drop them with no more than a warning, and the app would " +
        "run without them. A key wrangler added since needs a newer Appflare that reads or refuses it; if the app " +
        'works without them, drop them with the catalog manifest\'s config patch { "k2": null, "analytics": null }',
    );
  });

  it("passes an unknown key a Vite-written config fills with an empty list or object", () => {
    const raw = { name: "app", main: "index.js", k2: [], analytics: {}, later: { items: [] } };
    expect(unknownWranglerKeys(raw)).toEqual([]);
    expect(unknownWranglerKeys({ ...raw, k2: [{ binding: "STREAM" }] })).toEqual(["k2"]);
  });

  it("does not look inside an environment, which the packer never builds", () => {
    expect(unknownWranglerKeys({ name: "app", env: { production: { k2: [] } } })).toEqual([]);
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

  it("refuses mTLS certificates, which an artifact cannot bring, naming how to drop them", () => {
    const config = {
      ...base,
      mtls_certificates: [{ binding: "CERT", certificate_id: "0199" }],
    } as unknown as ResolvedWranglerConfig;
    expect(unsupportedWranglerSections(config)).toEqual(["mtls_certificates"]);
    expect(() => collectBindings(config)).toThrow(
      'the wrangler config declares mtls_certificates (mTLS certificates), which Appflare cannot install, so the app would run without it; if the app works without it, drop it with the catalog manifest\'s config patch { "mtls_certificates": null }',
    );
  });

  it("lets a config patch drop mTLS certificates", () => {
    expect(configPatchSchema.safeParse({ mtls_certificates: null }).success).toBe(true);
    expect(configPatchSchema.safeParse({ mtls_certificates: [] }).success).toBe(false);
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

describe("containers, refused unless the pack allows them", () => {
  const config = {
    name: "app",
    main: "index.js",
    containers: [{ class_name: "Sandbox", image: "docker.io/example/app:1.0.0" }],
    durable_objects: { bindings: [{ name: "Sandbox", class_name: "Sandbox" }] },
  } as unknown as ResolvedWranglerConfig;

  it("refuses containers by default, as for any catalog entry", () => {
    expect(unsupportedWranglerSections(config)).toEqual(["containers"]);
    expect(() => collectBindings(config)).toThrow(
      /the wrangler config declares containers \(Containers\), which Appflare cannot install/,
    );
  });

  it("leaves allowed sections out without refusing the config", () => {
    const bindings = collectBindings(config, undefined, { allowSections: ["containers"] });
    expect(bindings.map((b) => [b.type, b.name])).toEqual([
      ["durable_object_namespace", "Sandbox"],
    ]);
  });

  it("still refuses a section the pack does not allow", () => {
    const both = { ...config, tail_consumers: [{ service: "logs" }] } as ResolvedWranglerConfig;
    expect(() => collectBindings(both, undefined, { allowSections: ["containers"] })).toThrow(
      /declares tail_consumers \(Tail Workers\), which/,
    );
  });
});

describe("allowedSections", () => {
  it("accepts refused sections, once each", () => {
    expect(allowedSections([])).toEqual([]);
    expect(allowedSections(["containers", "tail_consumers", "containers"])).toEqual([
      "containers",
      "tail_consumers",
    ]);
  });

  it("refuses a key the packer does not refuse", () => {
    expect(() => allowedSections(["container"])).toThrow(AllowedSectionError);
    expect(() => allowedSections(["kv_namespaces"])).toThrow(
      /"kv_namespaces" is not a wrangler config section the packer refuses/,
    );
  });

  it("refuses the sections read against the catalog manifest", () => {
    for (const key of SECTIONS_READ_WITH_CATALOG) {
      expect(() => allowedSections([key])).toThrow(
        `${key} cannot be allowed: the packer reads it against the catalog manifest and refuses only what it cannot carry`,
      );
    }
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
