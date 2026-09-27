import { databaseProtocolName } from "@appflare/schema";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Input,
  Label,
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
import { AppTokenHelp } from "./app-token-permissions";
import { connectionsComplete, DatabaseField } from "./database-fields";
import { DocsLink } from "./docs-link";
import { EmailRoutingFields } from "./email-routing-fields";
import {
  FieldHelp,
  FieldLabel,
  TechnicalNamesProvider,
  TechnicalNamesSwitch,
  useTechnicalNames,
} from "./field-label";
import { useJobStarted } from "./job-started";
import { placeholderOptions } from "./placeholder-chips";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import { generatedSecret, MultilineSecretInput } from "./secret-fields";
import { type PlaceholderChips, VarField } from "./var-field";

/** The one notice at the top of the settings form, or null when an admin can save. */
export function settingsNotice(
  isAdmin: boolean,
  busy: boolean,
  unavailable: string | null,
): "members" | "busy" | "unavailable" | null {
  if (!isAdmin) return "members";
  if (busy) return "busy";
  if (unavailable !== null) return "unavailable";
  return null;
}

/**
 * The "Settings" section of `/apps/$installId`: the app's settings (vars),
 * with labels and help from its catalog manifest (the names the app reads
 * show on hover and with "Show technical names"; placeholders as chips); its
 * secrets, whose values are never shown, each with "Set new value" (and
 * "Remove" for one the installed version declares optional or no longer
 * declares; the secret that takes the app's own Cloudflare token says how to
 * create one next to its new value); for an app that receives email, the
 * zone it receives for. "Save and redeploy" starts the settings change job
 * and opens its log. Members see it read-only; while a job of the app runs,
 * nothing can be saved. At most one notice sits at the top.
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

  const [showNames, setShowNames] = useState(false);
  // Placeholders stay in the fields as chips; each deploy fills them in.
  const chips: PlaceholderChips = {
    options: placeholderOptions({
      // Offered where the app has a wildcard domain, or a default already uses it.
      wildcard:
        settings.placeholders.wildcardHostname !== null ||
        settings.fields.some((f) => /\{\{\s*wildcardHostname\s*\}\}/.test(f.shownDefault)),
      workers: Object.keys(settings.placeholders.entryWorkers ?? {}),
    }),
    known: settings.placeholders,
  };
  const defaultOf = (field: SettingField) => field.shownDefault;
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
  const notice = settingsNotice(isAdmin, busy, settings.unavailable);

  return (
    <section aria-label="Settings and secrets" className="grid gap-3">
      <LayerCard>
        <LayerCard.Primary className="px-5 py-4">
          <form className="grid gap-6" onSubmit={onSubmit}>
            {notice === "members" && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title="Only admins can change settings."
              />
            )}
            {notice === "busy" && (
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
            {notice === "unavailable" && settings.unavailable !== null && (
              <Banner
                variant="secondary"
                icon={<InfoIcon weight="fill" />}
                title={settings.unavailable}
              />
            )}
            {nothingToEdit ? (
              <Text variant="secondary">This app has no settings or secrets to change.</Text>
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <Text variant="secondary" size="sm">
                  <FieldHelp
                    text={
                      selfDeploying
                        ? "Saving runs the app's own installer again with these values. It changes the app in place: there is no snapshot and no undo."
                        : "Saving deploys the app again with these values, after checking them on a preview where Cloudflare allows it. You can undo it from Versions on the Jobs tab."
                    }
                    after={
                      <DocsLink
                        topic={selfDeploying ? "settingsChangeBuilt" : "settingsChange"}
                        variant="inline"
                      />
                    }
                  />
                </Text>
                <TechnicalNamesSwitch checked={showNames} onChange={setShowNames} />
              </div>
            )}

            <TechnicalNamesProvider value={showNames}>
              <fieldset disabled={!canEdit || pending} className="grid gap-6">
                {settings.fields.length > 0 && (
                  <Group
                    title="Settings"
                    description={
                      selfDeploying
                        ? "Handed to the app's installer. One left at its default follows the default of each new version."
                        : "One left at its default follows the default of each new version."
                    }
                  >
                    {settings.fields.map((field) => (
                      <VarField
                        key={field.name}
                        field={field}
                        value={shownOf(field)}
                        when="when the app is deployed"
                        chips={chips}
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
                        ? "Kept encrypted for the app's installer. Values are never shown; a new value replaces the current one."
                        : "Kept encrypted on the app. Values are never shown; a new value replaces the current one."
                    }
                  >
                    <div className="grid gap-4">
                      {settings.secrets.map((slot) => (
                        <SecretRow
                          key={slot.name}
                          tokenHelp={
                            settings.appToken?.secret === slot.name ? (
                              <AppTokenHelp
                                appName={install.name}
                                permissions={settings.appToken.permissions}
                              />
                            ) : undefined
                          }
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

                {settings.appToken !== null && settings.appToken.secret === null && (
                  <Group
                    title={`Cloudflare token for ${install.name}`}
                    description={`${install.name} uses a Cloudflare API token of its own, which you give it in its own setup steps. Create one, or a new one, here.`}
                  >
                    <AppTokenHelp
                      appName={install.name}
                      permissions={settings.appToken.permissions}
                    />
                  </Group>
                )}

                {settings.databases.length > 0 && (
                  <Group
                    title="Databases"
                    description="Connection strings are never stored, so they are never shown. A new one gets a new Hyperdrive configuration, which the new version binds. The old configuration is kept until the next update or settings change, so undoing this change from Versions still reaches the old database."
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
                          so moving email alone does not deploy it again, and a rollback does not
                          move email back.
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
            </TechnicalNamesProvider>

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
          <FieldHelp text={description} />
        </Text>
      </div>
      {children}
    </div>
  );
}

/** "A", "A and B", "A, B and C". */
function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A short visible label ("New value") whose accessible name also says what it
 * is for ("New value for Analytics API token"): the rows above it show that
 * already, but a screen reader lands on the field alone.
 */
function ShortLabel({ text, of }: { text: string; of: string }) {
  return (
    <>
      {text}
      <span className="sr-only"> for {of}</span>
    </>
  );
}

/** A database's label for people: the catalog's, else what kind of connection string it takes. */
function databaseLabel(slot: Pick<DatabaseSlot, "label" | "protocol">): string {
  return slot.label ?? `${databaseProtocolName(slot.protocol)} connection string`;
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
  const showNames = useTechnicalNames();
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Text bold>
            <FieldLabel label={databaseLabel(slot)} name={slot.binding} />
          </Text>
          {slot.configName === null ? (
            <Badge variant="warning">No configuration recorded</Badge>
          ) : (
            // The Hyperdrive configuration's name is technical detail.
            showNames && <Badge variant="outline">{slot.configName}</Badge>
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
          label={<ShortLabel text="New connection string" of={databaseLabel(slot)} />}
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
  tokenHelp,
}: {
  slot: SecretSlot;
  /** The new value being entered; undefined while the field is closed. */
  value: string | undefined;
  removed: boolean;
  canRemove: boolean;
  disabled: boolean;
  onValueChange(value: string | undefined): void;
  onRemovedChange(removed: boolean): void;
  /** For the secret that takes the app's Cloudflare token: how to create one, under its new value. */
  tokenHelp?: ReactNode;
}) {
  const derivedNote =
    slot.derivesLabels === undefined
      ? undefined
      : `A new value also updates ${listInWords(slot.derivesLabels)}, which Appflare works out from it.`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label showOptional={slot.declared && slot.optional}>
            <FieldLabel label={slot.label} name={slot.name} />
          </Label>
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
      {(slot.help !== undefined || derivedNote !== undefined) && (
        <Text variant="secondary" size="sm">
          <FieldHelp text={slot.help ?? ""} after={derivedNote} />
        </Text>
      )}
      {value !== undefined &&
        (slot.generate ? (
          <div className="grid gap-2">
            <SensitiveInput
              label={<ShortLabel text="New value" of={slot.label} />}
              value={value}
              onValueChange={(next: string) => onValueChange(next)}
              description="Generated for you. Copy it now if you need it: it cannot be shown again once saved."
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
            label={<ShortLabel text="New value" of={slot.label} />}
            value={value}
            disabled={disabled}
            onChange={(next) => onValueChange(next)}
            description="The current value stays until the new one is saved."
          />
        ) : (
          <Input
            label={<ShortLabel text="New value" of={slot.label} />}
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
      {value !== undefined && tokenHelp}
    </div>
  );
}
