import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Input,
  LayerCard,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { EnvelopeSimpleIcon, InfoIcon, WarningCircleIcon } from "@phosphor-icons/react";
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
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { Timestamp } from "./timestamp";

const METHOD_LABELS: Record<RecoveryMethod, string> = {
  account_code: "a recovery code from the Cloudflare account",
  issued_code: "a recovery code from an admin",
  email_link: "an emailed link",
};

/**
 * Settings > Users, "Forgotten passwords": how someone who forgot their
 * password gets back in, the last time that happened, and (owner only)
 * turning password reset emails on or off.
 */
export function PasswordRecoveryCard({ settings }: { settings: PasswordRecoverySettings }) {
  const { email, viewerIsOwner, lastRecovery } = settings;
  return (
    <div className="grid gap-3">
      <LayerCard className="grid gap-3 p-4">
        <Text>
          On the sign-in page, choose "Forgot your password?".{" "}
          {email.enabled
            ? "Appflare emails a link to choose a new one. "
            : "With password reset emails on, Appflare emails a link to choose a new one. "}
          Without email, the owner resets anyone's from the user's menu above, and admins a
          member's. Whoever manages this Cloudflare account can get a one-time recovery code for any
          admin, the owner included, by running this on their computer:{" "}
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
      </LayerCard>
      <PasswordEmailCard status={email} viewerIsOwner={viewerIsOwner} />
    </div>
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
    <LayerCard className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <EnvelopeSimpleIcon size={18} />
          <Text variant="heading" as="h3">
            Password reset emails
          </Text>
          <DocsLink topic="passwordResetEmails" />
        </div>
        <Badge variant={status.enabled ? "primary" : "neutral"}>
          {status.enabled ? "On" : "Off"}
        </Badge>
      </div>
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
      {restarting && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
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
              <Button variant="secondary" loading={pending === "test"} onClick={test}>
                Send me a test email
              </Button>
              <ConfirmDialog
                trigger={(p) => (
                  <Button {...p} variant="secondary" disabled={pending !== null}>
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
          <div>
            <Button type="submit" variant="primary" loading={pending === "on"}>
              Turn on
            </Button>
          </div>
        </form>
      ) : (
        !restarting && (
          <Text variant="secondary">Off. Only the owner can turn on reset emails.</Text>
        )
      )}
    </LayerCard>
  );
}
