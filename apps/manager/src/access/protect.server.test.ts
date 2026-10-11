import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AccessDestination } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { FAKE_TEAM_DOMAIN, fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { MAX_ACCESS_APP_DESTINATIONS } from "./bypass.server";
import { readInstallAccess, USERS_POLICY_NAME } from "./install-access.server";
import {
  accessAppName,
  overlap,
  PROTECT_MESSAGES,
  planDestinations,
  planWarnings,
  previewsCoveredElsewhere,
  protectInstall,
  readInstallProtection,
  resyncInstallAccessIfFailed,
  sameDestinations,
  syncInstallAccessDestinations,
  unprotectInstall,
  wildcardsCoveredElsewhere,
} from "./protect.server";
import { ACCESS_MESSAGES } from "./toggle.server";

/**
 * Protecting one install with its own Cloudflare Access application, against
 * a stateful fake of the account's Access objects: what is made and
 * recorded, doing it twice, picking up after a partial failure, refusing an
 * address another application covers, keeping destinations in step, and
 * taking it all off again.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOST = `cut.${SUBDOMAIN}.workers.dev`;
const WILDCARD = `*.${SUBDOMAIN}.workers.dev`;
/** What the seeded install's application covers: its hostnames, then its Worker. */
const OWN: AccessDestination[] = [
  { type: "public", uri: HOST },
  { type: "public", uri: "links.example.com" },
  { type: "worker", worker_id: "tag-cut" },
];
/** Its version previews' pattern, named next to an application that covers them more broadly. */
const PREVIEWS: AccessDestination = { type: "public", uri: `*-${HOST}` };
/** An application made by hand for every workers.dev address of the account. */
const TEAM_APP = {
  id: "team",
  aud: "aud-t",
  name: "Workers",
  destinations: [{ type: "public", uri: WILDCARD }],
  policies: [],
};
const MANIFEST = JSON.stringify({ version: "1.0.0", catalog: { name: "Cut" }, worker: {} });

function setup() {
  const cf = fakeAccessAccount({ now: () => NOW });
  cf.scripts.push({ id: "cut", tag: "tag-cut" }, { id: "cut-worker", tag: "tag-cut-worker" });
  const deps = { db: env.DB, client: cf.client, authSecret: AUTH, now: () => NOW };
  return { cf, deps };
}

/** Calls that change something at Cloudflare. */
function writes(cf: ReturnType<typeof fakeAccessAccount>) {
  return cf.keys().filter((k) => !k.startsWith("GET "));
}

async function resourceRows(kind: string) {
  return (
    await env.DB.prepare(
      "SELECT id, name, cf_id, deleted_at FROM resources WHERE kind = ?1 ORDER BY rowid",
    )
      .bind(kind)
      .all<{ id: string; name: string; cf_id: string | null; deleted_at: number | null }>()
  ).results;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({
    manifestJson: MANIFEST,
    resources: [
      { kind: "worker", name: "cut", cfId: "cut" },
      { kind: "domain", name: "links.example.com", cfId: "dom-1" },
    ],
  });
  await createDb(env.DB)
    .insert(user)
    .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
});

describe("planDestinations", () => {
  const sub = (name: string) => `${name}.${SUBDOMAIN}.workers.dev`;
  const app = (id: string, uris: string[]) => ({
    id,
    aud: `aud-${id}`,
    name: id,
    destinations: uris.map((uri) => ({ type: "public" as const, uri })),
  });

  it("names every hostname of the install, then each Worker uploaded by its tag, each once", () => {
    expect(
      planDestinations({
        workers: [
          { name: "cut", tag: "tag-cut" },
          { name: "Cut-API", tag: null },
        ],
        subdomain: SUBDOMAIN,
        customDomains: ["links.example.com", "Links.example.com"],
        wildcardBases: ["t.example.com"],
        externalHosts: ["b.customer.net", "A.customer.net", "a.customer.net"],
      }),
    ).toEqual({
      destinations: [
        { type: "public", uri: HOST },
        { type: "public", uri: sub("cut-api") },
        { type: "public", uri: "links.example.com" },
        { type: "public", uri: "a.customer.net" },
        { type: "public", uri: "b.customer.net" },
        { type: "worker", worker_id: "tag-cut" },
      ],
      previewsLeft: [],
      wildcardLeft: [],
      overLimit: [],
    });
    // An account without a workers.dev subdomain: the Workers by tag alone.
    expect(
      planDestinations({
        workers: [{ name: "cut", tag: "tag-cut" }],
        subdomain: null,
        customDomains: ["links.example.com"],
        externalHosts: [],
      }).destinations,
    ).toEqual([
      { type: "public", uri: "links.example.com" },
      { type: "worker", worker_id: "tag-cut" },
    ]);
    // Before its upload, nothing but its hostname could cover a Worker.
    expect(() =>
      planDestinations({
        workers: [{ name: "cut", tag: null }],
        subdomain: null,
        externalHosts: [],
      }),
    ).toThrow(PROTECT_MESSAGES.noSubdomain);
    const one: AccessDestination[] = [
      { type: "public", uri: "A.example.com" },
      { type: "worker", worker_id: "t" },
    ];
    const other: AccessDestination[] = [
      { type: "worker", worker_id: "t" },
      { type: "public", uri: "a.example.com" },
    ];
    expect(sameDestinations(one, other)).toBe(true);
    expect(sameDestinations(one, other.slice(1))).toBe(false);
  });

  it("names the version previews only where another application covers them", () => {
    const workers = [
      { name: "relay", tag: "tag-relay" },
      { name: "api-relay", tag: "tag-api-relay" },
    ];
    const input = { workers, subdomain: SUBDOMAIN, externalHosts: [] };
    const previews = (name: string) => ({ type: "public", uri: `*-${sub(name)}` });
    // The `worker` destinations cover them, so without a broader application they are not named.
    expect(
      previewsCoveredElsewhere({ ...input, others: [app("intranet", ["a.example.com"])] }),
    ).toBe(false);
    const others = [app("Workers", [`${WILDCARD}/admin/*`])];
    expect(previewsCoveredElsewhere({ ...input, others })).toBe(true);
    expect(() => planDestinations({ ...input, others })).toThrow(/script list/);
    // The install's own `api-relay` ends like `relay`: the same application covers it anyway.
    expect(
      planDestinations({ ...input, others, scripts: ["relay", "api-relay", "browser"] }),
    ).toEqual({
      destinations: [
        { type: "public", uri: sub("relay") },
        previews("relay"),
        { type: "public", uri: sub("api-relay") },
        previews("api-relay"),
        { type: "worker", worker_id: "tag-relay" },
        { type: "worker", worker_id: "tag-api-relay" },
      ],
      previewsLeft: [],
      wildcardLeft: [],
      overLimit: [],
    });
  });

  it("leaves the previews to the broader application when another Worker's name ends the same way", () => {
    // `relay` protected next to an unprotected `browser-relay`: `*-relay` would put
    // browser-relay's own address behind relay's application.
    const plan = planDestinations({
      workers: [{ name: "relay", tag: "tag-relay" }],
      subdomain: SUBDOMAIN,
      externalHosts: [],
      others: [app("Workers", [WILDCARD])],
      scripts: ["relay", "browser-relay", "relay-old"],
    });
    expect(plan.destinations).toEqual([
      { type: "public", uri: sub("relay") },
      { type: "worker", worker_id: "tag-relay" },
    ]);
    expect(plan.previewsLeft).toEqual([
      {
        worker: "relay",
        uri: `*-${sub("relay")}`,
        apps: ["Workers"],
        sharedWith: ["browser-relay"],
      },
    ]);
    expect(planWarnings(plan)).toEqual([
      `The version previews of the Worker "relay" stay under the Cloudflare Access application "Workers", which also covers them: naming them in Appflare's application (*-${sub("relay")}) would also cover the Worker "browser-relay", whose name ends the same way.`,
    ]);
  });

  describe("a wildcard domain", () => {
    const input = {
      workers: [{ name: "cut", tag: "tag-cut" }],
      subdomain: SUBDOMAIN,
      wildcardBases: ["T.example.com"],
      externalHosts: [],
    };
    const own = { type: "public" as const, uri: HOST };
    const worker = { type: "worker" as const, worker_id: "tag-cut" };
    /** An application made by hand for every name of the zone. */
    const zone = [app("Example", ["*.example.com"])];
    /** The domain's own routes, to the install's Worker. */
    const routes = [
      { worker: "cut", address: "t.example.com/*" },
      { worker: "cut", address: "*.t.example.com/*" },
    ];

    it("is named only where another application covers it", () => {
      // Its routes send the base and every name under it to the Worker, whose destination covers them.
      const intranet = [app("intranet", ["a.example.com"])];
      expect(wildcardsCoveredElsewhere({ ...input, others: intranet })).toBe(false);
      expect(planDestinations({ ...input, others: intranet })).toEqual({
        destinations: [own, worker],
        previewsLeft: [],
        wildcardLeft: [],
        overLimit: [],
      });
      expect(wildcardsCoveredElsewhere({ ...input, others: zone })).toBe(true);
      expect(() => planDestinations({ ...input, others: zone })).toThrow(/Worker addresses/);
      // Addresses elsewhere in the zone, or of the install's own Worker, leave both named.
      const elsewhere = [
        ...routes,
        { worker: "blog", address: "blog.example.com" },
        { worker: "feed", address: "*example.com/feed/*" },
      ];
      expect(planDestinations({ ...input, others: zone, workerAddresses: elsewhere })).toEqual({
        destinations: [
          own,
          { type: "public", uri: "t.example.com" },
          { type: "public", uri: "*.t.example.com" },
          worker,
        ],
        previewsLeft: [],
        wildcardLeft: [],
        overLimit: [],
      });
    });

    it("is left to the broader application where another Worker answers under it", () => {
      const plan = planDestinations({
        ...input,
        others: zone,
        // A custom domain of an unrelated Worker, which the domain's routes do not take.
        workerAddresses: [...routes, { worker: "api", address: "api.t.example.com" }],
      });
      expect(plan.destinations).toEqual([own, { type: "public", uri: "t.example.com" }, worker]);
      expect(plan.wildcardLeft).toEqual([
        {
          uri: "*.t.example.com",
          apps: ["Example"],
          sharedWith: [{ worker: "api", address: "api.t.example.com" }],
        },
      ]);
      expect(planWarnings(plan)).toEqual([
        `This app's *.t.example.com stays under the Cloudflare Access application "Example", which also covers it: naming it in Appflare's application would also cover api.t.example.com of the Worker "api".`,
      ]);
      // Another Worker's route on a path of the base leaves the base too; one deeper under it, the names.
      const deeper = planDestinations({
        ...input,
        others: zone,
        workerAddresses: [
          ...routes,
          { worker: "hooks", address: "t.example.com/hooks/*" },
          { worker: "eu", address: "*.eu.t.example.com/*" },
        ],
      });
      expect(deeper.destinations).toEqual([own, worker]);
      expect(deeper.wildcardLeft.map((l) => [l.uri, l.sharedWith.map((s) => s.worker)])).toEqual([
        ["t.example.com", ["hooks"]],
        ["*.t.example.com", ["eu"]],
      ]);
    });
  });

  it("stays within Cloudflare's limit, leaving out what a Worker's destination covers anyway", () => {
    const domains = Array.from(
      { length: 60 },
      (_, i) => `d${String(i).padStart(2, "0")}.example.com`,
    );
    const plan = planDestinations({
      workers: [{ name: "cut", tag: "tag-cut" }],
      subdomain: SUBDOMAIN,
      customDomains: domains,
      externalHosts: ["go.customer.net"],
      // Covers the last ten domains more broadly: those must be named.
      others: [app("Tail", ["d5*.example.com"])],
    });
    expect(plan.destinations).toHaveLength(MAX_ACCESS_APP_DESTINATIONS);
    const uris = plan.destinations.map((d) => (d.type === "public" ? d.uri : d.worker_id));
    // Required: the Worker, the external domain and the ten the other application covers.
    for (const required of ["tag-cut", "go.customer.net", "d50.example.com", "d59.example.com"]) {
      expect(uris).toContain(required);
    }
    // Then the workers.dev address and the first domains, in order, while there is room.
    expect(uris.slice(0, 3)).toEqual([HOST, "d00.example.com", "d01.example.com"]);
    expect(plan.overLimit).toEqual(domains.slice(37, 50));
    expect(planWarnings(plan)).toEqual([PROTECT_MESSAGES.overLimit(domains.slice(37, 50))]);
    // More required than the limit: refused, instead of Cloudflare's own 400.
    expect(() =>
      planDestinations({
        workers: [{ name: "cut", tag: "tag-cut" }],
        subdomain: SUBDOMAIN,
        externalHosts: Array.from({ length: 50 }, (_, i) => `h${i}.customer.net`),
      }),
    ).toThrow(PROTECT_MESSAGES.tooManyDestinations(51));
  });

  it("counts an address left to the application that names it itself toward nothing", () => {
    const domains = Array.from(
      { length: 60 },
      (_, i) => `d${String(i).padStart(2, "0")}.example.com`,
    );
    const input = {
      workers: [{ name: "cut", tag: "tag-cut" }],
      subdomain: SUBDOMAIN,
      customDomains: domains,
      externalHosts: ["go.customer.net"],
      others: [app("Admin", ["d00.example.com"]), app("Shop", ["go.customer.net"])],
    };
    // Refused as conflicts when protecting anew, so counted like any other.
    expect(planDestinations(input).overLimit).toEqual(domains.slice(47));
    // Left to those applications: planned, never sent, so two more domains fit.
    const plan = planDestinations({ ...input, leaveTaken: true });
    expect(plan.overLimit).toEqual(domains.slice(49));
    expect(plan.destinations).toHaveLength(MAX_ACCESS_APP_DESTINATIONS + 2);
    expect(plan.destinations).toContainEqual({ type: "public", uri: "d00.example.com" });
    // Fifty external domains and the Worker fit when one of them is left to another application.
    const externals = Array.from({ length: 50 }, (_, i) => `h${i}.customer.net`);
    const crowded = {
      workers: [{ name: "cut", tag: "tag-cut" }],
      subdomain: null,
      externalHosts: externals,
      others: [app("H0", ["h0.customer.net"])],
    };
    expect(() => planDestinations(crowded)).toThrow(PROTECT_MESSAGES.tooManyDestinations(51));
    expect(planDestinations({ ...crowded, leaveTaken: true }).destinations).toHaveLength(51);
  });
});

describe("overlap", () => {
  const ours = {
    hostnames: [HOST, `*-${HOST}`, "links.example.com", "t.example.com", "*.t.example.com"],
    tags: ["tag-cut"],
  };
  const against = (uris: string[], workerIds: string[] = []) =>
    overlap({ uris, hostnames: uris.map((u) => u.split("/")[0] ?? u), workerIds }, ours);

  it("blocks another application on the same address, or on part of one", () => {
    expect(against([], ["tag-cut"])).toEqual({ blocking: ["one of its Workers"], broader: [] });
    for (const [theirs, mine] of [
      [HOST, HOST],
      [`*-${HOST}`, `*-${HOST}`],
      // One version preview, inside the app's previews.
      [`abcd1234-${HOST}`, `*-${HOST}`],
      // A path of a hostname of the app: Access picks the path there.
      ["links.example.com/admin/*", "links.example.com"],
      ["x.t.example.com", "*.t.example.com"],
      ["*.t.example.com", "*.t.example.com"],
    ] as const) {
      expect(against([theirs])).toEqual({ blocking: [mine], broader: [] });
    }
  });

  it("lets a broader pattern be, with a path or without", () => {
    expect(against([WILDCARD])).toEqual({ blocking: [], broader: [WILDCARD] });
    expect(against(["*.example.com"])).toEqual({ blocking: [], broader: ["*.example.com"] });
    expect(against([`${WILDCARD}/admin/*`])).toEqual({
      blocking: [],
      broader: [`${WILDCARD}/admin/*`],
    });
    expect(against(["*-cut.other.workers.dev", "intranet.example.com"])).toEqual({
      blocking: [],
      broader: [],
    });
    // Broader on one address and the same on another: blocked.
    expect(against(["*.example.com", "links.example.com"]).blocking).toEqual(["links.example.com"]);
  });

  it("leaves relay and browser-relay alone, each next to the other's application", () => {
    const relay = [`relay.${SUBDOMAIN}.workers.dev`, `*-relay.${SUBDOMAIN}.workers.dev`];
    const browser = [
      `browser-relay.${SUBDOMAIN}.workers.dev`,
      `*-browser-relay.${SUBDOMAIN}.workers.dev`,
    ];
    const coverage = (uris: string[], tag: string) => ({ uris, hostnames: uris, workerIds: [tag] });
    // Protecting relay next to browser-relay's application: no address of relay's.
    expect(overlap(coverage(browser, "tag-b"), { hostnames: relay, tags: ["tag-r"] })).toEqual({
      blocking: [],
      broader: [],
    });
    // Protecting browser-relay next to relay's previews pattern: broader, so named exactly.
    expect(overlap(coverage(relay, "tag-r"), { hostnames: browser, tags: ["tag-b"] })).toEqual({
      blocking: [],
      broader: [relay[1]],
    });
  });

  it("leaves another Worker's custom domain or route under the app's wildcard domain alone", () => {
    const next = {
      ...ours,
      othersAddresses: [
        "status.t.example.com",
        "*.eu.t.example.com/*",
        "api.t.example.com/hooks/*",
        "t.example.com/hooks/*",
      ],
    };
    const blockingOf = (uri: string) =>
      overlap({ uris: [uri], hostnames: [uri.split("/")[0] ?? uri], workerIds: [] }, next).blocking;
    // Another protected app's custom domain, a route of another Worker, a path under one.
    for (const theirs of [
      "status.t.example.com",
      "status.t.example.com/admin",
      "x.eu.t.example.com",
      "*.eu.t.example.com",
      "api.t.example.com/hooks/x",
    ]) {
      expect(blockingOf(theirs)).toEqual([]);
    }
    // The app still answers there: other paths of a host whose route takes one path,
    // a name nobody else has, the base and the pattern themselves.
    expect(blockingOf("api.t.example.com")).toEqual(["*.t.example.com"]);
    expect(blockingOf("x.status.t.example.com")).toEqual(["*.t.example.com"]);
    expect(blockingOf("other.t.example.com")).toEqual(["*.t.example.com"]);
    expect(blockingOf("t.example.com")).toEqual(["t.example.com"]);
    expect(blockingOf("*.t.example.com")).toEqual(["*.t.example.com"]);
  });

  it("leaves another Worker whose name ends like the app's alone", () => {
    // `my-cut` and its previews: inside `*-cut` as written, yet no preview of `cut`.
    expect(against([`my-${HOST}`, `*-my-${HOST}`, `my-${HOST}/s/*`])).toEqual({
      blocking: [],
      broader: [],
    });
    // That Worker's application sees the app's previews pattern as broader.
    expect(
      overlap(
        { uris: [HOST, `*-${HOST}`], hostnames: [HOST, `*-${HOST}`], workerIds: ["tag-cut"] },
        { hostnames: [`my-${HOST}`, `*-my-${HOST}`], tags: ["tag-my-cut"] },
      ),
    ).toEqual({ blocking: [], broader: [`*-${HOST}`] });
  });
});

describe("protectInstall", () => {
  it("makes one application covering the install's Worker, letting in Appflare's users and its token", async () => {
    const { cf, deps } = setup();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(result.teamDomain).toBe(FAKE_TEAM_DOMAIN);
    const [app] = [...cf.apps.values()];
    expect(app).toMatchObject({
      name: accessAppName("Cut", "cut"),
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      // Its hostnames first, so Cloudflare names the application by its
      // workers.dev address, then its Worker (with its routes).
      destinations: OWN,
      domain: HOST,
    });
    const users = [...cf.policies.values()].find((p) => p.name === USERS_POLICY_NAME);
    expect(app?.policies).toEqual([
      { id: users?.id, name: USERS_POLICY_NAME, decision: "allow", precedence: 1 },
      {
        id: expect.any(String),
        name: `Appflare health checks ${INSTALL_ID}`,
        decision: "non_identity",
        precedence: 2,
      },
    ]);
    const record = await readInstallAccess(env.DB, INSTALL_ID);
    const probes = cf.appPolicies.get(record?.probesPolicyId ?? "");
    expect(probes?.include).toEqual([{ service_token: { token_id: record?.tokenId } }]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toEqual({
      accessAppId: app?.id,
      probesPolicyId: record?.probesPolicyId,
      aud: app?.aud,
      teamDomain: FAKE_TEAM_DOMAIN,
      coverage: { destinations: OWN, workerTags: { cut: "tag-cut" }, taken: [], overLimit: [] },
      syncFailedAt: null,
      resyncDueAt: null,
      // The users policy the application names, to tell when it was made anew.
      usersPolicyId: users?.id,
      appMissingAt: null,
    });
    expect(await resourceRows("access_app")).toEqual([
      {
        id: `${INSTALL_ID}:access_app:app`,
        name: "Appflare: Cut (cut)",
        cf_id: app?.id,
        deleted_at: null,
      },
    ]);
    // Everything is checked before anything is made.
    expect(cf.keys().indexOf("POST /access/policies")).toBeGreaterThan(
      cf.keys().indexOf("GET /access/apps"),
    );
  });

  it("changes nothing when protected already, and keeps the audience tag", async () => {
    const { cf, deps } = setup();
    const first = await protectInstall(deps, { installId: INSTALL_ID });
    const before = writes(cf).length;
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.outcome).toBe("unchanged");
    expect(again.aud).toBe(first.aud);
    // Only the users policy is rewritten (as every protect keeps it current).
    expect(writes(cf).slice(before)).toEqual([
      `PUT /access/policies/${[...cf.policies.keys()][0]}`,
    ]);
    expect(cf.apps.size).toBe(1);
  });

  it("takes over an application whose creation was not recorded, with a fresh token policy", async () => {
    const { cf, deps } = setup();
    const first = await protectInstall(deps, { installId: INSTALL_ID });
    const oldProbes = (await readInstallAccess(env.DB, INSTALL_ID))?.probesPolicyId;
    // The answer to the create was lost: nothing recorded the application.
    await env.DB.prepare(
      "UPDATE install_access SET access_app_id = NULL, probes_policy_id = NULL, access_aud = NULL",
    ).run();
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.outcome).toBe("adopted");
    expect(again.accessAppId).toBe(first.accessAppId);
    expect(again.aud).toBe(first.aud);
    expect(cf.apps.size).toBe(1);
    const record = await readInstallAccess(env.DB, INSTALL_ID);
    expect(record?.accessAppId).toBe(first.accessAppId);
    expect(record?.probesPolicyId).not.toBe(oldProbes);
    // The old inline policy went with the rewrite: one token policy, naming the token.
    expect([...cf.appPolicies.values()].map((p) => p.include)).toEqual([
      [{ service_token: { token_id: record?.tokenId } }],
    ]);
  });

  it("picks up after a refusal part way, making nothing twice", async () => {
    const { cf, deps } = setup();
    cf.forbidden.add("POST /accounts/acc0000000000000000000000000000a/access/service_tokens");
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      /cannot manage Access service tokens/,
    );
    // The users policy exists; no application was made.
    expect(cf.policies.size).toBe(1);
    expect(cf.apps.size).toBe(0);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toBeNull();
    cf.forbidden.clear();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(cf.policies.size).toBe(1);
    expect(cf.tokens.size).toBe(1);
    expect(cf.apps.size).toBe(1);
  });

  it("refuses a token without the service token permission before making anything", async () => {
    const { cf, deps } = setup();
    // A token made for a version that did not ask for "Access: Service Tokens".
    cf.forbidden.add("GET /accounts/acc0000000000000000000000000000a/access/service_tokens");
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      /cannot manage Access service tokens/,
    );
    expect(writes(cf)).toEqual([]);
    expect(cf.policies.size).toBe(0);
    const settings = await readSettings(createDb(env.DB), [SETTING.appAccessUsersPolicyId]);
    expect(settings.app_access_users_policy_id).toBeUndefined();
  });

  it("refuses an address another application covers as narrowly, before making anything", async () => {
    const { cf, deps } = setup();
    for (const [name, destinations, covered] of [
      ["Old cut", [{ type: "worker", worker_id: "tag-cut" }], "one of its Workers"],
      ["Links", [{ type: "public", uri: "links.example.com/admin/*" }], "links.example.com"],
      ["Cut", [{ type: "public", uri: HOST }], HOST],
      ["Preview", [{ type: "public", uri: `abcd1234-${HOST}` }], `*-${HOST}`],
    ] as const) {
      cf.apps.clear();
      cf.apps.set("other", { id: "other", aud: "aud-x", name, destinations, policies: [] });
      await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
        `The Cloudflare Access application "${name}" already covers ${covered}, an address of this app.`,
      );
    }
    expect(writes(cf)).toEqual([]);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
  });

  it("refuses in the same words an application Cloudflare names that its listing missed", async () => {
    const { cf, deps } = setup();
    cf.apps.set("other", {
      id: "other",
      aud: "aud-x",
      name: "Links admin",
      destinations: [{ type: "public", uri: "links.example.com" }],
      policies: [],
    });
    // Made in the dashboard between the listing and the create.
    let listings = 0;
    const client = {
      ...cf.client,
      access: {
        ...cf.client.access,
        listApps: async () => (listings++ === 0 ? [] : cf.client.access.listApps()),
      },
    };
    await expect(protectInstall({ ...deps, client }, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.conflict("Links admin", ["links.example.com"]),
    );
    expect(writes(cf).filter((k) => k.startsWith("POST /access/apps"))).toEqual([
      "POST /access/apps",
    ]);
    expect([...cf.apps.keys()]).toEqual(["other"]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toBeNull();
  });

  it("goes ahead next to a broader application, naming each address of the app itself", async () => {
    const { cf, deps } = setup();
    cf.apps.set("team", structuredClone(TEAM_APP));
    cf.apps.set("corp", {
      id: "corp",
      aud: "aud-c",
      name: "Example",
      destinations: [{ type: "public", uri: "*.example.com" }],
      policies: [],
    });
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(result.overridden).toEqual([
      { name: "Workers", patterns: [WILDCARD] },
      { name: "Example", patterns: ["*.example.com"] },
    ]);
    // An exact hostname for each address the wildcards cover, which Access picks over them,
    // the version previews' pattern included.
    expect(cf.apps.get(result.accessAppId)?.destinations).toEqual([
      OWN[0],
      PREVIEWS,
      ...OWN.slice(1),
    ]);
    expect(result.warnings).toEqual([]);
    expect(cf.apps.get("team")?.destinations).toEqual(TEAM_APP.destinations);
    expect(PROTECT_MESSAGES.overridden("Workers", [WILDCARD])).toBe(
      `The Cloudflare Access application "Workers" also covers ${WILDCARD}; Appflare's application takes precedence on this app's addresses.`,
    );
    // Nothing broader: nothing to say, and the Worker's destination covers the previews again.
    cf.apps.delete("team");
    cf.apps.delete("corp");
    expect((await protectInstall(deps, { installId: INSTALL_ID })).overridden).toEqual([]);
    expect(cf.apps.get(result.accessAppId)?.destinations).toEqual(OWN);
  });

  it("leaves the previews to a broader application rather than cover another Worker named like the app", async () => {
    const { cf, deps } = setup();
    cf.apps.set("team", structuredClone(TEAM_APP));
    // Another app's Worker whose address `*-cut` would match too.
    cf.scripts.push({ id: "browser-cut", tag: "tag-browser-cut" });
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(cf.apps.get(result.accessAppId)?.destinations).toEqual(OWN);
    expect(result.warnings).toEqual([
      PROTECT_MESSAGES.previewsLeft({
        worker: "cut",
        uri: `*-${HOST}`,
        apps: ["Workers"],
        sharedWith: ["browser-cut"],
      }),
    ]);
  });

  it("names a wildcard domain only next to a broader application, and leaves it there for another Worker's custom domain", async () => {
    const { cf, deps } = setup();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('wild', ?1, 'wildcard_domain', NULL, 't.example.com', 'zone-1', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const BASE = { type: "public", uri: "t.example.com" };
    const NAMES = { type: "public", uri: "*.t.example.com" };
    // Nothing covers it more broadly: the Worker's destination covers it, and no custom domain is read.
    const alone = await protectInstall(deps, { installId: INSTALL_ID });
    expect(cf.apps.get(alone.accessAppId)?.destinations).toEqual(OWN);
    expect(cf.keys()).not.toContain("GET /workers/domains");

    cf.apps.set("corp", {
      id: "corp",
      aud: "aud-c",
      name: "Example",
      destinations: [{ type: "public", uri: "*.example.com" }],
      policies: [],
    });
    cf.workerDomains.push({
      id: "dom-api",
      hostname: "api.t.example.com",
      service: "api",
      zone_id: "zone-1",
    });
    cf.calls.length = 0;
    const shared = await protectInstall(deps, { installId: INSTALL_ID });
    expect(cf.apps.get(shared.accessAppId)?.destinations).toEqual([OWN[0], OWN[1], BASE, OWN[2]]);
    expect(shared.warnings).toEqual([
      PROTECT_MESSAGES.wildcardLeft({
        uri: "*.t.example.com",
        apps: ["Example"],
        sharedWith: [{ worker: "api", address: "api.t.example.com" }],
      }),
    ]);
    expect(cf.keys().filter((k) => k === "GET /workers/domains")).toHaveLength(1);

    // That custom domain gone: the names are the app's again.
    cf.workerDomains.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toMatchObject({
      outcome: "updated",
      warnings: [],
    });
    expect(cf.apps.get(shared.accessAppId)?.destinations).toEqual([
      OWN[0],
      OWN[1],
      BASE,
      NAMES,
      OWN[2],
    ]);
  });

  it("protects an app with a wildcard domain next to another protected app's custom domain under it", async () => {
    const { cf, deps } = setup();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('wild', ?1, 'wildcard_domain', NULL, 't.example.com', 'zone-1', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    // The other app's application names its custom domain, as Appflare's do.
    cf.scripts.push({ id: "status", tag: "tag-status" });
    cf.workerDomains.push({
      id: "dom-status",
      hostname: "status.t.example.com",
      service: "status",
      zone_id: "zone-1",
    });
    cf.apps.set("status", {
      id: "status",
      aud: "aud-s",
      name: "Appflare: Status (status)",
      destinations: [
        { type: "public", uri: "status.t.example.com" },
        { type: "worker", worker_id: "tag-status" },
      ],
      policies: [],
    });
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.outcome).toBe("created");
    expect(cf.apps.get(result.accessAppId)?.destinations).toEqual(OWN);
    expect(cf.keys().filter((k) => k === "GET /workers/domains")).toHaveLength(1);
    expect((await protectInstall(deps, { installId: INSTALL_ID })).outcome).toBe("unchanged");

    // A name under the wildcard domain that no other Worker has is still the app's.
    cf.apps.set("intranet", {
      id: "intranet",
      aud: "aud-i",
      name: "Intranet",
      destinations: [{ type: "public", uri: "intranet.t.example.com" }],
      policies: [],
    });
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.conflict("Intranet", ["*.t.example.com"]),
    );
  });

  it("covers Workers before they exist, then switches to them by tag keeping the audience tag", async () => {
    const { cf, deps } = setup();
    const before = await protectInstall(deps, {
      installId: INSTALL_ID,
      appName: "Cut",
      workers: [
        { name: "cut", tag: null },
        { name: "cut-worker", tag: null },
      ],
    });
    const hostnames = [
      { type: "public", uri: HOST },
      { type: "public", uri: `cut-worker.${SUBDOMAIN}.workers.dev` },
      { type: "public", uri: "links.example.com" },
    ];
    expect([...cf.apps.values()][0]?.destinations).toEqual(hostnames);
    const after = await protectInstall(deps, {
      installId: INSTALL_ID,
      appName: "Cut",
      // One tag from the upload, one looked up; the primary Worker comes first whatever the order.
      workers: [{ name: "cut-worker" }, { name: "cut", tag: "tag-cut" }],
    });
    expect(after.outcome).toBe("updated");
    expect(after.accessAppId).toBe(before.accessAppId);
    expect(after.aud).toBe(before.aud);
    const app = [...cf.apps.values()][0];
    expect(app?.destinations).toEqual([
      ...hostnames,
      { type: "worker", worker_id: "tag-cut" },
      { type: "worker", worker_id: "tag-cut-worker" },
    ]);
    expect(app?.domain).toBe(HOST);
    // The token policy is referenced by id, so it stays.
    expect(app?.policies.map((p) => p.precedence)).toEqual([1, 2]);
    expect(cf.appPolicies.size).toBe(1);
  });

  it("covers an external domain with a public destination, recorded or about to be added", async () => {
    const { cf, deps } = setup();
    const pending = await protectInstall(deps, {
      installId: INSTALL_ID,
      pendingExternalHosts: ["Go.Customer.net"],
    });
    expect(pending.destinations).toEqual([
      ...OWN.slice(0, 2),
      { type: "public", uri: "go.customer.net" },
      OWN[2],
    ]);
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', 'APP_I1', 'go.customer.net', 'z/ch', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    // Recorded now: the sync keeps it.
    await syncInstallAccessDestinations(deps, INSTALL_ID);
    expect([...cf.apps.values()][0]?.destinations).toContainEqual({
      type: "public",
      uri: "go.customer.net",
    });
    // Removed: the destination comes off.
    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 2 WHERE id = 'i1:custom_hostname:x'",
    ).run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [],
    });
    expect([...cf.apps.values()][0]?.destinations).toEqual(OWN);
  });

  it("takes over an application by its name only when it covers nothing but this install", async () => {
    const { cf, deps } = setup();
    for (const destinations of [[{ type: "public", uri: HOST }], OWN]) {
      cf.apps.set("mine", {
        id: "mine",
        aud: "aud-mine",
        name: accessAppName("Cut", "cut"),
        destinations,
        policies: [],
      });
      await env.DB.prepare("DELETE FROM install_access").run();
      const adopted = await protectInstall(deps, { installId: INSTALL_ID });
      expect(adopted).toMatchObject({ outcome: "adopted", accessAppId: "mine", aud: "aud-mine" });
      expect(cf.apps.size).toBe(1);
    }

    // One made by hand under that name for more than the app is never taken over.
    await unprotectInstall(deps, INSTALL_ID);
    cf.apps.set("hand", {
      id: "hand",
      aud: "aud-hand",
      name: accessAppName("Cut", "cut"),
      destinations: [
        { type: "worker", worker_id: "tag-cut" },
        { type: "public", uri: "intranet.example.com" },
      ],
      policies: [],
    });
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      `"${accessAppName("Cut", "cut")}" already covers one of its Workers`,
    );
    expect(cf.apps.get("hand")?.destinations).toHaveLength(2);
  });

  it("refuses a Worker the account does not have, an app deployed by its own installer, and no Zero Trust", async () => {
    const { cf, deps } = setup();
    cf.scripts.length = 0;
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.workerMissing("cut"),
    );
    cf.scripts.push({ id: "cut", tag: "tag-cut" });
    cf.organization.current = null;
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      ACCESS_MESSAGES.noOrganization,
    );
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying'").run();
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      PROTECT_MESSAGES.selfDeploying("Cut"),
    );
    expect(writes(cf)).toEqual([]);
  });

  it("leaves an address another application named first to it when protecting again, as the sync does", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    // Protected by an earlier version (its Worker alone), when an application for the
    // custom domain could still be made.
    app.destinations = [{ type: "worker", worker_id: "tag-cut" }];
    cf.apps.set("links", {
      id: "links",
      aud: "aud-links",
      name: "Links admin",
      destinations: [{ type: "public", uri: "links.example.com" }],
      policies: [],
    });
    const taken = [{ uri: "links.example.com", app: "Links admin" }];
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again).toMatchObject({ outcome: "updated", taken, destinations: [OWN[0], OWN[2]] });
    expect(cf.apps.get(app.id)?.destinations).toEqual([OWN[0], OWN[2]]);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage).toMatchObject({
      destinations: [OWN[0], OWN[2]],
      taken,
    });
    // Its application deleted in the dashboard: made again, without that address.
    cf.apps.delete(app.id);
    const remade = await protectInstall(deps, { installId: INSTALL_ID });
    expect(remade).toMatchObject({ outcome: "created", taken });
    expect(cf.apps.get(remade.accessAppId)?.destinations).toEqual([OWN[0], OWN[2]]);
    // A new external domain another application names is still refused.
    cf.apps.set("go", {
      id: "go",
      aud: "aud-go",
      name: "Go",
      destinations: [{ type: "public", uri: "go.customer.net" }],
      policies: [],
    });
    await expect(
      protectInstall(deps, { installId: INSTALL_ID, pendingExternalHosts: ["go.customer.net"] }),
    ).rejects.toThrow(PROTECT_MESSAGES.conflict("Go", ["go.customer.net"]));
    // An app not protected yet is refused instead, so the admin decides (see above).
  });

  it("waits for another Access change (the lock) instead of interleaving", async () => {
    const { deps } = setup();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('access_lock', 'someone', ?1)",
    )
      .bind(Date.now())
      .run();
    await expect(protectInstall(deps, { installId: INSTALL_ID })).rejects.toThrow(
      ACCESS_MESSAGES.busy,
    );
  });
});

describe("syncInstallAccessDestinations", () => {
  it("does nothing for an app Appflare does not protect", async () => {
    const { cf, deps } = setup();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "not-protected",
      taken: [],
      warnings: [],
    });
    expect(cf.calls).toEqual([]);
  });

  it("writes only a change of destinations, keeping settings changed in the dashboard", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    app.session_duration = "8h";
    cf.calls.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "unchanged",
      taken: [],
      warnings: [],
    });
    // The account's applications are listed, the Access application itself not read.
    expect(cf.keys()).toEqual(["GET /access/apps"]);

    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', 'APP_I1', 'go.customer.net', NULL, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [],
    });
    const updated = cf.apps.get(app.id);
    expect(updated?.destinations).toEqual([
      ...OWN.slice(0, 2),
      { type: "public", uri: "go.customer.net" },
      OWN[2],
    ]);
    expect(updated?.session_duration).toBe("8h");
    expect(updated?.aud).toBe(app.aud);
    expect(updated?.policies.length).toBe(2);
    expect(cf.appPolicies.size).toBe(1);

    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 2 WHERE id = 'i1:custom_hostname:x'",
    ).run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [],
    });
    expect(cf.apps.get(app.id)?.destinations).toEqual(OWN);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.destinations).toEqual(OWN);
  });

  it("gives an app protected by an earlier version its hostnames with one rewrite", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    // What an earlier version wrote: the Worker alone.
    const before = [{ type: "worker", worker_id: "tag-cut" }];
    app.destinations = before;
    await env.DB.prepare("UPDATE install_access SET access_destinations_json = ?1")
      .bind(JSON.stringify({ destinations: before, workerTags: { cut: "tag-cut" } }))
      .run();
    cf.calls.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [],
    });
    expect(writes(cf)).toEqual([`PUT /access/apps/${app.id}`]);
    expect(cf.apps.get(app.id)).toMatchObject({ destinations: OWN, domain: HOST, aud: app.aud });
    cf.calls.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "unchanged",
      taken: [],
      warnings: [],
    });
    // The account's applications are listed, the Access application itself not read.
    expect(cf.keys()).toEqual(["GET /access/apps"]);
  });

  it("leaves out hostnames past Cloudflare's limit of destinations, with a warning", async () => {
    const { cf, deps } = setup();
    const { accessAppId } = await protectInstall(deps, { installId: INSTALL_ID });
    const domains = Array.from({ length: 55 }, (_, i) => `d${i}.example.com`);
    for (const domain of domains) {
      await env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, ?2, 'domain', NULL, ?3, NULL, 2)`,
      )
        .bind(`i1:domain:${domain}`, INSTALL_ID, domain)
        .run();
    }
    const result = await syncInstallAccessDestinations(deps, INSTALL_ID);
    // The Worker, then the workers.dev address and the domains in order while there is room.
    const left = [...domains, "links.example.com"].sort().slice(48);
    expect(result).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [PROTECT_MESSAGES.overLimit(left)],
    });
    const written = cf.apps.get(accessAppId)?.destinations as AccessDestination[];
    expect(written).toHaveLength(MAX_ACCESS_APP_DESTINATIONS);
    expect(written.at(-1)).toEqual({ type: "worker", worker_id: "tag-cut" });
    // Recorded, for the cron to watch.
    const overLimit = async () =>
      (await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.overLimit;
    expect(await overLimit()).toEqual(left);

    // A domain that was left out removed: nothing to write, the record follows.
    await env.DB.prepare("UPDATE resources SET deleted_at = 3 WHERE name = ?1").bind(left[0]).run();
    cf.calls.length = 0;
    expect((await syncInstallAccessDestinations(deps, INSTALL_ID)).outcome).toBe("unchanged");
    expect(writes(cf)).toEqual([]);
    expect(await overLimit()).toEqual(left.slice(1));
  });

  it("does not count an address left to another application toward the limit", async () => {
    const { cf, deps } = setup();
    const { accessAppId } = await protectInstall(deps, { installId: INSTALL_ID });
    const domains = Array.from({ length: 55 }, (_, i) => `d${i}.example.com`);
    for (const domain of domains) {
      await env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, ?2, 'domain', NULL, ?3, NULL, 2)`,
      )
        .bind(`i1:domain:${domain}`, INSTALL_ID, domain)
        .run();
    }
    cf.apps.set("admin", {
      id: "admin",
      aud: "aud-a",
      name: "Admin",
      destinations: [{ type: "public", uri: "d0.example.com" }],
      policies: [],
    });
    const sorted = [...domains, "links.example.com"].sort();
    expect(sorted[0]).toBe("d0.example.com");
    const result = await syncInstallAccessDestinations(deps, INSTALL_ID);
    expect(result).toEqual({
      outcome: "updated",
      taken: [{ uri: "d0.example.com", app: "Admin" }],
      warnings: [PROTECT_MESSAGES.overLimit(sorted.slice(49))],
    });
    const written = cf.apps.get(accessAppId)?.destinations as AccessDestination[];
    expect(written).toHaveLength(MAX_ACCESS_APP_DESTINATIONS);
    expect(written).not.toContainEqual({ type: "public", uri: "d0.example.com" });
  });

  it("covers the Workers by tag alone in an account without a workers.dev subdomain", async () => {
    const { cf, deps } = setup();
    await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
      .bind(SETTING.accountSubdomain)
      .run();
    const client = {
      ...cf.client,
      workers: { ...cf.client.workers, getAccountSubdomain: async () => ({ subdomain: "" }) },
    };
    await protectInstall({ ...deps, client }, { installId: INSTALL_ID });
    const only = [
      { type: "public", uri: "links.example.com" },
      { type: "worker", worker_id: "tag-cut" },
    ];
    expect([...cf.apps.values()][0]?.destinations).toEqual(only);
    expect(await syncInstallAccessDestinations({ ...deps, client }, INSTALL_ID)).toEqual({
      outcome: "unchanged",
      taken: [],
      warnings: [],
    });
  });
});

describe("syncInstallAccessDestinations and another application on an address", () => {
  /** An app protected by an earlier version (its Worker alone), next to `others`. */
  async function protectedEarlier(others: Array<{ id: string; name: string; uri: string }>) {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    const before = [{ type: "worker", worker_id: "tag-cut" }];
    app.destinations = before;
    await env.DB.prepare(
      "UPDATE install_access SET access_destinations_json = ?1, access_resync_due_at = 5",
    )
      .bind(JSON.stringify({ destinations: before, workerTags: { cut: "tag-cut" } }))
      .run();
    for (const o of others) {
      const destinations = [{ type: "public", uri: o.uri }];
      cf.apps.set(o.id, { id: o.id, aud: `aud-${o.id}`, name: o.name, destinations, policies: [] });
    }
    cf.calls.length = 0;
    return { cf, deps, app };
  }

  it("leaves an address another application names itself to it, keeping the Worker, once", async () => {
    const { cf, deps, app } = await protectedEarlier([
      { id: "links", name: "Links admin", uri: "links.example.com" },
      { id: "team", name: "Workers", uri: WILDCARD },
    ]);
    const taken = [{ uri: "links.example.com", app: "Links admin" }];
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken,
      warnings: [],
    });
    // Written once, without the address the other application names, and with the
    // previews' pattern the wildcard covers too.
    expect(cf.keys()).toEqual([
      "GET /access/apps",
      // Whether another Worker's name ends like the app's, for the previews' pattern.
      "GET /workers/scripts",
      `GET /access/apps/${app.id}`,
      `PUT /access/apps/${app.id}`,
    ]);
    const left = [OWN[0], PREVIEWS, OWN[2]];
    expect(cf.apps.get(app.id)?.destinations).toEqual(left);
    expect(cf.apps.get(app.id)?.aud).toBe(app.aud);
    const protection = await readInstallProtection(env.DB, INSTALL_ID);
    expect(protection?.coverage).toMatchObject({ destinations: left, taken });
    // Done: the cron does not try again, nor does the next sync write.
    expect(protection).toMatchObject({ syncFailedAt: null, resyncDueAt: null });
    cf.calls.length = 0;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "unchanged",
      taken: [],
      warnings: [],
    });
    // The account's applications and Workers are listed, the Access application not read.
    expect(cf.keys()).toEqual(["GET /access/apps", "GET /workers/scripts"]);
    expect(PROTECT_MESSAGES.taken("Links admin", ["links.example.com"])).toBe(
      'The Cloudflare Access application "Links admin" covers links.example.com itself, so it decides who reaches this app there and may refuse Appflare\'s health checks; Appflare\'s application covers the app\'s other addresses. Delete "Links admin" under Zero Trust, Access, Applications, and Appflare covers that address again within 30 minutes.',
    );

    // A change of addresses tries the address again, and leaves it again.
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:custom_hostname:x', ?1, 'custom_hostname', 'APP_I1', 'go.customer.net', 'z/ch', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken,
      warnings: [],
    });
    expect(cf.apps.get(app.id)?.destinations).toContainEqual({
      type: "public",
      uri: "go.customer.net",
    });
    // Once the other application is gone, it is covered again.
    cf.apps.delete("links");
    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 2 WHERE id = 'i1:custom_hostname:x'",
    ).run();
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [],
      warnings: [],
    });
    expect(cf.apps.get(app.id)?.destinations).toEqual([OWN[0], PREVIEWS, ...OWN.slice(1)]);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.taken).toEqual([]);
  });

  it("writes again without an address an application made since the listing names", async () => {
    const { cf, deps, app } = await protectedEarlier([]);
    // Made in the dashboard between the listing and the write.
    let listings = 0;
    const client = {
      ...cf.client,
      access: {
        ...cf.client.access,
        listApps: async () => {
          const listed = await cf.client.access.listApps();
          if (listings++ === 0) {
            cf.apps.set("links", {
              id: "links",
              aud: "aud-links",
              name: "Links admin",
              destinations: [{ type: "public", uri: "links.example.com" }],
              policies: [],
            });
          }
          return listed;
        },
      },
    };
    expect(await syncInstallAccessDestinations({ ...deps, client }, INSTALL_ID)).toEqual({
      outcome: "updated",
      taken: [{ uri: "links.example.com", app: "Links admin" }],
      warnings: [],
    });
    expect(cf.keys()).toEqual([
      "GET /access/apps",
      `GET /access/apps/${app.id}`,
      `PUT /access/apps/${app.id}`,
      "GET /access/apps",
      `PUT /access/apps/${app.id}`,
    ]);
    expect(cf.apps.get(app.id)?.destinations).toEqual([OWN[0], OWN[2]]);
  });

  it("leaves the version previews' pattern too, and never the Worker", async () => {
    const { cf, deps, app } = await protectedEarlier([
      { id: "previews", name: "Previews", uri: `*-${HOST}` },
      { id: "team", name: "Workers", uri: WILDCARD },
    ]);
    expect((await syncInstallAccessDestinations(deps, INSTALL_ID)).taken).toEqual([
      { uri: `*-${HOST}`, app: "Previews" },
    ]);
    expect(cf.apps.get(app.id)?.destinations).toEqual(OWN);

    // Another application on the Worker itself: nothing to leave, so the refusal stands.
    cf.apps.delete("previews");
    cf.apps.set("worker", {
      id: "worker",
      aud: "aud-w",
      name: "Cut by hand",
      destinations: [{ type: "worker", worker_id: "tag-cut" }],
      policies: [],
    });
    const written = cf.apps.get(app.id);
    if (written === undefined) throw new Error("no app");
    const elsewhere = [{ type: "worker", worker_id: "tag-elsewhere" }];
    written.destinations = elsewhere;
    await env.DB.prepare("UPDATE install_access SET access_destinations_json = NULL").run();
    await expect(syncInstallAccessDestinations(deps, INSTALL_ID)).rejects.toThrow(/409: \[12132\]/);
    expect(cf.apps.get(app.id)?.destinations).toEqual(elsewhere);
  });

  it("refuses an external domain about to be added that another application names, changing nothing", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const app = [...cf.apps.values()][0];
    cf.apps.set("go", {
      id: "go",
      aud: "aud-go",
      name: "Go",
      destinations: [{ type: "public", uri: "go.customer.net" }],
      policies: [],
    });
    await expect(
      syncInstallAccessDestinations(deps, INSTALL_ID, {
        pendingExternalHosts: ["go.customer.net"],
      }),
    ).rejects.toThrow(PROTECT_MESSAGES.conflict("Go", ["go.customer.net"]));
    expect(cf.apps.get(app?.id ?? "")?.destinations).toEqual(OWN);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.destinations).toEqual(OWN);
  });
});

describe("syncInstallAccessDestinations and a Worker it cannot find", () => {
  it("refuses instead of leaving the Worker uncovered", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:worker:cut-gone', ?1, 'worker', NULL, 'cut-gone', 'cut-gone', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    const before = [...cf.apps.values()][0]?.destinations;
    await expect(syncInstallAccessDestinations(deps, INSTALL_ID)).rejects.toThrow(
      PROTECT_MESSAGES.workerMissing("cut-gone"),
    );
    expect([...cf.apps.values()][0]?.destinations).toEqual(before);
  });
});

describe("resyncInstallAccessIfFailed", () => {
  it("takes failed and due installs in one queue, oldest first, and puts one that keeps failing behind the others", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    // Three installs whose applications are gone, marked before the one that works:
    // two failed, one only due.
    for (const [i, id, column] of [
      [1, "i2", "access_sync_failed_at"],
      [2, "i3", "access_resync_due_at"],
      [3, "i4", "access_sync_failed_at"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, status, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/cut.zip', ?2, 'installed', 1, 1)`,
      )
        .bind(id, String(i).repeat(64))
        .run();
      await env.DB.prepare(
        `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
           token_secret, ${column}, created_at, updated_at)
         VALUES (?1, ?2, 't', 'c', 's', ?3, 1, 1)`,
      )
        .bind(id, `gone-${id}`, i)
        .run();
    }
    await env.DB.prepare(
      "UPDATE install_access SET access_resync_due_at = 10 WHERE install_id = ?1",
    )
      .bind(INSTALL_ID)
      .run();
    const run = () =>
      resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client, now: () => NOW });
    expect((await run()).map((r) => [r.installId, r.outcome])).toEqual([
      ["i2", "failed"],
      ["i3", "failed"],
      ["i4", "failed"],
    ]);
    // The resync that was only due failed: now it is a failure, which the app's page shows.
    expect((await readInstallProtection(env.DB, "i3"))?.syncFailedAt).toEqual(NOW);
    const second = await run();
    expect(second[0]).toEqual({ installId: INSTALL_ID, outcome: "unchanged" });
    expect(second.slice(1).map((r) => r.outcome)).toEqual(["failed", "failed"]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: null,
    });
    expect((await readInstallProtection(env.DB, "i4"))?.syncFailedAt).toEqual(NOW);
  });
});

describe("resyncInstallAccessIfFailed and a deleted application", () => {
  it("leaves an install whose application was deleted to Protect again, marks kept", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    // The upkeep found the application deleted after it was marked due.
    cf.apps.clear();
    await env.DB.prepare(
      "UPDATE install_access SET access_resync_due_at = 10, access_app_missing_at = 20",
    ).run();
    const before = cf.keys().length;
    expect(
      await resyncInstallAccessIfFailed({
        db: env.DB,
        client: async () => cf.client,
        now: () => NOW,
      }),
    ).toEqual([]);
    expect(cf.keys().length).toBe(before);
    // No failure: the page says the application was deleted, nothing else.
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: new Date(10),
      appMissingAt: new Date(20),
    });
  });
});

describe("resyncInstallAccessIfFailed and another Access change", () => {
  it("leaves the installs as they were for the next run, instead of failing them", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare("UPDATE install_access SET access_resync_due_at = 10").run();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
         artifact_url, artifact_digest, status, installed_at, updated_at)
       VALUES ('i2', 'cut', 'i2', 'i2', '1.0.0', 'https://artifacts.test/cut.zip', ?1, 'installed', 1, 1)`,
    )
      .bind("2".repeat(64))
      .run();
    await env.DB.prepare(
      `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
         token_secret, access_sync_failed_at, created_at, updated_at)
       VALUES ('i2', 'gone-i2', 't', 'c', 's', 20, 1, 1)`,
    ).run();
    // A job holds the lock.
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('access_lock', 'a job', ?1)",
    )
      .bind(Date.now())
      .run();
    const run = () =>
      resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client, now: () => NOW });
    // The first meets the lock; the rest are not tried.
    expect(await run()).toEqual([{ installId: INSTALL_ID, outcome: "busy" }]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: new Date(10),
    });
    expect((await readInstallProtection(env.DB, "i2"))?.syncFailedAt).toEqual(new Date(20));
    await env.DB.prepare("DELETE FROM settings WHERE key = 'access_lock'").run();
    expect((await run()).map((r) => [r.installId, r.outcome])).toEqual([
      [INSTALL_ID, "unchanged"],
      ["i2", "failed"],
    ]);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: null,
    });
  });
});

describe("unprotectInstall", () => {
  it("deletes the application, then the token, then the unused users policy, and forgets them", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    cf.calls.length = 0;
    const removed = await unprotectInstall(deps, INSTALL_ID);
    expect(removed).toEqual({ removed: true, usersPolicy: "removed" });
    expect(writes(cf).map((k) => k.replace(/\/[^/]+$/, "/<id>"))).toEqual([
      "DELETE /access/apps/<id>",
      "DELETE /access/service_tokens/<id>",
      "DELETE /access/policies/<id>",
    ]);
    expect(cf.apps.size + cf.tokens.size + cf.policies.size + cf.appPolicies.size).toBe(0);
    expect(await readInstallAccess(env.DB, INSTALL_ID)).toBeNull();
    expect((await resourceRows("access_app"))[0]?.deleted_at).not.toBeNull();
    expect((await resourceRows("access_service_token"))[0]?.deleted_at).not.toBeNull();
    const s = await readSettings(createDb(env.DB), [SETTING.appAccessUsersPolicyId]);
    expect(s.app_access_users_policy_id).toBeFalsy();
    // Again: nothing left to do.
    expect(await unprotectInstall(deps, INSTALL_ID)).toEqual({ removed: false, usersPolicy: null });
  });

  it("finds an application whose creation was not recorded, so the token can go", async () => {
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      "UPDATE install_access SET access_app_id = NULL, probes_policy_id = NULL",
    ).run();
    const removed = await unprotectInstall(deps, INSTALL_ID);
    expect(removed.removed).toBe(true);
    expect(cf.apps.size + cf.tokens.size).toBe(0);
  });
});
