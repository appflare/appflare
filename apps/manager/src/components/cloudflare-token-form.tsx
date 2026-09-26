import { Banner, Button, Collapsible, Input, Link, LinkButton, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  KeyIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  ACCESS_FEATURE,
  accountTokenTemplateUrl,
  CUSTOM_DOMAINS_FEATURE,
  DATABASE_ELSEWHERE_FEATURE,
  EMAIL_ROUTING_FEATURE,
  EXTERNAL_DOMAINS_FEATURE,
  optionalGroupsByFeature,
  PLAN_DETECTION_FEATURE,
  permissionName,
  SANDBOX_BUILDS_FEATURE,
  splitPermissionGroups,
  userTokenTemplateUrl,
} from "../cloudflare/token-template";
import type { TokenVerification, VerifyTokenResult } from "../cloudflare/verify-token";
import {
  CONNECTED_PAUSE_MS,
  type SavedTokenSummary,
  type TokenOutcome,
  tokenOutcome,
} from "../onboarding/wizard";
import { connectCloudflare } from "../server/setup.functions";
import { rotateToken, saveToken, verifyToken } from "../server/token.functions";
import { DocsLink } from "./docs-link";
import { formatDate } from "./format";

const { required } = splitPermissionGroups();
const optional = optionalGroupsByFeature();

/** Where each optional feature lives, for the list of what its permissions are for. */
const FEATURE_PLACES: Readonly<Record<string, string>> = {
  [ACCESS_FEATURE]: `"${ACCESS_FEATURE}" in Settings > Users and access`,
  [CUSTOM_DOMAINS_FEATURE]: "Custom domains on an installed app's Domains and email tab",
  [EXTERNAL_DOMAINS_FEATURE]:
    "External domains (Settings > Domains, then an installed app's Domains and email tab)",
  [EMAIL_ROUTING_FEATURE]:
    "Installing an app that receives email (it also needs Zone: Read and DNS: Edit from the custom domains list)",
  [PLAN_DETECTION_FEATURE]:
    "Reading this account's Workers plan for Settings > Account and capabilities, instead of asking you. Appflare only reads the plan names from the account's subscriptions; it never reads invoices or payment details",
  [SANDBOX_BUILDS_FEATURE]:
    "Enabling, updating and disabling sandbox builds in Settings > Account and capabilities (Workers Paid): Appflare creates, rolls out and deletes the sandbox Worker's container applications",
  [DATABASE_ELSEWHERE_FEATURE]:
    "Installing an app that keeps its data in a PostgreSQL or MySQL database outside Cloudflare: Appflare creates a Hyperdrive configuration from the connection string you enter, replaces it when you change the string, and deletes it on uninstall",
};

/** What a rotation saved. */
export interface SavedToken {
  accountId: string;
  workerName: string;
}

/**
 * Settings' token rotation: paste, verify, then save a new Cloudflare API
 * token (`verifyToken`, then `rotateToken`). Setup uses {@link SetupTokenForm}.
 *
 * The token lives only in this component's state. It is sent to the server in a
 * POST body, never rendered back, and cleared after a successful save. The input
 * is uncontrolled: React mirrors a controlled input's value into the DOM `value`
 * attribute, which would put the token in the page's markup.
 */
export function CloudflareTokenForm({
  onSaved,
}: {
  /** The only use left; setup has its own form. */
  mode: "rotate";
  onSaved: (saved: SavedToken) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<VerifyTokenResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onTokenChange(value: string) {
    setToken(value);
    // A verification only ever applies to the exact value that was verified.
    setResult(null);
    setError(null);
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifying(true);
    setError(null);
    setResult(null);
    try {
      setResult(await verifyToken({ data: { token } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the token.");
    } finally {
      setVerifying(false);
    }
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await rotateToken({ data: { token } });
      formRef.current?.reset();
      setToken("");
      setResult(null);
      onSaved({ accountId: saved.accountId, workerName: saved.workerName });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the token.");
    } finally {
      setSaving(false);
    }
  }

  const canSave = result?.ok === true && result.permissionsOk && !verifying;

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1">
            <Text bold>1. Create a token</Text>
            <DocsLink topic="tokenPermissions" />
          </div>
          <Text variant="secondary">
            The link opens the Cloudflare dashboard with the permissions Appflare needs already
            selected: {required.map((g) => g.label).join(", ")}. Choose this account, create the
            token, and copy it.
          </Text>
          {optional.length > 0 && (
            <div className="grid gap-1">
              <Text variant="secondary">
                It also selects permissions that only one optional feature uses. You can remove them
                from the token if you will not use that feature, and add them back later by editing
                or rotating the token:
              </Text>
              <ul className="grid gap-1 pl-4">
                {optional.map(({ feature, groups }) => (
                  <li key={feature}>
                    <Text as="span" variant="secondary">
                      {FEATURE_PLACES[feature] ?? `"${feature}"`}:{" "}
                      {groups.map(permissionName).join(", ")}
                    </Text>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LinkButton
            href={accountTokenTemplateUrl()}
            external
            variant="secondary"
            icon={<KeyIcon />}
          >
            Create token
          </LinkButton>
          <Text variant="secondary" size="sm">
            Not a Super Administrator?{" "}
            <Link href={userTokenTemplateUrl()} target="_blank" rel="noopener noreferrer">
              Create a user token instead <Link.ExternalIcon />
            </Link>
          </Text>
        </div>
      </div>

      <form ref={formRef} className="grid gap-3" onSubmit={onVerify}>
        <Text bold>2. Paste and verify it</Text>
        <Input
          label="Cloudflare API token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          passwordManagerIgnore
          required
          maxLength={512}
          // Locked while a request is in flight, so a result always matches the value.
          disabled={verifying || saving}
          onChange={(event) => onTokenChange(event.currentTarget.value)}
          description="Stored as an encrypted secret on this Worker. Appflare never shows it again."
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="submit"
            variant="secondary"
            icon={<ShieldCheckIcon />}
            loading={verifying}
            disabled={token.trim().length === 0}
          >
            Verify
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving}
            disabled={!canSave}
            onClick={onSave}
          >
            Save new token
          </Button>
        </div>
      </form>

      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
      {result !== null && !result.ok && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Verification failed"
          description={result.error}
        />
      )}
      {result?.ok === true && <VerifiedSummary result={result} />}
    </div>
  );
}

function VerifiedSummary({ result }: { result: TokenVerification }) {
  const account = result.accountName
    ? `${result.accountName} (${result.accountId})`
    : result.accountId;
  const kind = result.tokenType === "account" ? "Account API token" : "User API token";
  const expiry = result.expiresOn ? `expires ${formatDate(result.expiresOn)}` : "does not expire";
  return (
    <div className="grid gap-3">
      <Banner
        icon={<CheckCircleIcon weight="fill" />}
        title="Token verified"
        description={`${kind} for ${account}; ${expiry}.`}
      />
      {!result.permissionsOk && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="This token cannot manage Workers"
          description="Appflare needs Workers Scripts: Edit to store the token on itself and install apps. Create a token from the link above."
        />
      )}
      {result.missing.length > 0 && result.permissionsOk && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="Some permissions could not be confirmed"
          description={`Missing or not readable: ${result.missing.join(", ")}. You can continue; apps that need them will fail to install until the token has them.`}
        />
      )}
    </div>
  );
}

/** The feature each group of the token serves, for the "What the token can do" list. */
const TOKEN_USES: ReadonlyArray<{ feature: string; permissions: string }> = [
  { feature: "Install and update apps", permissions: required.map(permissionName).join(", ") },
  ...optional.map(({ feature, groups }) => ({
    feature,
    permissions: groups.map(permissionName).join(", "),
  })),
];

/** What each part of the token is for: feature, then its permissions. */
function TokenUses() {
  return (
    <div className="grid gap-2">
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,9.5rem)_1fr]">
        {TOKEN_USES.map(({ feature, permissions }) => (
          <div key={feature} className="contents">
            <dt>
              <Text size="sm" as="span">
                {feature}
              </Text>
            </dt>
            <dd className="mb-1 sm:mb-0">
              <Text variant="secondary" size="sm" as="span">
                {permissions}
              </Text>
            </dd>
          </div>
        ))}
      </dl>
      <Text variant="secondary" size="sm">
        Only the first line is required. Remove any other line you will not use; add it back later
        by editing the token.
      </Text>
    </div>
  );
}

/** One numbered part of the token step: the number, a short title, then its content. */
function Part({
  n,
  title,
  extra,
  children,
}: {
  n: number;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span
        aria-hidden="true"
        className="flex size-6 items-center justify-center rounded-full bg-kumo-tint text-sm font-medium text-kumo-default"
      >
        {n}
      </span>
      <div className="flex min-h-6 flex-wrap items-center gap-x-1 gap-y-0.5">
        <Text bold as="h2">
          {title}
        </Text>
        {extra}
      </div>
      <div className="col-start-2 grid gap-2">{children}</div>
    </li>
  );
}

/** What the setup token step reports once the token is verified and saved. */
export interface SetupTokenSaved extends SavedTokenSummary {
  /** First-run setup only: what follows (see `connectCloudflare`). */
  next?: "create-owner" | "redeploying";
}

/**
 * The setup token step, in three short parts: create the token (the button
 * first, one sentence, the permissions behind a disclosure), paste it, then
 * one Continue that verifies and saves in a single call (`connectCloudflare`
 * before any user exists, mode `first-run`; `saveToken` for an admin whose
 * manager has no token yet, mode `setup`). On success the account name shows
 * for a moment, then `onContinue` moves the wizard on; when some permission
 * could not be confirmed the warning stays until Continue. A refusal shows
 * Cloudflare's or Appflare's plain message under the button.
 *
 * The token lives only in the uncontrolled input and this component's state,
 * is sent in a POST body, and is never rendered back.
 */
export function SetupTokenForm({
  mode,
  onContinue,
}: {
  mode: "first-run" | "setup";
  onContinue: (saved: SetupTokenSaved) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{
    saved: SetupTokenSaved;
    outcome: TokenOutcome;
  } | null>(null);

  // The latest callback, so a parent re-render does not restart the pause.
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;

  // Moves on by itself after the pause when nothing needs reading.
  useEffect(() => {
    if (connected === null || !connected.outcome.autoAdvance) return;
    const timer = setTimeout(() => onContinueRef.current(connected.saved), CONNECTED_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connected !== null) {
      onContinue(connected.saved);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved: SetupTokenSaved =
        mode === "first-run"
          ? await connectCloudflare({ data: { token } })
          : await saveToken({ data: { token } });
      formRef.current?.reset();
      setToken("");
      setConnected({ saved, outcome: tokenOutcome(saved) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the token.");
    } finally {
      setSaving(false);
    }
  }

  const locked = saving || connected !== null;

  return (
    <form ref={formRef} onSubmit={onSubmit}>
      <ol className="grid gap-4">
        <Part n={1} title="Create a token" extra={<DocsLink topic="tokenPermissions" />}>
          <div>
            <LinkButton
              href={accountTokenTemplateUrl()}
              external
              variant="secondary"
              icon={<KeyIcon />}
            >
              Create token
            </LinkButton>
          </div>
          <Text variant="secondary">
            The link opens Cloudflare with the permissions already selected. Scroll down, choose
            Review token, then Create token, and copy it.
          </Text>
          <Collapsible.Root>
            <Collapsible.DefaultTrigger>What the token can do</Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <TokenUses />
            </Collapsible.DefaultPanel>
          </Collapsible.Root>
          <Text variant="secondary" size="sm">
            Not a Super Administrator?{" "}
            <Link href={userTokenTemplateUrl()} target="_blank" rel="noopener noreferrer">
              Create a user token instead <Link.ExternalIcon />
            </Link>
          </Text>
        </Part>
        <Part n={2} title="Paste it">
          <Input
            aria-label="Cloudflare API token"
            placeholder="Cloudflare API token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            passwordManagerIgnore
            required
            maxLength={512}
            disabled={locked}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              setError(null);
            }}
          />
          <Text variant="secondary" size="sm">
            Stored as an encrypted secret on this Worker. Appflare never shows it again.
          </Text>
        </Part>
        <Part
          n={3}
          title="Connect"
          extra={connected === null ? undefined : <ConnectedHeadline outcome={connected.outcome} />}
        >
          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            loading={saving}
            disabled={connected === null && token.trim().length === 0}
          >
            Continue
          </Button>
          <div className="grid gap-2 empty:hidden">
            {connected !== null && connected.outcome.missing.length > 0 && (
              <MissingPermissions missing={connected.outcome.missing} />
            )}
            {error !== null && (
              <div role="alert">
                <Banner
                  variant="error"
                  icon={<WarningCircleIcon weight="fill" />}
                  description={error}
                />
              </div>
            )}
          </div>
        </Part>
      </ol>
    </form>
  );
}

/**
 * The verified account, on the "Connect" line itself so the step does not
 * grow (and scroll) in the moment before the wizard moves on.
 */
function ConnectedHeadline({ outcome }: { outcome: TokenOutcome }) {
  return (
    <span role="status" className="ml-auto flex items-start gap-1.5">
      <span className="flex h-lh items-center">
        <CheckCircleIcon weight="fill" className="text-kumo-success" />
      </span>
      <Text as="span">
        {outcome.headline}
        {outcome.autoAdvance && <span className="text-kumo-subtle">. Continuing…</span>}
      </Text>
    </span>
  );
}

/** What the save could not confirm; the wizard waits for Continue while it shows. */
function MissingPermissions({ missing }: { missing: string[] }) {
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title="Some permissions could not be confirmed"
      description={`Missing or not readable: ${missing.join(", ")}. Apps that need them fail to install until the token has them. Choose Continue to go on.`}
    />
  );
}
