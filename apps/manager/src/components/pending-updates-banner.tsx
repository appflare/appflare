import { Banner, Link } from "@cloudflare/kumo";
import { ArrowCircleUpIcon } from "@phosphor-icons/react";
import {
  MANAGER_UPDATES_HREF,
  type PendingUpdates,
  pendingUpdatesTitle,
} from "../installs/pending-updates";

const mono = "font-mono text-[0.9em]";

/**
 * The home page's pending updates: each app with an update, linked to its
 * page (where the update starts), and a newer Appflare release, linked to
 * Settings (where the self-update starts). Nothing when there is none.
 */
export function PendingUpdatesBanner({ pending }: { pending: PendingUpdates }) {
  if (pending.total === 0) return null;
  return (
    <Banner
      variant="default"
      icon={<ArrowCircleUpIcon weight="fill" />}
      title={pendingUpdatesTitle(pending.total)}
      description={
        <ul className="grid gap-1">
          {pending.apps.map((app) => (
            <li key={app.installId}>
              <Link href={`/apps/${app.installId}`}>{app.instanceName}</Link>{" "}
              <span className={mono}>{app.version}</span> to{" "}
              <span className={mono}>{app.latestVersion}</span>
            </li>
          ))}
          {pending.manager !== null && (
            <li>
              <Link href={MANAGER_UPDATES_HREF}>Appflare</Link>{" "}
              <span className={mono}>{pending.manager.current}</span> to{" "}
              <span className={mono}>{pending.manager.latest}</span>, in Settings
            </li>
          )}
        </ul>
      }
    />
  );
}
