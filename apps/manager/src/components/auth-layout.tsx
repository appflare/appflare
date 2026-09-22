import { cn, LayerCard, Text } from "@cloudflare/kumo";
import { CloudIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Centered single-card layout for `/setup` and `/login`. `wide` fits the
 * Cloudflare token step's longer copy and two-button rows.
 */
export function AuthLayout({
  title,
  description,
  width = "narrow",
  children,
}: {
  title: string;
  description?: ReactNode;
  width?: "narrow" | "wide";
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-kumo-recessed px-4 py-10">
      <div className={cn("grid w-full gap-6", width === "wide" ? "max-w-xl" : "max-w-md")}>
        <div className="flex items-center justify-center gap-2">
          <CloudIcon size={24} weight="duotone" className="text-kumo-brand" />
          <Text variant="heading" size="lg" as="span">
            Appflare
          </Text>
        </div>
        <LayerCard>
          <LayerCard.Primary className="grid gap-6 px-6 py-5">
            <div className="grid gap-1.5">
              <Text variant="heading" as="h1">
                {title}
              </Text>
              {description !== undefined && <Text variant="secondary">{description}</Text>}
            </div>
            {children}
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </main>
  );
}
