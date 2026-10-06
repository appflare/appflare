import { Badge, Banner, Button, Collapsible, LayerDialog, Link, Text } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  KeyIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
  type ConnectionView,
  RECONNECT_COPY,
} from "../cloudflare/connection-view";
import type { TokenStatus } from "../server/token.functions";
import { appflareDevLink } from "./appflare-dev-link";
import { CloudflareTokenForm, type SavedToken } from "./cloudflare-token-form";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { StatusRegion, SuccessBanner } from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";

/**
 * The account settings' Cloudflare connection: the account and Worker the
 * manager runs as, how it connects (an API token, or a Cloudflare
 * authorization), whether that works, (admins) replacing the token, and a
 * quiet link that makes appflare.dev's Install buttons open this manager.
 * A connection that needs reconnecting says so first, in plain words, with
 * what still works.
 */
export function CloudflareTokenCard({
  status,
  canRotate,
  managerUrl,
}: {
  status: TokenStatus;
  canRotate: boolean;
  /** The address this browser uses for this manager, for the appflare.dev link; none, no link. */
  managerUrl?: string | null;
}) {
  const appflareDev = appflareDevLink(managerUrl);
  const connection = status.connection;
  const needsReconnect = connection.state === "needs_reconnect";
  return (
    <Section
      {...settingsSection("account", "connection")}
      titleAction={<DocsLink topic="tokenPermissions" />}
      badge={<ConnectionBadge connection={connection} />}
      description="The Cloudflare account Appflare manages, and how Appflare connects to it."
      action={canRotate ? <RotateTokenDialog kind={connection.kind} /> : null}
    >
      <SectionBody>
        {needsReconnect && <ReconnectNotice connection={connection} canRotate={canRotate} />}
        <DescriptionList>
          <DescriptionItem label="Account">{status.accountName ?? "Unknown"}</DescriptionItem>
          <DescriptionItem label="Account ID">
            <Text variant="mono" as="span">
              {status.accountId ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Worker">
            <Text variant="mono" as="span">
              {status.workerName ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Connected with">
            {CONNECTION_KIND_LABELS[connection.kind]}
          </DescriptionItem>
          {connection.kind === "api_token" ? (
            <>
              <DescriptionItem label="Last verified">
                <Timestamp iso={status.verifiedAt} fallback="Never" />
              </DescriptionItem>
              <DescriptionItem label="Secret binding">
                {status.hasSecret
                  ? "CF_API_TOKEN is bound to the running version."
                  : "The token is saved; the running version does not have it yet."}
              </DescriptionItem>
            </>
          ) : (
            <>
              <DescriptionItem label="Connected since">
                <Timestamp iso={connection.connectedSince} fallback="Unknown" />
              </DescriptionItem>
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
              {!needsReconnect && !connection.ready && (
                <DescriptionItem label="Running version">
                  The connection is saved; Appflare is redeploying itself to use it.
                </DescriptionItem>
              )}
            </>
          )}
        </DescriptionList>
        {connection.oauth !== null && <AuthorizationDetails oauth={connection.oauth} />}
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
              ? "Reconnecting happens here, in this section. You can also connect an API token instead, with Use an API token."
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
      <Collapsible.DefaultTrigger>Authorization details</Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <DescriptionList>
          <DescriptionItem label="Last renewed">
            <Timestamp iso={oauth.renewedAt} />
          </DescriptionItem>
          <DescriptionItem label="OAuth client ID">
            <Text variant="mono" as="span">
              {oauth.clientId}
            </Text>
          </DescriptionItem>
          <DescriptionItem label={`Permissions (${oauth.scopes.length})`}>
            <Text variant="mono" as="span">
              {oauth.scopes.join(", ")}
            </Text>
          </DescriptionItem>
          {oauth.missingScopes.length > 0 && (
            <DescriptionItem label="Not granted">
              <Text variant="mono" as="span">
                {oauth.missingScopes.join(", ")}
              </Text>
            </DescriptionItem>
          )}
        </DescriptionList>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
}

/**
 * Verify and store an API token on the same account and Worker: a new token
 * for a token connection, or a token instead of the Cloudflare authorization.
 */
function RotateTokenDialog({ kind }: { kind: ConnectionKind }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedToken | null>(null);
  const replacing = kind === "oauth";

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSaved(null);
  }

  async function onSaved(result: SavedToken) {
    setSaved(result);
    await router.invalidate();
  }

  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button
            {...p}
            variant="secondary"
            icon={replacing ? <KeyIcon /> : <ArrowsClockwiseIcon />}
          >
            {replacing ? "Use an API token" : "Rotate token"}
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>
          {replacing ? "Use an API token instead" : "Rotate Cloudflare token"}
        </LayerDialog.Title>
        <LayerDialog.Description>
          {replacing
            ? "Appflare will connect with this token instead of its Cloudflare authorization, and withdraw that authorization. The token must be for the same account."
            : "The new token must be for the same account. It replaces the stored one; revoke the old token in the Cloudflare dashboard afterwards."}
        </LayerDialog.Description>
        <LayerDialog.Body>
          {saved === null && <CloudflareTokenForm mode="rotate" onSaved={onSaved} />}
          {/* Mounted with the form, so screen readers announce the banner that replaces it. */}
          <StatusRegion>
            {saved !== null && (
              <SuccessBanner
                live={false}
                title={
                  saved.replacedAuthorization ? "Connected with the API token" : "Token rotated"
                }
                description={
                  saved.replacedAuthorization
                    ? `Appflare now uses this token on "${saved.workerName}" and withdrew its Cloudflare authorization. It redeploys itself to pick the token up.`
                    : `The new token is stored on "${saved.workerName}". Appflare redeploys itself to pick it up.`
                }
              />
            )}
          </StatusRegion>
        </LayerDialog.Body>
        {saved !== null && (
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary onClick={() => onOpenChange(false)}>
              Done
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
