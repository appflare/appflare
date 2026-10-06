import { Banner, Button, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import type { InstallDetail } from "../installs/installs.functions";
import { startEmailAgain } from "../installs/reconfigure.functions";
import type { EmailAgainParts } from "../jobs/reconfigure/email-again";
import { ConfirmDialog } from "./confirm-dialog";
import { useJobStarted } from "./job-started";
import { BANNER_ICON } from "./message-text";

/** "a, b and c". */
function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One sentence on what an update or a rollback left out of the app's email. */
export function emailLeftOutSummary(parts: EmailAgainParts): string {
  const missing: string[] = [];
  if (parts.addresses.length > 0) {
    missing.push(`mail to ${inWords(parts.addresses)} is not routed to the app`);
  }
  if (parts.catchAll) missing.push(`the catch-all of ${parts.zoneName} does not send mail to it`);
  const extra = parts.remove.map((r) =>
    r.kind === "rule" ? `the routing rule for ${r.name}` : `the catch-all of ${parts.zoneName}`,
  );
  if (extra.length > 0) {
    missing.push(
      `routes Appflare set up that the installed version no longer asks for are still there (${inWords(extra)})`,
    );
  }
  const sentence = missing.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * In the "Email" group of the app's settings: what an update or a rollback
 * left out of the installed version's email (something Appflare did not set
 * up was in the way, or Cloudflare refused a call), with "Set up email
 * again" for admins while no job of the app runs. Its confirmation names
 * each route it sets up or removes; confirming starts the settings change
 * job, whose log the page then opens. Members see what is left out.
 */
export function EmailAgainBanner({
  install,
  parts,
  canStart,
  disabled,
}: {
  install: InstallDetail;
  parts: EmailAgainParts;
  /** An admin, with no job of the app running. */
  canStart: boolean;
  /** Other changes in the settings form wait to be saved first. */
  disabled: boolean;
}) {
  const jobStarted = useJobStarted();
  const worker = `"${install.workerName}"`;
  const rules = parts.remove.filter((r) => r.kind === "rule");
  const resetsCatchAll = parts.remove.some((r) => r.kind === "catch_all");
  return (
    <Banner
      variant="alert"
      icon={BANNER_ICON.alert}
      title="Part of the app's email is not set up"
      description={`${emailLeftOutSummary(parts)} An update or a rollback left this out because something Appflare did not set up was in the way, or Cloudflare refused a call. Setting the email up again checks ${parts.zoneName} first and changes nothing Appflare did not set up; the Worker is not deployed again.`}
      action={
        canStart ? (
          <ConfirmDialog
            trigger={(p) => (
              <Button {...p} variant="secondary" icon={<ArrowsClockwiseIcon />} disabled={disabled}>
                Set up email again
              </Button>
            )}
            size="lg"
            title={`Set up the email of ${install.label} again`}
            description={`Appflare checks ${parts.zoneName} first. If a routing rule or a catch-all it did not set up is in the way, it stops without changing anything and says what to delete or change in the Cloudflare dashboard.`}
            actionLabel="Set up email again"
            destructive={false}
            onConfirm={async () => {
              const { jobId } = await startEmailAgain({ data: { installId: install.id, parts } });
              await jobStarted(jobId, "Setting up email again");
            }}
          >
            <ul className="grid list-disc gap-2 pl-5" data-email-again-parts>
              {parts.addresses.map((address) => (
                <li key={`rule:${address}`}>
                  <Text>
                    Route {address} to the Worker {worker}.
                  </Text>
                </li>
              ))}
              {parts.catchAll && (
                <li>
                  <Text>
                    Send mail to every other address at {parts.zoneName} to the Worker {worker}.
                  </Text>
                </li>
              )}
              {rules.map((r) => (
                <li key={`remove:${r.name}`}>
                  <Text>
                    Delete the routing rule for {r.name}, which Appflare set up and the installed
                    version no longer asks for, if it still sends mail to the Worker {worker}.
                  </Text>
                </li>
              ))}
              {resetsCatchAll && (
                <li>
                  <Text>
                    Put the catch-all of {parts.zoneName} back as it was before Appflare pointed it
                    at the Worker, since the installed version no longer asks for it.
                  </Text>
                </li>
              )}
            </ul>
          </ConfirmDialog>
        ) : undefined
      }
    />
  );
}
