import { type CatalogManifest, catalogManifestSchema, type IndexBuild } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVarFields } from "../installs/install-vars";

/**
 * The install form of an app that deploys itself: the install's stage,
 * known before it starts, filled into the entry's help, each address named
 * after it offered to copy, and the install id sent back. The server
 * functions only exist under the Start Vite plugin; they are stubbed.
 */
const server = vi.hoisted(() => ({
  startInstall: vi.fn(async (_: unknown) => ({ jobId: "job-1", installId: "install-1" })),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: server.startInstall }));
vi.mock("../installs/source-builds.functions", () => ({ installSourceBuild: vi.fn() }));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: vi.fn(),
  startAccessChange: vi.fn(),
}));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
vi.mock("../installs/custom-domains.functions", () => ({ checkInstallHostname: vi.fn() }));
vi.mock("./install-address-field", () => ({ InstallAddressField: () => null }));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRouting: vi.fn(),
}));

const { InstallForm } = await import("./install-form");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL_ID = "01JZ8Q4W3M5N6P7R8S9T0V1X2Y";
const STAGE = "appflare-9t0v1x2y";
const CALLBACK = `https://void-${STAGE}-api.acme.workers.dev/auth/callback`;

const BUILD: IndexBuild = {
  pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f",
  manifest: "https://appflare.github.io/catalog/apps/void/appflare.json",
  manifestDigest: "a".repeat(64),
  expectedMinutes: 10,
};

function catalog(): CatalogManifest {
  const command = (...words: string[]) => ["pnpm", "exec", "void", "platform", ...words];
  return catalogManifestSchema.parse({
    slug: "void",
    name: "Void",
    summary: "An app platform.",
    tagline: "Your own app platform",
    repo: "example/void-installer",
    license: "MIT",
    categories: ["developer-tools"],
    maintainers: ["example"],
    source: { ref: "main", sha: BUILD.pin },
    install: {
      tier: "self-deploying",
      packageManager: "pnpm",
      selfDeploying: {
        tool: "void",
        discoverCommand: command("discover", "--installation", "{{stage}}"),
        installCommand: command("install", "--yes", "--name", "{{stage}}"),
        resumeCommand: command("install", "--yes", "--name", "{{stage}}", "--resume"),
        updateCommand: command("upgrade", "{{stage}}", "--yes"),
        destroyCommand: command("uninstall", "{{stage}}", "--yes"),
        workerNames: ["void-{{stage}}-api"],
      },
    },
    plan: "paid",
    requires: ["workers-for-platforms"],
    secrets: [],
    vars: [
      {
        name: "VOID_PLATFORM_GITHUB_CLIENT_ID",
        label: "GitHub OAuth client id",
        help: "Create a GitHub OAuth app with the callback URL https://void-{{stage}}-api.{{workersDevSubdomain}}.workers.dev/auth/callback, then paste its client id.",
      },
    ],
    tokenPermissions: [
      { group: "Workers Scripts", scope: "account", access: "edit", reason: "Deploys Void." },
    ],
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.startInstall.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(subdomain: string | null = "acme", installId: string | null = INSTALL_ID) {
  const manifest = catalog();
  await act(async () =>
    root.render(
      <InstallForm
        catalog={manifest}
        varFields={installVarFields({ catalog: manifest, worker: { bindings: [] } })}
        subdomain={subdomain}
        canInstall
        defaultWorkerName="void"
        fixedWorkerName={false}
        blockedReason={null}
        requirementsConfirmed
        installer={BUILD}
        installId={installId}
        accountPlan="paid"
      />,
    ),
  );
}

function input(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((l) =>
    l.textContent?.includes(label),
  );
  const id = found?.getAttribute("for");
  const el = id === null || id === undefined ? null : container.querySelector(`[id="${id}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no field "${label}"`);
  return el;
}

function type(label: string, value: string) {
  const el = input(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the install form of an app that deploys itself", () => {
  it("names the install's stage and the first Worker before the install starts", async () => {
    await show();
    expect(container.textContent).toContain(
      `Void's installer names its Workers after this install's stage, ${STAGE} (void-${STAGE}-api)`,
    );
  });

  it("fills the stage into the help and offers the address it names to copy", async () => {
    await show();
    expect(container.textContent).toContain(`with the callback URL ${CALLBACK}, then paste`);
    const copy = container.querySelector("[data-installer-addresses]");
    expect(copy?.textContent).toContain("This address, filled in for this install:");
    expect(copy?.textContent).toContain(CALLBACK);
    expect(copy?.querySelector("button")).not.toBeNull();
  });

  it("offers nothing to copy while the workers.dev subdomain is not known", async () => {
    await show(null);
    expect(container.querySelector("[data-installer-addresses]")).toBeNull();
    expect(container.textContent).toContain(`void-${STAGE}-api.{{workersDevSubdomain}}`);
  });

  it("sends the install id whose stage it showed", async () => {
    await show();
    type("Cloudflare API token for Void", "app-token");
    type("GitHub OAuth client id", "Iv1.abc");
    // Base UI's checkbox follows its (hidden) native input.
    const confirm = container.querySelector<HTMLInputElement>(
      'fieldset[aria-label="Plan and cost"] input[type="checkbox"]',
    );
    await act(async () => confirm?.click());
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Install"),
    );
    expect(container.querySelector("[data-install-readiness]")?.textContent).toContain(
      "Installs Void",
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(server.startInstall).toHaveBeenCalledTimes(1);
    expect(server.startInstall.mock.calls[0]?.[0]).toMatchObject({
      data: { slug: "void", installId: INSTALL_ID, appToken: "app-token" },
    });
  });
});
