import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { requireRole, requireSession } from "../server/auth.server";
import { previewHeartbeat } from "./report.server";
import { acknowledgeNotice, readTelemetryStatus, setTelemetryEnabled } from "./state.server";
import { acknowledgeNoticeInput, setTelemetryInput, type TelemetryStatus } from "./telemetry";

/**
 * Anonymous usage data: any signed-in user reads the state and the preview;
 * only admins record a choice.
 */

export const getTelemetryStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<TelemetryStatus> => {
    await requireSession();
    return readTelemetryStatus(env);
  },
);

/**
 * Whether the home page shows the usage-data notice: to admins, while no
 * admin has seen it (a manager updated from a version without usage data)
 * and no Worker variable turns usage data off.
 */
export const getTelemetryNotice = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ show: boolean; status: TelemetryStatus }> => {
    const session = await requireSession();
    const status = await readTelemetryStatus(env);
    const show =
      hasRole(session.user.role, "admin") && status.state === "unset" && status.lockedBy === null;
    return { show, status };
  },
);

/** The setup step or the home page notice: the admin saw the notice and chose. */
export const acknowledgeTelemetryNotice = createServerFn({ method: "POST" })
  .validator(acknowledgeNoticeInput)
  .handler(async ({ data }): Promise<TelemetryStatus> => {
    await requireRole("admin");
    return acknowledgeNotice(env, data);
  });

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
