import { Banner, Checkbox } from "@cloudflare/kumo";
import { InfoIcon, WarningIcon } from "@phosphor-icons/react";
import {
  wholeDomainConsent,
  wholeDomainWarning,
  wildcardCertificateNote,
  wildcardPattern,
} from "../installs/wildcard-domain-input";

/**
 * What the admin should know about a wildcard base before adding it: the
 * pattern it serves, and either the agreement the zone itself needs or the
 * certificate a name below the zone needs. Shared by the app page and the
 * install form.
 */
export function WildcardNotes({
  zoneName,
  base,
  wholeDomain,
  agreed,
  onAgree,
  disabled,
}: {
  zoneName: string;
  base: string;
  wholeDomain: boolean;
  agreed: boolean;
  onAgree(agreed: boolean): void;
  disabled: boolean;
}) {
  if (wholeDomain) {
    return (
      <div className="grid gap-3">
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title={`The app gets ${zoneName} and ${wildcardPattern(zoneName)}`}
          description={wholeDomainWarning(zoneName)}
        />
        <Checkbox
          checked={agreed}
          onCheckedChange={(v: boolean) => onAgree(v)}
          disabled={disabled}
          label={wholeDomainConsent(zoneName)}
        />
      </div>
    );
  }
  return (
    <Banner
      variant="secondary"
      icon={<InfoIcon weight="fill" />}
      title={`Names under ${base} need a certificate`}
      description={wildcardCertificateNote(base, zoneName)}
    />
  );
}
