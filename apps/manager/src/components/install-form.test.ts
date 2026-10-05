import { type CatalogManifest, catalogWorkerName, type IndexBuild } from "@appflare/schema";
import { Banner } from "@cloudflare/kumo";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type InstallVarField, installVarFields } from "../installs/install-vars";
import { baseCatalog } from "../test/artifact-fixture";

// The form only needs the router once a job has started, and the server
// functions once it submits or loads a zone list (effects, which do not run here).
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
// Dashboard links name the account Appflare runs in (the signed-in layout knows it).
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: vi.fn() }));
vi.mock("../installs/source-builds.functions", () => ({ installSourceBuild: vi.fn() }));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
vi.mock("../installs/custom-domains.functions", () => ({ checkInstallHostname: vi.fn() }));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: vi.fn(),
  startAccessChange: vi.fn(),
}));
// The address and email pickers load their choices from the account; only
// where the address choice sits matters here, so it is a marker.
vi.mock("./install-address-field", () => ({
  InstallAddressField: () => createElement("div", { "data-address-choice": "" }),
}));
vi.mock("./email-routing-fields", () => ({ EmailRoutingFields: () => null }));

const { InstallForm, installFormNotice, filledByAppflare, installFooterLine } = await import(
  "./install-form"
);

type Props = Parameters<typeof InstallForm>[0];

function render(catalog: CatalogManifest, props: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(InstallForm, {
      catalog,
      varFields: installVarFields({
        catalog,
        worker: { bindings: [] },
      } as unknown as Parameters<typeof installVarFields>[0]),
      subdomain: "acme",
      canInstall: true,
      defaultWorkerName: catalogWorkerName(catalog),
      fixedWorkerName: false,
      blockedReason: null,
      requirementsConfirmed: true,
      ...props,
    }),
  );
}

/** The class list Kumo gives a banner's container, to count banners in a form. */
const BANNER_CLASS = /class="([^"]+)"/.exec(
  renderToStaticMarkup(createElement(Banner, { title: "x", variant: "secondary" })),
)?.[1];

function bannerCount(html: string): number {
  return html.split(`class="${BANNER_CLASS}"`).length - 1;
}

const ANALYTICS_TOKEN: CatalogManifest["tokenPermissions"] = [
  {
    group: "Account Analytics",
    scope: "account",
    access: "read",
    reason: "Read visits through the Analytics Engine SQL API.",
  },
];

describe("the install form's notices", () => {
  it("carries at most one banner, at the top, even when a member opens a blocked app", () => {
    expect(BANNER_CLASS).toBeTruthy();
    const html = render(baseCatalog(), {
      canInstall: false,
      blockedReason: 'Cut is already installed as "cut".',
    });
    expect(bannerCount(html)).toBe(1);
    expect(html).toContain("Cut is already installed");
    expect(html).not.toContain("Only admins can install apps.");
    expect(bannerCount(render(baseCatalog()))).toBe(0);
    expect(bannerCount(render(baseCatalog(), { canInstall: false }))).toBe(1);
  });

  it("prefers the reason the app cannot be installed over the members' note", () => {
    expect(installFormNotice(true, null)).toBe(null);
    expect(installFormNotice(false, null)?.title).toBe("Only admins can install apps.");
    expect(
      installFormNotice(false, "Blocked", { href: "/onboarding#sandbox", label: "Fix it" }),
    ).toEqual({ title: "Blocked", link: { href: "/onboarding#sandbox", label: "Fix it" } });
  });

  it("has no banner for a build in the sandbox Worker, only a quiet confirmation", () => {
    const build: IndexBuild = {
      pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f",
      expectedMinutes: 5,
      instanceType: "standard-1",
    } as IndexBuild;
    const html = render(baseCatalog(), { sandboxBuild: build });
    expect(bannerCount(html)).toBe(0);
    expect(html).toContain("Build it in my sandbox Worker");
  });
});

describe("the install form's order", () => {
  const catalog = baseCatalog({
    secrets: [
      { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
      { name: "SMTP_PASSWORD", label: "Mail password", optional: true },
    ],
    vars: [
      { name: "SITE_TITLE", label: "Site title", default: "My site" },
      { name: "ALLOWED_ORIGINS", label: "Allowed origins" },
    ],
  });
  const html = render(catalog);
  const at = (needle: string) => {
    const i = html.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("starts with the address, in a panel of its own, then what the app needs", () => {
    const panel = at("data-address-panel");
    const address = at("data-address-choice");
    const needs = at("What Cut needs");
    expect(panel).toBeLessThan(address);
    expect(address).toBeLessThan(needs);
    // A secret it must have and a setting with no default are asked up front.
    expect(needs).toBeLessThan(at("Admin password"));
    expect(at("Admin password")).toBeLessThan(at("Allowed origins"));
  });

  it("folds the name, optional secrets and settings with a default into Optional settings", () => {
    const fold = at("Optional settings");
    expect(html).toMatch(/Optional settings <span[^>]*>\(3\)/);
    expect(at("Allowed origins")).toBeLessThan(fold);
    expect(fold).toBeLessThan(at(">Name in Appflare<"));
    expect(fold).toBeLessThan(at("Mail password"));
    expect(fold).toBeLessThan(at("Site title"));
    // Closed, it names what is inside.
    expect(html).toContain("Name in Appflare, Mail password and Site title");
  });

  it("keeps an optional secret to one field, with no switch to set it", () => {
    expect(html).not.toContain("Set it now");
    // The one switch left is "Show technical names".
    expect(html.split('role="switch"').length - 1).toBe(1);
    expect(html).toMatch(/Mail password.*\(optional\)/);
  });

  it("puts the technical names switch in the header, away from the fields", () => {
    expect(at("Show technical names")).toBeLessThan(at("data-address-panel"));
  });

  it("says in its footer what is left before Install", () => {
    expect(html).toContain('data-install-readiness="blocked"');
    expect(html).toContain("To install, fill in Allowed origins.");
    expect(html).toContain("1 of 2 left to fill in");
  });
});

describe("the install form's labels", () => {
  const catalog = baseCatalog({
    vars: [{ name: "SITE_TITLE", label: "Site title", default: "My site" }],
  });

  it("show labels only, with the technical names behind a switch", () => {
    const html = render(catalog);
    expect(html).toContain("Admin password");
    expect(html).toContain("Site title");
    expect(html).not.toContain("(ADMIN_PASSWORD)");
    expect(html).not.toContain("(SITE_TITLE)");
    expect(html).not.toContain(">SITE_TITLE<");
    expect(html).toContain("Show technical names");
  });

  it("mark optional fields with a quiet suffix", () => {
    const html = render(
      baseCatalog({
        vars: [{ name: "FOOTER", label: "Footer text", optional: true }],
      }),
    );
    expect(html).toMatch(/Footer text.*\(optional\)/);
  });
});

describe("settings Appflare fills in", () => {
  const catalog = baseCatalog({
    vars: [
      {
        name: "CALLBACK_URL",
        label: "Sign-in callback",
        default: "{{appUrl}}/auth/callback",
      },
      { name: "PREVIEW_HOST", label: "Preview host", default: "{{workerHostname}}" },
      { name: "SITE_TITLE", label: "Site title", default: "My site" },
    ],
  });

  it("are not asked: the install keeps their defaults, and the app's page shows them", () => {
    const html = render(catalog);
    expect(html).not.toContain("Sign-in callback");
    expect(html).not.toContain("Preview host");
    expect(html).not.toContain("data-placeholder");
    expect(html).toContain("Site title");
  });

  it("are the derived ones and those whose default holds a placeholder, never a seed-only one", () => {
    expect(filledByAppflare({ shownDefault: "{{accountId}}" }, [])).toBe(true);
    expect(filledByAppflare({ shownDefault: "https://{{accessTeamDomain}}" }, [])).toBe(true);
    expect(filledByAppflare({ shownDefault: "", derivedFrom: "SESSION" }, [])).toBe(true);
    expect(filledByAppflare({ shownDefault: "cloudflare_access" }, [])).toBe(false);
    expect(filledByAppflare({ shownDefault: "{{appUrl}}", seedOnly: true }, [])).toBe(false);
  });
});

describe("the app's own Cloudflare token", () => {
  it("is explained next to the secret that takes it, not above the form", () => {
    const catalog = baseCatalog({
      tokenPermissions: ANALYTICS_TOKEN,
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
        { name: "CF_API_TOKEN", label: "Analytics API token", cloudflareToken: true },
      ],
    });
    const html = render(catalog);
    const help = html.indexOf("data-app-token-help");
    expect(help).toBeGreaterThan(html.indexOf("Analytics API token"));
    expect(help).toBeGreaterThan(html.indexOf("Admin password"));
    expect(html.split("data-app-token-help").length - 1).toBe(1);
    expect(html).toContain("Create token");
    expect(html).not.toContain("Add by hand");
  });

  it("is explained next to a self-deploying app's token field", () => {
    const catalog = baseCatalog({
      tokenPermissions: [
        { group: "Workers Scripts", scope: "account", access: "edit", reason: "Deploys the app." },
      ],
      secrets: [],
      vars: [],
    });
    const build = { pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f" } as IndexBuild;
    const html = render(catalog, { installer: build });
    const field = html.indexOf("Cloudflare API token for Cut");
    const help = html.indexOf("data-app-token-help");
    expect(field).toBeGreaterThan(-1);
    expect(help).toBeGreaterThan(field);
    expect(html.slice(field, help)).not.toContain("<fieldset");
  });

  it("is not shown for an app that needs no token of its own", () => {
    expect(render(baseCatalog())).not.toContain("data-app-token-help");
  });
});

describe("links beside the fields", () => {
  const link = (path: string) => ({ label: `Get ${path}`, url: `https://example.org/${path}` });
  const html = render(
    baseCatalog({
      secrets: [
        { name: "API_KEY", label: "API key", help: "The key.", link: link("api") },
        { name: "SESSION", label: "Session key", generate: "password", link: link("session") },
        { name: "EXTRA", label: "Extra key", optional: true, link: link("extra") },
      ],
      vars: [{ name: "MODEL", label: "Model", default: "small", link: link("model") }],
    }),
  );

  it("follow the help of every kind of field, up front and folded, opening in a new tab", () => {
    for (const path of ["api", "session", "extra", "model"]) {
      expect(html).toMatch(
        new RegExp(`<a[^>]*href="https://example.org/${path}"[^>]*target="_blank"`),
      );
      expect(html).toContain(`Get ${path}`);
    }
    // The generated secret's link sits in its help, apart from the badge's refresh button.
    expect(html.indexOf("Get session")).toBeGreaterThan(html.indexOf("Session key"));
    // The optional ones are in the fold.
    expect(html.indexOf("Get extra")).toBeGreaterThan(html.indexOf("Optional settings"));
    expect(html.indexOf("Get model")).toBeGreaterThan(html.indexOf("Optional settings"));
  });
});

describe("what holds the install", () => {
  const prefill = (vars: Record<string, string>) => ({
    replaces: "old",
    workerName: "cut",
    displayName: "",
    vars,
    access: false,
    domain: null,
    emailZoneId: null,
  });
  const field = (over: Partial<InstallVarField> & { name: string; label: string }) => ({
    required: false,
    kind: "text" as const,
    shownDefault: "",
    options: null,
    ...over,
  });

  it("names a setting whose value cannot be used, and Install stays off", () => {
    const html = render(baseCatalog(), {
      varFields: [field({ name: "RULES", label: "Rules", kind: "json", shownDefault: "[]" })],
      prefill: prefill({ RULES: "{not json" }),
    });
    expect(html).toContain('data-install-readiness="blocked"');
    expect(html).toContain("To install Cut again, fix Rules.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Install again/);
    // The fold holds it, so it is open.
    expect(html).toMatch(/data-fold[^>]*>.*?aria-expanded="true"/s);
  });

  it("names a required setting emptied in the fold, which opens", () => {
    const html = render(baseCatalog(), {
      varFields: [field({ name: "MODE", label: "Mode", required: true, shownDefault: "fast" })],
      prefill: prefill({ MODE: "" }),
    });
    expect(html).toContain("fix Mode");
    expect(html).toMatch(/data-fold[^>]*>.*?aria-expanded="true"/s);
  });

  it("shows a setting Appflare fills in when an install made again changed it", () => {
    const callback = field({
      name: "CALLBACK",
      label: "Sign-in callback",
      shownDefault: "{{appUrl}}/cb",
    });
    expect(render(baseCatalog(), { varFields: [callback] })).not.toContain("Sign-in callback");
    const html = render(baseCatalog(), {
      varFields: [callback],
      prefill: prefill({ CALLBACK: "https://login.example.org/cb" }),
    });
    expect(html).toContain("Sign-in callback");
    expect(html).toMatch(/data-fold[^>]*>.*?aria-expanded="true"/s);
  });
});

describe("the footer's line", () => {
  it("puts again after the app's name when installing again", () => {
    expect(installFooterLine({ again: true, appName: "Memory Note", blocker: null })).toEqual({
      ready: true,
      text: "Installs Memory Note again",
    });
    expect(
      installFooterLine({ again: true, appName: "Memory Note", blocker: "fill in API key" }),
    ).toEqual({ ready: false, text: "To install Memory Note again, fill in API key." });
  });

  it("reads plainly for a new install", () => {
    expect(installFooterLine({ again: false, appName: "Cut", blocker: null })).toEqual({
      ready: true,
      text: "Installs Cut",
    });
    expect(installFooterLine({ again: false, appName: "Cut", blocker: "fix Rules" }).text).toBe(
      "To install, fix Rules.",
    );
  });

  it("names the address after the app on Install again", () => {
    const html = render(baseCatalog(), {
      prefill: {
        replaces: "old",
        workerName: "cut",
        displayName: "",
        vars: {},
        access: false,
        domain: null,
        emailZoneId: null,
      },
    });
    expect(html).toContain('data-install-readiness="ready"');
    expect(html).toMatch(
      /Installs Cut again at <span[^>]*>https:\/\/cut\.acme\.workers\.dev<\/span>\./,
    );
    expect(html).not.toContain("Installs again");
  });
});
