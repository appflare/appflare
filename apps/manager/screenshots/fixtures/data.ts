import catalogIndex from "./catalog.json";
import cloudmarkManifest from "./cloudmark-manifest.json";
import cutManifest from "./cut-manifest.json";
import emdashManifest from "./emdash-manifest.json";

const now = "2026-09-28T09:00:00.000Z";
const source = { id: "official", label: "Appflare", colour: "orange", official: true };
const selected = ["cut", "emdash", "statusbeam", "r2-explorer", "cloudmark", "formzero"];
const names: Record<string, string> = {
  cut: "Short links",
  emdash: "Journal",
  statusbeam: "Service status",
  "r2-explorer": "Files",
  cloudmark: "Bookmarks",
  formzero: "Contact forms",
};
const icons = new Map(
  catalogIndex.apps.map((app) => [app.slug, `/api/catalog/media/${app.media.icon.sha256}`]),
);
function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Screenshot fixture has no matching entry");
  return item;
}
const media = (app: (typeof catalogIndex.apps)[number]) => ({
  icon: icons.get(app.slug),
  cover: null,
  screenshots: (app.media.screenshots ?? []).map((shot) => ({
    src: `/api/catalog/media/${shot.sha256}`,
    alt: shot.alt,
  })),
});
const apps = selected.map((slug, index) => {
  const app = first(catalogIndex.apps.filter((entry) => entry.slug === slug));
  const workerName = slug === "cut" ? "links" : slug;
  const address =
    slug === "cut" ? "https://links.example.com" : `https://${workerName}.example.workers.dev`;
  return {
    id: `install-${slug}`,
    slug,
    catalogSource: source,
    origin: "catalog",
    name: app.name,
    icon: icons.get(slug),
    displayName: names[slug],
    label: names[slug],
    workerName,
    status: "installed",
    version:
      slug === "emdash" ? "0.0.0-20260920.a0d31e2" : slug === "statusbeam" ? "0.1.0" : app.version,
    latestVersion: app.version,
    updateAvailable: slug === "emdash" || slug === "statusbeam",
    updateNeeds:
      slug === "statusbeam"
        ? "It needs something from you first, such as a new setting or a confirmation."
        : null,
    address,
    updatedAt: new Date(Date.parse(now) - (index + 2) * 86_400_000).toISOString(),
    uninstalledAt: null,
    healthStatus: "verified",
    healthCheckedAt: now,
  };
});
const view = {
  checkedAt: now,
  r2: { state: "enabled" },
  containers: { state: "available" },
  workersPlan: { state: "paid" },
  zone: { state: "available" },
  emailRouting: { state: "available" },
  workersDev: { state: "registered", subdomain: "example" },
  zeroTrust: { state: "exists", teamDomain: "example.cloudflareaccess.com" },
  analyticsEngine: { state: "enabled" },
  plan: { plan: "paid", source: "detected" },
  manualPlan: null,
  accountId: "1a2b3c4d1a2b3c4d1a2b3c4d1a2b3c4d",
};
const needs = {
  total: 7,
  workersPaid: 2,
  r2: 2,
  analyticsEngine: 0,
  zone: 1,
  emailRouting: 0,
  access: 1,
  sandbox: 0,
};
const sandbox = { state: "on", missing: null, confirmed: true };
const capabilityRows = {
  view,
  sandbox: "enabled",
  needs,
  inUse: { ...needs, total: 6 },
  sandboxJobs: { activeEnable: null, lastFailure: null },
};
const popularityBySlug: Record<string, { stars: number; installs: number }> = {
  cloudmark: { stars: 67, installs: 180 },
  cut: { stars: 214, installs: 180 },
  emdash: { stars: 140, installs: 520 },
  formzero: { stars: 38, installs: 180 },
  "r2-explorer": { stars: 96, installs: 180 },
  statusbeam: { stars: 121, installs: 180 },
};
const moduleBytesBySlug: Record<string, number> = {
  cloudmark: 79_000,
  cut: 91_000,
  emdash: 186_000,
  formzero: 102_000,
  "r2-explorer": 132_000,
  statusbeam: 144_000,
};
const catalogApps = catalogIndex.apps.map((app) => ({
  ...app,
  key: app.slug,
  source,
  instances: apps
    .filter((install) => install.slug === app.slug)
    .map((install) => ({
      installId: install.id,
      status: install.status,
      workerName: install.workerName,
      instanceName: install.label,
    })),
  images: media(app),
  popularity: popularityBySlug[app.slug],
  primitives: { ids: app.services, keyValueDurableObjects: false, complete: true },
  categories: app.categories,
  appLicense: { expression: app.license, note: null },
  pitch: app.tagline,
}));
const manifests: Record<
  string,
  {
    catalog: {
      vars?: Array<{
        name: string;
        label?: string;
        help?: string;
        required?: boolean;
        default?: string;
      }>;
    };
  }
> = {
  cut: cutManifest,
  cloudmark: cloudmarkManifest,
  emdash: emdashManifest,
};
const fallbackManifest: {
  catalog: {
    vars?: Array<{
      name: string;
      label?: string;
      help?: string;
      required?: boolean;
      default?: string;
    }>;
  };
} = { catalog: cutManifest.catalog };
const job = {
  id: "01K5Q3MGN7F6YP8T2RC9VJ4BXA",
  kind: "install",
  restore: false,
  deleteRetained: false,
  status: "succeeded",
  error: null,
  workerVersionId: "7f3c1a2e-5b48-4e19-8d64-2c90a7f13e5b",
  targetVersion: null,
  startedBy: "user",
  startedAt: "2026-09-25T10:14:00.000Z",
  finishedAt: "2026-09-25T10:14:38.000Z",
  reportedAt: null,
  install: apps[0],
  sourceBuild: null,
  addressMove: null,
  build: null,
  logs: [
    {
      id: 1,
      ts: "2026-09-25T10:14:01.000Z",
      level: "info",
      message: "Verified the signed release",
      requests: [],
      detail: null,
    },
    {
      id: 2,
      ts: "2026-09-25T10:14:07.000Z",
      level: "info",
      message: "Created the links KV namespace",
      requests: [`POST /accounts/${view.accountId}/storage/kv/namespaces -> 200`],
      detail: null,
    },
    {
      id: 3,
      ts: "2026-09-25T10:14:19.000Z",
      level: "info",
      message: "Uploaded the Worker",
      requests: [`PUT /accounts/${view.accountId}/workers/scripts/links -> 200`],
      detail: null,
    },
    {
      id: 4,
      ts: "2026-09-25T10:14:38.000Z",
      level: "info",
      message: "Health check passed",
      requests: [],
      detail: null,
    },
  ],
};

function detail(slug: string) {
  const app = first(
    catalogIndex.apps.filter((entry) => entry.slug === slug).concat(catalogIndex.apps),
  );
  const manifest = manifests[app.slug] ?? fallbackManifest;
  return {
    app,
    key: app.slug,
    source,
    images: media(app),
    popularity: popularityBySlug[app.slug],
    catalog: manifest.catalog,
    authors: app.authors,
    creates: app.services.map((kind) => ({ kind, binding: kind.toUpperCase() })),
    durableObjects: [],
    error: null,
    instances: catalogApps.find((entry) => entry.slug === app.slug)?.instances ?? [],
    suggestedWorkerName: app.slug === "cloudmark" ? "cloudmark-2" : app.slug,
    fixedWorkerName: false,
    varFields: (manifest.catalog.vars ?? []).map((field) => ({
      name: field.name,
      label: field.label ?? field.name,
      help: field.help,
      required: field.required ?? false,
      kind: "text",
      shownDefault: field.default ?? "",
      options: null,
    })),
    subdomain: "example",
    createsKnown: true,
    sandboxConnected: true,
    sandbox,
    cronTriggers: app.services.includes("cron") ? 1 : 0,
    moduleBytes: moduleBytesBySlug[app.slug],
    accountPlan: "paid",
    capabilities: view,
    primitives: { ids: app.services, keyValueDurableObjects: false, complete: true },
    categories: app.categories,
    appLicense: { expression: app.license, note: null },
    sourceBuilds: true,
  };
}

function installDetail(id: string) {
  const install = first(apps.filter((entry) => entry.id === id).concat(apps));
  return {
    ...install,
    currentVersionId: "7f3c1a2e-5b48-4e19-8d64-2c90a7f13e5b",
    pinSha: null,
    source: null,
    build: {
      kind: "artifact",
      image: null,
      builtAt: install.updatedAt,
      installer: null,
      stage: null,
    },
    vars: { BASE_URL: install.address },
    resources: [
      { kind: "kv", name: `${install.workerName}-links`, id: "kv-fixture-1", binding: "LINKS" },
    ],
    retained: [],
    secretNames: ["ADMIN_PASSWORD"],
    domains:
      install.slug === "cut"
        ? [
            {
              hostname: "links.example.com",
              url: "https://links.example.com",
              wildcard: false,
              status: "active",
              id: "domain-1",
              live: true,
            },
          ]
        : [],
    wildcard: null,
    externalDomains:
      install.slug === "cut"
        ? [
            {
              id: "external-1",
              hostname: "go.example.org",
              status: "active",
              url: "https://go.example.org",
              wildcard: false,
              live: true,
            },
          ]
        : [],
    emailRoutes: [],
    uninstall: "start",
    forgotten: false,
    activeJobId: null,
    workersDevEnabled: true,
    workersDevNote: null,
    workersDevChoice: "auto",
    workersDevUrl: `https://${install.workerName}.example.workers.dev`,
    otherWorkers: [],
    autoUpdate: "inherit",
    autoUpdateWaiting: null,
    autoUpdateDefault: false,
    jobs: [{ ...job, logs: undefined, install: undefined }],
    postInstall: ["Open the app and sign in to manage it."],
    tokenPermissions: [],
  };
}

/**
 * The fixtures' variant for one picture, named in the page's address
 * (`?fixture=address-on-domain`), so a page can be shot in another state.
 * Read once, when the page loads.
 */
const variant =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fixture");

/** Appflare's address: its workers.dev address, or a domain of the account since the 25th. */
const managerAddress =
  variant === "address-on-domain"
    ? {
        hostname: "appflare.example.com",
        zoneId: "zone-example",
        previousHostname: "appflare.example.workers.dev",
        movedAt: "2026-09-25T10:00:00.000Z",
        workersDevHostname: "appflare.example.workers.dev",
        serving: true,
        attachedByHand: [],
        movingJobId: null,
        movingTo: null,
      }
    : {
        hostname: null,
        zoneId: null,
        previousHostname: null,
        movedAt: null,
        workersDevHostname: "appflare.example.workers.dev",
        serving: null,
        attachedByHand: [],
        movingJobId: null,
        movingTo: null,
      };

function argument(args: unknown[], key: string): string {
  const first = args[0] as { data?: Record<string, string> } | undefined;
  return first?.data?.[key] ?? "";
}

export function fixture(name: string, args: unknown[]): unknown {
  const result: Record<string, () => unknown> = {
    // Setup at the owner step: the token is saved, and nobody exists yet.
    enterSetup: () => ({ step: "create-owner" }),
    loadAppflareVersion: () => "0.1.0",
    createOwner: () => ({ ok: true }),
    enterApp: () => ({
      viewer: {
        id: "user-ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "admin",
        isOwner: true,
      },
      accountId: view.accountId,
    }),
    getWhatsNew: () => ({ current: "0.1.0", releases: [], seen: "0.1.0" }),
    markWhatsNewSeen: () => ({ seen: "0.1.0" }),
    getLayoutData: () => ({
      manager: { current: "0.1.0", latest: null, updateAvailable: false, activeJobId: null },
      removedApps: 0,
      apps,
      failedJobs: [],
      accountRows: [],
      deployCopy: null,
      downgrade: null,
    }),
    listCatalog: () => ({
      apps: catalogApps,
      sources: [source],
      failed: [],
      unsigned: [],
      updatedAt: now,
      error: null,
      unreadable: 0,
      featured: null,
      statsGeneratedAt: now,
      capabilities: view,
      repositoryBuilds: true,
      sandbox,
    }),
    getCatalogEntry: () => detail(argument(args, "slug")),
    getInstall: () => installDetail(argument(args, "installId")),
    listSnapshots: () => [],
    getInstallSettings: () => ({
      slug: "cut",
      kind: "artifact",
      unavailable: null,
      fields: [
        {
          name: "HOME_PAGE",
          label: "Home page",
          help: "Choose what visitors see on the home page.",
          required: false,
          kind: "text",
          shownDefault: "default",
          options: null,
          value: "default",
        },
      ],
      placeholders: {
        workerName: "links",
        workerUrl: "https://links.example.com",
        wildcardHostname: null,
      },
      secrets: [
        {
          name: "ADMIN_PASSWORD",
          label: "Admin password",
          help: "Used to sign in to the app.",
          generate: true,
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
      appToken: null,
    }),
    startUpdate: () => ({
      version: "0.1.1",
      needsSecrets: [
        {
          name: "STATUS_API_TOKEN",
          label: "Status API token",
          help: "Lets the checker read status updates.",
          generate: false,
          optional: false,
        },
      ],
      heldSecrets: [],
      skipsPreview: null,
      build: null,
      cronTriggers: null,
    }),
    getJob: () => job,
    listJobs: () => [
      job,
      {
        ...job,
        id: "01K5Q3NG27ZXT5WM6BHV9JRAE4",
        install: apps[5],
        startedAt: "2026-09-24T11:00:00.000Z",
        finishedAt: "2026-09-24T11:00:30.000Z",
      },
      {
        ...job,
        id: "01K5Q3P2CA4Q8VKY9NHJ7M6WRT",
        kind: "update",
        status: "running",
        install: apps[3],
        finishedAt: null,
      },
    ],
    getCapabilityRowsData: () => capabilityRows,
    getAutoUpdateSettings: () => ({ apps: false, manager: false, devBuild: false }),
    getManagerUpdate: () => ({
      current: "0.1.0",
      latest: { version: "0.1.0", tag: "v0.1.0", publishedAt: "2026-09-20T10:00:00.000Z" },
      updateAvailable: false,
      checkedAt: now,
      activeJobId: null,
    }),
    getManagerVersions: () => ({
      ok: true,
      servingVersionId: "7f3c1a2e-5b48-4e19-8d64-2c90a7f13e5b",
      versions: [
        {
          id: "7f3c1a2e-5b48-4e19-8d64-2c90a7f13e5b",
          number: 2,
          createdOn: "2026-09-20T10:00:00.000Z",
          appflareVersion: "0.1.0",
          trigger: "upload",
          message: null,
          serving: true,
          older: false,
        },
        {
          id: "2d9a86f1-0c3e-4b75-91a2-4fe8837d5b10",
          number: 1,
          createdOn: "2026-09-01T10:00:00.000Z",
          appflareVersion: "0.0.9",
          trigger: "upload",
          message: null,
          serving: false,
          older: true,
        },
      ],
    }),
    getAccountCapabilities: () => view,
    getTokenStatus: () => ({
      configured: true,
      accountId: view.accountId,
      accountName: "Example account",
      workerName: "appflare",
      verifiedAt: now,
      hasSecret: true,
    }),
    getDangerZoneState: () => ({ canRemove: false, reason: null }),
    getSandboxStatus: () => ({
      connected: true,
      info: { sandboxVersion: "0.1.0", image: "appflare/sandbox:0.1.0" },
      problem: null,
      workerExists: true,
      pinnedVersion: "0.1.0",
      updateAvailable: false,
      activeJob: null,
      lastFailure: null,
      inUseBy: [],
      readiness: sandbox,
    }),
    getGithubAccess: () => ({
      tokens: [],
      sandboxConnected: true,
      sandboxSupportsTokens: true,
    }),
    listUsers: () => [
      {
        id: "user-ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "admin",
        isOwner: true,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      {
        id: "user-grace",
        name: "Grace Hopper",
        email: "grace@example.com",
        role: "admin",
        isOwner: false,
        createdAt: "2026-09-02T10:00:00.000Z",
      },
      {
        id: "user-alan",
        name: "Alan Turing",
        email: "alan@example.com",
        role: "member",
        isOwner: false,
        createdAt: "2026-09-03T10:00:00.000Z",
      },
    ],
    listPasskeys: () => [
      {
        id: "passkey-1",
        name: "This laptop",
        provider: "1Password",
        synced: true,
        createdAt: "2026-09-20T10:00:00.000Z",
      },
    ],
    getPasswordRecoverySettings: () => ({
      email: { bound: true, sender: "security@example.com", enabled: true },
      viewerIsOwner: true,
      lastRecovery: null,
    }),
    getAccessStatus: () => ({
      enabled: true,
      domain: "manager.example.com",
      teamDomain: "example.cloudflareaccess.com",
      enabledAt: "2026-09-02T10:00:00.000Z",
      adminEmails: ["ada@example.com", "grace@example.com"],
      currentHostname: "manager.example.com",
    }),
    listNotificationChannels: () => [
      {
        id: "channel-1",
        kind: "webhook",
        label: "Team updates",
        target: "hooks.example.com",
        events: ["update_available", "install_finished", "health_failing"],
        failureCount: 0,
        lastError: null,
        lastFailureAt: null,
        lastSuccessAt: now,
        pending: 0,
        readable: true,
        createdAt: "2026-09-20T10:00:00.000Z",
      },
    ],
    getGatewayView: () => ({
      gateway: {
        zoneId: "zone-example",
        zoneName: "example.com",
        hostname: "apps.example.com",
        ready: true,
        readyAt: now,
        check: { kind: "ready", used: 1, allocated: 100 },
        answering: true,
        domains: [{ hostname: "go.example.org", installId: "install-cut" }],
      },
      zones: [{ id: "zone-example", name: "example.com" }],
      accountId: view.accountId,
    }),
    getDomainOptions: () => ({
      zones: [{ id: "zone-example", name: "example.com" }],
      inactiveZones: [],
      missing: [],
      noZones: false,
    }),
    getManagerAddress: () => managerAddress,
    getManagerAddressOptions: () => ({
      zones: [
        { id: "zone-example", name: "example.com", suggestedHostname: "appflare.example.com" },
      ],
      inactiveZones: [],
      missing: [],
      noZones: false,
    }),
    getExternalDomainOptions: () => ({
      gateway: { zoneName: "example.com", hostname: "apps.example.com" },
      accountZones: ["example.com"],
    }),
    getExternalDomainStatus: () => ({
      hostname: "go.example.org",
      status: "active",
      sslStatus: "active",
      method: "http",
      active: true,
      records: [],
      errors: [],
      health: null,
      checkedAt: now,
    }),
    checkCustomDomain: () => ({
      hostname: "links.example.com",
      url: "https://links.example.com",
      status: "verified",
      detail: "HTTP 200",
      checkedAt: now,
      workersDevTurnedOff: false,
    }),
    listTakenWorkerNames: () => ({
      installed: apps.map((app) => app.workerName),
      account: ["appflare", ...apps.map((app) => app.workerName)],
    }),
  };
  const call = result[name];
  if (!call) throw new Error(`Missing screenshot fixture: ${name}`);
  return Promise.resolve(call());
}
