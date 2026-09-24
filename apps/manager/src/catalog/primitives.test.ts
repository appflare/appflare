import { describe, expect, it } from "vitest";
import {
  type CapabilitiesView,
  capabilitiesView,
  type StoredCapabilities,
} from "../capabilities/capabilities";
import {
  derivePrimitives,
  indexPrimitives,
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

// How services are worked out from manifests is tested in @appflare/schema.
describe("derivePrimitives", () => {
  it("adds whether the sources name everything", () => {
    expect(derivePrimitives({ requires: ["r2"], crons: ["0 1 * * *"], complete: false })).toEqual({
      ids: ["r2", "cron"],
      complete: false,
      keyValueDurableObjects: false,
    });
  });

  it("has a label for every primitive and maps every known requirement", () => {
    for (const id of PRIMITIVE_IDS) expect(PRIMITIVE_LABELS[id].length).toBeGreaterThan(0);
    expect(requirementPrimitive("email-routing")).toBe("email-routing");
    expect(requirementPrimitive("something-new")).toBeNull();
  });
});

describe("indexPrimitives", () => {
  it("reads the services an index row publishes, in display order, skipping unknown ids", () => {
    expect(
      indexPrimitives({ tier: "artifact", services: ["zone", "d1", "a-service-added-later"] }),
    ).toEqual({ ids: ["d1", "zone"], complete: true, keyValueDurableObjects: false });
    expect(
      indexPrimitives({
        tier: "artifact",
        services: ["durable-objects"],
        keyValueDurableObjects: true,
      })?.keyValueDurableObjects,
    ).toBe(true);
  });

  it("marks a row of an app that is not a prebuilt artifact as incomplete", () => {
    expect(indexPrimitives({ tier: "self-deploying", services: ["r2"] })?.complete).toBe(false);
    expect(indexPrimitives({ tier: "sandbox", services: [] })?.complete).toBe(false);
  });

  it("is null for a row written before the index published services", () => {
    expect(indexPrimitives({ tier: "artifact" })).toBeNull();
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

  it("follows the zone and Email Routing probes", () => {
    const found = capabilitiesView(
      null,
      stored({ zone: { state: "available" }, emailRouting: { state: "available" } }),
    );
    expect(primitiveStatus("zone", found, plain)).toMatchObject({
      availability: "available",
      reason: expect.stringMatching(/^Detected/),
    });
    expect(primitiveStatus("email-routing", found, plain).availability).toBe("available");

    const none = capabilitiesView(
      null,
      stored({ zone: { state: "none" }, emailRouting: { state: "no-zone" } }),
    );
    expect(primitiveStatus("zone", none, plain).availability).toBe("unavailable");
    expect(primitiveStatus("email-routing", none, plain)).toMatchObject({
      availability: "unavailable",
      reason: expect.stringMatching(/no active zone in this account/),
    });

    // A zone the token sees, whose Email Routing it may not read.
    const refused = capabilitiesView(
      null,
      stored({ zone: { state: "available" }, emailRouting: unknownProbe }),
    );
    expect(primitiveStatus("email-routing", refused, plain).availability).toBe("unknown");

    // Rows stored before the domain probes existed, and no row at all.
    for (const view of [capabilitiesView(null, stored()), NOTHING_KNOWN]) {
      expect(primitiveStatus("zone", view, plain).availability).toBe("unknown");
      expect(primitiveStatus("email-routing", view, plain).availability).toBe("unknown");
    }
  });

  it("leaves Access unknown: nothing probes it", () => {
    expect(primitiveStatus("access", capabilitiesView(null, stored()), plain)).toMatchObject({
      availability: "unknown",
      reason: expect.stringMatching(/does not check/),
    });
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
