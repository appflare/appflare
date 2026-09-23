import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  Input,
  LayerCard,
  Link,
  LinkButton,
  Loader,
  Select,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  GlobeIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { accountTokenTemplateUrl } from "../cloudflare/token-template";
import { checkHostnameInZone } from "../installs/custom-domain-input";
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
import { formatTime } from "./format";
import { HealthBadge } from "./install-health";

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
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" as="h2">
          Custom domains
        </Text>
        {canAdd && <AddDomainDialog install={install} />}
      </div>
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
    </section>
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

function DialogHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1.5">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
      </div>
      <Dialog.Close
        aria-label="Close"
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            shape="square"
            icon={<XIcon />}
            aria-label="Close"
          />
        )}
      />
    </div>
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
            <Link href="/settings">Settings</Link> with Rotate token.
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
 * Pick a zone, type a hostname in it, add. When the hostname already has DNS
 * records, the server answers with them instead of adding; the admin must tick
 * that they may be replaced, and the next submit asks Cloudflare to replace
 * them.
 */
function AddDomainDialog({ install }: { install: InstallDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DomainOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
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
    setHostname("");
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
  const checked = zone === null ? null : checkHostnameInZone(hostname, zone.name);
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary" icon={<PlusIcon />}>
            Add a domain
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <DialogHeader
          title="Add a custom domain"
          description={`Serve ${install.instanceName} on a hostname in one of your domains on Cloudflare. Cloudflare creates its DNS record and certificate; the workers.dev URL keeps working.`}
        />
        {options === null && loadError === null && (
          <div className="flex items-center gap-2">
            <Loader size="sm" />
            <Text variant="secondary">Reading the account's domains…</Text>
          </div>
        )}
        {loadError !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={loadError} />
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
          <form className="grid gap-4" onSubmit={onSubmit}>
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
            <Input
              label="Hostname"
              placeholder={zone === null ? "app.example.com" : `app.${zone.name}`}
              value={hostname}
              onChange={(e) => {
                setHostname(e.currentTarget.value);
                resetConflict();
              }}
              onBlur={() => setTouched(true)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending || zone === null}
              error={hostnameError}
              description={
                zone === null
                  ? "Choose a domain first."
                  : `${zone.name} itself or a name under it, such as app.${zone.name}.`
              }
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
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button {...props} disabled={pending}>
                    Cancel
                  </Button>
                )}
              />
              <Button
                type="submit"
                variant="primary"
                icon={<GlobeIcon />}
                loading={pending}
                disabled={zone === null || (conflict !== null && !replace)}
              >
                {conflict !== null ? "Replace records and add" : "Add domain"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Dialog.Root>
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
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  }

  async function onRemove() {
    setPending(true);
    setError(null);
    try {
      await removeCustomDomain({ data: { installId, resourceId: domain.id } });
      setOpen(false);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the domain.");
    }
    setPending(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
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
      />
      <Dialog className="grid gap-6 px-6 py-5">
        <DialogHeader
          title={`Remove ${domain.hostname}?`}
          description="The app stops answering on this hostname. The workers.dev URL keeps working."
        />
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} disabled={pending}>
                Cancel
              </Button>
            )}
          />
          <Button variant="destructive" loading={pending} onClick={onRemove}>
            Remove domain
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
