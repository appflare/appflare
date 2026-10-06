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
  secretKey,
} from "@appflare/schema";
import { Badge, Button, Input, InputArea, Label, SensitiveInput } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { GENERATED_SECRET_LENGTH } from "../installs/install-input";
import { FieldLabel, fieldDescription } from "./field-label";
import { Tooltip } from "./tooltip";

/**
 * One field per catalog secret, shared by the install form and the update
 * form. Each is labelled with the catalog's label; the secret's name shows on
 * hover or with the form's "Show technical names" (./field-label.tsx), and
 * long help folds behind "More", and the catalog's `link` (where to get the
 * value) follows it. Generated secrets (`generate`) are
 * prefilled once with a fresh value the
 * admin can copy now (it is shown only here) or regenerate; a multi-line one
 * (`multiline`) is a text area that keeps its line breaks; the others are
 * password fields the admin fills in. Every field is one label, one control
 * and one line of help under it.
 *
 * An optional secret (`optional: true`) is the same single field, marked
 * "(optional)": left empty, it is not set. Values are keyed by the secret's
 * key (`secretKey`: its name unless the catalog gives it a key of its own,
 * for two secrets of one name that go to different Workers), and an optional
 * secret has no entry while its field is empty, so the form
 * sends nothing for it (the server would skip an empty value as well). An
 * optional generated secret starts empty, with a Generate button. A derived secret (the
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
 * `generate: "password"`, a new VAPID private key for `"vapid-private-key"`, 32
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
        secretKey(s),
        s.generate && !held.includes(secretKey(s)) ? generatedSecret(s.generate) : "",
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
    const value = values[secretKey(s)];
    return isOptionalSecret(s) && value === undefined ? true : (value ?? "").length > 0;
  });
}

export function SecretFields({
  secrets,
  only,
  vars = [],
  held = [],
  values,
  onChange,
  after,
  fieldExtras = {},
  disabled = false,
}: {
  secrets: readonly CatalogSecret[];
  /**
   * The keys of the secrets to show, for a form that shows them in groups;
   * every secret the admin enters when left out. `secrets` stays the whole
   * list, which says what is derived from what.
   */
  only?: readonly string[];
  /** Secrets the Worker already has (by key), asked for again by an update; their fields start empty. */
  held?: readonly string[];
  /** The catalog's vars, for the vars derived from a secret. */
  vars?: readonly (Pick<CatalogVar, "name" | "derive"> & { label?: string })[];
  values: Readonly<Record<string, string | undefined>>;
  /** A new value, by the secret's key; undefined leaves an optional secret unset. */
  onChange(key: string, value: string | undefined): void;
  /** What ends the chance to copy a generated value ("the install", "the update"). */
  after: string;
  /**
   * Shown right under a secret's field, by the secret's key: how to create the
   * Cloudflare token the app takes in that secret.
   */
  fieldExtras?: Readonly<Record<string, ReactNode>>;
  /** While the form is being sent: nothing can be changed. */
  disabled?: boolean;
}) {
  return enteredSecrets(secrets)
    .filter((secret) => only === undefined || only.includes(secretKey(secret)))
    .map((secret) => {
      const key = secretKey(secret);
      const value = values[key];
      const derived = derivedNote(secrets, key, vars);
      const isHeld = held.includes(key);
      const optional = isOptionalSecret(secret);
      return (
        <div key={key} className="grid gap-3">
          <SecretField
            secret={secret}
            value={value ?? ""}
            // An optional secret whose field is emptied is left unset.
            onChange={(next) => onChange(key, optional && next.length === 0 ? undefined : next)}
            after={after}
            optional={optional}
            disabled={disabled}
            note={
              [
                derived,
                isHeld ? heldSecretNote(secret) : undefined,
                isSeedOnly(secret) ? SEED_ONLY_SECRET_NOTE : undefined,
              ]
                .filter((t) => t !== undefined)
                .join(" ") || undefined
            }
          />
          {fieldExtras[key]}
        </div>
      );
    });
}

/**
 * What the field of the secret keyed `key` says about the secrets and vars
 * derived from it (by label where the catalog gives one), or undefined when
 * none is.
 */
export function derivedNote(
  secrets: readonly CatalogSecret[],
  key: string,
  vars: readonly (Pick<CatalogVar, "name" | "derive"> & { label?: string })[] = [],
): string | undefined {
  const derived = [
    ...secrets.filter((s) => isDerivedSecret(s) && s.derive?.from === key),
    ...vars.filter((v) => v.derive?.from === key),
  ];
  if (derived.length === 0) return undefined;
  return `Appflare also sets ${derived.map((s) => s.label ?? s.name).join(" and ")} from it.`;
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
  required = true,
}: {
  label: ReactNode;
  value: string;
  onChange(value: string): void;
  /** Help before the note that the value is hidden once saved. */
  description?: ReactNode;
  disabled?: boolean;
  /** False marks the field "(optional)". */
  required?: boolean;
}) {
  return (
    <InputArea
      label={label}
      value={value}
      required={required}
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
      description={
        description === undefined || description === null ? (
          MULTILINE_SECRET_NOTE
        ) : (
          <>
            {description} {MULTILINE_SECRET_NOTE}
          </>
        )
      }
    />
  );
}

/** What the field of a multi-line secret says after its help. */
export const MULTILINE_SECRET_NOTE = "Paste it with its line breaks. It is hidden once saved.";

/** The value field of one secret: generated (copy now, regenerate), multi-line, or a password field. */
function SecretField({
  secret,
  value,
  onChange,
  after,
  optional = false,
  note,
  disabled = false,
}: {
  secret: CatalogSecret;
  value: string;
  onChange(value: string): void;
  after: string;
  /** Marked "(optional)"; empty means not set. */
  optional?: boolean;
  disabled?: boolean;
  /** A sentence after the help, such as which secrets are derived from this one. */
  note?: string | undefined;
}) {
  // Its state beside the label: filled in for the admin, and used once and not kept.
  const badges = [
    ...(secret.generate && value.length > 0 ? ["Generated"] : []),
    ...(isSeedOnly(secret) ? ["Used once"] : []),
  ];
  const label = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <FieldLabel label={secret.label} name={secret.name} />
      {badges.map((badge) => (
        <Badge key={badge} variant="secondary">
          {badge}
        </Badge>
      ))}
    </span>
  );
  const generatedNote =
    !secret.generate || value.length === 0
      ? undefined
      : isSeedOnly(secret)
        ? "The install's page shows it once more."
        : `Copy it now if you need it: it cannot be shown again after ${after}.`;
  const notes = [note, generatedNote].filter((t) => t !== undefined).join(" ") || undefined;
  // The help, its note and the catalog's link (where to get the value), one paragraph.
  const help = fieldDescription({
    help: secret.help,
    note: notes,
    link: secret.link,
    optional,
  });
  if (secret.generate) {
    return (
      <GeneratedSecretField
        secret={secret}
        value={value}
        onChange={onChange}
        optional={optional}
        help={help}
        disabled={disabled}
        regenerate={() => {
          if (!disabled) onChange(generatedSecret(secret.generate));
        }}
      />
    );
  }
  if (isMultilineSecret(secret)) {
    return (
      <MultilineSecretInput
        label={label}
        value={value}
        onChange={onChange}
        description={help}
        required={!optional}
        disabled={disabled}
      />
    );
  }
  return (
    <Input
      label={label}
      type="password"
      autoComplete="off"
      spellCheck={false}
      passwordManagerIgnore
      required={!optional}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      description={help}
    />
  );
}

/**
 * A generated secret's field, laid out as Kumo's Field lays one out (label,
 * control, help), with its label row built here so the "Generated" badge
 * and the refresh button inside it sit beside the label, not inside it: a
 * button inside a `<label>` would take the label's clicks.
 */
function GeneratedSecretField({
  secret,
  value,
  onChange,
  optional,
  help,
  regenerate,
  disabled = false,
}: {
  secret: CatalogSecret;
  value: string;
  onChange(value: string): void;
  optional: boolean;
  help: ReactNode;
  regenerate(): void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const helpId = useId();
  return (
    <div data-generated-field="" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Label htmlFor={inputId} showOptional={optional}>
          <FieldLabel label={secret.label} name={secret.name} />
        </Label>
        {value.length > 0 ? (
          <GeneratedBadge fieldLabel={secret.label} onRegenerate={regenerate} />
        ) : (
          // An optional generated secret starts empty: generating it is the way to set one.
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon={<ArrowsClockwiseIcon />}
            onClick={regenerate}
            disabled={disabled}
          >
            Generate
          </Button>
        )}
        {isSeedOnly(secret) && <Badge variant="secondary">Used once</Badge>}
      </div>
      <SensitiveInput
        id={inputId}
        aria-describedby={help === undefined ? undefined : helpId}
        value={value}
        required={!optional}
        disabled={disabled}
        onValueChange={(next: string) => onChange(next)}
      />
      {help !== undefined && (
        <p id={helpId} className="m-0 text-kumo-subtle text-sm leading-snug">
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * "Generated", with a thin divider and a small refresh button inside the
 * badge: making a new value is a niche need, so it is quiet. The button's
 * Kumo tooltip says "Regenerate"; its name says which field.
 */
export function GeneratedBadge({
  fieldLabel,
  onRegenerate,
}: {
  fieldLabel: string;
  onRegenerate(): void;
}) {
  return (
    // Kumo's Badge takes no data attributes; the wrapper marks it for tests and styles.
    <span data-secret-badge="Generated" className="inline-flex">
      <Badge variant="secondary" className="gap-0 py-0 pr-0.5">
        <span className="py-0.5">Generated</span>
        <span aria-hidden className="mx-1.5 h-3 w-px bg-current opacity-25" />
        <Tooltip
          content="Regenerate"
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              shape="circle"
              aria-label={`Regenerate ${fieldLabel}`}
              icon={<ArrowsClockwiseIcon />}
              onClick={onRegenerate}
              className="size-5 text-current"
            />
          }
        />
      </Badge>
    </span>
  );
}
