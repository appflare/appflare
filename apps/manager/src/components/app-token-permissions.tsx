import type { TokenPermission } from "@appflare/schema";
import { Badge, LayerCard, Link, LinkButton, Table, Text } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import {
  appTokenTemplateUrl,
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
}: {
  appName: string;
  permissions: readonly TokenPermission[];
}) {
  if (permissions.length === 0) return null;
  const resolved = resolveAppTokenPermissions(permissions);
  const templateUrl = appTokenTemplateUrl(appName, resolved);
  const unmapped = resolved.some((p) => p.group === null);
  return (
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        This app needs its own Cloudflare token
      </Text>
      <Text variant="secondary">
        {appName} calls the Cloudflare API with a token you create for it. The token belongs to the
        app, not to the manager: when the install form asks for it, it is stored as a secret on the
        app's Worker, never on the manager's; otherwise the app's setup steps say where it goes.
      </Text>
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
