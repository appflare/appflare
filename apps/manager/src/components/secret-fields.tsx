import {
  type CatalogSecret,
  enteredSecrets,
  isDerivedSecret,
  isOptionalSecret,
} from "@appflare/schema";
import { Button, Input, SensitiveInput, Switch, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { GENERATED_SECRET_LENGTH } from "../installs/install-input";

/**
 * One field per catalog secret, shared by the install form and the update
 * form. `generate: true` secrets are prefilled once with a random value the
 * admin can copy now (it is shown only here) or regenerate; the others are
 * password fields the admin fills in. An optional secret (`optional: true`)
 * is left unset behind a "Set now" switch; turning it on opens its field.
 *
 * Values are keyed by secret name. An optional secret has no key while it is
 * left unset, so the form sends nothing for it. A derived secret (the
 * catalog's `derive`) gets no field: the server computes it from its source,
 * whose field says so.
 */

export function generatedSecret(): string {
  return generateTemporaryPassword(GENERATED_SECRET_LENGTH);
}

/** Initial values: generated for `generate: true` secrets, empty otherwise; none for optional or derived ones. */
export function initialSecretValues(secrets: readonly CatalogSecret[]): Record<string, string> {
  return Object.fromEntries(
    enteredSecrets(secrets)
      .filter((s) => !isOptionalSecret(s))
      .map((s) => [s.name, s.generate ? generatedSecret() : ""]),
  );
}

/** `values` with one secret's new value; undefined drops it (an optional secret left unset). */
export function withSecretValue(
  values: Readonly<Record<string, string>>,
  name: string,
  value: string | undefined,
): Record<string, string> {
  if (value !== undefined) return { ...values, [name]: value };
  const { [name]: _dropped, ...rest } = values;
  return rest;
}

/** Whether every secret that is required, or optional and being set now, has a value. */
export function secretsComplete(
  secrets: readonly CatalogSecret[],
  values: Readonly<Record<string, string | undefined>>,
): boolean {
  return enteredSecrets(secrets).every((s) => {
    const value = values[s.name];
    return isOptionalSecret(s) && value === undefined ? true : (value ?? "").length > 0;
  });
}

export function SecretFields({
  secrets,
  values,
  onChange,
  after,
}: {
  secrets: readonly CatalogSecret[];
  values: Readonly<Record<string, string | undefined>>;
  /** A new value; undefined leaves an optional secret unset. */
  onChange(name: string, value: string | undefined): void;
  /** What ends the chance to copy a generated value ("the install", "the update"). */
  after: string;
}) {
  return enteredSecrets(secrets).map((secret) => {
    const value = values[secret.name];
    const derived = derivedNote(secrets, secret.name);
    if (!isOptionalSecret(secret)) {
      return (
        <SecretField
          key={secret.name}
          secret={secret}
          value={value ?? ""}
          onChange={(next) => onChange(secret.name, next)}
          after={after}
          note={derived}
        />
      );
    }
    const label = `${secret.label} (${secret.name})`;
    return (
      <div key={secret.name} className="grid gap-2">
        <div className="grid gap-1">
          <Text bold>{label}</Text>
          <Text variant="secondary" size="sm">
            {secret.help ? `${secret.help} ` : ""}Optional: the app works without it, and it can be
            set later in the app's settings.
          </Text>
        </div>
        <Switch
          label="Set now"
          checked={value !== undefined}
          onCheckedChange={(on: boolean) =>
            onChange(secret.name, on ? (secret.generate ? generatedSecret() : "") : undefined)
          }
        />
        {value !== undefined && (
          <SecretField
            secret={secret}
            withHelp={false}
            value={value}
            onChange={(next) => onChange(secret.name, next)}
            after={after}
          />
        )}
      </div>
    );
  });
}

/**
 * What the field of `name` says about the secrets derived from it, or
 * undefined when none is.
 */
export function derivedNote(secrets: readonly CatalogSecret[], name: string): string | undefined {
  const derived = secrets.filter((s) => isDerivedSecret(s) && s.derive?.from === name);
  if (derived.length === 0) return undefined;
  return `Appflare also sets ${derived.map((s) => s.name).join(" and ")} from it.`;
}

/** The value field of one secret: generated (copy now, regenerate) or a password field. */
function SecretField({
  secret,
  value,
  onChange,
  after,
  withHelp = true,
  note,
}: {
  secret: CatalogSecret;
  value: string;
  onChange(value: string): void;
  after: string;
  /** Show the catalog's help under the field (off when the switch above already shows it). */
  withHelp?: boolean;
  /** A sentence after the help, such as which secrets are derived from this one. */
  note?: string | undefined;
}) {
  const label = `${secret.label} (${secret.name})`;
  const help =
    [withHelp ? secret.help : undefined, note].filter((t) => t !== undefined).join(" ") ||
    undefined;
  if (secret.generate) {
    return (
      <div className="grid gap-2">
        <SensitiveInput
          label={label}
          value={value}
          onValueChange={(next: string) => onChange(next)}
          description={`${help ? `${help} ` : ""}Generated for you. Copy it now: it is shown only here and cannot be read back after ${after}.`}
        />
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<ArrowsClockwiseIcon />}
            onClick={() => onChange(generatedSecret())}
          >
            Regenerate
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Input
      label={label}
      type="password"
      autoComplete="off"
      spellCheck={false}
      passwordManagerIgnore
      required
      onChange={(e) => onChange(e.currentTarget.value)}
      description={help}
    />
  );
}
