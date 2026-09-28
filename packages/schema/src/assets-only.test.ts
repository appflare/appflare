import { describe, expect, it } from "vitest";
import { artifactManifestSchema } from "./artifact";
import { assetsOnlyWorkerProblems, isAssetsOnlyWorker } from "./assets-only";

const sha256 = "a".repeat(64);
const gitSha = "b".repeat(40);

/** An artifact of one Worker that serves static assets only. */
function staticArtifact(
  worker: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
  catalog: Record<string, unknown> = {},
) {
  return {
    format: 1,
    app: "site",
    version: "1.0.0",
    builtAt: "2026-09-27T12:00:00Z",
    builder: "@appflare/pack@0.3.0",
    keyId: "catalog-2026-09",
    worker: {
      name: "site",
      wranglerConfig: { declared: "wrangler.jsonc", effective: "wrangler.jsonc" },
      compatibilityDate: "2025-06-01",
      compatibilityFlags: [],
      modules: [],
      bindings: [],
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
      ...worker,
    },
    assets: {
      config: { not_found_handling: "single-page-application" },
      binding: null,
      files: [
        {
          route: "/index.html",
          path: "assets/index.html",
          hash: "c".repeat(32),
          size: 1,
          sha256,
          offset: 30,
        },
      ],
    },
    d1: {},
    catalog: {
      slug: "site",
      name: "Site",
      summary: "A static site.",
      tagline: "An app on Workers",
      homepage: "https://github.com/acme/site",
      repo: "acme/site",
      license: "MIT",
      categories: ["utilities"],
      maintainers: ["acme"],
      source: { ref: "v1.0.0", sha: gitSha },
      install: {
        tier: "artifact",
        packageManager: "npm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "site",
        installDirs: [],
      },
      plan: "free",
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
      ...catalog,
    },
    ...more,
  };
}

function messages(json: unknown): string[] {
  const parsed = artifactManifestSchema.safeParse(json);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("artifacts with a Worker of static assets only", () => {
  it("parse without a main module or modules", () => {
    const parsed = artifactManifestSchema.parse(staticArtifact());
    expect(parsed.worker.mainModule).toBeUndefined();
    expect(isAssetsOnlyWorker(parsed.worker)).toBe(true);
  });

  it("refuse bindings, secrets, vars and everything else only code could use", () => {
    expect(
      messages(
        staticArtifact(
          {
            bindings: [{ type: "kv_namespace", name: "CACHE" }],
            crons: ["0 0 * * *"],
            migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
          },
          {},
          {
            secrets: [{ name: "TOKEN", label: "Token", generate: "password" }],
            vars: [{ name: "MODE", label: "Mode", optional: true }],
          },
        ),
      ),
    ).toEqual([
      "The Worker has bindings (CACHE), catalog secrets (TOKEN), catalog vars (MODE), Durable Object migrations, cron triggers, but it has no code of its own (its wrangler config has assets and no main), so nothing could use them; give it a main entrypoint or leave them out.",
    ]);
  });

  it("refuse an assets binding, run_worker_first, and settings wrangler does not send", () => {
    const problems = assetsOnlyWorkerProblems(
      {
        modules: [],
        bindings: [],
        migrations: [],
        crons: [],
        observability: { enabled: true },
        cacheOptions: { enabled: true },
      },
      { binding: "ASSETS", config: { run_worker_first: ["/api/*"] }, files: [] },
      { secrets: [], vars: [] },
    );
    expect(problems).toEqual([
      "The Worker has no code and no static assets, so it would serve nothing.",
      "The Worker has an assets binding (ASSETS), assets.run_worker_first, but it has no code of its own (its wrangler config has assets and no main), so nothing could use them; give it a main entrypoint or leave them out.",
      "The Worker records observability, cacheOptions, but it has no code of its own (its wrangler config has assets and no main), and such a Worker is uploaded without them.",
    ]);
  });

  it("hold the main module and the modules together", () => {
    expect(messages(staticArtifact({ mainModule: "index.js" }))).toEqual([
      "The Worker names the main module index.js but has no modules.",
    ]);
    const module = {
      name: "index.js",
      type: "esm",
      path: "worker/index.js",
      size: 1,
      sha256,
      offset: 0,
    };
    expect(messages(staticArtifact({ modules: [module] }))).toEqual([
      "The Worker has modules but no main module.",
    ]);
  });
});
