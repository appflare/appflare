import { describe, expect, it } from "vitest";
import { strictCatalogManifestSchema } from "../src/catalog.ts";
import { parseJsonc } from "../src/jsonc.ts";
import { migrate } from "./codemod-manifest-v1.mjs";

/** A manifest in the shape before v1, using every field the rewrite changes. */
const old = `{
  "$schema": "https://appflare.github.io/catalog/schema/v1.json",
  "slug": "demo",
  "name": "Demo",
  "summary": "A demo app.",
  "tagline": "Shows every change",
  "homepage": "https://github.com/acme/demo",
  "repo": "acme/demo",
  "license": "AGPL-3.0",
  "categories": ["blogging", "ai"],
  "maintainers": ["acme"],
  "source": { "ref": "v1.0.0", "sha": "${"a".repeat(40)}" },
  "install": {
    "tier": "artifact",
    "packageManager": "pnpm",
    "wranglerConfig": "wrangler.jsonc",
    "workerName": "demo",
    "fixedWorkerName": false,
    "version": "1.2.3",
    // Probed after every update.
    "healthPath": "/health",
    "healthMode": "status-only",
    "wildcardHostname": true,
    "wildcardReason": "Each tunnel has its own name.",
    "installDirs": [{ "path": ".", "lockfile": "required", "devDependencies": true }]
  },
  "plan": "paid",
  "requires": [],
  "secrets": [
    { "name": "ADMIN_PASSWORD", "label": "Admin password", "generate": true },
    { "name": "SESSION_KEY", "label": "Session key", "generate": false, "optional": false },
    { "name": "CF_API_TOKEN", "label": "Cloudflare API token" }
  ],
  "vars": [
    { "name": "BASE_URL", "label": "Address", "default": "{{workerUrl}}" },
    { "name": "TITLE", "label": "Title", "required": true, "type": "text" },
    {
      "name": "THEME",
      "label": "Theme",
      "required": false
    }
  ],
  "postInstall": [{ "type": "markdown", "content": "Open {{workerUrl}}." }],
  "tokenPermissions": [
    { "name": "Zone.DNS:Edit", "scope": "zone", "description": "Writes the records." },
    { "name": "Workers Scripts", "scope": "account" },
    { "name": "Made Up Group", "scope": "account" }
  ],
  "resources": {
    "hyperdrive": [{ "binding": "DB", "protocol": "postgres", "label": "Main database" }],
    "d1": { "DB2": { "migrations": "prisma/migrations/*/migration.sql" } }
  },
  "bump": { "autoMerge": false },
  "revision": 1
}
`;

describe("codemod-manifest-v1", () => {
  const result = migrate(old);
  const parsed = parseJsonc(result.text) as { [key: string]: unknown };

  it("moves every field to its v1 shape", () => {
    expect(parsed).toEqual({
      $schema: "https://appflare.github.io/catalog/schema/v1.json",
      slug: "demo",
      name: "Demo",
      summary: "A demo app.",
      tagline: "Shows every change",
      repo: "acme/demo",
      license: "AGPL-3.0",
      categories: ["cms", "ai"],
      maintainers: ["acme"],
      source: { ref: "v1.0.0", sha: "a".repeat(40), version: "1.2.3" },
      install: {
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        health: { path: "/health", mode: "status-only" },
        wildcardHostname: { reason: "Each tunnel has its own name." },
        installDirs: [{ path: "." }],
      },
      plan: "paid",
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
        { name: "SESSION_KEY", label: "Session key" },
        { name: "CF_API_TOKEN", label: "Cloudflare API token", cloudflareToken: true },
      ],
      vars: [
        { name: "BASE_URL", label: "Address", default: "{{workerUrl}}", optional: true },
        { name: "TITLE", label: "Title" },
        { name: "THEME", label: "Theme", optional: true },
      ],
      postInstall: [{ type: "markdown", content: "Open {{workerUrl}}." }],
      tokenPermissions: [
        { group: "DNS", scope: "zone", reason: "Writes the records.", access: "edit" },
        {
          group: "Workers Scripts",
          scope: "account",
          reason: "TODO: say why the app needs this permission",
          access: "edit",
        },
        { name: "Made Up Group", scope: "account" },
      ],
      resources: {
        hyperdrive: { DB: { protocol: "postgres", label: "Main database" } },
        d1: { DB2: { migrationsGlob: "prisma/migrations/*/migration.sql" } },
      },
    });
  });

  it("keeps comments and one-line objects as they were written", () => {
    expect(result.text).toContain('    // Probed after every update.\n    "health": {');
    expect(result.text).toContain(
      '{ "name": "ADMIN_PASSWORD", "label": "Admin password", "generate": "password" },',
    );
    expect(result.text).toContain('"source": { "ref": "v1.0.0", "sha": ');
  });

  it("says what a person must finish, with the old text of each permission", () => {
    expect(result.todos).toEqual(
      expect.arrayContaining([
        expect.stringContaining('license has "AGPL-3.0", a deprecated SPDX id'),
        expect.stringContaining(
          'tokenPermissions[0] { "name": "Zone.DNS:Edit", "scope": "zone", "description": "Writes the records." } is now zone "DNS" with edit access',
        ),
        expect.stringContaining("(the old default, as it named no level)"),
        expect.stringContaining(
          'tokenPermissions[2] { "name": "Made Up Group", "scope": "account" }: not converted',
        ),
        expect.stringContaining("secrets[2] (CF_API_TOKEN) was marked cloudflareToken by its name"),
      ]),
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('vars[0] (BASE_URL) defaults to "{{workerUrl}}"'),
        expect.stringContaining("postInstall uses {{workerUrl}}"),
      ]),
    );
  });

  it("leaves what the strict schema refuses only where a person must decide", () => {
    const strict = strictCatalogManifestSchema.safeParse(parsed);
    expect(strict.error?.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["license", "tokenPermissions.2.name"]),
    );
    const fixed = {
      ...parsed,
      license: "AGPL-3.0-only",
      tokenPermissions: (parsed.tokenPermissions as unknown[]).slice(0, 2),
    };
    expect(strictCatalogManifestSchema.safeParse(fixed).success).toBe(true);
  });

  it("keeps a default that a comment explains", () => {
    const commented = migrate(
      old.replace(
        '  "requires": [],',
        '  // Nothing to require: the app runs on Workers alone.\n  "requires": [],',
      ),
    );
    expect(commented.text).toContain('"requires": []');
    expect(commented.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("kept requires, which defaults to []")]),
    );
  });
});
