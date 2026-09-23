import type { CatalogSecret } from "@appflare/schema";
import { Button, Input, SensitiveInput } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { generateTemporaryPassword } from "../auth/temporary-password";
import { GENERATED_SECRET_LENGTH } from "../installs/install-input";

/**
 * One field per catalog secret, shared by the install form and the update
 * form. `generate: true` secrets are prefilled once with a random value the
 * admin can copy now (it is shown only here) or regenerate; the others are
 * password fields the admin fills in.
 */

export function generatedSecret(): string {
  return generateTemporaryPassword(GENERATED_SECRET_LENGTH);
}

/** Initial values: generated for `generate: true` secrets, empty otherwise. */
export function initialSecretValues(secrets: readonly CatalogSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.map((s) => [s.name, s.generate ? generatedSecret() : ""]));
}

/** Whether every secret has a value. */
export function secretsComplete(
  secrets: readonly CatalogSecret[],
  values: Readonly<Record<string, string>>,
): boolean {
  return secrets.every((s) => (values[s.name] ?? "").length > 0);
}

export function SecretFields({
  secrets,
  values,
  onChange,
  after,
}: {
  secrets: readonly CatalogSecret[];
  values: Readonly<Record<string, string>>;
  onChange(name: string, value: string): void;
  /** What ends the chance to copy a generated value ("the install", "the update"). */
  after: string;
}) {
  return secrets.map((secret) =>
    secret.generate ? (
      <div key={secret.name} className="grid gap-2">
        <SensitiveInput
          label={`${secret.label} (${secret.name})`}
          value={values[secret.name] ?? ""}
          onValueChange={(value: string) => onChange(secret.name, value)}
          description={`${secret.help ? `${secret.help} ` : ""}Generated for you. Copy it now: it is shown only here and cannot be read back after ${after}.`}
        />
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<ArrowsClockwiseIcon />}
            onClick={() => onChange(secret.name, generatedSecret())}
          >
            Regenerate
          </Button>
        </div>
      </div>
    ) : (
      <Input
        key={secret.name}
        label={`${secret.label} (${secret.name})`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        passwordManagerIgnore
        required
        onChange={(e) => onChange(secret.name, e.currentTarget.value)}
        description={secret.help}
      />
    ),
  );
}
