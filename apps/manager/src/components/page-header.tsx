import { Breadcrumbs, Text } from "@cloudflare/kumo";
import { Fragment, type ReactNode } from "react";

export interface Crumb {
  label: string;
  href: string;
}

/**
 * Page title, optional one-line description, and trailing actions. A page
 * below another one names its parents in Kumo breadcrumbs above the title,
 * ending with the page itself.
 */
export function PageHeader({
  title,
  description,
  actions,
  parents,
  icon,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The pages above this one, outermost first. */
  parents?: Crumb[];
  /** Shown before the title, such as the app's icon. */
  icon?: ReactNode;
}) {
  return (
    <header className="grid gap-3">
      {parents !== undefined && parents.length > 0 && (
        <Breadcrumbs size="sm">
          {parents.map((crumb) => (
            <Fragment key={crumb.href}>
              <Breadcrumbs.Link href={crumb.href}>{crumb.label}</Breadcrumbs.Link>
              <Breadcrumbs.Separator />
            </Fragment>
          ))}
          <Breadcrumbs.Current>{title}</Breadcrumbs.Current>
        </Breadcrumbs>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon}
          <div className="grid min-w-0 gap-1">
            <Text variant="heading" size="lg" as="h1">
              {title}
            </Text>
            {description !== undefined && <Text variant="secondary">{description}</Text>}
          </div>
        </div>
        {actions !== undefined && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
