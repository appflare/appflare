import { Badge, Banner, Link, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowRightIcon, TrashSimpleIcon } from "@phosphor-icons/react";
import type { RemovedAppRow } from "../installs/removed-apps.functions";
import { resourceKindLabel } from "./format";
import { BANNER_ICON, MessageText } from "./message-text";
import { DeleteRetainedDialog, ForgetDialog } from "./removed-app-actions";
import { Section, SectionEmpty, SectionRow, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

const mono = "font-mono text-[0.9em]";

/**
 * The removed apps settings' one section: uninstalled apps that still keep
 * data resources in the account, one row each with what it kept. Admins can
 * delete what an app kept (a job; its log opens) or forget the app, which
 * only hides it here: the resources stay in the account.
 */
export function RemovedAppsSection({ rows, isAdmin }: { rows: RemovedAppRow[]; isAdmin: boolean }) {
  return (
    <Section
      {...settingsSection("removedApps", "removed-apps")}
      description="Apps that were uninstalled but kept some of their data in the account."
      empty={
        rows.length === 0 ? (
          <SectionEmpty
            icon={<TrashSimpleIcon size={48} className="text-kumo-inactive" />}
            title="No removed apps"
            description="No uninstalled app that keeps data is listed. Apps you forgot are not listed here even when they still keep data; their own pages show what they kept."
          />
        ) : undefined
      }
    >
      <SectionRows>
        {rows.map((row) => (
          <RemovedAppItem key={row.id} row={row} isAdmin={isAdmin} />
        ))}
      </SectionRows>
    </Section>
  );
}

function RemovedAppItem({ row, isAdmin }: { row: RemovedAppRow; isAdmin: boolean }) {
  const busy = row.activeJobId !== null;
  return (
    <SectionRow
      id={`removed-${row.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/apps/${row.id}`}>{row.label}</Link>
          {busy && <Badge variant="info">Deleting</Badge>}
        </span>
      }
      description={
        <>
          {row.name}, Worker <span className={mono}>{row.workerName}</span>, uninstalled{" "}
          <Timestamp iso={row.uninstalledAt} />
        </>
      }
      action={
        busy ? (
          <LinkButton
            href={`/jobs/${row.activeJobId}`}
            variant="secondary"
            icon={<ArrowRightIcon />}
          >
            View log
          </LinkButton>
        ) : isAdmin ? (
          <>
            <DeleteRetainedDialog app={row} />
            <ForgetDialog app={row} />
          </>
        ) : null
      }
    >
      <div className="grid gap-1.5">
        <Text bold>Kept in the account</Text>
        <ul className="grid gap-1">
          {row.retained.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <span>{resourceKindLabel(r.kind)}</span>
              <span className={mono}>{r.name}</span>
            </li>
          ))}
        </ul>
      </div>
      {row.lastFailure !== null && !busy && (
        <Banner
          variant="error"
          icon={BANNER_ICON.error}
          title="Deleting the kept data did not finish"
          description={<MessageText message={row.lastFailure.error ?? "The job failed."} />}
          action={
            <LinkButton
              href={`/jobs/${row.lastFailure.jobId}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              View log
            </LinkButton>
          }
        />
      )}
    </SectionRow>
  );
}
