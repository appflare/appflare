import {
  Banner,
  Button,
  Checkbox,
  LayerDialog,
  Link,
  LinkButton,
  Loader,
  Select,
  Table,
  Text,
  useKumoToastManager,
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
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
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
import {
  checkWildcardSubdomain,
  domainLabel,
  WILDCARD_EXPLAINER,
} from "../installs/wildcard-domain-input";
import { addWildcardDomain, removeWildcardDomain } from "../installs/wildcard-domains.functions";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { DomainName } from "./domain-name";
import { formatTime } from "./format";
import { HealthBadge } from "./install-health";
import { useJobStarted } from "./job-started";
import { PageSection } from "./page-section";
import { ResponsiveTable } from "./responsive-table";
import { settingsLink } from "./settings-links";
import { useAccountId } from "./use-account-id";
import { WildcardNotes } from "./wildcard-notes";
import { ZoneHostnameField } from "./zone-hostname-field";

/**
 * `/apps/$installId` → Custom domains (admins only): the hostnames that serve
 * the app besides its workers.dev URL, with "Add a domain", a one-off check of
 * each, and remove. Adding needs zone permissions the rest of Appflare does
 * not, so the add dialog says which ones the token lacks and how to add them.
 *
 * An app that needs every name under one hostname (`install.wildcard`) gets
 * a wildcard domain here instead, at most one, shown as its pattern.
 */
export function CustomDomainsSection({ install }: { install: InstallDetail }) {
  const wildcard = install.wildcard;
  const canAdd =
    install.status === "installed" &&
    install.activeJobId === null &&
    (wildcard === null || !install.domains.some((d) => d.wildcard));
  const canRemove = install.status !== "uninstalling" && install.status !== "uninstalled";
  return (
    <PageSection
      id="domains"
      title={wildcard === null ? "Custom domains" : "Wildcard domain"}
      titleAction={<DocsLink topic="customDomains" />}
      actions={
        !canAdd ? undefined : wildcard === null ? (
          <AddDomainDialog install={install} />
        ) : (
          <AddWildcardDomainDialog install={install} reason={wildcard.reason} />
        )
      }
    >
      {install.domains.length === 0 ? (
        <Text variant="secondary">
          {wildcard === null
            ? "The app is served on its workers.dev URL only. Add a hostname in one of your domains on Cloudflare to serve it there too."
            : `The app is served on its workers.dev URL only, and needs a hostname with every name under it. ${wildcard.reason}`}
        </Text>
      ) : (
        <ResponsiveTable label="Domains" minWidth="sm" stickyFirstColumn>
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
                  <DomainName domain={domain} />
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
        </ResponsiveTable>
      )}
    </PageSection>
  );
}

/** Between two automatic checks of a domain that does not reach the app yet. */
const AUTO_CHECK_MS = 10_000;
/** Automatic checks at most per page view: about three minutes. */
const AUTO_CHECKS = 18;

/**
 * One probe of the app on this hostname, shown here. The install's health
 * stays the check of its main address. A domain that has not reached the
 * app yet (just added, its certificate on the way) is checked on its own
 * every {@link AUTO_CHECK_MS} while the page is open; once the app answers,
 * the server records the domain as live and may turn workers.dev off, and
 * the page reloads to show it.
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
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CustomDomainCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (): Promise<CustomDomainCheck | null> => {
    setPending(true);
    setError(null);
    try {
      const next = await checkCustomDomain({ data: { installId, resourceId: domain.id } });
      setResult(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the domain.");
      return null;
    } finally {
      setPending(false);
    }
  }, [installId, domain.id]);

  const reached = useCallback(
    async (next: CustomDomainCheck | null) => {
      // The domain just went live (and workers.dev may be off): show the new address.
      if (
        next !== null &&
        next.status === "verified" &&
        (!domain.live || next.workersDevTurnedOff)
      ) {
        await router.invalidate();
        return true;
      }
      return false;
    },
    [router, domain.live],
  );

  useEffect(() => {
    if (!enabled || domain.live) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const tick = async () => {
      attempt++;
      const next = await check();
      if (!live || (await reached(next))) return;
      if (attempt < AUTO_CHECKS) timer = setTimeout(tick, AUTO_CHECK_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, domain.live, check, reached]);

  async function onCheck() {
    await reached(await check());
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
  const accountId = useAccountId();
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
          Serve {install.label} on a hostname in one of your domains on Cloudflare. Cloudflare
          creates its DNS record and certificate.{" "}
          {install.workersDevChoice === "auto" && install.workersDevEnabled
            ? "Once the app answers there, workers.dev is turned off; its switch turns it back on."
            : "The workers.dev URL stays as its switch is set."}
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

/**
 * After a wildcard domain was added or removed: the settings change that
 * fills `{{wildcardHostname}}` in again, when one started, is followed on its
 * job page; one that could not start is explained in a toast.
 */
function useSettingsRefresh() {
  const jobStarted = useJobStarted();
  const toasts = useKumoToastManager();
  return async (result: { settingsJobId: string | null; settingsNote: string | null }) => {
    if (result.settingsJobId !== null) {
      await jobStarted(result.settingsJobId, "Settings are being deployed with the new hostname");
    } else if (result.settingsNote !== null) {
      toasts.add({
        title: "Settings not deployed again",
        description: result.settingsNote,
        variant: "warning",
      });
    }
  };
}

function RemoveDomainDialog({
  installId,
  domain,
}: {
  installId: string;
  domain: CustomDomainView;
}) {
  const router = useRouter();
  const settingsRefresh = useSettingsRefresh();
  const label = domainLabel(domain);
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button
          {...p}
          variant="secondary-destructive"
          size="sm"
          icon={<TrashIcon />}
          aria-label={`Remove ${label}`}
        >
          Remove
        </Button>
      )}
      title={`Remove ${label}`}
      description={
        domain.wildcard
          ? `The app stops answering on ${domain.hostname} and every name under it; Appflare deletes the DNS records and Workers routes it added. If this is its last live domain while workers.dev is off, Appflare turns workers.dev back on first, unless an admin turned it off.`
          : "The app stops answering on this hostname. If this is its last live domain while workers.dev is off, Appflare turns workers.dev back on first, unless an admin turned it off."
      }
      actionLabel="Remove domain"
      onConfirm={async () => {
        const data = { installId, resourceId: domain.id };
        if (domain.wildcard) {
          const removed = await removeWildcardDomain({ data });
          await router.invalidate();
          await settingsRefresh(removed);
          return;
        }
        await removeCustomDomain({ data });
        await router.invalidate();
      }}
    />
  );
}

/**
 * For an app that needs every name under one hostname: pick a zone, type
 * the name (nothing for the zone itself), add. The dialog says why the app
 * needs it (the catalog's reason), shows the pattern it gets, notes the
 * certificate a name below the zone's first level needs, and asks before the
 * zone itself is used, since every name in it then reaches the app. Names
 * with DNS records or routes of their own are refused by the server, which
 * says which.
 */
function AddWildcardDomainDialog({ install, reason }: { install: InstallDetail; reason: string }) {
  const router = useRouter();
  const settingsRefresh = useSettingsRefresh();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DomainOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [touched, setTouched] = useState(false);
  const [wholeDomain, setWholeDomain] = useState(false);
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
    setWholeDomain(false);
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
  const checked = zone === null ? null : checkWildcardSubdomain(subdomain, zone.name);
  const hostnameError = touched && checked !== null && !checked.ok ? checked.error : undefined;
  const needsConsent = checked?.ok === true && checked.wholeDomain;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (zone === null || checked === null || !checked.ok || pending) return;
    if (needsConsent && !wholeDomain) return;
    setPending(true);
    setError(null);
    try {
      const added = await addWildcardDomain({
        data: {
          installId: install.id,
          zoneId: zone.id,
          hostname: checked.hostname,
          ...(checked.wholeDomain ? { wholeDomain } : {}),
        },
      });
      setOpen(false);
      await router.invalidate();
      await settingsRefresh(added);
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
            Add a wildcard domain
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Add a wildcard domain</LayerDialog.Title>
        <LayerDialog.Description>
          {reason.length > 0 ? `${reason} ` : ""}
          {WILDCARD_EXPLAINER}{" "}
          {install.workersDevChoice === "auto" && install.workersDevEnabled
            ? "Once the app answers there, workers.dev is turned off; its switch turns it back on."
            : "The workers.dev URL stays as its switch is set."}
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
                    setWholeDomain(false);
                  }}
                  items={Object.fromEntries(options.zones.map((z) => [z.id, z.name]))}
                  disabled={pending}
                />
                <ZoneHostnameField
                  zoneName={zone?.name ?? null}
                  value={subdomain}
                  onChange={(next) => {
                    setSubdomain(next);
                    setWholeDomain(false);
                  }}
                  onBlur={() => setTouched(true)}
                  checked={checked}
                  error={hostnameError}
                  disabled={pending}
                  wildcard
                />
                {zone !== null && checked?.ok === true && (
                  <WildcardNotes
                    zoneName={zone.name}
                    base={checked.hostname}
                    wholeDomain={checked.wholeDomain}
                    agreed={wholeDomain}
                    onAgree={setWholeDomain}
                    disabled={pending}
                  />
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
              disabled={zone === null || (needsConsent && !wholeDomain)}
            >
              Add wildcard domain
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
