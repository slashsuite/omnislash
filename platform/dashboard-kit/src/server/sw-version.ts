// ob 1693: serve public/sw.js with a build version. The worker's cache name carries it, so a deploy that
// changes any built file changes the served sw.js, the browser installs the new worker, and its activate step
// drops the old cache. The version is a hash of every built file's path and contents (the build is a few MB and this runs
// once at start-up, so an icon or the offline page changing in place at the same size still changes it), so restarting on an
// unchanged build yields the same version and does not churn every installed copy.
//
// It is stamped when serve.ts answers `/sw.js`, not by a Vite hook: the build copies `public/` after the
// bundle hooks have run, so a stamp written there is overwritten by the raw file.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SW_PLACEHOLDER = "__SW_VERSION__";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The version for the built client directory, 12 hex chars. `sw.js` itself is left out of the hash. */
export function swVersionFor(clientDir: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(clientDir).sort()) {
    const rel = relative(clientDir, file);
    if (rel === "sw.js") continue;
    hash.update(`${rel}\0`).update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** `<clientDir>/sw.js` with the version in place of the placeholder. Throws if the placeholder is missing. */
export function stampedServiceWorker(clientDir: string): string {
  const path = join(clientDir, "sw.js");
  const source = readFileSync(path, "utf8");
  if (!source.includes(SW_PLACEHOLDER)) throw new Error(`${path} has no ${SW_PLACEHOLDER} to stamp`);
  return source.replaceAll(SW_PLACEHOLDER, swVersionFor(clientDir));
}
