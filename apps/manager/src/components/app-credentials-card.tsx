import type { TokenPermission } from "@appflare/schema";
import { Input, Text } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { replaceAppCredentials } from "../installs/app-credentials.functions";
import { AppTokenHelp } from "./app-token-permissions";
import { BusyButton } from "./busy-button";
import { bannerMessage, ErrorMessageBanner, StatusRegion, SuccessBanner } from "./message-text";
import { Section, SectionBody } from "./section";

/**
 * The install page's section for a self-deploying app's own token: the sandbox
 * Worker holds it (and the app's secret values) for the app's installer.
 * Admins enter it again here when it was rotated or the sandbox Worker lost
 * it; the next update or uninstall uses it. Values are never shown.
 *
 * The fields are uncontrolled and read from the form on submit: React mirrors
 * a controlled input's value into the DOM `value` attribute, which would put
 * the token in the page's markup.
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
  const [entered, setEntered] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  /** What the fields hold: the token trimmed, and the secrets given a value. */
  function valuesOf(form: HTMLFormElement) {
    const data = new FormData(form);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    return {
      token: field(TOKEN_FIELD).trim(),
      secrets: Object.fromEntries(
        secretNames.flatMap((name) => {
          const value = field(secretField(name));
          return value.length > 0 ? [[name, value] as const] : [];
        }),
      ),
    };
  }

  function onInput(event: FormEvent<HTMLFormElement>) {
    const { token, secrets } = valuesOf(event.currentTarget);
    setEntered(token.length > 0 || Object.keys(secrets).length > 0);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    // Read before the fieldset locks: a disabled field is left out of the form's data.
    const { token, secrets } = valuesOf(form);
    if ((token.length === 0 && Object.keys(secrets).length === 0) || pending) return;
    setPending(true);
    setResult(null);
    try {
      const { stored } = await replaceAppCredentials({
        data: { installId, ...(token.length > 0 ? { appToken: token } : {}), secrets },
      });
      form.reset();
      setEntered(false);
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
    <Section title="App token">
      <SectionBody>
        <form className="grid gap-4" onSubmit={onSubmit} onInput={onInput}>
          <Text variant="secondary">
            {appName}'s installer runs with the token you created for it, which your sandbox Worker
            holds together with the app's secrets. Updating and uninstalling need them. Enter them
            again here if you rotated the token, or if the sandbox Worker was deleted and enabled
            again; leave a field empty to keep what it holds.
          </Text>
          <div>
            <fieldset disabled={!canEdit || pending} className="grid gap-4">
              <Input
                label="New app token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                passwordManagerIgnore
                name={TOKEN_FIELD}
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
                  name={secretField(name)}
                />
              ))}
            </fieldset>
            {/* Outside the form's gaps, so what was stored is announced. */}
            <StatusRegion spacing="mt-4">
              {result?.ok === true && (
                <SuccessBanner live={false} {...bannerMessage(result.message)} />
              )}
            </StatusRegion>
          </div>
          {result?.ok === false && <ErrorMessageBanner message={result.message} />}
          {canEdit && (
            <div className="flex justify-end">
              <BusyButton
                pending={pending}
                type="submit"
                variant="secondary"
                icon={<KeyIcon />}
                disabled={!entered}
              >
                Store on the sandbox Worker
              </BusyButton>
            </div>
          )}
        </form>
      </SectionBody>
    </Section>
  );
}

/** The token field's name in the form. */
const TOKEN_FIELD = "appToken";

/** A secret's field name in the form, apart from the token's whatever the secret is called. */
function secretField(name: string): string {
  return `secret:${name}`;
}
