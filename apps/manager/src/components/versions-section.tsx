import {
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Input,
  LayerCard,
  Link,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { restoreDatabase, startRollback } from "../installs/versions.functions";
import type { RestoreDatabaseResult, SnapshotView } from "../installs/versions.server";
import { formatDateTime } from "./format";
import { StatusBadge } from "./status-badge";

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

function DialogHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1.5">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
      </div>
      <Dialog.Close
        aria-label="Close"
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            shape="square"
            icon={<XIcon />}
            aria-label="Close"
          />
        )}
      />
    </div>
  );
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
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        Versions
      </Text>
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
                      {formatDateTime(s.takenAt)}
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
                              <RollbackUnavailable />
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
    </section>
  );
}

/**
 * Cloudflare refuses to roll a Worker back across a Durable Object class
 * change, and the change itself (deleted or renamed classes) cannot be undone.
 */
function RollbackUnavailable() {
  return (
    <div className="grid max-w-64 justify-items-end gap-1">
      <Button size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon />} disabled>
        Roll back
      </Button>
      <Text variant="secondary" size="sm">
        Not available: this update changed the app's Durable Object classes, and Cloudflare refuses
        to roll a Worker back across such a change.
      </Text>
    </div>
  );
}

function RollbackDialog({ install, snapshot }: { install: InstallDetail; snapshot: SnapshotView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = snapshot.fromCatalogVersion ?? shortVersion(snapshot.fromVersionId);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setError(null);
  }

  async function onConfirm() {
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startRollback({
        data: { installId: install.id, snapshotId: snapshot.id },
      });
      await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the rollback.");
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} size="sm" variant="secondary" icon={<ArrowCounterClockwiseIcon />}>
            Roll back
          </Button>
        )}
      />
      <Dialog size="base" className="grid gap-6 px-6 py-5">
        <DialogHeader
          title={`Roll back ${install.instanceName} to ${target}`}
          description={
            <>
              Deploys Worker version <span className={mono}>{snapshot.fromVersionId}</span> again to
              all traffic, the version that served before the{" "}
              {snapshot.jobKind === "reconfigure" ? "settings change" : "update"} on{" "}
              {formatDateTime(snapshot.takenAt)}, with the settings and secrets it had then.
            </>
          }
        />
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Databases are not changed"
          description="If the newer version changed its data, the older code may not read it. Restore a database from this snapshot separately if you need its data as it was."
        />
        {install.emailRoutes.length > 0 && (
          <Banner
            variant="secondary"
            icon={<InfoIcon weight="fill" />}
            title="Email Routing is not changed"
            description="A rollback does not move the app's email back to another zone. If email moved since this snapshot, move it back under Settings."
          />
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
          <Button
            variant="primary"
            icon={<ArrowCounterClockwiseIcon />}
            loading={pending}
            onClick={onConfirm}
          >
            Roll back
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
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
    <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} size="sm" variant="secondary-destructive" icon={<DatabaseIcon />}>
            Restore {database.name} to this point
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <DialogHeader
          title={`Restore database ${database.name}`}
          description={
            <>
              Restores <span className={mono}>{database.name}</span> to this point: its state when
              the snapshot was taken on {formatDateTime(snapshot.takenAt)}
              {database.bookmark !== null && (
                <>
                  {" "}
                  (bookmark <span className={mono}>{database.bookmark}</span>)
                </>
              )}
              .
            </>
          }
        />
        {done === null ? (
          <form className="grid gap-5" onSubmit={onSubmit}>
            <Banner
              variant="alert"
              icon={<WarningIcon weight="fill" />}
              title="Everything written since then is replaced"
              description="The Worker is not changed. Cloudflare returns a bookmark of the database as it is now, so this restore can be undone by restoring to that bookmark."
            />
            <Input
              label={`Type ${database.name} to confirm`}
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
              <Button
                type="submit"
                variant="destructive"
                icon={<ClockCounterClockwiseIcon />}
                loading={pending}
                disabled={!confirmed}
              >
                Restore database
              </Button>
            </div>
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
            <div className="flex justify-end gap-2">
              <Link href={`/jobs/${done.jobId}`}>View log</Link>
              <Dialog.Close render={(props) => <Button {...props}>Close</Button>} />
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
