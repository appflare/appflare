import { Banner, Button, Link, useKumoToastManager } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowsClockwiseIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { type PendingAppUpdate, pendingUpdatesTitle } from "../installs/pending-updates";
import {
  type UpdateAllItem,
  type UpdateAllOutcome,
  updateAllSummary,
} from "../installs/update-all";
import { startAllUpdates } from "../installs/update-all.functions";
import type { StartUpdateHandle } from "./update-banner";

const mono = "font-mono text-[0.9em]";

/**
 * The home page's pending app updates, each linked to its app's page. For
 * admins, one update gets an "Update" button (the same as its row's) and
 * several get only "Update all" (no row buttons), which starts every update
 * that needs nothing from the admin and then lists the ones that do (a new
 * secret, a confirmation, an approval), each linked to the app's page where
 * its update asks for it. Appflare's own update is not listed here: the
 * sidebar's Appflare card offers it. Nothing when there is none.
 */
export function PendingUpdatesBanner({
  apps,
  isAdmin,
  update,
}: {
  apps: PendingAppUpdate[];
  isAdmin: boolean;
  /** The home page's start-update handle, shared with the rows. */
  update: StartUpdateHandle;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [updatingAll, setUpdatingAll] = useState(false);
  const [outcome, setOutcome] = useState<UpdateAllOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onUpdateAll() {
    setUpdatingAll(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await startAllUpdates({
        data: { installIds: apps.map((a) => a.installId) },
      });
      setOutcome(result);
      toasts.add({
        title: updateAllSummary(result),
        description:
          result.started.length > 0
            ? "Each app's status shows its update; its log shows each step."
            : undefined,
        variant: result.started.length > 0 ? "info" : "warning",
      });
      // The started apps now show as updating, and leave the count.
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the updates.");
    }
    setUpdatingAll(false);
  }

  const only = apps.length === 1 ? apps[0] : undefined;
  let action: ReactNode;
  if (isAdmin && only !== undefined) {
    action = (
      <Button
        variant="primary"
        icon={<ArrowCircleUpIcon />}
        loading={update.pendingId === only.installId}
        onClick={() => update.start({ id: only.installId, instanceName: only.instanceName })}
      >
        Update
      </Button>
    );
  } else if (isAdmin && apps.length > 1) {
    action = (
      <Button
        variant="primary"
        icon={<ArrowsClockwiseIcon />}
        loading={updatingAll}
        onClick={() => void onUpdateAll()}
      >
        Update all
      </Button>
    );
  }

  return (
    <>
      {apps.length > 0 && (
        <Banner
          variant="default"
          icon={<ArrowCircleUpIcon weight="fill" />}
          title={pendingUpdatesTitle(apps.length)}
          description={
            <ul className="grid gap-1">
              {apps.map((app) => (
                <li key={app.installId}>
                  <Link href={`/apps/${app.installId}`}>{app.instanceName}</Link>{" "}
                  <span className={mono}>{app.version}</span> to{" "}
                  <span className={mono}>{app.latestVersion}</span>
                </li>
              ))}
            </ul>
          }
          action={action}
        />
      )}
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
      {outcome !== null && outcome.needsInput.length > 0 && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Needs your input"
          description={
            <OutcomeList
              items={outcome.needsInput}
              lead="Open each app to give what its update needs and start it there."
            />
          }
        />
      )}
      {outcome !== null && outcome.notStarted.length > 0 && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Not started"
          description={<OutcomeList items={outcome.notStarted} />}
        />
      )}
    </>
  );
}

function OutcomeList({
  items,
  lead,
}: {
  items: (UpdateAllItem & { reason: string })[];
  lead?: string;
}) {
  return (
    <div className="grid gap-2">
      {lead !== undefined && <span>{lead}</span>}
      <ul className="grid gap-1">
        {items.map((item) => (
          <li key={item.installId}>
            <Link href={`/apps/${item.installId}`}>{item.instanceName}</Link>{" "}
            <span className={mono}>{item.version}</span>: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
