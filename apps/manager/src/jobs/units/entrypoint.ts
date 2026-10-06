import { WorkerEntrypoint } from "cloudflare:workers";
import type { RemovalRelease } from "../../access/install-access.server";
import type { AccessUpkeepReport } from "../../access/upkeep-run.server";
import type { EmailRoutingInspection } from "../../installs/email-routing.server";
import type { DomainCheckReport } from "../../installs/external-domains-poll.server";
import type { ExpiredSourceBuilds } from "../../installs/source-builds.server";
import type { WorkflowRepairReport } from "../../installs/workflow-repair.server";
import type { DeliveryReport } from "../../notifications/deliver.server";
import type { HealthSweepReport } from "../../notifications/health-sweep.server";
import { createNotificationUnits, type NotificationUnitResult } from "../../notifications/units";
import type { SetSandboxBindingResult, WaitForSandboxContainersResult } from "../../sandbox/units";
import type { CronTriggerScan } from "../install/cron-limit";
import type {
  ProtectInstallUnitResult,
  SyncInstallAccessResult,
  UnprotectInstallResult,
} from "./access";
import type { D1SeedResult } from "./d1-seed";
import type {
  AttachDomainResult,
  WaitForCustomDomainResult,
  WaitForExternalDomainResult,
} from "./domains";
import type { UnitResult } from "./result";
import type { SandboxSettleResult } from "./sandbox-settle";
import {
  type AssetPartResult,
  createJobUnits,
  type D1BaselineResult,
  type D1MigrationsResult,
  type D1SchemaResult,
  type R2PageResult,
  type WorkerUploadResult,
} from "./units";

/**
 * The manager's job units over RPC. A job reaches this class through the
 * `SELF` service binding (`services: [{ binding: "SELF", service: <this
 * Worker's name>, entrypoint: "JobUnits" }]`); each call runs as a new
 * invocation with its own subrequest limit and costs the caller one
 * subrequest. Inputs arrive as plain values and are validated before use;
 * the API token and the GitHub token come from this Worker's own secrets.
 */
export class JobUnits extends WorkerEntrypoint<Env> {
  uploadAssetPart(input: unknown): Promise<UnitResult<AssetPartResult>> {
    return createJobUnits(this.env).uploadAssetPart(input);
  }

  uploadWorker(input: unknown): Promise<UnitResult<WorkerUploadResult>> {
    return createJobUnits(this.env).uploadWorker(input);
  }

  applyD1Migrations(input: unknown): Promise<UnitResult<D1MigrationsResult>> {
    return createJobUnits(this.env).applyD1Migrations(input);
  }

  applyD1Schema(input: unknown): Promise<UnitResult<D1SchemaResult>> {
    return createJobUnits(this.env).applyD1Schema(input);
  }

  applyD1Baseline(input: unknown): Promise<UnitResult<D1BaselineResult>> {
    return createJobUnits(this.env).applyD1Baseline(input);
  }

  seedD1(input: unknown): Promise<UnitResult<D1SeedResult>> {
    return createJobUnits(this.env).seedD1(input);
  }

  emptyR2Page(input: unknown): Promise<UnitResult<R2PageResult>> {
    return createJobUnits(this.env).emptyR2Page(input);
  }

  inspectEmailRouting(input: unknown): Promise<UnitResult<EmailRoutingInspection>> {
    return createJobUnits(this.env).inspectEmailRouting(input);
  }

  countCronTriggers(input: unknown): Promise<UnitResult<CronTriggerScan>> {
    return createJobUnits(this.env).countCronTriggers(input);
  }

  settleSandbox(input: unknown): Promise<UnitResult<SandboxSettleResult>> {
    return createJobUnits(this.env).settleSandbox(input);
  }

  attachDomain(input: unknown): Promise<UnitResult<AttachDomainResult>> {
    return createJobUnits(this.env).attachDomain(input);
  }

  waitForExternalDomain(input: unknown): Promise<UnitResult<WaitForExternalDomainResult>> {
    return createJobUnits(this.env).waitForExternalDomain(input);
  }

  waitForCustomDomain(input: unknown): Promise<UnitResult<WaitForCustomDomainResult>> {
    return createJobUnits(this.env).waitForCustomDomain(input);
  }

  waitForSandboxContainers(input: unknown): Promise<UnitResult<WaitForSandboxContainersResult>> {
    return createJobUnits(this.env).waitForSandboxContainers(input);
  }

  setSandboxBinding(input: unknown): Promise<UnitResult<SetSandboxBindingResult>> {
    return createJobUnits(this.env).setSandboxBinding(input);
  }

  protectInstall(input: unknown): Promise<UnitResult<ProtectInstallUnitResult>> {
    return createJobUnits(this.env).protectInstall(input);
  }

  syncInstallAccess(input: unknown): Promise<UnitResult<SyncInstallAccessResult>> {
    return createJobUnits(this.env).syncInstallAccess(input);
  }

  unprotectInstall(input: unknown): Promise<UnitResult<UnprotectInstallResult>> {
    return createJobUnits(this.env).unprotectInstall(input);
  }

  releaseAppAccess(input: unknown): Promise<UnitResult<RemovalRelease>> {
    return createJobUnits(this.env).releaseAppAccess(input);
  }

  // Notification units (src/notifications/units.ts): delivery, the scheduled health check,
  // and the scheduled check of external domains.
  deliverNotifications(input: unknown): Promise<NotificationUnitResult<DeliveryReport>> {
    return createNotificationUnits(this.env).deliverNotifications(input);
  }

  checkInstallsHealth(input: unknown): Promise<NotificationUnitResult<HealthSweepReport>> {
    return createNotificationUnits(this.env).checkInstallsHealth(input);
  }

  checkExternalDomains(input: unknown): Promise<NotificationUnitResult<DomainCheckReport>> {
    return createNotificationUnits(this.env).checkExternalDomains(input);
  }

  // The scheduled upkeep of apps protected with Cloudflare Access, in three
  // parts with a budget each (src/access/upkeep-run.server.ts).
  refreshAccessRevisions(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>> {
    return createNotificationUnits(this.env).refreshAccessRevisions(input);
  }

  renewAccessTokens(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>> {
    return createNotificationUnits(this.env).renewAccessTokens(input);
  }

  resyncAccessApps(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>> {
    return createNotificationUnits(this.env).resyncAccessApps(input);
  }

  // The scheduled repair of installed apps' missing Workflows.
  repairWorkflows(input: unknown): Promise<NotificationUnitResult<WorkflowRepairReport>> {
    return createNotificationUnits(this.env).repairWorkflows(input);
  }

  // The scheduled expiry of builds for review nobody used.
  expireSourceBuilds(input: unknown): Promise<NotificationUnitResult<ExpiredSourceBuilds>> {
    return createNotificationUnits(this.env).expireSourceBuilds(input);
  }
}
