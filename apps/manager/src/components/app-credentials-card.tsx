import type { TokenPermission } from "@appflare/schema";
import { Banner, Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, KeyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { replaceAppCredentials } from "../installs/app-credentials.functions";
import { AppTokenHelp } from "./app-token-permissions";

/**
 * The install page's card for a self-deploying app's own token: the sandbox
 * Worker holds it (and the app's secret values) for the app's installer.
 * Admins enter it again here when it was rotated or the sandbox Worker lost
 * it; the next update or uninstall uses it. Values are never shown.
 */
export function AppCredentialsCard({
  installId,
  appName,
  secretNames,
  tokenPermissions,
  canEdit,
}: {
  installId: string;
  appName: string;
  secretNames: readonly string[];
  /** What the app's token needs, for "Create token" next to its field. */
  tokenPermissions: readonly TokenPermission[];
  canEdit: boolean;
}) {
  const [token, setToken] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const entered = token.trim().length > 0 || Object.values(secrets).some((v) => v.length > 0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entered || pending) return;
    setPending(true);
    setResult(null);
    try {
      const { stored } = await replaceAppCredentials({
        data: {
          installId,
          ...(token.trim().length > 0 ? { appToken: token.trim() } : {}),
          secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.length > 0)),
        },
      });
      setToken("");
      setSecrets({});
      setResult({ ok: true, message: `Stored on the sandbox Worker: ${stored.join(", ")}.` });
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Could not store them.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center gap-2">
        <KeyIcon aria-hidden />
        App token
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <Text variant="secondary">
            {appName}'s installer runs with the token you created for it, which your sandbox Worker
            holds together with the app's secrets. Updating and uninstalling need them. Enter them
            again here if you rotated the token, or if the sandbox Worker was deleted and enabled
            again; leave a field empty to keep what it holds.
          </Text>
          <fieldset disabled={!canEdit || pending} className="grid gap-4">
            <Input
              label="New app token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              passwordManagerIgnore
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
            />
            {canEdit && <AppTokenHelp appName={appName} permissions={tokenPermissions} />}
            {secretNames.map((name) => (
              <Input
                key={name}
                label={`New value of ${name}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                passwordManagerIgnore
                value={secrets[name] ?? ""}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setSecrets((s) => ({ ...s, [name]: value }));
                }}
              />
            ))}
          </fieldset>
          {result !== null && (
            <Banner
              variant={result.ok ? "secondary" : "error"}
              icon={
                result.ok ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />
              }
              title={result.message}
            />
          )}
          {canEdit && (
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="secondary"
                icon={<KeyIcon />}
                loading={pending}
                disabled={!entered}
              >
                Store on the sandbox Worker
              </Button>
            </div>
          )}
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}
