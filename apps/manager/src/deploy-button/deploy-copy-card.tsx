import { Banner, Button, LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  GitBranchIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { DocsLink } from "../components/docs-link";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import type { DeployCopyCleanup } from "./deploy-copy";

const mono = "font-mono text-[0.9em]";

/**
 * "Clean up the deploy copy", on the home page of a manager the "Deploy to
 * Cloudflare" button deployed, for admins, until one of them dismisses it:
 * disconnect Workers Builds from the Worker, then delete the repository the
 * button copied. Appflare cannot do either with its account token.
 */
export function DeployCopyCard({
  cleanup,
  onDismiss,
}: {
  cleanup: DeployCopyCleanup;
  onDismiss: () => Promise<void>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dismiss() {
    setDismissing(true);
    setError(null);
    try {
      await onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dismiss the card.");
      setDismissing(false);
    }
  }

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
          loading={dismissing}
          onClick={() => void dismiss()}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text>
          The Deploy to Cloudflare button copied Appflare's deploy repository into your GitHub or
          GitLab account and connected that copy to this Worker with Workers Builds. Appflare
          updates itself from signed releases and needs neither.
        </Text>
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="While the copy stays connected, any push to it deploys the old version it holds over this one."
        />
        <ol className="grid list-decimal gap-3 pl-5">
          <li className="grid gap-1.5">
            <Text>
              Disconnect Workers Builds: open the Worker's settings
              {cleanup.workerName !== null && (
                <>
                  {" "}
                  (<span className={mono}>{cleanup.workerName}</span>)
                </>
              )}
              , and under <strong>Builds</strong> select <strong>Disconnect</strong>.
            </Text>
            <span>
              <LinkButton
                href={cleanup.workerSettingsUrl}
                external
                variant="secondary"
                icon={<ArrowSquareOutIcon />}
              >
                Open the Worker's settings
              </LinkButton>
            </span>
          </li>
          <li className="grid gap-1.5">
            <Text>
              Delete the copy: open the repository, then Settings, and at the bottom select{" "}
              <strong>Delete this repository</strong>. On GitLab, it is in your projects list.
            </Text>
            <span>
              <LinkButton
                href={cleanup.repositorySearchUrl}
                external
                variant="secondary"
                icon={<ArrowSquareOutIcon />}
              >
                Find the copy on GitHub
              </LinkButton>
            </span>
          </li>
        </ol>
        <Text variant="secondary" size="sm">
          Workers Builds may also have created an API token for its builds (dashboard, My Profile,
          API Tokens); delete it too. Dismiss this card once you are done.
        </Text>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
      </LayerCard.Primary>
    </LayerCard>
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
