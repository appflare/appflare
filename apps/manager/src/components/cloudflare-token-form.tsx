import { Banner, Button, Input, Link, LinkButton, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  KeyIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useRef, useState } from "react";
import {
  ACCESS_FEATURE,
  accountTokenTemplateUrl,
  CUSTOM_DOMAINS_FEATURE,
  optionalGroupsByFeature,
  permissionName,
  splitPermissionGroups,
  userTokenTemplateUrl,
} from "../cloudflare/token-template";
import type { TokenVerification, VerifyTokenResult } from "../cloudflare/verify-token";
import { rotateToken, saveToken, verifyToken } from "../server/token.functions";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const { required } = splitPermissionGroups();
const optional = optionalGroupsByFeature();

/** Where each optional feature lives, for the list of what its permissions are for. */
const FEATURE_PLACES: Readonly<Record<string, string>> = {
  [ACCESS_FEATURE]: `"${ACCESS_FEATURE}" in Settings`,
  [CUSTOM_DOMAINS_FEATURE]: "Custom domains on an installed app's page",
};

export interface SavedToken {
  accountId: string;
  workerName: string;
  /** Setup only: false when `SETUP_TOKEN` could not be deleted from the Worker. */
  setupTokenRemoved?: boolean;
}

/**
 * Paste, verify, then save a Cloudflare API token: `/setup` (mode `setup`, calls
 * `saveToken`) and the settings rotation dialog (mode `rotate`, `rotateToken`).
 *
 * The token lives only in this component's state. It is sent to the server in a
 * POST body, never rendered back, and cleared after a successful save. The input
 * is uncontrolled: React mirrors a controlled input's value into the DOM `value`
 * attribute, which would put the token in the page's markup.
 */
export function CloudflareTokenForm({
  mode,
  onSaved,
}: {
  mode: "setup" | "rotate";
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
      const saved: SavedToken =
        mode === "setup"
          ? await saveToken({ data: { token } })
          : await rotateToken({ data: { token } });
      formRef.current?.reset();
      setToken("");
      setResult(null);
      onSaved({
        accountId: saved.accountId,
        workerName: saved.workerName,
        ...(saved.setupTokenRemoved === undefined
          ? {}
          : { setupTokenRemoved: saved.setupTokenRemoved }),
      });
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
          <Text bold>1. Create a token</Text>
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
            {mode === "setup" ? "Save and continue" : "Save new token"}
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
  const expiry = result.expiresOn
    ? `expires ${dateFormat.format(new Date(result.expiresOn))}`
    : "does not expire";
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
