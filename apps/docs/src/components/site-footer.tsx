import Link from "fumadocs-core/link";

/** The foot of every page: the link to what the site records about visits. */
export function SiteFooter() {
  return (
    <footer className="border-fd-border border-t px-4 py-6 text-center text-fd-muted-foreground text-sm md:px-6">
      <Link href="/privacy/" className="hover:text-fd-foreground hover:underline">
        Privacy
      </Link>
    </footer>
  );
}
