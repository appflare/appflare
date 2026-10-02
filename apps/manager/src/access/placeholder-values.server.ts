import { accessCertsUrl, isAccessTeamDomain } from "@appflare/cf-api";
import { type AccessPlaceholderValues, accessTeamNameOf } from "@appflare/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { install_access } from "../db/schema";

/**
 * What an app's `{{accessTeamDomain}}`, `{{accessTeamName}}`, `{{accessAud}}`
 * and `{{accessCertsUrl}}` are filled in with: its Cloudflare Access protection
 * as recorded (access/protect.server.ts), or null when Appflare does not
 * protect it, which fills them in empty. Every deploy reads them here (or,
 * for an install protected before its first upload, from the protection it
 * just made), so a version never carries values of another protection.
 */

/** The values of a protection; a team domain that is not `<team>.cloudflareaccess.com` gives no keys URL. */
export function accessPlaceholderValues(protection: {
  teamDomain: string | null;
  aud: string | null;
}): AccessPlaceholderValues {
  const teamDomain =
    protection.teamDomain !== null && isAccessTeamDomain(protection.teamDomain)
      ? protection.teamDomain
      : "";
  return {
    teamDomain,
    teamName: accessTeamNameOf(teamDomain),
    aud: protection.aud ?? "",
    certsUrl: teamDomain === "" ? "" : accessCertsUrl(teamDomain),
  };
}

/** The install's Access placeholder values from D1; null when Appflare does not protect it. */
export async function readAccessPlaceholderValues(
  orm: Database,
  installId: string,
): Promise<AccessPlaceholderValues | null> {
  const [row] = await orm
    .select({ aud: install_access.access_aud, teamDomain: install_access.access_team_domain })
    .from(install_access)
    .where(and(eq(install_access.install_id, installId), isNotNull(install_access.access_app_id)))
    .limit(1);
  return row === undefined ? null : accessPlaceholderValues(row);
}
