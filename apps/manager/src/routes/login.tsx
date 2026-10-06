import { Banner, Button, Input, Link, Text } from "@cloudflare/kumo";
import { FingerprintIcon, InfoIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../auth/client";
import {
  PASSKEY_MESSAGES,
  passkeyRegistrationErrorMessage,
  passkeySignInErrorMessage,
  passkeysSupported,
} from "../auth/passkey-errors";
import { passwordSignInErrorMessage } from "../auth/sign-in-errors";
import { AuthError, AuthLayout, FULL_WIDTH_ACTION, OrDivider } from "../components/auth-layout";
import { BusyButton } from "../components/busy-button";
import { PasswordInput } from "../components/password-input";
import { afterSignIn, withReturnTo } from "../components/return-to";
import {
  loginSearchSchema,
  MOVED_HERE_NOTE,
  MOVED_SIGN_IN_NOTE,
  PASSKEY_OFFER,
  showsMovedNote,
} from "../domains/moved-note";
import { listPasskeys } from "../server/passkeys.functions";
import { getSetupStatus } from "../server/setup.functions";
import { loadAppflareVersion } from "../server/version.functions";

/**
 * `/login`: Better Auth email + password, or a passkey the user added in
 * Settings. `?returnTo=` is the page the visitor was sent here from; signing
 * in either way opens it (home when it is missing or not one of this
 * manager's pages), and "Forgot your password?" carries it along.
 *
 * Right after Appflare moved to this address (an admin's move, which sends
 * the browser here with `?moved=1`, or the move it made by itself to the
 * domain it was installed for), the page says why everyone signs in again,
 * and after a password sign-in offers a passkey for this address, unless the
 * user has one that works here already.
 */
export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  validateSearch: loginSearchSchema,
  beforeLoad: async ({ search }) => {
    const [{ needsSetup, movedHere }, version] = await Promise.all([
      getSetupStatus(),
      loadAppflareVersion(),
    ]);
    // Until the owner exists, everything leads to /setup.
    if (needsSetup) throw redirect({ href: withReturnTo("/setup", search.returnTo) });
    return { version, movedHere };
  },
  component: LoginPage,
});

/** Whether to offer a passkey now: supported here, and none of the user's works at this address. */
async function offersPasskey(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return !(await listPasskeys()).some((p) => p.worksAt === null || p.worksAt === undefined);
  } catch {
    // Not knowing is no reason to hold the sign-in up.
    return false;
  }
}

function LoginPage() {
  const { version, movedHere } = Route.useRouteContext();
  const search = Route.useSearch();
  const { returnTo } = search;
  const router = useRouter();
  const signedIn = () => router.navigate({ href: afterSignIn(returnTo), replace: true });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [offer, setOffer] = useState(false);
  const moved = showsMovedNote(search) || movedHere;

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
    if (moved && (await offersPasskey())) {
      setPending(null);
      setOffer(true);
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

  if (offer) {
    return (
      <AuthLayout
        title={PASSKEY_OFFER.title(window.location.host)}
        description={PASSKEY_OFFER.description}
        version={version}
      >
        <PasskeyOffer onDone={signedIn} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in to Appflare"
      description="Use your email and password, or a passkey."
      version={version}
    >
      <div className="grid gap-5">
        {moved && (
          <Banner
            variant="secondary"
            icon={<InfoIcon weight="fill" />}
            description={showsMovedNote(search) ? MOVED_SIGN_IN_NOTE : MOVED_HERE_NOTE}
          />
        )}
        {error !== null && <AuthError message={error} />}
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Input label="Email" name="email" type="email" autoComplete="username" required />
          <PasswordInput label="Password" name="password" autoComplete="current-password" />
          <Text variant="secondary" size="sm" as="p">
            <Link href={withReturnTo("/forgot-password", returnTo)}>Forgot your password?</Link>
          </Text>
          <BusyButton
            pending={pending === "password"}
            type="submit"
            variant="primary"
            className={FULL_WIDTH_ACTION}
            disabled={pending === "passkey"}
          >
            Sign in
          </BusyButton>
        </form>
        <OrDivider />
        <BusyButton
          pending={pending === "passkey"}
          variant="secondary"
          icon={<FingerprintIcon />}
          className={FULL_WIDTH_ACTION}
          disabled={pending === "password"}
          onClick={onPasskey}
        >
          Sign in with a passkey
        </BusyButton>
      </div>
    </AuthLayout>
  );
}

/**
 * Signed in at Appflare's new address: add a passkey for it now (the
 * browser's prompt), or not now. Either way the page asked for opens next.
 */
function PasskeyOffer({ onDone }: { onDone: () => Promise<unknown> }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    setAdding(true);
    setError(null);
    const { error: addError } = await authClient.passkey.addPasskey({ name: PASSKEY_OFFER.name });
    if (addError) {
      setError(passkeyRegistrationErrorMessage(addError));
      setAdding(false);
      return;
    }
    await onDone();
  }

  return (
    <div className="grid gap-3">
      {error !== null && <AuthError message={error} />}
      <BusyButton
        pending={adding}
        variant="primary"
        icon={<FingerprintIcon />}
        className={FULL_WIDTH_ACTION}
        onClick={onAdd}
      >
        Add a passkey
      </BusyButton>
      <Button
        variant="secondary"
        className={FULL_WIDTH_ACTION}
        disabled={adding}
        onClick={() => void onDone()}
      >
        Not now
      </Button>
    </div>
  );
}
