import {
  Banner,
  Button,
  Combobox,
  cn,
  InputGroup,
  LayerCard,
  Link,
  Radio,
  Text,
} from "@cloudflare/kumo";
import {
  CaretUpDownIcon,
  CheckCircleIcon,
  GlobeHemisphereWestIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  checkExternalHostname,
  EXTERNAL_DOMAIN_COST,
  VALIDATION_LABELS,
  VALIDATION_METHODS,
  type ValidationMethod,
} from "../gateway/gateway";
import { checkSubdomainInZone } from "../installs/custom-domain-input";
import { getDomainOptions } from "../installs/custom-domains.functions";
import type { DomainOptions } from "../installs/custom-domains.server";
import type { ExternalDomainOptions } from "../installs/external-domain-input";
import { getExternalDomainOptions } from "../installs/external-domains.functions";
import {
  hostnameConsequence,
  hostnameStatus,
  type InstallHostnameCheck,
} from "../installs/install-hostname-check";
import { type InstallDomainInput, WORKER_NAME_MAX_LENGTH } from "../installs/install-input";
import {
  checkWildcardSubdomain,
  WILDCARD_EXTERNAL_REFUSAL,
  wildcardPattern,
} from "../installs/wildcard-domain-input";
import type { WorkerNameCheck } from "../installs/worker-name-check";
import { AppflareLoader } from "./appflare-loader";
import { MoreText, useTechnicalNames } from "./field-label";
import { settingsLink } from "./settings-links";
import { WildcardNotes } from "./wildcard-notes";
import { UNCHECKED_NOTE } from "./worker-name-field";

/**
 * Where the app will answer, as one control that reads as the address
 * itself: `https://` [the name you type] `.` [the domain, a dropdown]. The
 * dropdown at the end holds every place the app can live: the account's
 * workers.dev subdomain, each domain on the account, and "another domain"
 * (a hostname whose DNS is elsewhere, through the gateway). What the left
 * part means follows the dropdown:
 *
 * - workers.dev: the Worker name, checked live (free, taken, the rules);
 * - a domain on the account: the name before it, prefilled with the Worker
 *   name; left empty, the app takes the domain itself (the field then reads
 *   `https://example.com`, with no dot);
 * - another domain: the whole hostname.
 *
 * One line under the control says what the address means, in the state's
 * colour. On a domain, the Worker name moves to a quiet line of its own
 * ("Runs as the Worker open-seo · Change"), opened at once when the name
 * is taken. An app that needs a wildcard hostname is offered the account's
 * domains as wildcard bases, and no other domain.
 *
 * The domains are read once, when the form opens, and only when
 * `withDomains` (an admin who can install now: the reads are admin-only).
 */

/** The dropdown's value: workers.dev, one of the account's domains (`zone:<id>`), or another domain. */
export type AddressPlace = "workers" | `zone:${string}` | "external";

/**
 * What the tray under the address says about the name: green when it is
 * free, red when it cannot be used, a spinner while it is checked, or a
 * quiet note; null when there is nothing to say (the tray then shows the
 * address the app will have).
 */
export interface AddressStatus {
  tone: "neutral" | "success" | "warning" | "danger" | "pending";
  text: string;
}

/** The status while the app is on workers.dev; null when there is nothing to say. */
export function workersDevStatus(
  check: WorkerNameCheck | null,
  fixed: { appName: string } | null,
): AddressStatus | null {
  if (fixed !== null) {
    return {
      tone: "neutral",
      text: `${fixed.appName} only works under this name, so it installs once per account.`,
    };
  }
  switch (check?.state) {
    case "checking":
      return { tone: "pending", text: "Checking the name…" };
    case "free":
      return { tone: "success", text: "Available" };
    case "taken":
    case "invalid":
      return { tone: "danger", text: check.message };
    case "unknown":
      return { tone: "neutral", text: UNCHECKED_NOTE };
    default:
      return null;
  }
}

/** What a domain of the account means for the app, in the quiet line under the address. */
export function zoneNote(hostname: string, zoneName: string, wildcard: boolean): string {
  if (wildcard) {
    return `The app answers at ${hostname} and on every name under it (${wildcardPattern(hostname)}).`;
  }
  if (hostname === zoneName) {
    return `The app takes ${zoneName} itself. Type a name to use a subdomain instead.`;
  }
  return `Cloudflare adds its DNS record and certificate once the app runs. ${WORKERS_DEV_OFF}`;
}

/**
 * The domain an address means, with the checks behind it: none for
 * workers.dev; on one of the account's domains, `name` before it (the
 * domain itself when empty), as a custom domain or, for an app that needs
 * one, a wildcard base (on the domain itself only once the admin agreed);
 * another domain through the gateway. Null while the address is not
 * complete.
 */
export function addressDomain(input: {
  place: AddressPlace;
  zones: readonly { id: string; name: string }[];
  name: string;
  wildcard: boolean;
  wholeDomainAgreed: boolean;
  hostname: string;
  /** The gateway's zone, or null while the gateway is not set up (or not read yet). */
  gateway: string | null;
  accountZones: readonly string[];
  method: ValidationMethod;
}): {
  zone: { id: string; name: string } | null;
  zoneCheck:
    | ReturnType<typeof checkSubdomainInZone>
    | ReturnType<typeof checkWildcardSubdomain>
    | null;
  externalCheck: ReturnType<typeof checkExternalHostname> | null;
  domain: InstallDomainInput | null;
} {
  const zone = input.place.startsWith("zone:")
    ? (input.zones.find((z) => `zone:${z.id}` === input.place) ?? null)
    : null;
  const zoneCheck =
    zone === null
      ? null
      : input.wildcard
        ? checkWildcardSubdomain(input.name, zone.name)
        : checkSubdomainInZone(input.name, zone.name);
  const externalCheck =
    input.place === "external" && input.gateway !== null
      ? checkExternalHostname(input.hostname, {
          gateway: input.gateway,
          account: input.accountZones,
        })
      : null;
  let domain: InstallDomainInput | null = null;
  if (zone !== null && zoneCheck?.ok === true) {
    const whole = "wholeDomain" in zoneCheck && zoneCheck.wholeDomain === true;
    if (!input.wildcard) domain = { kind: "custom", zoneId: zone.id, hostname: zoneCheck.hostname };
    else if (!whole || input.wholeDomainAgreed) {
      domain = {
        kind: "wildcard",
        zoneId: zone.id,
        hostname: zoneCheck.hostname,
        ...(whole ? { wholeDomain: true } : {}),
      };
    }
  } else if (externalCheck?.ok === true) {
    domain = { kind: "external", hostname: externalCheck.hostname, validation: input.method };
  }
  return { zone, zoneCheck, externalCheck, domain };
}

/** Where the picker starts: the domain an earlier install chose, else workers.dev. */
export function initialPlace(initial: InstallDomainInput | null): AddressPlace {
  if (initial === null) return "workers";
  if (initial.kind === "external") return "external";
  return `zone:${initial.zoneId}`;
}

/** What else to know about a domain on the account, behind "More". */
const ZONE_DETAIL =
  "If the name already has DNS records, the install leaves them and finishes on workers.dev; add the domain on the app's page then.";

/** Each address but workers.dev turns the workers.dev address off once it is live. */
const WORKERS_DEV_OFF = "The workers.dev address turns off once this one is live.";

export function InstallAddressField({
  appName,
  workerName,
  onWorkerNameChange,
  check,
  fixedWorkerName,
  subdomain,
  withDomains,
  wildcard,
  otherWorkers,
  disabled,
  onDomainChange,
  hostnameCheck = null,
  initial = null,
}: {
  appName: string;
  workerName: string;
  onWorkerNameChange(name: string): void;
  /** The live check of the Worker name; null shows no state. */
  check: WorkerNameCheck | null;
  /** The app only works under its catalog Worker name. */
  fixedWorkerName: boolean;
  /** The account's workers.dev subdomain, or null when unknown. */
  subdomain: string | null;
  /** Offer the account's domains (reads them once). */
  withDomains: boolean;
  /** The app's manifest sets `install.wildcardHostname`, with its reason; null otherwise. */
  wildcard: { reason: string } | null;
  /** The app's other Workers, named after this one ("open-seo-audit"). */
  otherWorkers: readonly string[];
  disabled: boolean;
  /** A state setter (stable): the domain to send (null for workers.dev only) and whether it is complete. */
  onDomainChange(domain: InstallDomainInput | null, complete: boolean): void;
  /**
   * The live check of the chosen name in one of the account's domains
   * (`useInstallHostnameCheck`); null shows no state.
   */
  hostnameCheck?: InstallHostnameCheck | null;
  /** The domain to start with ("Install again"); null starts on workers.dev. */
  initial?: InstallDomainInput | null;
}) {
  const [place, setPlace] = useState<AddressPlace>(() => initialPlace(initial));
  const [zones, setZones] = useState<DomainOptions | null>(null);
  const [external, setExternal] = useState<ExternalDomainOptions | null>(null);
  /** Why the account's domains, or the options for another domain, could not be read. */
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  /** On a domain: the name before it (empty for the domain itself). */
  const [name, setName] = useState<string | null>(null);
  /** A starting hostname in one of the account's domains, split into `name` once they are read. */
  const [startHostname, setStartHostname] = useState(
    initial?.kind === "custom" || initial?.kind === "wildcard" ? initial.hostname : null,
  );
  /** Another domain: the whole hostname. */
  const [hostname, setHostname] = useState(initial?.kind === "external" ? initial.hostname : "");
  const [touched, setTouched] = useState(false);
  const [method, setMethod] = useState<ValidationMethod>(
    initial?.kind === "external" ? initial.validation : "http",
  );
  /** A wildcard on the domain itself: the admin agreed every name in it reaches the app. */
  const [wholeDomain, setWholeDomain] = useState(
    initial?.kind === "wildcard" && initial.wholeDomain === true,
  );
  const [editingName, setEditingName] = useState(false);
  const inputId = useId();
  const statusId = useId();
  const noteId = useId();
  const consequenceId = useId();

  useEffect(() => {
    if (!withDomains) return;
    let live = true;
    const fail = (set: (message: string) => void) => (err: unknown) => {
      if (live) set(err instanceof Error ? err.message : "Could not read the domains.");
    };
    getDomainOptions().then((o) => live && setZones(o), fail(setZonesError));
    // A wildcard app cannot use another domain; its options are not needed.
    if (wildcard === null) {
      getExternalDomainOptions().then((o) => live && setExternal(o), fail(setExternalError));
    }
    return () => {
      live = false;
    };
  }, [withDomains, wildcard]);

  // A starting hostname ("Install again"), as the name before its domain once the
  // domains are read; the domain itself when it is the whole hostname.
  useEffect(() => {
    if (startHostname === null || zones === null || !place.startsWith("zone:")) return;
    setStartHostname(null);
    const zone = zones.zones.find((z) => `zone:${z.id}` === place);
    if (zone === undefined) return;
    if (startHostname === zone.name) setName("");
    else if (startHostname.endsWith(`.${zone.name}`)) {
      setName(startHostname.slice(0, -(zone.name.length + 1)));
    }
  }, [startHostname, zones, place]);
  // The name before the domain starts as the Worker name, the way most people name it.
  const typedName = name ?? workerName;
  const gateway = external?.gateway ?? null;
  const {
    zone,
    zoneCheck,
    externalCheck,
    domain: chosen,
  } = addressDomain({
    place,
    zones: zones?.zones ?? [],
    name: typedName,
    wildcard: wildcard !== null,
    wholeDomainAgreed: wholeDomain,
    hostname,
    gateway: gateway?.zoneName ?? null,
    accountZones: external?.accountZones ?? [],
    method,
  });
  // Reported by value, so an unchanged choice does not update the form again.
  const reported = JSON.stringify(chosen);
  const complete = place === "workers" || chosen !== null;
  useEffect(() => {
    onDomainChange(JSON.parse(reported) as InstallDomainInput | null, complete);
  }, [reported, complete, onDomainChange]);

  const nameProblem = check?.state === "taken" || check?.state === "invalid" ? check.message : null;
  // On a domain, a Worker name that cannot be used opens its own field.
  // Once the field opened for a name that cannot be used, it stays open while
  // the admin types a new one (the name is "checking" between, with no problem).
  useEffect(() => {
    if (nameProblem !== null && place !== "workers") setEditingName(true);
  }, [nameProblem, place]);
  const showNameField = place !== "workers" && (editingName || nameProblem !== null);

  // The left part of the control, and what it means.
  const left =
    place === "workers"
      ? {
          label: "Worker name",
          value: workerName,
          onChange: (v: string) => onWorkerNameChange(v.trim()),
          readOnly: fixedWorkerName,
          maxLength: WORKER_NAME_MAX_LENGTH,
          placeholder: "",
        }
      : place === "external"
        ? {
            label: "Hostname",
            value: hostname,
            onChange: setHostname,
            readOnly: false,
            maxLength: 253,
            placeholder: "app.example.org",
          }
        : {
            label: "Subdomain",
            value: typedName,
            onChange: (v: string) => {
              setName(v);
              setWholeDomain(false);
            },
            readOnly: false,
            maxLength: 63,
            placeholder: "Subdomain (optional)",
          };

  const error =
    place === "workers"
      ? nameProblem
      : touched && place === "external" && externalCheck !== null && !externalCheck.ok
        ? externalCheck.error
        : zoneCheck !== null && !zoneCheck.ok && typedName.length > 0
          ? zoneCheck.error
          : null;
  // Green or red, or a note that matters; nothing while idle.
  const status: AddressStatus | null =
    error !== null
      ? { tone: "danger", text: error }
      : place === "workers"
        ? workersDevStatus(check, fixedWorkerName ? { appName } : null)
        : // A name in one of the account's domains: whether it is in use already.
          zoneCheck?.ok === true && wildcard === null
          ? hostnameStatus(hostnameCheck)
          : null;
  // A name the install would leave out: what that means, and the choices.
  // While a name on the same domain is checked again (each keystroke), the
  // last one stays, so the form below does not jump; the answer replaces it.
  const onZone = place.startsWith("zone:") && zoneCheck?.ok === true && wildcard === null;
  const lastConsequence = useRef<{
    place: AddressPlace;
    shown: ReturnType<typeof hostnameConsequence>;
  } | null>(null);
  let consequence = onZone ? hostnameConsequence(hostnameCheck) : null;
  if (onZone && hostnameCheck?.state === "checking" && lastConsequence.current?.place === place) {
    consequence = lastConsequence.current.shown;
  } else {
    lastConsequence.current = consequence === null ? null : { place, shown: consequence };
  }
  // What the chosen place means, quietly, for a domain only.
  const note =
    place === "external"
      ? gateway === null
        ? null
        : `Whoever runs its DNS points a CNAME at ${gateway.hostname}. ${WORKERS_DEV_OFF}`
      : zone !== null && zoneCheck?.ok === true
        ? consequence !== null
          ? null
          : zoneNote(zoneCheck.hostname, zone.name, wildcard !== null)
        : place.startsWith("zone:") && zones === null
          ? "Reading the account's domains…"
          : null;

  const workersDevLabel = `${subdomain ?? "<your subdomain>"}.workers.dev`;
  // The address the app will have, once the parts make one.
  const shownUrl =
    place === "workers"
      ? workerName === ""
        ? null
        : `https://${workerName}.${workersDevLabel}`
      : zoneCheck?.ok === true
        ? `https://${zoneCheck.hostname}`
        : externalCheck?.ok === true
          ? `https://${externalCheck.hostname}`
          : null;
  const loadingZones = withDomains && zones === null && zonesError === null;
  // Each lookup's error shows only with the choice it serves.
  const loadError = place === "external" ? externalError : place === "workers" ? null : zonesError;
  const showNames = useTechnicalNames();
  const domainOptions = domainGroups({
    workersDev: workersDevLabel,
    zones: withDomains ? (zones?.zones ?? null) : [],
    loading: loadingZones,
    missing: zones?.missing ?? [],
    withDomains,
    wildcard: wildcard !== null,
  });
  const shownDomain = (v: unknown): string => {
    if (v === "workers") return `.${workersDevLabel}`;
    if (v === "external") return "Another domain";
    const name = zones?.zones.find((z) => `zone:${z.id}` === v)?.name;
    // The domains are still read: nothing to put after a dot yet.
    if (name === undefined) return "Your domain…";
    // The domain itself when no name is typed: no dot in front.
    return typedName.trim() === "" ? name : `.${name}`;
  };

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-2 font-semibold text-kumo-default text-lg">Address</legend>
      {/* One field in three parts: the scheme, the name you type, and the domain,
          a dropdown pinned at the right edge. The parts are siblings, so the
          dropdown is never inside the text field's label. */}
      {/* The manager's layered card (Kumo's LayerCard, as every section uses): the
          field is the raised layer on top, and the line about it is the tray
          beneath, always there and one line tall, so nothing moves as it changes. */}
      <LayerCard data-address-card="" className="min-w-0 rounded-xl">
        <LayerCard.Primary
          data-address-control=""
          data-invalid={error === null ? undefined : ""}
          className={cn(
            "h-11 flex-row items-stretch gap-0 rounded-xl p-0 pr-0",
            "focus-within:ring-[1.5px] focus-within:ring-kumo-focus/50",
            error !== null && "ring-kumo-danger focus-within:ring-kumo-danger",
          )}
        >
          <InputGroup
            size="lg"
            className="h-full min-w-0 flex-1 rounded-none bg-transparent shadow-none ring-0 focus-within:ring-0"
          >
            {/* A phone has no room for the scheme; the address still reads whole without it. */}
            <InputGroup.Addon className="max-sm:hidden">https://</InputGroup.Addon>
            <InputGroup.Input
              id={inputId}
              aria-label={left.label}
              aria-invalid={error !== null}
              aria-describedby={[
                statusId,
                noteId,
                ...(consequence === null ? [] : [consequenceId]),
              ].join(" ")}
              value={left.value}
              onChange={(e) => left.onChange(e.currentTarget.value)}
              onBlur={() => setTouched(true)}
              readOnly={left.readOnly}
              maxLength={left.maxLength}
              placeholder={left.placeholder}
              autoComplete="off"
              spellCheck={false}
              passwordManagerIgnore
              required={!place.startsWith("zone:")}
              className="font-medium text-kumo-default max-sm:text-sm"
            />
          </InputGroup>
          <DomainPicker
            options={domainOptions}
            value={place}
            shown={shownDomain(place)}
            disabled={disabled || !withDomains}
            onChange={(next) => {
              setPlace(next);
              setTouched(false);
              setWholeDomain(false);
            }}
          />
        </LayerCard.Primary>
        {/* Announced as it changes; one line tall in every state. */}
        <LayerCard.Secondary
          id={statusId}
          data-address-tray=""
          // One line tall; on a phone two, where a reason needs them, in every state alike.
          className="my-0 h-9 min-w-0 gap-1.5 px-3 py-0 font-normal text-sm max-sm:h-[3.25rem]"
        >
          <TrayLine status={status} url={shownUrl} />
          {/* Announced: the name's state only, not the address that changes with each key. */}
          <span role="status" className="sr-only">
            {status?.text ?? ""}
          </span>
        </LayerCard.Secondary>
      </LayerCard>

      <p id={noteId} className={cn("m-0 text-kumo-subtle text-sm", note === null && "hidden")}>
        {note}
        {note !== null && place.startsWith("zone:") && wildcard === null && (
          <>
            {" "}
            <MoreText more={ZONE_DETAIL}>{""}</MoreText>
          </>
        )}
      </p>
      {place === "workers" && showNames && otherWorkers.length > 0 && (
        <p className="m-0 text-kumo-subtle text-sm">{workersNote(otherWorkers)}</p>
      )}

      {place !== "workers" && (
        <WorkerNameLine
          workerName={workerName}
          onChange={onWorkerNameChange}
          check={check}
          problem={nameProblem}
          fixed={fixedWorkerName}
          open={showNameField}
          onOpen={() => setEditingName(true)}
          subdomain={subdomain}
          otherWorkers={otherWorkers}
        />
      )}

      {wildcard !== null && place === "workers" && (
        <Text variant="secondary" size="sm">
          {wildcard.reason} {WILDCARD_EXTERNAL_REFUSAL}
        </Text>
      )}

      {consequence !== null && (
        // The address field's description points here, so the choices are read with it.
        <div id={consequenceId}>
          <Banner
            variant="alert"
            icon={<WarningIcon weight="fill" />}
            title={consequence.title}
            description={consequence.description}
          />
        </div>
      )}

      {loadError !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={loadError} />
      )}

      {wildcard !== null && zone !== null && zoneCheck?.ok === true && (
        <WildcardNotes
          zoneName={zone.name}
          base={zoneCheck.hostname}
          wholeDomain={"wholeDomain" in zoneCheck && zoneCheck.wholeDomain === true}
          agreed={wholeDomain}
          onAgree={setWholeDomain}
          disabled={disabled}
        />
      )}

      {place === "external" && external !== null && gateway === null && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="The gateway for other domains is not set up"
          description={
            <span>
              Set it up once in the{" "}
              <Link
                href={settingsLink("domains", "external-domains")}
                target="_blank"
                rel="noopener"
              >
                domains settings
              </Link>
              , or install on workers.dev and add the domain later.
            </span>
          }
        />
      )}
      {place === "external" && gateway !== null && (
        <div className="mt-1 grid gap-2 rounded-lg border border-kumo-hairline bg-kumo-base p-3">
          <Radio.Group
            legend="Is the hostname in use already?"
            value={method}
            onValueChange={(v) => {
              if (VALIDATION_METHODS.includes(v as ValidationMethod))
                setMethod(v as ValidationMethod);
            }}
            orientation="horizontal"
            disabled={disabled}
            className="[&>div]:flex-wrap [&>div]:gap-x-6 [&>div]:gap-y-2"
          >
            <Radio.Item value="http" label="Not yet" />
            <Radio.Item value="txt" label="Yes, it shows another site" />
          </Radio.Group>
          <Text variant="secondary" size="sm">
            <MoreText more={EXTERNAL_DOMAIN_COST}>{VALIDATION_LABELS[method].help}</MoreText>
          </Text>
        </div>
      )}
    </fieldset>
  );
}

/** One choice of the domain picker. */
export interface DomainOption {
  value: AddressPlace | "loading" | "none";
  label: string;
  disabled?: true;
}

/** The picker's choices in their groups: workers.dev, the account's domains, elsewhere. */
export interface DomainGroup {
  value: string;
  items: DomainOption[];
}

/**
 * The domain picker's groups: the account's workers.dev subdomain first,
 * then the account's domains (a waiting or an empty note while there are
 * none to pick), then another domain, which an app that needs a wildcard
 * hostname cannot use.
 */
export function domainGroups(input: {
  workersDev: string;
  /** The account's active domains; null while they are read. */
  zones: readonly { id: string; name: string }[] | null;
  loading: boolean;
  /** Permissions the token lacks to list the domains. */
  missing: readonly string[];
  withDomains: boolean;
  wildcard: boolean;
}): DomainGroup[] {
  const groups: DomainGroup[] = [
    { value: "workers.dev", items: [{ value: "workers", label: input.workersDev }] },
  ];
  if (!input.withDomains) return groups;
  const zones = input.zones ?? [];
  groups.push({
    value: input.wildcard ? "Your domains, with every name under it" : "Your domains",
    items:
      zones.length > 0
        ? zones.map((z) => ({ value: `zone:${z.id}` as const, label: z.name }))
        : input.loading || input.zones === null
          ? [{ value: "loading", label: "Reading your domains…", disabled: true }]
          : [
              {
                value: "none",
                label:
                  input.missing.length > 0
                    ? `None the token can see (it may lack ${input.missing.join(", ")})`
                    : "No active domain on this account",
                disabled: true,
              },
            ],
  });
  if (!input.wildcard) {
    groups.push({
      value: "Elsewhere",
      items: [{ value: "external", label: "Another domain, managed elsewhere…" }],
    });
  }
  return groups;
}

/**
 * Whether a choice stays in the picker for what is typed in its search:
 * a domain whose name holds the words, and always the notes and "Another
 * domain" (the way out when none of the account's domains is the one).
 */
export function domainMatches(option: DomainOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "" || option.value === "external" || option.disabled === true) return true;
  return option.label.toLowerCase().includes(q);
}

/**
 * The domain part of the address: Kumo's Combobox, its trigger showing the
 * chosen domain, and a search field at the top of its list, since an
 * account may hold many domains.
 */
function DomainPicker({
  options,
  value,
  shown,
  disabled,
  onChange,
}: {
  options: DomainGroup[];
  value: AddressPlace;
  /** What the trigger shows (".example.com", "example.com", "Another domain"). */
  shown: string;
  disabled: boolean;
  onChange(place: AddressPlace): void;
}) {
  const [query, setQuery] = useState("");
  const selected = options.flatMap((g) => g.items).find((o) => o.value === value) ?? null;
  const zoneOptions = options.find((g) => g.value.startsWith("Your domains"))?.items ?? [];
  const realZones = zoneOptions.filter((o) => o.disabled !== true);
  const noMatch =
    query.trim() !== "" && realZones.length > 0 && !realZones.some((o) => domainMatches(o, query));
  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(next) => {
        const option = next as DomainOption | null;
        if (option !== null && option.disabled !== true) onChange(option.value as AddressPlace);
      }}
      isItemEqualToValue={(a: DomainOption, b: DomainOption) => a.value === b.value}
      itemToStringLabel={(o: DomainOption) => o.label}
      filter={(o: DomainOption, q: string) => domainMatches(o, q)}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      onOpenChange={(open: boolean) => {
        if (!open) setQuery("");
      }}
      disabled={disabled}
    >
      <Combobox.Trigger
        aria-label={`Domain of the address: ${shown}`}
        className={cn(
          // Pinned at the right, split from the name by a hairline, as wide as its domain.
          // On a phone it takes at most two thirds of the field and truncates.
          "flex h-full w-max min-w-0 shrink-0 cursor-pointer items-center gap-1.5 border-0 border-kumo-hairline border-l bg-kumo-base px-3 max-sm:max-w-[65%]",
          "text-base text-kumo-subtle max-sm:text-sm",
          "hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50 focus-visible:ring-inset",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{shown}</span>
        <Combobox.Icon className="flex shrink-0 items-center">
          <CaretUpDownIcon aria-hidden className="size-4" />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Content align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <Combobox.Input placeholder="Search your domains…" aria-label="Search your domains" />
        {noMatch && (
          <p className="m-0 px-3.5 pb-1 text-kumo-subtle text-sm">
            No domain of yours matches “{query.trim()}”.
          </p>
        )}
        <Combobox.List>
          {(group: DomainGroup) => (
            <Combobox.Group key={group.value} items={group.items}>
              {group.value !== "workers.dev" && (
                <Combobox.GroupLabel>{group.value}</Combobox.GroupLabel>
              )}
              <Combobox.Collection>
                {(option: DomainOption) => (
                  <Combobox.Item
                    key={option.value}
                    value={option}
                    disabled={option.disabled === true}
                  >
                    <span translate="no">{option.label}</span>
                  </Combobox.Item>
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

/** "Also runs as open-seo-audit." for an app of several Workers; null for one. */
function workersNote(otherWorkers: readonly string[]): ReactNode {
  if (otherWorkers.length === 0) return null;
  return (
    <>
      Its other Worker{otherWorkers.length === 1 ? " is" : "s are"} named after it:{" "}
      {otherWorkers.map((name, i) => (
        <span key={name} className="whitespace-nowrap" translate="no">
          {i > 0 && ", "}
          {name}
        </span>
      ))}
      .
    </>
  );
}

/**
 * The tray's one line: the name's state in its colour (with the address
 * the app will have beside it, from a tablet up), or, with nothing to say,
 * just that address. Every state is one line, so the tray never changes
 * height as the name is typed, checked or the domain is switched.
 */
function TrayLine({ status, url }: { status: AddressStatus | null; url: string | null }) {
  const icon: Record<AddressStatus["tone"], ReactNode> = {
    success: <CheckCircleIcon aria-hidden weight="fill" className="shrink-0 text-kumo-success" />,
    warning: <WarningCircleIcon aria-hidden weight="fill" className="shrink-0 text-kumo-warning" />,
    danger: <XCircleIcon aria-hidden weight="fill" className="shrink-0 text-kumo-danger" />,
    pending: <AppflareLoader size="sm" />,
    neutral: <InfoIcon aria-hidden className="shrink-0 text-kumo-subtle" />,
  };
  const address =
    url === null ? null : (
      <span className="min-w-0 truncate text-kumo-subtle" translate="no">
        {url}
      </span>
    );
  // A reason or a warning may take a second line on a phone.
  const reason = status?.tone === "danger" || status?.tone === "warning";
  if (status === null) {
    return (
      <span data-address-status="address" className="flex min-w-0 items-center gap-1.5">
        <GlobeHemisphereWestIcon aria-hidden className="shrink-0 text-kumo-subtle" />
        {address ?? <span className="text-kumo-subtle">Type a name for the address.</span>}
      </span>
    );
  }
  return (
    <span
      data-address-status={status.tone}
      className="flex w-full min-w-0 items-center justify-between gap-3"
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          status.tone === "success" && "text-kumo-success",
          status.tone === "warning" && "text-kumo-warning",
          status.tone === "danger" && "text-kumo-danger",
          (status.tone === "neutral" || status.tone === "pending") && "text-kumo-subtle",
        )}
      >
        {icon[status.tone]}
        {/* A reason may take a second line on a phone; the tray keeps room for it. */}
        <span
          data-address-status-text=""
          className={cn("min-w-0", reason ? "line-clamp-2" : "truncate")}
          title={reason ? status.text : undefined}
        >
          {status.text}
        </span>
      </span>
      {/* The address beside a short state; a reason or a note keeps the whole line. */}
      {(status.tone === "success" || status.tone === "pending") && address !== null && (
        <span className="flex min-w-0 max-sm:hidden">{address}</span>
      )}
    </span>
  );
}

/**
 * The Worker name while the address is a domain: one quiet line with the
 * name and its state, and "Change", which opens its field. The field is
 * open from the start while the name is taken or breaks the rules.
 */
function WorkerNameLine({
  workerName,
  onChange,
  check,
  problem,
  fixed,
  open,
  onOpen,
  subdomain,
  otherWorkers,
}: {
  workerName: string;
  onChange(name: string): void;
  check: WorkerNameCheck | null;
  problem: string | null;
  fixed: boolean;
  open: boolean;
  onOpen(): void;
  subdomain: string | null;
  otherWorkers: readonly string[];
}) {
  if (open) {
    // A field with one job: its state sits inside it at the right, as Kumo's
    // InputGroup shows one; only why a name cannot be used gets words, below.
    return (
      <div className="mt-1">
        <InputGroup
          label="Worker name"
          size="sm"
          description="Its resources are named after it. Each install of an app needs its own."
          error={problem === null ? undefined : { message: problem, match: true }}
        >
          <InputGroup.Input
            aria-label="Worker name"
            value={workerName}
            onChange={(e) => onChange(e.currentTarget.value.trim())}
            autoComplete="off"
            spellCheck={false}
            passwordManagerIgnore
            required
            maxLength={WORKER_NAME_MAX_LENGTH}
          />
          <InputGroup.Suffix>.{subdomain ?? "<your subdomain>"}.workers.dev</InputGroup.Suffix>
          {check !== null && check.state !== "unknown" && (
            <InputGroup.Addon align="end">
              <span data-name-check={check.state} className="flex">
                {check.state === "checking" ? (
                  <AppflareLoader />
                ) : check.state === "free" ? (
                  <CheckCircleIcon
                    aria-label="Available"
                    weight="fill"
                    className="text-kumo-success"
                  />
                ) : (
                  <XCircleIcon aria-hidden weight="fill" className="text-kumo-danger" />
                )}
              </span>
            </InputGroup.Addon>
          )}
        </InputGroup>
        <span role="status" className="sr-only">
          {check?.state === "free" ? "Available" : (problem ?? "")}
        </span>
      </div>
    );
  }
  return (
    // One line of text that wraps as text, its icons and "Change" inline.
    <p className="m-0 text-kumo-subtle text-sm">
      <GlobeHemisphereWestIcon aria-hidden className="mr-1.5 inline align-[-2px]" />
      Runs as the Worker{" "}
      <span className="font-medium text-kumo-default" translate="no">
        {workerName}
      </span>
      {otherWorkers.length > 0 && (
        <>
          {" "}
          (and{" "}
          <span className="whitespace-nowrap" translate="no">
            {otherWorkers.join(", ")}
          </span>
          )
        </>
      )}
      {check?.state === "free" && (
        <CheckCircleIcon
          aria-label="available"
          weight="fill"
          className="ml-1.5 inline align-[-2px] text-kumo-success"
        />
      )}{" "}
      {!fixed && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="inline-flex align-baseline"
          onClick={onOpen}
        >
          Change
        </Button>
      )}
    </p>
  );
}
