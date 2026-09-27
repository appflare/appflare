import { Banner, ClipboardText, LayerDialog, Radio, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { serverErrorMessage } from "../auth/sign-in-errors";
import { issuePasswordRecoveryCode, sendPasswordResetLink } from "../server/recovery.functions";

type Way = "link" | "code";

type Outcome = { kind: "link"; email: string } | { kind: "code"; email: string; code: string };

/**
 * An admin resets another user's password: emails them a reset link (when
 * reset emails are on) or shows a one-time recovery code to pass on. Either
 * way they choose the new password themselves; their current one keeps
 * working until then. Closing the dialog discards the code.
 */
export function ResetPasswordDialog({
  user,
  emailReset,
  open,
  onOpenChange,
}: {
  user: { id: string; name: string; email: string };
  /** Password reset emails are on. */
  emailReset: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [way, setWay] = useState<Way>(emailReset ? "link" : "code");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function change(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setOutcome(null);
      setError(null);
      setWay(emailReset ? "link" : "code");
    }
  }

  async function run() {
    setPending(true);
    setError(null);
    try {
      if (way === "link") {
        const { email } = await sendPasswordResetLink({ data: { userId: user.id } });
        setOutcome({ kind: "link", email });
      } else {
        const { email, code } = await issuePasswordRecoveryCode({ data: { userId: user.id } });
        setOutcome({ kind: "code", email, code });
      }
    } catch (err) {
      setError(serverErrorMessage(err, "Could not reset the password. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={change} dismissDisabled={pending}>
      <LayerDialog.Content>
        <LayerDialog.Title>{`Reset ${user.name}'s password`}</LayerDialog.Title>
        <LayerDialog.Description>
          {outcome === null
            ? `${user.email} chooses a new password themselves. Their current password works until they do; then they are signed out everywhere.`
            : outcome.kind === "code"
              ? `Give ${outcome.email} this recovery code. It is shown only once.`
              : `A reset link is on its way to ${outcome.email}.`}
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            {outcome === null && emailReset && (
              <Radio.Group
                legend="How"
                value={way}
                onValueChange={(v: string) => setWay(v === "code" ? "code" : "link")}
                appearance="card"
              >
                <Radio.Item
                  value="link"
                  label="Email a reset link"
                  description={`Sent to ${user.email}. It works for 30 minutes.`}
                />
                <Radio.Item
                  value="code"
                  label="Show a recovery code"
                  description="You pass it on yourself. It works once, for 30 minutes."
                />
              </Radio.Group>
            )}
            {outcome === null && !emailReset && (
              <Text variant="secondary">
                Appflare shows a one-time recovery code for you to pass on. It works once, for 30
                minutes. Turn on password reset emails below to send a link instead.
              </Text>
            )}
            {outcome?.kind === "code" && (
              <>
                <ClipboardText text={outcome.code} />
                <Banner
                  variant="alert"
                  icon={<WarningCircleIcon weight="fill" />}
                  title="Copy it now"
                  description='On the sign-in page they choose "Forgot your password?", then "I have a recovery code", and enter their email, this code and a new password. It works once, for 30 minutes.'
                />
              </>
            )}
            {outcome?.kind === "link" && (
              <Banner
                variant="secondary"
                icon={<CheckCircleIcon weight="fill" />}
                title="Reset link sent"
                description="It works for 30 minutes. If it does not arrive, show a recovery code instead."
              />
            )}
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel={outcome === null ? "Cancel" : "Close"}>
          {outcome === null ? (
            <LayerDialog.Actions.Primary loading={pending} onClick={run}>
              {way === "link" ? "Send reset link" : "Show recovery code"}
            </LayerDialog.Actions.Primary>
          ) : (
            <LayerDialog.Actions.Primary onClick={() => change(false)}>
              Done
            </LayerDialog.Actions.Primary>
          )}
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
