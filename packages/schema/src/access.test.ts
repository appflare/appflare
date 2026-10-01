import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACCESS_BYPASS_PATH_PATTERN,
  ACCESS_PLACEHOLDER_SOURCE,
  accessBypassPathProblem,
  accessBypassPaths,
  accessOfferOf,
  catalogAccessSchema,
  MAX_ACCESS_BYPASS_PATHS,
  usesAccessPlaceholders,
} from "./access";
import { catalogManifestSchema, requirementSchema, strictCatalogManifestSchema } from "./catalog";

const manifest = {
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  tagline: "Short links on your own domain",
  repo: "MendyLanda/cut",
  license: "MIT",
  categories: ["utilities"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: { packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
  plan: "free",
};

const selfDeployingInstall = {
  tier: "self-deploying",
  packageManager: "pnpm",
  wranglerConfig: "wrangler.jsonc",
  selfDeploying: {
    tool: "alchemy",
    deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
    destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
    workerNames: ["app-{{stage}}"],
  },
};

describe("the access block", () => {
  it("is optional, and without it protection is offered, switched off", () => {
    const parsed = catalogManifestSchema.parse(manifest);
    expect(parsed.access).toBeUndefined();
    expect(accessOfferOf(parsed)).toBe("offered");
    expect(accessBypassPaths(parsed)).toEqual([]);
  });

  it("takes a mode and public paths", () => {
    const parsed = strictCatalogManifestSchema.parse({
      ...manifest,
      requires: ["access"],
      access: { mode: "required", bypass: ["/s/*", "/.well-known/*", "/api/webhook"] },
    });
    expect(accessOfferOf(parsed)).toBe("required");
    expect(accessBypassPaths(parsed)).toEqual(["/s/*", "/.well-known/*", "/api/webhook"]);
    expect(
      accessOfferOf(catalogManifestSchema.parse({ ...manifest, access: { mode: "recommended" } })),
    ).toBe("recommended");
    // A block with public paths only: offered, off by default.
    expect(
      accessOfferOf(catalogManifestSchema.parse({ ...manifest, access: { bypass: ["/s/*"] } })),
    ).toBe("offered");
  });

  it("refuses an unknown mode, an empty or too long list, and a path listed twice", () => {
    expect(catalogAccessSchema.safeParse({ mode: "always" }).success).toBe(false);
    expect(catalogAccessSchema.safeParse({ bypass: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_ACCESS_BYPASS_PATHS + 1 }, (_, i) => `/p${i}`);
    expect(catalogAccessSchema.safeParse({ bypass: many }).success).toBe(false);
    const twice = catalogAccessSchema.safeParse({ bypass: ["/s/*", "/S/*"] });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]?.message).toBe("/S/* is listed twice");
  });

  it('needs "access" in requires for a required mode or an Access placeholder in a default', () => {
    const required = catalogManifestSchema.safeParse({ ...manifest, access: { mode: "required" } });
    expect(required.success).toBe(false);
    expect(required.error?.issues[0]?.path).toEqual(["requires"]);
    const placeholder = catalogManifestSchema.safeParse({
      ...manifest,
      vars: [{ name: "AUD", label: "Audience", default: "{{ accessAud }}" }],
    });
    expect(placeholder.success).toBe(false);
    expect(placeholder.error?.issues[0]?.path).toEqual(["vars", 0, "default"]);
    for (const entry of [
      { ...manifest, requires: ["access"], access: { mode: "required" } },
      {
        ...manifest,
        requires: ["access"],
        vars: [{ name: "A", label: "A", default: "{{accessAud}}" }],
      },
      { ...manifest, access: { mode: "recommended", bypass: ["/s/*"] } },
    ]) {
      expect(catalogManifestSchema.safeParse(entry).success).toBe(true);
    }
    expect(usesAccessPlaceholders("x {{accessCertsUrl}}")).toBe(true);
    expect(usesAccessPlaceholders("{{appUrl}}")).toBe(false);
  });

  it('is hidden by an index schema that does not know the "access" requirement', () => {
    // What a manager from before the requirement does with the index row.
    const older = z.array(requirementSchema.exclude(["access"]));
    expect(older.safeParse(["access"]).success).toBe(false);
    expect(requirementSchema.safeParse("access").success).toBe(true);
  });

  it("is refused on the self-deploying tier", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...manifest,
      plan: "paid",
      install: selfDeployingInstall,
      requires: ["access"],
      access: { mode: "required" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["access", "requires"]),
    );
  });

  it("is stripped, not refused, by a schema that does not know it", () => {
    // What a manager from before the block does with a newer catalog: its
    // schemas strip keys they do not know (only authoring is strict).
    const parsed = catalogManifestSchema.safeParse({ ...manifest, laterField: { x: 1 } });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("laterField");
  });
});

describe("accessBypassPathProblem", () => {
  it("accepts a path and a path with everything under it", () => {
    for (const path of ["/s/*", "/api/webhook", "/.well-known/*", "/a-b_c.d~e/f@g:h+i=j,k"]) {
      expect(accessBypassPathProblem(path)).toBeNull();
      expect(new RegExp(ACCESS_BYPASS_PATH_PATTERN).test(path)).toBe(true);
    }
  });

  it("refuses what Access would not match as written, or what opens the whole app", () => {
    const cases: Array<[string, string]> = [
      ["s/*", 'must start with "/"'],
      ["/", "whole app public"],
      ["/*", "whole app public"],
      ["/s?x=1", "without a query"],
      ["/s#top", "fragment"],
      ["/s/*/x", "one wildcard only"],
      ["/s*", "one wildcard only"],
      ["/*/x", "one wildcard only"],
      ["/s/", 'must not end in "/"'],
      ["/a//b", '"//"'],
      ["/a/../b", '".."'],
      ["/a b", "letters, digits"],
      ["/%2e", "letters, digits"],
      [`/${"a".repeat(200)}`, "at most 128"],
    ];
    for (const [path, message] of cases) {
      expect(accessBypassPathProblem(path), path).toContain(message);
      // The pattern cannot say everything; the ones it passes are caught in words.
      if (path !== "/a/../b" && path.length <= 128) {
        expect(new RegExp(ACCESS_BYPASS_PATH_PATTERN).test(path), path).toBe(false);
      }
    }
  });
});

describe("the JSON Schema", () => {
  const json = JSON.parse(
    readFileSync(new URL("../json-schema/v1.json", import.meta.url), "utf8"),
  ) as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
    allOf: unknown[];
  };

  it("describes the block, its pattern and limits, and refuses it on the self-deploying tier", () => {
    const access = json.properties.access;
    expect(access?.properties?.bypass).toMatchObject({
      maxItems: MAX_ACCESS_BYPASS_PATHS,
      uniqueItems: true,
      items: { pattern: ACCESS_BYPASS_PATH_PATTERN },
    });
    const selfDeploying = json.allOf[0] as { anyOf: Array<{ not?: { anyOf: unknown[] } }> };
    expect(selfDeploying.anyOf[1]?.not?.anyOf).toContainEqual({ required: ["access"] });
    // The two requirement rules: a required mode, and an Access placeholder in a default.
    const text = JSON.stringify(json.allOf);
    expect(text).toContain('"mode":{"const":"required"}');
    expect(text).toContain(JSON.stringify(ACCESS_PLACEHOLDER_SOURCE));
  });
});
