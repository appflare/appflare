import { SANDBOX_BUCKET_NAME } from "@appflare/schema";
import { Badge, Banner, Button, Collapsible, Link, Text } from "@cloudflare/kumo";
import { ArrowCircleUpIcon, CubeIcon, PlugsConnectedIcon, PowerIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { buildCostLine, CONTAINERS_PRICING_URL, estimateBuild } from "../sandbox/cost";
import { sandboxPreflightProblems } from "../sandbox/preflight";
import {
  connectSandbox,
  type SandboxCardState,
  startSandboxJob,
} from "../server/sandbox.functions";
import { AppflareLoader } from "./appflare-loader";
import { BusyButton } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { jobKindLabel } from "./format";
import { SendReportButton } from "./job-report-dialog";
import { useJobStarted } from "./job-started";
import {
  BANNER_ICON,
  bannerRole,
  ErrorMessageBanner,
  MessageText,
  StatusRegion,
  SuccessBanner,
} from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";

/** The sandbox Worker's name, typed to confirm disabling. */
const SANDBOX_WORKER = "appflare-sandbox";

/**
 * The Building apps settings' sandbox builds section: whether this manager can
 * install apps that have no ready-made release (the `sandbox` tier), which the
 * account's sandbox Worker builds on Workers Paid.
 *
 * - Off, on an account where Workers Paid is detected: "Enable sandbox
 *   builds" asks for confirmation (what it creates, and what builds cost),
 *   then starts a job that deploys the sandbox Worker release this Appflare
 *   pins, its bucket and container applications, and connects to it. What
 *   keeps it from working (R2 off, the token without Containers) is named
 *   first, from the account capabilities.
 * - Connected: the sandbox Worker's version and image; "Update sandbox"
 *   (confirmed the same way) when this Appflare pins a newer release;
 *   "Disable sandbox builds" behind the typed name, refused while an app
 *   still needs it.
 * - Off, with Appflare still bound to a sandbox Worker that was deleted (a
 *   disable that stopped before its last step leaves that): a note saying
 *   so, and "Disable sandbox builds" to remove the binding; enabling
 *   replaces it.
 * - When the last enable, update or disable job failed and none has
 *   succeeded since, its first error line and a link to its log, so a
 *   stopped run does not look like a card that was never used.
 */
export function SandboxCard({
  status,
  capabilities,
  isAdmin,
}: {
  status: SandboxCardState;
  capabilities: CapabilitiesView;
  isAdmin: boolean;
}) {
  // Kept here, above the connected and not-connected views, so the region
  // that announces a Connect only stays mounted when the refreshed status
  // swaps one view for the other.
  const [justConnected, setJustConnected] = useState(false);
  return (
    <Section
      {...settingsSection("building", "sandbox")}
      titleAction={<DocsLink topic="sandboxBuilds" />}
      badge={<StateBadge status={status} />}
      description="Some catalog apps have no ready-made release. Appflare can build them from their pinned commit in a container in your own account, with the optional sandbox Worker. Builds need Workers Paid and are not signed."
    >
      <SectionBody>
        {status.activeJob !== null && <RunningJob job={status.activeJob} />}
        {status.activeJob === null && status.lastFailure !== null && (
          <LastFailure failure={status.lastFailure} isAdmin={isAdmin} />
        )}
        {/* One grid item, so the empty region adds no gap. */}
        <div>
          <StatusRegion spacing="mb-4">
            {justConnected && (
              <SuccessBanner
                live={false}
                title={CONNECTED}
                description="Appflare now runs with its binding to the sandbox Worker. It can take a few seconds to show here."
              />
            )}
          </StatusRegion>
          {status.connected ? (
            <Connected status={status} isAdmin={isAdmin} />
          ) : (
            <NotConnected
              status={status}
              capabilities={capabilities}
              isAdmin={isAdmin}
              connect={{ done: justConnected, onDone: () => setJustConnected(true) }}
            />
          )}
        </div>
      </SectionBody>
    </Section>
  );
}

function StateBadge({ status }: { status: SandboxCardState }) {
  if (status.activeJob !== null) return <Badge variant="info">Changing</Badge>;
  if (status.connected && status.problem === null) return <Badge variant="success">On</Badge>;
  if (status.connected) return <Badge variant="warning">Not answering</Badge>;
  return <Badge variant="neutral">Off</Badge>;
}

function RunningJob({ job }: { job: { id: string; kind: string } }) {
  return (
    <Banner
      // The loader is a status of its own; the banner's title says what runs.
      icon={<AppflareLoader size="sm" aria-hidden />}
      title={`${jobKindLabel(job)} is running`}
      description={
        <>
          Follow it in <Link href={`/jobs/${job.id}`}>its job log</Link>. The actions here come back
          when it ends.
        </>
      }
    />
  );
}

/** The last enable, update or disable job failed, and none has succeeded since. */
function LastFailure({
  failure,
  isAdmin,
}: {
  failure: NonNullable<SandboxCardState["lastFailure"]>;
  isAdmin: boolean;
}) {
  return (
    <Banner
      variant="error"
      icon={BANNER_ICON.error}
      role={bannerRole("error")}
      title={`${jobKindLabel(failure)} failed`}
      description={
        <span className="grid gap-1">
          <span className="break-words">
            <MessageText message={failure.message} />
          </span>
          <span>
            See <Link href={`/jobs/${failure.id}`}>its job log</Link> for what happened.
          </span>
        </span>
      }
      action={
        isAdmin ? (
          <SendReportButton jobId={failure.id} reportedAt={failure.reportedAt} />
        ) : undefined
      }
    />
  );
}

/**
 * What enabling or updating costs, for both confirmations: Workers Paid
 * usage while a build runs, nothing in between, and the estimate for a build
 * of the default size and length (each app shows its own before it builds).
 */
function SandboxUsageNote() {
  return (
    <div className="grid gap-2">
      <Text>
        Workers Paid usage applies while builds run: each build runs one container, billed as
        container time beyond what Workers Paid includes each month. Nothing runs between builds.
      </Text>
      <Text variant="secondary" size="sm">
        A typical build: {buildCostLine(estimateBuild())}. Each app shows its own estimate before it
        is built.
      </Text>
      <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
        Containers pricing
        <Link.ExternalIcon />
      </Link>
    </div>
  );
}

function EnableDialog({ status, disabled }: { status: SandboxCardState; disabled: boolean }) {
  const start = useStartSandboxJob();
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="primary" icon={<PowerIcon />} disabled={disabled}>
          Enable sandbox builds
        </Button>
      )}
      title="Enable sandbox builds"
      description={`Appflare creates the sandbox Worker ${status.pinnedVersion} (${SANDBOX_WORKER}) in this account, with the container applications that run its image and the R2 bucket ${SANDBOX_BUCKET_NAME}, then connects to it.`}
      actionLabel="Enable"
      destructive={false}
      onConfirm={() => start("enable")}
    >
      <SandboxUsageNote />
    </ConfirmDialog>
  );
}

function UpdateDialog({ status, disabled }: { status: SandboxCardState; disabled: boolean }) {
  const start = useStartSandboxJob();
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="primary" icon={<ArrowCircleUpIcon />} disabled={disabled}>
          Update sandbox
        </Button>
      )}
      title="Update sandbox"
      description={`Appflare uploads the sandbox Worker ${status.pinnedVersion} and rolls its container applications out to its image. Builds wait until it is done.`}
      actionLabel="Update"
      destructive={false}
      onConfirm={() => start("update")}
    >
      <SandboxUsageNote />
    </ConfirmDialog>
  );
}

/** Starts one of the sandbox jobs and opens its log. */
function useStartSandboxJob() {
  const jobStarted = useJobStarted();
  return async (action: "enable" | "update" | "disable", confirm?: string) => {
    const { jobId } = await startSandboxJob({
      data: confirm === undefined ? { action } : { action, confirm },
    });
    const titles = {
      enable: "Enabling sandbox builds",
      update: "Updating the sandbox Worker",
      disable: "Disabling sandbox builds",
    } as const;
    await jobStarted(jobId, titles[action]);
  };
}

/** A button that runs `action` and shows its error below; for the non-dialog actions. */
function ActionButton({
  label,
  icon,
  variant,
  disabled,
  action,
}: {
  label: string;
  icon: ReactNode;
  variant: "primary" | "secondary";
  disabled?: boolean;
  action: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${label.toLowerCase()}.`);
    }
    setPending(false);
  }
  return (
    <div className="grid justify-items-end gap-2">
      <BusyButton
        pending={pending}
        variant={variant}
        icon={icon}
        disabled={disabled === true}
        onClick={onClick}
      >
        {label}
      </BusyButton>
      {error !== null && <ErrorMessageBanner message={error} />}
    </div>
  );
}

function Connected({ status, isAdmin }: { status: SandboxCardState; isAdmin: boolean }) {
  const busy = status.activeJob !== null;
  return (
    <div className="grid gap-4">
      {status.info === null ? (
        <Banner
          variant="error"
          icon={BANNER_ICON.error}
          role={bannerRole("error")}
          title="The sandbox Worker does not answer as expected"
          description={
            status.problem === null ? undefined : <MessageText message={status.problem} />
          }
        />
      ) : (
        <DescriptionList>
          <DescriptionItem label="Sandbox Worker">
            <span className="font-mono text-[0.9em]">{status.info.sandboxVersion}</span>
          </DescriptionItem>
          <DescriptionItem label="Image">
            <span className="font-mono text-[0.9em]">{status.info.image}</span>
          </DescriptionItem>
        </DescriptionList>
      )}
      {status.updateAvailable && (
        <Banner
          icon={<ArrowCircleUpIcon weight="fill" />}
          title={`Sandbox Worker ${status.pinnedVersion} is available`}
          description="This Appflare version comes with a newer sandbox Worker. Updating uploads it and rolls its container applications to its image; builds wait until it is done."
        />
      )}
      {isAdmin && (
        <div className="flex flex-wrap items-start justify-end gap-2">
          <DisableDialog status={status} disabled={busy} />
          {(status.updateAvailable || status.info === null) && (
            <UpdateDialog status={status} disabled={busy} />
          )}
        </div>
      )}
    </div>
  );
}

/** Whether Connect only just worked, and what it calls when it does. */
interface ConnectState {
  done: boolean;
  onDone(): void;
}

function NotConnected({
  status,
  capabilities,
  isAdmin,
  connect,
}: {
  status: SandboxCardState;
  capabilities: CapabilitiesView;
  isAdmin: boolean;
  connect: ConnectState;
}) {
  const busy = status.activeJob !== null;
  const paidDetected = capabilities.plan.source === "detected" && capabilities.plan.plan === "paid";
  const problems = sandboxPreflightProblems({
    r2: capabilities.r2,
    containers: capabilities.containers,
    accountId: capabilities.accountId,
  });
  const dangling = isAdmin && status.danglingBinding;
  if (!paidDetected) {
    return (
      <div className="grid gap-2">
        <Text>
          Appflare has not detected Workers Paid on this account, which sandbox builds need. If the
          account is on Workers Paid, add Containers: Edit to Appflare's token (or Billing: Read)
          and choose Check again under What this account can run, on Your account.
        </Text>
        {dangling && <DanglingBindingNote />}
        {isAdmin && status.workerExists === true && (
          <LeftoverWorker status={status} disabled={busy} connect={connect} />
        )}
        {dangling && status.workerExists !== true && (
          <div className="flex justify-end">
            <DisableDialog status={status} disabled={busy} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <Text>
        Enabling deploys the sandbox Worker {status.pinnedVersion} to this account with its R2
        bucket and container applications, waits until Cloudflare has prepared them (a minute or
        two), then connects Appflare to it. No container runs until a build starts one, and it stops
        when the build ends; builds are billed as container time on Workers Paid.
      </Text>
      {problems.length > 0 && (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Fix this first"
          description={
            <span className="grid gap-1">
              {problems.map((p) => (
                <span key={p}>
                  <MessageText message={p} dashboardLinks="short" />
                </span>
              ))}
            </span>
          }
        />
      )}
      {dangling && <DanglingBindingNote />}
      {status.workerExists === null && isAdmin && (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Appflare could not check whether the sandbox Worker exists"
        />
      )}
      {isAdmin ? (
        <div className="flex flex-wrap items-start justify-end gap-2">
          {(status.workerExists === true || dangling) && (
            <DisableDialog status={status} disabled={busy} />
          )}
          {status.workerExists === true && <ConnectButton disabled={busy} connect={connect} />}
          <EnableDialog status={status} disabled={busy || problems.length > 0} />
        </div>
      ) : (
        <Text variant="secondary" size="sm">
          Only admins can enable them.
        </Text>
      )}
    </div>
  );
}

/**
 * Appflare's Worker still binds a sandbox Worker that was deleted. Calls
 * through that binding fail, so sandbox builds are off.
 */
function DanglingBindingNote() {
  return (
    <Banner
      variant="alert"
      icon={BANNER_ICON.alert}
      title="Appflare still has a binding to a deleted sandbox Worker"
      description="Sandbox builds are off. Disabling them removes the binding, and enabling them replaces it."
    />
  );
}

/** A sandbox Worker without Workers Paid detected: it can still be removed. */
function LeftoverWorker({
  status,
  disabled,
  connect,
}: {
  status: SandboxCardState;
  disabled: boolean;
  connect: ConnectState;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Text variant="secondary" size="sm">
        A sandbox Worker is in this account.
      </Text>
      <div className="flex gap-2">
        <DisableDialog status={status} disabled={disabled} />
        <ConnectButton disabled={disabled} connect={connect} />
      </div>
    </div>
  );
}

const CONNECTED = "Sandbox builds are connected";

/**
 * Connects to a sandbox Worker that is already there (deployed by the CLI,
 * for example). The card announces the result, in a region that outlives
 * this button.
 */
function ConnectButton({ disabled, connect }: { disabled: boolean; connect: ConnectState }) {
  const router = useRouter();
  if (connect.done) return null;
  return (
    <ActionButton
      label="Connect only"
      icon={<PlugsConnectedIcon />}
      variant="secondary"
      disabled={disabled}
      action={async () => {
        await connectSandbox();
        connect.onDone();
        await router.invalidate();
      }}
    />
  );
}

function DisableDialog({ status, disabled }: { status: SandboxCardState; disabled: boolean }) {
  const start = useStartSandboxJob();
  const inUse = status.inUseBy.length > 0;
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<CubeIcon />} disabled={disabled}>
          Disable sandbox builds
        </Button>
      )}
      title="Disable sandbox builds"
      description="Appflare deletes the sandbox Worker with the containers it builds in and the storage that holds every build and its log, then disconnects from it. GitHub access tokens are kept on the sandbox Worker, so they are removed too."
      {...(inUse ? {} : { confirmText: SANDBOX_WORKER })}
      actionLabel="Disable and delete"
      disabled={inUse}
      onConfirm={(typed) => start("disable", typed)}
    >
      {inUse ? (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Apps still need the sandbox Worker"
          description={`${status.inUseBy.join(", ")} ${status.inUseBy.length === 1 ? "was" : "were"} built or deployed in it, and ${status.inUseBy.length === 1 ? "its" : "their"} updates and uninstall run there. Uninstall ${status.inUseBy.length === 1 ? "it" : "them"} first.`}
        />
      ) : (
        <Text variant="secondary">
          Apps are not affected: none of them was built in the sandbox Worker. Enable sandbox builds
          again at any time.
        </Text>
      )}
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>Technical details</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <Text variant="secondary" size="sm">
            Deleted: the Worker <span className="font-mono text-[0.9em]">{SANDBOX_WORKER}</span>,
            its container applications, and the R2 bucket{" "}
            <span className="font-mono text-[0.9em]">appflare-builds</span>.
          </Text>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </ConfirmDialog>
  );
}
