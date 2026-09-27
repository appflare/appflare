import type { TokenPermission } from "@appflare/schema";
import { Badge, LayerCard, Link, LinkButton, Table, Text } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import {
  appTokenTemplateUrl,
  R2_API_TOKENS_URL,
  resolveAppTokenPermissions,
  USER_API_TOKENS_URL,
} from "../cloudflare/token-template";

const SCOPE_LABELS: Record<NonNullable<TokenPermission["scope"]>, string> = {
  account: "Account",
  zone: "Zone",
  user: "User",
};

/**
 * The Cloudflare token an app needs for itself (its catalog manifest's
 * `tokenPermissions`): each permission, and a link to the dashboard's token form
 * prefilled with the ones Appflare can map. Renders nothing when the app needs
 * no token of its own.
 */
export function AppTokenPermissions({
  appName,
  permissions,
  custody = "app",
}: {
  appName: string;
  permissions: readonly TokenPermission[];
  /**
   * Where the token goes: `app`, a secret on the app's Worker; `sandbox`, a
   * secret on the sandbox Worker, where a self-deploying app's own installer
   * runs with it.
   */
  custody?: "app" | "sandbox";
}) {
  if (permissions.length === 0) return null;
  const resolved = resolveAppTokenPermissions(permissions);
  const templateUrl = appTokenTemplateUrl(appName, resolved);
  const unmapped = resolved.some((p) => p.group === null);
  // R2 Data Catalog has no template key; the R2 API token form's Admin Read &
  // Write grants it together with R2 storage and R2 SQL.
  const r2Token = resolved.some((p) => /\br2 data catalog\b/i.test(p.name));
  return (
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        This app needs its own Cloudflare token
      </Text>
      {custody === "sandbox" ? (
        <Text variant="secondary">
          {appName} deploys itself: its own installer creates its Workers and resources with a token
          you create for it, not with the manager's. The install form asks for it and stores it as a
          secret on your sandbox Worker, where the installer runs; Appflare keeps no copy. Updating
          and uninstalling use it again, so keep it valid while the app is installed.
        </Text>
      ) : (
        <Text variant="secondary">
          {appName} calls the Cloudflare API with a token you create for it. The token belongs to
          the app, not to the manager: when the install form asks for it, it is stored as a secret
          on the app's Worker, never on the manager's; otherwise the app's setup steps say where it
          goes.
        </Text>
      )}
      <LayerCard className="p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Permission</Table.Head>
              <Table.Head>Scope</Table.Head>
              <Table.Head>What the app uses it for</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {resolved.map((p) => (
              <Table.Row key={p.name}>
                <Table.Cell>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[0.9em]">{p.name}</span>
                    {p.group === null && templateUrl !== null && (
                      <Badge variant="outline">Add by hand</Badge>
                    )}
                  </span>
                </Table.Cell>
                <Table.Cell>{p.scope !== null ? SCOPE_LABELS[p.scope] : ""}</Table.Cell>
                <Table.Cell>{p.description ?? ""}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
      {r2Token && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LinkButton href={R2_API_TOKENS_URL} external variant="secondary" icon={<KeyIcon />}>
            Create R2 API token
          </LinkButton>
          <Text variant="secondary" size="sm">
            Opens the account's R2 API tokens. Create an account API token with Admin Read &amp;
            Write: it has every R2 permission listed here. It reaches every bucket in the account.
          </Text>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {templateUrl !== null ? (
          <>
            <LinkButton href={templateUrl} external variant="secondary" icon={<KeyIcon />}>
              Create token
            </LinkButton>
            <Text variant="secondary" size="sm">
              Opens a user API token form with{" "}
              {unmapped ? "the permissions Appflare recognizes" : "these permissions"} selected.
              Narrow its accounts and zones to the ones the app needs.
            </Text>
          </>
        ) : (
          <Text variant="secondary" size="sm">
            Create the token in the Cloudflare dashboard under{" "}
            <Link href={USER_API_TOKENS_URL} target="_blank" rel="noopener noreferrer">
              API tokens <Link.ExternalIcon />
            </Link>{" "}
            and add these permissions by hand.
          </Text>
        )}
      </div>
    </section>
  );
}
