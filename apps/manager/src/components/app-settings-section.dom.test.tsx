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
  placeholders: { workerName: "counterscale", workerUrl: null, wildcardHostname: null },
  secrets: [
    {
      name: "CF_BEARER_TOKEN",
      label: "Analytics API token",
      generate: false,
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
    permissions: [{ name: "Account.Account Analytics:Read", scope: "account" }],
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
