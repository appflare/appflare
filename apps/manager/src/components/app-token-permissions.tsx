import type { TokenPermission } from "@appflare/schema";
import { Collapsible, LinkButton, Text } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import {
  type AppTokenPermission,
  appTokenTemplateUrl,
  r2ApiTokensUrl,
  resolveAppTokenPermissions,
  unmappedPermissionReason,
  userTokenTemplateUrl,
} from "../cloudflare/token-template";
import { useAccountId } from "./use-account-id";

const SCOPE_LABELS: Record<NonNullable<TokenPermission["scope"]>, string> = {
  account: "Account",
  zone: "Zone",
  user: "User",
};

/** How a permission reads in the list: the dashboard's group and level, else the catalog's name. */
export function permissionTitle(p: AppTokenPermission): string {
  if (p.group === null) return p.name;
  return `${p.group.label} · ${p.group.type === "edit" ? "Edit" : "Read"}`;
}

/**
 * How to create the Cloudflare API token an app needs for itself (its
 * catalog manifest's `tokenPermissions`), placed next to the field that
 * takes the token: a "Create token" link to the dashboard's token form with
 * every permission it can select already selected, and the permissions,
 * folded, each with what the app uses it for. A permission the link cannot
 * select says why on its own line. Renders nothing when the app needs no
 * token of its own.
 */
export function AppTokenHelp({
  appName,
  permissions,
}: {
  appName: string;
  permissions: readonly TokenPermission[];
}) {
  const accountId = useAccountId();
  if (permissions.length === 0) return null;
  const resolved = resolveAppTokenPermissions(permissions);
  const templateUrl = appTokenTemplateUrl(appName, resolved, accountId);
  const unmapped = resolved.filter((p) => p.group === null).length;
  // R2's own API token (Admin Read & Write) carries R2 storage, R2 Data
  // Catalog and R2 SQL together: the way wrangler's `pipelines setup` sends
  // people, and an alternative for a Pipelines sink's token.
  const r2Token = resolved.some((p) => /\br2 data catalog\b/i.test(p.name));
  return (
    <div className="grid gap-2" data-app-token-help="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LinkButton
          href={templateUrl ?? userTokenTemplateUrl([], appName, accountId)}
          external
          size="sm"
          variant="secondary"
          icon={<KeyIcon />}
        >
          Create token
        </LinkButton>
        <Text variant="secondary" size="sm">
          {templateUrl === null
            ? "Opens Cloudflare's token form; add the permissions listed below."
            : unmapped === 0
              ? "Opens Cloudflare with the permissions it needs already selected."
              : `Opens Cloudflare with the permissions it needs selected, except ${unmapped === 1 ? "one" : unmapped} you add yourself.`}
        </Text>
      </div>
      {r2Token && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <LinkButton
            href={r2ApiTokensUrl(accountId)}
            external
            size="sm"
            variant="secondary"
            icon={<KeyIcon />}
          >
            Create R2 API token
          </LinkButton>
          <Text variant="secondary" size="sm">
            Or an R2 API token with Admin Read &amp; Write, which has every R2 permission listed. It
            reaches every bucket in the account.
          </Text>
        </div>
      )}
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>
          Permissions it needs ({resolved.length})
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="grid gap-2 pt-1">
            <Text variant="secondary" size="sm">
              In the form, narrow the token to this account and the zones the app needs.
            </Text>
            <ul className="m-0 grid list-none gap-2 p-0">
              {resolved.map((p) => (
                <li key={p.name} className="grid gap-0.5">
                  <Text size="sm" bold>
                    {permissionTitle(p)}
                    {p.group === null && p.scope !== null && (
                      <span className="font-normal text-kumo-subtle">
                        {" "}
                        ({SCOPE_LABELS[p.scope]})
                      </span>
                    )}
                  </Text>
                  {p.description !== null && (
                    <Text variant="secondary" size="sm">
                      {p.description}
                    </Text>
                  )}
                  {p.group === null && (
                    <Text variant="secondary" size="sm">
                      {unmappedPermissionReason(p)}
                    </Text>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </div>
  );
}
