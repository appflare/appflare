import { Button, Input } from "@cloudflare/kumo";
import { FingerprintIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeySignInErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { passwordSignInErrorMessage } from "../auth/sign-in-errors";
import {
  AuthError,
  AuthLayout,
  AuthSuccess,
  FULL_WIDTH_ACTION,
  OrDivider,
} from "../components/auth-layout";
import { PasswordInput } from "../components/password-input";
import { getSetupStatus } from "../server/setup.functions";
import { loadAppflareVersion } from "../server/version.functions";

/** `/login`: Better Auth email + password, or a passkey the user added in Settings. */
export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  validateSearch: z.object({ created: z.boolean().optional() }),
  beforeLoad: async () => {
    const [{ needsSetup }, version] = await Promise.all([getSetupStatus(), loadAppflareVersion()]);
    // Until the first admin exists, everything leads to /setup.
    if (needsSetup) throw redirect({ to: "/setup" });
    return { version };
  },
  component: LoginPage,
});

function LoginPage() {
  const { created } = Route.useSearch();
  const { version } = Route.useRouteContext();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending("password");
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (signInError) {
      setError(passwordSignInErrorMessage(signInError));
      setPending(null);
      return;
    }
    await router.navigate({ to: "/" });
  }

  async function onPasskey() {
    setError(null);
    if (!passkeysSupported()) {
      setError(PASSKEY_MESSAGES.unsupported);
      return;
    }
    setPending("passkey");
    const { error: signInError } = await authClient.signIn.passkey();
    if (signInError) {
      setError(passkeySignInErrorMessage(signInError));
      setPending(null);
      return;
    }
    await router.navigate({ to: "/" });
  }

  const justCreated = created === true;
  return (
    <AuthLayout
      title="Sign in to Appflare"
      description="Use your email and password, or a passkey."
      version={version}
      {...(justCreated ? { step: 2 as const } : {})}
    >
      <div className="grid gap-5">
        {error !== null ? (
          <AuthError message={error} />
        ) : (
          justCreated && (
            <AuthSuccess title="Admin account created" description="Sign in with it to continue." />
          )
        )}
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Input label="Email" name="email" type="email" autoComplete="username" required />
          <PasswordInput label="Password" name="password" autoComplete="current-password" />
          <Button
            type="submit"
            variant="primary"
            className={FULL_WIDTH_ACTION}
            loading={pending === "password"}
            disabled={pending === "passkey"}
          >
            Sign in
          </Button>
        </form>
        <OrDivider />
        <Button
          variant="secondary"
          icon={<FingerprintIcon />}
          className={FULL_WIDTH_ACTION}
          loading={pending === "passkey"}
          disabled={pending === "password"}
          onClick={onPasskey}
        >
          Sign in with a passkey
        </Button>
      </div>
    </AuthLayout>
  );
}
