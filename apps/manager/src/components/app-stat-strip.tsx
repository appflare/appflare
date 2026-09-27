import { Badge, Text } from "@cloudflare/kumo";
import { StarIcon } from "@phosphor-icons/react";
import type { AppStat } from "../catalog/app-page";
import { Tooltip } from "./tooltip";

/**
 * The row of small facts under an app's header (stars, plan, license,
 * version, size, last tested, category): a plain label over each value, the
 * detail in a tooltip. One row on wider screens, two rows on phones.
 */
export function AppStatStrip({ stats }: { stats: readonly AppStat[] }) {
  return (
    <dl className="m-0 grid grid-cols-4 gap-y-4 border-kumo-hairline border-y py-4 md:flex md:divide-x md:divide-kumo-hairline">
      {stats.map((stat) => (
        <div
          key={stat.id}
          className="grid min-w-0 content-start justify-items-center gap-1 px-2 text-center md:flex-1"
        >
          <dt>
            <Text as="span" variant="secondary" size="xs">
              {stat.label}
            </Text>
          </dt>
          <dd className="m-0 grid min-w-0 max-w-full justify-items-center gap-0.5">
            <Tooltip content={stat.tooltip} className="min-w-0 max-w-full">
              <StatValue stat={stat} />
            </Tooltip>
            {stat.caption !== null && (
              <Text as="span" variant="secondary" size="xs">
                {stat.caption}
              </Text>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatValue({ stat }: { stat: AppStat }) {
  if (stat.tone === "warning") return <Badge variant="warning">{stat.value}</Badge>;
  return (
    <span className="flex min-w-0 items-center justify-center gap-1 font-semibold text-kumo-default">
      {stat.id === "stars" && <StarIcon aria-hidden weight="fill" className="shrink-0" />}
      <span className="text-balance [overflow-wrap:anywhere]">{stat.value}</span>
    </span>
  );
}
