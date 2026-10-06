import { Badge, Banner, Button, Link, Text } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  GlobeIcon,
  LockKeyIcon,
  LockKeyOpenIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  ACCESS_NOW_REQUIRED_TITLE,
  ACCESS_REPAIR_REASONS,
  type AppAccessCheck,
  accessProblemFix,
  accessRequiredLine,
  type InstallAccessView,
  pendingPublicPathsLine,
  publicPathsLine,
  signInNote,
  whoGetsIn,
  zeroTrustUsersNote,
} from "../access/app-access";
import { dashboardLinks } from "../cloudflare/dashboard-links";
import {
  checkAppAccess,
  makePublicPaths,
  startAccessChange,
} from "../installs/access-change.functions";
import type { InstallDetail } from "../installs/installs.functions";
import { AppflareLoader } from "./appflare-loader";
import { ConfirmDialog } from "./confirm-dialog";
import { DescriptionItem, DescriptionList } from "./description-list";
import { DocsLink } from "./docs-link";
import { FLUSH_RING_CLASS } from "./hash-target";
import { useJobStarted } from "./job-started";
import { BANNER_ICON, bannerRole, MessageText } from "./message-text";
import { Section, SectionBody } from "./section";
import { useAccountId } from "./use-account-id";

/** "3 people". */
function people(users: number): string {
  return users === 1 ? "1 person" : `${users} people`;
}

/**
 * `/apps/$installId`, Domains and email, "Cloudflare Access": whether
 * Appflare protects the app with Cloudflare Access, so that every address
 * it has asks for a sign-in and only Appflare's users get in. Shows who
 * gets in, what stays public, the Access application in the Zero Trust
 * dashboard, and a sync that failed (the cron tries again). Admins turn it
 * on or off with a confirmation that says what happens; when Appflare's
 * records show something to repair (`InstallAccessView.repair`), "Protect
 * again" is offered with a line saying what. Each starts the settings change
 * job, whose log the page then opens. An app whose catalog
 * entry requires protection has no off control. Members see the state.
 */
export function AppAccessSection({
  install,
  access,
  isAdmin,
}: {
  install: InstallDetail;
  access: InstallAccessView;
  isAdmin: boolean;
}) {
  const accountId = useAccountId();
  const required = access.offer === "required";
  const idle = install.status === "installed" && install.activeJobId === null;
  const usersNote = zeroTrustUsersNote(access.users);
  const canTurnOn = isAdmin && idle && !access.protected;
  const canTurnOff = isAdmin && idle && access.protected && !required;
  // Turning it on again repairs what Appflare's records show to be wrong.
  const repair = access.protected ? access.repair : null;
  const canProtectAgain = isAdmin && idle && repair !== null;
  return (
    <Section
      id="access"
      title="Cloudflare Access"
      titleAction={<DocsLink topic="protectApps" />}
      className={FLUSH_RING_CLASS}
      badge={
        access.protected ? (
          <Badge variant="success">Protected</Badge>
        ) : (
          <Badge variant="neutral">Off</Badge>
        )
      }
      description="Ask for a Cloudflare sign-in on every address of the app, so only Appflare's users reach it."
      action={canTurnOn ? <TurnOnDialog install={install} access={access} again={false} /> : null}
    >
      <SectionBody>
        {required && !access.protected && (
          <Banner
            variant="alert"
            icon={BANNER_ICON.alert}
            title={ACCESS_NOW_REQUIRED_TITLE}
            description={`${accessRequiredLine(install.name)} Appflare never protects it on its own, and holds its updates until it is protected.`}
            action={
              canTurnOn ? (
                <TurnOnDialog install={install} access={access} again={false} label="Turn on" />
              ) : undefined
            }
          />
        )}
        {access.syncFailedAt !== null && (
          <Banner
            variant="alert"
            icon={BANNER_ICON.alert}
            title="Cloudflare Access is not in step with this app's addresses"
            description="The last update of its Access applications failed. Appflare tries again every 30 minutes; the app's addresses stay protected meanwhile."
          />
        )}
        {access.protected ? (
          <DescriptionList>
            <DescriptionItem label="Who gets in">
              Appflare's users: {people(access.users)}, members included
            </DescriptionItem>
            {access.teamDomain !== null && (
              <DescriptionItem label="Sign-in">
                <Text variant="mono" as="span">
                  {access.teamDomain}
                </Text>
              </DescriptionItem>
            )}
            <DescriptionItem label="Public paths">
              {access.publicPaths.length > 0
                ? access.publicPaths.join(", ")
                : "None; every path asks for a sign-in, links you share included"}
            </DescriptionItem>
            <DescriptionItem label="Access application">
              <span className="grid gap-0.5">
                {access.appName !== null && <span>{access.appName}</span>}
                <Link href={dashboardLinks(accountId).accessApps} target="_blank" rel="noopener">
                  Open in Zero Trust
                  <Link.ExternalIcon />
                </Link>
              </span>
            </DescriptionItem>
          </DescriptionList>
        ) : (
          <Text variant="secondary">
            Not protected: anyone with the app's address reaches it, unless the app has a sign-in of
            its own. {whoGetsIn(access.users)} {publicPathsLine(access.publicPaths)}
          </Text>
        )}
        {access.protected && access.pendingPublicPaths.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text variant="secondary" size="sm">
              {pendingPublicPathsLine(access.pendingPublicPaths)} They ask for a sign-in until an
              admin makes them public.
            </Text>
            {isAdmin && <MakePublicDialog install={install} paths={access.pendingPublicPaths} />}
          </div>
        )}
        {usersNote !== null && (
          <Text variant="secondary" size="sm">
            {usersNote}
          </Text>
        )}
        {required && access.protected && (
          <Text variant="secondary" size="sm">
            It cannot be turned off. {accessRequiredLine(install.name)}
          </Text>
        )}
        {isAdmin && !idle && install.activeJobId !== null && (
          <Text variant="secondary" size="sm">
            Another job of this app is running; change this once it finishes.{" "}
            <Link href={`/jobs/${install.activeJobId}`}>View its log</Link>
          </Text>
        )}
        {!isAdmin && (
          <Text variant="secondary" size="sm">
            Only admins can change this.
          </Text>
        )}
        {repair !== null && (
          <Text variant="secondary" size="sm">
            {ACCESS_REPAIR_REASONS[repair]}
          </Text>
        )}
        {(canProtectAgain || canTurnOff) && (
          <div className="flex flex-wrap justify-end gap-2">
            {canProtectAgain && <TurnOnDialog install={install} access={access} again />}
            {canTurnOff && <TurnOffDialog install={install} access={access} />}
          </div>
        )}
      </SectionBody>
    </Section>
  );
}

/** Starts the change and opens its log, like any settings change. */
function useStartChange(install: InstallDetail, to: "on" | "off") {
  const jobStarted = useJobStarted();
  return async () => {
    const { jobId } = await startAccessChange({ data: { installId: install.id, access: to } });
    await jobStarted(jobId, "Cloudflare Access change started");
  };
}

type CheckState = { step: "checking" } | { step: "checked"; check: AppAccessCheck };

/**
 * Turning protection on, after the same check the change starts with; or,
 * `again`, bringing it back in step for an app that is already protected.
 */
function TurnOnDialog({
  install,
  access,
  again,
  label = "Protect with Cloudflare Access",
}: {
  install: InstallDetail;
  access: InstallAccessView;
  again: boolean;
  /** The trigger's words when turning it on. */
  label?: string;
}) {
  const [state, setState] = useState<CheckState>({ step: "checking" });
  const [checkError, setCheckError] = useState<string | null>(null);
  const start = useStartChange(install, "on");

  async function runCheck() {
    setState({ step: "checking" });
    setCheckError(null);
    try {
      setState({ step: "checked", check: await checkAppAccess() });
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Could not check Cloudflare Access.");
    }
  }

  const check = state.step === "checked" ? state.check : null;
  const problem = check?.problem ?? null;
  const fix = problem === null ? null : accessProblemFix(problem.kind);
  return (
    <ConfirmDialog
      trigger={(p) =>
        again ? (
          <Button {...p} variant="secondary" icon={<ArrowsClockwiseIcon />}>
            Protect again
          </Button>
        ) : (
          <Button {...p} variant="primary" icon={<LockKeyIcon />}>
            {label}
          </Button>
        )
      }
      title={
        again ? `Protect ${install.label} again` : `Protect ${install.label} with Cloudflare Access`
      }
      description={
        <>
          {again
            ? 'Appflare brings the app\'s Access application back in step with its addresses and the "Appflare users" policy, and makes it again if it no longer exists.'
            : "Every address of the app asks for a Cloudflare Access sign-in: its workers.dev address, its version previews and its domains."}
          {access.usesAccessValues
            ? " The app reads the Access values in its settings, so Appflare deploys it again with them."
            : ""}
        </>
      }
      actionLabel={again ? "Protect again" : "Turn on"}
      destructive={false}
      size="lg"
      onOpen={() => void runCheck()}
      // A check that could not run does not hold the change: it checks again when it starts.
      disabled={problem !== null || (check === null && checkError === null)}
      onConfirm={start}
    >
      {state.step === "checking" && checkError === null && (
        <div className="flex items-center gap-3">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Checking the token and the Zero Trust organization…</Text>
        </div>
      )}
      {checkError !== null && (
        <Text variant="secondary" size="sm">
          {checkError} Appflare checks again when the change starts.
        </Text>
      )}
      {problem !== null && fix !== null && (
        <Banner
          variant="error"
          icon={BANNER_ICON.error}
          role={bannerRole("error")}
          title="This account cannot protect apps yet"
          description={
            <span className="grid gap-1">
              <span>
                <MessageText message={problem.message} />
              </span>
              <Link href={fix.href}>{fix.label}</Link>
            </span>
          }
        />
      )}
      {check !== null && problem === null && (
        <div className="grid gap-2">
          <Text>
            {whoGetsIn(check.users)} {signInNote(check)}
          </Text>
          <Text variant="secondary" size="sm">
            {publicPathsLine(access.publicPaths)}
          </Text>
          {zeroTrustUsersNote(check.users) !== null && (
            <Text variant="secondary" size="sm">
              {zeroTrustUsersNote(check.users)}
            </Text>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

function TurnOffDialog({ install, access }: { install: InstallDetail; access: InstallAccessView }) {
  const start = useStartChange(install, "off");
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary-destructive" icon={<LockKeyOpenIcon />}>
          Turn off
        </Button>
      )}
      title="Turn off Cloudflare Access"
      description={
        <>
          Appflare deletes the app's Access applications. Anyone with the app's address can then
          reach it, unless the app has a sign-in of its own.
          {access.usesAccessValues
            ? " The app reads the Access values in its settings, so Appflare first deploys it again without them."
            : ""}
        </>
      }
      actionLabel="Turn off"
      onConfirm={start}
    />
  );
}

/**
 * Accepting the paths a catalog revision added to the entry's public paths:
 * after a confirmation, since anyone then reaches them without a sign-in.
 * Runs at once (no job); a sync that fails is retried by the cron.
 */
function MakePublicDialog({ install, paths }: { install: InstallDetail; paths: string[] }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="secondary" icon={<GlobeIcon />}>
          Make public
        </Button>
      )}
      title={`Make ${paths.join(", ")} public`}
      description={`Anyone can then reach ${paths.length === 1 ? "this path" : "these paths"} of ${install.label} without signing in, on every address of the app.`}
      actionLabel="Make public"
      destructive={false}
      onConfirm={async () => {
        const result = await makePublicPaths({ data: { installId: install.id, paths } });
        await router.invalidate();
        if (result.problem !== null) {
          // Accepted already; only Cloudflare is behind, and the cron catches up.
          throw new Error(
            `Accepted, but Cloudflare Access was not updated yet: ${result.problem} Appflare tries again within 30 minutes.`,
          );
        }
        if (result.pending.length > 0) {
          // The catalog changed since the page loaded: what it added since waits.
          throw new Error(
            `The catalog changed meanwhile: ${result.pending.join(", ")} still asks for a sign-in. Review it on the card.`,
          );
        }
      }}
    />
  );
}
