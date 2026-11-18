// OB-2173: the Reviewers page's save path, kept out of the server-fn file so it tests without a store.
// The checks are the CLI's own (validateReviewReaders), so the page and `ob review readers` refuse alike.

import { ReviewReadersError, saveReviewReaders, validateReviewReaders, type ConfigIO, type ReviewReaders } from "../../../../apps/cli/src/review-readers.ts";

export type SaveResult = { ok: true; value: ReviewReaders } | { ok: false; error: string };

/** Check the page's value and store it. A value that does not pass stores nothing and says why. */
export async function saveReviewersValue(io: ConfigIO, value: unknown): Promise<SaveResult> {
  let clean: ReviewReaders;
  try {
    clean = validateReviewReaders(value);
  } catch (e) {
    if (e instanceof ReviewReadersError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, value: await saveReviewReaders(io, clean) };
}
