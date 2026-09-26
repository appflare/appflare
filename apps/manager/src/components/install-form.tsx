import {
  type CatalogManifest,
  entryPlaceholderValues,
  hasPlaceholder,
  type IndexBuild,
  renderEntryWorkerPlaceholders,
  renderPlaceholders,
} from "@appflare/schema";
import {
  Banner,
  Button,
  Input,
  InputArea,
  InputGroup,
  LayerCard,
  Link,
  Radio,
  Select,
  Text,
} from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useState } from "react";
import type { AccountPlan } from "../account/plan";
import { DISPLAY_NAME_MAX_LENGTH, displayNameProblem } from "../installs/display-name";
import {
  type InstallDomainInput,
  WORKER_NAME_HINT,
  WORKER_NAME_MAX_LENGTH,
  WORKER_NAME_PATTERN,
} from "../installs/install-input";
import {
  type InstallVarField,
  MAX_CARD_OPTIONS,
  missingRequiredVar,
  varValueProblem,
} from "../installs/install-vars";
import { startInstall } from "../installs/installs.functions";
import { workersDevUrl } from "../installs/post-install";
import { installSourceBuild } from "../installs/source-builds.functions";
import { CronTriggersField } from "./cron-triggers-field";
import { EmailRoutingFields } from "./email-routing-fields";
import { InstallDomainFields } from "./install-domain-fields";
import { useJobStarted } from "./job-started";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import {
  initialSecretValues,
  SecretFields,
  secretsComplete,
  withSecretValue,
} from "./secret-fields";
import { tooltipContent } from "./tooltip";
import {
  WorkersPaidConfirmation,
  type WorkersPaidConfirmationState,
} from "./workers-paid-confirmation";

/**
 * The install form of `/catalog/$slug`, generated from
 * the signed catalog manifest: the Worker name, the install's optional display
 * name, one field
 * per secret and var, and the Workers Paid confirmation. The confirmation of
 * the app's account requirements is a checkbox in the page's prerequisites
 * callout; it arrives here as `requirementsConfirmed`. `generate: true`
 * secrets are prefilled with a random value the admin can copy now; it is
 * shown only here. Optional secrets stay unset unless the admin turns on
 * "Set now". An app that receives email (`install.emailRouting`) also
 * asks for a zone and previews what the install sets up there. An app with
 * cron triggers says how many it uses against the free plan's 5 per account;
 * if it does not need Workers Paid itself, the Workers Paid confirmation is
 * offered as optional and skips the job's count of the account's triggers.
 * An address besides workers.dev (a custom or external domain) can be
 * chosen; the install job adds it once the Worker serves.
 * When Settings records the account as on Workers Paid, no Workers Paid
 * confirmation is shown and it counts as given; otherwise ticking one also
 * offers "Remember this for the account", which records the plan.
 * Members see the form disabled.
 *
 * Settings start with the catalog default, else the wrangler config's value,
 * with `{{workerUrl}}` and `{{workerName}}` shown filled in for the Worker
 * name as typed. Only settings the admin changed are sent and stored; the
 * others take the default of whichever version a job deploys, placeholders
 * filled in then. A setting the app reads as JSON is a
 * multi-line field that must hold valid JSON.
 */
export function InstallForm({
  catalog,
  appKey = catalog.slug,
  varFields,
  subdomain,
  canInstall,
  defaultWorkerName,
  fixedWorkerName,
  blockedReason,
  blockedLink = null,
  requirementsConfirmed,
  sandboxBuild = null,
  sandboxFirst = false,
  installer = null,
  cronTriggers = 0,
  accountPlan = "free",
  planDetected = false,
  reviewedBuildId = null,
}: {
  catalog: CatalogManifest;
  /**
   * The app key the catalog page was opened with (`<catalog>:<slug>` for a
   * custom catalog's app): the install is looked up in that catalog only.
   */
  appKey?: string;
  /** One per catalog var (`installVarFields`). */
  varFields: InstallVarField[];
  /** The account's workers.dev subdomain, or null when unknown. */
  subdomain: string | null;
  canInstall: boolean;
  /** The catalog's Worker name, or the next free `<name>-N` when it is taken. */
  defaultWorkerName: string;
  /** The app only works under its catalog Worker name; the field is read-only. */
  fixedWorkerName: boolean;
  /** Why the install is not possible right now (for example, already installed). */
  blockedReason: string | null;
  /** Where to fix what blocks the install, shown under the reason (a checklist row). */
  blockedLink?: { href: string; label: string } | null;
  /** Sandbox builds are off and the install turns them on first; its confirmation says so. */
  sandboxFirst?: boolean;
  /** The admin ticked "This account meets these requirements" (only asked when `requires` is not empty). */
  requirementsConfirmed: boolean;
  /** A sandbox tier app's build, whose cost the admin confirms; null for a prebuilt app. */
  sandboxBuild?: IndexBuild | null;
  /**
   * A self-deploying app's installer run, whose cost the admin confirms and
   * which needs the app's own token; null for other apps. Its installer names
   * the Workers, so the form has no Worker name.
   */
  installer?: IndexBuild | null;
  /** Distinct cron triggers the artifact declares (0 when none or not known before a build). */
  cronTriggers?: number;
  /** The account's Workers plan in force: detected, else as Settings records it. */
  accountPlan?: AccountPlan;
  /** The plan was detected, so remembering one for the account would not apply. */
  planDetected?: boolean;
  /**
   * The review of a build from a repository (or from source): the form
   * installs that build, whose manifest `catalog` is, instead of the catalog's
   * release; null for a catalog install.
   */
  reviewedBuildId?: string | null;
}) {
  const jobStarted = useJobStarted();
  const [workerName, setWorkerName] = useState(defaultWorkerName);
  /** Empty: no display name, so the install is shown by its Worker name. */
  const [displayName, setDisplayName] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    initialSecretValues(catalog.secrets),
  );
  /** Settings the admin edited; the others follow their default. */
  const [editedVars, setEditedVars] = useState<Record<string, string>>({});
  const accountPaid = accountPlan === "paid";
  const [paidTicked, setPaidTicked] = useState(false);
  const [rememberPaid, setRememberPaid] = useState(false);
  /** Given when Settings says Workers Paid, else what the admin ticked here. */
  const paidConfirmed = accountPaid || paidTicked;
  const paidConfirmation: WorkersPaidConfirmationState = {
    checked: paidTicked,
    onChange: setPaidTicked,
    remember: rememberPaid,
    onRememberChange: setRememberPaid,
    offerRemember: !planDetected,
  };
  const [buildConfirmed, setBuildConfirmed] = useState(false);
  const [appToken, setAppToken] = useState("");
  const confirmsCost = sandboxBuild ?? installer;
  const receivesEmail = catalog.install.emailRouting !== undefined;
  const [emailZoneId, setEmailZoneId] = useState<string | null>(null);
  const [emailReady, setEmailReady] = useState(false);
  const [domain, setDomain] = useState<{ value: InstallDomainInput | null; complete: boolean }>({
    value: null,
    complete: true,
  });
  const onDomainChange = useCallback(
    (value: InstallDomainInput | null, complete: boolean) => setDomain({ value, complete }),
    [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholders = { workerName, workerUrl: workersDevUrl(workerName, subdomain) };
  // An app of several Workers: `{{workerUrl:<name>}}` names one of them.
  const entryWorkers = entryPlaceholderValues(catalog, workerName, subdomain) ?? {};
  const shownDefault = (field: InstallVarField): string =>
    renderEntryWorkerPlaceholders(
      renderPlaceholders(field.shownDefault, placeholders),
      entryWorkers,
    );
  const shownVar = (field: InstallVarField): string =>
    editedVars[field.name] ?? shownDefault(field);
  /**
   * Only settings the admin changed. The others are not stored, so each
   * install and update job uses the default of the version it deploys.
   */
  const submittedVars = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const field of varFields) {
      const edited = editedVars[field.name];
      const shown = shownDefault(field);
      if (edited !== undefined && edited !== shown) out[field.name] = edited;
    }
    return out;
  };
  const nameValid = installer !== null || WORKER_NAME_PATTERN.test(workerName);
  const displayNameError = displayNameProblem(displayName);
  const disabled = !canInstall || blockedReason !== null || pending;
  const missing =
    !secretsComplete(catalog.secrets, secrets) ||
    varFields.some(
      (f) => missingRequiredVar(f, shownVar(f)) || varValueProblem(f, shownVar(f)) !== null,
    );
  const ready =
    nameValid &&
    displayNameError === null &&
    !missing &&
    (catalog.plan !== "paid" || paidConfirmed) &&
    (confirmsCost === null || buildConfirmed) &&
    (installer === null || appToken.trim().length > 0) &&
    (catalog.requires.length === 0 || requirementsConfirmed) &&
    (!receivesEmail || (emailZoneId !== null && emailReady)) &&
    (installer !== null || domain.complete);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || disabled) return;
    setPending(true);
    setError(null);
    try {
      const fields = {
        workerName,
        ...(displayName.trim() === "" ? {} : { displayName }),
        secrets,
        vars: submittedVars(),
        paidConfirmed,
        ...(!accountPaid && paidTicked && rememberPaid ? { rememberPaidPlan: true } : {}),
        requirementsConfirmed,
        ...(receivesEmail && emailZoneId !== null ? { emailRouting: { zoneId: emailZoneId } } : {}),
        ...(installer === null && domain.value !== null ? { domain: domain.value } : {}),
      };
      const { jobId } =
        reviewedBuildId !== null
          ? await installSourceBuild({ data: { ...fields, buildId: reviewedBuildId } })
          : await startInstall({
              data: {
                ...fields,
                slug: appKey,
                ...(confirmsCost === null ? {} : { buildConfirmed }),
                ...(installer === null ? {} : { appToken: appToken.trim() }),
              },
            });
      await jobStarted(jobId, "Install started");
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
            <Banner
              variant="secondary"
              icon={<InfoIcon weight="fill" />}
              title={blockedReason}
              description={
                blockedLink === null ? undefined : (
                  <Link href={blockedLink.href}>{blockedLink.label}</Link>
                )
              }
            />
          )}
          <fieldset disabled={disabled} className="grid gap-6">
            {installer !== null ? (
              <Text variant="secondary" size="sm">
                {catalog.name}'s installer names its Workers after this install (
                <span className="font-mono text-[0.9em]">
                  {catalog.install.selfDeploying?.workers[0]?.replace("{{stage}}", "appflare-…") ??
                    catalog.install.workerName}
                </span>
                ), so several installs never share one.
              </Text>
            ) : (
              <InputGroup
                label="Worker name"
                labelTooltip={tooltipContent(
                  "Resources are named after it. Each install of an app needs its own Worker name.",
                )}
                error={nameValid ? undefined : { message: `Use ${WORKER_NAME_HINT}`, match: true }}
                description={
                  fixedWorkerName
                    ? `${catalog.name} only works as the Worker "${workerName}", so it installs once per account.`
                    : "The app is served at this address."
                }
              >
                <InputGroup.Addon>https://</InputGroup.Addon>
                <InputGroup.Input
                  aria-label="Worker name"
                  value={workerName}
                  onChange={(e) => setWorkerName(e.currentTarget.value.trim())}
                  readOnly={fixedWorkerName}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={WORKER_NAME_MAX_LENGTH}
                />
                <InputGroup.Suffix>
                  .{subdomain ?? "<your subdomain>"}.workers.dev
                </InputGroup.Suffix>
              </InputGroup>
            )}
            <Input
              label="Name"
              labelTooltip={tooltipContent(
                "Optional. Shown instead of the Worker name in Appflare only; it can be changed at any time from the app's page.",
              )}
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              placeholder={installer !== null ? catalog.name : workerName}
              autoComplete="off"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              error={displayNameError ?? undefined}
              description={
                installer !== null
                  ? `How this install is listed in Appflare. Leave empty to use ${catalog.name}.`
                  : "How this install is listed in Appflare. Leave empty to use the Worker name."
              }
            />

            {installer !== null && (
              <Input
                label={`${catalog.name}'s Cloudflare API token`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                passwordManagerIgnore
                required
                value={appToken}
                onChange={(e) => setAppToken(e.currentTarget.value)}
                description="The token you created with the permissions listed above. It is stored as a secret on your sandbox Worker, where the app's installer runs with it; Appflare keeps no copy and never uses it itself."
              />
            )}

            {catalog.secrets.length > 0 && (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Text bold>Secrets</Text>
                  <Text variant="secondary" size="sm">
                    {installer !== null
                      ? "Stored as encrypted secrets on your sandbox Worker for the app's installer, which sets them on the app's Workers. Appflare keeps only their names."
                      : "Stored as encrypted secrets on the app's Worker. Appflare keeps only their names."}
                  </Text>
                </div>
                <SecretFields
                  secrets={catalog.secrets}
                  values={secrets}
                  onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
                  after="the install"
                />
              </div>
            )}

            {varFields.length > 0 && (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Text bold>Variables</Text>
                  <Text variant="secondary" size="sm">
                    {installer !== null
                      ? "Handed to the app's installer as environment variables."
                      : "Variables on the app's Worker. Variables marked JSON take a JSON value."}
                  </Text>
                </div>
                {varFields.map((field) => (
                  <VarField
                    key={field.name}
                    field={field}
                    value={shownVar(field)}
                    onChange={(value) => setEditedVars((s) => ({ ...s, [field.name]: value }))}
                  />
                ))}
              </div>
            )}

            {/* The zone reads are admin-only calls; a member sees no zone field. */}
            {receivesEmail && canInstall && blockedReason === null && (
              <EmailRoutingFields
                slug={appKey}
                workerName={workerName}
                disabled={disabled}
                zoneId={emailZoneId}
                onZoneChange={setEmailZoneId}
                onReadyChange={setEmailReady}
              />
            )}

            {/* The zone and gateway reads are admin-only calls; the installer of a
                self-deploying app decides where its Workers answer. */}
            {installer === null && canInstall && blockedReason === null && (
              <InstallDomainFields disabled={disabled} onChange={onDomainChange} />
            )}

            {confirmsCost !== null && (
              <SandboxBuildConfirmation
                build={confirmsCost}
                checked={buildConfirmed}
                onChange={setBuildConfirmed}
                action="install"
                kind={installer !== null ? "installer" : "build"}
                sandboxFirst={sandboxFirst}
              />
            )}

            <CronTriggersField
              count={cronTriggers}
              confirmation={catalog.plan === "paid" || accountPaid ? null : paidConfirmation}
            />

            {catalog.plan === "paid" && !accountPaid && (
              <WorkersPaidConfirmation state={paidConfirmation} />
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

/**
 * One setting: a text field, a JSON field checked as the admin types, or for
 * a catalog `type: "select"` var its choices (cards for up to
 * {@link MAX_CARD_OPTIONS}, a dropdown beyond). Shared with the Settings
 * section of the app page.
 */
export function VarField({
  field,
  value,
  onChange,
  when = "when it installs",
}: {
  field: InstallVarField;
  value: string;
  onChange: (value: string) => void;
  /** When placeholders are filled in, for the field's note. */
  when?: string;
}) {
  const notes = [
    field.help,
    hasPlaceholder(value)
      ? `{{workerUrl}}, {{workerName}} and {{accountId}} are filled in with the app's URL, Worker name and Cloudflare account id ${when}.`
      : undefined,
  ].filter((note) => note !== undefined);
  const description = notes.length > 0 ? notes.join(" ") : undefined;
  const problem = varValueProblem(field, value) ?? undefined;
  if (field.options !== null && field.options.length <= MAX_CARD_OPTIONS) {
    return (
      <Radio.Group
        legend={`${field.label} (${field.name})`}
        description={description}
        value={value}
        onValueChange={(next: string) => onChange(next)}
        orientation="horizontal"
        appearance="card"
        error={problem}
      >
        {field.options.map((option) => (
          <Radio.Item key={option.value} value={option.value} label={option.label} />
        ))}
      </Radio.Group>
    );
  }
  if (field.options !== null) {
    return (
      <Select
        label={`${field.label} (${field.name})`}
        placeholder="Choose one"
        value={value === "" ? null : value}
        onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
        items={field.options.map((option) => ({ value: option.value, label: option.label }))}
        required={field.required}
        description={description}
        error={problem}
      />
    );
  }
  if (field.kind === "json") {
    return (
      <InputArea
        label={`${field.label} (${field.name}, JSON)`}
        value={value}
        required={field.required}
        autoComplete="off"
        spellCheck={false}
        autoResize
        minRows={1}
        maxRows={8}
        className="font-mono"
        onChange={(e) => onChange(e.currentTarget.value)}
        description={description}
        error={problem}
      />
    );
  }
  return (
    <Input
      label={`${field.label} (${field.name})`}
      value={value}
      required={field.required}
      autoComplete="off"
      onChange={(e) => onChange(e.currentTarget.value)}
      description={description}
    />
  );
}
