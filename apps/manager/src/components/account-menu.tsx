import { Badge, DropdownMenu, Text } from "@cloudflare/kumo";
import { FingerprintIcon, SignOutIcon, UsersIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { authClient } from "../auth/client";
import {
  ACCOUNT_LINKS,
  type AccountViewer,
  accountInitial,
  accountName,
  accountRoleLabel,
} from "./account";
import { RouterAnchor } from "./router-anchor";

/**
 * The sidebar footer's account menu (Kumo's DropdownMenu, with the avatar
 * trigger from its docs): the signed-in user's initial; open, their name
 * (or email), email and role, links to Users and access and to their
 * passkeys, and Sign out.
 */
export function AccountMenu({ viewer }: { viewer: AccountViewer }) {
  const router = useRouter();
  const name = accountName(viewer);
  const role = accountRoleLabel(viewer);

  async function signOut() {
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="rounded-full focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-hidden"
            aria-label={`Account: ${name}, ${role}`}
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
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="end" className="min-w-60">
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
          Users and access
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
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={SignOutIcon} variant="danger" onClick={() => void signOut()}>
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
