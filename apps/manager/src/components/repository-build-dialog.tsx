import { parseRepositoryInput } from "@appflare/schema";
import { Button, Input, LayerDialog, Text } from "@cloudflare/kumo";
import { GitBranchIcon } from "@phosphor-icons/react";
import { type FormEvent, useId, useState } from "react";
import { GITHUB_ACCESS_PLACE } from "../github/tokens";
import { NOT_FROM_CATALOG } from "../installs/source-build-input";
import { startSourceBuild } from "../installs/source-builds.functions";
import type { SandboxReadiness } from "../sandbox/readiness";
import { DocsLink } from "./docs-link";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner, MessageText } from "./message-text";
import { SandboxMissingBanner } from "./sandbox-first";
import {
  BuildCommandField,
  buildCommandChoice,
  buildCommandError,
  INITIAL_BUILD_COMMAND,
  SourceBuildCostConfirmation,
} from "./source-build-fields";

/**
 * "From a repository" on the Catalog page (admins on Workers Paid; sandbox
 * builds on, or turned on first by the build when the account has what they
 * need, else the dialog says what is missing): the admin names a public
 * GitHub repository and
 * optionally a branch, tag or commit and a build command; the sandbox Worker
 * builds it, and the build's review page shows what it declares before
 * anything is installed. The build's log opens once it starts.
 */
export function RepositoryBuildButton({ sandbox }: { sandbox: SandboxReadiness }) {
  const jobStarted = useJobStarted();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("");
  const [buildCommand, setBuildCommand] = useState(INITIAL_BUILD_COMMAND);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = repository.trim().length === 0 ? null : parseRepositoryInput(repository);
  const repositoryError = parsed !== null && !parsed.ok ? parsed.error : null;
  const ready =
    sandbox.missing === null &&
    parsed?.ok === true &&
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
          kind: "repository",
          repository: repository.trim(),
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

  // Each opening starts from an empty form.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setRepository("");
      setRef("");
      setBuildCommand(INITIAL_BUILD_COMMAND);
      setCostConfirmed(false);
      setError(null);
    }
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      {/* The dialog's own trigger, so focus returns to the button when it closes. */}
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<GitBranchIcon />}>
            From a repository
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Install from a repository</LayerDialog.Title>
        <LayerDialog.Description>
          Any GitHub repository with a wrangler config. It is built in your account first; you
          review what it declares, then install it. {NOT_FROM_CATALOG}: Appflare never updates it on
          its own. <DocsLink topic="installFromRepository" variant="inline" />
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            <Input
              label="Repository"
              value={repository}
              onChange={(e) => setRepository(e.currentTarget.value)}
              placeholder="https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={pending}
              error={repositoryError ?? undefined}
              description={
                <MessageText
                  message={`Repositories on github.com. A private one needs a GitHub access token in ${GITHUB_ACCESS_PLACE}.`}
                  newTab
                />
              }
            />
            <Input
              label="Branch, tag or commit"
              value={ref}
              onChange={(e) => setRef(e.currentTarget.value)}
              placeholder={
                parsed?.ok === true && parsed.ref !== null ? parsed.ref : "The default branch"
              }
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              description="Optional. A branch or tag can be checked for changes later; a commit never moves."
            />
            <BuildCommandField
              value={buildCommand}
              onChange={setBuildCommand}
              disabled={pending}
              detectDescription="Runs its package.json build script, if it has one, with the package manager its lockfile names."
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
                what="the repository"
                sandboxFirst={sandbox.state === "ready-auto"}
              />
            )}
            <Text variant="secondary" size="sm">
              The build log opens once the build starts; its review opens from there when it
              finishes.
            </Text>
            {error !== null && <ErrorMessageBanner message={error} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            loading={pending}
            disabled={!ready}
          >
            Build for review
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
