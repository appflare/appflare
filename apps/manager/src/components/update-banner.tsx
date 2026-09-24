import { Banner, Button, Checkbox, Dialog, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowCircleUpIcon,
  ArrowRightIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { InstallDetail } from "../installs/installs.functions";
import { startUpdate } from "../installs/versions.functions";
import type { UpdateNeeds } from "../installs/versions.server";
import { CronTriggersField } from "./cron-triggers-field";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import { initialSecretValues, SecretFields, secretsComplete } from "./secret-fields";

/**
 * The update state of `/apps/$installId`: an update or rollback running
 * (with a link to its log), or "Update available to <version>" with an Update
 * button for admins. The button starts the update job and opens its log; when
 * the new version introduces secrets, cannot be checked on a preview before
 * it serves traffic, or adds cron triggers, a dialog asks for the secrets and
 * the confirmations first (for cron triggers, unless Settings records the
 * account as on Workers Paid, an optional "This account is on Workers Paid",
 * which skips the job's count of the account's triggers and can be
 * remembered for the account).
 */
export function UpdateBanner({ install, isAdmin }: { install: InstallDetail; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<UpdateNeeds | null>(null);

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
  if (!install.updateAvailable || install.latestVersion === null) return null;

  async function onUpdate() {
    setPending(true);
    setError(null);
    try {
      const result = await startUpdate({ data: { installId: install.id } });
      if ("jobId" in result) {
        await router.navigate({ to: "/jobs/$jobId", params: { jobId: result.jobId } });
        return;
      }
      setNeeds(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    }
    setPending(false);
  }

  const canStart = isAdmin && install.activeJobId === null;
  return (
    <div className="grid gap-3">
      <Banner
        icon={<ArrowCircleUpIcon weight="fill" />}
        title={`Update available to ${install.latestVersion}`}
        description={`Installed: ${install.version}. Appflare takes a snapshot first, checks the new version before it serves any traffic where Cloudflare allows it, and keeps the current one for a rollback.`}
        action={
          canStart ? (
            <Button
              variant="primary"
              icon={<ArrowCircleUpIcon />}
              loading={pending}
              onClick={onUpdate}
            >
              Update
            </Button>
          ) : undefined
        }
      />
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
      {needs !== null && (
        <UpdateDialog install={install} needs={needs} onClose={() => setNeeds(null)} />
      )}
    </div>
  );
}

function UpdateDialog({
  install,
  needs,
  onClose,
}: {
  install: InstallDetail;
  needs: UpdateNeeds;
  onClose(): void;
}) {
  const router = useRouter();
  const [secrets, setSecrets] = useState(() => initialSecretValues(needs.needsSecrets));
  const [confirmed, setConfirmed] = useState(needs.skipsPreview === null);
  const [buildConfirmed, setBuildConfirmed] = useState(needs.build === null);
  /** A sandbox build may turn out to have no preview; the admin may accept that up front. */
  const [allowNoPreview, setAllowNoPreview] = useState(false);
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [rememberPaid, setRememberPaid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = confirmed && buildConfirmed && secretsComplete(needs.needsSecrets, secrets);

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
          confirmNoPreview: needs.skipsPreview !== null || allowNoPreview,
          ...(needs.build === null ? {} : { buildConfirmed: true }),
          ...(needs.cronTriggers === null
            ? {}
            : {
                paidConfirmed,
                ...(paidConfirmed && rememberPaid ? { rememberPaidPlan: true } : {}),
              }),
        },
      });
      if ("jobId" in result) {
        await router.navigate({ to: "/jobs/$jobId", params: { jobId: result.jobId } });
        return;
      }
      setError("The catalog changed while this form was open. Close it and try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the update.");
    }
    setPending(false);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()} disablePointerDismissal>
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              Update {install.instanceName} to {needs.version}
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              {needs.selfDeploying === true
                ? "The app's own installer deploys the new version over the installed one. There is no snapshot and no rollback."
                : "Appflare takes a snapshot of the current version and of each D1 database first."}
            </Dialog.Description>
          </div>
          <Dialog.Close
            aria-label="Close"
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                shape="square"
                icon={<XIcon />}
                aria-label="Close"
              />
            )}
          />
        </div>
        <form className="grid gap-5" onSubmit={onSubmit}>
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
          {needs.build !== null && needs.skipsPreview === null && needs.selfDeploying !== true && (
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
                  This version needs secrets the app does not have yet. They are stored as encrypted
                  secrets on the app's Worker; Appflare keeps only their names.
                </Text>
              </div>
              <SecretFields
                secrets={needs.needsSecrets}
                values={secrets}
                onChange={(name, value) => setSecrets((s) => ({ ...s, [name]: value }))}
                after="the update"
              />
            </div>
          )}
          {error !== null && (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
            <Button
              type="submit"
              variant="primary"
              icon={<ArrowCircleUpIcon />}
              loading={pending}
              disabled={!ready}
            >
              Update
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
