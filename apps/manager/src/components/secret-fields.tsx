import {
  type CatalogSecret,
  type CatalogVar,
  enteredSecrets,
  generateBase64Key32,
  generateVapidPrivateKey,
  isDerivedSecret,
  isMultilineSecret,
  isOptionalSecret,
  isSeedOnly,
} from "@appflare/schema";
import { Button, Input, InputArea, SensitiveInput, Switch, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { GENERATED_SECRET_LENGTH } from "../installs/install-input";

/**
 * One field per catalog secret, shared by the install form and the update
 * form. Generated secrets (`generate`) are prefilled once with a fresh value the
 * admin can copy now (it is shown only here) or regenerate; a multi-line one
 * (`multiline`) is a text area that keeps its line breaks; the others are
 * password fields the admin fills in. An optional secret (`optional: true`)
 * is left unset behind a "Set now" switch; turning it on opens its field.
 *
 * Values are keyed by secret name. An optional secret has no key while it is
 * left unset, so the form sends nothing for it. A derived secret (the
 * catalog's `derive`) gets no field: the server computes it from its source,
 * whose field says so. A seed-only secret (the catalog's `seedOnly`) is only
 * ever in the install form, whose field says it is used once and not kept.
 */

/** What the field of a seed-only secret says (the catalog's `seedOnly`). */
export const SEED_ONLY_SECRET_NOTE =
  "Used once to create the first admin account. Appflare does not keep it; copy it before you install.";

/** What the field of a seed-only var says. */
export const SEED_ONLY_VAR_NOTE =
  "Used once to create the first admin account. Appflare does not keep it.";

/**
 * A fresh value for a secret the catalog generates: a random password for
 * `generate: true`, a new VAPID private key for `"vapid-private-key"`, 32
 * random bytes as padded base64 for `"base64-key-32"` (WebCrypto's
 * `getRandomValues`, in the browser).
 */
export function generatedSecret(generate: CatalogSecret["generate"]): string {
  if (generate === "vapid-private-key") return generateVapidPrivateKey();
  if (generate === "base64-key-32") return generateBase64Key32();
  return generateTemporaryPassword(GENERATED_SECRET_LENGTH);
}

/**
 * Initial values: generated for generated secrets, empty otherwise; none for
 * optional or derived ones. A `held` secret (the Worker has it already, and
 * an update asks for it again) starts empty even when generated: a fresh
 * value would replace the current one unasked.
 */
export function initialSecretValues(
  secrets: readonly CatalogSecret[],
  held: readonly string[] = [],
): Record<string, string> {
  return Object.fromEntries(
    enteredSecrets(secrets)
      .filter((s) => !isOptionalSecret(s))
      .map((s) => [
        s.name,
        s.generate && !held.includes(s.name) ? generatedSecret(s.generate) : "",
      ]),
  );
}

/** What the field of a secret the Worker already has says, asked for again by an update. */
export function heldSecretNote(secret: Pick<CatalogSecret, "generate">): string {
  return secret.generate === "vapid-private-key"
    ? "The app already has this key. Paste it to keep existing push subscriptions, or generate a new one (subscribers must subscribe again)."
    : "The app already has this secret. Enter its current value to keep it, or a new one to replace it.";
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
  vars = [],
  held = [],
  values,
  onChange,
  after,
}: {
  secrets: readonly CatalogSecret[];
  /** Secrets the Worker already has, asked for again by an update; their fields start empty. */
  held?: readonly string[];
  /** The catalog's vars, for the vars derived from a secret. */
  vars?: readonly Pick<CatalogVar, "name" | "derive">[];
  values: Readonly<Record<string, string | undefined>>;
  /** A new value; undefined leaves an optional secret unset. */
  onChange(name: string, value: string | undefined): void;
  /** What ends the chance to copy a generated value ("the install", "the update"). */
  after: string;
}) {
  return enteredSecrets(secrets).map((secret) => {
    const value = values[secret.name];
    const derived = derivedNote(secrets, secret.name, vars);
    const isHeld = held.includes(secret.name);
    if (!isOptionalSecret(secret)) {
      return (
        <SecretField
          key={secret.name}
          secret={secret}
          value={value ?? ""}
          onChange={(next) => onChange(secret.name, next)}
          after={after}
          note={
            [
              derived,
              isHeld ? heldSecretNote(secret) : undefined,
              isSeedOnly(secret) ? SEED_ONLY_SECRET_NOTE : undefined,
            ]
              .filter((t) => t !== undefined)
              .join(" ") || undefined
          }
          held={isHeld}
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
            onChange(
              secret.name,
              on ? (secret.generate ? generatedSecret(secret.generate) : "") : undefined,
            )
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
 * What the field of `name` says about the secrets and vars derived from it,
 * or undefined when none is.
 */
export function derivedNote(
  secrets: readonly CatalogSecret[],
  name: string,
  vars: readonly Pick<CatalogVar, "name" | "derive">[] = [],
): string | undefined {
  const derived = [
    ...secrets.filter((s) => isDerivedSecret(s) && s.derive?.from === name),
    ...vars.filter((v) => v.derive?.from === name),
  ];
  if (derived.length === 0) return undefined;
  return `Appflare also sets ${derived.map((s) => s.name).join(" and ")} from it.`;
}

/**
 * A multi-line secret as the Worker gets it: Windows line endings become
 * `\n`, and spaces or tabs at the end of the last line are dropped (a paste
 * often carries them). Every other character, line breaks included, is kept,
 * so a PEM block arrives exactly as pasted.
 */
export function normaliseMultilineSecret(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[^\S\n]+$/, "");
}

/**
 * The field of a multi-line secret (the catalog's `multiline: true`), such as
 * a PEM private key: a monospace text area that keeps every line break. A
 * text area cannot mask its value, so it is shown while the admin enters it,
 * and the note says it is never shown again. Shared by the install and
 * update forms and the app's settings.
 */
export function MultilineSecretInput({
  label,
  value,
  onChange,
  description,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  /** Help before the note that the value is hidden once saved. */
  description?: string | undefined;
  disabled?: boolean;
}) {
  return (
    <InputArea
      label={label}
      value={value}
      required
      disabled={disabled}
      autoResize
      minRows={6}
      maxRows={16}
      className="font-mono"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onValueChange={(next: string) => onChange(next.replace(/\r\n/g, "\n"))}
      onBlur={() => {
        const settled = normaliseMultilineSecret(value);
        if (settled !== value) onChange(settled);
      }}
      description={`${description ? `${description} ` : ""}${MULTILINE_SECRET_NOTE}`}
    />
  );
}

/** What the field of a multi-line secret says after its help. */
export const MULTILINE_SECRET_NOTE =
  "Paste it with its line breaks. It is shown while you enter it and hidden once saved: Appflare cannot read it back.";

/** The value field of one secret: generated (copy now, regenerate), multi-line, or a password field. */
function SecretField({
  secret,
  value,
  onChange,
  after,
  withHelp = true,
  note,
  held = false,
}: {
  secret: CatalogSecret;
  value: string;
  onChange(value: string): void;
  after: string;
  /** Show the catalog's help under the field (off when the switch above already shows it). */
  withHelp?: boolean;
  /** A sentence after the help, such as which secrets are derived from this one. */
  note?: string | undefined;
  /** The Worker has it already: the admin keeps it by entering it, or chooses a new one. */
  held?: boolean;
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
          description={
            held && value.length === 0
              ? help
              : isSeedOnly(secret)
                ? `${help ? `${help} ` : ""}Generated for you; the install's page shows it once more.`
                : `${help ? `${help} ` : ""}Generated for you. Copy it now: it is shown only here and cannot be read back after ${after}.`
          }
        />
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<ArrowsClockwiseIcon />}
            onClick={() => onChange(generatedSecret(secret.generate))}
          >
            {value.length === 0 ? "Generate" : "Regenerate"}
          </Button>
        </div>
      </div>
    );
  }
  if (isMultilineSecret(secret)) {
    return (
      <MultilineSecretInput label={label} value={value} onChange={onChange} description={help} />
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
