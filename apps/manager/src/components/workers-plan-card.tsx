import { Badge, Banner, LayerCard, Radio, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ACCOUNT_PLAN_COPY, type AccountPlan, accountPlanSchema } from "../account/plan";
import { setAccountPlan } from "../account/plan.functions";

/**
 * Settings, Workers plan: the plan an admin states for the account, which
 * Cloudflare's API does not expose. Admins change it with the radio group
 * (saved at once); members see it read-only.
 */
export function WorkersPlanCard({ plan, isAdmin }: { plan: AccountPlan; isAdmin: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<AccountPlan>(plan);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: string) {
    const parsed = accountPlanSchema.safeParse(next);
    if (!parsed.success || parsed.data === value) return;
    const previous = value;
    setValue(parsed.data);
    setPending(true);
    setError(null);
    try {
      await setAccountPlan({ data: { plan: parsed.data } });
      await router.invalidate();
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : "Could not save the Workers plan.");
    }
    setPending(false);
  }

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>{ACCOUNT_PLAN_COPY.title}</span>
        <Badge variant={value === "paid" ? "orange" : "neutral"}>
          {ACCOUNT_PLAN_COPY.labels[value]}
        </Badge>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <Text variant="secondary">{ACCOUNT_PLAN_COPY.explanation}</Text>
        <Radio.Group
          legend="This account's Workers plan"
          value={value}
          onValueChange={(next: string) => void onChange(next)}
          disabled={!isAdmin || pending}
          orientation="horizontal"
        >
          <Radio.Item label={ACCOUNT_PLAN_COPY.labels.free} value="free" />
          <Radio.Item label={ACCOUNT_PLAN_COPY.labels.paid} value="paid" />
        </Radio.Group>
        {!isAdmin && (
          <Text variant="secondary" size="sm">
            Only admins can change it.
          </Text>
        )}
        {error !== null && (
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={error} />
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
