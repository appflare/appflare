import { parseRepositoryInput } from "@appflare/schema";
import { Banner, Button, Input, LayerDialog, Text } from "@cloudflare/kumo";
import { GitBranchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type FormEvent, useId, useState } from "react";
import { NOT_FROM_CATALOG } from "../installs/source-build-input";
import { startSourceBuild } from "../installs/source-builds.functions";
import type { SandboxReadiness } from "../sandbox/readiness";
import { DocsLink } from "./docs-link";
import { useJobStarted } from "./job-started";
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" icon={<GitBranchIcon />} onClick={() => setOpen(true)}>
        From a repository
      </Button>
      {open && <RepositoryBuildDialog sandbox={sandbox} onClose={() => setOpen(false)} />}
    </>
  );
}

function RepositoryBuildDialog({
  sandbox,
  onClose,
}: {
  sandbox: SandboxReadiness;
  onClose(): void;
}) {
  const jobStarted = useJobStarted();
  const formId = useId();
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

  return (
    <LayerDialog.Root
      open
      onOpenChange={(next) => !next && onClose()}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Install from a repository</LayerDialog.Title>
        <LayerDialog.Description>
          Any public GitHub repository with a wrangler config. It is built in your account first;
          you review what it declares, then install it. {NOT_FROM_CATALOG}: Appflare never updates
          it on its own. <DocsLink topic="installFromRepository" variant="inline" />
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
              description="Public repositories on github.com only."
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
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
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
