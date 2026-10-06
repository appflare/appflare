import { Banner, Checkbox, LayerDialog, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  EnvelopeSimpleIcon,
  InfoIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { reinstallSentence } from "../installs/tier-change";
import { startUpdate } from "../installs/versions.functions";
import type { UpdateNeeds } from "../installs/versions.server";
import { appLink } from "./app-links";
import { BusyButton, BusyMark, busyActionProps } from "./busy-button";
import { CronTriggersField } from "./cron-triggers-field";
import { connectionsComplete, DatabaseFields, optionalConnectionsValid } from "./database-fields";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner } from "./message-text";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import {
  initialSecretValues,
  SecretFields,
  secretsComplete,
  withSecretValue,
} from "./secret-fields";

/**
 * The update state of `/apps/$installId`: an update or rollback running
 * (with a link to its log), "Update available to <version>" with an Update
 * button for admins, or, when the catalog entry changed how the app is
 * installed, that the new version takes a reinstall, with no Update button
 * (tier-change.ts). The button starts the update job and opens its log; when
 * the new version introduces secrets or databases elsewhere (whose
 * connection strings it asks for), cannot be checked on a preview before
 * it serves traffic, or adds cron triggers, a dialog asks for the secrets and
 * the confirmations first (for cron triggers, unless Settings records the
 * account as on Workers Paid, an optional "This account is on Workers Paid",
 * which skips the job's count of the account's triggers and can be
 * remembered for the account).
 */
export function UpdateBanner({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
  const update = useStartUpdate();

  if (install.status === "updating") {
    const job = install.jobs.find((j) => j.id === install.activeJobId);
    return (
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title={
          job?.kind === "rollback"
            ? "Rolling back"
            : job?.kind === "reconfigure"
              ? "Saving settings"
              : "Updating"
        }
        description={
          job?.kind === "reconfigure"
            ? install.build.kind === "self-deploying"
              ? "The app's own installer is applying the new settings."
              : "The current version keeps serving until the one with the new settings has passed its checks."
            : "The current version keeps serving until the new one has passed its checks."
        }
        action={
          install.activeJobId !== null ? (
            <LinkButton
              href={`/jobs/${install.activeJobId}`}
              variant="secondary"
              icon={<ArrowRightIcon />}
            >
              View log
            </LinkButton>
          ) : undefined
        }
      />
    );
  }
  if (install.reinstallNeeded && install.latestVersion !== null) {
    return (
      <Banner
        variant="alert"
        icon={<WarningIcon weight="fill" />}
        title={`${install.latestVersion} takes a reinstall`}
        description={`Installed: ${install.version}. ${reinstallSentence(install.build.kind)}`}
        action={
          isAdmin ? (
            <LinkButton href={appLink(install.id, "danger-zone")} variant="secondary">
              Go to Uninstall
            </LinkButton>
          ) : undefined
        }
      />
    );
  }
  if (!install.updateAvailable || install.latestVersion === null) return null;

  const canStart = isAdmin && install.activeJobId === null;
  return (
    <div className="grid gap-3">
      <Banner
        icon={<ArrowCircleUpIcon weight="fill" />}
        title={`Update available to ${install.latestVersion}`}
        description={`Installed: ${install.version}. Appflare takes a snapshot first, checks the new version before it serves any traffic where Cloudflare allows it, and keeps the current one for a rollback.`}
        action={
          canStart ? (
            <BusyButton
              pending={update.pendingId === install.id}
              variant="secondary"
              icon={<ArrowCircleUpIcon />}
              onClick={() => update.start(install)}
            >
              Update
            </BusyButton>
          ) : undefined
        }
      />
      {update.error !== null && <ErrorMessageBanner message={update.error.message} />}
      {update.dialog}
    </div>
  );
}

/**
 * The note under each secret field that holds a token a new event stream's
 * sink writes with, by secret name (`SecretFields`' `fieldExtras`). Shared
 * by the update dialog and the update from a reviewed build.
 */
export function streamTokenNotes(names: readonly string[]): Record<string, ReactNode> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      <Text key={name} variant="secondary" size="sm">
        This version sends events into a new table in R2. Cloudflare keeps this token as the
        credential its event stream writes with.
      </Text>,
    ]),
  );
}

/** The connection strings entered, without the fields left empty (an optional one keeps its connection). */
export function filledConnections(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
}

/** What starting an update needs to know about the install. */
export type UpdateTarget = Pick<InstallDetail, "id" | "label">;

/**
 * Starting an app's update from a button: the update job starts and its log
 * opens, or, when the new version needs secrets or confirmations, `dialog`
 * asks for them first. `pendingId` is the install whose start is in
 * flight; `error` says why the last start was refused.
 */
export interface StartUpdateHandle {
  start(install: UpdateTarget): void;
  pendingId: string | null;
  error: { installId: string; message: string } | null;
  /** The dialog asking for what the update needs; render it once. */
  dialog: ReactNode;
}

export function useStartUpdate(): StartUpdateHandle {
  const jobStarted = useJobStarted();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ installId: string; message: string } | null>(null);
  const [asking, setAsking] = useState<{ install: UpdateTarget; needs: UpdateNeeds } | null>(null);

  async function start(install: UpdateTarget) {
    setPendingId(install.id);
    setError(null);
    try {
      // The admin pressed Update: optional choices are offered too.
      const result = await startUpdate({ data: { installId: install.id, offerChoices: true } });
      if ("jobId" in result) {
        await jobStarted(result.jobId, "Update started");
        return;
      }
      setAsking({ install, needs: result });
    } catch (err) {
      setError({
        installId: install.id,
        message: err instanceof Error ? err.message : "Could not start the update.",
      });
    }
    setPendingId(null);
  }

  return {
    start: (install) => void start(install),
    pendingId,
    error,
    dialog:
      asking === null ? null : (
        <UpdateDialog
          install={asking.install}
          needs={asking.needs}
          onClose={() => setAsking(null)}
        />
      ),
  };
}

function UpdateDialog({
  install,
  needs,
  onClose,
}: {
  install: UpdateTarget;
  needs: UpdateNeeds;
  onClose(): void;
}) {
  const jobStarted = useJobStarted();
  const formId = useId();
  const [secrets, setSecrets] = useState(() =>
    initialSecretValues(needs.needsSecrets, needs.heldSecrets),
  );
  /** Connection strings of the databases this version adds; never stored by Appflare. */
  const databases = needs.needsDatabases ?? [];
  /** Databases an earlier update connected: a string replaces that connection, empty keeps it. */
  const replaceable = needs.replaceableDatabases ?? [];
  const [connections, setConnections] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(needs.skipsPreview === null);
  const [buildConfirmed, setBuildConfirmed] = useState(needs.build === null);
  /** A sandbox build may turn out to have no preview; the admin may accept that up front. */
  const [allowNoPreview, setAllowNoPreview] = useState(false);
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [rememberPaid, setRememberPaid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    confirmed &&
    buildConfirmed &&
    secretsComplete(needs.needsSecrets, secrets) &&
    connectionsComplete(databases, connections) &&
    optionalConnectionsValid(replaceable, connections);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await startUpdate({
        data: {
          installId: install.id,
          secrets,
          ...(databases.length + replaceable.length === 0
            ? {}
            : { hyperdrive: filledConnections(connections) }),
          confirmNoPreview: needs.skipsPreview !== null || allowNoPreview,
          ...(needs.build === null ? {} : { buildConfirmed: true }),
          ...(needs.cronTriggers === null
            ? {}
            : {
                paidConfirmed,
                ...(paidConfirmed && rememberPaid ? { rememberPaidPlan: true } : {}),
              }),
          ...(needs.emailRouting === undefined ? {} : { confirmEmailRouting: needs.version }),
        },
      });
      if ("jobId" in result) {
        await jobStarted(result.jobId, "Update started");
        return;
      }
      setError("The catalog changed while this form was open. Close it and try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    }
    setPending(false);
  }

  return (
    <LayerDialog.Root
      open
      onOpenChange={(open) => !open && onClose()}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>
          Update {install.label} to {needs.version}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {needs.selfDeploying === true
            ? "The app's own installer deploys the new version over the installed one. There is no snapshot and no rollback."
            : "Appflare takes a snapshot of the current version and of each D1 database first."}
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            {needs.build !== null && (
              <SandboxBuildConfirmation
                build={needs.build}
                checked={buildConfirmed}
                onChange={setBuildConfirmed}
                disabled={pending}
                action="update"
                kind={needs.selfDeploying === true ? "installer" : "build"}
              />
            )}
            {needs.build !== null &&
              needs.skipsPreview === null &&
              needs.selfDeploying !== true && (
                <Checkbox
                  checked={allowNoPreview}
                  onCheckedChange={(checked: boolean) => setAllowNoPreview(checked)}
                  disabled={pending}
                  label="If the built version cannot be checked on a preview first (it changes or implements Durable Objects), update without that check"
                />
              )}
            {needs.skipsPreview !== null && (
              <div className="grid gap-3">
                <Banner
                  variant="alert"
                  icon={<WarningIcon weight="fill" />}
                  title="No preview check for this update"
                  description={`${needs.skipsPreview}.`}
                />
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(checked: boolean) => setConfirmed(checked)}
                  disabled={pending}
                  label="Update without checking the new version first"
                />
              </div>
            )}
            {needs.emailRouting !== undefined && (
              <Banner
                variant="secondary"
                icon={<EnvelopeSimpleIcon />}
                title="Email changes with this version"
                description={needs.emailRouting}
              />
            )}
            {needs.cronTriggers !== null && (
              <CronTriggersField
                count={needs.cronTriggers}
                confirmation={{
                  checked: paidConfirmed,
                  onChange: setPaidConfirmed,
                  remember: rememberPaid,
                  onRememberChange: setRememberPaid,
                  disabled: pending,
                }}
              />
            )}
            {needs.needsSecrets.length > 0 && (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Text bold>New secrets</Text>
                  <Text variant="secondary" size="sm">
                    {(needs.heldSecrets ?? []).length > 0
                      ? "This version needs secrets the app does not have yet, or the value of one it has again."
                      : "This version needs secrets the app does not have yet."}{" "}
                    They are stored as encrypted secrets on the app's Worker; Appflare keeps only
                    their names.
                  </Text>
                </div>
                <SecretFields
                  secrets={needs.needsSecrets}
                  vars={needs.derivedVars ?? []}
                  held={needs.heldSecrets ?? []}
                  values={secrets}
                  onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
                  after="the update"
                  fieldExtras={streamTokenNotes(needs.streamTokens ?? [])}
                  disabled={pending}
                />
              </div>
            )}
            {databases.length > 0 && (
              <DatabaseFields
                databases={databases}
                values={connections}
                onChange={(binding, value) => setConnections((c) => ({ ...c, [binding]: value }))}
                disabled={pending}
              />
            )}
            {replaceable.length > 0 && (
              <DatabaseFields
                databases={replaceable}
                values={connections}
                onChange={(binding, value) => setConnections((c) => ({ ...c, [binding]: value }))}
                replacing
                disabled={pending}
              />
            )}
            {error !== null && <ErrorMessageBanner message={error} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            {...busyActionProps(pending, !ready)}
          >
            <BusyMark pending={pending} />
            Update
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
