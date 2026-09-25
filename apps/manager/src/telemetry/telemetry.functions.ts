import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireRole, requireSession } from "../server/auth.server";
import { previewHeartbeat } from "./report.server";
import { readTelemetryStatus, setTelemetryEnabled } from "./state.server";
import { setTelemetryInput, type TelemetryStatus } from "./telemetry";

/**
 * Anonymous usage data: any signed-in user reads the state and the preview;
 * only admins change the choice.
 */

export const getTelemetryStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<TelemetryStatus> => {
    await requireSession();
    return readTelemetryStatus(env);
  },
);

/** Settings, Usage data: the switch. */
export const setTelemetry = createServerFn({ method: "POST" })
  .validator(setTelemetryInput)
  .handler(async ({ data }): Promise<TelemetryStatus> => {
    await requireRole("admin");
    return setTelemetryEnabled(env, data.enabled);
  });

/** Settings, Usage data, Preview: the next heartbeat as it would be sent, as JSON. */
export const previewTelemetry = createServerFn({ method: "GET" }).handler(
  async (): Promise<string> => {
    await requireSession();
    return JSON.stringify(await previewHeartbeat(env), null, 2);
  },
);
