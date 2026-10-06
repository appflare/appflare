import { describe, expect, it } from "vitest";
import { accessPlaceholderValues } from "../../access/placeholder-values.server";
import { buildArtifactFixture } from "../../test/artifact-fixture";
import {
  buildScriptMetadata,
  durableObjectMigrations,
  installVars,
  selfServiceUploadBinding,
  uploadModule,
} from "./metadata";

describe("installVars", () => {
  const worker = {
    workerName: "cut-2",
    subdomain: "acme",
    accountId: "0123456789abcdef0123456789abcdef",
  };

  it("fills in the Access values of a protected install, and empty ones otherwise", async () => {
    const f = await buildArtifactFixture({
      bindings: [{ type: "plain_text", name: "POLICY_AUD", text: "{{accessAud}}" }],
      catalog: {
        vars: [
          { name: "TEAM_DOMAIN", label: "Team", default: "https://{{accessTeamDomain}}" },
          { name: "CERTS", label: "Keys", default: "{{accessCertsUrl}}" },
        ],
        requires: ["access"],
      },
    });
    const access = accessPlaceholderValues({
      teamDomain: "acme.cloudflareaccess.com",
      aud: "aud-123",
    });
    expect(installVars(f.manifest, {}, { ...worker, access }).vars).toEqual([
      { type: "plain_text", name: "POLICY_AUD", text: "aud-123" },
      { type: "plain_text", name: "TEAM_DOMAIN", text: "https://acme.cloudflareaccess.com" },
      {
        type: "plain_text",
        name: "CERTS",
        text: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
      },
    ]);
    // Not protected: empty, so an app that checks them refuses everyone.
    expect(
      installVars(f.manifest, {}, worker).vars.map((v) => v.type === "plain_text" && v.text),
    ).toEqual(["", "https://", ""]);
  });

  it("fills in {{accountId}} in the wrangler config's vars, catalog defaults and entered values", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "plain_text", name: "CF_ACCOUNT_ID", text: "{{accountId}}" },
        { type: "json", name: "ANALYTICS", json: { account: "{{ accountId }}" } },
      ],
      catalog: {
        vars: [
          {
            name: "NUXT_CF_ACCOUNT_ID",
            label: "Account",
            default: "{{accountId}}",
          },
          { name: "API_BASE", label: "API", optional: true },
        ],
      },
    });
    const resolved = installVars(
      f.manifest,
      { API_BASE: "https://api.cloudflare.com/client/v4/accounts/{{accountId}}" },
      worker,
    );
    expect(resolved.vars).toEqual([
      { type: "plain_text", name: "CF_ACCOUNT_ID", text: worker.accountId },
      { type: "json", name: "ANALYTICS", json: { account: worker.accountId } },
      { type: "plain_text", name: "NUXT_CF_ACCOUNT_ID", text: worker.accountId },
      {
        type: "plain_text",
        name: "API_BASE",
        text: `https://api.cloudflare.com/client/v4/accounts/${worker.accountId}`,
      },
    ]);
  });

  it("uses the user's value, else the catalog default, else the recorded var; blanks are omitted", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "plain_text", name: "HOME_PAGE", text: "recorded" },
      ],
      catalog: {
        vars: [
          { name: "HOME_PAGE", label: "Home", optional: true },
          { name: "GREETING", label: "Greeting", default: "hi", optional: true },
          { name: "EMPTY", label: "Empty", optional: true },
        ],
      },
    });
    expect(installVars(f.manifest, { HOME_PAGE: "admin", EMPTY: "" }, worker).vars).toEqual([
      { type: "plain_text", name: "MODE", text: "prod" },
      { type: "plain_text", name: "HOME_PAGE", text: "admin" },
      { type: "plain_text", name: "GREETING", text: "hi" },
    ]);
    expect(installVars(f.manifest, {}, worker).vars).toEqual([
      { type: "plain_text", name: "MODE", text: "prod" },
      { type: "plain_text", name: "HOME_PAGE", text: "recorded" },
      { type: "plain_text", name: "GREETING", text: "hi" },
    ]);
  });

  it("keeps non-string vars as JSON and fills in {{workerUrl}} and {{workerName}} everywhere", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "json", name: "EMAIL_ADDRESSES", json: [] },
        { type: "json", name: "LIMITS", json: { origin: "{{workerUrl}}", max: 3 } },
        { type: "plain_text", name: "SELF", text: "{{workerName}}" },
      ],
      catalog: {
        vars: [
          { name: "PUBLIC_URL", label: "URL", default: "{{workerUrl}}", optional: true },
          {
            name: "EMAIL_ADDRESSES",
            label: "Addresses",
            default: '["{{workerName}}@example.com"]',
            optional: true,
          },
        ],
      },
    });
    expect(installVars(f.manifest, {}, worker)).toEqual({
      fill: expect.any(Function),
      vars: [
        { type: "json", name: "EMAIL_ADDRESSES", json: ["cut-2@example.com"] },
        {
          type: "json",
          name: "LIMITS",
          json: { origin: "https://cut-2.acme.workers.dev", max: 3 },
        },
        { type: "plain_text", name: "SELF", text: "cut-2" },
        { type: "plain_text", name: "PUBLIC_URL", text: "https://cut-2.acme.workers.dev" },
      ],
      warnings: [],
    });
    // What the admin entered is JSON too, and takes placeholders.
    expect(
      installVars(
        f.manifest,
        { EMAIL_ADDRESSES: '["a@example.com", "{{workerName}}@example.org"]' },
        worker,
      ).vars[0],
    ).toEqual({
      type: "json",
      name: "EMAIL_ADDRESSES",
      json: ["a@example.com", "cut-2@example.org"],
    });
  });

  it("falls back to the default when a stored value is not JSON for a var this version reads as JSON", async () => {
    // The admin's value was entered while ADDRESSES was a text var; this version reads JSON.
    const stored = { ADDRESSES: "a@example.com" };
    const withDefault = await buildArtifactFixture({
      bindings: [{ type: "json", name: "ADDRESSES", json: ["upstream@example.com"] }],
      catalog: {
        vars: [
          {
            name: "ADDRESSES",
            label: "Addresses",
            default: '["{{workerName}}@example.com"]',
            optional: true,
          },
        ],
      },
    });
    expect(installVars(withDefault.manifest, stored, worker)).toEqual({
      fill: expect.any(Function),
      vars: [{ type: "json", name: "ADDRESSES", json: ["cut-2@example.com"] }],
      warnings: [
        "The stored value of ADDRESSES is not valid JSON, but this version of the app reads ADDRESSES as JSON; the Worker gets the catalog default instead.",
      ],
    });
    const withoutDefault = await buildArtifactFixture({
      bindings: [{ type: "json", name: "ADDRESSES", json: ["upstream@example.com"] }],
      catalog: { vars: [{ name: "ADDRESSES", label: "Addresses", optional: true }] },
    });
    const resolved = installVars(withoutDefault.manifest, stored, worker);
    expect(resolved.vars).toEqual([
      { type: "json", name: "ADDRESSES", json: ["upstream@example.com"] },
    ]);
    expect(resolved.warnings).toEqual([
      expect.stringMatching(/the Worker gets the wrangler config's value instead\.$/),
    ]);
    // A value the admin edited into valid JSON is used as is, without a warning.
    expect(installVars(withDefault.manifest, { ADDRESSES: '["b@example.com"]' }, worker)).toEqual({
      fill: expect.any(Function),
      vars: [{ type: "json", name: "ADDRESSES", json: ["b@example.com"] }],
      warnings: [],
    });
  });
});

describe("buildScriptMetadata", () => {
  it("fills binding ids from created resources and adds vars and assets", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
        { type: "r2_bucket", name: "FILES" },
        { type: "queue", name: "Q", delivery_delay: 5 },
        { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "json", name: "ADDRESSES", json: ["recorded"] },
      ],
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.assets.binding = "ASSETS";
        m.assets.config = { not_found_handling: "single-page-application" };
        m.worker.observability = { enabled: true };
      },
    });
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [
        { binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv-id" },
        { binding: "DB", type: "d1", name: "cut-db", cfId: "d1-uuid" },
        { binding: "FILES", type: "r2_bucket", name: "cut-files", cfId: "cut-files" },
        { binding: "Q", type: "queue", name: "cut-q", cfId: "queue-id" },
      ],
      vars: [
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
        { type: "json", name: "ADDRESSES", json: [] },
      ],
      assetsJwt: "completion-jwt",
      workflowNames: { JOBS: "cut-jobs" },
    });
    expect(metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-id" },
        { type: "d1", name: "DB", id: "d1-uuid" },
        { type: "r2_bucket", name: "FILES", bucket_name: "cut-files" },
        { type: "queue", name: "Q", queue_name: "cut-q", delivery_delay: 5 },
        { type: "workflow", name: "JOBS", workflow_name: "cut-jobs", class_name: "JobWorkflow" },
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
        // Vars come from `vars` only, never also as recorded.
        { type: "json", name: "ADDRESSES", json: [] },
        { type: "assets", name: "ASSETS" },
      ],
      assets: { jwt: "completion-jwt", config: { not_found_handling: "single-page-application" } },
      observability: { enabled: true },
    });
    expect(metadata.keep_bindings).toBeUndefined();
  });

  it("passes Images and send_email restrictions through, and rate limits with the install's own id", async () => {
    const passthrough = [
      {
        type: "ratelimit",
        name: "LIMITER",
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      },
      { type: "images", name: "IMAGES" },
      {
        type: "send_email",
        name: "EMAIL",
        allowed_destination_addresses: ["owner@example.com"],
        allowed_sender_addresses: ["app@example.com"],
      },
      { type: "send_email", name: "ADMIN", destination_address: "admin@example.com" },
    ];
    const f = await buildArtifactFixture({ bindings: passthrough });
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [],
      vars: [],
      assetsJwt: null,
      rateLimitIds: { LIMITER: "734112" },
    });
    expect(metadata.bindings).toEqual([
      { ...passthrough[0], namespace_id: "734112" },
      ...passthrough.slice(1),
    ]);
    // Never the artifact's id, which other Workers in the account may share.
    expect(() =>
      buildScriptMetadata({
        manifest: f.manifest,
        workerName: "cut",
        resources: [],
        vars: [],
        assetsJwt: null,
      }),
    ).toThrow(/LIMITER has no namespace of its own/);
  });

  it("points a service binding to the app's own Worker at the install's Worker", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "service", name: "WORKER_SELF_REFERENCE", service: "self" },
        { type: "service", name: "JOBS", service: "self", entrypoint: "Jobs" },
      ],
    });
    // The artifact was built as "cut"; this install runs as "mail-2".
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "mail-2",
      resources: [],
      vars: [],
      assetsJwt: null,
    });
    expect(metadata.bindings).toEqual([
      { type: "service", name: "WORKER_SELF_REFERENCE", service: "mail-2" },
      { type: "service", name: "JOBS", service: "mail-2", entrypoint: "Jobs" },
    ]);
  });

  it("never uploads a service binding to another Worker, even one that slipped past the plan", async () => {
    for (const binding of [
      { type: "service", name: "SELF", service: "appflare", entrypoint: "JobUnits" },
      { type: "service", name: "ENV", service: "self", environment: "staging" },
    ]) {
      const f = await buildArtifactFixture({ bindings: [binding] });
      expect(() =>
        buildScriptMetadata({
          manifest: f.manifest,
          workerName: "cut",
          resources: [],
          vars: [],
          assetsJwt: null,
        }),
      ).toThrow(`service binding ${binding.name} does not point at the app's own Worker`);
    }
    expect(() =>
      selfServiceUploadBinding({ type: "service", name: "X", service: "other" }, "cut"),
    ).toThrow(/does not point at the app's own Worker/);
  });

  it("sends a service binding's props with the placeholders filled in, as the vars get them", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "service", name: "SELF", service: "self", props: { at: "{{appUrl}}/x", n: 1 } },
      ],
    });
    const vars = installVars(
      f.manifest,
      {},
      {
        workerName: "cut",
        subdomain: "acct",
        accountId: "a1",
        appUrl: "https://links.example.com",
      },
    );
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [],
      vars: vars.vars,
      fill: vars.fill,
      assetsJwt: null,
    });
    expect(metadata.bindings).toContainEqual({
      type: "service",
      name: "SELF",
      service: "cut",
      props: { at: "https://links.example.com/x", n: 1 },
    });
    // Never sent unfilled.
    expect(() =>
      buildScriptMetadata({
        manifest: f.manifest,
        workerName: "cut",
        resources: [],
        vars: [],
        assetsJwt: null,
      }),
    ).toThrow("service binding SELF has props, but no placeholder values");
  });

  it("sends assets without a binding when the app has none, and nothing when there are no assets", async () => {
    const f = await buildArtifactFixture();
    const withAssets = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: [],
      assetsJwt: "jwt",
    });
    expect(withAssets.assets).toEqual({ jwt: "jwt", config: {} });
    expect(withAssets.bindings?.some((b) => b.type === "assets")).toBe(false);
    const none = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: [],
      assetsJwt: null,
    });
    expect(none.assets).toBeUndefined();
  });

  it("sends a Worker of static assets only what wrangler sends: assets and compatibility, no main module", async () => {
    const f = await buildArtifactFixture({
      assetsOnly: true,
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.assets.config = { not_found_handling: "single-page-application" };
      },
    });
    const input = { manifest: f.manifest, workerName: "cut", resources: [], vars: [] };
    expect(buildScriptMetadata({ ...input, assetsJwt: "jwt" })).toEqual({
      assets: { jwt: "jwt", config: { not_found_handling: "single-page-application" } },
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
    });
    expect(() => buildScriptMetadata({ ...input, assetsJwt: null })).toThrow(
      /serves static assets only, but no assets were uploaded/,
    );
    expect(() =>
      buildScriptMetadata({
        ...input,
        vars: [{ type: "plain_text", name: "MODE", text: "prod" }],
        assetsJwt: "jwt",
      }),
    ).toThrow(/cannot have bindings or vars/);
  });

  it("sends the assets directory's _redirects and _headers in assets.config, as wrangler does", async () => {
    const rules = {
      not_found_handling: "404-page",
      _redirects: "/old /new 301\n",
      _headers: "/*\n  X-Frame-Options: DENY\n",
    };
    const withCode = await buildArtifactFixture({
      bindings: [],
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.assets.config = { ...rules };
      },
    });
    const assetsOnly = await buildArtifactFixture({
      assetsOnly: true,
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.assets.config = { ...rules };
      },
    });
    for (const f of [withCode, assetsOnly]) {
      const metadata = buildScriptMetadata({
        manifest: f.manifest,
        workerName: "cut",
        resources: [],
        vars: [],
        assetsJwt: "jwt",
      });
      expect(metadata.assets).toEqual({ jwt: "jwt", config: rules });
    }
  });

  it("refuses a resource binding that was not created", async () => {
    const f = await buildArtifactFixture();
    expect(() =>
      buildScriptMetadata({
        manifest: f.manifest,
        workerName: "cut",
        resources: [],
        vars: [],
        assetsJwt: null,
      }),
    ).toThrow(/CUT_KV \(kv_namespace\) has no created resource/);
  });

  it("sends Durable Object migrations the way wrangler does for a new script", () => {
    expect(durableObjectMigrations([])).toBeUndefined();
    expect(
      durableObjectMigrations([
        { tag: "v1", new_sqlite_classes: ["Room"] },
        { tag: "v2", renamed_classes: [{ from: "Room", to: "Chat" }] },
      ]),
    ).toEqual({
      new_tag: "v2",
      steps: [
        { new_sqlite_classes: ["Room"] },
        { renamed_classes: [{ from: "Room", to: "Chat" }] },
      ],
    });
  });

  it("sends exports and cache_options, and a Worker Loader as recorded", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "worker_loader", name: "LOADER" },
      ],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Legacy"] }],
      catalog: { plan: "paid" },
      exports: { Api: { type: "worker", cache: { enabled: true } } },
      cacheOptions: { enabled: true, cross_version_cache: false },
    });
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: [],
      assetsJwt: null,
    });
    expect(metadata.exports).toEqual({ Api: { type: "worker", cache: { enabled: true } } });
    expect(metadata.cache_options).toEqual({ enabled: true, cross_version_cache: false });
    expect(metadata.bindings).toContainEqual({ type: "worker_loader", name: "LOADER" });
    // Entrypoint exports alone leave migrations as they are.
    expect(metadata.migrations).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["Legacy"] }],
    });
  });

  it("sends no migrations when exports declare Durable Objects, as wrangler does", async () => {
    const f = await buildArtifactFixture({
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
      exports: { Room: { type: "durable-object", storage: "sqlite" } },
    });
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      workerName: "cut",
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: [],
      assetsJwt: null,
    });
    expect(metadata.exports).toEqual({ Room: { type: "durable-object", storage: "sqlite" } });
    expect(metadata.migrations).toBeUndefined();
    expect(metadata.cache_options).toBeUndefined();
  });

  it("gives module parts wrangler's content types", () => {
    const bytes = new Uint8Array([1]);
    expect(uploadModule({ name: "a.js", type: "esm" }, bytes).contentType).toBe(
      "application/javascript+module",
    );
    expect(uploadModule({ name: "a.bin", type: "data" }, bytes).contentType).toBe(
      "application/octet-stream",
    );
  });
});
