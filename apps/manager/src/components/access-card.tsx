import {
  Badge,
  Banner,
  Button,
  Checkbox,
  LayerDialog,
  LinkButton,
  Loader,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  InfoIcon,
  LockKeyIcon,
  LockKeyOpenIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
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
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
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
      {error !== null && (
        <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
      )}
      {notice !== null && (
        <Banner variant="secondary" icon={<CheckCircleIcon weight="fill" />} title={notice} />
      )}
      {isAdmin && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            icon={<ArrowsClockwiseIcon />}
            loading={syncing}
            onClick={onResync}
          >
            Re-sync admins
          </Button>
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
            {error !== null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
            )}

            {state.step === "checking" && error === null && (
              <div className="flex items-center gap-3">
                <Loader size="sm" />
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
                  icon={<WarningIcon weight="fill" />}
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

            {state.step === "done" && (
              <Banner
                icon={<CheckCircleIcon weight="fill" />}
                title="Cloudflare Access protection is on"
                description={`Reload to sign in through Access. From now on every visit to ${state.hostname} starts with the Access sign-in.`}
              />
            )}
          </div>
        </LayerDialog.Body>
        {ready && (
          <LayerDialog.Actions dismissLabel="Cancel">
            <LayerDialog.Actions.Primary
              loading={pending}
              disabled={!confirmed}
              onClick={() => void onTurnOn()}
            >
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
  return (
    <div className="grid gap-4">
      <Banner
        variant={check.problem === "no-organization" ? "default" : "error"}
        icon={
          check.problem === "no-organization" ? (
            <InfoIcon weight="fill" />
          ) : (
            <WarningCircleIcon weight="fill" />
          )
        }
        title={
          check.problem === "no-organization"
            ? "Create a Zero Trust organization first"
            : "Cloudflare Access cannot be turned on yet"
        }
        description={check.message}
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
