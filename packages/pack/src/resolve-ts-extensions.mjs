// ESM resolution hook (registered by the CLI). Node's native TypeScript support
// requires explicit `.ts` specifiers, but workspace packages such as
// `@appflare/schema` import their own modules extensionlessly. When the default
// resolver fails on a relative, extensionless specifier, retry with `.ts` and
// then `/index.ts`. Only affects the CLI process; tests use Vite's resolver.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasKnownExt = /\.[cm]?[jt]sx?$/.test(specifier);
    if (relative && !hasKnownExt) {
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        return await nextResolve(`${specifier}/index.ts`, context);
      }
    }
    throw error;
  }
}
