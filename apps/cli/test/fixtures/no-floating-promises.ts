// Fixture for ob 338 — a discarded promise the lint rule must fail. Not part of `moon run cli:lint`
// (ignored via test/fixtures/**). The unit in lint-no-floating-promises.test.ts lints this file
// and asserts @typescript-eslint/no-floating-promises fires.
//
// Typed by ./tsconfig.lint.json beside it (OB-2058), which includes only this file; a new fixture here
// needs adding to it. Its lib is ES5 alone (OB-2217): that declares Promise, all the rule needs.
async function addTags(_db: unknown, _id: string, _tags: string[]): Promise<void> {}

declare const db: unknown;
declare const id: string;
declare const tags: string[];

addTags(db, id, tags);
