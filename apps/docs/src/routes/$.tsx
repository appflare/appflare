import { DocsLayout } from "@fumadocs/base-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "@fumadocs/base-ui/layouts/docs/page";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense, use } from "react";
import { getMDXComponents } from "../components/mdx.tsx";
import { baseOptions } from "../lib/layout.shared.tsx";
import { pageHead } from "../lib/meta.ts";
import {
  markdownUrl,
  ogImagePath,
  pageUrl,
  SITE_URL,
  siteName,
  slugsFromSplat,
  sourceFileUrl,
} from "../lib/shared.ts";
import { docs, source } from "../lib/source.ts";

export const Route = createFileRoute("/$")({
  loader: async ({ params }) => {
    const page = source.getPage(slugsFromSplat(params._splat));
    if (!page) throw notFound();
    await docs.getPage(page.path)?.preload();
    return {
      path: page.path,
      url: pageUrl(page.slugs),
      title: page.data.title,
      description: page.data.description,
      markdownUrl: markdownUrl(page.slugs),
      ogImage: ogImagePath(page.slugs),
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? pageHead({
          title: `${loaderData.title} | ${siteName}`,
          description: loaderData.description,
          url: `${SITE_URL}${loaderData.url}`,
          image: `${SITE_URL}${loaderData.ogImage}`,
        })
      : {},
  component: Page,
});

function Page() {
  const { path, markdownUrl } = Route.useLoaderData();
  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      <Suspense>
        <Content path={path} markdownUrl={markdownUrl} />
      </Suspense>
    </DocsLayout>
  );
}

function Content({ path, markdownUrl }: { path: string; markdownUrl: string }) {
  const page = docs.getPage(path);
  if (!page) throw notFound();
  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="-mt-4 flex flex-row items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={sourceFileUrl(path)} />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
