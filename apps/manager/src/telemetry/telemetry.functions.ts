import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireRole, requireSession } from "../server/auth.server";
import { type FailureReportPreview, NOTE_MAX_LENGTH } from "./failure-report";
import { previewFailureReport, type SendOutcome, sendFailureReport } from "./failure-report.server";
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

const jobReportInput = z.object({ jobId: z.string().min(1).max(64) });

/** "Send a report" on a failed job (admins): the report exactly as it would be sent. */
export const previewJobReport = createServerFn({ method: "GET" })
  .validator(jobReportInput)
  .handler(async ({ data }): Promise<FailureReportPreview> => {
    await requireRole("admin");
    return previewFailureReport(env, data.jobId);
  });

/** "Send a report", Send (admins): sends it once, whether or not usage data is on. */
export const sendJobReport = createServerFn({ method: "POST" })
  .validator(
    jobReportInput.extend({
      note: z.string().max(NOTE_MAX_LENGTH),
      installId: z.string().max(64).optional(),
    }),
  )
  .handler(async ({ data }): Promise<SendOutcome> => {
    await requireRole("admin");
    return sendFailureReport(env, data.jobId, data.note, { proposedInstallId: data.installId });
  });
