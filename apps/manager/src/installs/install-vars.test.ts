import {
  type ArtifactManifest,
  appWorkers,
  type CatalogVar,
  type WorkerBinding,
  workerManifest,
} from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  enteredDerivedVarProblems,
  enteredVarFields,
  type InstallVarField,
  installVarFields,
  missingRequiredVar,
  patchedVars,
  resolveVars,
  settingsVarFields,
  varsNeedRefresh,
  varsUseAccess,
  varsUseAppUrl,
  varsUseWildcardHostname,
  varsUseWorkerUrl,
  varValueProblem,
} from "./install-vars";

function manifest(
  bindings: WorkerBinding[],
  vars: CatalogVar[],
  secrets: string[] = [],
): Pick<ArtifactManifest, "catalog" | "worker"> {
  return {
    worker: { bindings } as ArtifactManifest["worker"],
    catalog: {
      install: {},
      vars,
      secrets: secrets.map((name) => ({ name, label: name })),
    } as ArtifactManifest["catalog"],
  };
}

const v = (name: string, extra: Partial<CatalogVar> = {}): CatalogVar => ({
  name,
  label: name.toLowerCase(),
  optional: true,
  type: "text",
  seedOnly: false,
  ...extra,
});

describe("a derived var", () => {
  const publicKey = v("VAPID_PUBLIC_KEY", {
    derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
  });

  it("is a field that names its source and starts empty, never with the config's value", () => {
    const fields = installVarFields(
      manifest(
        [{ type: "plain_text", name: "VAPID_PUBLIC_KEY", text: "dev-key" }],
        [v("HOME"), publicKey],
      ),
    );
    expect(fields[1]).toMatchObject({
      name: "VAPID_PUBLIC_KEY",
      derivedFrom: "VAPID_PRIVATE_KEY",
      shownDefault: "",
    });
    expect(fields[0]).not.toHaveProperty("derivedFrom");
    expect(enteredVarFields(fields).map((f) => f.name)).toEqual(["HOME"]);
  });

  it("is never taken from a form", () => {
    const fields = installVarFields(manifest([], [v("HOME"), publicKey]));
    expect(enteredDerivedVarProblems(["HOME", "VAPID_PUBLIC_KEY"], fields)).toEqual([
      "VAPID_PUBLIC_KEY is computed from VAPID_PRIVATE_KEY; give VAPID_PRIVATE_KEY a new value instead.",
    ]);
  });

  it("reaches the Worker with the value the install stored", () => {
    const m = manifest(
      [{ type: "plain_text", name: "VAPID_PUBLIC_KEY", text: "dev-key" }],
      [publicKey],
    );
    const placeholders = { workerUrl: null, appUrl: null, workerName: "app" };
    expect(resolveVars(m, { VAPID_PUBLIC_KEY: "BPub" }, placeholders).vars).toEqual([
      { type: "plain_text", name: "VAPID_PUBLIC_KEY", text: "BPub" },
    ]);
  });
});

describe("installVarFields", () => {
  it("shows the catalog default, else the wrangler config's value, and sends only the catalog default", () => {
    const fields = installVarFields(
      manifest(
        [
          { type: "plain_text", name: "REGION", text: "eu" },
          { type: "json", name: "ADDRESSES", json: ["a@example.com"] },
          { type: "json", name: "LIMITS", json: { max: 3 } },
        ],
        [
          v("REGION", { help: "Where it runs." }),
          v("ADDRESSES"),
          v("LIMITS", { default: '{"max":5}' }),
          v("PUBLIC_URL", { default: "{{workerUrl}}", optional: false }),
        ],
      ),
    );
    expect(fields).toEqual([
      {
        name: "REGION",
        label: "region",
        help: "Where it runs.",
        required: false,
        kind: "text",
        shownDefault: "eu",
        options: null,
      },
      {
        name: "ADDRESSES",
        label: "addresses",
        required: false,
        kind: "json",
        shownDefault: '["a@example.com"]',
        options: null,
      },
      {
        name: "LIMITS",
        label: "limits",
        required: false,
        kind: "json",
        shownDefault: '{"max":5}',
        options: null,
      },
      {
        name: "PUBLIC_URL",
        label: "public_url",
        required: true,
        kind: "text",
        shownDefault: "{{workerUrl}}",
        options: null,
      },
    ]);
  });
});

describe("varValueProblem and missingRequiredVar", () => {
  const json: InstallVarField = {
    name: "ADDRESSES",
    label: "Addresses",
    required: true,
    kind: "json",
    shownDefault: "",
    options: null,
  };

  it("checks JSON only for JSON settings and leaves empty values to the required check", () => {
    expect(varValueProblem(json, '["{{workerName}}@example.com"]')).toBeNull();
    expect(varValueProblem(json, "")).toBeNull();
    expect(varValueProblem(json, "a@example.com")).toMatch(/^Addresses is not valid JSON/);
    expect(varValueProblem({ ...json, kind: "text" }, "a@example.com")).toBeNull();
    expect(missingRequiredVar(json, "  ")).toBe(true);
    expect(missingRequiredVar({ ...json, shownDefault: "[]" }, "")).toBe(false);
    expect(missingRequiredVar({ ...json, required: false }, "")).toBe(false);
  });
});

describe("resolveVars", () => {
  it("never sends a var of a secret's name, from the wrangler config or the catalog", () => {
    const m = manifest(
      [
        { type: "plain_text", name: "PASSWORD", text: "change-me" },
        { type: "json", name: "TOKENS", json: ["a"] },
        { type: "plain_text", name: "GREETING", text: "hi" },
      ],
      [v("PASSWORD", { default: "also-me" }), v("GREETING")],
      ["PASSWORD", "TOKENS"],
    );
    expect(
      resolveVars(m, { PASSWORD: "entered" }, { workerUrl: null, appUrl: null, workerName: "app" })
        .vars,
    ).toEqual([{ type: "plain_text", name: "GREETING", text: "hi" }]);
  });

  it("never sends a seed-only var, nor drops a config var for a seed-only secret", () => {
    const m = manifest(
      [{ type: "plain_text", name: "SITE_NAME", text: "Chat" }],
      [v("ADMIN_NAME", { optional: false, seedOnly: true }), v("GREETING", { default: "hi" })],
    );
    m.catalog.secrets.push({
      name: "SITE_NAME",
      label: "x",
      generate: "password",
      seedOnly: true,
      optional: false,
      multiline: false,
      cloudflareToken: false,
    });
    const placeholders = { workerUrl: null, appUrl: null, workerName: "app" };
    expect(resolveVars(m, { ADMIN_NAME: "root", GREETING: "hello" }, placeholders).vars).toEqual([
      { type: "plain_text", name: "SITE_NAME", text: "Chat" },
      { type: "plain_text", name: "GREETING", text: "hello" },
    ]);
    const fields = installVarFields(m);
    expect(fields.map((f) => [f.name, f.seedOnly ?? false])).toEqual([
      ["ADMIN_NAME", true],
      ["GREETING", false],
    ]);
    expect(settingsVarFields(fields).map((f) => f.name)).toEqual(["GREETING"]);
  });

  it("leaves {{workerUrl}} as written while the URL is unknown", () => {
    const m = manifest([{ type: "plain_text", name: "URL", text: "{{workerUrl}}/x" }], []);
    expect(resolveVars(m, {}, { workerUrl: null, appUrl: null, workerName: "app" }).vars).toEqual([
      { type: "plain_text", name: "URL", text: "{{workerUrl}}/x" },
    ]);
  });
});

describe("{{wildcardHostname}}", () => {
  const m = manifest([], [v("TUNNEL_DOMAIN", { default: "{{wildcardHostname}}" })]);

  it("is filled in with the wildcard domain, and empty without one", () => {
    const values = {
      workerUrl: "https://cut.acme.workers.dev",
      appUrl: "https://cut.acme.workers.dev",
      workerName: "cut",
    };
    expect(resolveVars(m, {}, { ...values, wildcardHostname: "tunnels.example.com" }).vars).toEqual(
      [{ type: "plain_text", name: "TUNNEL_DOMAIN", text: "tunnels.example.com" }],
    );
    expect(resolveVars(m, {}, { ...values, wildcardHostname: null }).vars).toEqual([
      { type: "plain_text", name: "TUNNEL_DOMAIN", text: "" },
    ]);
  });

  it("is found in a default or an entered value, not in a fixed one", () => {
    expect(varsUseWildcardHostname(m, {})).toBe(true);
    expect(varsUseWildcardHostname(m, { TUNNEL_DOMAIN: "t.example.org" })).toBe(false);
    const plain = manifest([], [v("BASE")]);
    expect(varsUseWildcardHostname(plain, {})).toBe(false);
    expect(varsUseWildcardHostname(plain, { BASE: "https://{{ wildcardHostname }}" })).toBe(true);
    expect(varsUseWorkerUrl(m, {})).toBe(false);
  });
});

describe("varsUseAccess", () => {
  it("finds the Access placeholders in the wrangler config, a default, or an entered value", () => {
    const own = manifest([{ type: "plain_text", name: "AUD", text: "{{accessAud}}" }], []);
    expect(varsUseAccess(own, {})).toBe(true);
    const json = manifest(
      [{ type: "json", name: "ACCESS", json: { certs: "{{accessCertsUrl}}" } }],
      [],
    );
    expect(varsUseAccess(json, {})).toBe(true);
    const byDefault = manifest([], [v("TEAM", { default: "{{ accessTeamDomain }}" })]);
    expect(varsUseAccess(byDefault, {})).toBe(true);
    expect(varsUseAccess(byDefault, { TEAM: "team.cloudflareaccess.com" })).toBe(false);
    // The team name alone, as an app that builds the team's address itself reads it.
    const teamName = manifest(
      [],
      [v("ACCESS_URL", { default: "https://{{accessTeamName}}.cloudflareaccess.com" })],
    );
    expect(varsUseAccess(teamName, {})).toBe(true);
    expect(varsUseAccess(manifest([], [v("BASE", { default: "{{appUrl}}" })]), {})).toBe(false);
    expect(varsNeedRefresh(byDefault, {}, ["access"])).toBe(true);
    expect(varsNeedRefresh(byDefault, {}, ["appUrl", "wildcardHostname"])).toBe(false);
  });
});

describe("varsUseWorkerUrl", () => {
  it("finds {{workerUrl}} in the wrangler config, a catalog default, or an entered value", () => {
    const own = manifest([{ type: "plain_text", name: "URL", text: "{{workerUrl}}/x" }], []);
    expect(varsUseWorkerUrl(own, {})).toBe(true);
    const json = manifest([{ type: "json", name: "CFG", json: { base: "{{workerUrl}}" } }], []);
    expect(varsUseWorkerUrl(json, {})).toBe(true);
    const byDefault = manifest([], [v("BASE", { default: "{{workerUrl}}" })]);
    expect(varsUseWorkerUrl(byDefault, {})).toBe(true);
    // The admin replaced the default with a fixed address.
    expect(varsUseWorkerUrl(byDefault, { BASE: "https://cut.example.com" })).toBe(false);
    const plain = manifest([], [v("BASE")]);
    expect(varsUseWorkerUrl(plain, {})).toBe(false);
    expect(varsUseWorkerUrl(plain, { BASE: "{{workerUrl}}/api" })).toBe(true);
  });

  it("counts {{workerHostname}}, and not {{workerName}} or the app's address", () => {
    const host = manifest([{ type: "plain_text", name: "HOST", text: "{{workerHostname}}" }], []);
    expect(varsUseWorkerUrl(host, {})).toBe(true);
    const m = manifest([{ type: "plain_text", name: "NAME", text: "{{workerName}}" }], []);
    expect(varsUseWorkerUrl(m, {})).toBe(false);
    const app = manifest([], [v("BASE", { default: "{{appUrl}}" })]);
    expect(varsUseWorkerUrl(app, {})).toBe(false);
  });

  it("finds it in another Worker's own vars, as a config patch sets them", () => {
    const primary = manifest([], []);
    const other = (text: string) => ({
      ...primary,
      workers: [{ worker: { bindings: [{ type: "plain_text", name: "BASE_URL", text }] } }],
    });
    expect(varsUseWorkerUrl(other("{{workerUrl}}/gatekeeper/github"), {})).toBe(true);
    expect(varsUseWorkerUrl(other("{{appUrl}}/gatekeeper/github"), {})).toBe(false);
  });

  it("finds the placeholders in a service binding's props, the primary's or another Worker's", () => {
    const withProps = (text: string) =>
      manifest(
        [{ type: "service", name: "CTX", service: "self", props: { sharingDomain: text } }],
        [],
      );
    expect(varsUseAppUrl(withProps("{{appUrl}}"), {})).toBe(true);
    expect(varsNeedRefresh(withProps("{{appHostname}}"), {}, ["appUrl"])).toBe(true);
    expect(varsUseAppUrl(withProps("https://fixed.example"), {})).toBe(false);
    expect(varsUseWorkerUrl(withProps("{{workerUrl}}"), {})).toBe(true);
    const other = {
      ...manifest([], []),
      workers: [
        {
          worker: {
            bindings: [
              { type: "service", name: "CTX", service: "self", props: { at: "{{workerUrl}}" } },
            ],
          },
        },
      ],
    };
    expect(varsUseWorkerUrl(other, {})).toBe(true);
  });
});

describe("the app's address", () => {
  const served = {
    workerName: "cut",
    workerUrl: "https://cut.acme.workers.dev",
    appUrl: "https://links.example.com",
    accountId: "0123456789abcdef0123456789abcdef",
  };

  it("fills {{appUrl}} and {{appHostname}} with where the app is served, {{workerUrl}} and {{workerHostname}} with workers.dev", () => {
    const m = manifest(
      [],
      [
        v("APP_URL", { default: "{{appUrl}}/auth" }),
        v("APP_HOST", { default: "{{appHostname}}" }),
        v("DEV_URL", { default: "{{workerUrl}}" }),
        v("DEV_HOST", { default: "{{ workerHostname }}" }),
        v("ACCOUNT", { default: "{{accountId}}" }),
        v("NAME", { default: "{{workerName}}" }),
      ],
    );
    expect(resolveVars(m, {}, served).vars).toEqual([
      { type: "plain_text", name: "APP_URL", text: "https://links.example.com/auth" },
      { type: "plain_text", name: "APP_HOST", text: "links.example.com" },
      { type: "plain_text", name: "DEV_URL", text: "https://cut.acme.workers.dev" },
      { type: "plain_text", name: "DEV_HOST", text: "cut.acme.workers.dev" },
      { type: "plain_text", name: "ACCOUNT", text: "0123456789abcdef0123456789abcdef" },
      { type: "plain_text", name: "NAME", text: "cut" },
    ]);
  });

  it("fills JSON vars inside every string", () => {
    const m = manifest(
      [{ type: "json", name: "ORIGINS", json: ["{{appUrl}}", "{{workerUrl}}"] }],
      [],
    );
    expect(resolveVars(m, {}, served).vars).toEqual([
      {
        type: "json",
        name: "ORIGINS",
        json: ["https://links.example.com", "https://cut.acme.workers.dev"],
      },
    ]);
  });

  it("is found by varsUseAppUrl in a default, the wrangler config or an entered value", () => {
    expect(varsUseAppUrl(manifest([], [v("BASE", { default: "{{appUrl}}" })]), {})).toBe(true);
    expect(varsUseAppUrl(manifest([], [v("HOST", { default: "{{appHostname}}" })]), {})).toBe(true);
    const own = manifest([{ type: "json", name: "CFG", json: { base: "{{appUrl}}" } }], []);
    expect(varsUseAppUrl(own, {})).toBe(true);
    const plain = manifest([], [v("BASE")]);
    expect(varsUseAppUrl(plain, {})).toBe(false);
    expect(varsUseAppUrl(plain, { BASE: "{{appUrl}}/api" })).toBe(true);
    // The workers.dev address does not follow a domain.
    expect(varsUseAppUrl(manifest([], [v("BASE", { default: "{{workerUrl}}" })]), {})).toBe(false);
  });

  it("is found in the per-Worker form that names the primary Worker only", () => {
    const entry = (text: string) => {
      const m = manifest([], [v("BASE", { default: text })]);
      m.catalog.install.workers = [
        { name: "web", wranglerConfig: "web/wrangler.jsonc", primary: true, workersDev: true },
        { name: "api", wranglerConfig: "api/wrangler.jsonc", primary: false, workersDev: true },
      ];
      return m;
    };
    expect(varsUseAppUrl(entry("{{appUrl:web}}"), {})).toBe(true);
    expect(varsUseAppUrl(entry("{{appHostname:web}}"), {})).toBe(true);
    expect(varsUseAppUrl(entry("{{appUrl:api}}"), {})).toBe(false);
    expect(varsUseWorkerUrl(entry("{{workerUrl:web}}"), {})).toBe(true);
    expect(varsUseWorkerUrl(entry("{{workerUrl:api}}"), {})).toBe(false);
  });

  it("asks for a refresh only for the values that changed", () => {
    const m = manifest([], [v("BASE", { default: "{{appUrl}}" })]);
    expect(varsNeedRefresh(m, {}, ["appUrl"])).toBe(true);
    expect(varsNeedRefresh(m, {}, ["wildcardHostname"])).toBe(false);
    expect(varsNeedRefresh(m, {}, ["wildcardHostname", "appUrl"])).toBe(true);
    expect(varsNeedRefresh(m, {}, [])).toBe(false);
  });
});

describe("select vars", () => {
  const options = [
    { value: "default", label: "Landing page" },
    { value: "404", label: "Not found" },
    { value: "admin", label: "Admin sign-in" },
  ];
  const home = (extra: Partial<CatalogVar> = {}) =>
    v("HOME_PAGE", { type: "select", options, ...extra });
  const placeholders = { workerUrl: null, appUrl: null, workerName: "cut" };

  it("carry their choices, and start with the wrangler config's value only when it is one", () => {
    const fields = installVarFields(
      manifest(
        [
          { type: "plain_text", name: "HOME_PAGE", text: "admin" },
          { type: "plain_text", name: "OTHER", text: "home" },
        ],
        [home(), v("OTHER", { type: "select", options })],
      ),
    );
    expect(fields.map((f) => [f.shownDefault, f.options])).toEqual([
      ["admin", options],
      ["", options],
    ]);
    expect(installVarFields(manifest([], [home({ default: "404" })]))[0]?.shownDefault).toBe("404");
  });

  it("refuse a value that is not one of the choices", () => {
    const [field] = installVarFields(manifest([], [home({ optional: false })]));
    if (field === undefined) throw new Error("no field");
    expect(varValueProblem(field, "404")).toBeNull();
    expect(varValueProblem(field, "home")).toBe(
      "home_page must be one of: Landing page, Not found, Admin sign-in.",
    );
    expect(varValueProblem(field, "")).toBeNull();
    expect(missingRequiredVar(field, "")).toBe(true);
  });

  it("send the stored choice, or the default when this version no longer offers it", () => {
    const m = manifest(
      [{ type: "plain_text", name: "HOME_PAGE", text: "default" }],
      [home({ default: "404" })],
    );
    expect(resolveVars(m, { HOME_PAGE: "admin" }, placeholders)).toEqual({
      vars: [{ type: "plain_text", name: "HOME_PAGE", text: "admin" }],
      warnings: [],
    });
    const gone = resolveVars(m, { HOME_PAGE: "home" }, placeholders);
    expect(gone.vars).toEqual([{ type: "plain_text", name: "HOME_PAGE", text: "404" }]);
    expect(gone.warnings).toEqual([
      "The stored value of HOME_PAGE is not one of the choices this version of the app offers; the Worker gets the catalog default instead.",
    ]);
  });

  it("send JSON choices as JSON", () => {
    const m = manifest(
      [{ type: "json", name: "OPEN", json: false }],
      [
        v("OPEN", {
          type: "select",
          options: [
            { value: "true", label: "Open" },
            { value: "false", label: "Closed" },
          ],
        }),
      ],
    );
    expect(resolveVars(m, { OPEN: "true" }, placeholders).vars).toEqual([
      { type: "json", name: "OPEN", json: true },
    ]);
  });
});

describe("resolveVars for an app of several Workers", () => {
  it("drops a var only on the Worker that gets the secret of its name", () => {
    const secretVar: WorkerBinding = { type: "plain_text", name: "SESSION", text: "dev" };
    const app = {
      format: 2,
      worker: { bindings: [secretVar] },
      assets: {},
      workers: [{ name: "jobs", worker: { bindings: [secretVar] }, assets: {} }],
      catalog: {
        install: {
          workers: [
            { name: "web", wranglerConfig: "web/wrangler.jsonc", primary: true },
            { name: "jobs", wranglerConfig: "jobs/wrangler.jsonc" },
          ],
        },
        secrets: [{ name: "SESSION", label: "Session", generate: "password", workers: ["web"] }],
        vars: [],
      },
    } as unknown as ArtifactManifest;
    const placeholders = { workerUrl: null, appUrl: null, workerName: "duo" };
    const [web, jobs] = appWorkers(app);
    if (web === undefined || jobs === undefined) throw new Error("two Workers expected");
    expect(resolveVars(workerManifest(app, web), {}, placeholders).vars).toEqual([]);
    expect(resolveVars(workerManifest(app, jobs), {}, placeholders).vars).toEqual([secretVar]);
  });
});

describe("patchedVars", () => {
  it("lists the vars each Worker's config patch sets, not the ones it removes", () => {
    expect(
      patchedVars({
        install: {
          workers: [
            { name: "router" },
            { name: "github", configPatch: { vars: { BASE_URL: "{{appUrl}}/gk", OLD: null } } },
          ],
        },
      }),
    ).toEqual([{ worker: "github", name: "BASE_URL", value: "{{appUrl}}/gk" }]);
    expect(patchedVars({ install: { configPatch: { vars: { A: "1" } } } })).toEqual([
      { worker: null, name: "A", value: "1" },
    ]);
  });
});
