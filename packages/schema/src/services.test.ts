import { describe, expect, it } from "vitest";
import {
  appServices,
  deriveServices,
  isServiceId,
  requirementService,
  SERVICE_IDS,
  type ServiceCatalogFacts,
} from "./services";

describe("deriveServices", () => {
  it("reads bindings, queue consumers and crons of an artifact (FlareMo's shape)", () => {
    const services = deriveServices({
      bindings: [
        { type: "d1" },
        { type: "r2_bucket" },
        { type: "queue" },
        { type: "vectorize" },
        { type: "ratelimit" },
        { type: "ai" },
        { type: "plain_text" },
      ],
      crons: ["17 3 * * *"],
      queueConsumers: [{ queue: { binding: "Q" } }],
      requires: ["r2", "workers-ai"],
    });
    expect(services).toEqual({
      ids: ["d1", "r2", "vectorize", "queues", "cron", "workers-ai"],
      keyValueDurableObjects: false,
    });
  });

  it("names Email Routing and a domain for mail apps (send_email binding, install.emailRouting)", () => {
    expect(deriveServices({ bindings: [{ type: "send_email" }] }).ids).toEqual(["email-routing"]);
    expect(deriveServices({ emailRouting: true }).ids).toEqual(["email-routing", "zone"]);
  });

  it("names Analytics Engine for a dataset binding and for the requirement", () => {
    expect(deriveServices({ bindings: [{ type: "analytics_engine" }] }).ids).toEqual([
      "analytics-engine",
    ]);
    expect(deriveServices({ requires: ["analytics-engine", "r2"] }).ids).toEqual([
      "r2",
      "analytics-engine",
    ]);
    expect(requirementService("analytics-engine")).toBe("analytics-engine");
  });

  it("reads what a token may touch: zone-scoped groups, DNS, Access, storage", () => {
    // unifi-ddns: no bindings, a token that edits DNS.
    expect(deriveServices({ tokenPermissions: [{ name: "Zone.DNS", scope: "zone" }] }).ids).toEqual(
      ["zone"],
    );
    // OpenSEO's installer token.
    expect(
      deriveServices({
        requires: ["r2", "containers"],
        tokenPermissions: [
          { name: "Workers Scripts", scope: "account" },
          { name: "Workers KV Storage", scope: "account" },
          { name: "D1", scope: "account" },
          { name: "Workers R2 Storage", scope: "account" },
          { name: "Secrets Store:Edit", scope: "account" },
          { name: "Account Settings:Read", scope: "account" },
          { name: "Access: Apps and Policies", scope: "account" },
        ],
      }).ids,
    ).toEqual(["kv", "d1", "r2", "containers", "access"]);
  });

  it("flags key-value backed Durable Objects, and not SQLite-backed ones", () => {
    const sqlite = deriveServices({
      bindings: [{ type: "durable_object_namespace" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    });
    expect(sqlite.keyValueDurableObjects).toBe(false);
    const kv = deriveServices({ migrations: [{ tag: "v1", new_classes: ["Room"] }] });
    expect(kv).toEqual({ ids: ["durable-objects"], keyValueDurableObjects: true });
  });

  it("lists each service once, in display order, and nothing for a bare Worker", () => {
    const services = deriveServices({
      bindings: [{ type: "queue" }, { type: "kv_namespace" }, { type: "queue" }],
      queueConsumers: [{}],
    });
    expect(services.ids).toEqual(["kv", "queues"]);
    expect(deriveServices({ bindings: [] }).ids).toEqual([]);
  });

  it("maps every known requirement and knows its own ids", () => {
    expect(requirementService("email-routing")).toBe("email-routing");
    expect(requirementService("something-new")).toBeNull();
    for (const id of SERVICE_IDS) expect(isServiceId(id)).toBe(true);
    expect(isServiceId("something-new")).toBe(false);
  });
});

describe("appServices", () => {
  const catalog: ServiceCatalogFacts = {
    requires: ["zone"],
    tokenPermissions: [],
    install: { emailRouting: { catchAll: true } } as ServiceCatalogFacts["install"],
  };

  it("reads an artifact's Worker together with its catalog manifest (mail2telegram's shape)", () => {
    const worker = {
      bindings: [
        { type: "d1", name: "DB" },
        { type: "r2_bucket", name: "BUCKET" },
        { type: "ai", name: "AI" },
      ],
      migrations: [],
      crons: ["0 3 * * *"],
    } as unknown as Parameters<typeof appServices>[1];
    expect(appServices({ ...catalog, requires: ["r2"] }, worker)).toEqual({
      ids: ["d1", "r2", "cron", "workers-ai", "email-routing", "zone"],
      keyValueDurableObjects: false,
    });
  });

  it("reads only what a catalog manifest declares when there is no Worker", () => {
    expect(appServices(catalog, null).ids).toEqual(["email-routing", "zone"]);
    expect(
      appServices(
        {
          requires: [],
          tokenPermissions: [],
          install: {},
          resources: { vectorize: { INDEX: { dimensions: 768, metric: "cosine" } } },
        },
        null,
      ).ids,
    ).toEqual(["vectorize"]);
  });
});
