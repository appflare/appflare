import {
  Badge,
  Banner,
  Button,
  InlineCopyText,
  Input,
  LayerCard,
  LayerDialog,
  Link,
  Loader,
  Radio,
  Table,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  InfoIcon,
  PlusIcon,
  TrashIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  checkExternalHostname,
  EXTERNAL_DOMAIN_COST,
  VALIDATION_LABELS,
  VALIDATION_METHODS,
  type ValidationMethod,
} from "../gateway/gateway";
import {
  type ExternalDomainOptions,
  type ExternalDomainStatus,
  externalDomainPhase,
} from "../installs/external-domain-input";
import {
  addExternalDomain,
  getExternalDomainOptions,
  getExternalDomainStatus,
  removeExternalDomain,
} from "../installs/external-domains.functions";
import type { CustomDomainView, InstallDetail } from "../installs/installs.functions";
import { WILDCARD_EXTERNAL_REFUSAL } from "../installs/wildcard-domain-input";
import { ConfirmDialog } from "./confirm-dialog";
import { DocsLink } from "./docs-link";
import { formatTime } from "./format";
import { HealthBadge } from "./install-health";
import { ErrorMessageBanner } from "./message-text";
import { PageSection } from "./page-section";
import { ResponsiveTable } from "./responsive-table";
import { settingsLink } from "./settings-links";

/** How often a pending domain is read again while the page is open. */
const POLL_MS = 10_000;

const mono = "font-mono text-[0.9em]";

/**
 * `/apps/$installId` → External domains: hostnames in someone else's DNS that
 * serve the app through the gateway (Settings, Domains). Each shows its
 * state as Cloudflare reports it, read again every 10 seconds while it is
 * pending, with the exact records its owner adds; once active, one request
 * through it checks the app answers. Admins add and remove them.
 */
export function ExternalDomainsSection({
  install,
  isAdmin,
}: {
  install: InstallDetail;
  isAdmin: boolean;
}) {
  const canAdd =
    isAdmin &&
    install.status === "installed" &&
    install.activeJobId === null &&
    install.wildcard === null;
  const canRemove =
    isAdmin && install.status !== "uninstalling" && install.status !== "uninstalled";
  // An app that needs every name under its hostname cannot use one: wildcard
  // custom hostnames are Enterprise only.
  if (install.wildcard !== null && install.externalDomains.length === 0) {
    return (
      <PageSection
        id="external-domains"
        title="External domains"
        description="Hostnames in DNS outside this account, such as a customer's domain."
      >
        <Text variant="secondary">{WILDCARD_EXTERNAL_REFUSAL}</Text>
      </PageSection>
    );
  }
  return (
    <PageSection
      id="external-domains"
      title="External domains"
      description="Hostnames in DNS outside this account, such as a customer's domain."
      actions={canAdd ? <AddExternalDomainDialog install={install} /> : undefined}
    >
      {install.externalDomains.length === 0 ? (
        <Text variant="secondary">
          None yet. An external domain needs the gateway, set up once in the{" "}
          <Link href={settingsLink("domains", "external-domains")}>domains settings</Link>.
        </Text>
      ) : (
        <div className="grid gap-3">
          {install.externalDomains.map((domain) => (
            <ExternalDomainCard
              key={domain.id}
              installId={install.id}
              domain={domain}
              canRemove={canRemove}
            />
          ))}
        </div>
      )}
    </PageSection>
  );
}

function PhaseBadge({ status }: { status: ExternalDomainStatus }) {
  const phase = externalDomainPhase(status);
  return (
    <Badge
      variant={
        phase.tone === "success" ? "success" : phase.tone === "problem" ? "error" : "warning"
      }
      appearance="dot"
    >
      {phase.label}
    </Badge>
  );
}

/**
 * One external domain: its state, read on open and every {@link POLL_MS}
 * while it is not active; the records to add while pending; a probe of the
 * app through it once active.
 */
function ExternalDomainCard({
  installId,
  domain,
  canRemove,
}: {
  installId: string;
  domain: CustomDomainView;
  canRemove: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ExternalDomainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const probed = useRef(false);

  const refresh = useCallback(
    async (probe: boolean) => {
      setChecking(true);
      try {
        const next = await getExternalDomainStatus({
          data: { installId, resourceId: domain.id, probe },
        });
        setStatus(next);
        setError(null);
        // The domain just went live (and workers.dev may be off): show the new address.
        if (
          next.workersDevTurnedOff === true ||
          (!domain.live && next.health?.status === "verified")
        ) {
          await router.invalidate();
        }
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read the domain's state.");
        return null;
      } finally {
        setChecking(false);
      }
    },
    [installId, domain.id, domain.live, router],
  );

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // Once active, the first read also asks the app through the domain.
      const next = await refresh(false);
      if (!live) return;
      if (next?.active === true && !probed.current) {
        probed.current = true;
        await refresh(true);
        return;
      }
      if (next !== null && !next.active && next.status !== "missing") {
        timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh]);

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-2">
          <Link href={domain.url} target="_blank" rel="noopener noreferrer">
            {domain.hostname}
            <Link.ExternalIcon />
          </Link>
          {status !== null && <PhaseBadge status={status} />}
          {status === null && error === null && <Loader size="sm" />}
        </span>
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowsClockwiseIcon />}
            loading={checking}
            onClick={() => void refresh(true)}
          >
            Check now
          </Button>
          {canRemove && <RemoveExternalDomainDialog installId={installId} domain={domain} />}
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-3 px-5 py-4">
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        {status !== null && <DomainState status={status} />}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function DomainState({ status }: { status: ExternalDomainStatus }) {
  if (status.active) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Text variant="secondary">Serving with its own certificate.</Text>
        {status.health !== null && (
          <>
            <HealthBadge status={status.health.status} />
            <Text as="span" variant="secondary" size="sm">
              {status.health.detail} at {formatTime(status.checkedAt)}
            </Text>
          </>
        )}
      </span>
    );
  }
  return (
    <div className="grid gap-3">
      <Text variant="secondary">
        {status.method === "txt"
          ? "Add these records at the domain's DNS host, top to bottom. The TXT records let Cloudflare validate the name and issue its certificate while the name keeps serving what it serves now; change the CNAME once this shows Active."
          : "Add this record at the domain's DNS host. Cloudflare then validates the name and issues its certificate, usually within two minutes. Until then visitors see an error page or a certificate warning."}{" "}
        Hostname {status.status.replace(/_/g, " ")}, certificate{" "}
        {(status.sslStatus ?? "unknown").replace(/_/g, " ")}; checked {formatTime(status.checkedAt)}
        .
      </Text>
      {status.records.length > 0 && <RecordsTable records={status.records} />}
      {status.errors.length > 0 && (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="Cloudflare says"
          description={status.errors.join(" ")}
        />
      )}
    </div>
  );
}

function RecordsTable({ records }: { records: ExternalDomainStatus["records"] }) {
  return (
    <ResponsiveTable label="DNS records">
      <Table.Header>
        <Table.Row>
          <Table.Head>Type</Table.Head>
          <Table.Head>Name</Table.Head>
          <Table.Head>Value</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {records.map((r) => (
          <Table.Row key={`${r.type} ${r.name} ${r.value}`}>
            <Table.Cell>
              <span className={mono}>{r.type}</span>
            </Table.Cell>
            <Table.Cell>
              <InlineCopyText value={r.name}>{r.name}</InlineCopyText>
            </Table.Cell>
            <Table.Cell>
              <div className="grid gap-1">
                <InlineCopyText value={r.value}>{r.value}</InlineCopyText>
                <Text variant="secondary" size="sm">
                  {r.purpose}
                </Text>
              </div>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </ResponsiveTable>
  );
}

/** The validation choice, shared with the install form. */
export function ValidationChoice({
  value,
  onChange,
  disabled,
}: {
  value: ValidationMethod;
  onChange: (value: ValidationMethod) => void;
  disabled?: boolean;
}) {
  return (
    <Radio.Group
      legend="How the domain is verified"
      value={value}
      onValueChange={(v) => {
        if (VALIDATION_METHODS.includes(v as ValidationMethod)) onChange(v as ValidationMethod);
      }}
      disabled={disabled}
      appearance="card"
    >
      {VALIDATION_METHODS.map((method) => (
        <Radio.Item
          key={method}
          value={method}
          label={VALIDATION_LABELS[method].label}
          description={VALIDATION_LABELS[method].help}
        />
      ))}
    </Radio.Group>
  );
}

function AddExternalDomainDialog({ install }: { install: InstallDetail }) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ExternalDomainOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [touched, setTouched] = useState(false);
  const [method, setMethod] = useState<ValidationMethod>("http");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) return;
    setOptions(null);
    setLoadError(null);
    setHostname("");
    setTouched(false);
    setMethod("http");
    setError(null);
    getExternalDomainOptions()
      .then(setOptions)
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : "Could not read the gateway."),
      );
  }

  const gateway = options?.gateway ?? null;
  const checked =
    gateway === null
      ? null
      : checkExternalHostname(hostname, {
          gateway: gateway.zoneName,
          account: options?.accountZones ?? [],
        });
  const hostnameError = touched && checked !== null && !checked.ok ? checked.error : undefined;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (checked === null || !checked.ok || pending) return;
    setPending(true);
    setError(null);
    try {
      await addExternalDomain({
        data: { installId: install.id, hostname: checked.hostname, validation: method },
      });
      setOpen(false);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the domain.");
    }
    setPending(false);
  }

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
            Add an external domain
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Add an external domain</LayerDialog.Title>
        <LayerDialog.Description>
          Serve {install.label} on a hostname whose DNS is managed elsewhere. Appflare registers it
          with Cloudflare for SaaS and shows the records its owner adds.{" "}
          <DocsLink topic="externalDomains" variant="inline" />
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {options === null && loadError === null && (
              <div className="flex items-center gap-2">
                <Loader size="sm" />
                <Text variant="secondary">Reading the gateway…</Text>
              </div>
            )}
            {loadError !== null && (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title={loadError}
              />
            )}
            {options !== null && gateway === null && (
              <Banner
                variant="alert"
                icon={<WarningIcon weight="fill" />}
                title="The gateway is not set up"
                description={
                  <span>
                    External domains go through a gateway on one domain of this account. Set it up
                    in the{" "}
                    <Link
                      href={settingsLink("domains", "external-domains")}
                      target="_blank"
                      rel="noopener"
                    >
                      domains settings
                    </Link>
                    , then come back.
                  </span>
                }
              />
            )}
            {gateway !== null && (
              <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
                {/* A whole hostname, not a URL: no scheme in front, and no zone after it. */}
                <Input
                  label="Hostname"
                  error={hostnameError}
                  description={
                    checked?.ok === true && checked.apex
                      ? `${checked.hostname} is a whole domain (an apex). Its DNS host must support a CNAME at the apex (CNAME flattening or ALIAS); many do not.`
                      : "One exact hostname, such as app.example.org."
                  }
                  disabled={pending}
                  placeholder="app.example.org"
                  value={hostname}
                  onChange={(e) => setHostname(e.currentTarget.value)}
                  onBlur={() => setTouched(true)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <ValidationChoice value={method} onChange={setMethod} disabled={pending} />
                <Text variant="secondary" size="sm">
                  Visitors reach it through <span className={mono}>{gateway.hostname}</span>.{" "}
                  {EXTERNAL_DOMAIN_COST}
                </Text>
                {error !== null && <ErrorMessageBanner message={error} newTab />}
              </form>
            )}
          </div>
        </LayerDialog.Body>
        {gateway !== null && (
          <LayerDialog.Actions dismissLabel="Cancel">
            <LayerDialog.Actions.Primary
              type="submit"
              form={formId}
              loading={pending}
              disabled={checked === null || !checked.ok}
            >
              Add domain
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function RemoveExternalDomainDialog({
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
      description="Cloudflare stops serving the app on this hostname at once; visitors get an error page until its owner points the name elsewhere. The records its owner added can then be deleted."
      actionLabel="Remove domain"
      onConfirm={async () => {
        await removeExternalDomain({ data: { installId, resourceId: domain.id } });
        await router.invalidate();
      }}
    />
  );
}
