import { Badge, Banner, Button, InlineCopyText, LinkButton, Text } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  GlobeIcon,
  KeyIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { accountTokenTemplateUrl } from "../cloudflare/token-template";
import {
  EXTERNAL_DOMAIN_COST,
  externalDomainsInUse,
  GATEWAY_WORKER_NAME,
  saasCheckMessage,
  type ZoneSaasCheck,
} from "../gateway/gateway";
import { checkGatewayZone, setUpGateway, turnOffGateway } from "../gateway/gateway.functions";
import type { GatewayView } from "../gateway/gateway.server";
import { AppflareLoader } from "./appflare-loader";
import { BusyButton } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import {
  BANNER_ICON,
  bannerRole,
  ErrorMessageBanner,
  MessageText,
  SuccessBanner,
} from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";
import { useAccountId } from "./use-account-id";
import { ZoneCombobox } from "./zone-combobox";

const mono = "font-mono text-[0.9em]";

/**
 * The domains settings' external domains section: the gateway zone, chosen once per
 * account. Before it exists: pick one of the account's zones, see whether
 * Cloudflare for SaaS is on for it and whether the token may use it (and
 * what to do when not), and set it up. Afterwards: where external domains
 * point their CNAME, whether the gateway answers, and turning it off.
 */
export function GatewayCard({
  view,
  isAdmin,
}: {
  view: GatewayView | { error: string };
  isAdmin: boolean;
}) {
  const gateway = "error" in view ? null : view.gateway;
  return (
    <Section
      {...settingsSection("domains", "external-domains")}
      titleAction={<DocsLink topic="gateway" />}
      badge={
        "error" in view ? null : gateway === null ? (
          <Badge variant="neutral">Not set up</Badge>
        ) : gateway.ready && gateway.check.kind === "ready" ? (
          <Badge variant="success">Ready</Badge>
        ) : (
          <Badge variant="warning">Needs attention</Badge>
        )
      }
      description="The gateway that serves apps on hostnames in other people's DNS, set up once on one of your domains."
      error={"error" in view ? view.error : null}
    >
      {!("error" in view) && <GatewayBody view={view} gateway={gateway} isAdmin={isAdmin} />}
    </Section>
  );
}

function GatewayBody({
  view,
  gateway,
  isAdmin,
}: {
  view: GatewayView;
  gateway: GatewayView["gateway"];
  isAdmin: boolean;
}) {
  return (
    <SectionBody>
      <Text variant="secondary">
        An external domain is a hostname in DNS you do not manage in this Cloudflare account, such
        as a customer's or a domain at another registrar. The gateway runs on one domain of this
        account, which keeps serving its own sites as before.
      </Text>
      {gateway === null ? (
        <ChooseZone zones={view.zones} isAdmin={isAdmin} />
      ) : (
        <GatewayDetails gateway={gateway} isAdmin={isAdmin} />
      )}
      <Text variant="secondary" size="sm">
        {EXTERNAL_DOMAIN_COST}
      </Text>
    </SectionBody>
  );
}

function CheckBanner({
  check,
  zoneName,
  onRecheck,
  rechecking,
}: {
  check: ZoneSaasCheck;
  zoneName: string;
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  const accountId = useAccountId();
  const message = saasCheckMessage(check, zoneName);
  if (message === null) return null;
  const recheck =
    onRecheck === undefined ? null : (
      <BusyButton
        pending={rechecking}
        variant="secondary"
        icon={<ArrowsClockwiseIcon />}
        onClick={onRecheck}
      >
        Check again
      </BusyButton>
    );
  const variant = check.kind === "error" ? "error" : "alert";
  return (
    <Banner
      variant={variant}
      icon={BANNER_ICON[variant]}
      role={bannerRole(variant)}
      title={
        check.kind === "saas-off"
          ? `Cloudflare for SaaS is off for ${zoneName}`
          : check.kind === "missing-permission"
            ? `The token cannot manage custom hostnames on ${zoneName}`
            : "Cloudflare could not be asked"
      }
      description={<MessageText message={message} />}
      action={
        <span className="flex flex-wrap gap-2">
          {check.kind === "saas-off" && (
            <LinkButton
              href={check.dashboardUrl}
              external
              variant="secondary"
              icon={<ArrowSquareOutIcon />}
            >
              Open Custom Hostnames
            </LinkButton>
          )}
          {check.kind === "missing-permission" && (
            <LinkButton
              href={accountTokenTemplateUrl(accountId)}
              external
              variant="secondary"
              icon={<KeyIcon />}
            >
              Create a new token
            </LinkButton>
          )}
          {recheck}
        </span>
      }
    />
  );
}

function ChooseZone({
  zones,
  isAdmin,
}: {
  zones: Array<{ id: string; name: string }> | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [check, setCheck] = useState<(ZoneSaasCheck & { zoneName: string }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (zones === null) {
    return (
      <Banner
        variant="alert"
        icon={BANNER_ICON.alert}
        title="Appflare cannot list the account's domains"
        description="The token needs Zone: Read, DNS: Edit and Workers Routes: Edit (the custom domain permissions) and SSL and Certificates: Edit on the domain that becomes the gateway. Edit the token in the Cloudflare dashboard to add them."
      />
    );
  }
  if (zones.length === 0) {
    return (
      <Banner
        variant="secondary"
        icon={BANNER_ICON.secondary}
        title="External domains need one domain on Cloudflare in this account"
        description="Add a domain you own to this account (the free plan is enough; it means changing its nameservers), or register one with Cloudflare Registrar at cost. Either also lets apps use custom domains, which need no gateway. Until then, apps answer on workers.dev."
      />
    );
  }
  if (!isAdmin) {
    return (
      <Text variant="secondary" size="sm">
        Only admins can set up the gateway.
      </Text>
    );
  }

  async function runCheck(id: string) {
    setChecking(true);
    setError(null);
    try {
      setCheck(await checkGatewayZone({ data: { zoneId: id } }));
    } catch (err) {
      setCheck(null);
      setError(err instanceof Error ? err.message : "Could not check the domain.");
    }
    setChecking(false);
  }

  async function onSetUp() {
    if (zoneId === null) return;
    setSettingUp(true);
    setError(null);
    try {
      await setUpGateway({ data: { zoneId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set up the gateway.");
    }
    setSettingUp(false);
  }

  const zone = zones.find((z) => z.id === zoneId) ?? null;
  return (
    <div className="grid gap-4">
      <ZoneCombobox
        label="Gateway domain"
        description="A domain of this account with Cloudflare for SaaS on. A domain of its own is tidiest, but one that serves a site works: its own hostnames pass through the gateway to their origin unchanged."
        zones={zones}
        value={zoneId}
        onChange={(id) => {
          setZoneId(id);
          setCheck(null);
          void runCheck(id);
        }}
        disabled={settingUp}
      />
      {checking && (
        <div className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Asking Cloudflare about {zone?.name ?? "the domain"}…</Text>
        </div>
      )}
      {check !== null && !checking && check.kind !== "ready" && (
        <CheckBanner
          check={check}
          zoneName={check.zoneName}
          onRecheck={() => zoneId !== null && void runCheck(zoneId)}
          rechecking={checking}
        />
      )}
      {check !== null && !checking && check.kind === "ready" && (
        <SuccessBanner
          title={`Cloudflare for SaaS is on for ${check.zoneName}`}
          description={`Setting up adds a proxied DNS record appflare-gateway.${check.zoneName}, makes it the domain's fallback origin (unless it has one), creates the Worker ${GATEWAY_WORKER_NAME} with a KV namespace for its routing table, and routes every request of ${check.zoneName} to that Worker.`}
        />
      )}
      {error !== null && <ErrorMessageBanner message={error} />}
      <div className="flex justify-end">
        <BusyButton
          pending={settingUp}
          variant="primary"
          icon={<GlobeIcon />}
          disabled={check?.kind !== "ready" || checking}
          onClick={onSetUp}
        >
          Set up gateway
        </BusyButton>
      </div>
    </div>
  );
}

function GatewayDetails({
  gateway,
  isAdmin,
}: {
  gateway: NonNullable<GatewayView["gateway"]>;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [finishing, setFinishing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { check } = gateway;

  async function onFinish() {
    setFinishing(true);
    setError(null);
    try {
      await setUpGateway({ data: { zoneId: gateway.zoneId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish setting up the gateway.");
    }
    setFinishing(false);
  }

  async function onRecheck() {
    setRechecking(true);
    await router.invalidate();
    setRechecking(false);
  }

  return (
    <>
      <DescriptionList>
        <DescriptionItem label="Gateway domain">{gateway.zoneName}</DescriptionItem>
        <DescriptionItem label="CNAME target">
          <InlineCopyText value={gateway.hostname}>{gateway.hostname}</InlineCopyText>
        </DescriptionItem>
        <DescriptionItem label="Cloudflare for SaaS">
          {check.kind === "ready"
            ? `On${check.used !== null ? `, ${check.used} custom hostname${check.used === 1 ? "" : "s"} in use` : ""}`
            : check.kind === "saas-off"
              ? "Off"
              : "Could not be checked"}
        </DescriptionItem>
        <DescriptionItem label="Gateway Worker">
          <span className={mono}>{GATEWAY_WORKER_NAME}</span>
          {gateway.answering === true && " answers on its hostname"}
          {gateway.answering === false && " does not answer on its hostname yet"}
        </DescriptionItem>
        <DescriptionItem label="Set up">
          {gateway.readyAt === null ? "Not finished" : <Timestamp iso={gateway.readyAt} />}
        </DescriptionItem>
        <DescriptionItem label="External domains">
          {gateway.domains.length === 0
            ? "None yet"
            : gateway.domains.map((d) => d.hostname).join(", ")}
        </DescriptionItem>
      </DescriptionList>
      {!gateway.ready && (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Setting up the gateway did not finish"
          description="Finishing continues where it stopped; nothing is created twice."
          action={
            isAdmin ? (
              <BusyButton pending={finishing} variant="secondary" onClick={onFinish}>
                Finish setup
              </BusyButton>
            ) : undefined
          }
        />
      )}
      <CheckBanner
        check={check}
        zoneName={gateway.zoneName}
        onRecheck={onRecheck}
        rechecking={rechecking}
      />
      {gateway.ready && gateway.answering === false && check.kind === "ready" && (
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title={`https://${gateway.hostname} did not answer as the gateway`}
          description="A new route or DNS record can take a minute. If it stays like this, check the Worker's routes on the domain in the Cloudflare dashboard."
          action={
            <BusyButton
              pending={rechecking}
              variant="secondary"
              icon={<ArrowsClockwiseIcon />}
              onClick={onRecheck}
            >
              Check again
            </BusyButton>
          }
        />
      )}
      {error !== null && <ErrorMessageBanner message={error} />}
      {isAdmin && (
        <div className="flex justify-end">
          <TurnOffDialog gateway={gateway} />
        </div>
      )}
    </>
  );
}

function TurnOffDialog({ gateway }: { gateway: NonNullable<GatewayView["gateway"]> }) {
  const router = useRouter();
  const blocked = gateway.domains.length > 0;
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<TrashIcon />}>
          Turn off gateway
        </Button>
      )}
      title="Turn off the gateway"
      description={
        blocked ? (
          <MessageText message={externalDomainsInUse(gateway.domains)} newTab />
        ) : (
          `Removes the route, the Worker ${GATEWAY_WORKER_NAME} and its routing table from ${gateway.zoneName}, and the DNS record and fallback origin if Appflare added them. Cloudflare for SaaS stays on for the domain.`
        )
      }
      actionLabel="Turn off"
      disabled={blocked}
      onConfirm={async () => {
        await turnOffGateway();
        await router.invalidate();
      }}
    />
  );
}
