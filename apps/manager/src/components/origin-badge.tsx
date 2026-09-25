import { Badge } from "@cloudflare/kumo";
import { GitBranchIcon } from "@phosphor-icons/react";
import type { InstallOrigin } from "../db/schema";
import { BUILT_FROM_SOURCE, NOT_FROM_CATALOG } from "../installs/source-build-input";
import { Tooltip } from "./tooltip";

const TOOLTIPS: Record<Exclude<InstallOrigin, "catalog">, string> = {
  repository:
    "Built in your account from a repository you named. The catalog never reviewed it, and Appflare never updates it on its own: check for changes on its page.",
  source:
    "A catalog app built in your account from a commit you chose. The catalog did not check that commit; updating from the catalog puts its release back.",
};

/**
 * Marks an install whose code does not come from the catalog: "Not from the
 * catalog, not checked" for a repository, "Built from source, not checked"
 * for a catalog app built at another commit. Nothing for a catalog install.
 */
export function OriginBadge({ origin }: { origin: InstallOrigin }) {
  if (origin === "catalog") return null;
  return (
    <Tooltip content={TOOLTIPS[origin]}>
      <Badge variant="warning" icon={<GitBranchIcon aria-hidden />}>
        {origin === "repository" ? NOT_FROM_CATALOG : BUILT_FROM_SOURCE}
      </Badge>
    </Tooltip>
  );
}
