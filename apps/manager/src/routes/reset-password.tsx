import { Banner, Button, Link, Text } from "@cloudflare/kumo";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import {
  PASSWORD_LIMITS,
  RECOVERY_MESSAGES,
  recoveryErrorMessage,
} from "../auth/recovery-messages";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION } from "../components/auth-layout";
import { PasswordInput } from "../components/password-input";
import { getSetupStatus } from "../server/setup.functions";
import { loadAppflareVersion } from "../server/version.functions";

/** `/reset-password?token=…`: where an emailed reset link leads. */
export const Route = createFileRoute("/reset-password")({
  staticData: { title: "Choose a new password" },
  validateSearch: z.object({
    token: z.string().max(256).optional(),
    error: z.string().max(64).optional(),
  }),
  beforeLoad: async () => {
    const [{ needsSetup }, version] = await Promise.all([getSetupStatus(), loadAppflareVersion()]);
    if (needsSetup) throw redirect({ to: "/setup" });
    return { version };
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { version } = Route.useRouteContext();
  const { token, error: linkError } = Route.useSearch();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const usable = token !== undefined && token.length > 0 && linkError === undefined;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === undefined) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.resetPassword({
      token,
      newPassword: String(form.get("newPassword") ?? ""),
    });
    setPending(false);
    if (failed) {
      setError(recoveryErrorMessage(failed));
      return;
    }
    setDone(true);
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description="You are signed out everywhere once it is set."
      version={version}
    >
      <div className="grid gap-5">
        {!usable ? (
          <>
            <AuthError message={RECOVERY_MESSAGES.linkInvalid} />
            <Link href="/forgot-password">Ask for a new link</Link>
          </>
        ) : done ? (
          <>
            <Banner
              variant="secondary"
              icon={<CheckCircleIcon weight="fill" />}
              title="Password changed"
              description="Sign in with your new password."
            />
            <Link href="/login">Sign in</Link>
          </>
        ) : (
          <>
            {error !== null && <AuthError message={error} />}
            <form className="grid gap-4" onSubmit={onSubmit}>
              <PasswordInput
                label="New password"
                name="newPassword"
                autoComplete="new-password"
                minLength={PASSWORD_LIMITS.min}
                maxLength={PASSWORD_LIMITS.max}
                description={`At least ${PASSWORD_LIMITS.min} characters.`}
              />
              <Button
                type="submit"
                variant="primary"
                className={FULL_WIDTH_ACTION}
                loading={pending}
              >
                Set new password
              </Button>
            </form>
            <Text variant="secondary" size="sm" as="p">
              <Link href="/login">Back to sign in</Link>
            </Text>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
