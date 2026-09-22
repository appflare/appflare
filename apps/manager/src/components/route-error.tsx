import { Banner } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ErrorComponentProps } from "@tanstack/react-router";

/** Default route error: the message only (server functions never put secrets in errors). */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Something went wrong"
        description={error instanceof Error ? error.message : "Unexpected error."}
      />
    </div>
  );
}
