import { Button, Collapsible, Input, LayerCard, Text } from "@cloudflare/kumo";
import { GitBranchIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { startSourceBuild } from "../installs/source-builds.functions";
import type { SandboxReadiness } from "../sandbox/readiness";
import { DocsLink } from "./docs-link";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner } from "./message-text";
import { SandboxMissingBanner } from "./sandbox-first";
import {
  BuildCommandField,
  buildCommandChoice,
  buildCommandError,
  INITIAL_BUILD_COMMAND,
  SourceBuildCostConfirmation,
} from "./source-build-fields";

/**
 * "Advanced: build from source at a commit" under a catalog app's install
 * form (admins on Workers Paid; sandbox builds on, or turned on first by the
 * build when the account has what they need): builds the app's
 * repository at a branch, tag or commit the admin chooses, with the catalog's
 * manifest (secrets, settings, build command) as the baseline. The review
 * shows what that commit declares and how it differs from the catalog's
 * release before anything is installed; the install is marked as built from
 * source and is not the catalog's checked release.
 */
export function BuildFromSourceCard({
  slug,
  appName,
  repo,
  pinnedRef,
  sandbox,
}: {
  slug: string;
  appName: string;
  /** `owner/repo` of the app's upstream repository. */
  repo: string;
  /** The ref the catalog's release is pinned to, shown as the example. */
  pinnedRef: string;
  /** Sandbox builds: on, turned on first by this build, or what is missing. */
  sandbox: SandboxReadiness;
}) {
  const jobStarted = useJobStarted();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const [buildCommand, setBuildCommand] = useState(INITIAL_BUILD_COMMAND);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    sandbox.missing === null &&
    buildCommandError(buildCommand) === null &&
    costConfirmed &&
    !pending;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startSourceBuild({
        data: {
          kind: "source",
          slug,
          ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
          buildCommand: buildCommandChoice(buildCommand),
          costConfirmed,
        },
      });
      await jobStarted(jobId, "Build started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the build.");
      setPending(false);
    }
  }

  return (
    <LayerCard>
      <LayerCard.Primary className="px-5 py-4">
        <Collapsible.Root open={open} onOpenChange={setOpen}>
          <Collapsible.DefaultTrigger>
            Advanced: build from source at a commit
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <form className="grid gap-5 pt-2" onSubmit={onSubmit}>
              <Text variant="secondary">
                Builds {appName} from {repo} at the branch, tag or commit you choose, in your
                account, with the catalog's secrets and settings. The catalog checked only its own
                release, so this build is not checked, and Appflare does not update it on its own.{" "}
                <DocsLink topic="installFromRepository" variant="inline" />
              </Text>
              <Input
                label="Branch, tag or commit"
                value={ref}
                onChange={(e) => setRef(e.currentTarget.value)}
                placeholder={`The default branch (the catalog's release is ${pinnedRef})`}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
              <BuildCommandField
                value={buildCommand}
                onChange={setBuildCommand}
                disabled={pending}
                detectDescription="The catalog's build command for this app, else its package.json build script."
              />
              {sandbox.missing !== null ? (
                <SandboxMissingBanner
                  title="Sandbox builds are off, and Appflare cannot turn them on"
                  missing={sandbox.missing}
                />
              ) : (
                <SourceBuildCostConfirmation
                  checked={costConfirmed}
                  onChange={setCostConfirmed}
                  disabled={pending}
                  what={`${appName} at that commit`}
                  sandboxFirst={sandbox.state === "ready-auto"}
                />
              )}
              {error !== null && <ErrorMessageBanner message={error} newTab />}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="secondary"
                  icon={<GitBranchIcon />}
                  loading={pending}
                  disabled={!ready}
                >
                  Build for review
                </Button>
              </div>
            </form>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </LayerCard.Primary>
    </LayerCard>
  );
}
