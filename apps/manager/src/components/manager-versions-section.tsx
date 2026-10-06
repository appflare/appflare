import { AppflareLoader } from "@appflare/brand/loader";
import { Badge, Banner, Button, Link, Table, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useVersionSwitch } from "../jobs/live-job";
import type { SwitchJob } from "../jobs/live-job-state";
import type { ManagerVersionRow } from "../jobs/self-update/rollback";
import { type ManagerVersionsState, rollBackManager } from "../jobs/self-update/rollback.functions";
import type { RollBackManagerResult } from "../jobs/self-update/rollback.server";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { BANNER_ICON, StatusRegion, SuccessBanner } from "./message-text";
import { Section, SectionBody, SectionTable } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * Settings, Updates, "Recent versions": the newest versions of Appflare's
 * own Worker, the one serving marked, and for admins "Roll back" on each
 * older one. The rollback runs in the request; this section then follows the
 * switch the way the sidebar's update card does (polling `/api/health`) and
 * reloads the page onto the older version, which then says it was rolled
 * back.
 */

const mono = "font-mono text-[0.9em]";

/** Where the section keeps the finished rollback across the reload that follows it. */
const ROLLED_BACK_KEY = "appflare:rolled-back-to";

interface RolledBack {
  version: string;
  jobId: string;
}

/** What made a version, from its `workers/triggered_by` annotation. */
const TRIGGER_LABELS: Record<string, string> = {
  upload: "Deploy",
  version_upload: "Upload",
  secret: "Secret change",
  rollback: "Rollback",
  deployment: "Deployment",
};

function triggerLabel(row: ManagerVersionRow): string {
  if (row.trigger === null) return "Unknown";
  return TRIGGER_LABELS[row.trigger] ?? row.trigger;
}

function versionLabel(row: ManagerVersionRow): string {
  return row.appflareVersion ?? row.id.slice(0, 8);
}

/** Reads (once) the rollback the previous page finished, and forgets it. */
function useRolledBack(): RolledBack | null {
  const [value, setValue] = useState<RolledBack | null>(null);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(ROLLED_BACK_KEY);
      window.sessionStorage.removeItem(ROLLED_BACK_KEY);
      if (raw !== null) setValue(JSON.parse(raw) as RolledBack);
    } catch {
      // Storage blocked or unreadable: no notice; the list shows what serves.
    }
  }, []);
  return value;
}

export function ManagerVersionsSection({
  state,
  isAdmin,
  current,
}: {
  state: ManagerVersionsState;
  isAdmin: boolean;
  /** The Appflare version this page was loaded from. */
  current: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<RollBackManagerResult | null>(null);
  const rolledBack = useRolledBack();
  const [done, setDone] = useState<RolledBack | null>(null);
  const notice = done ?? rolledBack;
  const job: SwitchJob | null =
    result === null
      ? null
      : {
          kind: "self_rollback",
          status: "succeeded",
          targetVersion: result.version,
          finishedAt: result.finishedAt,
        };
  const onArrived = useCallback(() => {
    if (result === null) return;
    try {
      const value: RolledBack = { version: result.version, jobId: result.jobId };
      window.sessionStorage.setItem(ROLLED_BACK_KEY, JSON.stringify(value));
    } catch {
      // Storage blocked: the reloaded page shows no notice, only the list.
    }
  }, [result]);
  const { switching, stalled } = useVersionSwitch(job, { clientVersion: current, onArrived });

  async function onRolledBack(next: RollBackManagerResult) {
    setResult(next);
    // The same release serves again: nothing to reload onto, only the list to refresh.
    if (next.version === current) {
      setDone({ version: next.version, jobId: next.jobId });
      await router.invalidate();
    }
  }

  const pending = result !== null && result.version !== current && !stalled;
  return (
    <Section
      {...settingsSection("updates", "versions")}
      titleAction={<DocsLink topic="appflareRollback" />}
      description="Appflare's newest versions on its Worker. A rollback redeploys an older one to all traffic; the database is not rolled back."
      error={state.ok ? null : state.error}
      empty={
        state.ok && state.versions.length === 0 ? (
          <Text variant="secondary">Cloudflare lists no versions of Appflare's Worker.</Text>
        ) : undefined
      }
    >
      {/* Mounted with the list, so screen readers announce each notice as it comes. */}
      <StatusRegion>
        {(notice !== null || pending || stalled) && (
          <SectionBody>
            <RollbackNotices
              notice={notice}
              switchingTo={pending && result !== null ? result.version : null}
              switching={switching}
              stalledAt={stalled && result !== null ? result.version : null}
            />
          </SectionBody>
        )}
      </StatusRegion>
      {state.ok && state.versions.length > 0 && (
        <SectionTable label="Appflare versions" stickyFirstColumn>
          <Table.Header>
            <Table.Row>
              <Table.Head>Appflare version</Table.Head>
              <Table.Head>Worker version</Table.Head>
              <Table.Head>Created</Table.Head>
              <Table.Head>Made by</Table.Head>
              {isAdmin && <Table.Head />}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {state.versions.map((row) => (
              <Table.Row key={row.id}>
                <Table.Cell className="align-top">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={mono}>{row.appflareVersion ?? "unknown"}</span>
                    {row.serving && <Badge variant="success">Serving</Badge>}
                  </div>
                </Table.Cell>
                <Table.Cell className="align-top">
                  <span className={mono} title={row.id}>
                    {row.id.slice(0, 8)}
                  </span>
                </Table.Cell>
                <Table.Cell className="align-top whitespace-nowrap">
                  <Timestamp iso={row.createdOn} fallback="Unknown" />
                </Table.Cell>
                <Table.Cell className="align-top">
                  <Text as="span">{triggerLabel(row)}</Text>
                </Table.Cell>
                {isAdmin && (
                  <Table.Cell className="align-top">
                    <div className="flex justify-end">
                      {row.older && (
                        <RollbackDialog
                          row={row}
                          current={current}
                          disabled={result !== null}
                          onRolledBack={onRolledBack}
                        />
                      )}
                    </div>
                  </Table.Cell>
                )}
              </Table.Row>
            ))}
          </Table.Body>
        </SectionTable>
      )}
    </Section>
  );
}

/**
 * What the last rollback did: finished, switching traffic, or not answering
 * here yet. Plain banners: the section's status region around them is what
 * screen readers follow.
 */
function RollbackNotices({
  notice,
  switchingTo,
  switching,
  stalledAt,
}: {
  notice: RolledBack | null;
  switchingTo: string | null;
  switching: boolean;
  stalledAt: string | null;
}) {
  return (
    <>
      {notice !== null && (
        <SuccessBanner
          live={false}
          title={`Appflare rolled back to ${notice.version}`}
          description={
            <Link href={`/jobs/${notice.jobId}`} variant="inline">
              View log
            </Link>
          }
        />
      )}
      {switchingTo !== null && (
        <Banner
          variant="secondary"
          // The loader is a status of its own; the banner's title says what runs.
          icon={<AppflareLoader size="sm" aria-hidden />}
          title={`Switching to Appflare ${switchingTo}…`}
          description={
            switching
              ? "Cloudflare is moving traffic to it. This page reloads once it answers."
              : "This page reloads once it answers."
          }
        />
      )}
      {stalledAt !== null && (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title={`Rolled back to ${stalledAt}`}
          description="It did not answer here yet."
          action={
            <Banner.Action
              variant="secondary"
              icon={ArrowClockwiseIcon}
              onClick={() => window.location.reload()}
            >
              Reload
            </Banner.Action>
          }
        />
      )}
    </>
  );
}

function RollbackDialog({
  row,
  current,
  disabled,
  onRolledBack,
}: {
  row: ManagerVersionRow;
  current: string;
  disabled: boolean;
  onRolledBack: (result: RollBackManagerResult) => Promise<void>;
}) {
  const label = versionLabel(row);
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) => (
        <Button
          {...p}
          size="sm"
          variant="secondary"
          icon={<ArrowCounterClockwiseIcon />}
          disabled={disabled}
        >
          Roll back
        </Button>
      )}
      title={`Roll Appflare back to ${label}`}
      description={
        <>
          Redeploys Worker version <span className={mono}>{row.id}</span> (Appflare{" "}
          {row.appflareVersion ?? "version unknown"}) to all traffic, in place of Appflare {current}
          .
        </>
      }
      confirmText={label}
      actionLabel="Roll back"
      onConfirm={async () => {
        await onRolledBack(await rollBackManager({ data: { versionId: row.id } }));
      }}
    >
      <Banner
        variant="alert"
        icon={BANNER_ICON.alert}
        title="The database is not rolled back"
        description="Appflare's database stays as it is. When this version's code is older than the database's schema (a newer version migrated it since), Appflare refuses the rollback."
      />
      <ul className="grid list-disc gap-2 pl-5">
        <li>
          <Text>
            Before the switch, Appflare checks the version at its preview URL: it must answer as
            Appflare {label} with a working database.
          </Text>
        </li>
        <li>
          <Text>
            Cloudflare refuses a version whose secrets changed since it was deployed, such as an
            older API token. Pick a newer version of the same release then.
          </Text>
        </li>
        <li>
          <Text>
            Automatic updates of Appflare are turned off, so the older version is not updated again
            right away.
          </Text>
        </li>
      </ul>
      <Text variant="secondary">
        Nothing else may run during the rollback. This page reloads once the older version answers.
      </Text>
    </ConfirmDialog>
  );
}
