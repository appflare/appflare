import {
  Badge,
  Banner,
  Button,
  Collapsible,
  LayerDialog,
  Link,
  Radio,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  PlugsConnectedIcon,
  SignInIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
  type ConnectionView,
  connectedWith,
  RECONNECT_COPY,
} from "../cloudflare/connection-view";
import { startCloudflareReconnect } from "../cloudflare/reconnect.functions";
import { RECONNECT_OUTCOME_COPY, type ReconnectOutcome } from "../cloudflare/reconnect-outcome";
import type { TokenStatus } from "../server/token.functions";
import { appflareDevLink } from "./appflare-dev-link";
import { BusyButton } from "./busy-button";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { ErrorMessageBanner, StatusRegion, SuccessBanner } from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsLink, settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The account settings' Cloudflare connection: the account and Worker the
 * manager runs as, how it connects (Cloudflare sign-in or an API token),
 * since when, and whether that works; the technical details on demand; and,
 * for admins, Reconnect Cloudflare (while the connection needs it) or
 * Change how Appflare connects (while it works), which offer the same two
 * ways. A connection that needs reconnecting says so first, in plain words,
 * with what still works. A quiet link makes appflare.dev's Install buttons
 * open this manager.
 */
export function CloudflareTokenCard({
  status,
  canRotate,
  managerUrl,
  outcome = null,
  startOpen = false,
}: {
  status: TokenStatus;
  canRotate: boolean;
  /** The address this browser uses for this manager, for the appflare.dev link; none, no link. */
  managerUrl?: string | null;
  /** How a Cloudflare sign-in that just came back ended. */
  outcome?: ReconnectOutcome | null;
  /** Opens the reconnect dialog at once (Home's Reconnect Cloudflare). */
  startOpen?: boolean;
}) {
  const appflareDev = appflareDevLink(managerUrl);
  const connection = status.connection;
  const needsReconnect = connection.state === "needs_reconnect";
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    if (startOpen && canRotate) setDialogOpen(true);
  }, [startOpen, canRotate]);

  return (
    <Section
      {...settingsSection("account", "connection")}
      titleAction={<DocsLink topic="tokenPermissions" />}
      badge={<ConnectionBadge connection={connection} />}
      description="The Cloudflare account Appflare manages, and how Appflare connects to it."
      action={
        canRotate ? (
          <ReconnectDialog connection={connection} open={dialogOpen} onOpenChange={setDialogOpen} />
        ) : null
      }
    >
      <SectionBody>
        {outcome !== null && (
          <OutcomeBanner outcome={outcome} onRetry={canRotate ? () => setDialogOpen(true) : null} />
        )}
        {needsReconnect && <ReconnectNotice connection={connection} canRotate={canRotate} />}
        <DescriptionList>
          <DescriptionItem label="Account">{status.accountName ?? "Unknown"}</DescriptionItem>
          <DescriptionItem label="Account ID">
            <span className="break-all">
              <Text variant="mono" as="span">
                {status.accountId ?? "Unknown"}
              </Text>
            </span>
          </DescriptionItem>
          <DescriptionItem label="Worker">
            <Text variant="mono" as="span">
              {status.workerName ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Connection">
            {needsReconnect
              ? `Was connected with ${CONNECTION_KIND_LABELS[connection.kind]}`
              : connectedWith(connection.kind)}
          </DescriptionItem>
          <DescriptionItem label="Since">
            <Timestamp
              iso={
                connection.kind === "api_token"
                  ? (status.verifiedAt ?? connection.connectedSince)
                  : connection.connectedSince
              }
              fallback="Unknown"
            />
          </DescriptionItem>
          <DescriptionItem label="State">{stateWords(connection)}</DescriptionItem>
          {!needsReconnect && connection.problem !== null && (
            <DescriptionItem label="Last problem">
              {connection.problem}{" "}
              {connection.problemAt !== null && (
                <Text variant="secondary" as="span">
                  (<Timestamp iso={connection.problemAt} />)
                </Text>
              )}
            </DescriptionItem>
          )}
        </DescriptionList>
        {connection.oauth !== null ? (
          <AuthorizationDetails oauth={connection.oauth} />
        ) : (
          <TokenDetails status={status} />
        )}
        {appflareDev !== null && (
          <div className="grid gap-0.5">
            <Text size="sm" as="p">
              <Link href={appflareDev} target="_blank" rel="noreferrer">
                Use this Appflare on appflare.dev
                <ArrowSquareOutIcon className="ml-1 inline" aria-hidden />
              </Link>
            </Text>
            <Text variant="secondary" size="sm" as="p">
              Remembers this Appflare in your browser so Install buttons on appflare.dev open here.
            </Text>
          </div>
        )}
      </SectionBody>
    </Section>
  );
}

/** The connection's state in a few plain words. */
function stateWords(connection: ConnectionView): string {
  if (connection.state === "needs_reconnect") {
    return "Needs reconnecting. Appflare cannot change anything in the account until then; your apps keep running.";
  }
  if (!connection.ready) return "Saved. Appflare is redeploying itself to use it.";
  return connection.kind === "oauth"
    ? "Working. Appflare renews its access by itself."
    : "Working.";
}

function ConnectionBadge({ connection }: { connection: ConnectionView }) {
  if (connection.state === "needs_reconnect") {
    return <Badge variant="error">Needs reconnecting</Badge>;
  }
  return connection.ready ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="warning">Waiting for redeploy</Badge>
  );
}

/** How the sign-in that just came back ended, with "Start again" when that can help. */
function OutcomeBanner({
  outcome,
  onRetry,
}: {
  outcome: ReconnectOutcome;
  onRetry: (() => void) | null;
}) {
  const copy = RECONNECT_OUTCOME_COPY[outcome];
  if (copy.variant === "success") {
    return <SuccessBanner title={copy.title} description={copy.description} />;
  }
  const notice = copy.variant === "notice";
  return (
    <div role={notice ? "status" : "alert"}>
      <Banner
        variant={notice ? "alert" : "error"}
        icon={notice ? <WarningIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
        title={copy.title}
        description={copy.description}
        action={
          copy.retry && onRetry !== null ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Start again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/** What happened, what still works, and where reconnecting happens. */
function ReconnectNotice({
  connection,
  canRotate,
}: {
  connection: ConnectionView;
  canRotate: boolean;
}) {
  return (
    <Banner
      variant="error"
      icon={<WarningIcon weight="fill" />}
      title={RECONNECT_COPY.title}
      description={
        <span className="grid gap-1">
          {connection.problem !== null && <span>{connection.problem}</span>}
          <span>
            Until then Appflare cannot install, update or remove apps. Your apps keep running.
          </span>
          <span>
            {canRotate
              ? `Choose ${RECONNECT_COPY.action} to sign in with Cloudflare again or to connect an API token instead.`
              : "An administrator reconnects Cloudflare here, in this section."}
          </span>
        </span>
      }
    />
  );
}

/** The authorization's technical details, behind a toggle. */
function AuthorizationDetails({ oauth }: { oauth: NonNullable<ConnectionView["oauth"]> }) {
  return (
    <Collapsible.Root>
      <Collapsible.DefaultTrigger>Details</Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <DescriptionList>
          <DescriptionItem label="Last renewed">
            <Timestamp iso={oauth.renewedAt} />
          </DescriptionItem>
          <DescriptionItem label="OAuth client ID">
            <span className="break-all">
              <Text variant="mono" as="span">
                {oauth.clientId}
              </Text>
            </span>
          </DescriptionItem>
        </DescriptionList>
        <ScopeList label={`Permissions (${oauth.scopes.length})`} scopes={oauth.scopes} />
        {oauth.missingScopes.length > 0 && (
          <ScopeList label="Not granted" scopes={oauth.missingScopes} />
        )}
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

/**
 * Scope ids under their label, across the whole panel rather than in a row's
 * value column, so on a phone the longest id still fits on a line: each id
 * stays whole and lines wrap only between ids.
 */
function ScopeList({ label, scopes }: { label: string; scopes: readonly string[] }) {
  return (
    <div className="mt-2.5 grid gap-1">
      <Text variant="secondary" as="p">
        {label}
      </Text>
      <p>
        <Text variant="mono" as="span">
          {scopes.map((scope, i) => (
            <span key={scope}>
              <span className="whitespace-nowrap">
                {scope}
                {i < scopes.length - 1 ? "," : ""}
              </span>{" "}
            </span>
          ))}
        </Text>
      </p>
    </div>
  );
}

/** The token's technical details, behind a toggle; its permissions are checked elsewhere. */
function TokenDetails({ status }: { status: TokenStatus }) {
  return (
    <Collapsible.Root>
      <Collapsible.DefaultTrigger>Details</Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <DescriptionList>
          <DescriptionItem label="Last verified">
            <Timestamp iso={status.verifiedAt} fallback="Never" />
          </DescriptionItem>
          <DescriptionItem label="Stored as">
            {status.hasSecret
              ? "The CF_API_TOKEN secret, bound to the running version."
              : "The CF_API_TOKEN secret; the running version does not have it yet."}
          </DescriptionItem>
          <DescriptionItem label="Permissions">
            <Link href={settingsLink("account", "capability-token-permissions")}>
              Token permissions
            </Link>{" "}
            in What this account can run shows what the token allows.
          </DescriptionItem>
        </DescriptionList>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

type Way = "sign-in" | "token";

/**
 * Reconnect Cloudflare, or Change how Appflare connects: exactly two ways.
 * Signing in with Cloudflare sends this tab to Cloudflare and back through
 * appflare.dev; an API token is created in the dashboard and pasted here
 * (verified for this account and Worker before anything changes).
 */
function ReconnectDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: ConnectionView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const needsReconnect = connection.state === "needs_reconnect";
  const [way, setWay] = useState<Way>("sign-in");
  const [saved, setSaved] = useState<SavedToken | null>(null);

  function change(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setSaved(null);
      setWay("sign-in");
    }
  }

  async function onSaved(result: SavedToken) {
    setSaved(result);
    await router.invalidate();
  }

  const label = needsReconnect ? RECONNECT_COPY.action : RECONNECT_COPY.change;
  return (
    <LayerDialog.Root open={open} onOpenChange={change}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button
            {...p}
            variant={needsReconnect ? "primary" : "secondary"}
            icon={needsReconnect ? <PlugsConnectedIcon /> : <ArrowsClockwiseIcon />}
          >
            {label}
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>{label}</LayerDialog.Title>
        <LayerDialog.Description>
          Choose how Appflare connects to your Cloudflare account. Your apps keep running either
          way.
        </LayerDialog.Description>
        <LayerDialog.Body>
          {saved === null && (
            <div className="grid gap-5">
              <Radio.Group
                value={way}
                onValueChange={(v) => setWay(v === "token" ? "token" : "sign-in")}
                appearance="card"
              >
                <Radio.Legend className="sr-only">How Appflare connects</Radio.Legend>
                <Radio.Item
                  value="sign-in"
                  label="Sign in with Cloudflare"
                  description="Recommended. Gives Appflare every permission it needs at once, with nothing to copy or paste."
                />
                <Radio.Item
                  value="token"
                  label={
                    connection.kind === "api_token" ? "Use a new API token" : "Use an API token"
                  }
                  description={
                    connection.kind === "oauth"
                      ? "Create a token in the Cloudflare dashboard and paste it here. Appflare then stops using Cloudflare sign-in and withdraws it."
                      : "Create a token in the Cloudflare dashboard and paste it here. It replaces the one Appflare uses now."
                  }
                />
              </Radio.Group>
              {way === "sign-in" ? (
                <SignInWay kind={connection.kind} />
              ) : (
                <CloudflareTokenForm mode="rotate" onSaved={onSaved} />
              )}
            </div>
          )}
          {/* Mounted with the form, so screen readers announce the banner that replaces it. */}
          <StatusRegion>
            {saved !== null && (
              <SuccessBanner
                live={false}
                title={saved.replacedAuthorization ? "Connected with the API token" : "Token saved"}
                description={
                  saved.replacedAuthorization
                    ? `Appflare now uses this token on "${saved.workerName}" and withdrew its Cloudflare sign-in. It redeploys itself to pick the token up.`
                    : `The new token is stored on "${saved.workerName}". Appflare redeploys itself to pick it up. Revoke the old token in the Cloudflare dashboard.`
                }
              />
            )}
          </StatusRegion>
        </LayerDialog.Body>
        {saved !== null && (
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary onClick={() => change(false)}>
              Done
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** This browser's address for Appflare, where the sign-in comes back. */
function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * The sign-in way: one line on what comes next, then the whole tab goes to
 * Cloudflare. It comes back to the connection settings with the outcome.
 */
function SignInWay({ kind }: { kind: ConnectionKind }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = currentOrigin();

  async function onStart() {
    setStarting(true);
    setError(null);
    try {
      const { url } = await startCloudflareReconnect();
      window.location.assign(url);
      // The tab is leaving; the button stays busy until it has.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start signing in with Cloudflare.");
      setStarting(false);
    }
  }

  return (
    <div className="grid gap-3">
      <Text variant="secondary" as="p">
        Cloudflare asks you to approve access, then appflare.dev asks you to confirm your Appflare
        address{origin === null ? "" : `, ${origin},`} to bring you back here.
        {kind === "api_token" ? " Appflare then removes its API token from its Worker." : ""}
      </Text>
      <div className="flex justify-end">
        <BusyButton pending={starting} variant="primary" icon={<SignInIcon />} onClick={onStart}>
          Continue to Cloudflare
        </BusyButton>
      </div>
      {error !== null && <ErrorMessageBanner message={error} newTab />}
    </div>
  );
}
