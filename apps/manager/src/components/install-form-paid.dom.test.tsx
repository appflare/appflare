import { type CatalogManifest, catalogManifestSchema } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitedKind } from "../catalog/account-limits";

/**
 * The install form's "This account is on Workers Paid" for an app that sets
 * cron triggers or creates resources Workers Free has a low limit for. The
 * server functions only exist under the Start Vite plugin; they and the job
 * page navigation are stubbed. The Worker name is fixed so the form needs no
 * name check.
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
  checkAppAccess: vi.fn(async () => ({
    problem: null,
    users: 1,
    loginMethods: [],
    oneTimePin: true,
  })),
  startAccessChange: vi.fn(),
}));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));
// The address choice reads the account's zones; workers.dev only is all this needs.
vi.mock("./install-address-field", () => ({ InstallAddressField: () => null }));
vi.mock("../installs/custom-domains.functions", () => ({ checkInstallHostname: vi.fn() }));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRouting: vi.fn(),
}));

const { InstallForm } = await import("./install-form");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG: CatalogManifest = catalogManifestSchema.parse({
  slug: "notes",
  name: "Notes",
  summary: "Notes.",
  tagline: "Notes",
  repo: "example/notes",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["example"],
  source: { ref: "main", sha: "6056400d47530aa87e4ae5764b37ffca9d00e87f" },
  install: { packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
  plan: "free",
  secrets: [],
  vars: [],
  requires: [],
});

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

async function show(extra: {
  cronTriggers?: number;
  limitedResources?: Partial<Record<LimitedKind, number>>;
  planKnown?: boolean;
}) {
  await act(async () =>
    root.render(
      <InstallForm
        catalog={CATALOG}
        varFields={[]}
        subdomain="example"
        canInstall
        defaultWorkerName="notes"
        fixedWorkerName
        blockedReason={null}
        requirementsConfirmed
        capabilities={null}
        {...extra}
      />,
    ),
  );
}

function paidBox(): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes("This account is on Workers Paid"),
    ) ?? null
  );
}

async function submit() {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Install"),
  );
  await act(async () => button?.click());
}

function sentPaid(): unknown {
  const call = server.startInstall.mock.calls.at(-1)?.[0] as { data: { paidConfirmed?: unknown } };
  return call.data.paidConfirmed;
}

describe("InstallForm, This account is on Workers Paid", () => {
  it("is offered for an app that creates a D1 database while the plan is not known", async () => {
    await show({ limitedResources: { d1: 1 } });
    expect(paidBox()?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(
      "Workers Paid allows 50,000 D1 databases per account. Otherwise Appflare counts the D1 databases the account already has and stops before it changes anything if this would pass 10.",
    );
    const input = paidBox()?.closest("label")?.querySelector<HTMLInputElement>("input");
    await act(async () => input?.click());
    await submit();
    expect(sentPaid()).toBe(true);
  });

  it("is one confirmation for cron triggers and databases together", async () => {
    await show({ cronTriggers: 2, limitedResources: { d1: 1, hyperdrive: 1 } });
    const boxes = [...container.querySelectorAll('[role="checkbox"]')].filter((el) =>
      el.closest("label")?.textContent?.includes("This account is on Workers Paid"),
    );
    expect(boxes).toHaveLength(1);
    expect(container.textContent).toContain(
      "Workers Paid allows 1,000 cron triggers, 50,000 D1 databases and 25 Hyperdrive configurations per account. Otherwise Appflare counts what the account already has and stops before it changes anything if this would pass Workers Free's limits (5 cron triggers, 10 D1 databases, 10 Hyperdrive configurations).",
    );
  });

  it("is not offered on a plan known as free, where the install counts whatever is ticked", async () => {
    await show({ limitedResources: { d1: 1 }, planKnown: true });
    expect(paidBox()).toBeNull();
    await submit();
    expect(sentPaid()).toBe(false);
  });

  it("is not offered for an app that creates none of them", async () => {
    await show({ limitedResources: {} });
    expect(paidBox()).toBeNull();
  });
});
