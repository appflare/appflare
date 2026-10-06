import {
  accessBypassPaths,
  accessOfferOf,
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
import { Banner, Collapsible, cn, Input, Link, Text } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useCallback, useId, useState } from "react";
import { storedAccessProblem } from "../access/app-access";
import type { AccountPlan } from "../account/plan";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { accessStartsOn } from "../installs/access-offer";
import { appTokenSecret } from "../installs/app-token-secret";
import { DISPLAY_NAME_MAX_LENGTH, displayNameProblem } from "../installs/display-name";
import { type InstallFormPrefill, SECRETS_AGAIN_NOTE } from "../installs/install-again";
import { hostnameAllowsInstall, hostnameLeftOut } from "../installs/install-hostname-check";
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
import { BusyButton } from "./busy-button";
import { CronTriggersField } from "./cron-triggers-field";
import { connectionsComplete, DatabaseFields } from "./database-fields";
import { EMAIL_ROUTING_INTRO, EmailRoutingFields } from "./email-routing-fields";
import { TechnicalNamesProvider, TechnicalNamesSwitch, useShowTechnicalNames } from "./field-label";
import { InstallAccessField, useAppAccessCheck } from "./install-access-field";
import { InstallAddressField } from "./install-address-field";
import { foldStartsOpen, foldSummary, installFormGroups } from "./install-form-groups";
import { useJobStarted } from "./job-started";
import { ErrorMessageBanner, MessageText, messageHasLinks } from "./message-text";
import { hasChips, placeholderOptions } from "./placeholder-chips";
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
import { useInstallHostnameCheck } from "./use-hostname-check";
import { type PlaceholderChips, VarField } from "./var-field";
import { useWorkerNameCheck } from "./worker-name-field";
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
 * The notice as a banner. Kumo's banner title is plain text, so a notice
 * with links of its own (why sandbox builds cannot be turned on names the
 * account's dashboard page) goes in the description instead. The notice is
 * Appflare's own wording, so its dashboard addresses show as short links.
 */
function InstallFormNoticeBanner({
  notice,
}: {
  notice: NonNullable<ReturnType<typeof installFormNotice>>;
}) {
  const link =
    notice.link === null ? undefined : <Link href={notice.link.href}>{notice.link.label}</Link>;
  return (
    <Banner
      variant="secondary"
      icon={<InfoIcon weight="fill" />}
      {...(messageHasLinks(notice.title)
        ? {
            description: (
              <span className="grid gap-2">
                <span>
                  <MessageText message={notice.title} newTab dashboardLinks="short" />
                </span>
                {link}
              </span>
            ),
          }
        : { title: notice.title, description: link })}
    />
  );
}

/**
 * The install form of `/catalog/$slug`, generated from the signed catalog
 * manifest, in groups:
 *
 * - The address (./install-address-field.tsx): one control reading as the
 *   URL, the name typed on the left and the domain picked at the right
 *   (workers.dev, one of the account's domains, or another domain), its
 *   state in a tray beneath; under it, "Protect with Cloudflare Access"
 *   (./install-access-field.tsx), not offered for an app whose own
 *   installer decides its Workers.
 * - What the app needs: secrets it cannot run without and settings without a
 *   default (./install-form-groups.ts), with a count of what is left.
 *   Generated secrets (`generate`) are prefilled with a fresh value the
 *   admin can copy now (shown only here); seed-only ones (a first admin's
 *   account) say they are used once, and a generated one is shown once more
 *   on the install's job page (./seed-credentials.ts).
 * - The email domain, for an app that receives email.
 * - "Optional settings", folded: the install's name in Appflare, optional
 *   secrets (one field each; left empty, not set) and settings that have a
 *   default or are optional. It opens by itself when it holds a value or a
 *   problem. Settings Appflare fills in (placeholders, derived values) are
 *   not asked unless a value differs from the default.
 * - Plan and cost: the sandbox build's cost, and Workers Paid. For a paid app
 *   whose plan the page's "Before you install" box asks about
 *   (`planAskedAbove`), that box's tick is the confirmation. Otherwise, while
 *   Settings does not record Workers Paid, the form asks; ticking it offers
 *   "Remember this for the account". An app with cron triggers says how many
 *   it uses against the free plan's 5 per account.
 *
 * The footer says what is left before Install, or where the app is
 * installed. Only settings the admin changed are sent and stored, with their
 * placeholders; the others take the default of whichever version a job
 * deploys. "Install again" (`prefill`) starts from a failed install's choices.
 * Fields are labelled for people; a "Show technical names" switch in the
 * header shows each field's variable or secret name. The form carries at
 * most one notice, at the top (why it cannot be used now). Members see the
 * form disabled.
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
  capabilities = null,
  prefill = null,
  planAskedAbove = false,
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
  /**
   * The account's stored capability probes, for what already shows the
   * account cannot protect apps with Cloudflare Access; null when unknown.
   */
  capabilities?: Pick<CapabilitiesView, "zeroTrust" | "accessServiceTokens"> | null;
  /**
   * "Install again" (../installs/install-again.ts): what the form starts
   * with, from the failed install it replaces; null for a new install.
   */
  prefill?: InstallFormPrefill | null;
  /**
   * The page's "Before you install" callout already asks about Workers Paid
   * (its plan row, for a paid app whose plan Appflare cannot tell): its tick,
   * `requirementsConfirmed`, then counts for the plan too, and the form does
   * not ask again.
   */
  planAskedAbove?: boolean;
}) {
  const jobStarted = useJobStarted();
  const [workerName, setWorkerName] = useState(prefill?.workerName ?? defaultWorkerName);
  /** Empty: no display name, so the install goes by the app's name. */
  const [displayName, setDisplayName] = useState(prefill?.displayName ?? "");
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    initialSecretValues(catalog.secrets),
  );
  /** Connection strings by Hyperdrive binding, for an app that uses a database elsewhere. */
  const databases = hyperdriveDeclarations(catalog.resources?.hyperdrive);
  const [connections, setConnections] = useState<Record<string, string>>({});
  /** Settings the admin edited; the others follow their default. */
  const [editedVars, setEditedVars] = useState<Record<string, string>>(prefill?.vars ?? {});
  const accountPaid = accountPlan === "paid";
  const [paidTicked, setPaidTicked] = useState(false);
  const [rememberPaid, setRememberPaid] = useState(false);
  /**
   * Given when Settings says Workers Paid, else what the admin ticked here,
   * or above when the page's callout asks about the plan.
   */
  const paidConfirmed =
    accountPaid ||
    paidTicked ||
    (planAskedAbove && catalog.plan === "paid" && requirementsConfirmed);
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
  const [emailZoneId, setEmailZoneId] = useState<string | null>(prefill?.emailZoneId ?? null);
  const [emailReady, setEmailReady] = useState(false);
  const [domain, setDomain] = useState<{ value: InstallDomainInput | null; complete: boolean }>({
    value: prefill?.domain ?? null,
    complete: true,
  });
  const onDomainChange = useCallback(
    (value: InstallDomainInput | null, complete: boolean) => setDomain({ value, complete }),
    [],
  );
  // Cloudflare Access: not for an app whose own installer decides its Workers.
  const offersAccess = installer === null;
  const accessOffer = accessOfferOf(catalog);
  const [accessTicked, setAccessTicked] = useState(
    () => prefill?.access ?? accessStartsOn(catalog),
  );
  const accessCheck = useAppAccessCheck(offersAccess && canInstall && blockedReason === null);
  // The live check, once it answered; until then what the stored probes show.
  const accessProblem =
    accessCheck !== null ? accessCheck.problem : storedAccessProblem(capabilities);
  const accessOn = accessOffer === "required" || (accessTicked && accessProblem === null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNames] = useShowTechnicalNames();
  const notice = installFormNotice(canInstall, blockedReason, blockedLink);
  /** Fields labelled for people, whose technical names the switch in the header shows. */
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
  const chipWorkers = Object.keys(entryWorkers ?? {});
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
    prefill?.replaces ?? null,
  );
  const namePattern = workerNameFormatProblem(workerName);
  const shownNameCheck =
    nameCheck ??
    (namePattern === null ? null : { state: "invalid" as const, message: namePattern });
  const nameValid =
    installer !== null || shownNameCheck === null || workerNameAllowsInstall(shownNameCheck);
  // The custom domain, checked live like the Worker name: in use already, or free.
  const hostnameCheck = useInstallHostnameCheck(
    domain.value,
    workerName,
    installer === null && canInstall && blockedReason === null,
    prefill?.replaces ?? null,
  );
  const displayNameError = displayNameProblem(displayName);
  const disabled = !canInstall || blockedReason !== null || pending;

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
        ...(offersAccess ? { access: accessOn } : {}),
      };
      const { jobId } =
        reviewedBuildId !== null
          ? await installSourceBuild({
              data: {
                ...fields,
                buildId: reviewedBuildId,
                ...(prefill === null ? {} : { replaces: prefill.replaces }),
              },
            })
          : await startInstall({
              data: {
                ...fields,
                slug: appKey,
                ...(confirmsCost === null ? {} : { buildConfirmed }),
                ...(installer === null ? {} : { appToken: appToken.trim() }),
                ...(prefill === null ? {} : { replaces: prefill.replaces }),
              },
            });
      // A generated first-admin password, shown once more on the job page.
      holdSeedCredentials(jobId, generatedSeedCredentials(catalog.secrets, secrets));
      await jobStarted(jobId, prefill === null ? "Install started" : "Installing again");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the install.");
      setPending(false);
    }
  }

  // Up front, what the install cannot go without; the rest folds (./install-form-groups.ts).
  // Settings Appflare fills in itself (from the address, the account, Access)
  // and settings computed from a secret are not asked here: the app's page shows them.
  // One the admin changed stays, though: an install made again shows what it sends.
  const askedVars = varFields.filter(
    (f) =>
      !filledByAppflare(f, chipWorkers) ||
      (f.derivedFrom === undefined && shownVar(f) !== f.shownDefault),
  );
  const groups = installFormGroups(catalog.secrets, askedVars);
  const neededVars = groups.needed.vars;
  const foldedVars = groups.folded.vars;
  const foldLabels = [
    NAME_LABEL,
    ...groups.folded.secrets.map((s) => s.label),
    ...foldedVars.map((f) => f.label),
  ];
  // Open from the start when it holds something already, such as the choices of
  // an install made again (its name in Appflare, settings it changed).
  const [foldOpen, setFoldOpen] = useState(
    () =>
      displayName !== "" ||
      foldStartsOpen(
        { secrets: groups.folded.secrets, vars: foldedVars },
        { secrets, vars: shownVar, varProblem: varValueProblem },
      ),
  );
  // A folded setting whose value cannot be used keeps the fold open: it is what holds the install.
  const foldProblem = foldedVars.some((f) => settingProblem(f, shownVar(f)) !== null);
  const secretsNote = `${
    installer !== null
      ? "Secrets are kept encrypted for the app's installer; Appflare stores only their names."
      : "Secrets are kept encrypted on the app; Appflare stores only their names."
  }${catalog.secrets.some(isSeedOnly) ? " Those that create the first admin account are not kept at all." : ""}${
    prefill === null ? "" : ` ${SECRETS_AGAIN_NOTE}`
  }`;
  // An app of several Workers names the others after this one.
  const otherWorkers = Object.values(entryWorkers ?? {})
    .map((w) => w.workerName)
    .filter((name) => name !== workerName);
  const fieldExtras =
    tokenSecret === null
      ? {}
      : {
          [tokenSecret]: <AppTokenHelp appName={catalog.name} permissions={tokenPermissions} />,
        };
  const secretFields = (only: readonly { name: string }[]) =>
    only.length === 0 ? null : (
      <SecretFields
        secrets={catalog.secrets}
        only={only.map((s) => s.name)}
        vars={catalog.vars}
        values={secrets}
        onChange={(name, value) => setSecrets((s) => withSecretValue(s, name, value))}
        after="the install"
        fieldExtras={fieldExtras}
      />
    );
  const varFieldsOf = (fields: readonly InstallVarField[]) =>
    fields.map((field) => (
      <VarField
        key={field.name}
        field={field}
        value={shownVar(field)}
        chips={chips}
        onChange={(value) => setEditedVars((s) => ({ ...s, [field.name]: value }))}
      />
    ));
  // What the "needs" group asks, and how many are still empty.
  const neededEntries: { label: string; filled: boolean }[] = [
    ...(installer === null
      ? []
      : [
          { label: `the Cloudflare API token for ${catalog.name}`, filled: appToken.trim() !== "" },
        ]),
    ...groups.needed.secrets.map((s) => ({
      label: s.label,
      filled: (secrets[s.name] ?? "").length > 0,
    })),
    ...databases.map((d) => ({
      label: d.label ?? "the connection string",
      filled: connectionsComplete([d], connections),
    })),
    ...neededVars.map((f) => ({ label: f.label, filled: !missingRequiredVar(f, shownVar(f)) })),
  ];
  const leftToFill = neededEntries.filter((e) => !e.filled);
  const needsSomething = neededEntries.length > 0 || tokenElsewhere;
  // Something to tick before the install gets a box of its own; the cron
  // count alone, on a Workers Paid account, is one quiet line by the button.
  const asksPaid = catalog.plan === "paid" && !accountPaid && !planAskedAbove;
  const asksCron = !accountPaid && cronTriggers > 0 && catalog.plan !== "paid";
  const confirms = confirmsCost !== null || asksCron || asksPaid;
  // Why Install is off, first reason first; empty when it is on.
  const blockers = [
    !nameValid && "choose a Worker name that is free",
    !domain.complete && "finish the address",
    domain.complete &&
      !hostnameAllowsInstall(hostnameCheck) &&
      "choose an address no other app here uses",
    leftToFill.length > 0 && `fill in ${listWords(leftToFill.map((e) => e.label))}`,
    // Every secret the app must have, counted again as the server counts them.
    leftToFill.length === 0 &&
      !secretsComplete(catalog.secrets, secrets) &&
      "fill in the secrets the app needs",
    displayNameError !== null && "shorten the name in Appflare",
    receivesEmail &&
      (emailZoneId === null || !emailReady) &&
      "choose a domain that can receive email",
    catalog.plan === "paid" &&
      !paidConfirmed &&
      (planAskedAbove
        ? "confirm the account's plan above"
        : "confirm the account is on Workers Paid"),
    catalog.requires.length > 0 &&
      !requirementsConfirmed &&
      !planAskedAbove &&
      "confirm the account has what the app needs, above",
    confirmsCost !== null && !buildConfirmed && "confirm the build's cost",
    accessOffer === "required" &&
      accessCheck?.problem != null &&
      "set up Cloudflare Access for this account",
    ...askedVars
      .filter((f) => settingProblem(f, shownVar(f)) !== null)
      .map((f) => `fix ${f.label}`),
  ].filter((b): b is string => typeof b === "string");
  // Install is on exactly when the footer has nothing left to name.
  const ready = blockers.length === 0;
  // A domain the install would leave out (records or another Worker's): the app answers on workers.dev.
  const shownUrl =
    domain.value === null || hostnameLeftOut(hostnameCheck)
      ? workerUrl
      : `https://${domain.value.hostname}`;
  const footerLine = installFooterLine({
    again: prefill !== null,
    appName: catalog.name,
    blocker: blockers[0] ?? null,
  });

  return (
    <Section
      title={`Install ${catalog.name}`}
      action={namedFields ? <TechnicalNamesSwitch /> : null}
    >
      <SectionBody className="gap-0 p-0">
        <form className="grid min-w-0" onSubmit={onSubmit}>
          <TechnicalNamesProvider value={showNames}>
            <fieldset disabled={disabled} className="grid min-w-0 gap-8 px-5 pt-5 pb-6">
              {notice !== null && <InstallFormNoticeBanner notice={notice} />}

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
                // The address is what the app's page shows first; here it is the one
                // raised panel, with who can open it under it.
                <div
                  data-address-panel=""
                  className="grid min-w-0 gap-4 rounded-xl bg-kumo-recessed p-4 ring-1 ring-kumo-hairline sm:p-5"
                >
                  <InstallAddressField
                    appName={catalog.name}
                    workerName={workerName}
                    onWorkerNameChange={setWorkerName}
                    check={shownNameCheck}
                    fixedWorkerName={fixedWorkerName}
                    subdomain={subdomain}
                    withDomains={canInstall && blockedReason === null}
                    wildcard={catalog.install.wildcardHostname ?? null}
                    otherWorkers={otherWorkers}
                    disabled={disabled}
                    onDomainChange={onDomainChange}
                    hostnameCheck={hostnameCheck}
                    initial={prefill?.domain ?? null}
                  />
                  {offersAccess && (
                    <div className="border-kumo-hairline border-t pt-4">
                      <InstallAccessField
                        appName={catalog.name}
                        offer={accessOffer}
                        publicPaths={accessBypassPaths(catalog)}
                        checked={accessTicked}
                        onCheckedChange={setAccessTicked}
                        problem={accessProblem}
                        check={accessCheck}
                        disabled={disabled}
                      />
                    </div>
                  )}
                </div>
              )}

              {needsSomething && (
                <FormGroup
                  title={`What ${catalog.name} needs`}
                  description={groups.needed.secrets.length > 0 ? secretsNote : undefined}
                  status={
                    neededEntries.length === 0 ? null : leftToFill.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-kumo-success text-sm">
                        <CheckCircleIcon aria-hidden weight="fill" />
                        All filled in
                      </span>
                    ) : (
                      <span className="text-kumo-subtle text-sm">
                        {leftToFill.length === neededEntries.length
                          ? `${leftToFill.length} to fill in`
                          : `${leftToFill.length} of ${neededEntries.length} left to fill in`}
                      </span>
                    )
                  }
                >
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
                  {secretFields(groups.needed.secrets)}
                  <DatabaseFields
                    databases={databases}
                    values={connections}
                    onChange={(binding, value) =>
                      setConnections((s) => ({ ...s, [binding]: value }))
                    }
                    withHeading={false}
                  />
                  {varFieldsOf(neededVars)}
                  {tokenElsewhere && (
                    <div className="grid gap-2">
                      <Text bold>Cloudflare token for {catalog.name}</Text>
                      <Text variant="secondary" size="sm">
                        {catalog.name} uses a Cloudflare API token of its own, which you give it
                        after it is installed. Its setup steps say where.
                      </Text>
                      <AppTokenHelp appName={catalog.name} permissions={tokenPermissions} />
                    </div>
                  )}
                </FormGroup>
              )}

              {/* The zone reads are admin-only calls; a member sees no zone field. */}
              {receivesEmail && canInstall && blockedReason === null && (
                <FormGroup title="Email" description={EMAIL_ROUTING_INTRO}>
                  <EmailRoutingFields
                    slug={appKey}
                    workerName={workerName}
                    disabled={disabled}
                    zoneId={emailZoneId}
                    onZoneChange={setEmailZoneId}
                    onReadyChange={setEmailReady}
                    withHeading={false}
                  />
                </FormGroup>
              )}

              <FoldedGroup
                title="Optional settings"
                count={foldLabels.length}
                summary={foldSummary(foldLabels)}
                open={foldOpen || foldProblem}
                onOpenChange={setFoldOpen}
              >
                <Input
                  label={NAME_LABEL}
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
                  description={`How it is listed in Appflare. Leave empty to use ${catalog.name}.`}
                />
                {groups.needed.secrets.length === 0 && groups.folded.secrets.length > 0 && (
                  <Text variant="secondary" size="sm">
                    {secretsNote}
                  </Text>
                )}
                {secretFields(groups.folded.secrets)}
                {varFieldsOf(foldedVars)}
                {foldedVars.length > 0 && (
                  <Text variant="secondary" size="sm">
                    {installer !== null
                      ? "Settings are handed to the app's installer. You can change them later on the app's page, which also shows the ones Appflare fills in."
                      : "You can change settings later on the app's page, which also shows the ones Appflare fills in."}
                  </Text>
                )}
              </FoldedGroup>

              {confirms && (
                <fieldset
                  aria-label="Plan and cost"
                  className="grid gap-3 rounded-xl p-4 ring-1 ring-kumo-hairline"
                >
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
                  {asksPaid && <WorkersPaidConfirmation state={paidConfirmation} />}
                </fieldset>
              )}
            </fieldset>
          </TechnicalNamesProvider>

          {/* The footer: where the install goes, or what is left before it can. */}
          <div className="grid gap-3 rounded-b-[inherit] border-kumo-hairline border-t bg-kumo-elevated px-5 py-4">
            {error !== null && <ErrorMessageBanner message={error} newTab />}
            {!confirms && cronTriggers > 0 && <CronTriggersField count={cronTriggers} />}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <p
                data-install-readiness={blockers.length === 0 ? "ready" : "blocked"}
                className="min-w-0 flex-1 text-pretty text-kumo-subtle text-sm"
              >
                {disabled ? null : !footerLine.ready ? (
                  footerLine.text
                ) : (
                  <>
                    {footerLine.text}
                    {shownUrl !== null && (
                      <>
                        {" at "}
                        <span className="break-all font-medium text-kumo-default">{shownUrl}</span>
                      </>
                    )}
                    .
                  </>
                )}
              </p>
              {/* Announced: what is left, not the address that changes with each key. */}
              <span aria-live="polite" className="sr-only">
                {disabled ? "" : (blockers[0] ?? "Ready to install.")}
              </span>
              <BusyButton
                pending={pending}
                type="submit"
                variant="primary"
                icon={<DownloadSimpleIcon />}
                disabled={disabled || !ready}
              >
                {prefill === null ? "Install" : "Install again"}
              </BusyButton>
            </div>
          </div>
        </form>
      </SectionBody>
    </Section>
  );
}

/**
 * The footer's line: what Install does ("Installs Cut", followed by " at "
 * and the address when there is one), or the first thing left before it can
 * ("To install, fill in …"). Installing again puts "again" after the app's
 * name, where it reads naturally.
 */
export function installFooterLine(input: {
  again: boolean;
  appName: string;
  /** The first thing left before Install turns on; null when nothing is. */
  blocker: string | null;
}): { ready: boolean; text: string } {
  const { again, appName, blocker } = input;
  if (blocker === null) {
    return { ready: true, text: again ? `Installs ${appName} again` : `Installs ${appName}` };
  }
  return {
    ready: false,
    text: again ? `To install ${appName} again, ${blocker}.` : `To install, ${blocker}.`,
  };
}

/** The display name's label, also the first entry of the fold's summary. */
const NAME_LABEL = "Name in Appflare";

/**
 * What keeps a setting's value from being installed: the value's own
 * problem (JSON that does not parse, a choice not offered), or a required
 * setting emptied although it had a default.
 */
export function settingProblem(field: InstallVarField, value: string): string | null {
  const problem = varValueProblem(field, value);
  if (problem !== null) return problem;
  return field.required && value.trim() === "" && !missingRequiredVar(field, value)
    ? `${field.label} is required.`
    : null;
}

/**
 * A setting the install form does not ask: one Appflare computes from a
 * secret, or one whose default is filled in from what Appflare knows (the
 * app's address, the account, its Access application). The install keeps
 * its default; the app's page shows it, and it can be changed there.
 */
export function filledByAppflare(
  field: Pick<InstallVarField, "derivedFrom" | "shownDefault" | "seedOnly">,
  workers: readonly string[],
): boolean {
  if (field.seedOnly === true) return false;
  return field.derivedFrom !== undefined || hasChips(field.shownDefault, workers);
}

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * One group of the install form: a heading with its state on the right (how
 * many fields are left), a line under it, then its fields.
 */
function FormGroup({
  title,
  description,
  status = null,
  children,
}: {
  title: string;
  description?: string | undefined;
  /** The group's state, at the right of its heading. */
  status?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset aria-labelledby={id} className="grid min-w-0 gap-5">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <Text variant="heading" as="h3" id={id}>
            {title}
          </Text>
          {status}
        </div>
        {description !== undefined && (
          <Text variant="secondary" size="sm">
            {description}
          </Text>
        )}
      </div>
      {children}
    </fieldset>
  );
}

/**
 * The form's "Optional settings": a quiet outlined row that opens in place,
 * naming its first fields while closed. Its fields stay in the page while it
 * is closed (hidden), so their values and checks live on.
 */
function FoldedGroup({
  title,
  count,
  summary,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  count: number;
  summary: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      // The border is the box's own edge and its content is clipped to it, so the
      // header's hover fill follows the inner curve (outer radius minus the border).
      data-fold=""
      className="grid min-w-0 overflow-hidden rounded-xl border border-kumo-hairline"
    >
      <h3 className="m-0">
        <Collapsible.Trigger
          className={cn(
            "group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left",
            "hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50 focus-visible:ring-inset",
          )}
        >
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="font-medium text-base text-kumo-default">
              {title} <span className="font-normal text-kumo-subtle">({count})</span>
            </span>
            {!open && <span className="truncate text-kumo-subtle text-sm">{summary}</span>}
          </span>
          <CaretDownIcon
            aria-hidden
            className="shrink-0 text-kumo-subtle transition-transform duration-150 group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
      </h3>
      <Collapsible.Panel
        keepMounted
        className="grid min-w-0 gap-5 border-kumo-hairline border-t px-4 pt-4 pb-5"
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
