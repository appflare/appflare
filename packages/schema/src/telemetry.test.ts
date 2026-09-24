import { describe, expect, it } from "vitest";
import {
  commonTelemetryProperties,
  isInstallId,
  TELEMETRY_BATCH_URL,
  TELEMETRY_PROJECT_KEY,
  telemetryBatchBody,
  telemetryLock,
} from "./telemetry";

describe("telemetryLock", () => {
  it("is off-switched by APPFLARE_TELEMETRY off, 0 or false, in any case", () => {
    for (const value of ["off", "OFF", " 0 ", "false", "False"]) {
      expect(telemetryLock({ APPFLARE_TELEMETRY: value })).toBe("APPFLARE_TELEMETRY");
    }
  });
  it("honours DO_NOT_TRACK=1 or true", () => {
    expect(telemetryLock({ DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK");
    expect(telemetryLock({ DO_NOT_TRACK: "true" })).toBe("DO_NOT_TRACK");
  });
  it("leaves usage data on for anything else", () => {
    expect(telemetryLock({})).toBeNull();
    expect(telemetryLock({ APPFLARE_TELEMETRY: "on", DO_NOT_TRACK: "0" })).toBeNull();
    expect(telemetryLock({ APPFLARE_TELEMETRY: "" })).toBeNull();
  });
});

describe("isInstallId", () => {
  it("accepts only random (v4) UUIDs", () => {
    expect(isInstallId(crypto.randomUUID())).toBe(true);
    expect(isInstallId("0190f5b2-7c3a-7abc-8def-0123456789ab")).toBe(false);
    expect(isInstallId("not-a-uuid")).toBe(false);
    expect(isInstallId(undefined)).toBe(false);
  });
});

describe("telemetryBatchBody", () => {
  it("sends anonymous events of one install id to PostHog's EU batch endpoint", () => {
    expect(TELEMETRY_BATCH_URL).toBe("https://eu.i.posthog.com/batch/");
    const id = "6f1c3c1e-2b1a-4c1d-9e1f-0a1b2c3d4e5f";
    const body = telemetryBatchBody(id, [
      {
        event: "manager heartbeat",
        uuid: "u1",
        timestamp: "2026-09-24T00:00:00.000Z",
        properties: { ...commonTelemetryProperties("manager", "0.5.0"), users: 2 },
      },
    ]);
    expect(body).toEqual({
      api_key: TELEMETRY_PROJECT_KEY,
      historical_migration: false,
      batch: [
        {
          event: "manager heartbeat",
          uuid: "u1",
          timestamp: "2026-09-24T00:00:00.000Z",
          distinct_id: id,
          properties: {
            $process_person_profile: false,
            $geoip_disable: true,
            $lib: "appflare-manager",
            source: "manager",
            manager_version: "0.5.0",
            users: 2,
            distinct_id: id,
          },
        },
      ],
    });
  });
});
