// The after-deploy proof for ob 1657: report ONE deliberate error as a daemon would, then say what it was
// reported as. Run on the API host, as the `ob` user, from the checkout the daemon runs from:
//
//   cd /opt/omnislash && OMNISLASH_SENTRY_ENVIRONMENT=live bun apps/cli/src/sentry/selftest.ts web|bridge
//
// It goes through the same `startSentry` the daemons use (same secret, same release, same scrub), so the event
// that lands in Sentry carries the sha and environment a real error from that daemon would. Exits 1 when no
// DSN is configured, since a self-test that sent nothing has proved nothing.
import { getStore } from "../db/store.ts";
import { flushSentry, reportError, SENTRY_DAEMONS, startSentry, type SentryDaemon } from "./report.ts";

const daemon = process.argv[2] as SentryDaemon | undefined;
if (daemon !== "web" && daemon !== "bridge") {
  console.error(`usage: bun ${process.argv[1]} <${Object.keys(SENTRY_DAEMONS).join("|")}>`);
  process.exit(2);
}

const started = await startSentry(daemon, () => getStore({ migrate: false }));
if (!started) {
  console.error(`sentry is OFF for ${daemon}: ${SENTRY_DAEMONS[daemon].secret} is not readable here, so nothing was sent`);
  process.exit(1);
}
reportError(new Error(`ob 1657 sentry self-test (${daemon}): deliberate error, safe to ignore`), { selftest: "1" });
await flushSentry(5000);
console.log(`sent one deliberate error to ${started.project}: release ${started.release}, environment ${started.environment}`);
process.exit(0);
