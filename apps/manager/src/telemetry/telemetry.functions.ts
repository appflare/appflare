import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { requireRole, requireSession } from "../server/auth.server";
import { previewHeartbeat } from "./report.server";
import {
  dismissNotice,
  isNoticeDue,
  readTelemetryStatus,
  setTelemetryEnabled,
} from "./state.server";
import { setTelemetryInput, type TelemetryStatus } from "./telemetry";

/**
 * Anonymous usage data: any signed-in user reads the state and the preview;
 * only admins change the choice or dismiss the notice.
 */

export const getTelemetryStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<TelemetryStatus> => {
    await requireSession();
    return readTelemetryStatus(env);
  },
);

/**
 * Whether the home page shows the usage-data notice: to admins, once per
 * manager (see `isNoticeDue`).
 */
export const getTelemetryNotice = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ show: boolean; status: TelemetryStatus }> => {
    const session = await requireSession();
    const [status, due] = await Promise.all([readTelemetryStatus(env), isNoticeDue(env)]);
    return { show: hasRole(session.user.role, "admin") && due, status };
  },
);

/** The home page notice's Dismiss: hides it for every admin of this manager. */
export const dismissTelemetryNotice = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    await requireRole("admin");
    await dismissNotice(env);
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
