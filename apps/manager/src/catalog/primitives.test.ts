import { describe, expect, it } from "vitest";
import {
  type CapabilitiesView,
  capabilitiesView,
  type StoredCapabilities,
} from "../capabilities/capabilities";
import {
  derivePrimitives,
  PRIMITIVE_IDS,
  PRIMITIVE_LABELS,
  primitiveStatus,
  primitiveStatuses,
  primitivesNote,
  requirementPrimitive,
  workersPaidStatus,
} from "./primitives";

function stored(overrides: Partial<StoredCapabilities> = {}): StoredCapabilities {
  return {
    checkedAt: "2026-09-24T12:00:00.000Z",
    r2: { state: "enabled" },
    containers: { state: "available" },
    workersPlan: { state: "paid" },
    ...overrides,
  };
}

const unknownProbe = { state: "unknown", reason: "no-permission", detail: "403" } as const;
const NOTHING_KNOWN: CapabilitiesView = capabilitiesView(null, null);

describe("derivePrimitives", () => {
  it("reads bindings, queue consumers and crons of an artifact (FlareMo's shape)", () => {
    const primitives = derivePrimitives({
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
      complete: true,
    });
    expect(primitives).toEqual({
      ids: ["d1", "r2", "vectorize", "queues", "cron", "workers-ai"],
      complete: true,
      keyValueDurableObjects: false,
    });
  });

  it("names Email Routing and a domain for mail apps (send_email binding, install.emailRouting)", () => {
    expect(derivePrimitives({ bindings: [{ type: "send_email" }], complete: true }).ids).toEqual([
      "email-routing",
    ]);
    expect(derivePrimitives({ emailRouting: true, complete: true }).ids).toEqual([
      "email-routing",
      "zone",
    ]);
  });

  it("reads what a token may touch: zone-scoped groups, DNS, Access, storage", () => {
    // unifi-ddns: no bindings, a token that edits DNS.
    expect(
      derivePrimitives({
        tokenPermissions: [{ name: "Zone.DNS", scope: "zone" }],
        complete: true,
      }).ids,
    ).toEqual(["zone"]);
    // OpenSEO's installer token.
    expect(
      derivePrimitives({
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
        complete: false,
      }).ids,
    ).toEqual(["kv", "d1", "r2", "containers", "access"]);
  });

  it("flags key-value backed Durable Objects, and not SQLite-backed ones", () => {
    const sqlite = derivePrimitives({
      bindings: [{ type: "durable_object_namespace" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
      complete: true,
    });
    expect(sqlite.keyValueDurableObjects).toBe(false);
    const kv = derivePrimitives({
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
      complete: true,
    });
    expect(kv).toEqual({ ids: ["durable-objects"], complete: true, keyValueDurableObjects: true });
  });

  it("lists each primitive once, in display order, and nothing for a bare Worker", () => {
    const primitives = derivePrimitives({
      bindings: [{ type: "queue" }, { type: "kv_namespace" }, { type: "queue" }],
      queueConsumers: [{}],
      complete: true,
    });
    expect(primitives.ids).toEqual(["kv", "queues"]);
    expect(derivePrimitives({ bindings: [], complete: true }).ids).toEqual([]);
  });

  it("has a label for every primitive and maps every known requirement", () => {
    for (const id of PRIMITIVE_IDS) expect(PRIMITIVE_LABELS[id].length).toBeGreaterThan(0);
    expect(requirementPrimitive("email-routing")).toBe("email-routing");
    expect(requirementPrimitive("something-new")).toBeNull();
  });
});

describe("primitiveStatus", () => {
  const plain = { keyValueDurableObjects: false };

  it("marks what every plan includes as available, whatever the probes say", () => {
    for (const id of ["kv", "d1", "queues", "workflows", "vectorize", "cron"] as const) {
      expect(primitiveStatus(id, NOTHING_KNOWN, plain).availability).toBe("available");
      expect(primitiveStatus(id, null, plain).availability).toBe("available");
    }
    expect(primitiveStatus("durable-objects", null, plain).availability).toBe("available");
  });

  it("follows the R2 probe", () => {
    const enabled = capabilitiesView(null, stored());
    const off = capabilitiesView(null, stored({ r2: { state: "not-enabled" } }));
    const unknown = capabilitiesView(null, stored({ r2: unknownProbe }));
    expect(primitiveStatus("r2", enabled, plain).availability).toBe("available");
    expect(primitiveStatus("r2", off, plain)).toMatchObject({
      availability: "unavailable",
      reason: expect.stringMatching(/not enabled/),
    });
    expect(primitiveStatus("r2", unknown, plain).availability).toBe("unknown");
    expect(primitiveStatus("r2", NOTHING_KNOWN, plain).availability).toBe("unknown");
  });

  it("follows the Containers probe, then the plan", () => {
    const needsPaid = capabilitiesView(
      null,
      stored({ containers: { state: "needs-workers-paid" }, workersPlan: unknownProbe }),
    );
    expect(primitiveStatus("containers", needsPaid, plain).availability).toBe("unavailable");
    const byPlan = capabilitiesView(null, stored({ containers: unknownProbe }));
    expect(primitiveStatus("containers", byPlan, plain).availability).toBe("available");
    const setByAdmin = capabilitiesView(
      "paid",
      stored({ containers: unknownProbe, workersPlan: unknownProbe }),
    );
    expect(primitiveStatus("containers", setByAdmin, plain)).toMatchObject({
      availability: "available",
      reason: "Needs Workers Paid, set in Settings.",
    });
    expect(primitiveStatus("containers", NOTHING_KNOWN, plain).availability).toBe("unknown");
  });

  it("needs Workers Paid for key-value Durable Objects only", () => {
    const free = capabilitiesView(
      null,
      stored({ workersPlan: { state: "free" }, containers: { state: "needs-workers-paid" } }),
    );
    expect(primitiveStatus("durable-objects", free, plain).availability).toBe("available");
    expect(
      primitiveStatus("durable-objects", free, { keyValueDurableObjects: true }).availability,
    ).toBe("unavailable");
  });

  it("leaves domains, Email Routing and Access unknown: nothing probes them", () => {
    const everything = capabilitiesView(null, stored());
    for (const id of ["zone", "email-routing", "access"] as const) {
      expect(primitiveStatus(id, everything, plain)).toMatchObject({
        availability: "unknown",
        reason: expect.stringMatching(/does not check/),
      });
    }
  });

  it("treats an admin's Free as unknown and a detected Free as not available", () => {
    expect(workersPaidStatus(capabilitiesView("free", null)).availability).toBe("unknown");
    const detectedFree = stored({
      workersPlan: { state: "free" },
      containers: { state: "needs-workers-paid" },
    });
    expect(workersPaidStatus(capabilitiesView(null, detectedFree)).availability).toBe(
      "unavailable",
    );
    expect(workersPaidStatus(null).availability).toBe("unknown");
  });

  it("gives one status per primitive, in order", () => {
    const statuses = primitiveStatuses(
      { ids: ["kv", "r2", "zone"], complete: true, keyValueDurableObjects: false },
      capabilitiesView(null, stored({ r2: { state: "not-enabled" } })),
    );
    expect(statuses.map((s) => [s.id, s.availability])).toEqual([
      ["kv", "available"],
      ["r2", "unavailable"],
      ["zone", "unknown"],
    ]);
  });
});

describe("primitivesNote", () => {
  it("says why a list may be incomplete, per tier", () => {
    expect(primitivesNote({ complete: true }, "artifact")).toBeNull();
    expect(primitivesNote({ complete: false }, "artifact")).toMatch(/not read/);
    expect(primitivesNote({ complete: false }, "sandbox")).toMatch(/once it is built/);
    expect(primitivesNote({ complete: false }, "self-deploying")).toMatch(/installer/);
  });
});
