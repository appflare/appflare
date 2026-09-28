import { Button, Input, Link, Text } from "@cloudflare/kumo";
import { FingerprintIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeySignInErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { passwordSignInErrorMessage } from "../auth/sign-in-errors";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION, OrDivider } from "../components/auth-layout";
import { PasswordInput } from "../components/password-input";
import { afterSignIn, returnToSearchSchema, withReturnTo } from "../components/return-to";
import { getSetupStatus } from "../server/setup.functions";
import { loadAppflareVersion } from "../server/version.functions";

/**
 * `/login`: Better Auth email + password, or a passkey the user added in
 * Settings. `?returnTo=` is the page the visitor was sent here from; signing
 * in either way opens it (home when it is missing or not one of this
 * manager's pages), and "Forgot your password?" carries it along.
 */
export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  validateSearch: returnToSearchSchema,
  beforeLoad: async ({ search }) => {
    const [{ needsSetup }, version] = await Promise.all([getSetupStatus(), loadAppflareVersion()]);
    // Until the owner exists, everything leads to /setup.
    if (needsSetup) throw redirect({ href: withReturnTo("/setup", search.returnTo) });
    return { version };
  },
  component: LoginPage,
});

function LoginPage() {
  const { version } = Route.useRouteContext();
  const { returnTo } = Route.useSearch();
  const router = useRouter();
  const signedIn = () => router.navigate({ href: afterSignIn(returnTo), replace: true });
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
    await signedIn();
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
    await signedIn();
  }

  return (
    <AuthLayout
      title="Sign in to Appflare"
      description="Use your email and password, or a passkey."
      version={version}
    >
      <div className="grid gap-5">
        {error !== null && <AuthError message={error} />}
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Input label="Email" name="email" type="email" autoComplete="username" required />
          <PasswordInput label="Password" name="password" autoComplete="current-password" />
          <Text variant="secondary" size="sm" as="p">
            <Link href={withReturnTo("/forgot-password", returnTo)}>Forgot your password?</Link>
          </Text>
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
