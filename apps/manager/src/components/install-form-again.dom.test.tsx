import { catalogManifestSchema } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessCheck } from "../access/app-access";
import { type InstallFormPrefill, SECRETS_AGAIN_NOTE } from "../installs/install-again";
import { HOSTNAME_CHECK_DELAY_MS } from "../installs/install-hostname-check";
import { WORKER_NAME_CHECK_DELAY_MS } from "../installs/worker-name-check";

/**
 * The install form on "Install again": it starts from the failed install's
 * choices, counts the Worker name the removal frees as free, says secrets
 * are entered again, and sends what it replaces. Server functions and the
 * job page navigation are stubbed.
 */
const server = vi.hoisted(() => ({
  startInstall: vi.fn(async (_: unknown) => ({ jobId: "job-1", installId: "install-1" })),
  installSourceBuild: vi.fn(async (_: unknown) => ({ jobId: "job-2", installId: "install-2" })),
  // As the server answers: the replaced install's names are left out for it.
  listTakenWorkerNames: vi.fn(async (args?: { data: { replaces?: string } }) =>
    args?.data.replaces === "old-install"
      ? { installed: [], account: ["appflare"] }
      : { installed: ["links"], account: ["appflare", "links"] },
  ),
  jobStarted: vi.fn(async () => {}),
  checkInstallHostname: vi.fn(
    async (_: unknown): Promise<Record<string, unknown>> => ({ state: "free" }),
  ),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: server.startInstall }));
vi.mock("../installs/source-builds.functions", () => ({
  installSourceBuild: server.installSourceBuild,
}));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: vi.fn(
    async (): Promise<AppAccessCheck> => ({
      problem: null,
      users: 1,
      loginMethods: ["One-time PIN (a code sent by email)"],
      oneTimePin: true,
    }),
  ),
  startAccessChange: vi.fn(),
}));
vi.mock("../installs/worker-names.functions", () => ({
  listTakenWorkerNames: server.listTakenWorkerNames,
}));
// The address control reads the account's domains, and checks a name in one of them.
vi.mock("../installs/custom-domains.functions", () => ({
  getDomainOptions: vi.fn(async () => ({
    zones: [{ id: "z1", name: "example.com" }],
    inactiveZones: [],
    missing: [],
    noZones: false,
  })),
  checkInstallHostname: server.checkInstallHostname,
}));
vi.mock("../installs/external-domains.functions", () => ({
  getExternalDomainOptions: vi.fn(async () => ({ gateway: null, accountZones: [] })),
}));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRouting: vi.fn(),
}));

const { InstallForm } = await import("./install-form");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalog = catalogManifestSchema.parse({
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
  secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" }],
  vars: [{ name: "HOME_PAGE", label: "Home page", optional: true }],
});

const PREFILL: InstallFormPrefill = {
  replaces: "old-install",
  workerName: "links",
  displayName: "Team links",
  vars: { HOME_PAGE: "/admin" },
  access: true,
  domain: null,
  emailZoneId: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.startInstall.mockClear();
  server.installSourceBuild.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("InstallForm, installing again", () => {
  it("starts from last time's choices, asks for the names with the failed install's left out, and sends what it replaces", async () => {
    await act(async () =>
      root.render(
        <InstallForm
          catalog={catalog}
          varFields={[
            {
              name: "HOME_PAGE",
              label: "Home page",
              required: false,
              kind: "text",
              shownDefault: "",
              options: null,
            },
          ]}
          subdomain="example"
          canInstall
          defaultWorkerName="links-2"
          fixedWorkerName={false}
          blockedReason={null}
          requirementsConfirmed
          prefill={PREFILL}
        />,
      ),
    );
    // The live name check, once typing would have paused.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORKER_NAME_CHECK_DELAY_MS + 50));
    });
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.some((i) => i.value === "links")).toBe(true);
    expect(inputs.some((i) => i.value === "Team links")).toBe(true);
    expect(container.textContent).toContain(SECRETS_AGAIN_NOTE);
    expect(server.listTakenWorkerNames).toHaveBeenCalledWith({ data: { replaces: "old-install" } });
    expect(container.textContent).not.toContain("already");
    // The freed name reads as available, in the tray under the address.
    expect(container.querySelector("[data-address-status-text]")?.textContent).toBe("Available");
    // The fold holds the name in Appflare and a changed setting, so it starts open.
    expect(
      container.querySelector("[data-fold] button[aria-expanded]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Install again",
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    const call = server.startInstall.mock.calls.at(-1)?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    const sent = call?.data ?? {};
    expect(sent).toMatchObject({
      slug: "links",
      workerName: "links",
      displayName: "Team links",
      vars: { HOME_PAGE: "/admin" },
      access: true,
      replaces: "old-install",
    });
    // A generated secret gets a fresh value; nothing of last time's is sent.
    expect(String((sent.secrets as Record<string, string>).ADMIN_PASSWORD).length).toBeGreaterThan(
      0,
    );
  });

  it("installs a build from a repository again through its review, sending what it replaces", async () => {
    await act(async () =>
      root.render(
        <InstallForm
          catalog={catalog}
          varFields={[]}
          subdomain="example"
          canInstall
          defaultWorkerName="links-2"
          fixedWorkerName={false}
          blockedReason={null}
          requirementsConfirmed
          reviewedBuildId="build-1"
          prefill={{ ...PREFILL, access: false, vars: {} }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORKER_NAME_CHECK_DELAY_MS + 50));
    });
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Install again",
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(server.startInstall).not.toHaveBeenCalled();
    const call = server.installSourceBuild.mock.calls.at(-1)?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(call?.data).toMatchObject({
      buildId: "build-1",
      workerName: "links",
      displayName: "Team links",
      replaces: "old-install",
    });
    expect(call?.data).not.toHaveProperty("slug");
    expect(server.jobStarted).toHaveBeenLastCalledWith("job-2", "Installing again");
  });

  describe("with a custom domain from last time", () => {
    const withDomain: InstallFormPrefill = {
      ...PREFILL,
      access: false,
      domain: { kind: "custom", zoneId: "z1", hostname: "links.example.com" },
    };

    async function renderWithDomain() {
      await act(async () =>
        root.render(
          <InstallForm
            catalog={catalog}
            varFields={[]}
            subdomain="example"
            canInstall
            defaultWorkerName="links-2"
            fixedWorkerName={false}
            blockedReason={null}
            requirementsConfirmed
            prefill={withDomain}
          />,
        ),
      );
      // The domains are read, then the name is checked once typing would have paused.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, HOSTNAME_CHECK_DELAY_MS + 50));
        });
      }
    }

    function readiness(): string {
      return container.querySelector("[data-install-readiness]")?.textContent ?? "";
    }

    it("warns that a name with DNS records is left out, and still installs", async () => {
      server.checkInstallHostname.mockResolvedValue({
        state: "records",
        records: [{ type: "CNAME", content: "elsewhere.example.net" }],
      });
      await renderWithDomain();
      expect(server.checkInstallHostname).toHaveBeenLastCalledWith({
        data: {
          zoneId: "z1",
          hostname: "links.example.com",
          workerName: "links",
          replaces: "old-install",
        },
      });
      const tray = container.querySelector("[data-address-status]");
      expect(tray?.getAttribute("data-address-status")).toBe("warning");
      expect(tray?.textContent).toContain("This name already has a DNS record (CNAME).");
      expect(container.textContent).toContain("The install will leave this name out");
      expect(container.textContent).toContain("delete the records in Cloudflare, then install");
      // Read with the address field: its description points at the note.
      const field = container.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
      const described = (field?.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toContain("delete the records in Cloudflare, then install");
      // Where the app will answer: workers.dev, since the domain is left out.
      expect(readiness()).toBe("Installs Links again at https://links.example.workers.dev.");
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Install again",
      );
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      const call = server.startInstall.mock.calls.at(-1)?.[0] as
        | { data: Record<string, unknown> }
        | undefined;
      // Installing anyway keeps the choice: the job adds the domain if the records are gone.
      expect(call?.data.domain).toEqual({
        kind: "custom",
        zoneId: "z1",
        hostname: "links.example.com",
      });
    });

    it("holds Install for a name another app here uses", async () => {
      server.checkInstallHostname.mockResolvedValue({ state: "other-app" });
      await renderWithDomain();
      expect(
        container.querySelector("[data-address-status]")?.getAttribute("data-address-status"),
      ).toBe("danger");
      expect(readiness()).toBe("To install Links again, choose an address no other app here uses.");
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Install again",
      );
      expect(button?.disabled).toBe(true);
    });
  });
});
