// ob 1616: one bounded wait for every call that can hang.
//
// On 2026-10-20 omnislash-web's Bun SQL pool leaked slots and every write hung 43 minutes with no error: a
// pooled client waits for a free connection forever, and so does a fetch to a host that accepted the
// socket and never answered. A hang tells the operator nothing; a deadline turns it into a named error
// (which call, how long) that lands in the journal and in the caller's hands.
//
// The deadline cannot cancel the work: a Bun SQL query has no abort, so the promise that lost the race
// keeps running and its eventual result (or rejection) is swallowed here rather than escaping as an
// unhandled rejection. `onTimeout` is the hook for the callers that CAN cancel (the fetch's AbortController).
import { AppError } from "./errors.ts";

/** A call that did not finish inside its deadline. `call` names it; `ms` is the budget it was given. */
export class CallTimeoutError extends AppError {
	readonly call: string;
	readonly ms: number;
	constructor(call: string, ms: number) {
		super(`${call} timed out after ${ms}ms`);
		this.name = "CallTimeoutError";
		this.call = call;
		this.ms = ms;
	}
}

/** `OB_*_TIMEOUT_MS`-style override: a positive integer, anything else is the fallback. */
export function timeoutFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env[name]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Run `run` and reject with a `CallTimeoutError` if it has not settled within `ms`. */
export async function withDeadline<T>(
	call: string,
	ms: number,
	run: () => Promise<T>,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const work = run();
	// If the deadline wins, `work` is orphaned: its later rejection must not become an unhandled one.
	work.catch(() => {});
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					try {
						onTimeout?.();
					} finally {
						reject(new CallTimeoutError(call, ms));
					}
				}, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
