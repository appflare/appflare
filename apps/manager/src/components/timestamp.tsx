import { Tooltip } from "@cloudflare/kumo";
import { formatDate, formatDateTime, formatExactDateTime } from "./format";

/**
 * A point in time as every screen shows it: the medium date and short time
 * (or the day only), with the exact time and time zone in a Kumo tooltip.
 * The time is focusable so keyboard users can open the tooltip too.
 * `fallback` is shown when there is no time yet.
 */
export function Timestamp({
  iso,
  dateOnly = false,
  fallback = "Not yet",
}: {
  iso: string | null | undefined;
  dateOnly?: boolean;
  fallback?: string;
}) {
  if (!iso) return <>{fallback}</>;
  return (
    <Tooltip
      content={formatExactDateTime(iso)}
      render={
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the exact time's tooltip
        <time dateTime={iso} tabIndex={0} />
      }
    >
      {dateOnly ? formatDate(iso) : formatDateTime(iso)}
    </Tooltip>
  );
}
