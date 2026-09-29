import { type CatalogManifest, catalogWorkerName, type IndexBuild } from "@appflare/schema";
import { Banner } from "@cloudflare/kumo";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { installVarFields } from "../installs/install-vars";
import { baseCatalog } from "../test/artifact-fixture";

// The form only needs the router once a job has started, and the server
// functions once it submits or loads a zone list (effects, which do not run here).
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
// Dashboard links name the account Appflare runs in (the signed-in layout knows it).
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: vi.fn() }));
vi.mock("../installs/source-builds.functions", () => ({ installSourceBuild: vi.fn() }));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
// The address and email pickers load their choices from the account; only
// where the address choice sits matters here, so it is a marker.
vi.mock("./install-domain-fields", () => ({
  InstallDomainFields: () => createElement("div", { "data-address-choice": "" }),
}));
vi.mock("./email-routing-fields", () => ({ EmailRoutingFields: () => null }));

const { InstallForm, installFormNotice } = await import("./install-form");

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
  it("starts with the address, the Worker name and the domain choice, before the app's settings", () => {
    const html = render(
      baseCatalog({
        vars: [{ name: "SITE_TITLE", label: "Site title", default: "My site" }],
      }),
    );
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const workerName = at('aria-label="Worker name"');
    const address = at("data-address-choice");
    const displayName = at(">Name<");
    const secrets = at("Admin password");
    const settings = at("Site title");
    expect(workerName).toBeLessThan(address);
    expect(address).toBeLessThan(displayName);
    expect(displayName).toBeLessThan(secrets);
    expect(secrets).toBeLessThan(settings);
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

describe("placeholders in the install form", () => {
  const catalog = baseCatalog({
    vars: [
      {
        name: "CALLBACK_URL",
        label: "Sign-in callback",
        default: "{{appUrl}}/auth/callback",
      },
      { name: "PREVIEW_HOST", label: "Preview host", default: "{{workerHostname}}" },
    ],
  });

  it("show as chips that say what they become, and never as raw text", () => {
    const html = render(catalog);
    expect(html).toContain("App address");
    expect(html).toContain('data-placeholder="{{appUrl}}"');
    expect(html).toContain('value="/auth/callback"');
    expect(html).not.toContain('value="{{appUrl}}/auth/callback"');
    // Nothing is filled in: the stored value keeps the placeholder.
    expect(html).not.toContain("https://cut.acme.workers.dev/auth/callback");
    expect(html).toContain(">Insert<");
  });

  it("show the workers.dev forms by their own name", () => {
    const html = render(catalog);
    expect(html).toContain('data-placeholder="{{workerHostname}}"');
    expect(html).toContain("workers.dev hostname");
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
