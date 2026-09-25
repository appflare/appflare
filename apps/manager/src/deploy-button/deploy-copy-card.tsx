import { Banner, Button, LayerCard, Link, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, GitBranchIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { DocsLink } from "../components/docs-link";
import { useOptimisticDismiss } from "../components/use-optimistic-dismiss";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import { type DeployCopyCleanup, USER_API_TOKENS_URL } from "./deploy-copy";

const mono = "font-mono text-[0.9em]";

/**
 * "Clean up the deploy copy", on the home page of a manager the "Deploy to
 * Cloudflare" button deployed, for admins, until one of them dismisses it:
 * disconnect Workers Builds from the Worker, then delete the repository the
 * button copied, each step one line with its link. Appflare cannot do either
 * with its account token. Dismiss hides the card at once; `onDismiss` saves
 * that in the background, and a failed save shows the card again.
 */
export function DeployCopyCard({
  cleanup,
  onDismiss,
}: {
  cleanup: DeployCopyCleanup;
  /** Saves the dismissal for every admin. */
  onDismiss: () => Promise<void>;
}) {
  const { hidden, dismiss } = useOptimisticDismiss(onDismiss);
  if (hidden) return null;
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <GitBranchIcon />
          <Text bold>Clean up the deploy copy</Text>
          <DocsLink topic="deployCopyCleanup" />
        </span>
        <Button
          variant="ghost"
          shape="square"
          icon={<XIcon />}
          aria-label="Dismiss"
          title="Dismiss"
          onClick={dismiss}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-3 px-5 py-4">
        <Banner
          size="sm"
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="While the copy stays connected, a push to it redeploys the older Appflare it holds."
        />
        <ol className="grid gap-2">
          <CleanupStep
            step={1}
            title="Disconnect Workers Builds"
            hint={
              cleanup.workerName === null ? (
                "Your Worker › Settings › Builds › Disconnect"
              ) : (
                <>
                  <span className={mono}>{cleanup.workerName}</span> › Builds › Disconnect
                </>
              )
            }
            action={
              <LinkButton
                href={cleanup.workerSettingsUrl}
                external
                size="sm"
                variant="secondary"
                icon={<ArrowSquareOutIcon />}
              >
                Open Builds
              </LinkButton>
            }
          />
          <CleanupStep
            step={2}
            title="Delete the repository copy"
            hint="Settings › Delete this repository"
            action={
              <LinkButton
                href={cleanup.repositorySearchUrl}
                external
                size="sm"
                variant="secondary"
                icon={<ArrowSquareOutIcon />}
              >
                Find on GitHub
              </LinkButton>
            }
          />
        </ol>
        <Text variant="secondary" size="sm">
          Also delete the API token Workers Builds created, if any, from{" "}
          <Link href={USER_API_TOKENS_URL} target="_blank" rel="noopener noreferrer">
            your API tokens
            <Link.ExternalIcon />
          </Link>
          .
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** One numbered step: what to do, where, and the button that goes there, on one line. */
function CleanupStep({
  step,
  title,
  hint,
  action,
}: {
  step: number;
  title: string;
  hint: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-recessed font-medium text-kumo-strong text-xs"
      >
        {step}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <Text as="span" bold>
          {title}
        </Text>
        <Text as="span" variant="secondary" size="sm">
          {hint}
        </Text>
      </span>
      {action}
    </li>
  );
}

/**
 * Shown to everyone while an older version of Appflare serves a database a
 * newer version migrated (see `schemaDowngrade`), with the way back to the
 * newest release.
 */
export function DowngradeBanner({
  version,
  deployButton,
}: {
  version: string;
  /** Whether the button deployed this manager: a push to its copy is the likely cause. */
  deployButton: boolean;
}) {
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title={`This Appflare (${version}) is older than its database`}
      description={`A newer version of Appflare set up this database, and an older one now serves it: after a rollback in the Cloudflare dashboard, or a redeploy of an old build${deployButton ? ", such as a push to the repository the Deploy to Cloudflare button copied" : ""}. Appflare keeps working, but what the newer version added is missing until you update again.`}
      action={
        <LinkButton href={MANAGER_UPDATES_HREF} variant="secondary">
          Update Appflare
        </LinkButton>
      }
    />
  );
}
