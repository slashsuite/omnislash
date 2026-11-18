// ob 337: which engine this process is configured to use, in a module that depends on NOTHING but errors.ts.
//
// This lived in store.ts (ob 324) and still reads from there, unchanged, via a re-export. It was split out
// because db.ts's openDb has to ask the question too -- that is the whole of the two-live-stores guard --
// and store.ts imports db.ts, so asking it from there would be a cycle. The alternative was db.ts parsing
// the variable itself, which is how one setting quietly becomes two settings that disagree.
import { AppError } from "../errors.ts";

export type StoreKind = "sqlite" | "postgres";

export const STORE_ENV = "OMNISLASH_STORE";

/**
 * How a caller is told to get back to the SQLite file, in one place because six messages say it.
 *
 * It used to be "unset OMNISLASH_STORE", which was correct while sqlite was the default. It is now the
 * opposite instruction, and an out-of-date one would send someone straight back to the failure this whole
 * change exists to remove: a shell with nothing set, opening a stale SQLite database that answers.
 */
export const SQLITE_ESCAPE_HATCH = `${STORE_ENV}=sqlite`;

/**
 * Which engine this process uses. POSTGRES unless explicitly told otherwise.
 *
 * The default was sqlite through ob 324/337, because SQLite was authoritative and the cutover had not
 * happened. It has now happened: Postgres holds the data, the SQLite file on this machine is a frozen
 * copy that nothing writes, and so an unset or empty variable can no longer mean "sqlite" without meaning
 * "answer from a database that is months out of date, cheerfully and with no error". That is the ob 237
 * failure class, and the environment is not a safe place to keep the only thing standing between a fresh
 * shell and it: ~/.zshrc is not writable here, so every new terminal starts with nothing set.
 *
 * So the default moved into the BUILD, where it cannot be lost by opening a new window. `OMNISLASH_STORE=sqlite`
 * still selects SQLite, deliberately and by name: the ~30 unported commands need it, and so do the foreign
 * SQLite files ob reads (the WhatsApp bridge store, the HA recorder).
 */
export function resolveStoreKind(raw?: string): StoreKind {
	const value = (raw ?? process.env[STORE_ENV] ?? "").trim().toLowerCase();
	if (value === "" || value === "postgres" || value === "postgresql" || value === "pg") return "postgres";
	if (value === "sqlite") return "sqlite";
	throw new AppError(
		`${STORE_ENV}=${value} is not a store: use 'postgres' (the default) or 'sqlite'. Unset it to get the default, postgres.`,
	);
}
