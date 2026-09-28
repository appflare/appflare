import { Banner, Button, ClipboardText, Input, Link, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, EnvelopeSimpleIcon, KeyIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../auth/client";
import {
  PASSWORD_LIMITS,
  RECOVER_COMMAND,
  RECOVERY_CODE_PATH,
  RECOVERY_MESSAGES,
  recoveryErrorMessage,
} from "../auth/recovery-messages";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION, OrDivider } from "../components/auth-layout";
import { PasswordInput } from "../components/password-input";
import { returnToSearchSchema, withReturnTo } from "../components/return-to";
import { getPasswordRecoveryOptions } from "../server/recovery.functions";
import { getSetupStatus } from "../server/setup.functions";
import { loadAppflareVersion } from "../server/version.functions";

/**
 * `/forgot-password`: get back in without the old password. With reset
 * emails on, an emailed link (the answer is the same whether or not the
 * address belongs to anyone); always, a recovery code from an admin or from
 * whoever manages the Cloudflare account (`create-appflare recover`).
 * `?returnTo=` from the sign-in page travels on: into the emailed link, and
 * back to sign in once the new password is set.
 */
export const Route = createFileRoute("/forgot-password")({
  staticData: { title: "Forgot your password?" },
  validateSearch: returnToSearchSchema,
  beforeLoad: async ({ search }) => {
    const [{ needsSetup }, version, options] = await Promise.all([
      getSetupStatus(),
      loadAppflareVersion(),
      getPasswordRecoveryOptions(),
    ]);
    if (needsSetup) throw redirect({ href: withReturnTo("/setup", search.returnTo) });
    return { version, emailReset: options.emailReset };
  },
  component: ForgotPasswordPage,
});

type Mode = "email" | "code";

function ForgotPasswordPage() {
  const { version, emailReset } = Route.useRouteContext();
  const [mode, setMode] = useState<Mode>(emailReset ? "email" : "code");
  return (
    <AuthLayout
      title="Forgot your password?"
      description={
        mode === "email"
          ? "Appflare emails you a link to choose a new one."
          : "Choose a new password with a one-time recovery code."
      }
      version={version}
    >
      {mode === "email" ? (
        <EmailForm onUseCode={() => setMode("code")} />
      ) : (
        <CodeForm onUseEmail={emailReset ? () => setMode("email") : undefined} />
      )}
    </AuthLayout>
  );
}

/** `/login`, carrying the page to return to. */
function useSignInHref(): string {
  const { returnTo } = Route.useSearch();
  return withReturnTo("/login", returnTo);
}

function BackToSignIn() {
  return (
    <Text variant="secondary" size="sm" as="p">
      <Link href={useSignInHref()}>Back to sign in</Link>
    </Text>
  );
}

function EmailForm({ onUseCode }: { onUseCode: () => void }) {
  const { returnTo } = Route.useSearch();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.requestPasswordReset({
      email: String(form.get("email") ?? "").trim(),
      // The emailed link opens /reset-password, which carries it back to sign in.
      redirectTo: withReturnTo("/reset-password", returnTo),
    });
    setPending(false);
    if (failed) {
      setError(recoveryErrorMessage(failed));
      return;
    }
    setSent(true);
  }

  return (
    <div className="grid gap-5">
      {error !== null && <AuthError message={error} />}
      {sent ? (
        <Banner
          variant="secondary"
          icon={<CheckCircleIcon weight="fill" />}
          title="Check your email"
          description={RECOVERY_MESSAGES.emailSent}
        />
      ) : (
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Input label="Email" name="email" type="email" autoComplete="username" required />
          <Button
            type="submit"
            variant="primary"
            icon={<EnvelopeSimpleIcon />}
            className={FULL_WIDTH_ACTION}
            loading={pending}
          >
            Email me a reset link
          </Button>
        </form>
      )}
      <OrDivider />
      <Button
        variant="secondary"
        icon={<KeyIcon />}
        className={FULL_WIDTH_ACTION}
        onClick={onUseCode}
      >
        I have a recovery code
      </Button>
      <BackToSignIn />
    </div>
  );
}

function CodeForm({ onUseEmail }: { onUseEmail: (() => void) | undefined }) {
  const signInHref = useSignInHref();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.$fetch<{ status: boolean }>(RECOVERY_CODE_PATH, {
      method: "POST",
      body: {
        email: String(form.get("email") ?? "").trim(),
        code: String(form.get("code") ?? ""),
        newPassword: String(form.get("newPassword") ?? ""),
      },
    });
    setPending(false);
    if (failed) {
      setError(recoveryErrorMessage(failed));
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="grid gap-5">
        <Banner
          variant="secondary"
          icon={<CheckCircleIcon weight="fill" />}
          title="Password changed"
          description="Sign in with your new password. You were signed out everywhere else."
        />
        <Link href={signInHref}>Sign in</Link>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {error !== null && <AuthError message={error} />}
      <Text variant="secondary">
        An admin of this Appflare can give you a code. If you manage the Cloudflare account it runs
        in, get one yourself by running this on your computer:
      </Text>
      <ClipboardText text={RECOVER_COMMAND} />
      <form className="grid gap-4" onSubmit={onSubmit}>
        <Input label="Email" name="email" type="email" autoComplete="username" required />
        <Input
          label="Recovery code"
          name="code"
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          required
        />
        <PasswordInput
          label="New password"
          name="newPassword"
          autoComplete="new-password"
          minLength={PASSWORD_LIMITS.min}
          maxLength={PASSWORD_LIMITS.max}
          description={`At least ${PASSWORD_LIMITS.min} characters.`}
        />
        <Button type="submit" variant="primary" className={FULL_WIDTH_ACTION} loading={pending}>
          Set new password
        </Button>
      </form>
      {onUseEmail !== undefined && (
        <>
          <OrDivider />
          <Button
            variant="secondary"
            icon={<EnvelopeSimpleIcon />}
            className={FULL_WIDTH_ACTION}
            onClick={onUseEmail}
          >
            Email me a reset link instead
          </Button>
        </>
      )}
      <BackToSignIn />
    </div>
  );
}
