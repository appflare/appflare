import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import {
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  type IndexJson,
  indexJsonSchema,
  readIndexJson,
} from "@appflare/schema";
import type { AppAccessCheck, InstallAccessView } from "../../src/access/app-access";
import type { CapabilityRowsInput, RowsConnection } from "../../src/capabilities/capability-rows";
import type { CatalogDetail } from "../../src/catalog/catalog.functions";
import type { ConnectionView } from "../../src/cloudflare/connection-view";
import { accountAttentionRows } from "../../src/home/account-attention";
import { installVarFields } from "../../src/installs/install-vars";
import type { InstallSettings } from "../../src/installs/reconfigure.server";
import type { StartUpdateResult } from "../../src/installs/versions.server";
import catalogIndexJson from "./catalog.json";
import cloudmarkManifest from "./cloudmark-manifest.json";
import cutManifest from "./cut-manifest.json";
import emdashManifest from "./emdash-manifest.json";
import formAppsJson from "./form-apps.json";

// Parsed as the manager reads them, so a fixture in an outdated shape fails
// here instead of rendering a page the manager would never show.
const catalogIndex: IndexJson = readIndexJson(indexJsonSchema.parse(catalogIndexJson));
/**
 * Apps whose install forms are pictured, besides the catalog's: kept out of
 * the catalog list, opened only by their own page (`/catalog/open-seo`). Their
 * rows and manifests came from the public catalog on 2026-10-04.
 */
const formApps: IndexJson = readIndexJson(
  indexJsonSchema.parse({
    generatedAt: formAppsJson.generatedAt,
    apps: formAppsJson.apps,
  }),
);
const manifests: Record<string, CatalogManifest> = {
  cut: catalogManifestSchema.parse(cutManifest.catalog),
  cloudmark: catalogManifestSchema.parse(cloudmarkManifest.catalog),
  emdash: catalogManifestSchema.parse(emdashManifest.catalog),
  ...Object.fromEntries(
    Object.entries(formAppsJson.manifests).map(([slug, manifest]) => [
      slug,
      catalogManifestSchema.parse(manifest),
    ]),
  ),
};

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
  [...catalogIndex.apps, ...formApps.apps].map((app) => [
    app.slug,
    app.media?.icon === undefined ? undefined : `/api/catalog/media/${app.media.icon.sha256}`,
  ]),
);
function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Screenshot fixture has no matching entry");
  return item;
}
const media = (app: IndexApp) => ({
  icon: icons.get(app.slug),
  cover: null,
  screenshots: (app.media?.screenshots ?? []).map((shot) => ({
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
    reinstallNeeded: false,
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
  accessServiceTokens: { state: "readable" },
  plan: { plan: "paid", source: "detected" },
  manualPlan: null,
  accountId: "1a2b3c4d1a2b3c4d1a2b3c4d1a2b3c4d",
};
/** An account with many domains, for the address's searchable domain picker. */
const manyZones = [
  "example.com",
  ...[
    "acme",
    "atlas",
    "birch",
    "bramble",
    "cedar",
    "cinder",
    "copper",
    "delta",
    "ember",
    "fable",
    "fjord",
    "garnet",
    "harbor",
    "hazel",
    "indigo",
    "juniper",
    "kestrel",
    "lantern",
    "linden",
    "maple",
    "meadow",
    "nimbus",
    "orchid",
    "pebble",
    "quarry",
    "raven",
    "saffron",
    "sequoia",
    "tundra",
    "umber",
    "vale",
    "willow",
    "yarrow",
    "zephyr",
    "alder",
    "basalt",
    "coral",
    "drift",
    "ember-shop",
  ].map((name, i) => `${name}${i % 3 === 0 ? ".org" : i % 3 === 1 ? ".dev" : ".net"}`),
].map((name, i) => ({ id: `zone-${i}`, name }));

/** The same account on Workers Free, its plan not detected: the install form asks about it. */
const freePlanView = {
  ...view,
  workersPlan: { state: "unknown" },
  containers: { state: "needs-workers-paid" },
  plan: { plan: "free", source: "default" },
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
  "auth-inbox": { stars: 88, installs: 40 },
  edgekey: { stars: 45, installs: 40 },
  garrul: { stars: 73, installs: 40 },
  mailflare: { stars: 160, installs: 40 },
  "open-seo": { stars: 410, installs: 180 },
  sink: { stars: 5200, installs: 520 },
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
  installs: apps
    .filter((install) => install.slug === app.slug)
    .map((install) => ({
      installId: install.id,
      status: install.status,
      workerName: install.workerName,
      label: install.label,
    })),
  images: media(app),
  popularity: popularityBySlug[app.slug],
  primitives: { ids: app.services, keyValueDurableObjects: false, complete: true },
  categories: app.categories,
  appLicense: { expression: app.license, note: null },
  pitch: app.tagline,
}));
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
    [...catalogIndex.apps, ...formApps.apps]
      .filter((entry) => entry.slug === slug)
      .concat(catalogIndex.apps),
  );
  const catalog = manifests[app.slug] ?? manifests.cut ?? null;
  // The fields the index row and the catalog manifest shape, typed as the page reads them.
  const entry: Pick<CatalogDetail, "app" | "catalog" | "authors" | "varFields" | "categories"> = {
    app,
    catalog,
    authors: app.authors,
    varFields: catalog === null ? [] : installVarFields({ catalog, worker: { bindings: [] } }),
    categories: app.categories,
  };
  return {
    ...entry,
    key: app.slug,
    source,
    images: media(app),
    popularity: popularityBySlug[app.slug],
    creates: app.services.map((kind) => ({ kind, binding: kind.toUpperCase() })),
    durableObjects: [],
    error: null,
    installs: catalogApps.find((entry) => entry.slug === app.slug)?.installs ?? [],
    suggestedWorkerName: app.slug === "cloudmark" ? "cloudmark-2" : app.slug,
    fixedWorkerName: false,
    subdomain: "example",
    createsKnown: true,
    sandboxConnected: true,
    sandbox,
    cronTriggers: app.services.includes("cron") ? (app.slug === "open-seo" ? 2 : 1) : 0,
    moduleBytes: moduleBytesBySlug[app.slug] ?? 150_000,
    accountPlan: variant === "free-plan" ? "free" : "paid",
    capabilities: variant === "free-plan" ? freePlanView : view,
    primitives: { ids: app.services, keyValueDurableObjects: false, complete: true },
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
    gatewayReady: true,
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

/**
 * Appflare's Cloudflare connection: an API token, or (`?fixture=connection-oauth`)
 * Cloudflare sign-in, which (`?fixture=connection-needs-reconnect`) Cloudflare
 * no longer accepts, or which (`?fixture=connection-missing-permission`) was
 * not allowed R2 storage.
 */
const signInMissing = variant === "connection-missing-permission" ? ["workers-r2.write"] : [];
const connection: ConnectionView =
  variant === "connection-oauth" ||
  variant === "connection-needs-reconnect" ||
  variant === "connection-missing-permission"
    ? {
        kind: "oauth",
        state: variant === "connection-needs-reconnect" ? "needs_reconnect" : "connected",
        problem:
          variant === "connection-needs-reconnect"
            ? "Cloudflare no longer accepts this connection: it was withdrawn in Cloudflare, it expired, or it was used somewhere else."
            : null,
        problemAt: variant === "connection-needs-reconnect" ? now : null,
        connectedSince: "2026-09-20T10:00:00.000Z",
        ready: variant !== "connection-needs-reconnect",
        oauth: {
          clientId: "b99863433175d812f9595af56dd1b71d",
          scopes: MANAGER_OAUTH_SCOPES.filter((s) => !signInMissing.includes(s)),
          missingScopes: signInMissing,
          renewedAt: now,
        },
      }
    : {
        kind: "api_token",
        state: "connected",
        problem: null,
        problemAt: null,
        connectedSince: now,
        ready: true,
        oauth: null,
      };

/** The connection as "What this account can run" reads it. */
const rowsConnection: RowsConnection = {
  kind: connection.kind,
  missingScopes: connection.oauth?.missingScopes ?? [],
};

/**
 * Home's account rows: none, but for a sign-in missing a permission, whose
 * row (Reconnect Cloudflare) is the one pictured.
 */
function accountRowsFixture() {
  return variant === "connection-missing-permission"
    ? accountAttentionRows(
        // The fixture's capabilities are plain literals; the server functions return them as is.
        { ...capabilityRows, connection: rowsConnection } as unknown as CapabilityRowsInput,
        [],
      ).filter((row) => row.id === "token-permissions")
    : [];
}

const installSettings: InstallSettings = {
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
      stored: null,
    },
  ],
  placeholders: {
    workerName: "links",
    workerUrl: "https://links.example.workers.dev",
    appUrl: "https://links.example.com",
    wildcardHostname: null,
  },
  secrets: [
    {
      name: "ADMIN_PASSWORD",
      label: "Admin password",
      help: "Used to sign in to the app.",
      generate: "password",
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
};

/** The short links app is protected with Cloudflare Access; the others are not. */
function accessView(id: string): InstallAccessView {
  const protectedApp = id === "install-cut";
  return {
    offer: "recommended",
    protected: protectedApp,
    appName: protectedApp ? "Appflare: Short links (links)" : null,
    teamDomain: protectedApp ? "example.cloudflareaccess.com" : null,
    publicPaths: ["/s/*"],
    pendingPublicPaths: [],
    syncFailedAt: null,
    usesAccessValues: false,
    users: 3,
    repair: null,
  };
}

const accessCheck: AppAccessCheck = {
  problem: null,
  users: 3,
  loginMethods: ["One-time PIN (a code sent by email)", "GitHub"],
  oneTimePin: true,
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
      accountRows: accountRowsFixture(),
      deployCopy: null,
      downgrade: null,
      reconnectNeeded: connection.state === "needs_reconnect",
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
    getInstallPage: () => ({
      install: installDetail(argument(args, "installId")),
      snapshots: [],
      settings: installSettings,
      access: accessView(argument(args, "installId")),
    }),
    checkAppAccess: () => accessCheck,
    listSnapshots: () => [],
    getInstallSettings: (): InstallSettings => installSettings,
    startUpdate: (): StartUpdateResult => ({
      version: "0.1.1",
      needsSecrets: [
        {
          name: "STATUS_API_TOKEN",
          label: "Status API token",
          help: "Lets the checker read status updates.",
          optional: false,
          seedOnly: false,
          multiline: false,
          cloudflareToken: false,
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
    getCapabilityRowsData: () => ({ ...capabilityRows, connection: rowsConnection }),
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
      connection,
    }),
    startCloudflareReconnect: () => ({ url: "#", origin: "https://appflare.example.com" }),
    getDangerZoneState: () => ({ canRemove: false, reason: null }),
    getSandboxStatus: () => ({
      connected: true,
      info: { sandboxVersion: "0.1.0", image: "appflare/sandbox:0.1.0" },
      problem: null,
      workerExists: true,
      danglingBinding: false,
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
    getEmailZoneOptions: () => ({
      zones: [{ id: "zone-example", name: "example.com" }],
      inactiveZones: [],
      noZones: false,
    }),
    previewEmailRouting: () => ({
      zoneId: "zone-example",
      zoneName: "example.com",
      routing: { enabled: true, status: "ready" },
      addresses: [],
      wantsCatchAll: true,
      catchAll: {
        state: "free",
        action: "drop",
        previous: { enabled: false, actions: [{ type: "drop" }] },
      },
      foreignMx: [],
      problems: [],
      warnings: [],
      missing: [],
      enablesRouting: false,
      sendsEmail: false,
      destinations: null,
    }),
    // "Install again" for an OpenSEO install that did not finish (`?again=install-open-seo-failed`).
    getInstallAgain: () => ({
      installId: "install-open-seo-failed",
      appKey: "open-seo",
      label: "SEO research",
      version: "0.1.10",
      workerName: "seo",
      displayName: "SEO research",
      vars: { OPENROUTER_MODEL: "openai/gpt-5.6-luna" },
      access: true,
      domain: { kind: "custom", zoneId: "zone-example", hostname: "seo.example.com" },
      emailZoneId: null,
      autoUpdate: "inherit",
      leftovers: [
        { kind: "worker", name: "seo" },
        { kind: "d1", name: "seo-db" },
      ],
      failedJobId: "01K5Q3MGN7F6YP8T2RC9VJ4BXA",
      refusal: null,
    }),
    getDomainOptions: () => ({
      zones: variant === "many-domains" ? manyZones : [{ id: "zone-example", name: "example.com" }],
      inactiveZones: [],
      missing: [],
      noZones: false,
    }),
    // A name on one of the account's domains is free, or (`?fixture=dns-records`) already has a record.
    checkInstallHostname: () =>
      variant === "dns-records"
        ? { state: "records", records: [{ type: "CNAME", content: "old-site.example.net" }] }
        : { state: "free" },
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
    listTakenWorkerNames: () => {
      const names = {
        installed: apps.map((app) => app.workerName),
        account: ["appflare", ...apps.map((app) => app.workerName)],
      };
      // A slow account, to picture the name while it is checked.
      return variant === "slow-names"
        ? new Promise((done) => setTimeout(() => done(names), 120_000))
        : names;
    },
  };
  const call = result[name];
  if (!call) throw new Error(`Missing screenshot fixture: ${name}`);
  return Promise.resolve(call());
}
