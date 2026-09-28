import { Banner, Button, ClipboardText, Collapsible, Input, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, InfoIcon, SignOutIcon, WarningIcon } from "@phosphor-icons/react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useReducer, useState } from "react";
import { z } from "zod";
import { authClient } from "../auth/client";
import { serverErrorMessage } from "../auth/sign-in-errors";
import { getCapabilityRowsData } from "../capabilities/capability-rows.functions";
import type { CapabilityRowsData } from "../capabilities/capability-rows.server";
import { SetupCapabilities } from "../capabilities/capability-section";
import { AppflareLoader } from "../components/appflare-loader";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION } from "../components/auth-layout";
import { BusyButton } from "../components/busy-button";
import { SetupTokenForm, type SetupTokenSaved } from "../components/cloudflare-token-form";
import { MessageText } from "../components/message-text";
import { PasswordInput } from "../components/password-input";
import { afterSignIn, returnToSearchSchema, withReturnTo } from "../components/return-to";
import {
  type AddressOptions,
  getManagerAddressOptions,
} from "../domains/manager-address.functions";
import { AddressSkippedNote, AddressStep } from "../onboarding/address-step";
import {
  initialWizardState,
  offersAddressStep,
  type SavedTokenSummary,
  setupResumePath,
  type WizardEvent,
  type WizardState,
  wizardCopy,
  wizardProgress,
  wizardReducer,
} from "../onboarding/wizard";
import { enterSetup } from "../server/gate.functions";
import { MIN_PASSWORD_LENGTH } from "../server/schemas";
import { createOwner } from "../server/setup.functions";
import { getTokenStatus } from "../server/token.functions";
import { loadAppflareVersion } from "../server/version.functions";

/**
 * `/setup`, the first-run wizard, as one page: one frame, one width and one
 * step indicator for every step, the step's content swapped in place. The
 * server decides where a visit starts (`enterSetup`); after that each step's
 * own call moves the wizard on without a navigation, so nothing remounts.
 *
 * Step 1 (anyone, before any user exists): paste a Cloudflare API token for
 * the account this Appflare runs in; one Continue verifies and saves it, and
 * saving gives this browser the right to finish setup. Step 2 (only that
 * browser): create the owner, who is signed in at once. Then, only when the
 * account has an active zone, where Appflare should live: its workers.dev
 * address or a domain of the account (moving there ends at the sign-in page
 * of the new address, which returns here). Last: what the account can run
 * (the same rows as on Your account), then Finish goes home. Once the owner
 * exists, everyone else is sent to sign in.
 *
 * `?checklist=true` marks the last step, so a reload stays there (a reload
 * on the address step goes on to it too); `?address=true` says the address
 * step was shown, so the step indicator keeps counting four steps. `?token=`
 * from older installers is accepted and ignored; it is removed from the address bar.
 * `?returnTo=` is the page a visitor was sent here from: Finish (or setup
 * being done already) opens it instead of home, and sign-in carries it on.
 */
export const Route = createFileRoute("/setup")({
  staticData: { title: "Set up" },
  validateSearch: returnToSearchSchema.extend({
    token: z.string().optional(),
    checklist: z.boolean().optional(),
    address: z.boolean().optional().catch(undefined),
  }),
  // No loaderDeps: moving to step 3 sets `?checklist=true` without a new match
  // (which would suspend and remount the page). The loader runs once per visit.
  shouldReload: false,
  loader: async ({ location }) => {
    stripTokenFromAddressBar();
    const { checklist, address, returnTo } = location.search as {
      checklist?: boolean;
      address?: boolean;
      returnTo?: string;
    };
    // Redirects to /login (users exist, no session) or returnTo or / (setup complete).
    const [gate, version] = await Promise.all([
      enterSetup({ data: { checklist: checklist === true, returnTo } }),
      loadAppflareVersion(),
    ]);
    const checklistData = gate.step === "checklist" ? await getCapabilityRowsData() : null;
    return {
      initial: initialWizardState(gate.step, checklistData, { addressShown: address === true }),
      version,
    };
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
  const loaded = Route.useLoaderData();
  const [state, dispatch] = useReducer(wizardReducer, loaded.initial);
  const router = useRouter();

  // A refusal can mean setup moved on elsewhere: the loader reads where it
  // stands again, and the wizard follows. The first run only repeats the start.
  const resync = useCallback(async () => {
    await router.invalidate();
  }, [router]);
  useEffect(() => {
    dispatch({ type: "sync", state: loaded.initial });
  }, [loaded.initial]);

  const copy = wizardCopy(state);
  const progress = wizardProgress(state);
  return (
    <AuthLayout
      width="wide"
      placement="top"
      {...(progress === null ? {} : { step: progress.step, stepCount: progress.count })}
      title={copy.title}
      description={<MessageText message={copy.description} newTab />}
      version={loaded.version}
    >
      <StepContent state={state} dispatch={dispatch} resync={resync} />
    </AuthLayout>
  );
}

function StepContent({
  state,
  dispatch,
  resync,
}: {
  state: WizardState;
  dispatch: (event: WizardEvent) => void;
  resync: () => Promise<void>;
}) {
  switch (state.step) {
    case "connect":
      return (
        <SetupTokenForm
          mode="first-run"
          onContinue={(saved) =>
            dispatch({ type: "connected", next: saved.next ?? "create-owner" })
          }
        />
      );
    case "redeploying":
      return <RedeployingStep onReady={() => dispatch({ type: "auth-ready" })} />;
    case "create-owner":
      return (
        <CreateOwnerStep
          onCreated={(checklist, address) =>
            dispatch({ type: "owner-created", checklist, address })
          }
          resync={resync}
        />
      );
    case "address":
      return (
        <SetupAddressStep
          options={state.options}
          accountId={state.checklist.view.accountId}
          onDone={() => dispatch({ type: "address-done" })}
        />
      );
    case "checklist":
      return (
        <ChecklistStep
          data={state.checklist}
          addressUnreadable={state.addressUnreadable === true}
          onRechecked={(checklist) => dispatch({ type: "checklist-loaded", checklist })}
        />
      );
    case "cloudflare-token":
      return (
        <SetupTokenForm
          mode="setup"
          onContinue={(saved: SetupTokenSaved) => dispatch({ type: "token-saved", saved })}
        />
      );
    case "token-saved":
      return (
        <TokenSavedStep
          saved={state.saved}
          onChecklist={(checklist) => dispatch({ type: "checklist-loaded", checklist })}
        />
      );
    case "wait-for-admin":
      return <WaitForAdminStep />;
  }
}

/**
 * Moves the address bar to the last step, so a reload goes there, without a
 * new route match. `address` records that the address step is (or was)
 * shown, so the step indicator keeps counting it.
 */
function useShowChecklistInAddress() {
  const router = useRouter();
  const search = Route.useSearch();
  return ({ address }: { address?: boolean } = {}) =>
    router.navigate({
      to: "/setup",
      search: {
        checklist: true,
        ...((address ?? search.address) === true ? { address: true } : {}),
        returnTo: search.returnTo,
      },
      replace: true,
    });
}

/** Where Appflare should live, shown only when the account has an active zone. */
function SetupAddressStep({
  options,
  accountId,
  onDone,
}: {
  options: AddressOptions;
  accountId: string | null;
  onDone: () => void;
}) {
  const { returnTo } = Route.useSearch();
  return (
    <AddressStep
      options={options}
      accountId={accountId}
      returnTo={setupResumePath(returnTo)}
      onDone={onDone}
    />
  );
}

/** How often the redeploy wait asks `/api/health` whether the new version serves. */
const REDEPLOY_POLL_MS = 2000;

/**
 * A manager deployed without secrets got its auth secret with the token; the
 * owner can be created once a version that has it serves. Polls the cheap,
 * unauthenticated health endpoint until it reports `authReady`.
 */
function RedeployingStep({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { authReady?: unknown };
        if (!cancelled && body.authReady === true) onReady();
      } catch {
        // The new version is rolling out; keep polling.
      }
    }, REDEPLOY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onReady]);
  return (
    <div className="flex items-center gap-2">
      <AppflareLoader size="sm" />
      <Text>Waiting for the new version to answer…</Text>
    </div>
  );
}

/** Step 2: the owner account, only in the browser that connected Cloudflare. */
function CreateOwnerStep({
  onCreated,
  resync,
}: {
  onCreated: (checklist: CapabilityRowsData, address: AddressOptions | null) => void;
  resync: () => Promise<void>;
}) {
  const router = useRouter();
  const { returnTo } = Route.useSearch();
  const showChecklist = useShowChecklistInAddress();
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
      await resync();
      return;
    }
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      await router.navigate({ href: withReturnTo("/login", returnTo) });
      return;
    }
    // The zones decide whether the address step shows; without them, it does not.
    const [checklist, address] = await Promise.all([
      getCapabilityRowsData(),
      getManagerAddressOptions().catch(() => null),
    ]);
    onCreated(checklist, address);
    await showChecklist({ address: offersAddressStep(address) });
  }

  return (
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
      <BusyButton pending={pending} type="submit" variant="primary" className={FULL_WIDTH_ACTION}>
        Create owner account
      </BusyButton>
    </form>
  );
}

/** Step 3: what the account can run, then Finish (home, or the page asked for first). */
function ChecklistStep({
  data,
  addressUnreadable,
  onRechecked,
}: {
  data: CapabilityRowsData;
  /** The address step was skipped because the domains could not be read. */
  addressUnreadable: boolean;
  onRechecked: (data: CapabilityRowsData) => void;
}) {
  const router = useRouter();
  const { returnTo } = Route.useSearch();
  return (
    <>
      {addressUnreadable && <AddressSkippedNote />}
      <SetupCapabilities data={data} onChanged={onRechecked} />
      <Button
        variant="primary"
        className={FULL_WIDTH_ACTION}
        onClick={() => void router.navigate({ href: afterSignIn(returnTo), replace: true })}
      >
        Finish
      </Button>
    </>
  );
}

/** A member signed in before the token step: nothing to do here but sign out. */
function WaitForAdminStep() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <>
      <Banner
        variant="secondary"
        icon={<InfoIcon weight="fill" />}
        title="An admin needs to finish setup"
        description="Appflare needs a Cloudflare API token before anyone can use it. Ask an admin to sign in and add one."
      />
      <BusyButton
        pending={signingOut}
        variant="secondary"
        icon={<SignOutIcon />}
        className={FULL_WIDTH_ACTION}
        onClick={signOut}
      >
        Sign out
      </BusyButton>
    </>
  );
}

/** How often the saved-token wait checks whether the redeployed Worker has the token. */
const SECRET_POLL_MS = 3000;

/**
 * An admin whose manager had users but no token: storing `CF_API_TOKEN`
 * deploys a new version of this Worker. Poll until a request lands on a
 * version that has the binding, then continue to what the account can run.
 */
function TokenSavedStep({
  saved,
  onChecklist,
}: {
  saved: SavedTokenSummary;
  onChecklist: (checklist: CapabilityRowsData) => void;
}) {
  const showChecklist = useShowChecklistInAddress();
  const [hasSecret, setHasSecret] = useState(false);
  const [continuing, setContinuing] = useState(false);

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

  async function onContinue() {
    setContinuing(true);
    try {
      onChecklist(await getCapabilityRowsData());
      await showChecklist();
    } finally {
      setContinuing(false);
    }
  }

  return (
    <>
      <div className="grid gap-4">
        <div className="flex items-start gap-2">
          <span className="flex h-lh items-center">
            {hasSecret ? (
              <CheckCircleIcon weight="fill" className="text-kumo-success" />
            ) : (
              <AppflareLoader size="sm" />
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
              <div className="grid gap-2">
                <p>
                  It guards nothing any more, so it can stay. A developer can remove it with the
                  command under Technical details.
                </p>
                <Collapsible.Root>
                  <Collapsible.DefaultTrigger>Technical details</Collapsible.DefaultTrigger>
                  <Collapsible.DefaultPanel>
                    <div className="grid gap-1.5">
                      <p>
                        The secret is <code className="font-mono text-[0.9em]">SETUP_TOKEN</code> on
                        Appflare's own Worker. To remove it:
                      </p>
                      <ClipboardText
                        text={`wrangler secret delete SETUP_TOKEN --name ${saved.workerName}`}
                      />
                    </div>
                  </Collapsible.DefaultPanel>
                </Collapsible.Root>
              </div>
            }
          />
        )}
      </div>
      <BusyButton
        pending={continuing}
        variant="primary"
        className={FULL_WIDTH_ACTION}
        onClick={() => void onContinue()}
      >
        Continue
      </BusyButton>
    </>
  );
}
