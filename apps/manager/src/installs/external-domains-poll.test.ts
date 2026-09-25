import type { CustomHostname } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import {
  domainStateChange,
  FRESH_DOMAIN_MS,
  observedDomainState,
  parseRecordedDomainState,
  recordedDomainStateJson,
} from "./external-domains-poll";

const ch = (status: string, ssl?: string): CustomHostname => ({
  id: "ch-1",
  hostname: "go.customer.test",
  status,
  ...(ssl === undefined ? {} : { ssl: { status: ssl } }),
});

describe("observedDomainState", () => {
  it("is active only with the hostname and its certificate active", () => {
    expect(observedDomainState(ch("active", "active"))).toEqual({ state: "active", reason: null });
    expect(observedDomainState(ch("active", "pending_issuance")).state).toBe("pending");
    expect(observedDomainState(ch("pending", "pending_validation")).state).toBe("pending");
  });

  it("is removed when Cloudflare has none, and failed when it gave up on it or its certificate", () => {
    expect(observedDomainState(undefined)).toEqual({
      state: "removed",
      reason:
        "Cloudflare no longer has a custom hostname for it; remove the domain on the app's page and add it again.",
    });
    expect(observedDomainState(ch("blocked"))).toEqual({
      state: "failed",
      reason: "Cloudflare reports the hostname as blocked.",
    });
    expect(observedDomainState(ch("pending_deletion")).reason).toBe(
      "Cloudflare reports the hostname as pending deletion.",
    );
    expect(observedDomainState(ch("pending", "validation_timed_out"))).toEqual({
      state: "failed",
      reason:
        "Its certificate was not issued: Cloudflare reports it as validation timed out. Remove the domain and add it again once its DNS records are in place.",
    });
  });
});

describe("domainStateChange", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const fresh = { now, addedAt: now - 60_000 };
  const old = { now, addedAt: now - FRESH_DOMAIN_MS - 1 };

  it("records a first sight, and tells only of a failure or a fresh domain gone active", () => {
    expect(domainStateChange(null, "pending", fresh)).toEqual({
      record: { state: "pending", since: now },
      event: null,
      from: 0,
    });
    expect(domainStateChange(null, "active", fresh).event).toBe("domain_active");
    expect(domainStateChange(null, "active", old)).toEqual({
      record: { state: "active", since: now },
      event: null,
      from: 0,
    });
    expect(domainStateChange(null, "failed", old).event).toBe("domain_failed");
  });

  it("tells once when a pending or failed domain goes active, keyed by the state it leaves", () => {
    const pending = { state: "pending" as const, since: 100 };
    expect(domainStateChange(pending, "active", old)).toEqual({
      record: { state: "active", since: now },
      event: "domain_active",
      from: 100,
    });
    expect(domainStateChange(pending, "pending", old)).toEqual({
      record: null,
      event: null,
      from: 100,
    });
    expect(domainStateChange({ state: "failed", since: 5 }, "active", old).event).toBe(
      "domain_active",
    );
  });

  it("tells when a domain fails, and records a failed one going back to pending silently", () => {
    expect(domainStateChange({ state: "pending", since: 1 }, "failed", old).event).toBe(
      "domain_failed",
    );
    expect(domainStateChange({ state: "active", since: 1 }, "failed", old).event).toBe(
      "domain_failed",
    );
    expect(domainStateChange({ state: "failed", since: 1 }, "failed", old).record).toBeNull();
    expect(domainStateChange({ state: "failed", since: 1 }, "pending", old)).toEqual({
      record: { state: "pending", since: now },
      event: null,
      from: 1,
    });
  });

  it("tells once when a domain is removed at Cloudflare, also after it failed", () => {
    expect(domainStateChange({ state: "active", since: 1 }, "removed", old)).toEqual({
      record: { state: "removed", since: now },
      event: "domain_failed",
      from: 1,
    });
    expect(domainStateChange({ state: "failed", since: 1 }, "removed", old).event).toBe(
      "domain_failed",
    );
    expect(domainStateChange({ state: "removed", since: 1 }, "removed", old).record).toBeNull();
    expect(domainStateChange(null, "removed", old).event).toBe("domain_failed");
  });

  it("keeps an active domain active while Cloudflare renews its certificate", () => {
    expect(domainStateChange({ state: "active", since: 1 }, "pending", old)).toEqual({
      record: null,
      event: null,
      from: 1,
    });
  });
});

describe("recorded state", () => {
  it("round-trips, and anything unreadable counts as never seen", () => {
    for (const s of ["pending", "active", "failed", "removed"] as const) {
      const state = { state: s, since: 42 };
      expect(parseRecordedDomainState(recordedDomainStateJson(state))).toEqual(state);
    }
    for (const bad of ["", "{", '{"state":"gone","since":1}', '{"state":"active"}', "null"]) {
      expect(parseRecordedDomainState(bad), bad).toBeNull();
    }
  });
});
