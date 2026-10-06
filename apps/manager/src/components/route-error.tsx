import { Banner } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ACCESS_DENIED_MESSAGE, isAccessDenied } from "../access/denied";
import { MessageText } from "./message-text";

/**
 * Default route error: the message only (server functions never put secrets in
 * errors). A call Cloudflare Access refused gets a plain explanation and a
 * reload, which sends the browser through the Access sign-in again.
 */
export function RouteError({ error }: ErrorComponentProps) {
  if (isAccessDenied(error)) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Banner
          variant="error"
          icon={<WarningCircleIcon weight="fill" />}
          description={ACCESS_DENIED_MESSAGE}
          action={
            <Banner.Action icon={<ArrowClockwiseIcon />} onClick={() => window.location.reload()}>
              Reload
            </Banner.Action>
          }
        />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Something went wrong"
        description={
          <MessageText message={error instanceof Error ? error.message : "Unexpected error."} />
        }
      />
    </div>
  );
}
