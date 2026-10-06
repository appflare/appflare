import {
  Banner,
  Button,
  ClipboardText,
  Collapsible,
  Input,
  LinkButton,
  Text,
} from "@cloudflare/kumo";
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
import {
  type ClaimNotice as ClaimNoticeState,
  claimNoticeFor,
  type RedeemResult,
  redeemOwnerClaimWith,
  takeOwnerClaimFromAddressBar,
} from "../handoff/owner-claim";
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
import { createOwner, redeemOwnerClaim } from "../server/setup.functions";
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
 * On a manager installed from the browser, step 1 happens on the page that
 * installed it: that page hands over the Cloudflare connection and opens
 * `/setup#claim=<code>`. The code leaves the address bar before anything
 * else and is exchanged, once, for this browser's setup claim; step 2
 * follows. Any other browser is told to finish there, or may connect with
 * an API token instead. Installed on a domain of the account, Appflare
 * lives there already, and the address step is skipped.
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
    // Before anything else: the code leaves the address bar, then is
    // exchanged for this browser's setup claim.
    const taken = takeOwnerClaimFromAddressBar();
    const redeemed = taken === null ? null : await redeem(taken.code);
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
      initial: initialWizardState(gate.step, checklistData, {
        addressShown: address === true,
        handoff: gate.handoff,
        installPage: gate.installPage,
      }),
      // What became of the code, shown only where it would have led past:
      // the first step. A code that got no definite answer stays in memory
      // (never in the address bar again) for Try again.
      claim: claimNoticeFor(taken, redeemed, gate.step === "handoff" || gate.step === "connect"),
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

/** Exchanges an owner claim for the setup claim cookie (see `redeemOwnerClaimWith`). */
function redeem(code: string | null): Promise<RedeemResult> {
  return redeemOwnerClaimWith((claim) => redeemOwnerClaim({ data: { claim } }), code);
}

function SetupPage() {
  const loaded = Route.useLoaderData();
  const [state, dispatch] = useReducer(wizardReducer, loaded.initial);
  const router = useRouter();
  // Kept across reloads of the loader, which no longer sees the code.
  const [claim, setClaim] = useState(loaded.claim);

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
      {claim !== null && (state.step === "handoff" || state.step === "connect") && (
        <ClaimNotice
          claim={claim}
          onAnswer={async (outcome) => {
            if (outcome === "retry") return;
            setClaim(outcome === "refused" ? { kind: "refused" } : null);
            if (outcome === "ok") await resync();
          }}
        />
      )}
      <StepContent state={state} dispatch={dispatch} resync={resync} />
    </AuthLayout>
  );
}

/**
 * What became of the setup link's code: refused for good, or not answered
 * yet, with Try again (the code is still in this page's memory).
 */
function ClaimNotice({
  claim,
  onAnswer,
}: {
  claim: ClaimNoticeState;
  onAnswer: (outcome: RedeemResult) => Promise<void>;
}) {
  const [trying, setTrying] = useState(false);
  if (claim.kind === "refused") {
    return (
      <Banner
        variant="alert"
        icon={<WarningIcon weight="fill" />}
        title="This setup link no longer works"
        description="It was already used, or it is more than 30 minutes old. Go back to the page that installed Appflare and open Appflare from there again."
      />
    );
  }
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title="Your setup link could not be used yet"
      description={
        <div className="grid gap-2">
          <p>Appflare did not answer, or asked this browser to wait a moment. Try again.</p>
          <div>
            <BusyButton
              pending={trying}
              variant="secondary"
              size="sm"
              onClick={async () => {
                setTrying(true);
                try {
                  await onAnswer(await redeem(claim.code));
                } finally {
                  setTrying(false);
                }
              }}
            >
              Try again
            </BusyButton>
          </div>
        </div>
      }
    />
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
    case "handoff":
      return (
        <HandoffStep
          installPage={state.installPage}
          onUseToken={() => dispatch({ type: "use-token" })}
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

/**
 * Step 1 on a manager installed from the browser, in a browser that has
 * not come from the page that installed it: go back there, or connect with
 * an API token instead (anyone with a token for this account controls it
 * anyway, so the token is enough on its own).
 */
function HandoffStep({
  installPage,
  onUseToken,
}: {
  installPage: string | null;
  onUseToken: () => void;
}) {
  return (
    <>
      <Text variant="secondary">
        If you closed that page, open it again in the same browser: it continues where it stopped.
      </Text>
      {installPage !== null && (
        <LinkButton href={installPage} variant="primary" className={FULL_WIDTH_ACTION}>
          Open the installer
        </LinkButton>
      )}
      <div className="grid gap-2">
        <Text variant="secondary">
          You can also connect Appflare with a Cloudflare API token for this account instead.
        </Text>
        <Button variant="secondary" className={FULL_WIDTH_ACTION} onClick={onUseToken}>
          Connect with an API token instead
        </Button>
      </div>
    </>
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
  onCreated: (checklist: CapabilityRowsData, address: AddressOptions | null | "set") => void;
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
    let addressSet = false;
    try {
      ({ addressSet } = await createOwner({
        data: { email, name: String(form.get("name") ?? ""), password },
      }));
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
    // The zones decide whether the address step shows; without them, it does
    // not. Nor when Appflare already lives on a domain (installed there).
    const [checklist, address] = await Promise.all([
      getCapabilityRowsData(),
      addressSet ? ("set" as const) : getManagerAddressOptions().catch(() => null),
    ]);
    onCreated(checklist, address);
    await showChecklist({ address: address !== "set" && offersAddressStep(address) });
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
