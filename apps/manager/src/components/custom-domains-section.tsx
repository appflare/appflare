import {
  Banner,
  Button,
  Checkbox,
  LayerCard,
  LayerDialog,
  Link,
  LinkButton,
  Loader,
  Select,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { accountTokenTemplateUrl } from "../cloudflare/token-template";
import { checkSubdomainInZone } from "../installs/custom-domain-input";
import {
  addCustomDomain,
  checkCustomDomain,
  getDomainOptions,
  removeCustomDomain,
} from "../installs/custom-domains.functions";
import type {
  ConflictingRecord,
  CustomDomainCheck,
  DomainOptions,
} from "../installs/custom-domains.server";
import type { CustomDomainView, InstallDetail } from "../installs/installs.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { formatTime } from "./format";
import { HealthBadge } from "./install-health";
import { Section } from "./section";
import { ZoneHostnameField } from "./zone-hostname-field";

/**
 * `/apps/$installId` → Custom domains (admins only): the hostnames that serve
 * the app besides its workers.dev URL, with "Add a domain", a one-off check of
 * each, and remove. Adding needs zone permissions the rest of Appflare does
 * not, so the add dialog says which ones the token lacks and how to add them.
 */
export function CustomDomainsSection({ install }: { install: InstallDetail }) {
  const canAdd = install.status === "installed" && install.activeJobId === null;
  const canRemove = install.status !== "uninstalling" && install.status !== "uninstalled";
  return (
    <Section
      title="Custom domains"
      actions={canAdd ? <AddDomainDialog install={install} /> : undefined}
    >
      {install.domains.length === 0 ? (
        <Text variant="secondary">
          The app is served on its workers.dev URL only. Add a hostname in one of your domains on
          Cloudflare to serve it there too.
        </Text>
      ) : (
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Hostname</Table.Head>
                <Table.Head>Check</Table.Head>
                <Table.Head>
                  <span className="sr-only">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {install.domains.map((domain) => (
                <Table.Row key={domain.id}>
                  <Table.Cell>
                    <Link href={domain.url} target="_blank" rel="noopener noreferrer">
                      {domain.hostname}
                      <Link.ExternalIcon />
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <DomainCheck
                      installId={install.id}
                      domain={domain}
                      enabled={install.status === "installed"}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end">
                      {canRemove && <RemoveDomainDialog installId={install.id} domain={domain} />}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Section>
  );
}

/**
 * One probe of the app on this hostname, shown here and not recorded: the
 * install's health stays the check of its workers.dev URL.
 */
function DomainCheck({
  installId,
  domain,
  enabled,
}: {
  installId: string;
  domain: CustomDomainView;
  enabled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CustomDomainCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    setPending(true);
    setError(null);
    try {
      setResult(await checkCustomDomain({ data: { installId, resourceId: domain.id } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the domain.");
    }
    setPending(false);
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      {result !== null && (
        <>
          <HealthBadge status={result.status} />
          <Text as="span" variant="secondary" size="sm">
            {result.detail} at {formatTime(result.checkedAt)}
          </Text>
        </>
      )}
      {error !== null && (
        <Text as="span" variant="error" size="sm">
          {error}
        </Text>
      )}
      {enabled && (
        <Button
          size="sm"
          variant="secondary"
          icon={<ArrowsClockwiseIcon />}
          loading={pending}
          onClick={onCheck}
        >
          Check now
        </Button>
      )}
    </span>
  );
}

/**
 * What to change when the token cannot manage custom domains. Editing the
 * token's permissions in the dashboard keeps its value, so Appflare needs no
 * change; a new token replaces the old one under Settings.
 */
function TokenPermissionsBanner({ options }: { options: DomainOptions }) {
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
            value, so nothing changes here. Or create a new token and replace the old one under{" "}
            <Link href="/settings/account">Settings, Account and capabilities</Link> with Rotate
            token.
          </span>
        </span>
      }
      action={
        <LinkButton
          href={accountTokenTemplateUrl()}
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

function recordList(records: ConflictingRecord[]): string {
  return records.map((r) => (r.content === null ? r.type : `${r.type} ${r.content}`)).join(", ");
}

interface Conflict {
  hostname: string;
  records: ConflictingRecord[];
}

/**
 * Pick a zone, type the subdomain (nothing for the zone's root), add. When the hostname already has DNS
 * records, the server answers with them instead of adding; the admin must tick
 * that they may be replaced, and the next submit asks Cloudflare to replace
 * them.
 */
function AddDomainDialog({ install }: { install: InstallDetail }) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DomainOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [touched, setTouched] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [replace, setReplace] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) return;
    setOptions(null);
    setLoadError(null);
    setZoneId(null);
    setSubdomain("");
    setTouched(false);
    setConflict(null);
    setReplace(false);
    setError(null);
    getDomainOptions()
      .then((loaded) => {
        setOptions(loaded);
        const [only] = loaded.zones;
        if (loaded.zones.length === 1 && only !== undefined) setZoneId(only.id);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : "Could not read the account's domains."),
      );
  }

  const zone = options?.zones.find((z) => z.id === zoneId) ?? null;
  // `subdomain` is what comes before the zone; empty means the zone itself.
  const checked = zone === null ? null : checkSubdomainInZone(subdomain, zone.name);
  const hostnameError = touched && checked !== null && !checked.ok ? checked.error : undefined;

  function resetConflict() {
    setConflict(null);
    setReplace(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (zone === null || checked === null || !checked.ok || pending) return;
    if (conflict !== null && !replace) return;
    setPending(true);
    setError(null);
    try {
      const result = await addCustomDomain({
        data: {
          installId: install.id,
          zoneId: zone.id,
          hostname: checked.hostname,
          ...(conflict !== null && replace ? { overrideExistingDnsRecord: true } : {}),
        },
      });
      if (result.ok) {
        setOpen(false);
        await router.invalidate();
      } else {
        setConflict({ hostname: result.hostname, records: result.records });
        setReplace(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the domain.");
    }
    setPending(false);
  }

  const canSubmit = options !== null && options.zones.length > 0;
  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<PlusIcon />}>
            Add a domain
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Add a custom domain</LayerDialog.Title>
        <LayerDialog.Description>
          Serve {install.instanceName} on a hostname in one of your domains on Cloudflare.
          Cloudflare creates its DNS record and certificate; the workers.dev URL keeps working.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {options === null && loadError === null && (
              <div className="flex items-center gap-2">
                <Loader size="sm" />
                <Text variant="secondary">Reading the account's domains…</Text>
              </div>
            )}
            {loadError !== null && (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title={loadError}
              />
            )}
            {options !== null && options.missing.length > 0 && (
              <TokenPermissionsBanner options={options} />
            )}
            {options !== null && !options.noZones && options.zones.length === 0 && (
              <Text variant="secondary">
                None of the account's domains is active yet ({options.inactiveZones.join(", ")}). A
                domain can serve an app once Cloudflare shows it as active.
              </Text>
            )}
            {options !== null && options.zones.length > 0 && (
              <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
                <Select
                  label="Domain"
                  placeholder="Choose a domain"
                  value={zoneId}
                  onValueChange={(v) => {
                    setZoneId(typeof v === "string" ? v : null);
                    resetConflict();
                  }}
                  items={Object.fromEntries(options.zones.map((z) => [z.id, z.name]))}
                  disabled={pending}
                />
                <ZoneHostnameField
                  zoneName={zone?.name ?? null}
                  value={subdomain}
                  onChange={(next) => {
                    setSubdomain(next);
                    resetConflict();
                  }}
                  onBlur={() => setTouched(true)}
                  checked={checked}
                  error={hostnameError}
                  disabled={pending}
                />
                {conflict !== null && (
                  <div className="grid gap-3">
                    <Banner
                      variant="alert"
                      icon={<WarningIcon weight="fill" />}
                      title={`${conflict.hostname} already has DNS records`}
                      description={
                        conflict.records.length > 0
                          ? `Adding the domain replaces them: ${recordList(conflict.records)}. Whatever they point to stops receiving traffic for this hostname.`
                          : "Cloudflare reports DNS records at this hostname that the domain would replace. Whatever they point to stops receiving traffic for this hostname."
                      }
                    />
                    <Checkbox
                      checked={replace}
                      onCheckedChange={(v: boolean) => setReplace(v)}
                      disabled={pending}
                      label="Replace the existing DNS records with the one for this app"
                    />
                  </div>
                )}
                {error !== null && (
                  <Banner
                    variant="error"
                    icon={<WarningCircleIcon weight="fill" />}
                    title={error}
                  />
                )}
              </form>
            )}
          </div>
        </LayerDialog.Body>
        {canSubmit && (
          <LayerDialog.Actions dismissLabel="Cancel">
            <LayerDialog.Actions.Primary
              type="submit"
              form={formId}
              loading={pending}
              disabled={zone === null || (conflict !== null && !replace)}
            >
              {conflict !== null ? "Replace records and add" : "Add domain"}
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function RemoveDomainDialog({
  installId,
  domain,
}: {
  installId: string;
  domain: CustomDomainView;
}) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button
          {...p}
          variant="secondary-destructive"
          size="sm"
          icon={<TrashIcon />}
          aria-label={`Remove ${domain.hostname}`}
        >
          Remove
        </Button>
      )}
      title={`Remove ${domain.hostname}`}
      description="The app stops answering on this hostname. The workers.dev URL keeps working."
      actionLabel="Remove domain"
      onConfirm={async () => {
        await removeCustomDomain({ data: { installId, resourceId: domain.id } });
        await router.invalidate();
      }}
    />
  );
}
