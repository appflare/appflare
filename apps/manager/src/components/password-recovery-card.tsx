import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Input,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { RecoveryMethod } from "../auth/recovery.server";
import { RECOVER_COMMAND } from "../auth/recovery-messages";
import { serverErrorMessage } from "../auth/sign-in-errors";
import {
  type PasswordRecoverySettings,
  sendTestPasswordEmail,
  setPasswordResetEmails,
} from "../server/recovery.functions";
import { AppflareLoader } from "./appflare-loader";
import { BusyButton } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { ErrorMessageBanner } from "./message-text";
import { Section, SectionBody, SectionFormActions, SectionRow, SectionRows } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

const METHOD_LABELS: Record<RecoveryMethod, string> = {
  account_code: "a recovery code from the Cloudflare account",
  issued_code: "a recovery code from an admin",
  email_link: "an emailed link",
};

/**
 * The users settings' "Forgotten passwords" section: how someone who forgot
 * their password gets back in, the last time that happened, and (owner only)
 * turning password reset emails on or off, as a row of its own.
 */
export function PasswordRecoveryCard({ settings }: { settings: PasswordRecoverySettings }) {
  const { email, viewerIsOwner, lastRecovery } = settings;
  return (
    <Section
      {...settingsSection("users", "forgotten-passwords")}
      description="How someone who forgot their password gets back in."
    >
      <SectionRows>
        <SectionBody className="gap-3">
          <Text>
            On the sign-in page, choose "Forgot your password?".{" "}
            {email.enabled
              ? "Appflare emails a link to choose a new one. "
              : "With password reset emails on, Appflare emails a link to choose a new one. "}
            Without email, the owner resets anyone's from the user's menu above, and admins a
            member's. Whoever manages this Cloudflare account can get a one-time recovery code for
            any admin, the owner included, by running this on their computer:{" "}
            <DocsLink topic="forgotPassword" variant="inline" />
          </Text>
          <ClipboardText text={RECOVER_COMMAND} />
          {lastRecovery !== null && (
            <Text variant="secondary" size="sm">
              Last reset without the old password: <Timestamp iso={lastRecovery.at} />,{" "}
              {lastRecovery.email ?? "a user who was deleted since"}, with{" "}
              {METHOD_LABELS[lastRecovery.method]}.
            </Text>
          )}
        </SectionBody>
        <PasswordEmailCard status={email} viewerIsOwner={viewerIsOwner} />
      </SectionRows>
    </Section>
  );
}

function PasswordEmailCard({
  status,
  viewerIsOwner,
}: {
  status: PasswordRecoverySettings["email"];
  viewerIsOwner: boolean;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [pending, setPending] = useState<"on" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Saved, but the version with the binding does not serve this page yet.
  const restarting = status.sender !== null && !status.bound;

  async function turnOn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending("on");
    setError(null);
    try {
      await setPasswordResetEmails({ data: { sender: String(form.get("sender") ?? "").trim() } });
      toasts.add({
        title: "Password reset emails turned on",
        description: "Appflare restarts with them in a few seconds. Then send yourself a test.",
        variant: "success",
      });
      await router.invalidate();
    } catch (err) {
      setError(serverErrorMessage(err, "Could not turn on reset emails. Try again."));
    } finally {
      setPending(null);
    }
  }

  async function test() {
    setPending("test");
    setError(null);
    try {
      const { to } = await sendTestPasswordEmail();
      toasts.add({ title: "Test email sent", description: `Check ${to}.`, variant: "success" });
    } catch (err) {
      setError(serverErrorMessage(err, "Could not send the test email. Try again."));
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionRow
      id="password-reset-emails"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <EnvelopeSimpleIcon size={18} />
          Password reset emails
          <DocsLink topic="passwordResetEmails" />
          <Badge variant={status.enabled ? "success" : "neutral"}>
            {status.enabled ? "On" : "Off"}
          </Badge>
        </span>
      }
    >
      {error !== null && <ErrorMessageBanner message={error} />}
      {restarting && (
        <Banner
          variant="secondary"
          // No live region: the toast for the change already says so.
          icon={<AppflareLoader size="sm" aria-hidden />}
          title="Appflare is restarting with reset emails turned on"
          description="Reload this page in a few seconds."
        />
      )}
      {status.enabled ? (
        <>
          <Text variant="secondary">
            Reset links come from {status.sender}. They work for 30 minutes.
          </Text>
          {viewerIsOwner && (
            <div className="flex flex-wrap gap-2">
              <BusyButton pending={pending === "test"} variant="secondary" onClick={test}>
                Send me a test email
              </BusyButton>
              <ConfirmDialog
                trigger={(p) => (
                  <Button {...p} variant="secondary-destructive" disabled={pending !== null}>
                    Turn off
                  </Button>
                )}
                title="Turn off password reset emails"
                description="People who forget their password then need a recovery code from an admin, or from whoever manages the Cloudflare account. Appflare restarts without email in a few seconds."
                actionLabel="Turn off"
                onConfirm={async () => {
                  await setPasswordResetEmails({ data: { sender: null } });
                  await router.invalidate();
                }}
              />
            </div>
          )}
        </>
      ) : viewerIsOwner && !restarting ? (
        <form className="grid gap-3" onSubmit={turnOn}>
          <Text variant="secondary">
            Appflare can email reset links through Cloudflare Email Sending. Enter an address on a
            domain set up for it in this account. Without Workers Paid, emails reach only addresses
            verified in Email Routing.
          </Text>
          <Input
            label="Send from"
            name="sender"
            type="email"
            placeholder="appflare@example.com"
            autoComplete="off"
            required
            defaultValue={status.sender ?? undefined}
          />
          <SectionFormActions>
            <BusyButton pending={pending === "on"} type="submit" variant="primary">
              Turn on
            </BusyButton>
          </SectionFormActions>
        </form>
      ) : (
        !restarting && (
          <Text variant="secondary">Off. Only the owner can turn on reset emails.</Text>
        )
      )}
    </SectionRow>
  );
}
