import { Badge, DropdownMenu, Text } from "@cloudflare/kumo";
import {
  BookOpenTextIcon,
  CircleHalfIcon,
  DesktopIcon,
  FingerprintIcon,
  type Icon,
  InfoIcon,
  LifebuoyIcon,
  MoonIcon,
  SignOutIcon,
  SparkleIcon,
  StarIcon,
  SunIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../auth/client";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import { managerSiteLink } from "../site-links";
import { feedbackIssueUrl, REPOSITORY_URL } from "../whats-new/project-links";
import { unreadLabel } from "../whats-new/release-notes";
import { useWhatsNew } from "../whats-new/use-whats-new";
import { WhatsNewDialog } from "../whats-new/whats-new-dialog";
import {
  ACCOUNT_LINKS,
  type AccountViewer,
  accountInitial,
  accountName,
  accountRoleLabel,
} from "./account";
import { appEntryMemo } from "./app-entry-memo";
import { DOCS_URL } from "./auth-layout";
import { type ColorModeChoice, parseColorModeChoice } from "./color-mode";
import { RouterAnchor } from "./router-anchor";
import { useColorMode } from "./use-color-mode";

const APPEARANCE: readonly { value: ColorModeChoice; label: string; icon: Icon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: DesktopIcon },
];

/** Outside links open in a new tab and send no referrer (the manager's hostname stays private). */
const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * The sidebar footer's account menu (Kumo's DropdownMenu, with the avatar
 * trigger from its docs): the signed-in user's initial, with a dot while
 * release notes are unread. Open, their name (or email), email and role;
 * links to Users and sign-in and to their passkeys; Appearance (light, the
 * default, dark, or the browser's setting); "What's new" (Appflare's
 * release notes, with the unread count), Documentation, Feedback (a new
 * issue on the repository, prefilled with the version) and "Give us a
 * star"; and Sign out. In the folded sidebar, where the footer has no room
 * for it, the menu also carries Appflare's version.
 */
export function AccountMenu({
  viewer,
  version,
  collapsed = false,
}: {
  viewer: AccountViewer;
  /** The running Appflare version. */
  version: string;
  /** The sidebar is folded into its icon rail. */
  collapsed?: boolean;
}) {
  const router = useRouter();
  const name = accountName(viewer);
  const role = accountRoleLabel(viewer);
  const whatsNew = useWhatsNew();
  const [notesOpen, setNotesOpen] = useState(false);
  const [colorMode, setColorMode] = useColorMode();
  const unread = whatsNew.unread;
  const unreadNotes = `${unread} unread release ${unread === 1 ? "note" : "notes"}`;

  async function signOut() {
    await authClient.signOut();
    appEntryMemo.forget();
    await router.navigate({ to: "/login" });
  }

  function openNotes() {
    whatsNew.markAllSeen();
    setNotesOpen(true);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              className="relative shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-hidden"
              aria-label={`Account: ${name}, ${role}${unread > 0 ? `, ${unreadNotes}` : ""}`}
              title={name}
            />
          }
        >
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full bg-kumo-brand text-sm font-medium text-white"
          >
            {accountInitial(viewer)}
          </span>
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-kumo-danger ring-2 ring-kumo-base"
            />
          )}
        </DropdownMenu.Trigger>
        {/* Folded, the trigger sits at the sidebar's left edge: the menu opens to its right. */}
        <DropdownMenu.Content side="top" align={collapsed ? "start" : "end"} className="min-w-60">
          <DropdownMenu.Group>
            <DropdownMenu.Label className="grid gap-1 font-normal">
              <span className="flex min-w-0 items-center justify-between gap-3">
                <Text bold truncate as="span">
                  {name}
                </Text>
                <Badge variant={role === "Member" ? "neutral" : "primary"}>{role}</Badge>
              </span>
              {name !== viewer.email && (
                <Text size="sm" variant="secondary" truncate as="span">
                  {viewer.email}
                </Text>
              )}
            </DropdownMenu.Label>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.LinkItem
            href={ACCOUNT_LINKS.users}
            icon={UsersIcon}
            render={<RouterAnchor />}
            // The page changes in place, so the menu closes itself.
            closeOnClick
          >
            Users and sign-in
          </DropdownMenu.LinkItem>
          <DropdownMenu.LinkItem
            href={ACCOUNT_LINKS.passkeys}
            icon={FingerprintIcon}
            render={<RouterAnchor />}
            // The page changes in place, so the menu closes itself.
            closeOnClick
          >
            Your passkeys
          </DropdownMenu.LinkItem>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger icon={CircleHalfIcon}>Appearance</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              <DropdownMenu.RadioGroup
                value={colorMode}
                onValueChange={(value) => setColorMode(parseColorModeChoice(String(value)))}
              >
                {APPEARANCE.map((option) => (
                  <DropdownMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    icon={option.icon}
                    closeOnClick={false}
                  >
                    {option.label}
                    <DropdownMenu.RadioItemIndicator />
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={SparkleIcon} onClick={openNotes}>
            What's new
            {unread > 0 && (
              <Badge variant="error" className="ml-auto">
                <span aria-hidden>{unreadLabel(unread)}</span>
                <span className="sr-only">{unreadNotes}</span>
              </Badge>
            )}
          </DropdownMenu.Item>
          <DropdownMenu.LinkItem
            href={managerSiteLink(DOCS_URL, "accountMenu")}
            icon={BookOpenTextIcon}
            {...EXTERNAL}
          >
            Documentation
          </DropdownMenu.LinkItem>
          <DropdownMenu.LinkItem href={feedbackIssueUrl(version)} icon={LifebuoyIcon} {...EXTERNAL}>
            Feedback
          </DropdownMenu.LinkItem>
          <DropdownMenu.LinkItem href={REPOSITORY_URL} icon={StarIcon} {...EXTERNAL}>
            Give us a star
          </DropdownMenu.LinkItem>
          {collapsed && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.LinkItem
                href={MANAGER_UPDATES_HREF}
                icon={InfoIcon}
                render={<RouterAnchor />}
                closeOnClick
              >
                Appflare {version}
              </DropdownMenu.LinkItem>
            </>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={SignOutIcon} onClick={() => void signOut()}>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <WhatsNewDialog
        open={notesOpen}
        onOpenChange={setNotesOpen}
        current={whatsNew.data?.current ?? version}
        releases={whatsNew.data?.releases ?? []}
        seenBefore={whatsNew.seenBefore}
      />
    </>
  );
}
