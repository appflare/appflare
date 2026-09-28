import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";
import type { InstallSettings } from "../installs/reconfigure.server";

// Saving needs the router and the server; these tests only look at the form.
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/reconfigure.functions", () => ({ startReconfigure: vi.fn() }));
vi.mock("./email-routing-fields", () => ({ EmailRoutingFields: () => null }));

const { AppSettingsSection, settingsNotice } = await import("./app-settings-section");

const INSTALL = {
  id: "01J00000000000000000000000",
  name: "Counterscale",
  workerName: "counterscale",
  activeJobId: null,
} as InstallDetail;

function settings(overrides: Partial<InstallSettings> = {}): InstallSettings {
  return {
    slug: "counterscale",
    kind: "artifact",
    unavailable: null,
    fields: [
      {
        name: "CF_ACCOUNT_ID",
        label: "Account ID",
        required: true,
        kind: "text",
        shownDefault: "{{accountId}}",
        options: null,
        stored: null,
      },
    ],
    placeholders: {
      workerName: "counterscale",
      workerUrl: null,
      appUrl: null,
      wildcardHostname: null,
    },
    secrets: [
      {
        name: "CF_BEARER_TOKEN",
        label: "Analytics API token",
        generate: undefined,
        declared: true,
        optional: false,
        present: true,
      },
    ],
    databases: [],
    canRemoveSecrets: true,
    email: null,
    skipsPreview: null,
    installer: null,
    appToken: {
      secret: "CF_BEARER_TOKEN",
      permissions: [
        { group: "Account Analytics", scope: "account", access: "read", reason: "Reads visits." },
      ],
    },
    ...overrides,
  };
}

function render(s: InstallSettings, isAdmin = true, install = INSTALL): string {
  return renderToStaticMarkup(createElement(AppSettingsSection, { install, settings: s, isAdmin }));
}

describe("the app's settings form", () => {
  it("does not show how to create the app's token until its secret gets a new value", () => {
    const html = render(settings());
    expect(html).toContain("Analytics API token");
    expect(html).toContain("Set new value");
    expect(html).not.toContain("data-app-token-help");
    expect(html).not.toContain("Create token");
  });

  it("keeps how to create the token for an app that takes it in its own setup steps", () => {
    const html = render(
      settings({
        slug: "unifi-ddns",
        fields: [],
        secrets: [],
        appToken: {
          secret: null,
          permissions: [
            { group: "DNS", scope: "zone", access: "edit", reason: "Updates records." },
          ],
        },
      }),
    );
    expect(html).toContain("Cloudflare token for Counterscale");
    expect(html).toContain("data-app-token-help");
    expect(html).toContain("Create token");
    expect(html).toContain("Permissions it needs (1)");
    // The token form opens on the account Appflare runs in.
    expect(html).toContain("accountId=0123456789abcdef0123456789abcdef");
    expect(html).not.toContain("accountId=%2A");
  });

  it("offers R2's own token, in this account, for an app whose token needs R2 Data Catalog", () => {
    const html = render(
      settings({
        fields: [],
        secrets: [],
        appToken: {
          secret: null,
          permissions: [
            {
              group: "Workers R2 Data Catalog",
              scope: "account",
              access: "edit",
              reason: "Writes the table.",
            },
          ],
        },
      }),
    );
    expect(html).toContain(
      "https://dash.cloudflare.com/?to=/0123456789abcdef0123456789abcdef/r2/api-tokens",
    );
  });

  it("names what a new secret value also updates, in plain words", () => {
    const html = render(
      settings({
        secrets: [
          {
            name: "CF_PASSWORD",
            label: "Dashboard password",
            generate: undefined,
            declared: true,
            optional: false,
            present: true,
            derives: ["CF_PASSWORD_HASH"],
            derivesLabels: ["Dashboard password hash"],
          },
        ],
      }),
    );
    expect(html).toContain(
      "A new value also updates Dashboard password hash, which Appflare works out from it.",
    );
  });

  it("shows labels only, and the placeholder as a chip that keeps its text", () => {
    const html = render(settings());
    expect(html).not.toContain("(CF_BEARER_TOKEN)");
    expect(html).not.toContain(">CF_BEARER_TOKEN<");
    expect(html).toContain('data-placeholder="{{accountId}}"');
    expect(html).toContain("Show technical names");
  });

  it("carries at most one notice at the top", () => {
    expect(settingsNotice(false, true, "Gone")).toBe("members");
    expect(settingsNotice(true, true, "Gone")).toBe("busy");
    expect(settingsNotice(true, false, "Gone")).toBe("unavailable");
    expect(settingsNotice(true, false, null)).toBe(null);
    const busy = render(settings({ unavailable: "Not now." }), true, {
      ...INSTALL,
      activeJobId: "job",
    } as InstallDetail);
    expect(busy).toContain("A job of this app is running");
    expect(busy).not.toContain("Not now.");
    expect(render(settings(), false)).toContain("Only admins can change settings.");
  });
});
