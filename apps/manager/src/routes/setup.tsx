import { Banner, Button, Input, Loader, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  InfoIcon,
  SignOutIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import { serverErrorMessage } from "../auth/sign-in-errors";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION } from "../components/auth-layout";
import { CloudflareTokenForm, type SavedToken } from "../components/cloudflare-token-form";
import { PasswordInput } from "../components/password-input";
import { UsageDataNotice } from "../components/usage-data-notice";
import { enterSetup } from "../server/gate.functions";
import { MIN_PASSWORD_LENGTH } from "../server/schemas";
import { checkSetupToken, createFirstAdmin, INVALID_SETUP_LINK } from "../server/setup.functions";
import { getTokenStatus } from "../server/token.functions";
import { loadAppflareVersion } from "../server/version.functions";
import type { TelemetryStatus } from "../telemetry/telemetry";
import { getTelemetryStatus } from "../telemetry/telemetry.functions";

/**
 * `/setup?token=…`. Before any user exists: validate the
 * setup token, then create the first admin. After that, signed in as an admin:
 * the Cloudflare token step, whose last screen says that anonymous usage data
 * is on and how to turn it off (saving the token records that the notice was
 * shown, so the home page does not repeat it). Once the token is configured
 * `/setup` redirects to `/`; until then every signed-in page redirects here
 * (`_app.tsx`).
 */
export const Route = createFileRoute("/setup")({
  staticData: { title: "Set up" },
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
    // Redirects to /login (users exist, no session) or / (setup complete).
    const [gate, version] = await Promise.all([enterSetup(), loadAppflareVersion()]);
    if (gate.step === "cloudflare-token") {
      return { step: gate.step, token: null, telemetry: await getTelemetryStatus(), version };
    }
    if (gate.step !== "create-admin") {
      return { step: gate.step, token: null, telemetry: null, version };
    }
    const token = heldToken;
    if (token === null) return { step: "invalid" as const, token: null, telemetry: null, version };
    const { valid } = await checkSetupToken({ data: { token } });
    return valid
      ? { step: "create-admin" as const, token, telemetry: null, version }
      : { step: "invalid" as const, token: null, telemetry: null, version };
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
  const { step, token, telemetry, version } = Route.useLoaderData();
  switch (step) {
    case "create-admin":
      return <CreateAdminStep token={token ?? ""} version={version} />;
    case "invalid":
      return (
        <AuthLayout
          title="Set up Appflare"
          description="Setup creates the first admin account."
          version={version}
        >
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title={INVALID_SETUP_LINK}
            description="Open the setup link printed by create-appflare when it installed this manager."
          />
        </AuthLayout>
      );
    case "cloudflare-token":
      return <CloudflareTokenStep telemetry={telemetry} version={version} />;
    case "wait-for-admin":
      return <WaitForAdminStep version={version} />;
  }
}

/** A member signed in before the token step: nothing to do here but sign out. */
function WaitForAdminStep({ version }: { version: string | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <AuthLayout title="Set up Appflare" description="Setup is not finished yet." version={version}>
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title="An admin needs to finish setup"
        description="Appflare needs a Cloudflare API token before anyone can use it. Ask an admin to sign in and add one."
      />
      <Button
        variant="secondary"
        icon={<SignOutIcon />}
        className={FULL_WIDTH_ACTION}
        loading={signingOut}
        onClick={signOut}
      >
        Sign out
      </Button>
    </AuthLayout>
  );
}

/** How often the success card checks whether the redeployed Worker has the token. */
const SECRET_POLL_MS = 3000;

function CloudflareTokenStep({
  telemetry,
  version,
}: {
  telemetry: TelemetryStatus | null;
  version: string | null;
}) {
  const [saved, setSaved] = useState<SavedToken | null>(null);
  if (saved !== null) {
    return <TokenSavedCard saved={saved} telemetry={telemetry} version={version} />;
  }
  return (
    <AuthLayout
      width="wide"
      step={3}
      title="Connect Cloudflare"
      description="Appflare installs and updates apps with an API token you create."
      version={version}
    >
      <CloudflareTokenForm mode="setup" onSaved={setSaved} />
    </AuthLayout>
  );
}

/**
 * Storing `CF_API_TOKEN` deploys a new version of this Worker. Poll until a
 * request lands on a version that has the binding.
 */
function TokenSavedCard({
  saved,
  telemetry,
  version,
}: {
  saved: SavedToken;
  telemetry: TelemetryStatus | null;
  version: string | null;
}) {
  const router = useRouter();
  const [hasSecret, setHasSecret] = useState(false);

  useEffect(() => {
    if (hasSecret) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const status = await getTokenStatus();
        if (!cancelled && status.hasSecret) setHasSecret(true);
      } catch {
        // Transient failures while the new version rolls out; keep polling.
      }
    }, SECRET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasSecret]);

  return (
    <AuthLayout
      width="wide"
      step={3}
      title="Cloudflare connected"
      description={`The token is saved on the Worker "${saved.workerName}" in account ${saved.accountId}.`}
      version={version}
    >
      <div className="grid gap-4">
        <div className="flex items-start gap-2">
          <span className="flex h-lh items-center">
            {hasSecret ? (
              <CheckCircleIcon weight="fill" className="text-kumo-success" />
            ) : (
              <Loader size="sm" />
            )}
          </span>
          <Text>
            {hasSecret
              ? "Appflare has redeployed itself with the token."
              : "Appflare is redeploying itself with the token. This takes a few seconds."}
          </Text>
        </div>
        {saved.setupTokenRemoved === false && (
          <Banner
            variant="alert"
            icon={<WarningIcon weight="fill" />}
            title="The setup token could not be removed"
            description={
              <>
                Appflare could not delete the{" "}
                <code className="font-mono text-[0.9em]">SETUP_TOKEN</code> secret from its Worker.
                It is inert now that an admin exists, but you can remove it with{" "}
                <code className="font-mono text-[0.9em]">
                  wrangler secret delete SETUP_TOKEN --name {saved.workerName}
                </code>
                .
              </>
            }
          />
        )}
        {telemetry !== null && <UsageDataNotice status={telemetry} />}
      </div>
      <Button
        variant="primary"
        className={FULL_WIDTH_ACTION}
        onClick={() => void router.navigate({ to: "/" })}
      >
        Go to Installed apps
      </Button>
    </AuthLayout>
  );
}

function CreateAdminStep(props: { token: string; version: string | null }) {
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
      setError(serverErrorMessage(err, "Could not create the admin account. Try again."));
      setPending(false);
    }
  }

  return (
    <AuthLayout
      step={1}
      title="Create the admin account"
      description="The owner installs apps and manages users."
      version={props.version}
    >
      <form className="grid gap-4" onSubmit={onSubmit}>
        {error !== null && <AuthError message={error} />}
        <Input label="Name" name="name" autoComplete="name" required maxLength={100} />
        <Input label="Email" name="email" type="email" autoComplete="email" required />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={128}
          description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Button type="submit" variant="primary" className={FULL_WIDTH_ACTION} loading={pending}>
          Create admin account
        </Button>
      </form>
    </AuthLayout>
  );
}
