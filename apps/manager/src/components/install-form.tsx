import {
  appTokenPermissions,
  type CatalogManifest,
  catalogWorkerName,
  enteredSecrets,
  entryPlaceholderValues,
  hyperdriveDeclarations,
  type IndexBuild,
  isSeedOnly,
  needsWildcardHostname,
  STAGE_PLACEHOLDER,
} from "@appflare/schema";
import { Banner, Button, Input, Link, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useState } from "react";
import type { AccountPlan } from "../account/plan";
import { appTokenSecret } from "../installs/app-token-secret";
import { DISPLAY_NAME_MAX_LENGTH, displayNameProblem } from "../installs/display-name";
import type { InstallDomainInput } from "../installs/install-input";
import {
  enteredVarFields,
  type InstallVarField,
  missingRequiredVar,
  varValueProblem,
} from "../installs/install-vars";
import { startInstall } from "../installs/installs.functions";
import { workersDevUrl } from "../installs/post-install";
import { installSourceBuild } from "../installs/source-builds.functions";
import { workerNameAllowsInstall, workerNameFormatProblem } from "../installs/worker-name-check";
import { AppTokenHelp } from "./app-token-permissions";
import { CronTriggersField } from "./cron-triggers-field";
import { connectionsComplete, DatabaseFields } from "./database-fields";
import { EmailRoutingFields } from "./email-routing-fields";
import { TechnicalNamesProvider, TechnicalNamesSwitch, useShowTechnicalNames } from "./field-label";
import { InstallDomainFields } from "./install-domain-fields";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner } from "./message-text";
import { placeholderOptions } from "./placeholder-chips";
import { SandboxBuildConfirmation } from "./sandbox-build-confirmation";
import {
  initialSecretValues,
  SecretFields,
  secretsComplete,
  withSecretValue,
} from "./secret-fields";
import { Section, SectionBody } from "./section";
import { generatedSeedCredentials, holdSeedCredentials } from "./seed-credentials";
import { tooltipContent } from "./tooltip";
import { type PlaceholderChips, VarField } from "./var-field";
import { useWorkerNameCheck, WorkerNameField } from "./worker-name-field";
import {
  WorkersPaidConfirmation,
  type WorkersPaidConfirmationState,
} from "./workers-paid-confirmation";

/** The one notice at the top of the install form, or null when there is nothing to say. */
export function installFormNotice(
  canInstall: boolean,
  blockedReason: string | null,
  blockedLink: { href: string; label: string } | null = null,
): { title: string; link: { href: string; label: string } | null } | null {
  if (blockedReason !== null) return { title: blockedReason, link: blockedLink };
  if (!canInstall) return { title: "Only admins can install apps.", link: null };
  return null;
}

/**
 * The install form of `/catalog/$slug`, generated from the signed catalog
 * manifest. First the address: the Worker name, checked as it is typed (its
 * format, then whether a Worker already has it, `worker-name-field.tsx`), and
 * the choice of a domain besides workers.dev; then the install's optional
 * display name, one field per secret and var, and the Workers Paid
 * confirmation. The confirmation of
 * the app's account requirements is a checkbox in the page's prerequisites
 * callout; it arrives here as `requirementsConfirmed`. Generated secrets
 * (`generate`) are prefilled with a fresh value the admin can copy now; it is
 * shown only here. A derived var is shown read-only: the install computes it
 * from its source secret. Optional secrets stay unset unless the admin turns on
 * "Set it now". Seed-only secrets and vars (a first admin's account) say they
 * are used once and not kept; a generated one is shown once more on the
 * install's job page (./seed-credentials.ts). An app that receives email (`install.emailRouting`) also
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
 * placeholders shown as chips that say what they become for the Worker name
 * as typed. Only settings the admin changed are sent and stored, with their
 * placeholders; the others take the default of whichever version a job
 * deploys, placeholders filled in then. A setting the app reads as JSON is a
 * multi-line field that must hold valid JSON.
 *
 * Fields are labelled for people, not code: a "Show technical names" switch
 * at the top shows each field's variable or secret name. The form carries at
 * most one notice, at the top (why it cannot be used now). The Cloudflare
 * token an app needs for itself is explained next to the field that takes it
 * (the installer's token field, or the secret the app reads it from), else
 * after the settings.
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
  /** Where to fix what blocks the install, shown under the reason (a row of What this account can run). */
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
  /** Empty: no display name, so the install goes by the app's name. */
  const [displayName, setDisplayName] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    initialSecretValues(catalog.secrets),
  );
  /** Connection strings by Hyperdrive binding, for an app that uses a database elsewhere. */
  const databases = hyperdriveDeclarations(catalog.resources?.hyperdrive);
  const [connections, setConnections] = useState<Record<string, string>>({});
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
  const [showNames] = useShowTechnicalNames();
  const notice = installFormNotice(canInstall, blockedReason, blockedLink);
  /** Fields labelled for people, whose technical names the switch at the top shows. */
  const namedFields =
    enteredSecrets(catalog.secrets).length > 0 || varFields.length > 0 || databases.length > 0;
  // The app's own Cloudflare token: explained at the installer's token field,
  // at the secret that takes it, or else after the settings.
  const tokenPermissions = appTokenPermissions(catalog);
  const tokenSecret = installer === null ? appTokenSecret(catalog) : null;
  const tokenElsewhere = tokenPermissions.length > 0 && installer === null && tokenSecret === null;

  // Placeholders stay in the fields as chips, each saying what it becomes;
  // the install fills them in, for the Worker name it gets.
  const entryWorkers = entryPlaceholderValues(catalog, workerName, subdomain);
  const workerUrl = installer === null ? workersDevUrl(workerName, subdomain) : null;
  const chips: PlaceholderChips = {
    options: placeholderOptions({
      wildcard: needsWildcardHostname(catalog.install),
      workers: Object.keys(entryWorkers ?? {}),
    }),
    known: {
      workerName: installer === null ? workerName : null,
      workerUrl,
      // The app is served on workers.dev until a domain chosen here goes
      // live; the settings are then filled in again with the domain.
      appUrl: domain.value === null ? workerUrl : null,
      ...(entryWorkers === undefined ? {} : { entryWorkers }),
    },
  };
  const shownDefault = (field: InstallVarField): string => field.shownDefault;
  const shownVar = (field: InstallVarField): string =>
    editedVars[field.name] ?? shownDefault(field);
  /**
   * Only settings the admin changed. The others are not stored, so each
   * install and update job uses the default of the version it deploys.
   */
  const submittedVars = (): Record<string, string> => {
    const out: Record<string, string> = {};
    // A derived var is never sent: the server computes it from its source.
    for (const field of enteredVarFields(varFields)) {
      const edited = editedVars[field.name];
      const shown = shownDefault(field);
      if (edited !== undefined && edited !== shown) out[field.name] = edited;
    }
    return out;
  };
  // Checked live while the admin can change the name; a fixed name is the catalog's.
  const nameCheck = useWorkerNameCheck(
    workerName,
    installer === null && !fixedWorkerName && canInstall && blockedReason === null,
  );
  const namePattern = workerNameFormatProblem(workerName);
  const shownNameCheck =
    nameCheck ??
    (namePattern === null ? null : { state: "invalid" as const, message: namePattern });
  const nameValid =
    installer !== null || shownNameCheck === null || workerNameAllowsInstall(shownNameCheck);
  const displayNameError = displayNameProblem(displayName);
  const disabled = !canInstall || blockedReason !== null || pending;
  const missing =
    !secretsComplete(catalog.secrets, secrets) ||
    !connectionsComplete(databases, connections) ||
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
        ...(databases.length === 0 ? {} : { hyperdrive: connections }),
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
      // A generated first-admin password, shown once more on the job page.
      holdSeedCredentials(jobId, generatedSeedCredentials(catalog.secrets, secrets));
      await jobStarted(jobId, "Install started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the install.");
      setPending(false);
    }
  }

  return (
    <Section title={`Install ${catalog.name}`}>
      <SectionBody>
        <form className="grid gap-6" onSubmit={onSubmit}>
          {notice !== null && (
            <Banner
              variant="secondary"
              icon={<InfoIcon weight="fill" />}
              title={notice.title}
              description={
                notice.link === null ? undefined : (
                  <Link href={notice.link.href}>{notice.link.label}</Link>
                )
              }
            />
          )}
          {namedFields && (
            <div className="flex justify-end">
              <TechnicalNamesSwitch />
            </div>
          )}
          <TechnicalNamesProvider value={showNames}>
            <fieldset disabled={disabled} className="grid gap-6">
              {installer !== null ? (
                <Text variant="secondary" size="sm">
                  {catalog.name}'s installer names its Workers after this install (
                  <span className="font-mono text-[0.9em]">
                    {catalog.install.selfDeploying?.workerNames[0]?.replace(
                      STAGE_PLACEHOLDER,
                      "appflare-…",
                    ) ?? catalogWorkerName(catalog)}
                  </span>
                  ), so several installs never share one.
                </Text>
              ) : (
                <WorkerNameField
                  value={workerName}
                  onChange={setWorkerName}
                  check={shownNameCheck}
                  subdomain={subdomain}
                  readOnly={fixedWorkerName}
                  description={
                    fixedWorkerName
                      ? `${catalog.name} only works as the Worker "${workerName}", so it installs once per account.`
                      : "The app is served at this address."
                  }
                />
              )}

              {/* The address comes first, next to the Worker name: they are what the app's
                page shows at the top. The zone and gateway reads are admin-only calls; the
                installer of a self-deploying app decides where its Workers answer. */}
              {installer === null && canInstall && blockedReason === null && (
                <InstallDomainFields
                  disabled={disabled}
                  onChange={onDomainChange}
                  wildcard={catalog.install.wildcardHostname ?? null}
                />
              )}

              <Input
                label="Name"
                required={false}
                labelTooltip={tooltipContent(
                  "Shown in Appflare only. You can change it at any time from the app's page.",
                )}
                value={displayName}
                onChange={(e) => setDisplayName(e.currentTarget.value)}
                placeholder={catalog.name}
                autoComplete="off"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                error={displayNameError ?? undefined}
                description={`How it is listed in Appflare. Leave empty to use the app's name, ${catalog.name}.`}
              />

              {installer !== null && (
                <div className="grid gap-3">
                  <Input
                    label={`Cloudflare API token for ${catalog.name}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    passwordManagerIgnore
                    required
                    value={appToken}
                    onChange={(e) => setAppToken(e.currentTarget.value)}
                    description="The app's installer runs with it from your sandbox Worker. Appflare keeps no copy."
                  />
                  <AppTokenHelp appName={catalog.name} permissions={tokenPermissions} />
                </div>
              )}

              {catalog.secrets.length > 0 && (
                <div className="grid gap-4">
                  <div className="grid gap-1.5">
                    <Text bold>Secrets</Text>
                    <Text variant="secondary" size="sm">
                      {installer !== null
                        ? "Kept encrypted for the app's installer. Appflare stores only their names."
                        : "Kept encrypted on the app. Appflare stores only their names."}
                      {catalog.secrets.some(isSeedOnly)
                        ? " Those that create the first admin account are not kept at all."
                        : ""}
                    </Text>
                  </div>
                  <SecretFields
                    secrets={catalog.secrets}
                    vars={catalog.vars}
                    values={secrets}
                    onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
                    after="the install"
                    fieldExtras={
                      tokenSecret === null
                        ? {}
                        : {
                            [tokenSecret]: (
                              <AppTokenHelp appName={catalog.name} permissions={tokenPermissions} />
                            ),
                          }
                    }
                  />
                </div>
              )}

              <DatabaseFields
                databases={databases}
                values={connections}
                onChange={(binding, value) => setConnections((s) => ({ ...s, [binding]: value }))}
              />

              {varFields.length > 0 && (
                <div className="grid gap-4">
                  <div className="grid gap-1.5">
                    <Text bold>Settings</Text>
                    <Text variant="secondary" size="sm">
                      {installer !== null
                        ? "Handed to the app's installer. You can change them later on the app's page."
                        : "You can change them later on the app's page."}
                    </Text>
                  </div>
                  {varFields.map((field) => (
                    <VarField
                      key={field.name}
                      field={field}
                      value={shownVar(field)}
                      chips={chips}
                      onChange={(value) => setEditedVars((s) => ({ ...s, [field.name]: value }))}
                    />
                  ))}
                </div>
              )}

              {tokenElsewhere && (
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Text bold>Cloudflare token for {catalog.name}</Text>
                    <Text variant="secondary" size="sm">
                      {catalog.name} uses a Cloudflare API token of its own, which you give it after
                      it is installed. Its setup steps say where.
                    </Text>
                  </div>
                  <AppTokenHelp appName={catalog.name} permissions={tokenPermissions} />
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
          </TechnicalNamesProvider>

          {error !== null && <ErrorMessageBanner message={error} newTab />}
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
      </SectionBody>
    </Section>
  );
}
