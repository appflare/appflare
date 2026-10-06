import { Banner, Checkbox, Link, LinkButton } from "@cloudflare/kumo";
import { KeyIcon, WarningIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { accountTokenTemplateUrl } from "../cloudflare/token-template";
import type { ConflictingRecord, DomainOptions } from "../installs/custom-domains.server";
import { settingsLink } from "./settings-links";

/**
 * Parts shared by the dialogs that attach a hostname in one of the
 * account's zones: an app's custom domain, and Appflare's own address.
 */

/**
 * What to change when the token cannot manage custom domains. Editing the
 * token's permissions in the dashboard keeps its value, so Appflare needs no
 * change; a new token replaces the old one under Settings. `accountId` opens
 * the dashboard in the right account; null lets it ask.
 */
export function TokenPermissionsBanner({
  options,
  accountId,
}: {
  options: Pick<DomainOptions, "missing" | "noZones">;
  accountId: string | null;
}) {
  const permissions = options.missing.join(", ");
  const title = options.noZones
    ? "Appflare cannot see any domain in this account"
    : "The Cloudflare token cannot manage custom domains yet";
  const why = options.noZones
    ? `Either the account has no domain on Cloudflare yet (add one first; it must be active before it can serve an app), or the token lacks the custom domain permissions: ${permissions}.`
    : `The token lacks ${permissions}.`;
  return (
    <Banner
      variant="alert"
      icon={<WarningIcon weight="fill" />}
      title={title}
      description={
        <span className="grid gap-1.5">
          <span>{why}</span>
          <span>
            To add them, open API Tokens in the Cloudflare dashboard, edit the Appflare token, add
            these permissions for the domains you want to use, and save. An edited token keeps its
            value, so nothing changes here. Or create a new token and replace the old one in the{" "}
            <Link href={settingsLink("account", "connection")} target="_blank" rel="noopener">
              Cloudflare connection settings
            </Link>{" "}
            with Change how Appflare connects.
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

/** A hostname whose DNS records a new custom domain would replace, as the server reported them. */
export interface DnsConflict {
  hostname: string;
  records: ConflictingRecord[];
}

function recordList(records: ConflictingRecord[]): string {
  return records.map((r) => (r.content === null ? r.type : `${r.type} ${r.content}`)).join(", ");
}

/**
 * The warning shown when the hostname already has DNS records, and the box
 * to tick before the next submit asks Cloudflare to replace them. `site`
 * names what stops answering when the hostname is the root of a zone, whose
 * records usually belong to a website. `permanent` says the records are
 * deleted for good. The box is described by the warning, so a screen
 * reader reads what ticking it agrees to.
 */
export function DnsConflictNotice({
  conflict,
  replace,
  onReplaceChange,
  disabled,
  checkboxLabel,
  site,
  permanent,
}: {
  conflict: DnsConflict;
  replace: boolean;
  onReplaceChange(replace: boolean): void;
  disabled: boolean;
  checkboxLabel: string;
  /** A sentence added to the warning, such as "Your site at example.com stops answering." */
  site?: string;
  /** A sentence saying the records cannot be restored, such as "Appflare cannot put them back." */
  permanent?: string;
}) {
  const warningId = useId();
  const replaced =
    conflict.records.length > 0
      ? `Adding the domain replaces them: ${recordList(conflict.records)}. Whatever they point to stops receiving traffic for this hostname.`
      : "Cloudflare reports DNS records at this hostname that the domain would replace. Whatever they point to stops receiving traffic for this hostname.";
  const description = [replaced, permanent, site].filter((s) => s !== undefined).join(" ");
  // Kumo's Checkbox passes `aria-describedby` on to the control, but its
  // props type does not list it; the spread keeps the type check quiet.
  const describedBy: Record<string, string> = { "aria-describedby": warningId };
  return (
    <div className="grid gap-3">
      <div id={warningId}>
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title={`${conflict.hostname} already has DNS records`}
          description={description}
        />
      </div>
      <Checkbox
        checked={replace}
        onCheckedChange={(v: boolean) => onReplaceChange(v)}
        disabled={disabled}
        label={checkboxLabel}
        {...describedBy}
      />
    </div>
  );
}
