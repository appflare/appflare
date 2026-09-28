import { Banner, Input, Link, Radio, Select, Text } from "@cloudflare/kumo";
import { InfoIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  checkExternalHostname,
  EXTERNAL_DOMAIN_COST,
  type ValidationMethod,
} from "../gateway/gateway";
import { checkSubdomainInZone } from "../installs/custom-domain-input";
import { getDomainOptions } from "../installs/custom-domains.functions";
import type { DomainOptions } from "../installs/custom-domains.server";
import type { ExternalDomainOptions } from "../installs/external-domain-input";
import { getExternalDomainOptions } from "../installs/external-domains.functions";
import type { InstallDomainInput } from "../installs/install-input";
import {
  checkWildcardSubdomain,
  WILDCARD_EXPLAINER,
  WILDCARD_EXTERNAL_REFUSAL,
} from "../installs/wildcard-domain-input";
import { WORKERS_DEV_COPY } from "../installs/workers-dev";
import { AppflareLoader } from "./appflare-loader";
import { ValidationChoice } from "./external-domains-section";
import { settingsLink } from "./settings-links";
import { WildcardNotes } from "./wildcard-notes";
import { ZoneHostnameField } from "./zone-hostname-field";

type Choice = "none" | "custom" | "external" | "wildcard";

const mono = "font-mono text-[0.9em]";

/**
 * The install form's address choice: workers.dev only (the default), a
 * custom domain (a hostname in one of the account's zones), or an external
 * domain (a hostname elsewhere, through the gateway). The install job adds
 * the domain once the Worker serves; a domain that cannot be added then does
 * not fail the install. `onChange` reports the domain to send (null for none)
 * and whether the choice is complete.
 *
 * An app that needs every name under one hostname (`wildcard`) is offered a
 * wildcard domain instead of both: a base in one of the account's zones,
 * served with every name under it. External domains cannot do that below
 * Cloudflare's Enterprise plan, and the section says so.
 */
export function InstallDomainFields({
  disabled,
  onChange,
  wildcard,
}: {
  disabled: boolean;
  /** The app's manifest sets `install.wildcardHostname`, with its reason; null otherwise. */
  wildcard: { reason: string } | null;
  /** A state setter (stable). */
  onChange(domain: InstallDomainInput | null, complete: boolean): void;
}) {
  const [choice, setChoice] = useState<Choice>("none");
  const [custom, setCustom] = useState<DomainOptions | null>(null);
  const [external, setExternal] = useState<ExternalDomainOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  /** Custom domain: what comes before the zone (empty for its root). */
  const [subdomain, setSubdomain] = useState("");
  /** External domain: the whole hostname. */
  const [hostname, setHostname] = useState("");
  const [touched, setTouched] = useState(false);
  const [method, setMethod] = useState<ValidationMethod>("http");
  /** Wildcard domain on the zone itself: the admin agreed every name in it reaches the app. */
  const [wholeDomain, setWholeDomain] = useState(false);
  const inZone = choice === "custom" || choice === "wildcard";

  // Read the zones and the gateway the first time a domain is chosen.
  useEffect(() => {
    if (choice === "none") return;
    let live = true;
    const load =
      choice === "custom" || choice === "wildcard"
        ? custom === null
          ? getDomainOptions().then((o) => {
              if (!live) return;
              setCustom(o);
              const [only] = o.zones;
              if (o.zones.length === 1 && only !== undefined) setZoneId(only.id);
            })
          : null
        : external === null
          ? getExternalDomainOptions().then((o) => live && setExternal(o))
          : null;
    load?.catch((err: unknown) => {
      if (live) setLoadError(err instanceof Error ? err.message : "Could not read the domains.");
    });
    return () => {
      live = false;
    };
  }, [choice, custom, external]);

  const zone = custom?.zones.find((z) => z.id === zoneId) ?? null;
  const customCheck = zone === null ? null : checkSubdomainInZone(subdomain, zone.name);
  const wildcardCheck = zone === null ? null : checkWildcardSubdomain(subdomain, zone.name);
  const gateway = external?.gateway ?? null;
  const externalCheck =
    gateway === null
      ? null
      : checkExternalHostname(hostname, {
          gateway: gateway.zoneName,
          account: external?.accountZones ?? [],
        });
  const check =
    choice === "custom"
      ? customCheck
      : choice === "wildcard"
        ? wildcardCheck
        : choice === "external"
          ? externalCheck
          : null;
  const hostnameError = touched && check !== null && !check.ok ? check.error : undefined;

  const chosen: InstallDomainInput | null =
    choice === "custom" && customCheck?.ok === true && zone !== null
      ? { kind: "custom", zoneId: zone.id, hostname: customCheck.hostname }
      : choice === "wildcard" &&
          wildcardCheck?.ok === true &&
          zone !== null &&
          (!wildcardCheck.wholeDomain || wholeDomain)
        ? {
            kind: "wildcard",
            zoneId: zone.id,
            hostname: wildcardCheck.hostname,
            ...(wildcardCheck.wholeDomain ? { wholeDomain: true } : {}),
          }
        : choice === "external" && externalCheck?.ok === true
          ? { kind: "external", hostname: externalCheck.hostname, validation: method }
          : null;
  // Reported by value, so an unchanged choice does not update the form again.
  const reported = JSON.stringify(chosen);
  const complete = choice === "none" || chosen !== null;
  useEffect(() => {
    onChange(JSON.parse(reported) as InstallDomainInput | null, complete);
  }, [reported, complete, onChange]);

  const loading = (inZone && custom === null) || (choice === "external" && external === null);

  return (
    <div className="grid gap-4">
      <Radio.Group
        legend="Address"
        description="The install adds a domain once the app runs."
        value={choice}
        onValueChange={(v) => {
          setChoice(v === "custom" || v === "external" || v === "wildcard" ? v : "none");
          setTouched(false);
          setLoadError(null);
          setWholeDomain(false);
        }}
        disabled={disabled}
        appearance="card"
      >
        <Radio.Item
          value="none"
          label="workers.dev only"
          description="The app answers on its workers.dev URL. Domains can be added on its page later."
        />
        {wildcard === null ? (
          <>
            <Radio.Item
              value="custom"
              label="Custom domain"
              description="A hostname in one of this account's domains. Cloudflare creates its DNS record and certificate."
            />
            <Radio.Item
              value="external"
              label="External domain"
              description="A hostname whose DNS is managed elsewhere. Its owner adds a CNAME to the gateway."
            />
          </>
        ) : (
          <Radio.Item
            value="wildcard"
            label="Wildcard domain"
            description={`A hostname in one of this account's domains, with every name under it. ${wildcard.reason}`}
          />
        )}
      </Radio.Group>

      {wildcard !== null && (
        <Text variant="secondary" size="sm">
          {choice === "wildcard" ? WILDCARD_EXPLAINER : WILDCARD_EXTERNAL_REFUSAL}
        </Text>
      )}

      {choice !== "none" && (
        <Text variant="secondary" size="sm">
          {WORKERS_DEV_COPY.installNote}. Serve on workers.dev on the app's page turns it back on.
        </Text>
      )}

      {loading && loadError === null && (
        <div className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Reading the account's domains…</Text>
        </div>
      )}
      {loadError !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={loadError} />
      )}

      {inZone && custom !== null && custom.zones.length === 0 && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="No domain of this account can serve an app"
          description={
            custom.missing.length > 0
              ? `The token may lack ${custom.missing.join(", ")}, or the account has no active domain.`
              : "None of the account's domains is active yet."
          }
        />
      )}
      {inZone && custom !== null && custom.zones.length > 0 && (
        <>
          <Select
            label="Domain"
            placeholder="Choose a domain"
            value={zoneId}
            onValueChange={(v) => {
              setZoneId(typeof v === "string" ? v : null);
              setWholeDomain(false);
            }}
            items={Object.fromEntries(custom.zones.map((z) => [z.id, z.name]))}
            disabled={disabled}
          />
          <ZoneHostnameField
            zoneName={zone?.name ?? null}
            value={subdomain}
            onChange={(next) => {
              setSubdomain(next);
              setWholeDomain(false);
            }}
            onBlur={() => setTouched(true)}
            checked={choice === "wildcard" ? wildcardCheck : customCheck}
            error={hostnameError}
            disabled={disabled}
            wildcard={choice === "wildcard"}
            hint={
              choice === "wildcard"
                ? "If a name already has DNS records or routes, the install leaves them; add the domain on the app's page then."
                : "If it already has DNS records, the install leaves them; add the domain on the app's page then."
            }
          />
          {choice === "wildcard" && zone !== null && wildcardCheck?.ok === true && (
            <WildcardNotes
              zoneName={zone.name}
              base={wildcardCheck.hostname}
              wholeDomain={wildcardCheck.wholeDomain}
              agreed={wholeDomain}
              onAgree={setWholeDomain}
              disabled={disabled}
            />
          )}
        </>
      )}

      {choice === "external" && external !== null && gateway === null && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title="The gateway for external domains is not set up"
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
              , or install with workers.dev only and add the domain later.
            </span>
          }
        />
      )}
      {choice === "external" && gateway !== null && (
        <>
          {/* A whole hostname, not a URL: no scheme in front, and no zone after it. */}
          <Input
            label="Hostname"
            error={hostnameError}
            description={
              externalCheck?.ok === true && externalCheck.apex
                ? `${externalCheck.hostname} is a whole domain (an apex). Its DNS host must support a CNAME at the apex (CNAME flattening or ALIAS).`
                : "One exact hostname whose DNS is managed outside this account."
            }
            disabled={disabled}
            placeholder="app.example.org"
            value={hostname}
            onChange={(e) => setHostname(e.currentTarget.value)}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            spellCheck={false}
          />
          <ValidationChoice value={method} onChange={setMethod} disabled={disabled} />
          <Banner
            variant="secondary"
            icon={<InfoIcon weight="fill" />}
            title="What the domain's owner adds"
            description={
              method === "http" ? (
                <span>
                  A CNAME from the hostname to <span className={mono}>{gateway.hostname}</span>. If
                  it is there before the install, the domain is usually live by the time the install
                  finishes.
                </span>
              ) : (
                <span>
                  TXT records the install shows once it has registered the name, then a CNAME to{" "}
                  <span className={mono}>{gateway.hostname}</span>.
                </span>
              )
            }
          />
          <Text variant="secondary" size="sm">
            {EXTERNAL_DOMAIN_COST}
          </Text>
        </>
      )}
    </div>
  );
}
