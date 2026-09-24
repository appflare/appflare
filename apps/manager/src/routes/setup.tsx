import { Banner, Button, Input, Loader, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, InfoIcon, SignOutIcon, WarningIcon } from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import { serverErrorMessage } from "../auth/sign-in-errors";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION } from "../components/auth-layout";
import { CloudflareTokenForm, type SavedToken } from "../components/cloudflare-token-form";
import { PasswordInput } from "../components/password-input";
import { UsageDataNotice } from "../components/usage-data-notice";
import { getChecklistData } from "../onboarding/checklist.functions";
import type { ChecklistData } from "../onboarding/checklist.server";
import { SetupChecklist } from "../onboarding/onboarding-checklist";
import { enterSetup } from "../server/gate.functions";
import { MIN_PASSWORD_LENGTH } from "../server/schemas";
import { createOwner } from "../server/setup.functions";
import { getTokenStatus } from "../server/token.functions";
import { loadAppflareVersion } from "../server/version.functions";
import type { TelemetryStatus } from "../telemetry/telemetry";
import { getTelemetryStatus } from "../telemetry/telemetry.functions";

/**
 * `/setup`, the first-run wizard. Step 1 (anyone, before any user exists):
 * paste a Cloudflare API token for the account this Appflare runs in; the
 * token is the proof of control, and saving it gives this browser the right
 * to finish setup. Step 2 (only that browser): create the owner, who is
 * signed in at once. Step 3: the onboarding checklist and the usage-data
 * notice, then Finish goes home. Once the owner exists, everyone else is sent
 * to sign in.
 *
 * `?token=` from older installers is accepted and ignored; it is removed from
 * the address bar. `?checklist=true` asks for step 3 once signed in.
 */
export const Route = createFileRoute("/setup")({
  staticData: { title: "Set up" },
  validateSearch: z.object({
    token: z.string().optional(),
    checklist: z.boolean().optional(),
  }),
  loaderDeps: ({ search }) => ({ checklist: search.checklist === true }),
  loader: async ({ deps }) => {
    stripTokenFromAddressBar();
    // Redirects to /login (users exist, no session) or / (setup complete).
    const [gate, version] = await Promise.all([
      enterSetup({ data: { checklist: deps.checklist } }),
      loadAppflareVersion(),
    ]);
    if (gate.step === "checklist") {
      const [checklist, telemetry] = await Promise.all([getChecklistData(), getTelemetryStatus()]);
      return { step: gate.step, version, checklist, telemetry };
    }
    return { step: gate.step, version, checklist: null, telemetry: null };
  },
  component: SetupPage,
});

/**
 * Removes a `?token=` (the retired setup link) from the address bar, so it
 * is kept in neither history nor the `Referer` of later requests.
 */
function stripTokenFromAddressBar() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

function SetupPage() {
  const { step, version, checklist, telemetry } = Route.useLoaderData();
  switch (step) {
    case "connect":
      return <ConnectStep version={version} />;
    case "redeploying":
      return <RedeployingStep version={version} />;
    case "create-owner":
      return <CreateOwnerStep version={version} />;
    case "checklist":
      return checklist === null ? null : (
        <ChecklistStep data={checklist} telemetry={telemetry} version={version} />
      );
    case "cloudflare-token":
      return <CloudflareTokenStep version={version} />;
    case "wait-for-admin":
      return <WaitForAdminStep version={version} />;
  }
}

/** Step 1: the API token, before any user exists. */
function ConnectStep({ version }: { version: string | null }) {
  const router = useRouter();
  return (
    <AuthLayout
      width="wide"
      step={1}
      title="Connect Cloudflare"
      description="Paste an API token for the Cloudflare account this Appflare runs in. Only someone who controls the account can create one, so it is all Appflare needs to let you finish setup."
      version={version}
    >
      <CloudflareTokenForm mode="first-run" onSaved={() => void router.invalidate()} />
    </AuthLayout>
  );
}

/** How often the redeploy wait asks `/api/health` whether the new version serves. */
const REDEPLOY_POLL_MS = 2000;

/**
 * A manager deployed without secrets got its auth secret with the token; the
 * owner can be created once a version that has it serves. Polls the cheap,
 * unauthenticated health endpoint and reloads the step once it reports
 * `authReady`.
 */
function RedeployingStep({ version }: { version: string | null }) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { authReady?: unknown };
        // The reload may still reach the old version; this step then stays
        // mounted and keeps polling until the next one moves on.
        if (!cancelled && body.authReady === true) await router.invalidate();
      } catch {
        // The new version is rolling out; keep polling.
      }
    }, REDEPLOY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [router]);
  return (
    <AuthLayout
      step={2}
      title="Cloudflare connected"
      description="Appflare is redeploying itself with its new secrets. This takes a few seconds."
      version={version}
    >
      <div className="flex items-center gap-2">
        <Loader size="sm" />
        <Text>Waiting for the new version to answer…</Text>
      </div>
    </AuthLayout>
  );
}

/** Step 2: the owner account, only in the browser that connected Cloudflare. */
function CreateOwnerStep({ version }: { version: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      await createOwner({ data: { email, name: String(form.get("name") ?? ""), password } });
    } catch (err) {
      setError(serverErrorMessage(err, "Could not create the owner account. Try again."));
      setPending(false);
      // The claim expired or someone else finished: the page shows what is next.
      await router.invalidate();
      return;
    }
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      await router.navigate({ to: "/login" });
      return;
    }
    await router.navigate({ to: "/setup", search: { checklist: true } });
  }

  return (
    <AuthLayout
      step={2}
      title="Create the owner account"
      description="The owner installs apps, manages users, and is the only one who can hand ownership over."
      version={version}
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
          Create owner account
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Step 3: what the account has that apps rely on, then Finish. */
function ChecklistStep({
  data,
  telemetry,
  version,
}: {
  data: ChecklistData;
  telemetry: TelemetryStatus | null;
  version: string | null;
}) {
  const router = useRouter();
  return (
    <AuthLayout
      width="wide"
      step={3}
      title="Check your account"
      description="Appflare read what this Cloudflare account can do. Fix what needs you now or later; this list stays in Settings › Account and capabilities."
      version={version}
    >
      <div className="grid gap-4">
        <SetupChecklist data={data} />
        {telemetry !== null && <UsageDataNotice status={telemetry} />}
      </div>
      <Button
        variant="primary"
        className={FULL_WIDTH_ACTION}
        onClick={() => void router.navigate({ to: "/" })}
      >
        Finish
      </Button>
    </AuthLayout>
  );
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

/**
 * An admin whose manager has users but no token yet (its first admin was
 * created before setup asked for the token first).
 */
function CloudflareTokenStep({ version }: { version: string | null }) {
  const [saved, setSaved] = useState<SavedToken | null>(null);
  if (saved !== null) return <TokenSavedCard saved={saved} version={version} />;
  return (
    <AuthLayout
      width="wide"
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
 * request lands on a version that has the binding, then continue to the
 * checklist.
 */
function TokenSavedCard({ saved, version }: { saved: SavedToken; version: string | null }) {
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
            title="The old setup secret could not be removed"
            description={
              <>
                Appflare could not delete the{" "}
                <code className="font-mono text-[0.9em]">SETUP_TOKEN</code> secret from its Worker.
                It guards nothing any more, but you can remove it with{" "}
                <code className="font-mono text-[0.9em]">
                  wrangler secret delete SETUP_TOKEN --name {saved.workerName}
                </code>
                .
              </>
            }
          />
        )}
      </div>
      <Button
        variant="primary"
        className={FULL_WIDTH_ACTION}
        onClick={() => void router.navigate({ to: "/setup", search: { checklist: true } })}
      >
        Continue
      </Button>
    </AuthLayout>
  );
}
