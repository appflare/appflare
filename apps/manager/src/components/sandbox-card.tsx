import { SANDBOX_BUCKET_NAME } from "@appflare/schema";
import { Badge, Banner, Button, LayerCard, Link, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  CheckCircleIcon,
  CubeIcon,
  PlugsConnectedIcon,
  PowerIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
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
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { jobKindLabel } from "./format";
import { useJobStarted } from "./job-started";

/** The sandbox Worker's name, typed to confirm disabling. */
const SANDBOX_WORKER = "appflare-sandbox";

/**
 * Settings, Sandbox builds: whether this manager can install apps that have
 * no prebuilt release (the `sandbox` tier), which the account's sandbox
 * Worker builds on Workers Paid.
 *
 * - Off, on an account where Workers Paid is detected: "Enable sandbox
 *   builds" asks for confirmation (what it creates, and what builds cost),
 *   then starts a job that deploys the sandbox Worker release this Appflare
 *   pins, its bucket and container applications, and connects to it. What
 *   keeps it from working (R2 off, the token without Containers) is named
 *   first, from the account capabilities above.
 * - Connected: the sandbox Worker's version and image; "Update sandbox"
 *   (confirmed the same way) when this Appflare pins a newer release;
 *   "Disable sandbox builds" behind the typed name, refused while an app
 *   still needs it.
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
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1">
          Sandbox builds
          <DocsLink topic="sandboxBuilds" />
        </span>
        <StateBadge status={status} />
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text variant="secondary">
          Some catalog apps have no prebuilt release. Appflare can build them from their pinned
          commit in a container in your own account, with the optional sandbox Worker. Builds need
          Workers Paid and are not signed.
        </Text>
        {status.activeJob !== null && <RunningJob job={status.activeJob} />}
        {status.activeJob === null && status.lastFailure !== null && (
          <LastFailure failure={status.lastFailure} />
        )}
        {status.connected ? (
          <Connected status={status} isAdmin={isAdmin} />
        ) : (
          <NotConnected status={status} capabilities={capabilities} isAdmin={isAdmin} />
        )}
      </LayerCard.Primary>
    </LayerCard>
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
      icon={<SpinnerGapIcon />}
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
function LastFailure({ failure }: { failure: NonNullable<SandboxCardState["lastFailure"]> }) {
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={`${jobKindLabel(failure)} failed`}
      description={
        <span className="grid gap-1">
          <span className="break-words">{failure.message}</span>
          <span>
            See <Link href={`/jobs/${failure.id}`}>its job log</Link> for what happened.
          </span>
        </span>
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

/** Short labels for the dashboard addresses the refusal reasons carry. */
const DASHBOARD_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/\/workers\/plans$/, "Workers plans"],
  [/\/r2\/overview$/, "R2 in the dashboard"],
];

/**
 * A refusal reason with each dashboard address shown as a short link instead
 * of the address itself. The reasons stay plain text for server errors.
 */
function ReasonText({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s)]+?)(?=[.)]*(?:\s|$))/);
  return (
    <>
      {parts.map((part, i) => {
        if (!part.startsWith("https://")) return part;
        const label = DASHBOARD_LABELS.find(([re]) => re.test(part))?.[1] ?? "the dashboard";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <Link key={i} href={part} target="_blank" rel="noopener noreferrer">
            {label}
            <Link.ExternalIcon />
          </Link>
        );
      })}
    </>
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
      description={`Appflare creates the sandbox Worker ${status.pinnedVersion} (${SANDBOX_WORKER}) in this account, with two container applications that run its image and the R2 bucket ${SANDBOX_BUCKET_NAME}, then connects to it.`}
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
      description={`Appflare uploads the sandbox Worker ${status.pinnedVersion} and rolls both container applications out to its image. Builds wait until it is done.`}
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
      <Button
        variant={variant}
        icon={icon}
        loading={pending}
        disabled={disabled === true}
        onClick={onClick}
      >
        {label}
      </Button>
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
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
          icon={<WarningCircleIcon weight="fill" />}
          title="The sandbox Worker does not answer as expected"
          description={status.problem ?? undefined}
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
          icon={<ArrowCircleUpIcon />}
          title={`Sandbox Worker ${status.pinnedVersion} is available`}
          description="This Appflare version comes with a newer sandbox Worker. Updating uploads it and rolls both container applications to its image; builds wait until it is done."
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

function NotConnected({
  status,
  capabilities,
  isAdmin,
}: {
  status: SandboxCardState;
  capabilities: CapabilitiesView;
  isAdmin: boolean;
}) {
  const busy = status.activeJob !== null;
  const paidDetected = capabilities.plan.source === "detected" && capabilities.plan.plan === "paid";
  const problems = sandboxPreflightProblems({
    r2: capabilities.r2,
    containers: capabilities.containers,
  });
  if (!paidDetected) {
    return (
      <div className="grid gap-2">
        <Text>
          Appflare has not detected Workers Paid on this account, which sandbox builds need. If the
          account is on Workers Paid, add Containers: Edit to Appflare's token (or Billing: Read)
          and choose Re-check under Account capabilities.
        </Text>
        {isAdmin && status.workerExists === true && (
          <LeftoverWorker status={status} disabled={busy} />
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <Text>
        Enabling deploys the sandbox Worker {status.pinnedVersion} to this account with its R2
        bucket and two container applications, waits until Cloudflare has prepared them (a minute or
        two), then connects Appflare to it. No container runs until a build starts one, and it stops
        when the build ends; builds are billed as container time on Workers Paid.
      </Text>
      {problems.length > 0 && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Fix this first"
          description={
            <span className="grid gap-1">
              {problems.map((p) => (
                <span key={p}>
                  <ReasonText text={p} />
                </span>
              ))}
            </span>
          }
        />
      )}
      {status.workerExists === null && isAdmin && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Appflare could not check whether the sandbox Worker exists."
        />
      )}
      {isAdmin ? (
        <div className="flex flex-wrap items-start justify-end gap-2">
          {status.workerExists === true && <DisableDialog status={status} disabled={busy} />}
          {status.workerExists === true && <ConnectButton disabled={busy} />}
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

/** A sandbox Worker without Workers Paid detected: it can still be removed. */
function LeftoverWorker({ status, disabled }: { status: SandboxCardState; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Text variant="secondary" size="sm">
        A sandbox Worker is in this account.
      </Text>
      <div className="flex gap-2">
        <DisableDialog status={status} disabled={disabled} />
        <ConnectButton disabled={disabled} />
      </div>
    </div>
  );
}

/** Connects to a sandbox Worker that is already there (deployed by the CLI, for example). */
function ConnectButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <Banner
        icon={<CheckCircleIcon weight="fill" />}
        title="Sandbox builds are connected"
        description="Appflare now runs with its binding to the sandbox Worker. It can take a few seconds to show here."
      />
    );
  }
  return (
    <ActionButton
      label="Connect only"
      icon={<PlugsConnectedIcon />}
      variant="secondary"
      disabled={disabled}
      action={async () => {
        await connectSandbox();
        setDone(true);
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
      description="Appflare disconnects from the sandbox Worker, then deletes it, its two container applications, and the R2 bucket appflare-builds with every build output and log in it."
      {...(inUse ? {} : { confirmText: SANDBOX_WORKER })}
      actionLabel="Disable and delete"
      disabled={inUse}
      onConfirm={(typed) => start("disable", typed)}
    >
      {inUse ? (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Apps still need the sandbox Worker"
          description={`${status.inUseBy.join(", ")} ${status.inUseBy.length === 1 ? "was" : "were"} built or deployed in it, and ${status.inUseBy.length === 1 ? "its" : "their"} updates and uninstall run there. Uninstall ${status.inUseBy.length === 1 ? "it" : "them"} first.`}
        />
      ) : (
        <Text variant="secondary">
          Apps are not affected: none of them was built in the sandbox Worker. Enable sandbox builds
          again at any time.
        </Text>
      )}
    </ConfirmDialog>
  );
}
