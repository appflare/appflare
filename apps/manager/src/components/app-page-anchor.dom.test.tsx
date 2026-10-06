import { Toasty } from "@cloudflare/kumo";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app page, arriving from a link to one of its sections. The route runs
 * under the router and loads through server functions, which only exist
 * under the Start Vite plugin; the loader data and the location are given
 * here instead.
 */
const loader = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  };
  const useHash = () => useSyncExternalStore(subscribe, () => window.location.hash.slice(1));
  return {
    createFileRoute: () => (options: Record<string, unknown>) => ({
      options,
      fullPath: "/apps/$installId",
      useLoaderData: () => loader.current,
      useRouteContext: () => ({ viewer: { id: "u1", role: "admin" } }),
      useSearch: () => ({}),
      useParams: () => ({ installId: "i1" }),
    }),
    useLocation: (opts?: { select?: (l: { hash: string }) => unknown }) => {
      const hash = useHash();
      return opts?.select ? opts.select({ hash }) : { hash };
    },
    useNavigate: () => async () => {},
    useRouter: () => ({ invalidate: async () => {}, subscribe: () => () => {} }),
    getRouteApi: () => ({
      useRouteContext: (opts?: { select?: (c: { accountId: string }) => unknown }) =>
        opts?.select ? opts.select({ accountId: "acc" }) : { accountId: "acc" },
    }),
  };
});

// Every server function the page and its parts import.
vi.mock("../auto-update/auto-update.functions", () => ({
  getAutoUpdateSettings: vi.fn(),
  setAutoUpdateDefaults: vi.fn(),
  setInstallAutoUpdate: vi.fn(),
}));
vi.mock("../installs/app-credentials.functions", () => ({ replaceAppCredentials: vi.fn() }));
vi.mock("../installs/reconfigure.functions", () => ({
  startReconfigure: vi.fn(),
  startEmailAgain: vi.fn(),
}));
vi.mock("../installs/email-routing.functions", () => ({
  getEmailZoneOptions: vi.fn(),
  previewEmailRoutingInput: vi.fn(),
  previewEmailRouting: vi.fn(),
}));
vi.mock("../installs/custom-domains.functions", () => ({
  getDomainOptions: vi.fn(),
  addCustomDomain: vi.fn(),
  removeCustomDomain: vi.fn(),
  checkCustomDomain: vi.fn(),
}));
vi.mock("../installs/wildcard-domains.functions", () => ({
  addWildcardDomain: vi.fn(),
  removeWildcardDomain: vi.fn(),
}));
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: vi.fn() }));
vi.mock("../installs/external-domains.functions", () => ({
  getExternalDomainOptions: vi.fn(),
  addExternalDomain: vi.fn(),
  getExternalDomainStatus: vi.fn(),
  removeExternalDomain: vi.fn(),
}));
vi.mock("../installs/removed-apps.functions", () => ({
  listRemovedApps: vi.fn(),
  deleteRetainedData: vi.fn(),
  forgetRemovedApp: vi.fn(),
}));
vi.mock("../installs/installs.functions", () => ({
  startInstall: vi.fn(),
  renameInstall: vi.fn(),
  getInstallPage: vi.fn(),
}));
vi.mock("../installs/source-builds.functions", () => ({
  startSourceBuild: vi.fn(),
  getSourceBuild: vi.fn(),
  installSourceBuild: vi.fn(),
  updateFromSourceBuild: vi.fn(),
  discardSourceBuild: vi.fn(),
  checkSourceChanges: vi.fn(),
}));
vi.mock("../installs/uninstall.functions", () => ({
  startUninstall: vi.fn(),
  retryUninstall: vi.fn(),
  getResourceUsage: vi.fn(),
}));
vi.mock("../installs/versions.functions", () => ({
  startUpdate: vi.fn(),
  startRollback: vi.fn(),
  restoreDatabase: vi.fn(),
}));
vi.mock("../installs/workers-dev.functions", () => ({ setWorkersDev: vi.fn() }));
vi.mock("../installs/access-change.functions", () => ({
  checkAppAccess: vi.fn(),
  startAccessChange: vi.fn(),
}));

const { Route } = await import("../routes/_app/apps/$installId");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const install = {
  id: "i1",
  slug: "cut",
  catalogSource: null,
  origin: "catalog",
  name: "Cut",
  icon: null,
  displayName: "Links for Ada",
  label: "Links for Ada",
  workerName: "cut-links",
  status: "installed",
  version: "1.2.0",
  latestVersion: "1.2.0",
  updateAvailable: false,
  reinstallNeeded: false,
  address: null,
  updatedAt: "2026-09-27T09:00:00.000Z",
  uninstalledAt: null,
  healthStatus: "verified",
  healthAccess: false,
  healthCheckedAt: "2026-09-27T09:00:00.000Z",
  currentVersionId: null,
  pinSha: null,
  source: null,
  build: { kind: "artifact", image: null, builtAt: null, installer: null, stage: null },
  vars: {},
  resources: [],
  retained: [],
  secretNames: ["ADMIN_PASSWORD"],
  domains: [],
  wildcard: null,
  externalDomains: [],
  emailRoutes: [],
  uninstall: "start",
  forgotten: false,
  activeJobId: null,
  workersDevEnabled: true,
  workersDevNote: null,
  workersDevChoice: "auto",
  workersDevUrl: null,
  otherWorkers: [],
  autoUpdate: "inherit",
  autoUpdateWaiting: null,
  autoUpdateDefault: false,
  jobs: [],
  postInstall: [],
  tokenPermissions: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  loader.current = {
    install,
    snapshots: [],
    settings: null,
    access: {
      offer: "offered",
      protected: false,
      appName: null,
      teamDomain: null,
      publicPaths: [],
      pendingPublicPaths: [],
      syncFailedAt: null,
      usesAccessValues: false,
      users: 2,
      repair: null,
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/apps/i1${hash}`);
  const Page = Route.options.component as ComponentType;
  act(() =>
    root.render(
      <Toasty>
        <Page />
      </Toasty>,
    ),
  );
}

function selectedTab(): string | null | undefined {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
}

describe("the app page, opened from a link to a section", () => {
  it("opens the Settings tab for #secrets, with the Secrets section on it", () => {
    renderAt("#secrets");
    expect(selectedTab()).toBe("Settings");
    const secrets = container.querySelector("#secrets");
    expect(secrets).not.toBeNull();
    // The secret's name is technical detail, shown once asked for.
    expect(secrets?.textContent).toContain("1 secret is set");
    expect(secrets?.textContent).not.toContain("ADMIN_PASSWORD");
    act(() => secrets?.querySelector<HTMLElement>('[role="switch"]')?.click());
    expect(secrets?.textContent).toContain("ADMIN_PASSWORD");
    expect(container.querySelector("#danger-zone")).toBeNull();
  });

  it("opens Domains and email for #access, with the Cloudflare Access card on it", () => {
    renderAt("#access");
    expect(selectedTab()).toBe("Domains and email");
    expect(container.querySelector("#access")?.textContent).toContain("Cloudflare Access");
  });

  it("opens the tab of a later link without a reload", () => {
    renderAt("#secrets");
    act(() => {
      window.location.hash = "#danger-zone";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(selectedTab()).toBe("Overview");
    expect(container.querySelector("#danger-zone")).not.toBeNull();
  });

  it("stays on Overview without a hash, or with one that names no section", () => {
    renderAt("");
    expect(selectedTab()).toBe("Overview");
    act(() => root.unmount());
    root = createRoot(container);
    renderAt("#nothing");
    expect(selectedTab()).toBe("Overview");
  });
});

describe("the Email section of Domains and email", () => {
  const zoneId = "0123456789abcdef0123456789abcdef";
  /** The app's settings, as an update that left email out leaves them. */
  function withEmail(leftover: string[]) {
    loader.current = {
      ...(loader.current as object),
      settings: {
        slug: "cut",
        kind: "artifact",
        unavailable: null,
        fields: [],
        placeholders: {
          workerName: "cut-links",
          workerUrl: null,
          appUrl: null,
          wildcardHostname: null,
        },
        secrets: [],
        databases: [],
        canRemoveSecrets: true,
        email: {
          zoneId,
          zoneName: "example.com",
          leftover,
          again: {
            zoneId,
            zoneName: "example.com",
            addresses: ["inbox@example.com"],
            catchAll: false,
            remove: [],
          },
        },
        skipsPreview: null,
        installer: null,
        appToken: null,
      },
    };
  }

  it("says what an update left out of the app's email, and where to set it up again", () => {
    withEmail([]);
    renderAt("#email");
    expect(selectedTab()).toBe("Domains and email");
    const email = container.querySelector("#email");
    expect(email?.textContent).toContain("Part of the app's email is not set up");
    expect(email?.textContent).toContain(
      "Mail to inbox@example.com is not routed to the app. An update or a rollback left this out. Set it up again under Email in the app's settings.",
    );
    expect(email?.querySelector('a[href="/apps/i1#email-zone"]')).not.toBeNull();
    // No route is set up now; the zone is still the app's.
    expect(email?.textContent).toContain(
      "None of the app's email routes are set up on example.com now.",
    );
    expect(email?.textContent).not.toContain("does not receive email through Email Routing");
  });

  it("says nothing of it while a move to another domain is unfinished", () => {
    withEmail(["old.test"]);
    renderAt("#email");
    const email = container.querySelector("#email");
    expect(email?.textContent).not.toContain("Part of the app's email is not set up");
    expect(email?.textContent).toContain("This app does not receive email through Email Routing.");
  });
});
