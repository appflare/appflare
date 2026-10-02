import { type CatalogManifest, catalogManifestSchema, type IndexBuild } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessCheck } from "../access/app-access";
import type { CapabilitiesView } from "../capabilities/capabilities";

/**
 * The install form's "Protect with Cloudflare Access". The server functions
 * only exist under the Start Vite plugin; they and the job page navigation
 * are stubbed. The Worker name is fixed so the form needs no name check.
 */
const server = vi.hoisted(() => ({
  startInstall: vi.fn(async (_: unknown) => ({ jobId: "job-1", installId: "install-1" })),
  checkAppAccess: vi.fn<() => Promise<AppAccessCheck>>(),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: server.startInstall }));
vi.mock("../installs/source-builds.functions", () => ({ installSourceBuild: vi.fn() }));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: server.checkAppAccess,
  startAccessChange: vi.fn(),
}));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
// The address choice reads the account's zones; workers.dev only is all this needs.
vi.mock("./install-domain-fields", () => ({ InstallDomainFields: () => null }));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRouting: vi.fn(),
}));

const { InstallForm } = await import("./install-form");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function catalog(access?: { mode?: "required" | "recommended"; bypass?: string[] }) {
  return catalogManifestSchema.parse({
    slug: "links",
    name: "Links",
    summary: "Short links.",
    tagline: "Short links",
    repo: "example/links",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["example"],
    source: { ref: "main", sha: "6056400d47530aa87e4ae5764b37ffca9d00e87f" },
    install: { packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
    plan: "free",
    secrets: [],
    vars: [],
    requires: access?.mode === "required" ? ["access"] : [],
    ...(access === undefined ? {} : { access }),
  });
}

const READY: AppAccessCheck = {
  problem: null,
  users: 3,
  loginMethods: ["One-time PIN (a code sent by email)", "GitHub"],
  oneTimePin: true,
};

const NO_ZERO_TRUST: Pick<CapabilitiesView, "zeroTrust" | "accessServiceTokens"> = {
  zeroTrust: { state: "none" },
  accessServiceTokens: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.startInstall.mockClear();
  server.checkAppAccess.mockReset();
  server.checkAppAccess.mockResolvedValue(READY);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(
  manifest: CatalogManifest,
  extra: {
    capabilities?: Pick<CapabilitiesView, "zeroTrust" | "accessServiceTokens"> | null;
    installer?: IndexBuild | null;
    canInstall?: boolean;
  } = {},
) {
  await act(async () =>
    root.render(
      <InstallForm
        catalog={manifest}
        varFields={[]}
        subdomain="example"
        canInstall={extra.canInstall ?? true}
        defaultWorkerName="links"
        fixedWorkerName
        blockedReason={null}
        requirementsConfirmed
        installer={extra.installer ?? null}
        capabilities={extra.capabilities ?? null}
      />,
    ),
  );
}

function accessBox(): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes("Protect with Cloudflare Access"),
    ) ?? null
  );
}

function installButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Install"),
  );
  if (button === undefined) throw new Error("no Install button");
  return button;
}

async function submit() {
  await act(async () => installButton().click());
}

function sentAccess(): unknown {
  const call = server.startInstall.mock.calls.at(-1)?.[0] as { data: { access?: unknown } };
  return call.data.access;
}

describe("InstallForm, Protect with Cloudflare Access", () => {
  it("starts off for an app that does not ask for it, and says everything asks for a sign-in", async () => {
    await show(catalog());
    const box = accessBox();
    expect(box?.getAttribute("aria-checked")).toBe("false");
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Everything at the app's addresses asks for a sign-in, links you share with others included.",
    );
    expect(text).toContain("Only Appflare's users get in: 3 people, members included.");
    expect(text).toContain("with the email of their Appflare account");
    expect(text).toContain("Login methods: One-time PIN (a code sent by email); GitHub.");
    expect(text).not.toContain("Zero Trust Free covers");
    await submit();
    expect(sentAccess()).toBe(false);
  });

  it("sends the choice once the admin ticks it", async () => {
    await show(catalog());
    // Base UI's checkbox follows its (hidden) native input.
    const input = accessBox()?.closest("label")?.querySelector<HTMLInputElement>("input");
    await act(async () => input?.click());
    expect(accessBox()?.getAttribute("aria-checked")).toBe("true");
    await submit();
    expect(sentAccess()).toBe(true);
  });

  it("starts on for a recommended app and lists what stays public", async () => {
    await show(catalog({ mode: "recommended", bypass: ["/s/*", "/api/webhook"] }));
    expect(accessBox()?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Stays public: /s/*, /api/webhook");
    await submit();
    expect(sentAccess()).toBe(true);
  });

  it("keeps a required app on, fixed, with its reason", async () => {
    await show(catalog({ mode: "required" }));
    const box = accessBox();
    expect(box?.getAttribute("aria-checked")).toBe("true");
    expect(box?.hasAttribute("data-disabled")).toBe(true);
    expect(container.textContent).toContain(
      "Links's catalog entry requires it: the app relies on Cloudflare Access to keep people out.",
    );
    await submit();
    expect(sentAccess()).toBe(true);
  });

  it("is off and disabled while the stored probes show no Zero Trust organization", async () => {
    // The live check has not answered yet.
    server.checkAppAccess.mockReturnValue(new Promise(() => {}));
    await show(catalog({ mode: "recommended" }), { capabilities: NO_ZERO_TRUST });
    const box = accessBox();
    expect(box?.getAttribute("aria-checked")).toBe("false");
    expect(box?.hasAttribute("data-disabled")).toBe(true);
    expect(container.textContent).toContain(
      "This Cloudflare account has no Zero Trust organization",
    );
    const fix = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Zero Trust in Your account",
    );
    expect(fix?.getAttribute("href")).toBe("/settings/account#capability-zero-trust");
    await submit();
    expect(sentAccess()).toBe(false);
  });

  it("follows the live check over stale probes, and points a permission problem at the token", async () => {
    server.checkAppAccess.mockResolvedValue({
      ...READY,
      problem: {
        kind: "tokens-permission",
        message: "The Cloudflare token cannot manage Access service tokens.",
      },
    });
    await show(catalog());
    expect(accessBox()?.hasAttribute("data-disabled")).toBe(true);
    expect(container.textContent).toContain(
      "The Cloudflare token cannot manage Access service tokens.",
    );
    const fix = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Token permissions in Your account",
    );
    expect(fix?.getAttribute("href")).toBe("/settings/account#capability-token-permissions");
  });

  it("holds the install of a required app the account cannot protect", async () => {
    server.checkAppAccess.mockResolvedValue({
      ...READY,
      problem: { kind: "no-organization", message: "No Zero Trust organization." },
    });
    await show(catalog({ mode: "required" }));
    expect(installButton().disabled).toBe(true);
  });

  it("adds one quiet line above Zero Trust Free's 50 users, and none at 50", async () => {
    server.checkAppAccess.mockResolvedValue({ ...READY, users: 50 });
    await show(catalog());
    expect(container.textContent).not.toContain("Zero Trust Free covers");
    act(() => root.unmount());
    root = createRoot(container);
    server.checkAppAccess.mockResolvedValue({ ...READY, users: 51 });
    await show(catalog());
    expect(container.textContent).toContain(
      "Zero Trust Free covers up to 50 users; Appflare has 51.",
    );
  });

  it("asks a sign-in method for any email when One-time PIN is missing", async () => {
    server.checkAppAccess.mockResolvedValue({
      ...READY,
      loginMethods: ["Cloudflare account (members of this Cloudflare account only)"],
      oneTimePin: false,
    });
    await show(catalog());
    expect(container.textContent).toContain(
      "add One-time PIN in the Zero Trust dashboard to let any email in",
    );
  });

  it("shows the server's refusal in the form's error banner", async () => {
    server.startInstall.mockRejectedValueOnce(
      new Error(
        "Links needs Cloudflare Access, which this account cannot provide yet: No Zero Trust organization.",
      ),
    );
    await show(catalog({ mode: "recommended" }));
    await submit();
    expect(container.textContent).toContain(
      "Links needs Cloudflare Access, which this account cannot provide yet",
    );
  });

  it("is not offered for an app deployed by its own installer, and sends nothing", async () => {
    await show(catalog(), {
      installer: { pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f" } as IndexBuild,
    });
    expect(accessBox()).toBeNull();
    expect(container.textContent).not.toContain("Cloudflare Access");
    expect(server.checkAppAccess).not.toHaveBeenCalled();
  });

  it("does not run the admin-only check for a member", async () => {
    await show(catalog(), { canInstall: false });
    expect(server.checkAppAccess).not.toHaveBeenCalled();
    expect(accessBox()?.hasAttribute("data-disabled")).toBe(true);
  });
});
