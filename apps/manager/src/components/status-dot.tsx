import { cn } from "@cloudflare/kumo";
import { APP_SIGNAL_LABELS, type AppSignal } from "../home/attention";

const DOT_COLOURS: Record<AppSignal, string> = {
  failed: "bg-kumo-danger",
  "not-responding": "bg-kumo-warning",
  update: "bg-kumo-info",
};

/**
 * The small dot beside an app's name in the sidebar and on its Home card:
 * red when something it was doing did not finish, amber when it is not
 * responding, blue when an update is available. Its meaning is its
 * accessible name and tooltip.
 */
export function StatusDot({ signal, className }: { signal: AppSignal; className?: string }) {
  const label = APP_SIGNAL_LABELS[signal];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-signal={signal}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_COLOURS[signal], className)}
    />
  );
}
