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
  CONNECTION_COPY,
  type ConnectionKind,
  type ConnectionView,
  RECONNECT_COPY,
} from "../cloudflare/connection-view";
import { startCloudflareReconnect } from "../cloudflare/reconnect.functions";
import { RECONNECT_OUTCOME_COPY, type ReconnectOutcome } from "../cloudflare/reconnect-outcome";
import { scopeReasons } from "../cloudflare/scope-reasons";
import type { TokenStatus } from "../server/token.functions";
import { appflareDevLink } from "./appflare-dev-link";
import { BusyButton } from "./busy-button";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import {
  ACTIONS_UNDER_ON_PHONE,
  ErrorMessageBanner,
  StatusRegion,
  SuccessBanner,
  TOUCH_TARGET,
} from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsLink, settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The account settings' Cloudflare connection. At a glance: the account,
 * how Appflare connects (Cloudflare sign-in or an API token), and whether
 * that works (the badge). Everything else (ids, since when, the last
 * problem, the permissions, the appflare.dev link) is under Details. For
 * admins, Reconnect Cloudflare (while the connection needs it) or Change how
 * Appflare connects (while it works), which offer the same two ways. A
 * connection that needs reconnecting says so first, in one line.
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
      description={CONNECTION_COPY.cardDescription}
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
        {needsReconnect && <ReconnectNotice canRotate={canRotate} />}
        <DescriptionList>
          <DescriptionItem label="Account">{status.accountName ?? "Unknown"}</DescriptionItem>
          <DescriptionItem label={needsReconnect ? "Was connected with" : "Connected with"}>
            {CONNECTION_COPY.kindName[connection.kind]}
          </DescriptionItem>
        </DescriptionList>
        <ConnectionDetails status={status} managerUrl={managerUrl ?? null} />
      </SectionBody>
    </Section>
  );
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
        className={ACTIONS_UNDER_ON_PHONE}
        title={copy.title}
        description={copy.description}
        action={
          copy.retry && onRetry !== null ? (
            <Button variant="secondary" size="sm" className={TOUCH_TARGET} onClick={onRetry}>
              Start again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/** One line: what still works, and who reconnects. Why it happened is under Details. */
function ReconnectNotice({ canRotate }: { canRotate: boolean }) {
  return (
    <Banner
      variant="error"
      icon={<WarningIcon weight="fill" />}
      title={RECONNECT_COPY.title}
      description={canRotate ? RECONNECT_COPY.adminLine : RECONNECT_COPY.memberLine}
    />
  );
}

/** The connection's state in a few plain words, for Details. */
function stateWords(connection: ConnectionView): string {
  if (connection.state === "needs_reconnect") return "Needs reconnecting.";
  if (!connection.ready) return "Saved. Appflare is redeploying itself to use it.";
  return connection.kind === "oauth"
    ? "Working. Appflare renews its access by itself."
    : "Working.";
}

/** Everything technical about the connection, behind one toggle. */
function ConnectionDetails({
  status,
  managerUrl,
}: {
  status: TokenStatus;
  managerUrl: string | null;
}) {
  const { connection } = status;
  const appflareDev = appflareDevLink(managerUrl);
  return (
    <Collapsible.Root>
      <Collapsible.DefaultTrigger className={TOUCH_TARGET}>Details</Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <div className="grid gap-3">
          <DescriptionList>
            <DescriptionItem label="State">{stateWords(connection)}</DescriptionItem>
            {connection.problem !== null && (
              <DescriptionItem
                label={connection.state === "needs_reconnect" ? "Why" : "Last problem"}
              >
                {connection.problem}{" "}
                {connection.problemAt !== null && (
                  <Text variant="secondary" as="span">
                    (<Timestamp iso={connection.problemAt} />)
                  </Text>
                )}
              </DescriptionItem>
            )}
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
            {connection.oauth !== null ? (
              <>
                <DescriptionItem label="Last renewed">
                  <Timestamp iso={connection.oauth.renewedAt} />
                </DescriptionItem>
                <DescriptionItem label="OAuth client ID">
                  <span className="break-all">
                    <Text variant="mono" as="span">
                      {connection.oauth.clientId}
                    </Text>
                  </span>
                </DescriptionItem>
              </>
            ) : (
              <>
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
                  </Link>
                </DescriptionItem>
              </>
            )}
          </DescriptionList>
          {connection.oauth !== null && (
            <>
              <ScopeList
                label={`Permissions (${connection.oauth.scopes.length})`}
                scopes={connection.oauth.scopes}
              />
              {connection.oauth.missingScopes.length > 0 && (
                <ScopeList label="Not granted" scopes={connection.oauth.missingScopes} />
              )}
            </>
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
                Install buttons on appflare.dev then open here, in this browser.
              </Text>
            </div>
          )}
        </div>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

/**
 * The sign-in's permissions under their label, one line each: the
 * permission's name, and why Appflare holds it behind it, in the words the
 * install page used before Cloudflare's consent page.
 */
function ScopeList({ label, scopes }: { label: string; scopes: readonly string[] }) {
  return (
    <div className="grid gap-1">
      <Text variant="secondary" as="p">
        {label}
      </Text>
      <ul className="grid">
        {scopeReasons(scopes).map((reason) => (
          <li key={reason.scope}>
            <Collapsible.Root>
              <Collapsible.DefaultTrigger className={TOUCH_TARGET}>
                {reason.label}
              </Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Text variant="secondary" as="p">
                  {reason.text}
                </Text>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          </li>
        ))}
      </ul>
    </div>
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
  const ways = CONNECTION_COPY.ways(connection.kind);
  return (
    <LayerDialog.Root open={open} onOpenChange={change}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button
            {...p}
            variant={needsReconnect ? "primary" : "secondary"}
            icon={needsReconnect ? <PlugsConnectedIcon /> : <ArrowsClockwiseIcon />}
            className={TOUCH_TARGET}
          >
            {label}
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>{label}</LayerDialog.Title>
        <LayerDialog.Description>{CONNECTION_COPY.dialogDescription}</LayerDialog.Description>
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
                  description={ways.signIn}
                />
                <Radio.Item value="token" label={ways.tokenLabel} description={ways.token} />
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
                description={CONNECTION_COPY.tokenSaved(saved)}
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

/** This browser's host for Appflare, where the sign-in comes back. */
function currentHost(): string | null {
  return typeof window === "undefined" ? null : window.location.host;
}

/**
 * The sign-in way: one line on what comes next, then the whole tab goes to
 * Cloudflare. It comes back to the connection settings with the outcome.
 */
function SignInWay({ kind }: { kind: ConnectionKind }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        {CONNECTION_COPY.signInNext(currentHost(), kind)}
      </Text>
      <div className="flex justify-end">
        <BusyButton
          pending={starting}
          variant="primary"
          icon={<SignInIcon />}
          className={`max-sm:w-full max-sm:justify-center ${TOUCH_TARGET}`}
          onClick={onStart}
        >
          Continue to Cloudflare
        </BusyButton>
      </div>
      {error !== null && <ErrorMessageBanner message={error} newTab />}
    </div>
  );
}
