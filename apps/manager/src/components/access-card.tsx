import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  LayerCard,
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
  XIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ACCESS_RECOVERY_COMMAND, accessRecoverySteps } from "../access/recovery";
import {
  type AccessCheck,
  type AccessStatus,
  checkAccess,
  resyncAccessAdmins,
  turnOffAccess,
  turnOnAccess,
} from "../server/access.functions";
import { formatDateTime } from "./format";

/** Where the dashboard creates a Zero Trust organization. */
const ZERO_TRUST_DASHBOARD_URL = "https://one.dash.cloudflare.com/";

/**
 * Settings → Cloudflare Access: whether the manager sits behind Cloudflare
 * Access, and (admins) turning that on or off and re-syncing the allow policy
 * with the current admins. Adding an admin in Users updates the policy by
 * itself; "Re-sync admins" covers changes made anywhere else.
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
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>Protect with Cloudflare Access</span>
        {status.enabled ? (
          <Badge variant="success">On</Badge>
        ) : (
          <Badge variant="neutral">Off</Badge>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
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
            {isAdmin ? (
              <div className="flex justify-end">
                <TurnOnDialog viewerEmail={viewerEmail} />
              </div>
            ) : (
              <Text variant="secondary" size="sm">
                Only admins can turn this on.
              </Text>
            )}
          </>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text as="dt" variant="secondary">
        {label}
      </Text>
      <Text as="dd">{children}</Text>
    </>
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
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
        <Row label="Protected address">
          <Text variant="mono" as="span">
            {status.domain ?? "Unknown"}
          </Text>
        </Row>
        <Row label="Zero Trust team">
          <Text variant="mono" as="span">
            {status.teamDomain ?? "Unknown"}
          </Text>
        </Row>
        <Row label="On since">{formatDateTime(status.enabledAt)}</Row>
        {status.adminEmails !== null && (
          <Row label="Allowed admins">{status.adminEmails.join(", ") || "None"}</Row>
        )}
      </dl>
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="primary" icon={<LockKeyIcon />}>
            Protect with Cloudflare Access
          </Button>
        )}
      />
      <Dialog size="lg" className="grid gap-6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <Dialog.Title className="text-lg font-semibold">
              Protect with Cloudflare Access
            </Dialog.Title>
            <Dialog.Description className="text-kumo-subtle">
              Appflare creates a self-hosted Access application for this address that allows only
              the admins' emails.
            </Dialog.Description>
          </div>
          {state.step !== "done" && (
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
          )}
        </div>

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
          <div className="grid gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
              <Row label="Address">
                <Text variant="mono" as="span">
                  {state.check.hostname}
                </Text>
              </Row>
              <Row label="Zero Trust team">
                <Text variant="mono" as="span">
                  {state.check.teamDomain}
                </Text>
              </Row>
              <Row label="Allowed emails">{state.check.adminEmails.join(", ")}</Row>
              <Row label="Login methods">
                {state.check.loginMethods.length > 0
                  ? state.check.loginMethods.join("; ")
                  : "None found"}
              </Row>
            </dl>
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
            <div className="flex justify-end gap-2">
              <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
              <Button
                variant="primary"
                icon={<LockKeyIcon />}
                loading={pending}
                disabled={!confirmed}
                onClick={onTurnOn}
              >
                Turn on
              </Button>
            </div>
          </div>
        )}

        {state.step === "done" && (
          <div className="grid gap-4">
            <Banner
              icon={<CheckCircleIcon weight="fill" />}
              title="Cloudflare Access protection is on"
              description={`Reload to sign in through Access. From now on every visit to ${state.hostname} starts with the Access sign-in.`}
            />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload and sign in
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
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
      <div className="flex justify-end gap-2">
        {check.problem === "no-organization" && (
          <LinkButton href={ZERO_TRUST_DASHBOARD_URL} external variant="secondary">
            Open Zero Trust
          </LinkButton>
        )}
        <Dialog.Close
          render={(props) => (
            <Button {...props} variant="primary">
              Close
            </Button>
          )}
        />
      </div>
    </div>
  );
}

function TurnOffDialog({ domain }: { domain: string | null }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onTurnOff() {
    setPending(true);
    setError(null);
    try {
      await turnOffAccess();
      // A full reload: Access no longer answers for this address, and the
      // page's data should come from the unprotected manager.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn off Cloudflare Access.");
      setPending(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
    >
      <Dialog.Trigger
        render={(p) => (
          <Button {...p} variant="secondary-destructive" icon={<LockKeyOpenIcon />}>
            Turn off
          </Button>
        )}
      />
      <Dialog size="base" className="grid gap-6 px-6 py-5">
        <div className="grid gap-1.5">
          <Dialog.Title className="text-lg font-semibold">Turn off Cloudflare Access?</Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">
            Appflare deletes the Access applications for {domain ?? "this address"} and stops
            checking Access tokens. Appflare's own sign-in still protects the manager.
          </Dialog.Description>
        </div>
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
          <Button
            variant="destructive"
            icon={<LockKeyOpenIcon />}
            loading={pending}
            onClick={onTurnOff}
          >
            Turn off
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
