import type { CatalogManifest } from "@appflare/schema";
import { Banner, Button, Checkbox, Input, LayerCard, SensitiveInput, Text } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  DownloadSimpleIcon,
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { generateTemporaryPassword } from "../auth/temporary-password";
import {
  GENERATED_SECRET_LENGTH,
  INSTANCE_NAME_MAX_LENGTH,
  WORKER_NAME_HINT,
  WORKER_NAME_MAX_LENGTH,
  WORKER_NAME_PATTERN,
} from "../installs/install-input";
import { startInstall } from "../installs/installs.functions";

function generated(): string {
  return generateTemporaryPassword(GENERATED_SECRET_LENGTH);
}

/**
 * The install form of `/catalog/$slug`, generated from
 * the signed catalog manifest: the Worker name, the install's label, one field
 * per secret and var, and the Workers Paid confirmation. `generate: true`
 * secrets are prefilled with a random value the admin can copy now; it is
 * shown only here. Members see the form disabled.
 */
export function InstallForm({
  catalog,
  canInstall,
  defaultWorkerName,
  fixedWorkerName,
  blockedReason,
}: {
  catalog: CatalogManifest;
  canInstall: boolean;
  /** The catalog's Worker name, or the next free `<name>-N` when it is taken. */
  defaultWorkerName: string;
  /** The app only works under its catalog Worker name; the field is read-only. */
  fixedWorkerName: boolean;
  /** Why the install is not possible right now (for example, already installed). */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [workerName, setWorkerName] = useState(defaultWorkerName);
  /** Null while the label follows the Worker name. */
  const [label, setLabel] = useState<string | null>(null);
  const instanceName = label ?? workerName;
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    Object.fromEntries(catalog.secrets.map((s) => [s.name, s.generate ? generated() : ""])),
  );
  const [vars, setVars] = useState<Record<string, string>>(() =>
    Object.fromEntries(catalog.vars.map((v) => [v.name, v.default ?? ""])),
  );
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = WORKER_NAME_PATTERN.test(workerName);
  const labelValid =
    instanceName.trim().length > 0 && instanceName.trim().length <= INSTANCE_NAME_MAX_LENGTH;
  const disabled = !canInstall || blockedReason !== null || pending;
  const missing =
    catalog.secrets.some((s) => (secrets[s.name] ?? "").length === 0) ||
    catalog.vars.some((v) => v.required && (vars[v.name] ?? "").trim().length === 0);
  const ready = nameValid && labelValid && !missing && (catalog.plan !== "paid" || paidConfirmed);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || disabled) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startInstall({
        data: {
          slug: catalog.slug,
          workerName,
          instanceName: instanceName.trim(),
          secrets,
          vars,
          paidConfirmed,
        },
      });
      await router.navigate({ to: "/jobs/$jobId", params: { jobId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the install.");
      setPending(false);
    }
  }

  return (
    <LayerCard>
      <LayerCard.Secondary>Install {catalog.name}</LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <form className="grid gap-6" onSubmit={onSubmit}>
          {!canInstall && (
            <Banner
              variant="secondary"
              icon={<InfoIcon weight="fill" />}
              title="Only admins can install apps."
            />
          )}
          {blockedReason !== null && (
            <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title={blockedReason} />
          )}
          <fieldset disabled={disabled} className="grid gap-6">
            <Input
              label="Worker name"
              value={workerName}
              onChange={(e) => setWorkerName(e.currentTarget.value.trim())}
              readOnly={fixedWorkerName}
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={WORKER_NAME_MAX_LENGTH}
              error={nameValid ? undefined : `Use ${WORKER_NAME_HINT}`}
              description={
                fixedWorkerName
                  ? `${catalog.name} only works as the Worker "${workerName}", so it installs once per account.`
                  : `The app is served at https://${workerName || "<name>"}.<your subdomain>.workers.dev. Resources are named after it. Each install of an app needs its own Worker name.`
              }
            />
            <Input
              label="Name"
              value={instanceName}
              onChange={(e) => setLabel(e.currentTarget.value)}
              autoComplete="off"
              required
              maxLength={INSTANCE_NAME_MAX_LENGTH}
              error={labelValid ? undefined : `Use 1 to ${INSTANCE_NAME_MAX_LENGTH} characters.`}
              description="How this install is listed in Appflare. Defaults to the Worker name."
            />

            {catalog.secrets.length > 0 && (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Text bold>Secrets</Text>
                  <Text variant="secondary" size="sm">
                    Stored as encrypted secrets on the app's Worker. Appflare keeps only their
                    names.
                  </Text>
                </div>
                {catalog.secrets.map((secret) =>
                  secret.generate ? (
                    <div key={secret.name} className="grid gap-2">
                      <SensitiveInput
                        label={`${secret.label} (${secret.name})`}
                        value={secrets[secret.name] ?? ""}
                        onValueChange={(value: string) =>
                          setSecrets((s) => ({ ...s, [secret.name]: value }))
                        }
                        description={`${secret.help ? `${secret.help} ` : ""}Generated for you. Copy it now: it is shown only here and cannot be read back after the install.`}
                      />
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon={<ArrowsClockwiseIcon />}
                          onClick={() => setSecrets((s) => ({ ...s, [secret.name]: generated() }))}
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
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setSecrets((s) => ({ ...s, [secret.name]: value }));
                      }}
                      description={secret.help}
                    />
                  ),
                )}
              </div>
            )}

            {catalog.vars.length > 0 && (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Text bold>Settings</Text>
                  <Text variant="secondary" size="sm">
                    Plain-text variables on the app's Worker.
                  </Text>
                </div>
                {catalog.vars.map((v) => (
                  <Input
                    key={v.name}
                    label={`${v.label} (${v.name})`}
                    value={vars[v.name] ?? ""}
                    required={v.required}
                    autoComplete="off"
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setVars((s) => ({ ...s, [v.name]: value }));
                    }}
                    description={v.help}
                  />
                ))}
              </div>
            )}

            {catalog.plan === "paid" && (
              <Checkbox
                label="This account is on Workers Paid"
                checked={paidConfirmed}
                onCheckedChange={(checked: boolean) => setPaidConfirmed(checked)}
              />
            )}
          </fieldset>

          {error !== null && (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              icon={<DownloadSimpleIcon />}
              loading={pending}
              disabled={disabled || !ready}
            >
              Install
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}
