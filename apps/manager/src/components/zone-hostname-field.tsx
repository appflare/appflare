import { InputGroup } from "@cloudflare/kumo";
import { type HostnameCheck, ROOT_DOMAIN_PLACEHOLDER } from "../installs/custom-domain-input";
import { wildcardPattern } from "../installs/wildcard-domain-input";

/**
 * A hostname in one of the account's zones, entered as the Cloudflare
 * dashboard does: the admin types the subdomain and the zone stays a fixed
 * suffix; left empty, it is the zone's root. The caller turns the value into
 * a hostname with checkSubdomainInZone and passes the result as `checked`,
 * so the field can say which hostname it means.
 */
export function ZoneHostnameField({
  zoneName,
  value,
  onChange,
  onBlur,
  checked,
  error,
  disabled,
  hint,
  wildcard,
}: {
  /** The chosen zone; null while none is chosen (the field is then disabled). */
  zoneName: string | null;
  value: string;
  onChange(value: string): void;
  onBlur(): void;
  checked: HostnameCheck | null;
  error: string | undefined;
  disabled: boolean;
  /** A sentence after the hostname the field means. */
  hint?: string;
  /** The app answers on every name under the hostname too (a wildcard domain). */
  wildcard?: boolean;
}) {
  const answers =
    checked?.ok === true
      ? wildcard === true
        ? `The app answers at https://${checked.hostname} and on every name under it (${wildcardPattern(checked.hostname)}).`
        : `The app answers at https://${checked.hostname}.`
      : null;
  const description =
    zoneName === null
      ? "Choose a domain first."
      : answers !== null
        ? `${answers}${hint === undefined ? "" : ` ${hint}`}`
        : `A name under ${zoneName}, or nothing for ${zoneName} itself.`;
  return (
    <InputGroup
      label="Subdomain"
      error={error === undefined ? undefined : { message: error, match: true }}
      description={description}
      disabled={disabled || zoneName === null}
    >
      {/* A hostname, not a URL: no scheme in front. */}
      <InputGroup.Input
        aria-label="Subdomain"
        placeholder={ROOT_DOMAIN_PLACEHOLDER}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
        autoComplete="off"
        spellCheck={false}
      />
      {zoneName !== null && <InputGroup.Addon align="end">.{zoneName}</InputGroup.Addon>}
    </InputGroup>
  );
}
