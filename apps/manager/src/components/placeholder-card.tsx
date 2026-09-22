import { Badge, LayerCard, Text } from "@cloudflare/kumo";

/**
 * A settings section or page that is designed but not built yet. Honest by
 * construction: always labelled "Not available yet".
 */
export function PlaceholderCard({ title, description }: { title: string; description: string }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        <span>{title}</span>
        <Badge variant="beta">Not available yet</Badge>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-1.5 px-5 py-4">
        <Text>{description}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
