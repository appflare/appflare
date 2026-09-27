import { renderEntryWorkerPlaceholders, renderPlaceholders } from "@appflare/schema";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Input,
  LayerCard,
  LinkButton,
  SensitiveInput,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ArrowUUpLeftIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  InfoIcon,
  KeyIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { enteredVarFields, missingRequiredVar, varValueProblem } from "../installs/install-vars";
import type { InstallDetail } from "../installs/installs.functions";
import { startReconfigure } from "../installs/reconfigure.functions";
import type { InstallSettings, SettingField } from "../installs/reconfigure.server";
import type { DatabaseSlot, SecretSlot } from "../jobs/reconfigure/plan";
import { connectionsComplete, DatabaseField } from "./database-fields";
import { DocsLink } from "./docs-link";
import { EmailRoutingFields } from "./email-routing-fields";
import { VarField } from "./install-form";
import { useJobStarted } from "./job-started";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import { generatedSecret, MultilineSecretInput } from "./secret-fields";

/**
 * The "Settings" section of `/apps/$installId`: the app's settings (vars),
 * with labels and help from its catalog manifest; its secrets, whose values
 * are never shown, each with "Set new value" (and "Remove" for one the
 * installed version declares optional or no longer declares); for an app that receives email, the
 * zone it receives for. "Save and redeploy" starts the settings change job
 * and opens its log. Members see it read-only; while a job of the app runs,
 * nothing can be saved.
 */
export function AppSettingsSection({
  install,
  settings,
  isAdmin,
}: {
  install: InstallDetail;
  settings: InstallSettings;
  isAdmin: boolean;
}) {
  const jobStarted = useJobStarted();
  const selfDeploying = settings.kind === "self-deploying";
  const busy = install.activeJobId !== null;
  const canEdit = isAdmin && !busy && settings.unavailable === null;

  /** Settings the admin edited in this form; the others show what is stored or their default. */
  const [edited, setEdited] = useState<Record<string, string>>({});
  /** New secret values being entered, by name (a name is present while its field is open). */
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  /** New connection strings being entered, by Hyperdrive binding (present while a field is open). */
  const [newConnections, setNewConnections] = useState<Record<string, string>>({});
  const [zoneId, setZoneId] = useState<string | null>(settings.email?.zoneId ?? null);
  const [movingEmail, setMovingEmail] = useState(false);
  const [emailReady, setEmailReady] = useState(false);
  const [confirmNoPreview, setConfirmNoPreview] = useState(false);
  const [buildConfirmed, setBuildConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultOf = (field: SettingField) =>
    renderEntryWorkerPlaceholders(
      renderPlaceholders(field.shownDefault, settings.placeholders),
      settings.placeholders.entryWorkers ?? {},
    );
  const initialOf = (field: SettingField) => field.stored ?? defaultOf(field);
  const shownOf = (field: SettingField) => edited[field.name] ?? initialOf(field);

  const varsChanged = settings.fields.some((f) => shownOf(f) !== initialOf(f));
  const secretsChanged = Object.keys(newSecrets).length > 0 || removed.size > 0;
  const connectionsChanged = Object.keys(newConnections).length > 0;
  const zoneChanged = movingEmail && zoneId !== null && zoneId !== settings.email?.zoneId;
  const dirty = varsChanged || secretsChanged || connectionsChanged || zoneChanged;
  const invalid =
    settings.fields.some(
      (f) => missingRequiredVar(f, shownOf(f)) || varValueProblem(f, shownOf(f)) !== null,
    ) ||
    Object.values(newSecrets).some((v) => v.length === 0) ||
    !connectionsComplete(
      settings.databases.filter((d) => Object.hasOwn(newConnections, d.binding)),
      newConnections,
    );
  /** Only settings, secrets and connections need a new version (and its checks); moving email does not. */
  const redeploys = varsChanged || secretsChanged || connectionsChanged;
  const ready =
    dirty &&
    !invalid &&
    (!zoneChanged || emailReady) &&
    (!redeploys || settings.skipsPreview === null || confirmNoPreview) &&
    (settings.installer === null || buildConfirmed);

  function discard() {
    setEdited({});
    setNewSecrets({});
    setRemoved(new Set());
    setNewConnections({});
    setZoneId(settings.email?.zoneId ?? null);
    setMovingEmail(false);
    setError(null);
  }

  /**
   * The settings to store: what is stored now for a setting left alone, and
   * for an edited one its value unless it is back at the default (the
   * others follow the default of the version each job deploys). A derived
   * var is never sent: the server keeps it, or computes it from its source.
   */
  function submittedVars(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of enteredVarFields(settings.fields)) {
      const edit = edited[field.name];
      if (edit === undefined || edit === initialOf(field)) {
        if (field.stored !== null) out[field.name] = field.stored;
        continue;
      }
      const value = edit.trim();
      if (value.length > 0 && value !== defaultOf(field).trim()) out[field.name] = value;
    }
    return out;
  }

  async function start(email: { zoneId: string } | null) {
    setPending(true);
    setError(null);
    try {
      const { jobId } = await startReconfigure({
        data: {
          installId: install.id,
          vars: submittedVars(),
          secrets: { set: newSecrets, unset: [...removed] },
          ...(connectionsChanged ? { hyperdrive: newConnections } : {}),
          ...(email === null ? {} : { emailRouting: email }),
          ...(redeploys && settings.skipsPreview !== null ? { confirmNoPreview } : {}),
          ...(settings.installer === null ? {} : { buildConfirmed }),
        },
      });
      await jobStarted(jobId, "Settings change started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the settings.");
      setPending(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !canEdit || pending) return;
    await start(zoneChanged && zoneId !== null ? { zoneId } : null);
  }

  /** A move that stopped before removing the old zone's routes: set up the zone again, remove the rest. */
  const leftover = settings.email?.leftover ?? [];
  const currentZoneId = settings.email?.zoneId ?? null;
  async function finishMove() {
    if (currentZoneId === null || pending) return;
    await start({ zoneId: currentZoneId });
  }

  const nothingToEdit =
    settings.fields.length === 0 &&
    settings.secrets.length === 0 &&
    settings.databases.length === 0 &&
    settings.email === null;

  return (
    <section aria-label="Settings and secrets" className="grid gap-3">
      <LayerCard>
        <LayerCard.Primary className="px-5 py-4">
          <form className="grid gap-6" onSubmit={onSubmit}>
            <Text variant="secondary">
              {selfDeploying
                ? "Save and redeploy runs the app's own installer again at the installed commit, with these settings and secrets. It changes the app in place: there is no snapshot and no rollback."
                : "Save and redeploy uploads the installed version again with these settings and secrets, checks it on a preview where Cloudflare allows it, and only then switches traffic to it. A snapshot is taken first, so undoing the change from the Jobs tab, under Versions, puts the previous settings and secrets back."}{" "}
              <DocsLink
                topic={selfDeploying ? "settingsChangeBuilt" : "settingsChange"}
                variant="inline"
              />
            </Text>
            {!isAdmin && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title="Only admins can change settings."
              />
            )}
            {isAdmin && busy && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title="A job of this app is running"
                description="Settings can be saved once it has finished."
                action={
                  <LinkButton
                    href={`/jobs/${install.activeJobId}`}
                    variant="secondary"
                    icon={<ArrowRightIcon />}
                  >
                    View log
                  </LinkButton>
                }
              />
            )}
            {isAdmin && !busy && settings.unavailable !== null && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title={settings.unavailable}
              />
            )}
            {nothingToEdit && (
              <Text variant="secondary">This app has no settings or secrets to change.</Text>
            )}

            <fieldset disabled={!canEdit || pending} className="grid gap-6">
              {settings.fields.length > 0 && (
                <Group
                  title="Variables"
                  description={
                    selfDeploying
                      ? "Handed to the app's installer as environment variables. A variable left at its default follows the default of each version."
                      : "Variables on the app's Worker. A variable left at its default follows the default of each version. Variables marked JSON take a JSON value."
                  }
                >
                  {settings.fields.map((field) => (
                    <VarField
                      key={field.name}
                      field={field}
                      value={shownOf(field)}
                      when="when the app is deployed"
                      onChange={(value) => setEdited((s) => ({ ...s, [field.name]: value }))}
                    />
                  ))}
                </Group>
              )}

              {settings.secrets.length > 0 && (
                <Group
                  title="Secrets"
                  description={
                    selfDeploying
                      ? "Stored encrypted on your sandbox Worker for the app's installer, which sets them on the app's Workers. Values are never shown; a new value replaces the current one."
                      : "Stored encrypted on the app's Worker. Values are never shown; a new value replaces the current one when the new version takes over."
                  }
                >
                  <div className="grid gap-4">
                    {settings.secrets.map((slot) => (
                      <SecretRow
                        key={slot.name}
                        slot={slot}
                        value={newSecrets[slot.name]}
                        removed={removed.has(slot.name)}
                        canRemove={settings.canRemoveSecrets && slot.optional && slot.present}
                        disabled={!canEdit || pending}
                        onValueChange={(value) =>
                          setNewSecrets((s) => {
                            if (value === undefined) {
                              const { [slot.name]: _dropped, ...rest } = s;
                              return rest;
                            }
                            return { ...s, [slot.name]: value };
                          })
                        }
                        onRemovedChange={(remove) =>
                          setRemoved((s) => {
                            const next = new Set(s);
                            if (remove) next.add(slot.name);
                            else next.delete(slot.name);
                            return next;
                          })
                        }
                      />
                    ))}
                  </div>
                </Group>
              )}

              {settings.databases.length > 0 && (
                <Group
                  title="Databases"
                  description="Reached through Cloudflare Hyperdrive. Connection strings are never stored, so they are never shown. A new one gets a new Hyperdrive configuration, which the new version binds. The old configuration is kept until the next update or settings change, so undoing this change from Versions still reaches the old database."
                >
                  <div className="grid gap-4">
                    {settings.databases.map((db) => (
                      <DatabaseRow
                        key={db.binding}
                        slot={db}
                        value={newConnections[db.binding]}
                        disabled={!canEdit || pending}
                        onValueChange={(value) =>
                          setNewConnections((s) => {
                            if (value === undefined) {
                              const { [db.binding]: _dropped, ...rest } = s;
                              return rest;
                            }
                            return { ...s, [db.binding]: value };
                          })
                        }
                      />
                    ))}
                  </div>
                </Group>
              )}

              {settings.email !== null && (
                <Group
                  title="Email"
                  description={
                    settings.email.zoneName === null
                      ? "The app receives email through Cloudflare Email Routing; Appflare has no record of its zone."
                      : `The app receives email for ${settings.email.zoneName} through Cloudflare Email Routing.`
                  }
                >
                  {leftover.length > 0 && (
                    <Banner
                      variant="alert"
                      icon={<WarningIcon weight="fill" />}
                      title="Moving email did not finish"
                      description={`Routing rules the app no longer needs are still set up on ${leftover.join(", ")}. Finishing the move checks ${settings.email.zoneName ?? "the new zone"} again and removes them; the Worker is not deployed again.`}
                      action={
                        canEdit ? (
                          <Button
                            type="button"
                            variant="secondary"
                            icon={<ArrowsClockwiseIcon />}
                            loading={pending}
                            disabled={dirty}
                            onClick={finishMove}
                          >
                            Finish moving email
                          </Button>
                        ) : undefined
                      }
                    />
                  )}
                  {movingEmail && canEdit ? (
                    <div className="grid gap-4">
                      <EmailRoutingFields
                        slug={settings.slug}
                        workerName={install.workerName}
                        disabled={!canEdit || pending}
                        zoneId={zoneId}
                        onZoneChange={setZoneId}
                        onReadyChange={setEmailReady}
                      />
                      <Text variant="secondary" size="sm">
                        Saving sets up the routes on the new zone first, then removes the ones on
                        the current zone the way an uninstall does. Routing rules name the Worker,
                        so moving email alone does not deploy it again, and a rollback does not move
                        email back.
                      </Text>
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon={<ArrowUUpLeftIcon />}
                          onClick={() => {
                            setMovingEmail(false);
                            setZoneId(settings.email?.zoneId ?? null);
                          }}
                        >
                          Keep the current zone
                        </Button>
                      </div>
                    </div>
                  ) : (
                    canEdit && (
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon={<EnvelopeSimpleIcon />}
                          onClick={() => {
                            // The admin picks the new zone; the current one is not a choice.
                            setZoneId(null);
                            setMovingEmail(true);
                          }}
                        >
                          Receive email for another zone
                        </Button>
                      </div>
                    )
                  )}
                </Group>
              )}

              {canEdit && redeploys && settings.skipsPreview !== null && (
                <div className="grid gap-3">
                  <Banner
                    variant="alert"
                    icon={<WarningIcon weight="fill" />}
                    title="No preview check for this change"
                    description={`${settings.skipsPreview}.`}
                  />
                  <Checkbox
                    checked={confirmNoPreview}
                    onCheckedChange={(checked: boolean) => setConfirmNoPreview(checked)}
                    label="Save without checking the new settings first"
                  />
                </div>
              )}
              {canEdit && dirty && settings.installer !== null && (
                <SandboxBuildConfirmation
                  build={settings.installer}
                  checked={buildConfirmed}
                  onChange={setBuildConfirmed}
                  action="settings change"
                  kind="installer"
                />
              )}
            </fieldset>

            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            {canEdit && !nothingToEdit && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!dirty || pending}
                  onClick={discard}
                >
                  Discard changes
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  icon={<ArrowsClockwiseIcon />}
                  loading={pending}
                  disabled={!ready}
                >
                  Save and redeploy
                </Button>
              </div>
            )}
          </form>
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
}

/** A titled group of fields, its title and note set closer together than the fields. */
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text bold>{title}</Text>
        <Text variant="secondary" size="sm">
          {description}
        </Text>
      </div>
      {children}
    </div>
  );
}

/**
 * One database: its label and the Hyperdrive configuration the Worker binds,
 * and "Replace connection string", which opens a field for a new one. The
 * current string is never stored, so it is never shown.
 */
function DatabaseRow({
  slot,
  value,
  disabled,
  onValueChange,
}: {
  slot: DatabaseSlot;
  /** The new connection string being entered; undefined while the field is closed. */
  value: string | undefined;
  disabled: boolean;
  onValueChange(value: string | undefined): void;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Text bold>{slot.fieldLabel}</Text>
          {slot.configName === null ? (
            <Badge variant="warning">No configuration recorded</Badge>
          ) : (
            <Badge variant="outline">{slot.configName}</Badge>
          )}
        </div>
        {slot.configName !== null &&
          (value === undefined ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<DatabaseIcon />}
              disabled={disabled}
              onClick={() => onValueChange("")}
            >
              Replace connection string
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<ArrowUUpLeftIcon />}
              disabled={disabled}
              onClick={() => onValueChange(undefined)}
            >
              Keep current connection
            </Button>
          ))}
      </div>
      {value !== undefined && (
        <DatabaseField
          decl={slot}
          label={`New connection string for ${slot.binding}`}
          value={value}
          onChange={(next) => onValueChange(next)}
        />
      )}
    </div>
  );
}

/**
 * One secret: its label and whether the Worker has it, "Set new value"
 * (which opens a field; a generated secret starts with a fresh random value
 * shown only here), and for a secret the version does not need (declared
 * optional, or no longer declared), "Remove". The current value is never read
 * or shown.
 */
function SecretRow({
  slot,
  value,
  removed,
  canRemove,
  disabled,
  onValueChange,
  onRemovedChange,
}: {
  slot: SecretSlot;
  /** The new value being entered; undefined while the field is closed. */
  value: string | undefined;
  removed: boolean;
  canRemove: boolean;
  disabled: boolean;
  onValueChange(value: string | undefined): void;
  onRemovedChange(removed: boolean): void;
}) {
  const label = slot.label === slot.name ? slot.name : `${slot.label} (${slot.name})`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Text bold>{label}</Text>
          {slot.declared && slot.optional && <Badge variant="outline">Optional</Badge>}
          {!slot.present && <Badge variant={slot.optional ? "outline" : "warning"}>Not set</Badge>}
          {!slot.declared && <Badge variant="outline">Not used by this version</Badge>}
          {removed && <Badge variant="red">Will be removed</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {value === undefined && !removed && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<KeyIcon />}
              disabled={disabled}
              onClick={() => onValueChange(slot.generate ? generatedSecret(slot.generate) : "")}
            >
              Set new value
            </Button>
          )}
          {value !== undefined && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<ArrowUUpLeftIcon />}
              disabled={disabled}
              onClick={() => onValueChange(undefined)}
            >
              Keep current value
            </Button>
          )}
          {canRemove && value === undefined && (
            <Button
              type="button"
              variant={removed ? "secondary" : "secondary-destructive"}
              size="sm"
              icon={removed ? <ArrowUUpLeftIcon /> : <TrashIcon />}
              disabled={disabled}
              onClick={() => onRemovedChange(!removed)}
            >
              {removed ? "Keep" : "Remove"}
            </Button>
          )}
        </div>
      </div>
      {slot.help !== undefined && (
        <Text variant="secondary" size="sm">
          {slot.help}
        </Text>
      )}
      {(slot.derives !== undefined || slot.derivesVars !== undefined) && (
        <Text variant="secondary" size="sm">
          A new value also replaces{" "}
          {[...(slot.derives ?? []), ...(slot.derivesVars ?? [])].join(" and ")}, which Appflare
          computes from it.
        </Text>
      )}
      {value !== undefined &&
        (slot.generate ? (
          <div className="grid gap-2">
            <SensitiveInput
              label={`New value of ${slot.name}`}
              value={value}
              onValueChange={(next: string) => onValueChange(next)}
              description="Generated for you. Copy it now: it is shown only here and cannot be read back after it is saved."
            />
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<ArrowsClockwiseIcon />}
                disabled={disabled}
                onClick={() => onValueChange(generatedSecret(slot.generate))}
              >
                Regenerate
              </Button>
            </div>
          </div>
        ) : slot.multiline === true ? (
          <MultilineSecretInput
            label={`New value of ${slot.name}`}
            value={value}
            disabled={disabled}
            onChange={(next) => onValueChange(next)}
            description="The current value stays until the new one is saved."
          />
        ) : (
          <Input
            label={`New value of ${slot.name}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            passwordManagerIgnore
            required
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
            description="The current value stays until the new one is saved."
          />
        ))}
    </div>
  );
}
