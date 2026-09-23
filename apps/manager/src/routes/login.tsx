import { Banner, Button, Input, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, FingerprintIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeySignInErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { AuthLayout } from "../components/auth-layout";
import { getSetupStatus } from "../server/setup.functions";

/** `/login`: Better Auth email + password, or a passkey the user added in Settings. */
export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  validateSearch: z.object({ created: z.boolean().optional() }),
  beforeLoad: async () => {
    // Until the first admin exists, everything leads to /setup.
    const { needsSetup } = await getSetupStatus();
    if (needsSetup) throw redirect({ to: "/setup" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { created } = Route.useSearch();
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
      setError(signInError.message ?? "Sign-in failed.");
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

  return (
    <AuthLayout title="Sign in" description="Use your Appflare account.">
      <form className="grid gap-4" onSubmit={onSubmit}>
        {created === true && error === null && (
          <Banner
            icon={<CheckCircleIcon weight="fill" />}
            title="Admin account created"
            description="Sign in with the email and password you just chose."
          />
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <Input label="Email" name="email" type="email" autoComplete="username" required />
        <Input
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button
          type="submit"
          variant="primary"
          loading={pending === "password"}
          disabled={pending === "passkey"}
        >
          Sign in
        </Button>
      </form>
      <div className="flex items-center gap-3" aria-hidden="true">
        <div className="h-px flex-1 bg-kumo-hairline" />
        <Text variant="secondary" size="sm">
          or
        </Text>
        <div className="h-px flex-1 bg-kumo-hairline" />
      </div>
      <Button
        variant="secondary"
        icon={<FingerprintIcon />}
        loading={pending === "passkey"}
        disabled={pending === "password"}
        onClick={onPasskey}
      >
        Sign in with a passkey
      </Button>
    </AuthLayout>
  );
}
