import { Link, Text } from "@cloudflare/kumo";
import { domainLabel } from "../installs/wildcard-domain-input";

/** What `DomainName` needs of a custom or wildcard domain (`CustomDomainView`). */
export interface NamedDomain {
  hostname: string;
  /** `https://<hostname>` */
  url: string;
  wildcard: boolean;
}

/**
 * A custom domain as a link that opens it; a wildcard domain as its pattern
 * (`*.tunnels.example.com`), linking to its base, with a line saying the base
 * answers too. Used wherever an install's domains are listed.
 */
export function DomainName({ domain, showUrl }: { domain: NamedDomain; showUrl?: boolean }) {
  const label = domain.wildcard
    ? domainLabel(domain)
    : showUrl === true
      ? domain.url
      : domain.hostname;
  return (
    <span className="grid gap-0.5">
      <Link href={domain.url} target="_blank" rel="noopener noreferrer">
        {showUrl === true && domain.wildcard ? `https://${label}` : label}
        <Link.ExternalIcon />
      </Link>
      {domain.wildcard && (
        <Text as="span" variant="secondary" size="sm">
          Every name under {domain.hostname}, and {domain.hostname} itself
        </Text>
      )}
    </span>
  );
}

/** Each domain as a `DomainName`, one per line; nothing for none. */
export function DomainNameList({
  domains,
  showUrl,
}: {
  domains: ReadonlyArray<NamedDomain & { id: string }>;
  showUrl?: boolean;
}) {
  if (domains.length === 0) return null;
  return (
    <ul className="grid gap-1">
      {domains.map((d) => (
        <li key={d.id}>
          <DomainName domain={d} {...(showUrl === undefined ? {} : { showUrl })} />
        </li>
      ))}
    </ul>
  );
}
