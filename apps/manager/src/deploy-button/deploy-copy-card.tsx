import { Link, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { DocsLink } from "../components/docs-link";
import { type DeployCopyCleanup, USER_API_TOKENS_URL } from "./deploy-copy";

/**
 * The two steps of cleaning up the deploy copy, each one line with the
 * button that goes there: disconnect Workers Builds from Appflare's Worker,
 * then delete the repository the Deploy to Cloudflare button copied.
 * Appflare cannot do either with its account token. Shown under Home's
 * "Clean up the deploy copy" row.
 */
export function DeployCopySteps({ cleanup }: { cleanup: DeployCopyCleanup }) {
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2">
        <CleanupStep
          step={1}
          title="Disconnect Workers Builds"
          hint="Settings › Builds › Disconnect"
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
      <span className="flex flex-wrap items-center gap-1">
        <Text variant="secondary" size="sm">
          Also delete the API token Workers Builds created, if any, from{" "}
          <Link href={USER_API_TOKENS_URL} target="_blank" rel="noopener noreferrer">
            your API tokens
            <Link.ExternalIcon />
          </Link>
          .
        </Text>
        <DocsLink topic="deployCopyCleanup" />
      </span>
    </div>
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
