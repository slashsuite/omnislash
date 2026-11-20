// Fixture: a discarded promise the lint rule must fail. The repo lint ignores test/fixtures/**; the unit in
// lint-no-floating-promises.test.ts lints this file and asserts typescript/no-floating-promises fires.
//
// Typed by ./tsconfig.lint.json beside it, which includes only this file. Its lib is ES5 alone: that
// declares Promise, all the rule needs.
async function addTags(_db: unknown, _id: string, _tags: string[]): Promise<void> {}

declare const db: unknown;
declare const id: string;
declare const tags: string[];

addTags(db, id, tags);
