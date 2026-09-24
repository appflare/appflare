import { formatDate, formatDateTime, formatExactDateTime } from "./format";

/**
 * A point in time as every screen shows it: the medium date and short time
 * (or the day only), with the exact time and time zone in its tooltip.
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
    <time dateTime={iso} title={formatExactDateTime(iso)}>
      {dateOnly ? formatDate(iso) : formatDateTime(iso)}
    </time>
  );
}
