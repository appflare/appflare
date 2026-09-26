import {
  Banner,
  Button,
  ClipboardText,
  Input,
  LayerCard,
  LayerDialog,
  Link,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  DatabaseIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { rollbackDialogCopy } from "../installs/rollback-copy";
import { restoreDatabase, startRollback } from "../installs/versions.functions";
import type { RestoreDatabaseResult, SnapshotView } from "../installs/versions.server";
import { ConfirmDialog } from "./confirm-dialog";
import { useJobStarted } from "./job-started";
import { Section } from "./section";
import { StatusBadge } from "./status-badge";
import { Timestamp } from "./timestamp";

/**
 * The "Versions" section of `/apps/$installId`: one row per snapshot an
 * update or a settings change took (when, which catalog and Worker versions
 * it moved between, how the job ended). Admins can roll the Worker back to a snapshot's version,
 * and restore each D1 database to the bookmark the snapshot took; the two are
 * separate because a rollback never changes data.
 */

const mono = "font-mono text-[0.9em]";

function shortVersion(id: string | null): string {
  return id === null ? "none" : id.slice(0, 8);
}

export function VersionsSection({
  install,
  snapshots,
  isAdmin,
}: {
  install: InstallDetail;
  snapshots: SnapshotView[];
  isAdmin: boolean;
}) {
  // Actions need an installed app with no job running.
  const canAct = isAdmin && install.status === "installed" && install.activeJobId === null;
  return (
    <Section title="Versions">
      {install.build.kind === "self-deploying" ? (
        <Text variant="secondary">
          This app's own installer changes it in place on every update, so Appflare takes no
          snapshot and cannot roll it back. To undo an update, restore the app's data with its own
          tools; the job log of each update shows what the installer did.
        </Text>
      ) : snapshots.length === 0 ? (
        <Text variant="secondary">
          No updates or settings changes yet. Each takes a snapshot first: the Worker version that
          was serving, its settings, and a Time Travel bookmark of each D1 database.
        </Text>
      ) : (
        <>
          <LayerCard className="p-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Snapshot taken</Table.Head>
                  <Table.Head>Catalog version</Table.Head>
                  <Table.Head>Worker version</Table.Head>
                  <Table.Head>Job</Table.Head>
                  {canAct && <Table.Head />}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {snapshots.map((s) => (
                  <Table.Row key={s.id}>
                    <Table.Cell className="align-top whitespace-nowrap">
                      <Timestamp iso={s.takenAt} />
                    </Table.Cell>
                    <Table.Cell className="align-top">
                      <span className={mono}>{s.fromCatalogVersion ?? "unknown"}</span>
                      {s.jobKind === "reconfigure" ? (
                        <Text as="span" variant="secondary" size="sm">
                          {" "}
                          (settings change)
                        </Text>
                      ) : (
                        <>
                          {" → "}
                          <span className={mono}>{s.toCatalogVersion ?? "unknown"}</span>
                        </>
                      )}
                    </Table.Cell>
                    <Table.Cell className="align-top">
                      <span className={mono}>{shortVersion(s.fromVersionId)}</span>
                      {/* isCurrent means the version before the change serves again (rolled back). */}
                      {s.isCurrent && (
                        <Text as="span" variant="secondary" size="sm">
                          {" "}
                          (serving now)
                        </Text>
                      )}
                      {" → "}
                      <span className={mono}>{shortVersion(s.toVersionId)}</span>
                    </Table.Cell>
                    <Table.Cell className="align-top">
                      <Link href={`/jobs/${s.jobId}`}>
                        {s.jobStatus === null ? (
                          "Log"
                        ) : (
                          <StatusBadge status={s.jobStatus} of="job" />
                        )}
                      </Link>
                    </Table.Cell>
                    {canAct && (
                      <Table.Cell className="align-top">
                        <div className="flex flex-wrap justify-end gap-2">
                          {!s.isCurrent &&
                            (s.crossesDoMigration ? (
                              <RollbackUnavailable reason={DO_MIGRATION_REASON} />
                            ) : s.lostDatabase !== null ? (
                              <RollbackUnavailable reason={s.lostDatabase} />
                            ) : (
                              <RollbackDialog install={install} snapshot={s} />
                            ))}
                          {s.databases.map((d) => (
                            <RestoreDatabaseDialog
                              key={d.resourceId}
                              install={install}
                              snapshot={s}
                              database={d}
                            />
                          ))}
                        </div>
                      </Table.Cell>
                    )}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
          <Text variant="secondary" size="sm">
            A rollback redeploys the Worker version that served before an update; it never changes
            data. Restoring a database is a separate action. D1 keeps Time Travel history for 7 days
            on Workers Free and 30 days on Workers Paid; older bookmarks cannot be restored. Each
            uploaded version stays reachable at its own preview URL (
            <span className={mono}>&lt;version&gt;-{install.workerName}</span> on your workers.dev
            subdomain) until Cloudflare drops it from the Worker's version history.
          </Text>
        </>
      )}
    </Section>
  );
}

/**
 * Cloudflare refuses to roll a Worker back across a Durable Object class
 * change, and the change itself (deleted or renamed classes) cannot be undone.
 */
const DO_MIGRATION_REASON =
  "Not available: this update changed the app's Durable Object classes, and Cloudflare refuses to roll a Worker back across such a change.";

/**
 * A disabled rollback with the reason: a Durable Object class change, or a
 * version that binds a Hyperdrive configuration deleted since.
 */
function RollbackUnavailable({ reason }: { reason: string }) {
  return (
    <div className="grid max-w-64 justify-items-end gap-1">
      <Button size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon />} disabled>
        Roll back
      </Button>
      <Text variant="secondary" size="sm">
        {reason}
      </Text>
    </div>
  );
}

/**
 * Confirms a rollback. A snapshot of the code installed now (a settings
 * change) is worded as undoing that change and needs no word about data;
 * a rollback to other code says the databases stay as they are.
 */
function RollbackDialog({ install, snapshot }: { install: InstallDetail; snapshot: SnapshotView }) {
  const jobStarted = useJobStarted();
  const copy = rollbackDialogCopy(snapshot, install.label);
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon />}>
          {copy.button}
        </Button>
      )}
      title={copy.title}
      description={
        <>
          {copy.lead} Worker version <span className={mono}>{snapshot.fromVersionId}</span>.
        </>
      }
      actionLabel={copy.action}
      destructive={false}
      onConfirm={async () => {
        const { jobId } = await startRollback({
          data: { installId: install.id, snapshotId: snapshot.id },
        });
        await jobStarted(jobId, copy.button === "Undo" ? "Undoing the change" : "Rollback started");
      }}
    >
      {copy.warnData && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Databases are not changed"
          description="If the newer version changed its data, the older code may not read it. Restore a database from this snapshot separately if you need its data as it was."
        />
      )}
      {install.emailRoutes.length > 0 && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="Email Routing is not changed"
          description="A rollback does not move the app's email back to another zone. If email moved since this snapshot, move it back on the Settings tab."
        />
      )}
      {!copy.warnData && install.emailRoutes.length === 0 && (
        <Text variant="secondary">
          Databases, custom domains and Email Routing are not changed.
        </Text>
      )}
    </ConfirmDialog>
  );
}

function RestoreDatabaseDialog({
  install,
  snapshot,
  database,
}: {
  install: InstallDetail;
  snapshot: SnapshotView;
  database: SnapshotView["databases"][number];
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RestoreDatabaseResult | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setConfirm("");
      setError(null);
      setDone(null);
    } else if (done !== null) {
      // The restore is in the job history now.
      void router.invalidate();
    }
  }

  const confirmed = confirm.trim() === database.name;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      setDone(
        await restoreDatabase({
          data: {
            installId: install.id,
            snapshotId: snapshot.id,
            databaseResourceId: database.resourceId,
          },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore the database.");
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Alert open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} size="sm" variant="secondary-destructive" icon={<DatabaseIcon />}>
            Restore {database.name} to this point
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>
          {done === null ? `Restore database ${database.name}` : `Restored ${done.databaseName}`}
        </LayerDialog.Title>
        <LayerDialog.Description>
          Restores <span className={mono}>{database.name}</span> to this point: its state when the
          snapshot was taken on <Timestamp iso={snapshot.takenAt} />
          {database.bookmark !== null && (
            <>
              {" "}
              (bookmark <span className={mono}>{database.bookmark}</span>)
            </>
          )}
          .
        </LayerDialog.Description>
        <LayerDialog.Body>
          {done === null ? (
            <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title="Everything written since then is replaced"
                description="The Worker is not changed. Cloudflare returns a bookmark of the database as it is now, so this restore can be undone by restoring to that bookmark."
              />
              <Input
                label={
                  <>
                    Type <strong className="font-medium text-kumo-default">{database.name}</strong>{" "}
                    to confirm
                  </>
                }
                placeholder={database.name}
                value={confirm}
                onChange={(e) => setConfirm(e.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
              {error !== null && (
                <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
              )}
            </form>
          ) : (
            <div className="grid gap-5">
              <Banner
                icon={<CheckCircleIcon weight="fill" />}
                title={`Restored ${done.databaseName}`}
                description={
                  done.previousBookmark === null
                    ? "Cloudflare did not return a bookmark of the state before the restore."
                    : "To undo this restore, restore the database to the bookmark below, for example with wrangler."
                }
              />
              {done.previousBookmark !== null && (
                <div className="grid gap-2">
                  <Text bold>Bookmark from just before the restore</Text>
                  <ClipboardText text={done.previousBookmark} size="base" />
                  <ClipboardText
                    text={`wrangler d1 time-travel restore ${done.databaseName} --bookmark=${done.previousBookmark}`}
                    size="sm"
                  />
                </div>
              )}
              <Link href={`/jobs/${done.jobId}`}>View log</Link>
            </div>
          )}
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={done === null ? "Cancel" : "Close"}>
          {done === null ? (
            <LayerDialog.Actions.Primary
              type="submit"
              form={formId}
              variant="destructive"
              loading={pending}
              disabled={!confirmed}
            >
              Restore database
            </LayerDialog.Actions.Primary>
          ) : (
            <LayerDialog.Actions.Primary onClick={() => onOpenChange(false)}>
              Done
            </LayerDialog.Actions.Primary>
          )}
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
}
