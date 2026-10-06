import { SANDBOX_CONTAINERS } from "@appflare/schema";
import { Banner, Button, Collapsible, Link, Text } from "@cloudflare/kumo";
import { KeyIcon, TrashIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { appLink } from "../components/app-links";
import { AppflareLoader } from "../components/appflare-loader";
import { ConfirmDialog } from "../components/confirm-dialog";
import { MessageText } from "../components/message-text";
import { Section, SectionRow, SectionRows } from "../components/section";
import { settingsSection } from "../components/settings-links";
import { Timestamp } from "../components/timestamp";
import { deletesBuildBucket, REMOVE_PATH, ROTATE_CONFIRMATION, ROTATE_PATH } from "./danger";
import type { DangerZoneState } from "./danger.functions";
import { getRemovalReview } from "./danger.functions";
import type { RemovalReview } from "./removal-plan.server";

/**
 * The danger zone, the last section of Your account: rotating the auth
 * secret and removing Appflare from the account. Only the owner sees it
 * (the endpoints refuse anyone else too). Both confirm in a dialog, then
 * post a plain form, so the browser leaves the app for the static page each
 * action answers with.
 */

/**
 * Posts `confirm=<value>` to `path` as a top-level form submission, then
 * waits for the page to go, keeping the dialog's button busy meanwhile.
 */
function submitForm(path: string, confirm: string): Promise<void> {
  const form = document.createElement("form");
  form.method = "post";
  form.action = path;
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "confirm";
  input.value = confirm;
  form.appendChild(input);
  document.body.appendChild(form);
  return new Promise<void>((resolve) => {
    window.addEventListener("pagehide", () => resolve(), { once: true });
    form.submit();
  });
}

export function DangerZone({ state }: { state: DangerZoneState }) {
  return (
    <Section
      {...settingsSection("account", "danger-zone")}
      description="Actions that cannot be undone. Each asks you to type a confirmation first."
    >
      <SectionRows>
        <SectionRow
          title="Rotate the auth secret"
          description={
            <>
              Signs everyone out and makes stored notification credentials unreadable until they are
              entered again. Last rotated:{" "}
              <Timestamp iso={state.authSecretRotatedAt} fallback="never from here" />.
            </>
          }
          action={<RotateAuthSecretDialog />}
        />
        <SectionRow
          title="Remove Appflare from this account"
          description="Deletes Appflare and everything it runs on. The apps it installed stay and keep running, unmanaged."
          action={<RemoveAppflareDialog />}
        />
      </SectionRows>
    </Section>
  );
}

function RotateAuthSecretDialog() {
  return (
    <ConfirmDialog
      trigger={(p) => (
        <Button {...p} variant="destructive" icon={<KeyIcon />}>
          Rotate auth secret
        </Button>
      )}
      title="Rotate the auth secret"
      description="Appflare gives itself a new random sign-in secret, which deploys a new version of the same code with it."
      confirmText={ROTATE_CONFIRMATION}
      actionLabel="Rotate and sign everyone out"
      onConfirm={(typed) => submitForm(ROTATE_PATH, typed)}
    >
      <Banner
        variant="alert"
        icon={<WarningIcon weight="fill" />}
        title="Everyone is signed out, you included"
        description="Every session ends at once. Passwords and passkeys stay as they are, so everyone can sign in again."
      />
      <div className="grid gap-1.5">
        <Text bold>Notification channels</Text>
        <Text variant="secondary">
          Their credentials are encrypted with a key derived from this secret. After the rotation
          they show as unreadable, and nothing is sent to them until an admin enters the bot token
          or webhook URL again.
        </Text>
      </div>
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>Technical details</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <Text variant="secondary" size="sm">
            The secret is the <span className="font-mono text-[0.9em]">BETTER_AUTH_SECRET</span>{" "}
            secret of Appflare's own Worker.
          </Text>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </ConfirmDialog>
  );
}

type ReviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; review: RemovalReview };

function RemoveAppflareDialog() {
  const [state, setState] = useState<ReviewState>({ kind: "loading" });

  function onOpen() {
    setState({ kind: "loading" });
    getRemovalReview()
      .then((review) => setState({ kind: "ready", review }))
      .catch((error: unknown) =>
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Appflare could not read the account.",
        }),
      );
  }

  const review = state.kind === "ready" ? state.review : null;
  const blocked =
    review === null || review.activeJobs.length > 0 || review.externalDomains.length > 0;
  return (
    <ConfirmDialog
      size="lg"
      trigger={(p) => (
        <Button {...p} variant="destructive" icon={<TrashIcon />}>
          Remove Appflare
        </Button>
      )}
      title="Remove Appflare from this account"
      description="Review what goes and what stays. This cannot be undone."
      {...(review !== null && !blocked ? { confirmText: review.targets.accountName } : {})}
      actionLabel="Remove Appflare"
      disabled={blocked}
      onOpen={onOpen}
      onConfirm={(typed) => submitForm(REMOVE_PATH, typed)}
    >
      {state.kind === "loading" && (
        <div className="flex items-center gap-2">
          <AppflareLoader size="sm" />
          <Text variant="secondary">Reading the account…</Text>
        </div>
      )}
      {state.kind === "error" && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title="Appflare could not read what it would remove"
          description={<MessageText message={state.message} newTab />}
        />
      )}
      {review !== null && <RemovalReviewBody review={review} />}
    </ConfirmDialog>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.9em]">{children}</span>;
}

/** Names in monospace, as a list: "a, b and c". */
function MonoList({ names }: { names: readonly string[] }) {
  return names.map((name, i) => (
    <span key={name}>
      {i === 0 ? "" : i === names.length - 1 ? " and " : ", "}
      <Mono>{name}</Mono>
    </span>
  ));
}

function RemovalReviewBody({ review }: { review: RemovalReview }) {
  const { targets, stays, activeJobs, externalDomains } = review;
  const { gateway, sandbox, manager } = targets;
  const appCount = stays.apps.length;
  return (
    <>
      {activeJobs.length > 0 && (
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          title={
            activeJobs.length === 1 ? "A job is running" : `${activeJobs.length} jobs are running`
          }
          description="Appflare cannot be removed while a job is queued or running. Wait for it to finish, then open this dialog again."
        />
      )}
      {externalDomains.length > 0 && <ExternalDomainsBanner domains={externalDomains} />}
      <div className="grid gap-1.5">
        <Text bold>Deleted, in this order</Text>
        <ul className="grid list-disc gap-1 pl-5">
          {deletesBuildBucket(sandbox) && (
            <li>
              The R2 bucket <Mono>appflare-builds</Mono>, emptied first: every build output and
              build log of the sandbox Worker.
            </li>
          )}
          {gateway !== null && (
            <li>
              The external domains gateway on <Mono>{gateway.zoneName}</Mono>: the route{" "}
              <Mono>*/*</Mono>, the Worker <Mono>appflare-gateway</Mono>
              {gateway.fallbackSet && ", the zone's fallback origin (Appflare set it)"}
              {gateway.recordCreated && (
                <>
                  , the DNS record <Mono>appflare-gateway.{gateway.zoneName}</Mono>
                </>
              )}
              {gateway.kvId !== null && " and its KV namespace (the routing table)"}.
            </li>
          )}
          {sandbox.worker === "sandbox" && (
            <li>
              The sandbox Worker <Mono>appflare-sandbox</Mono>, with the secrets it holds.
            </li>
          )}
          {(sandbox.containerApps ?? []).length > 0 && (
            <li>
              The sandbox Worker's container applications,{" "}
              <MonoList names={(sandbox.containerApps ?? []).map((app) => app.name)} />.
            </li>
          )}
          {manager.kvId !== null && (
            <li>
              Appflare's KV namespace (catalog caches), <Mono>{manager.kvId}</Mono>.
            </li>
          )}
          {(targets.appAccessInstalls ?? []).length > 0 && (
            <li>
              The Cloudflare Access service tokens Appflare's health checks used for protected apps,
              taken out of their Access applications first.
            </li>
          )}
          {manager.d1Id !== null && (
            <li>
              Appflare's D1 database, <Mono>{manager.d1Id}</Mono>: users, passkeys, jobs and their
              logs, snapshots, notification channels and settings.
            </li>
          )}
          {targets.accessAppIds.length > 0 && (
            <li>
              The Cloudflare Access applications that protect Appflare, after the database, so a
              removal that stops earlier leaves Appflare protected.
            </li>
          )}
          <li>
            Last, the Worker <Mono>{manager.workerName}</Mono> itself, with its Workflow, cron
            trigger and workers.dev address. It deletes itself after the final page has reached your
            browser.
          </li>
        </ul>
      </div>
      {sandbox.worker === "sandbox" && sandbox.appTokens > 0 && (
        <Banner
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          title={`${sandbox.appTokens} self-deploying app${sandbox.appTokens === 1 ? "" : "s"} lose${sandbox.appTokens === 1 ? "s" : ""} the installer token`}
          description="The sandbox Worker keeps the Cloudflare token each self-deploying app's installer runs with. It is deleted with the sandbox Worker. The apps keep running, but nothing can update or destroy them through their installer any more. Revoke those tokens in the Cloudflare dashboard if you no longer need them."
        />
      )}
      {sandbox.worker === "missing" && sandbox.bucket && (
        <Text variant="secondary">
          The bucket <Mono>appflare-builds</Mono> stays: the sandbox Worker that used it is already
          gone, so the bucket was kept on purpose. Delete it in the Cloudflare dashboard if you no
          longer need its builds.
        </Text>
      )}
      {sandbox.worker === "other" && (
        <Text variant="secondary">
          A Worker named <Mono>appflare-sandbox</Mono> exists but is not a sandbox Worker, so it is
          left alone, and so is any bucket named <Mono>appflare-builds</Mono>.
        </Text>
      )}
      <div className="grid gap-1.5">
        <Text bold>Stays in the account</Text>
        <ul className="grid list-disc gap-1 pl-5">
          <li>
            {appCount === 0
              ? "No app is installed."
              : `${appCount === 1 ? "The installed app" : `All ${appCount} installed apps`}, with ${appCount === 1 ? "its" : "their"} Workers, databases, buckets, namespaces and secrets. They keep running, unmanaged: nothing updates them any more.`}
            {appCount > 0 && (
              <span className="text-kumo-subtle">
                {" "}
                ({stays.apps.map((a) => a.label).join(", ")})
              </span>
            )}
          </li>
          {stays.customDomains > 0 && (
            <li>
              {stays.customDomains === 1
                ? "The custom domain of an app, which keeps serving it."
                : `${stays.customDomains} custom domains of apps, which keep serving them.`}
            </li>
          )}
          {stays.protectedApps.length > 0 && (
            <li>
              The Cloudflare Access application of{" "}
              {stays.protectedApps.length === 1
                ? "the app protected with Access"
                : `the ${stays.protectedApps.length} apps protected with Access`}
              {stays.usersPolicy && ', and the "Appflare users" policy they use'}, so{" "}
              {stays.protectedApps.length === 1 ? "it keeps" : "they keep"} asking for a sign-in.
              Who can sign in is then managed in the Cloudflare dashboard under Zero Trust, Access.
              <span className="text-kumo-subtle">
                {" "}
                ({stays.protectedApps.map((a) => a.label).join(", ")})
              </span>
            </li>
          )}
          {stays.protectedApps.length === 0 && stays.usersPolicy && (
            <li>
              The "Appflare users" Cloudflare Access policy, for any Access application that still
              uses it. Manage or delete it in the Cloudflare dashboard under Zero Trust, Access.
            </li>
          )}
          {sandbox.worker === "sandbox" && sandbox.containerApps === null && (
            <li>
              The sandbox Worker's container applications,{" "}
              <MonoList names={SANDBOX_CONTAINERS.map((c) => c.name)} />. Cloudflare keeps them when
              the Worker is deleted, and Appflare's token lacks Containers: Edit, so it cannot
              delete them. Afterwards, delete them in the Cloudflare dashboard under Workers,
              Containers, or add that permission to the token first.
            </li>
          )}
        </ul>
      </div>
      <Text variant="secondary">
        The removal runs in this window and shows each step as it finishes. If a step fails, the
        rest stays, Appflare keeps working, and running the removal again finishes it.
      </Text>
    </>
  );
}

/** Why the removal is refused while apps have external domains, linking each app's Domains tab. */
function ExternalDomainsBanner({ domains }: { domains: RemovalReview["externalDomains"] }) {
  const apps = new Map<string, { label: string; hostnames: string[] }>();
  for (const d of domains) {
    const app = apps.get(d.installId) ?? { label: d.label, hostnames: [] };
    app.hostnames.push(d.hostname);
    apps.set(d.installId, app);
  }
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title="Remove these external domains first, or their visitors lose the site"
      description={
        <>
          Visitors of an external domain reach its app only through the gateway, which removing
          Appflare deletes.
          <ul className="mt-1.5 grid list-disc gap-1 pl-5">
            {[...apps.entries()].map(([id, app]) => (
              <li key={id}>
                <Link href={appLink(id, "external-domains")}>{app.label}</Link>:{" "}
                {app.hostnames.join(", ")}
              </li>
            ))}
          </ul>
        </>
      }
    />
  );
}
