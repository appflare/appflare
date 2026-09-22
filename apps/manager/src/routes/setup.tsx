import { Banner, Button, Input, LinkButton, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AuthLayout } from "../components/auth-layout";
import { PlaceholderCard } from "../components/placeholder-card";
import { MIN_PASSWORD_LENGTH } from "../server/schemas";
import {
  checkSetupToken,
  createFirstAdmin,
  getSetupStatus,
  INVALID_SETUP_LINK,
} from "../server/setup.functions";

/**
 * `/setup?token=…`. Before any user exists: validate the
 * setup token, then create the first admin. After that: the Cloudflare token step.
 */
export const Route = createFileRoute("/setup")({
  validateSearch: z.object({ token: z.string().optional() }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    if (deps.token !== undefined && deps.token.length > 0) {
      heldToken = deps.token;
      // Before any server-function call, so the token is not in their Referer.
      // TanStack's history sees this replace and re-runs the loader without
      // `?token=`, which is why the token is held in memory first.
      stripTokenFromAddressBar();
    }
    const { needsSetup } = await getSetupStatus();
    if (!needsSetup) return { step: "cloudflare-token" as const, token: null };
    const token = heldToken;
    if (token === null) return { step: "invalid" as const, token: null };
    const { valid } = await checkSetupToken({ data: { token } });
    return valid
      ? { step: "create-admin" as const, token }
      : { step: "invalid" as const, token: null };
  },
  component: SetupPage,
});

/**
 * The setup token, taken from `?token=` and kept only in this tab's memory (never
 * in the URL, history, or storage) until the first admin exists.
 */
let heldToken: string | null = null;

/**
 * Removes `?token=` from the address bar (and so from history and from the
 * `Referer` of later requests).
 */
function stripTokenFromAddressBar() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

function SetupPage() {
  const { step, token } = Route.useLoaderData();
  switch (step) {
    case "create-admin":
      return <CreateAdminStep token={token ?? ""} />;
    case "invalid":
      return (
        <AuthLayout title="Set up Appflare">
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title={INVALID_SETUP_LINK}
            description="Open the setup link printed by create-appflare when it installed this manager."
          />
        </AuthLayout>
      );
    case "cloudflare-token":
      return (
        <AuthLayout
          title="Set up Appflare"
          description="The admin account exists. Next, connect a Cloudflare API token."
        >
          {/* TODO: the Cloudflare API token step (verify, store as CF_API_TOKEN, delete SETUP_TOKEN). */}
          <PlaceholderCard
            title="Cloudflare token step"
            description="Paste an account API token so Appflare can install apps in this account."
          />
          <LinkButton href="/login" variant="secondary">
            Go to sign in
          </LinkButton>
        </AuthLayout>
      );
  }
}

function CreateAdminStep(props: { token: string }) {
  const [token] = useState(props.token);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await createFirstAdmin({
        data: {
          token,
          email: String(form.get("email") ?? ""),
          name: String(form.get("name") ?? ""),
          password: String(form.get("password") ?? ""),
        },
      });
      heldToken = null;
      await router.navigate({ to: "/login", search: { created: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the admin account.");
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Create the admin account"
      description="This is the first user. Admins install apps and manage other users."
    >
      <form className="grid gap-4" onSubmit={onSubmit}>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <Input label="Name" name="name" autoComplete="name" required maxLength={100} />
        <Input label="Email" name="email" type="email" autoComplete="email" required />
        <Input
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Button type="submit" variant="primary" loading={pending}>
          Create admin account
        </Button>
        <Text variant="secondary" size="sm">
          You will sign in with this account next.
        </Text>
      </form>
    </AuthLayout>
  );
}
