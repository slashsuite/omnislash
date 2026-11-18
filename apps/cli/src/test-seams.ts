/**
 * Module test seams that cannot leak into another test file (OB-2150).
 *
 * A seam is a module-level value a test swaps for a fake (`__setSh`, `__setT3Seam`, ...). bun runs every test
 * file of a project in ONE process, so a stub one file leaves installed is what every later file gets: OB-2145
 * found a lost restore in t3-dispatch.test.ts (`restore = __setSh(a); restore = __setSh(b)`, so the `afterEach`
 * put back `a`) failing 9 tests in spinoff.test.ts, which read as a flake in the wrong file.
 *
 * Every seam is defined here, so the test preload (`apps/cli/test/preload.ts`) can check after EACH test that
 * every seam is back to its real value. A seam left stubbed is reset and fails the test that left it, so the
 * next test (and the next file) always starts with the real one.
 *
 * A new seam MUST use `defineSeam`; one that does not is invisible to that guard.
 */

export interface Seam<T> {
  readonly name: string;
  /** The value in force: the stub while one is installed, else the real one. */
  get(): T;
  /** Install `next`; returns a restore of the value it replaced. */
  set(next: T): () => void;
  /** Is the real value installed? */
  isReal(): boolean;
  /** Put the real value back. */
  reset(): void;
}

const registry = new Map<string, Seam<unknown>>();

/** Define a seam whose real value is `real`. Names are unique; a module evaluated again replaces its entry. */
export function defineSeam<T>(name: string, real: T): Seam<T> {
  let current = real;
  const seam: Seam<T> = {
    name,
    get: () => current,
    set(next) {
      const prev = current;
      current = next;
      return () => {
        current = prev;
      };
    },
    isReal: () => current === real,
    reset() {
      current = real;
    },
  };
  registry.set(name, seam as Seam<unknown>);
  return seam;
}

/** Every seam defined so far (only the modules this process has loaded). */
export function seamNames(): string[] {
  return [...registry.keys()];
}

/** Reset every seam that is not real, and return their names. */
function resetLeakedSeams(): string[] {
  const leaked: string[] = [];
  for (const seam of registry.values()) {
    if (seam.isReal()) continue;
    leaked.push(seam.name);
    seam.reset();
  }
  return leaked;
}

/** The guard: throws, naming each seam, when one is left stubbed; the seams are reset before it throws. */
export function assertSeamsReal(): void {
  const leaked = resetLeakedSeams();
  if (leaked.length === 0) return;
  throw new Error(
    `this test left the ${leaked.join(", ")} seam${leaked.length > 1 ? "s" : ""} stubbed (OB-2150): ` +
      "restore every stub it installs (a second set overwrites the first restore). The seams are reset, so the next test starts real.",
  );
}
