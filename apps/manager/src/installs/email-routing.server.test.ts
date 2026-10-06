import { createClient } from "@appflare/cf-api";
import type { CatalogEmailRouting } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { type EmailWorld, fakeEmailRouting, ZONE_ID, ZONE_NAME } from "../test/fake-email-routing";
import {
  getEmailZoneOptionsCore,
  inspectEmailRouting,
  previewEmailRoutingCore,
  releaseEmailRouting,
  removeEmailRule,
  resetEmailCatchAll,
} from "./email-routing.server";

const ACC = "acc0000000000000000000000000000a";
const TOKEN = "cf-test-token-DO-NOT-LEAK";

function setup(over: Partial<EmailWorld> = {}, zones?: unknown[]) {
  const fake = fakeEmailRouting(ACC, over);
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const handled = await fake.handle(request);
    if (handled !== null) return handled;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/client/v4/zones") {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: zones ?? [fake.world.zone],
        result_info: { page: 1, total_pages: 1 },
      });
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: "no route" }] },
      { status: 404 },
    );
  };
  const api = createClient({ accountId: ACC, token: TOKEN, fetch });
  return { ...fake, api };
}

const inspect = (
  api: ReturnType<typeof setup>["api"],
  config: CatalogEmailRouting,
  zoneId = ZONE_ID,
) => inspectEmailRouting(api, { zoneId, config, workerName: "inbox" });

describe("inspectEmailRouting", () => {
  it("plans routing, rules and catch-all on a clean zone", async () => {
    const { api, world } = setup();
    const got = await inspect(api, { rules: ["inbox"], catchAll: true });
    expect(got).toMatchObject({
      zoneId: ZONE_ID,
      zoneName: ZONE_NAME,
      routing: { enabled: false, status: "unconfigured" },
      addresses: [{ address: "inbox@example.com", existingRuleId: null }],
      wantsCatchAll: true,
      catchAll: {
        state: "free",
        action: "drop",
        previous: { enabled: false, actions: [{ type: "drop" }] },
      },
      foreignMx: [],
      problems: [],
      missing: [],
    });
    // Read only.
    expect(world.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("skips the DNS read when routing is already on", async () => {
    const { api, world } = setup({ routingEnabled: true });
    const got = await inspect(api, { catchAll: false, rules: ["inbox"] });
    expect(got.routing?.enabled).toBe(true);
    expect(world.calls.some((c) => c.includes("dns_records"))).toBe(false);
    expect(world.calls.some((c) => c.includes("catch_all"))).toBe(false);
  });

  it("refuses a zone whose mail goes to another provider", async () => {
    const { api } = setup({
      records: [{ id: "mx", type: "MX", name: ZONE_NAME, content: "aspmx.l.google.com" }],
    });
    const got = await inspect(api, { rules: [], catchAll: true });
    expect(got.foreignMx).toEqual(["aspmx.l.google.com"]);
    expect(got.problems.join(" ")).toContain("receives its mail elsewhere");
  });

  it("refuses an address that already has a rule elsewhere, and reuses one of its own", async () => {
    const { api } = setup({
      routingEnabled: true,
      rules: [
        {
          id: "r-other",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "INBOX@example.com" }],
          actions: [{ type: "forward", value: ["me@example.net"] }],
        },
        {
          id: "r-ours",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "bills@example.com" }],
          actions: [{ type: "worker", value: ["inbox"] }],
        },
      ],
    });
    const got = await inspect(api, { catchAll: false, rules: ["inbox", "bills"] });
    const conflict =
      "inbox@example.com already has a routing rule (forwarding to me@example.net). Appflare does not replace it; delete the rule in the Cloudflare dashboard or choose another zone.";
    // The conflict is named on its address too, so an update can leave out that one alone.
    expect(got.addresses).toEqual([
      { address: "inbox@example.com", existingRuleId: null, conflict },
      { address: "bills@example.com", existingRuleId: "r-ours" },
    ]);
    expect(got.problems).toEqual([conflict]);
  });

  it("refuses a catch-all that already delivers elsewhere, but not drop or its own", async () => {
    const taken = setup({
      catchAll: {
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "forward", value: ["me@example.net"] }],
      },
    });
    const takenInspection = await inspect(taken.api, { rules: [], catchAll: true });
    expect(takenInspection.catchAll?.state).toBe("taken");
    expect(takenInspection.catchAll?.problem).toBeDefined();
    expect(takenInspection.problems).toEqual([takenInspection.catchAll?.problem]);
    const dropping = setup({
      catchAll: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
    });
    expect((await inspect(dropping.api, { rules: [], catchAll: true })).problems).toEqual([]);
    const ours = setup({
      catchAll: {
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: ["inbox"] }],
      },
    });
    expect((await inspect(ours.api, { rules: [], catchAll: true })).catchAll?.state).toBe("ours");
  });

  it("refuses a zone of another account, a paused one, and one without Cloudflare DNS", async () => {
    const other = setup({
      zone: {
        id: ZONE_ID,
        name: ZONE_NAME,
        status: "active",
        type: "full",
        account: { id: "someone" },
      },
    });
    expect((await inspect(other.api, { rules: [], catchAll: true })).problems[0]).toContain(
      "belongs to another Cloudflare account",
    );
    const partial = setup({
      zone: {
        id: ZONE_ID,
        name: ZONE_NAME,
        status: "pending",
        type: "partial",
        account: { id: ACC },
      },
    });
    const problems = (await inspect(partial.api, { rules: [], catchAll: true })).problems.join(" ");
    expect(problems).toContain("not active");
    expect(problems).toContain("does not use Cloudflare DNS");
  });

  it("refuses an address outside the chosen zone", async () => {
    const { api } = setup();
    const got = await inspect(api, { catchAll: false, rules: ["inbox@other.org"] });
    expect(got.problems[0]).toContain("not an address at example.com");
  });

  it("reports missing permissions by name instead of failing", async () => {
    const { api } = setup({
      forbidden: [`/zones/${ZONE_ID}/email/routing`, `/zones/${ZONE_ID}/dns_records`],
    });
    const got = await inspect(api, { rules: ["inbox"], catchAll: true });
    expect(got.missing).toEqual(["Zone Settings: Edit", "Email Routing Rules: Edit"]);
    expect(got.addresses).toEqual([{ address: "inbox@example.com", existingRuleId: null }]);
    const unseen = await inspect(
      api,
      { rules: [], catchAll: true },
      "ffffffffffffffffffffffffffffffff",
    );
    expect(unseen.missing).toEqual(["Zone: Read"]);
    expect(unseen.problems).toEqual(["The Cloudflare token cannot see that zone."]);
  });

  it("refuses more rules than a domain holds", async () => {
    const rules = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: `box${i}@example.com` }],
      actions: [{ type: "drop" }],
    }));
    const { api, world } = setup({ routingEnabled: true, rules });
    const got = await inspect(api, { catchAll: false, rules: ["inbox"] });
    expect(got.problems[0]).toContain("limit of 200");
    // Every page of rules was read: four of 50, stopping at the reported total.
    expect(world.calls.filter((c) => c.endsWith("/rules")).length).toBe(4);
  });
});

describe("zone options and preview", () => {
  it("offers this account's active zones only", async () => {
    const { api } = setup({}, [
      { id: "z2", name: "b.example", status: "active", account: { id: ACC } },
      { id: "z1", name: "a.example", status: "active", account: { id: ACC } },
      { id: "z3", name: "c.example", status: "pending", account: { id: ACC } },
      { id: "z4", name: "d.example", status: "active", account: { id: "someone" } },
    ]);
    expect(await getEmailZoneOptionsCore(api)).toEqual({
      zones: [
        { id: "z1", name: "a.example" },
        { id: "z2", name: "b.example" },
      ],
      inactiveZones: ["c.example"],
      noZones: false,
    });
    const empty = setup({}, []);
    expect((await getEmailZoneOptionsCore(empty.api)).noZones).toBe(true);
  });

  it("lists verified destination addresses for an app that sends email", async () => {
    const { api } = setup({
      addresses: [
        { id: "a1", email: "me@example.net", verified: "2026-01-01T00:00:00Z" },
        { id: "a2", email: "new@example.net", verified: null },
      ],
    });
    const fixture = await buildArtifactFixture({
      catalog: baseCatalog({
        install: { ...baseCatalog().install, emailRouting: { catchAll: true } },
      }),
      bindings: [{ type: "send_email", name: "EMAIL" }],
    });
    const preview = await previewEmailRoutingCore(api, {
      catalog: fixture.manifest.catalog,
      bindings: fixture.manifest.worker.bindings,
      zoneId: ZONE_ID,
      workerName: "inbox",
    });
    expect(preview.enablesRouting).toBe(true);
    expect(preview.sendsEmail).toBe(true);
    expect(preview.destinations).toEqual(["me@example.net"]);
  });

  it("warns instead of failing when the token cannot list destination addresses", async () => {
    const { api } = setup({ forbidden: [`/accounts/${ACC}/email/routing/addresses`] });
    const fixture = await buildArtifactFixture({
      catalog: baseCatalog({
        install: { ...baseCatalog().install, emailRouting: { rules: ["inbox"] } },
      }),
      bindings: [{ type: "send_email", name: "EMAIL" }],
    });
    const preview = await previewEmailRoutingCore(api, {
      catalog: fixture.manifest.catalog,
      bindings: fixture.manifest.worker.bindings,
      zoneId: ZONE_ID,
      workerName: "inbox",
    });
    expect(preview.destinations).toBeNull();
    expect(preview.warnings.join(" ")).toContain("Email Routing Addresses: Read");
    expect(preview.problems).toEqual([]);
  });

  it("previews a sandbox tier entry, which has no built artifact yet", async () => {
    const { api, world } = setup({
      addresses: [{ id: "a1", email: "me@example.net", verified: "2026-01-01T00:00:00Z" }],
    });
    const catalog = baseCatalog({
      install: {
        ...baseCatalog().install,
        tier: "sandbox",
        emailRouting: { rules: ["inbox"], catchAll: true },
      },
    });
    const preview = await previewEmailRoutingCore(api, {
      catalog,
      bindings: null,
      zoneId: ZONE_ID,
      workerName: "inbox",
    });
    expect(preview.problems).toEqual([]);
    expect(preview.missing).toEqual([]);
    expect(preview.enablesRouting).toBe(true);
    expect(preview.addresses).toEqual([{ address: "inbox@example.com", existingRuleId: null }]);
    expect(preview.catchAll?.state).toBe("free");
    // Whether it sends email is known only once it is built; nothing is asked of the account for it.
    expect(preview.sendsEmail).toBeNull();
    expect(preview.destinations).toBeNull();
    expect(world.calls.some((c) => c.includes("/email/routing/addresses"))).toBe(false);
  });

  it("refuses to preview an app that does not receive email", async () => {
    const { api } = setup();
    const fixture = await buildArtifactFixture();
    await expect(
      previewEmailRoutingCore(api, {
        catalog: fixture.manifest.catalog,
        bindings: fixture.manifest.worker.bindings,
        zoneId: ZONE_ID,
        workerName: "cut",
      }),
    ).rejects.toThrow("does not receive email");
  });
});

describe("undoing an install's email routes", () => {
  it("deletes a rule, and counts one already gone as removed", async () => {
    const { api, world } = setup({
      rules: [{ id: "r1", enabled: true, matchers: [], actions: [] }],
    });
    expect(await removeEmailRule(api, { zoneId: ZONE_ID, ruleId: "r1" })).toBe("deleted");
    expect(world.rules).toEqual([]);
    expect(await removeEmailRule(api, { zoneId: ZONE_ID, ruleId: "r1" })).toBe("gone");
  });

  it("restores the catch-all only while it still delivers to the Worker", async () => {
    const ours = {
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["inbox"] }],
    };
    const { api, world } = setup({ catchAll: ours });
    const previous = { enabled: false, actions: [{ type: "forward", value: ["me@example.net"] }] };
    expect(await resetEmailCatchAll(api, { zoneId: ZONE_ID, workerName: "other", previous })).toBe(
      "not-ours",
    );
    expect(world.catchAll.enabled).toBe(true);
    expect(await resetEmailCatchAll(api, { zoneId: ZONE_ID, workerName: "inbox", previous })).toBe(
      "restored",
    );
    expect(world.catchAll).toEqual({
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["me@example.net"] }],
    });
    // Without a record of the catch-all before, it goes back to drop and off.
    world.catchAll = ours;
    expect(
      await resetEmailCatchAll(api, { zoneId: ZONE_ID, workerName: "inbox", previous: null }),
    ).toBe("restored");
    expect(world.catchAll).toEqual({
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
  });

  it("turns routing off only when nothing else uses it", async () => {
    const busy = setup({
      routingEnabled: true,
      rules: [
        {
          id: "r9",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "x@example.com" }],
          actions: [{ type: "drop" }],
        },
      ],
    });
    expect(await releaseEmailRouting(busy.api, ZONE_ID)).toEqual({
      outcome: "in-use",
      rules: 1,
      catchAll: false,
    });
    expect(busy.world.routingEnabled).toBe(true);

    const catchAll = setup({
      routingEnabled: true,
      catchAll: {
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "forward", value: ["me@example.net"] }],
      },
    });
    expect((await releaseEmailRouting(catchAll.api, ZONE_ID)).outcome).toBe("in-use");

    const idle = setup({ routingEnabled: true });
    expect(await releaseEmailRouting(idle.api, ZONE_ID)).toEqual({ outcome: "disabled" });
    expect(idle.world.routingEnabled).toBe(false);
    expect(idle.world.calls.at(-1)).toBe(`DELETE /zones/${ZONE_ID}/email/routing/dns`);

    const off = setup({ routingEnabled: false });
    expect(await releaseEmailRouting(off.api, ZONE_ID)).toEqual({ outcome: "already-off" });
  });
});
