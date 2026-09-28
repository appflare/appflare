import { Banner, Link, LinkButton, Select, Text } from "@cloudflare/kumo";
import {
  EnvelopeSimpleIcon,
  InfoIcon,
  KeyIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { accountTokenTemplateUrl } from "../cloudflare/token-template";
import { EMAIL_ROUTING_PERMISSIONS } from "../installs/email-routing";
import { getEmailZoneOptions, previewEmailRouting } from "../installs/email-routing.functions";
import type { EmailRoutingPreview, EmailZoneOptions } from "../installs/email-routing.server";
import { WORKER_NAME_PATTERN } from "../installs/install-input";
import { AppflareLoader } from "./appflare-loader";
import { settingsLink } from "./settings-links";
import { useAccountId } from "./use-account-id";

/** The records Cloudflare adds when it turns Email Routing on for a zone. */
const ROUTING_RECORDS =
  "MX records for route1, route2 and route3.mx.cloudflare.net, an SPF record (v=spf1 include:_spf.mx.cloudflare.net ~all) and a DKIM record";

/**
 * The install form's Email Routing fields, for an app whose manifest sets
 * `install.emailRouting`: a zone of the account (the active zones the token
 * can see) and a preview of what the install sets up there, read from the
 * Cloudflare API without changing anything. Anything in the way (a rule or
 * catch-all that already delivers elsewhere, another mail provider's MX
 * records, a missing permission) is shown here, and `onReadyChange(false)`
 * keeps the Install button off until it is resolved.
 */
export function EmailRoutingFields({
  slug,
  workerName,
  disabled,
  zoneId,
  onZoneChange,
  onReadyChange,
  headingLevel = "h3",
}: {
  slug: string;
  workerName: string;
  disabled: boolean;
  zoneId: string | null;
  /** A state setter (stable): the zones load once per form. */
  onZoneChange(zoneId: string | null): void;
  /** A state setter (stable). */
  onReadyChange(ready: boolean): void;
  /** The fields' heading, one level below the section they sit in. */
  headingLevel?: "h3" | "h4";
}) {
  const [options, setOptions] = useState<EmailZoneOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EmailRoutingPreview | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let live = true;
    getEmailZoneOptions()
      .then((loaded) => {
        if (!live) return;
        setOptions(loaded);
        const [only] = loaded.zones;
        if (loaded.zones.length === 1 && only !== undefined) onZoneChange(only.id);
      })
      .catch((err: unknown) => {
        if (live) {
          setLoadError(
            err instanceof Error ? err.message : "Could not read the account's domains.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, [onZoneChange]);

  const nameValid = WORKER_NAME_PATTERN.test(workerName);
  useEffect(() => {
    setPreview(null);
    setPreviewFailure(null);
    onReadyChange(false);
    if (zoneId === null || !nameValid) return;
    let live = true;
    setPreviewing(true);
    // The Worker name is typed; wait for a pause before reading the zone again.
    const timer = setTimeout(() => {
      previewEmailRouting({ data: { slug, zoneId, workerName } })
        .then((loaded) => {
          if (!live) return;
          setPreview(loaded);
          onReadyChange(loaded.problems.length === 0 && loaded.missing.length === 0);
        })
        .catch((err: unknown) => {
          if (live) {
            setPreviewFailure(
              err instanceof Error ? err.message : "Could not read Email Routing for that domain.",
            );
          }
        })
        .finally(() => {
          if (live) setPreviewing(false);
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug, zoneId, workerName, nameValid, onReadyChange]);

  const zoneName = options?.zones.find((z) => z.id === zoneId)?.name ?? null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text bold as={headingLevel}>
          Email
        </Text>
        <Text variant="secondary" size="sm">
          This app receives email through Cloudflare Email Routing. Choose the domain whose email it
          should receive; it must use Cloudflare DNS.
        </Text>
      </div>
      {options === null && loadError === null && (
        <div className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Reading the account's domains…</Text>
        </div>
      )}
      {loadError !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={loadError} />
      )}
      {options?.noZones && (
        <PermissionsBanner
          title="Appflare cannot see any domain in this account"
          missing={EMAIL_ROUTING_PERMISSIONS}
          why="Either the account has no domain on Cloudflare yet (add one and wait until it is active), or the token lacks the permissions receiving email needs."
        />
      )}
      {options !== null && !options.noZones && options.zones.length === 0 && (
        <Text variant="secondary">
          None of the account's domains is active yet ({options.inactiveZones.join(", ")}). A domain
          can receive email once Cloudflare shows it as active.
        </Text>
      )}
      {options !== null && options.zones.length > 0 && (
        <Select
          label="Domain"
          placeholder="Choose a domain"
          value={zoneId}
          onValueChange={(v) => onZoneChange(typeof v === "string" ? v : null)}
          items={Object.fromEntries(options.zones.map((z) => [z.id, z.name]))}
          disabled={disabled}
        />
      )}
      {zoneId !== null && previewing && preview === null && (
        <div className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Reading Email Routing on {zoneName ?? "the domain"}…</Text>
        </div>
      )}
      {previewFailure !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={previewFailure} />
      )}
      {preview !== null && <PreviewDetails preview={preview} workerName={workerName} />}
    </div>
  );
}

function PermissionsBanner({
  title,
  missing,
  why,
}: {
  title: string;
  missing: readonly string[];
  why: string;
}) {
  const accountId = useAccountId();
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title={title}
      description={
        <span className="grid gap-1.5">
          <span>{why}</span>
          <span>
            Needed: {missing.join(", ")}. Edit the Appflare token under API Tokens in the Cloudflare
            dashboard, add them for the domains you want to use, and save; an edited token keeps its
            value. Or create a new token and replace the old one in the{" "}
            <Link href={settingsLink("account", "connection")} target="_blank" rel="noopener">
              Cloudflare connection settings
            </Link>{" "}
            with Rotate token.
          </span>
        </span>
      }
      action={
        <LinkButton
          href={accountTokenTemplateUrl(accountId)}
          external
          variant="secondary"
          icon={<KeyIcon />}
        >
          Create a new token
        </LinkButton>
      }
    />
  );
}

/** What the install will set up on the zone, and anything that stops it. */
function PreviewDetails({
  preview,
  workerName,
}: {
  preview: EmailRoutingPreview;
  workerName: string;
}) {
  const zone = preview.zoneName ?? "the domain";
  const steps: string[] = [];
  if (preview.enablesRouting) {
    steps.push(`Turn Email Routing on for ${zone}. Cloudflare adds ${ROUTING_RECORDS}.`);
  }
  for (const a of preview.addresses) {
    steps.push(
      a.existingRuleId === null
        ? `Create a routing rule: mail to ${a.address} goes to the Worker "${workerName}".`
        : `Keep the routing rule that already sends ${a.address} to the Worker "${workerName}".`,
    );
  }
  if (preview.wantsCatchAll) {
    steps.push(
      preview.catchAll?.state === "ours"
        ? `Keep the catch-all of ${zone}, which already goes to the Worker "${workerName}".`
        : `Set the catch-all of ${zone}: mail to every other address goes to the Worker "${workerName}".`,
    );
  }
  return (
    <div className="grid gap-3">
      {preview.missing.length > 0 && (
        <PermissionsBanner
          title="The Cloudflare token cannot set up Email Routing yet"
          missing={preview.missing}
          why={`The token lacks permissions on ${zone} that the install needs.`}
        />
      )}
      {preview.problems.length > 0 && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title={`The app cannot receive email on ${zone} yet`}
          description={
            <ul className="grid list-disc gap-1 pl-5">
              {preview.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          }
        />
      )}
      {preview.warnings.map((w) => (
        <Banner key={w} variant="alert" icon={<WarningIcon weight="fill" />} title={w} />
      ))}
      {preview.problems.length === 0 && steps.length > 0 && (
        <Banner
          variant="secondary"
          icon={<EnvelopeSimpleIcon weight="fill" />}
          title={
            preview.routing?.enabled
              ? `Email Routing is on for ${zone}. The install will:`
              : "The install will:"
          }
          description={
            <span className="grid gap-2">
              <ul className="grid list-disc gap-1 pl-5">
                {steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <span>
                Uninstalling the app removes these again, and turns Email Routing off only if
                Appflare turned it on and no other rule is left on {zone}.
              </span>
            </span>
          }
        />
      )}
      {preview.sendsEmail === null && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="Whether this app also sends email is unknown until it is built"
          description="The app is built in this account when the install starts. If it sends email, it can send to the account's verified destination addresses for free; sending to other addresses needs Email Sending on Workers Paid."
        />
      )}
      {preview.sendsEmail === true && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="This app also sends email"
          description={
            preview.destinations === null
              ? "It can send to the account's verified destination addresses for free; sending to other addresses needs Email Sending on Workers Paid."
              : preview.destinations.length === 0
                ? "The account has no verified destination addresses yet. The app can send to those for free once you add and verify them (Email Service, Email Routing, Destination addresses); sending to other addresses needs Email Sending on Workers Paid."
                : `It can send for free to the account's verified destination addresses: ${preview.destinations.join(", ")}. Sending to other addresses needs Email Sending on Workers Paid.`
          }
        />
      )}
    </div>
  );
}
