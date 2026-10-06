import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";
import type { InstallSettings } from "../installs/reconfigure.server";

// Saving needs the router and the server; this test only opens fields.
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/reconfigure.functions", () => ({ startReconfigure: vi.fn() }));
vi.mock("./email-routing-fields", () => ({ EmailRoutingFields: () => null }));

const { AppSettingsSection } = await import("./app-settings-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL = {
  id: "01J00000000000000000000000",
  name: "Counterscale",
  workerName: "counterscale",
  activeJobId: null,
} as InstallDetail;

const SETTINGS: InstallSettings = {
  slug: "counterscale",
  kind: "artifact",
  unavailable: null,
  fields: [],
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
  databases: [
    {
      binding: "DB",
      protocol: "postgres",
      label: "Analytics database",
      fieldLabel: "Analytics database (DB)",
      configName: "counterscale-db",
    },
  ],
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
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AppSettingsSection install={INSTALL} settings={SETTINGS} isAdmin />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (button === undefined) throw new Error(`no "${text}" button`);
  act(() => button.click());
}

/** The text a field's label gives it, hidden words included: its accessible name. */
function labelsOfFields(): string[] {
  return [...container.querySelectorAll("label")].map((l) => l.textContent ?? "");
}

describe("the settings form's new-value fields", () => {
  it("name the secret or database they are for, not only 'New value'", () => {
    click("Set new value");
    click("Replace connection string");
    const labels = labelsOfFields();
    expect(labels).toContain("New value for Analytics API token");
    expect(labels).toContain("New connection string for Analytics database");
  });

  it("show how to create the app's token next to its new value", () => {
    expect(container.innerHTML).not.toContain("data-app-token-help");
    click("Set new value");
    expect(container.innerHTML).toContain("data-app-token-help");
  });
});

describe("secrets of one name that different Workers read", () => {
  it("are listed apart by label, each showing the name its Worker reads", () => {
    const keyed: InstallSettings = {
      ...SETTINGS,
      databases: [],
      appToken: null,
      fixedVars: [{ worker: "github", name: "BASE_URL", value: "{{appUrl}}/gatekeeper/github" }],
      secrets: ["GitHub", "Google"].map((service) => ({
        name: `${service.toUpperCase()}_CLIENT_ID`,
        envName: "CLIENT_ID",
        label: `${service} client ID`,
        generate: undefined,
        declared: true,
        optional: false,
        present: true,
      })),
    };
    act(() => root.render(<AppSettingsSection install={INSTALL} settings={keyed} isAdmin />));
    const toggle = container.querySelector('[role="switch"]');
    if (!(toggle instanceof HTMLElement)) throw new Error("no technical names switch");
    // The vars the catalog entry sets show only with the technical names, read-only.
    expect(container.querySelector("[data-fixed-vars]")).toBeNull();
    act(() => toggle.click());
    const fixed = container.querySelector("[data-fixed-vars]");
    expect(fixed?.textContent).toBe('BASE_URL (Worker "github"): {{appUrl}}/gatekeeper/github');
    expect(fixed?.querySelector("input")).toBeNull();
    const names = [...container.querySelectorAll("[data-technical-name]")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["CLIENT_ID", "CLIENT_ID"]);
    const labels = labelsOfFields().join(" ");
    expect(labels).toContain("GitHub client ID");
    expect(labels).toContain("Google client ID");
    act(() => toggle.click());
  });
});
