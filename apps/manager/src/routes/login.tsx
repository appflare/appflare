import { Banner, Button, Input } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import { AuthLayout } from "../components/auth-layout";
import { getSetupStatus } from "../server/setup.functions";

/** `/login`: Better Auth email + password. */
export const Route = createFileRoute("/login")({
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
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (signInError) {
      setError(signInError.message ?? "Sign-in failed.");
      setPending(false);
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
        <Button type="submit" variant="primary" loading={pending}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
