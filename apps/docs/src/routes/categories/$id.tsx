import { createFileRoute, notFound } from "@tanstack/react-router";
import Link from "fumadocs-core/link";
import { categoryDescription, categoryTitle } from "../../catalog/pages.ts";
import { appsInCategory } from "../../catalog/storefront.ts";
import { appsPath, categoryPath } from "../../catalog/urls.ts";
import { CatalogHeader, CatalogLayout } from "../../components/catalog/catalog-layout.tsx";
import { AppGrid, CategoryCards } from "../../components/catalog/tiles.tsx";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";

/** `/categories/<id>/`: every app in one category, most popular first. */
export const Route = createFileRoute("/categories/$id")({
  loader: async ({ params }) => {
    const { findCategory, siteCatalog } = await import("../../catalog/data.ts");
    const category = findCategory(params.id);
    if (!category) throw notFound();
    return {
      category,
      apps: appsInCategory(siteCatalog.apps, category.id),
      categories: siteCatalog.categories,
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? pageHead({
          title: `${categoryTitle(loaderData.category)} | ${siteName}`,
          description: categoryDescription(loaderData.category),
          url: `${SITE_URL}${categoryPath(loaderData.category.id)}`,
          image: `${SITE_URL}${ogImagePath(["categories", loaderData.category.id])}`,
        })
      : {},
  component: CategoryPage,
});

function CategoryPage() {
  const { category, apps, categories } = Route.useLoaderData();
  return (
    <CatalogLayout>
      <nav aria-label="Breadcrumb" className="-mb-6 text-fd-muted-foreground text-sm">
        <Link href={appsPath} className="hover:text-fd-foreground">
          Apps
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{category.label}</span>
      </nav>
      <CatalogHeader title={categoryTitle(category)} description={categoryDescription(category)} />
      <AppGrid apps={apps} />
      <section className="grid gap-3">
        <h2 className="font-semibold text-lg">All categories</h2>
        <CategoryCards categories={categories} current={category.id} />
      </section>
    </CatalogLayout>
  );
}
