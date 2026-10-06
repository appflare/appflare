import { Badge, Banner, Button, Checkbox, LayerDialog, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, LockKeyIcon, LockKeyOpenIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ACCESS_RECOVERY_COMMAND, accessRecoverySteps } from "../access/recovery";
import { zeroTrustDashboardUrl } from "../cloudflare/dashboard-links";
import {
  type AccessCheck,
  type AccessStatus,
  checkAccess,
  resyncAccessAdmins,
  turnOffAccess,
  turnOnAccess,
} from "../server/access.functions";
import { AppflareLoader } from "./appflare-loader";
import { BusyButton, BusyMark, busyActionProps } from "./busy-button";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import {
  BANNER_ICON,
  bannerMessage,
  bannerRole,
  ErrorMessageBanner,
  MessageText,
  StatusRegion,
  SuccessBanner,
} from "./message-text";
import { Section, SectionBody } from "./section";
import { settingsSection } from "./settings-links";
import { Timestamp } from "./timestamp";
import { useAccountId } from "./use-account-id";

/** Where the dashboard creates a Zero Trust organization. */
const ZERO_TRUST_DASHBOARD_PATH = "home";

/**
 * The users settings' Cloudflare Access section: whether the manager sits
 * behind Cloudflare Access, and (admins) turning that on (the header's
 * action) or off and re-syncing the allow policy with the current admins.
 * Adding an admin in Users updates the policy by itself; "Re-sync admins"
 * covers changes made anywhere else.
 */
export function AccessCard({
  status,
  isAdmin,
  viewerEmail,
}: {
  status: AccessStatus;
  isAdmin: boolean;
  viewerEmail: string;
}) {
  return (
    <Section
      {...settingsSection("users", "access")}
      badge={
        status.enabled ? <Badge variant="success">On</Badge> : <Badge variant="neutral">Off</Badge>
      }
      description="Protect this manager with Cloudflare Access, in front of its sign-in page."
      action={!status.enabled && isAdmin ? <TurnOnDialog viewerEmail={viewerEmail} /> : null}
    >
      <SectionBody>
        {status.enabled ? (
          <EnabledDetails status={status} isAdmin={isAdmin} />
        ) : (
          <>
            <Text variant="secondary">
              Put this manager behind Cloudflare Access. Before anyone reaches the sign-in page,
              Access asks them to prove they own an admin's email. Appflare then checks the Access
              token on every request and refuses the rest. The health check at /api/health stays
              open.
            </Text>
            {!isAdmin && (
              <Text variant="secondary" size="sm">
                Only admins can turn this on.
              </Text>
            )}
          </>
        )}
      </SectionBody>
    </Section>
  );
}

function EnabledDetails({ status, isAdmin }: { status: AccessStatus; isAdmin: boolean }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onResync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await resyncAccessAdmins();
      if (result.on) {
        setNotice(`The Access policy now allows ${result.adminEmails.join(", ")}.`);
      }
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the Access policy.");
    }
    setSyncing(false);
  }

  return (
    <>
      {/* The section body's grid spaces the list and the notice as one item,
          so the notice's region adds no gap while empty. */}
      <div>
        <DescriptionList>
          <DescriptionItem label="Protected address">
            <Text variant="mono" as="span">
              {status.domain ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="Zero Trust team">
            <Text variant="mono" as="span">
              {status.teamDomain ?? "Unknown"}
            </Text>
          </DescriptionItem>
          <DescriptionItem label="On since">
            <Timestamp iso={status.enabledAt} />
          </DescriptionItem>
          {status.adminEmails !== null && (
            <DescriptionItem label="Allowed admins">
              {status.adminEmails.join(", ") || "None"}
            </DescriptionItem>
          )}
        </DescriptionList>
        <StatusRegion spacing="mt-4">
          {notice !== null && <SuccessBanner live={false} {...bannerMessage(notice)} />}
        </StatusRegion>
      </div>
      {error !== null && <ErrorMessageBanner message={error} />}
      {isAdmin && (
        <div className="flex flex-wrap justify-end gap-2">
          <BusyButton
            pending={syncing}
            variant="secondary"
            icon={<ArrowsClockwiseIcon />}
            onClick={onResync}
          >
            Re-sync admins
          </BusyButton>
          <TurnOffDialog domain={status.domain} />
        </div>
      )}
    </>
  );
}

type TurnOnState =
  | { step: "checking" }
  | { step: "checked"; check: AccessCheck }
  | { step: "done"; hostname: string };

function TurnOnDialog({ viewerEmail }: { viewerEmail: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TurnOnState>({ step: "checking" });
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    setState({ step: "checking" });
    setError(null);
    try {
      setState({ step: "checked", check: await checkAccess() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check Cloudflare Access.");
    }
  }

  function onOpenChange(next: boolean) {
    // Once protection is on, this page's session no longer carries an Access
    // sign-in; only a full reload goes through Access.
    if (!next && state.step === "done") {
      window.location.reload();
      return;
    }
    setOpen(next);
    setConfirmed(false);
    setError(null);
    if (next) void runCheck();
  }

  async function onTurnOn() {
    setPending(true);
    setError(null);
    try {
      const result = await turnOnAccess();
      if (result.ok) {
        setState({ step: "done", hostname: result.hostname });
      } else {
        setState({ step: "checked", check: result });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn on Cloudflare Access.");
    }
    setPending(false);
  }

  const ready = state.step === "checked" && state.check.ok;
  return (
    <LayerDialog.Root open={open} onOpenChange={onOpenChange} dismissDisabled={pending}>
      <LayerDialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<LockKeyIcon />}>
            Protect with Cloudflare Access
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Protect with Cloudflare Access</LayerDialog.Title>
        <LayerDialog.Description>
          Appflare creates a self-hosted Access application for this address that allows only the
          admins' emails.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="grid gap-4">
            {error !== null && <ErrorMessageBanner message={error} newTab />}

            {state.step === "checking" && error === null && (
              <div className="flex items-center gap-3">
                <AppflareLoader size="sm" />
                <Text variant="secondary">Checking the token and the Zero Trust organization…</Text>
              </div>
            )}

            {state.step === "checked" && !state.check.ok && <ProblemView check={state.check} />}

            {state.step === "checked" && state.check.ok && (
              <>
                <DescriptionList>
                  <DescriptionItem label="Address">
                    <Text variant="mono" as="span">
                      {state.check.hostname}
                    </Text>
                  </DescriptionItem>
                  <DescriptionItem label="Zero Trust team">
                    <Text variant="mono" as="span">
                      {state.check.teamDomain}
                    </Text>
                  </DescriptionItem>
                  <DescriptionItem label="Allowed emails">
                    {state.check.adminEmails.join(", ")}
                  </DescriptionItem>
                  <DescriptionItem label="Login methods">
                    {state.check.loginMethods.length > 0
                      ? state.check.loginMethods.join("; ")
                      : "None found"}
                  </DescriptionItem>
                </DescriptionList>
                <Banner
                  variant="alert"
                  icon={BANNER_ICON.alert}
                  title={`You must be able to sign in to Access as ${viewerEmail}`}
                  description={<LockoutWarning hostname={state.check.hostname} />}
                />
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={setConfirmed}
                  label={`I can sign in through Cloudflare Access as ${viewerEmail}`}
                />
              </>
            )}
          </div>
          {/* In the dialog while it checks and turns on; the grid above is
              empty by the time it holds anything. */}
          <StatusRegion>
            {state.step === "done" && (
              <SuccessBanner
                live={false}
                title="Cloudflare Access protection is on"
                description={`Reload to sign in through Access. From now on every visit to ${state.hostname} starts with the Access sign-in.`}
              />
            )}
          </StatusRegion>
        </LayerDialog.Body>
        {ready && (
          <LayerDialog.Actions dismissLabel="Cancel">
            <LayerDialog.Actions.Primary
              onClick={() => void onTurnOn()}
              {...busyActionProps(pending, !confirmed)}
            >
              <BusyMark pending={pending} />
              Turn on
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
        {state.step === "done" && (
          <LayerDialog.Actions>
            <LayerDialog.Actions.Primary onClick={() => window.location.reload()}>
              Reload and sign in
            </LayerDialog.Actions.Primary>
          </LayerDialog.Actions>
        )}
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function LockoutWarning({ hostname }: { hostname: string }) {
  const [deleteApp, runCommand] = accessRecoverySteps(hostname);
  return (
    <span className="grid gap-2">
      <span>
        Access asks for this before Appflare's own sign-in. With the Cloudflare account login
        method, only members of this Cloudflare account get in, with their Cloudflare login email.
        To let other emails in, add One-time PIN as a login method in the Zero Trust dashboard
        first.
      </span>
      <span>If Access keeps you out, you see Cloudflare's page, not Appflare's. To recover:</span>
      <span>1. {deleteApp}</span>
      <span>2. {runCommand}</span>
      <Text variant="mono" as="span">
        {ACCESS_RECOVERY_COMMAND}
      </Text>
    </span>
  );
}

function ProblemView({ check }: { check: Extract<AccessCheck, { ok: false }> }) {
  const accountId = useAccountId();
  const variant = check.problem === "no-organization" ? "default" : "error";
  return (
    <div className="grid gap-4">
      <Banner
        variant={variant}
        icon={BANNER_ICON[variant]}
        role={bannerRole(variant)}
        title={
          check.problem === "no-organization"
            ? "Create a Zero Trust organization first"
            : "Cloudflare Access cannot be turned on yet"
        }
        description={<MessageText message={check.message} newTab />}
      />
      {check.problem === "no-organization" && (
        <div>
          <LinkButton
            href={zeroTrustDashboardUrl(accountId, ZERO_TRUST_DASHBOARD_PATH)}
            external
            variant="secondary"
          >
            Open Zero Trust
          </LinkButton>
        </div>
      )}
    </div>
  );
}

function TurnOffDialog({ domain }: { domain: string | null }) {
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<LockKeyOpenIcon />}>
          Turn off
        </Button>
      )}
      title="Turn off Cloudflare Access"
      description={`Appflare deletes the Access applications for ${domain ?? "this address"} and stops checking Access tokens. Appflare's own sign-in still protects the manager.`}
      actionLabel="Turn off"
      onConfirm={async () => {
        await turnOffAccess();
        // A full reload: Access no longer answers for this address, and the
        // page's data should come from the unprotected manager.
        window.location.reload();
      }}
    />
  );
}
