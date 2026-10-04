import { catalogManifestSchema } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAccessCheck } from "../access/app-access";
import { type InstallFormPrefill, SECRETS_AGAIN_NOTE } from "../installs/install-again";
import { WORKER_NAME_CHECK_DELAY_MS } from "../installs/worker-name-check";

/**
 * The install form on "Install again": it starts from the failed install's
 * choices, counts the Worker name the removal frees as free, says secrets
 * are entered again, and sends what it replaces. Server functions and the
 * job page navigation are stubbed.
 */
const server = vi.hoisted(() => ({
  startInstall: vi.fn(async (_: unknown) => ({ jobId: "job-1", installId: "install-1" })),
  // As the server answers: the replaced install's names are left out for it.
  listTakenWorkerNames: vi.fn(async (args?: { data: { replaces?: string } }) =>
    args?.data.replaces === "old-install"
      ? { installed: [], account: ["appflare"] }
      : { installed: ["links"], account: ["appflare", "links"] },
  ),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => server.jobStarted }));
vi.mock("./use-account-id", () => ({ useAccountId: () => "0123456789abcdef0123456789abcdef" }));
vi.mock("../installs/installs.functions", () => ({ startInstall: server.startInstall }));
vi.mock("../installs/source-builds.functions", () => ({ installSourceBuild: vi.fn() }));
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
vi.mock("./install-domain-fields", () => ({ InstallDomainFields: () => null }));
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
});
