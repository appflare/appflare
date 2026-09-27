import { Banner, Button, LayerCard, LayerDialog, Link, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, GitBranchIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, useId, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { checkSourceChanges, startSourceBuild } from "../installs/source-builds.functions";
import type { SourceChanges } from "../installs/source-builds.server";
import { DocsLink } from "./docs-link";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner } from "./message-text";
import { OriginBadge } from "./origin-badge";
import { SourceBuildCostConfirmation } from "./source-build-fields";

const mono = "font-mono text-[0.9em]";

/**
 * The Overview card of an install whose code does not come from the catalog
 * (a repository, or a catalog app built from source): where it came from,
 * "Check for changes" (the newest commit of the branch or tag it follows),
 * and "Rebuild and update", which builds that commit for review; the review
 * then starts the ordinary update. Appflare never does either on its own.
 */
export function SourceChangesCard({
  install,
  isAdmin,
}: {
  install: InstallDetail;
  isAdmin: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [changes, setChanges] = useState<SourceChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  if (install.origin === "catalog" || install.source === null) return null;
  const { source } = install;
  const repo = source.url.replace(/^https:\/\/github\.com\//, "");
  const canAct = isAdmin && install.status === "installed" && install.activeJobId === null;

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setChanges(await checkSourceChanges({ data: { installId: install.id } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check for changes.");
    }
    setChecking(false);
  }

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-1">
          Source
          <DocsLink topic="repositoryUpdates" />
        </span>
        <OriginBadge origin={install.origin} />
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text>
          Built from{" "}
          <Link href={source.url} target="_blank" rel="noopener noreferrer">
            {repo}
            <Link.ExternalIcon />
          </Link>{" "}
          at <span className={mono}>{source.ref}</span>
          {install.pinSha !== null && (
            <>
              {" "}
              (<span className={mono}>{install.pinSha.slice(0, 12)}</span>)
            </>
          )}
          .{" "}
          {install.origin === "repository"
            ? "The catalog never reviewed it, and Appflare never updates it on its own."
            : "The catalog did not check this commit. Updating from the catalog puts its checked release back."}
        </Text>
        {changes !== null && (
          <Banner
            variant={changes.changed ? "alert" : "default"}
            icon={<GitBranchIcon weight="fill" />}
            title={
              changes.pinned
                ? "Pinned to a commit"
                : changes.changed
                  ? `${changes.ref} has moved to ${changes.latest.slice(0, 12)}`
                  : `No new commits on ${changes.ref}`
            }
            description={
              changes.pinned
                ? "It was built from a commit, which never changes. Rebuild it to pick up a new build command or a moved dependency."
                : changes.changed
                  ? `Installed: ${changes.installed?.slice(0, 12) ?? "unknown"}. Rebuild it to review the changes before updating.`
                  : `Still at ${changes.latest.slice(0, 12)}, the commit installed.`
            }
          />
        )}
        {error !== null && <ErrorMessageBanner message={error} newTab />}
        {isAdmin && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              icon={<MagnifyingGlassIcon />}
              loading={checking}
              onClick={() => void check()}
            >
              Check for changes
            </Button>
            <Button
              variant="secondary"
              icon={<ArrowsClockwiseIcon />}
              disabled={!canAct}
              onClick={() => setRebuilding(true)}
            >
              Rebuild and update
            </Button>
          </div>
        )}
      </LayerCard.Primary>
      {rebuilding && (
        <RebuildDialog
          install={install}
          target={changes?.latest ?? null}
          onClose={() => setRebuilding(false)}
        />
      )}
    </LayerCard>
  );
}

/** Confirms the rebuild's cost, then starts it; its log opens, and its review follows. */
function RebuildDialog({
  install,
  target,
  onClose,
}: {
  install: InstallDetail;
  /** The commit "Check for changes" found, if it ran. */
  target: string | null;
  onClose(): void;
}) {
  const jobStarted = useJobStarted();
  const formId = useId();
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!costConfirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startSourceBuild({
        data: { kind: "rebuild", installId: install.id, costConfirmed },
      });
      await jobStarted(jobId, "Rebuild started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the rebuild.");
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root
      open
      onOpenChange={(open) => !open && onClose()}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Rebuild {install.label}</LayerDialog.Title>
        <LayerDialog.Description>
          Builds the newest commit of {install.source?.ref ?? "its branch"}
          {target === null ? "" : ` (${target.slice(0, 12)} when you checked)`} for review. Nothing
          changes until you review it and choose Update.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            <SourceBuildCostConfirmation
              checked={costConfirmed}
              onChange={setCostConfirmed}
              disabled={pending}
              what={`${install.name} again`}
            />
            {error !== null && <ErrorMessageBanner message={error} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            loading={pending}
            disabled={!costConfirmed}
          >
            Rebuild for review
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
