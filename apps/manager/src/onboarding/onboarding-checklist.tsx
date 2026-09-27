import { Banner, Button, Link, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useJobStarted } from "../components/job-started";
import { Section, SectionBody } from "../components/section";
import { settingsSection } from "../components/settings-links";
import { Timestamp } from "../components/timestamp";
import { buildCostLine, CONTAINERS_PRICING_URL, estimateBuild } from "../sandbox/cost";
import { startSandboxJob } from "../server/sandbox.functions";
import { recheckChecklist } from "./checklist.functions";
import type { ChecklistData } from "./checklist.server";
import { ChecklistBody, EnablingStatus } from "./checklist-view";

/**
 * The onboarding checklist's two places, the last setup step and the account
 * settings, with Re-check and the sandbox row's "Enable now" (admins only).
 * The rows themselves are drawn by `checklist-view.tsx`.
 */

/**
 * "Enable now": starts the sandbox enable job after a confirmation. In
 * Settings it then opens the job's log; inside the setup wizard (`stayInPlace`)
 * it stays, and the row says the job is running so setup can be finished.
 */
function EnableSandboxNow({ stayInPlace }: { stayInPlace: boolean }) {
  const jobStarted = useJobStarted();
  const [startedJob, setStartedJob] = useState<string | null>(null);
  if (startedJob !== null) return <EnablingStatus jobId={startedJob} />;
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary" size="sm" className="shrink-0">
          Enable now
        </Button>
      )}
      title="Enable sandbox builds now"
      description="The first app that needs a build enables sandbox builds by itself. Enabling now makes that first build faster: Appflare creates the sandbox Worker, its R2 bucket and two container applications in this account, then connects to it."
      actionLabel="Enable"
      destructive={false}
      onConfirm={async () => {
        const { jobId } = await startSandboxJob({ data: { action: "enable" } });
        if (stayInPlace) setStartedJob(jobId);
        else await jobStarted(jobId, "Enabling sandbox builds");
      }}
    >
      <div className="grid gap-2">
        <Text>
          Nothing runs between builds. Each build runs one container, billed as container time
          beyond what Workers Paid includes each month.
        </Text>
        <Text variant="secondary" size="sm">
          A typical build: {buildCostLine(estimateBuild())}.
        </Text>
        <Link href={CONTAINERS_PRICING_URL} target="_blank" rel="noopener noreferrer">
          Containers pricing
          <Link.ExternalIcon />
        </Link>
      </div>
    </ConfirmDialog>
  );
}

/** Runs the probes again; `onDone` receives the checklist as it now reads. */
function useRecheck(onDone: (data: ChecklistData) => Promise<void> | void) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function recheck() {
    setChecking(true);
    setError(null);
    try {
      await onDone(await recheckChecklist());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the account.");
    }
    setChecking(false);
  }
  return { checking, error, recheck };
}

function RecheckButton({
  checking,
  onClick,
  variant = "ghost",
}: {
  checking: boolean;
  onClick(): void;
  variant?: "ghost" | "secondary";
}) {
  return (
    <Button
      variant={variant}
      // Small beside the wizard's Finish; full size as a section's header action.
      size={variant === "ghost" ? "sm" : "base"}
      icon={<ArrowClockwiseIcon />}
      loading={checking}
      onClick={onClick}
    >
      Re-check
    </Button>
  );
}

function CheckedAt({ iso }: { iso: string | null }) {
  return (
    <Text variant="secondary" size="sm">
      {iso === null ? (
        "Not checked yet."
      ) : (
        <>
          Checked <Timestamp iso={iso} />.
        </>
      )}
    </Text>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={message} />;
}

/**
 * The last setup step's content: the checklist, when it was checked, and a
 * small Re-check (the wizard adds Finish). Re-check hands the new reading to
 * `onRechecked`, so the wizard updates in place.
 */
export function SetupChecklist({
  data,
  onRechecked,
}: {
  data: ChecklistData;
  onRechecked: (data: ChecklistData) => void;
}) {
  const { checking, error, recheck } = useRecheck(onRechecked);
  return (
    <div className="grid min-w-0 gap-3">
      <ChecklistBody data={data} enableNow={<EnableSandboxNow stayInPlace />} />
      {error !== null && <ErrorBanner message={error} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CheckedAt iso={data.view.checkedAt} />
        <RecheckButton checking={checking} onClick={() => void recheck()} />
      </div>
    </div>
  );
}

/**
 * The account settings' onboarding checklist section: the same checklist,
 * with Re-check (admins) at the right of its header. Re-check reloads the
 * page, so every section that reads the same probes shows the new values.
 */
export function OnboardingChecklistCard({
  data,
  isAdmin,
}: {
  data: ChecklistData;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { checking, error, recheck } = useRecheck(() => router.invalidate());
  return (
    <Section
      {...settingsSection("account", "checklist")}
      description="What this Cloudflare account has that apps rely on."
      action={
        isAdmin ? (
          <RecheckButton checking={checking} onClick={() => void recheck()} variant="secondary" />
        ) : null
      }
      error={error}
    >
      <SectionBody className="gap-3">
        <ChecklistBody
          data={data}
          enableNow={isAdmin ? <EnableSandboxNow stayInPlace={false} /> : null}
        />
        <CheckedAt iso={data.view.checkedAt} />
      </SectionBody>
    </Section>
  );
}
