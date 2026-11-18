// OB-2261: the <head> entry both dashboards' root routes carry, naming the commit they were built from.
// vite's `define` replaces __BUILD_COMMIT__ at build time (each app's vite.config.ts, from build-commit.ts);
// anywhere that did not go through that build (bun test) it is undefined and the meta says `unknown`.
declare const __BUILD_COMMIT__: string | undefined;

export const BUILD_COMMIT_META = {
  name: "build-commit",
  content: typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "unknown",
};
