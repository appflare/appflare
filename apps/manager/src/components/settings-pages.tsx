import type { AutoUpdateSettings } from "../auto-update/auto-update";
import { AppsAutomaticUpdatesSection } from "../auto-update/automatic-updates-card";
import { AccountCapabilitiesCard } from "../capabilities/account-capabilities-card";
import type { CapabilitiesView } from "../capabilities/capabilities";
import type { CatalogView } from "../catalog/catalogs.functions";
import type { ManagerUpdateState } from "../catalog/manager-releases.functions";
import type { DangerZoneState } from "../danger/danger.functions";
import { DangerZone } from "../danger/danger-zone";
import type { GatewayView } from "../gateway/gateway.server";
import type { RemovedAppRow } from "../installs/removed-apps.functions";
import type { ManagerVersionsState } from "../jobs/self-update/rollback.functions";
import type { ChannelView } from "../notifications/channels";
import type { ChecklistData } from "../onboarding/checklist.server";
import { OnboardingChecklistCard } from "../onboarding/onboarding-checklist";
import type { AccessStatus } from "../server/access.functions";
import type { PasskeyRow } from "../server/passkeys.functions";
import type { PasswordRecoverySettings } from "../server/recovery.functions";
import type { SandboxCardState } from "../server/sandbox.functions";
import type { Viewer } from "../server/session.functions";
import type { TokenStatus } from "../server/token.functions";
import type { UserRow } from "../server/users.functions";
import type { TelemetryStatus } from "../telemetry/telemetry";
import { AccessCard } from "./access-card";
import { AppflareUpdatesCard } from "./appflare-updates-card";
import { CatalogsList } from "./catalogs-settings";
import { CloudflareTokenCard } from "./cloudflare-token-card";
import { DocsLink } from "./docs-link";
import { GatewayCard } from "./gateway-card";
import { GithubAccessCard } from "./github-access-card";
import { ManagerVersionsSection } from "./manager-versions-section";
import { SETTINGS_PAGES } from "./navigation";
import { NotificationChannels } from "./notification-channels";
import { PageHeader } from "./page-header";
import { PasskeysSection } from "./passkeys-section";
import { PasswordRecoveryCard } from "./password-recovery-card";
import { RemovedAppsSection } from "./removed-apps-section";
import { SandboxCard } from "./sandbox-card";
import { UsageDataCard } from "./usage-data-card";
import { UsersSection } from "./users-section";

/**
 * The settings pages, each a page header (title, one line under it, an
 * optional docs link; no breadcrumbs, since the sidebar shows where you are)
 * and its sections, one card each (`section.tsx`). The routes load the data
 * and render these, so the pages render the same in tests.
 */

type SettingsPageKey = keyof typeof SETTINGS_PAGES;

/** A settings page's title and the line under it, from the settings page list. */
function SettingsPageHeader({
  page,
  title,
  docs,
}: {
  page: SettingsPageKey;
  title?: string;
  docs?: Parameters<typeof DocsLink>[0]["topic"];
}) {
  const { label, description } = SETTINGS_PAGES[page];
  return (
    <PageHeader
      title={title ?? label}
      description={description}
      titleAction={docs === undefined ? undefined : <DocsLink topic={docs} />}
    />
  );
}

/** `/settings`: whether apps update on their own by default, and the danger zone (last). */
export function GeneralSettingsView({
  autoUpdate,
  danger,
  viewer,
}: {
  autoUpdate: AutoUpdateSettings;
  danger: DangerZoneState;
  viewer: Pick<Viewer, "role" | "isOwner">;
}) {
  return (
    <>
      <SettingsPageHeader page="general" title="Settings" />
      <AppsAutomaticUpdatesSection settings={autoUpdate} isAdmin={viewer.role === "admin"} />
      <DangerZone isOwner={viewer.isOwner} state={danger} />
    </>
  );
}

/**
 * `/settings/account`: the Cloudflare connection (admins rotate the token),
 * the onboarding checklist, what the account can run, sandbox builds, and
 * GitHub access.
 */
export function AccountSettingsView({
  tokenStatus,
  capabilities,
  sandboxStatus,
  checklist,
  isAdmin,
}: {
  tokenStatus: TokenStatus;
  capabilities: CapabilitiesView;
  sandboxStatus: SandboxCardState;
  checklist: ChecklistData;
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="account" />
      <CloudflareTokenCard status={tokenStatus} canRotate={isAdmin} />
      <OnboardingChecklistCard data={checklist} isAdmin={isAdmin} />
      <AccountCapabilitiesCard view={capabilities} isAdmin={isAdmin} />
      <SandboxCard status={sandboxStatus} capabilities={capabilities} isAdmin={isAdmin} />
      <GithubAccessCard isAdmin={isAdmin} />
    </>
  );
}

/**
 * `/settings/users`: the users (admins add them and reset their passwords;
 * the owner changes roles, deletes users and transfers ownership), how a
 * forgotten password is recovered (admins), the signed-in user's own
 * passkeys, and Cloudflare Access in front of the manager.
 */
export function UsersSettingsView({
  users,
  recovery,
  passkeys,
  accessStatus,
  viewer,
}: {
  users: UserRow[] | null;
  /** Null for members. */
  recovery: PasswordRecoverySettings | null;
  passkeys: PasskeyRow[];
  accessStatus: AccessStatus;
  viewer: Pick<Viewer, "id" | "email" | "role">;
}) {
  return (
    <>
      <SettingsPageHeader page="users" />
      <UsersSection
        users={users}
        viewerId={viewer.id}
        // From the list, which heals a missing owner as it loads (users.server.ts).
        viewerIsOwner={users?.some((u) => u.id === viewer.id && u.isOwner) ?? false}
        emailReset={recovery?.email.enabled ?? false}
      />
      {recovery !== null && <PasswordRecoveryCard settings={recovery} />}
      <PasskeysSection passkeys={passkeys} />
      <AccessCard
        status={accessStatus}
        isAdmin={viewer.role === "admin"}
        viewerEmail={viewer.email}
      />
    </>
  );
}

/** `/settings/usage-data`: the anonymous daily report, its switch, and a preview of it. */
export function UsageDataSettingsView({
  telemetry,
  isAdmin,
}: {
  telemetry: TelemetryStatus;
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="usageData" docs="usageData" />
      <UsageDataCard status={telemetry} isAdmin={isAdmin} />
    </>
  );
}

/**
 * `/settings/domains`: the gateway that serves external domains (Cloudflare
 * for SaaS). Custom domains in the account's own zones need no setting; they
 * are added on each app's page.
 */
export function DomainsSettingsView({
  view,
  isAdmin,
}: {
  view: GatewayView | { error: string };
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="domains" />
      <GatewayCard view={view} isAdmin={isAdmin} />
    </>
  );
}

/** `/settings/notifications`: the channels (admins); members see a note. */
export function NotificationsSettingsView({ channels }: { channels: ChannelView[] | null }) {
  return (
    <>
      <SettingsPageHeader page="notifications" />
      <NotificationChannels channels={channels} />
    </>
  );
}

/** `/settings/catalogs`: the catalogs apps come from. */
export function CatalogsSettingsView({
  catalogs,
  isAdmin,
}: {
  catalogs: CatalogView[];
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="catalogs" />
      <CatalogsList catalogs={catalogs} isAdmin={isAdmin} />
    </>
  );
}

/** `/settings/removed-apps`: uninstalled apps that still keep data in the account. */
export function RemovedAppsSettingsView({
  rows,
  isAdmin,
}: {
  rows: RemovedAppRow[];
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="removedApps" docs="removedApps" />
      <RemovedAppsSection rows={rows} isAdmin={isAdmin} />
    </>
  );
}

/**
 * `/settings/appflare-updates`: the running version, the newest release,
 * the self-update and whether Appflare updates itself (admins), then
 * Appflare's own recent versions with the rollback to an older one.
 */
export function AppflareUpdatesSettingsView({
  managerUpdate,
  autoUpdate,
  versions,
  isAdmin,
}: {
  managerUpdate: ManagerUpdateState;
  autoUpdate: AutoUpdateSettings;
  versions: ManagerVersionsState;
  isAdmin: boolean;
}) {
  return (
    <>
      <SettingsPageHeader page="appflareUpdates" />
      <AppflareUpdatesCard state={managerUpdate} autoUpdate={autoUpdate} isAdmin={isAdmin} />
      <ManagerVersionsSection state={versions} isAdmin={isAdmin} current={managerUpdate.current} />
    </>
  );
}
