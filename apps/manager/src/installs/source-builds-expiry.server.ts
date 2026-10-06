import {
  createNotificationUnits,
  type NotificationUnitsApi,
  type NotificationUnitsEnv,
  selfNotificationUnits,
} from "../notifications/units";
import { expiredSourceBuildsLog, sourceBuildExpiryDue } from "./source-builds.server";

/**
 * The cron's expiry of builds for review nobody used. One read when nothing
 * is due; otherwise the `expireSourceBuilds` unit over `SELF`, so its D1
 * queries and sandbox Worker calls run in an invocation with a subrequest
 * budget of their own (in place without the binding). Never throws, so the
 * rest of the scheduled run goes on whatever happens here.
 */
export async function scheduledSourceBuildExpiry(
  env: NotificationUnitsEnv & { SELF?: unknown },
  units?: Pick<NotificationUnitsApi, "expireSourceBuilds">,
): Promise<"idle" | "ran" | "failed"> {
  try {
    if (!(await sourceBuildExpiryDue(env.DB))) return "idle";
    const unit = units ?? selfNotificationUnits(env) ?? createNotificationUnits(env);
    const result = await unit.expireSourceBuilds({});
    if (!result.ok) {
      console.error("expiring unused source builds failed", { error: result.error });
      return "failed";
    }
    const line = expiredSourceBuildsLog(result.value);
    if (line !== null) console.log(line);
    return "ran";
  } catch (error) {
    console.error("expiring unused source builds failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
