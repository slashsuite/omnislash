import { describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { computeAlerts, filterSnoozed, snoozeAlert } from "../../../apps/cli/src/commands/alerts.ts";
import {
  declaredJobs,
  jobForInvocation,
  jobHealth,
  recordJobAttempt,
  recordJobResult,
} from "../../../apps/cli/src/jobs.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { nowIso } from "../../../apps/cli/src/db.ts";

// ob 218. Four daemon jobs each failed silently for weeks and every one was found by a person opening a
// log file. The four cases below are those four outages, reconstructed at their real timescales, and each
// one asserts the two things that matter: it produces exactly ONE alert, of the right shape, and it goes
// quiet again when the underlying state is fixed.

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (now: string, seconds: number) => iso(Date.parse(now) - seconds * 1000);
const DAY = 86_400;

/** Only the job-health rules, so an unrelated item/PR rule can never be mistaken for one of these. */
async function jobAlerts(store: Store, now: string) {
  return (await computeAlerts(store, { focusProject: null, now })).filter((a) => a.rule >= 7);
}

/**
 * A fleet that has been running for `sinceS` and last succeeded a moment ago. Every case starts from a
 * healthy fleet and breaks exactly one job, because the alerts are relative to the fleet: a job with no
 * record is only suspicious once the OTHER jobs prove this machine has been tracking them for a while.
 */
async function seedHealthyFleet(store: Store, now: string, opts: { sinceS?: number; skip?: string[] } = {}): Promise<void> {
  const since = ago(now, opts.sinceS ?? 30 * DAY);
  const skip = new Set(opts.skip ?? []);
  for (const d of declaredJobs()) {
    if (skip.has(d.job)) continue;
    await recordJobAttempt(store, d.job, since);
    await recordJobResult(store, d.job, { ok: true }, ago(now, 60));
  }
}

/** `count` failures ending at `now`, spaced `everyS` apart, exactly as a timer would have produced them. */
async function failRepeatedly(
  store: Store,
  job: string,
  opts: { now: string; everyS: number; count: number; error: string },
): Promise<void> {
  for (let i = opts.count; i >= 1; i--) {
    const at = ago(opts.now, i * opts.everyS);
    await recordJobAttempt(store, job, at);
    await recordJobResult(store, job, { ok: false, error: opts.error }, at);
  }
}

describe("the declaration is the source of expected cadence (218)", () => {
  test("every launchd/systemd job daemonJobs() declares is health-tracked", async () => {
    const names = declaredJobs().map((d) => d.job);
    expect(names).toContain("gmail-sync");
    expect(names).toContain("cal-sync");
    // ob 208 retired slack-sync: a job that cannot work is removed rather than tracked.
    expect(names).not.toContain("slack-sync");
  });

  test("cadence comes from the declared schedule, not a second hand-maintained list", async () => {
    const by = new Map(declaredJobs().map((d) => [d.job, d]));
    expect(by.get("gmail-sync")!.cadence_s).toBe(300);
    expect(by.get("cal-sync")!.cadence_s).toBe(900);
    expect(by.get("cert-renew")!.cadence_s).toBe(DAY); // daily 03:40
    expect(by.get("backup")!.cadence_s).toBe(31 * DAY); // monthly, the 1st
    // KeepAlive processes are supposed to stay up, not to finish, so they have no cadence to be late against.
    expect(by.get("web")!.cadence_s).toBeNull();
    expect(by.get("whatsapp-bridge")!.cadence_s).toBeNull();
  });

  test("the seam recognises a job invocation and not a human typing the same first word", async () => {
    expect(jobForInvocation("gmail", ["sync"], {})).toBe("gmail-sync");
    expect(jobForInvocation("cert", ["renew"], {})).toBe("cert-renew");
    // the 08:00 job is `alerts --digest --notify` (1655); a person reading their own alerts or their own
    // digest is not that job, so typing it does not stand in for the timer
    expect(jobForInvocation("alerts", [], { digest: true, notify: true })).toBe("alerts");
    expect(jobForInvocation("alerts", [], { digest: true })).toBeNull();
    expect(jobForInvocation("alerts", [], {})).toBeNull();
    expect(jobForInvocation("gmail", ["search", "invoice"], {})).toBeNull();
    expect(jobForInvocation("show", ["218"], {})).toBeNull();
  });
});

describe("the four silent outages, reconstructed (218)", () => {
  test("ob 152: gmail failing every 300s for 17 days", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["gmail-sync"] });
    // it DID work until 17 days ago, then the 404 on one deleted message wedged every run since
    await recordJobAttempt(store, "gmail-sync", ago(now, 40 * DAY));
    await recordJobResult(store, "gmail-sync", { ok: true }, ago(now, 17 * DAY));
    await failRepeatedly(store, "gmail-sync", {
      now,
      everyS: 300,
      count: 40,
      error: "Google API request failed (404) for .../messages/19f853f0dc7af28d?format=full",
    });

    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_failing:gmail-sync");
    expect(alerts[0]!.label).toBe("job failing");
    expect(alerts[0]!.message).toContain("40 times in a row");
    expect(alerts[0]!.message).toContain("404");

    // fixed: one successful run and it goes quiet
    await recordJobResult(store, "gmail-sync", { ok: true }, now);
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  // ob 208 was slack-sync, which needed a token that never existed and so failed on every run from the
  // day it was configured. That JOB is retired (the fix was to remove it, not to credential it), but its
  // SHAPE outlives it and is the one this case asserts: a job that has never once succeeded, replayed on
  // the sibling 15-minute poll.
  test("ob 208: a 15-minute job erroring on every run since it was configured", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await failRepeatedly(store, "cal-sync", {
      now,
      everyS: 900,
      count: 200,
      error: "cannot read Google token at ~/.google_token (run ob google auth)",
    });

    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_failing:cal-sync");
    // it has never once succeeded, which the message says rather than implying a regression
    expect(alerts[0]!.message).toContain("has never succeeded");
    expect(alerts[0]!.message).toContain("~/.google_token");

    await recordJobResult(store, "cal-sync", { ok: true }, now);
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("ob 209: a job failing on every run", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cert-renew"] });
    await recordJobAttempt(store, "cert-renew", ago(now, 90 * DAY));
    await recordJobResult(store, "cert-renew", { ok: true }, ago(now, 60 * DAY));
    await failRepeatedly(store, "cert-renew", {
      now,
      everyS: DAY,
      count: 4,
      error: "cert renew: every source failed",
    });

    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_failing:cert-renew");
    expect(alerts[0]!.message).toContain("every source failed");

    await recordJobResult(store, "cert-renew", { ok: true }, now);
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("ob 212: a job that never ran at all, the only shape that would have caught it", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    // the rest of the fleet has been running here for a month; this one job has no record whatsoever
    await seedHealthyFleet(store, now, { skip: ["creds-check"] });

    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_never_ran:creds-check");
    expect(alerts[0]!.label).toBe("job never ran");
    expect(alerts[0]!.message).toContain("installed nowhere");

    // fixed: it is installed and runs once
    await recordJobAttempt(store, "creds-check", now);
    await recordJobResult(store, "creds-check", { ok: true }, now);
    expect((await jobAlerts(store, now))).toEqual([]);
  });
});

describe("job-health alerts do not cry wolf (218)", () => {
  test("a healthy fleet produces no alerts at all", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now);
    expect((await jobAlerts(store, now))).toEqual([]);
    expect((await computeAlerts(sqliteStoreFor(db), { focusProject: null, now }))).toEqual([]);
  });

  test("a fresh database says nothing: nothing has recorded, so nothing is late", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    expect((await jobAlerts(store, now))).toEqual([]);
    expect((await jobHealth(store, { now })).every((h) => h.state === "untracked" || h.state === "unscheduled")).toBe(true);
  });

  test("a machine that has simply not reached a monthly job yet is not accused of anything", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    // three days of tracking: long enough for the 5-minute jobs, nowhere near the monthly one's window
    await seedHealthyFleet(store, now, { sinceS: 3 * DAY, skip: ["backup"] });
    expect((await jobAlerts(store, now))).toEqual([]);
    const by = new Map((await jobHealth(store, { now })).map((h) => [h.job, h]));
    expect(by.get("backup")!.state).toBe("untracked");
  });

  test("a five-minute job that missed a few runs is a closed laptop, not an outage", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["gmail-sync"] });
    await recordJobAttempt(store, "gmail-sync", ago(now, 30 * DAY));
    // two hours without a run is 24 missed 300s windows and still below the floor
    await recordJobResult(store, "gmail-sync", { ok: true }, ago(now, 2 * 3600));
    expect((await jobAlerts(store, now))).toEqual([]);
    // a full day of producing nothing is a different claim, and that one is made
    await recordJobResult(store, "gmail-sync", { ok: true }, ago(now, 25 * 3600));
    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_stale:gmail-sync");
    expect(alerts[0]!.label).toBe("job stale");
  });

  test("a job disabled on purpose is silent through alert_job_ignore", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    // whatsapp-sync ships installed-and-disabled until the ob 202 bridge window
    await seedHealthyFleet(store, now, { skip: ["whatsapp-sync", "creds-check"] });
    expect((await jobAlerts(store, now)).map((a) => a.key).sort()).toEqual([
      "job_never_ran:creds-check",
      "job_never_ran:whatsapp-sync",
    ]);

    await setConfig(db, "alert_job_ignore", "whatsapp-sync, creds-check");
    expect((await jobAlerts(store, now))).toEqual([]);
    expect((await jobHealth(store, { now })).find((h) => h.job === "whatsapp-sync")!.state).toBe("ignored");
  });

  test("a KeepAlive process and a job whose runs this database cannot observe never go stale", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    // web and whatsapp-bridge are supposed to stay up, so their silence here proves nothing
    // (spinoff-drain was the third until ob 1589 retired its job)
    await seedHealthyFleet(store, now, { skip: ["web", "whatsapp-bridge"] });
    expect((await jobAlerts(store, now))).toEqual([]);
    const by = new Map((await jobHealth(store, { now })).map((h) => [h.job, h]));
    expect(by.get("web")!.state).toBe("unscheduled");
    expect(by.get("whatsapp-bridge")!.state).toBe("unscheduled");
    expect(by.has("spinoff-drain")).toBe(false);
  });

  test("a job that is failing raises the failing alert only, never failing AND stale", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["gmail-sync"] });
    await recordJobAttempt(store, "gmail-sync", ago(now, 60 * DAY));
    await recordJobResult(store, "gmail-sync", { ok: true }, ago(now, 45 * DAY));
    await failRepeatedly(store, "gmail-sync", { now, everyS: 300, count: 50, error: "no token" });
    const keys = (await jobAlerts(store, now)).map((a) => a.key);
    expect(keys).toEqual(["job_failing:gmail-sync"]);
  });

  test("one failure is a transient and does not alert; the third one does", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await recordJobAttempt(store, "cal-sync", ago(now, 30 * DAY));
    await recordJobResult(store, "cal-sync", { ok: true }, ago(now, 900));
    await failRepeatedly(store, "cal-sync", { now, everyS: 900, count: 2, error: "network unreachable" });
    expect((await jobAlerts(store, now))).toEqual([]);
    await failRepeatedly(store, "cal-sync", { now, everyS: 60, count: 1, error: "network unreachable" });
    expect((await jobAlerts(store, now)).map((a) => a.key)).toEqual(["job_failing:cal-sync"]);
  });
});

// ob 221. Within an hour of 218 landing the live tracker reported `sync` as `ok` with last_success_at
// null: an attempt had been recorded and no result ever was, and zero failures read as healthy. These
// cases pin the two answers an unresolved attempt can now give, and pin that neither of them is `ok`.
describe("a run that starts and never finishes (221)", () => {
  test("THE LIVE DEFECT: an attempt with no result is never ok, and reads as interrupted once its cadence has passed", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["sync"] });
    // exactly the live row: one attempt, no result of either kind, no success ever
    await recordJobAttempt(store, "sync", ago(now, 600));
    const inFlight = (await jobHealth(store, { now })).find((h) => h.job === "sync")!;
    expect(inFlight.state).not.toBe("ok");
    expect(inFlight.state).toBe("running"); // 600s into an hourly job: it could still be going
    expect(inFlight.last_success_at).toBeNull();

    // an hour later the next run is already due, so that one is not still going: it died.
    const later = iso(Date.parse(now) + 3600 * 1000);
    const dead = (await jobHealth(store, { now: later })).find((h) => h.job === "sync")!;
    expect(dead.state).toBe("interrupted");
    expect(dead.unresolved_for_s).toBeGreaterThanOrEqual(3600);

    // and a result, of either kind, resolves it
    await recordJobResult(store, "sync", { ok: true }, later);
    expect((await jobHealth(store, { now: later })).find((h) => h.job === "sync")!.state).toBe("ok");
  });

  test("interrupted runs are counted only when a LATER attempt proves the earlier one died", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["gmail-sync"] });

    for (let i = 4; i >= 1; i--) await recordJobAttempt(store, "gmail-sync", ago(now, i * 300));
    const h = (await jobHealth(store, { now })).find((j) => j.job === "gmail-sync")!;
    // four attempts, three of which were still unresolved when the next one started
    expect(h.consecutive_interruptions).toBe(3);
    expect(h.consecutive_failures).toBe(0);

    // one completed run clears the streak, whichever way it completed
    await recordJobResult(store, "gmail-sync", { ok: false, error: "network unreachable" }, now);
    const after = (await jobHealth(store, { now })).find((j) => j.job === "gmail-sync")!;
    expect(after.consecutive_interruptions).toBe(0);
    expect(after.consecutive_failures).toBe(1);
  });

  test("ONE interruption is a closed laptop and stays quiet; a job dying every run alerts", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await recordJobAttempt(store, "cal-sync", ago(now, 30 * DAY));
    await recordJobResult(store, "cal-sync", { ok: true }, ago(now, 6 * 900));

    // one run started and never came back: a lid closing mid-sync. No alert.
    await recordJobAttempt(store, "cal-sync", ago(now, 4 * 900));
    await recordJobAttempt(store, "cal-sync", ago(now, 3 * 900));
    expect((await jobHealth(store, { now })).find((h) => h.job === "cal-sync")!.state).toBe("interrupted");
    expect((await jobAlerts(store, now))).toEqual([]);

    // it keeps happening: three unfinished runs in a row is the repetition that earns the alert
    await recordJobAttempt(store, "cal-sync", ago(now, 2 * 900));
    expect((await jobAlerts(store, now))).toEqual([]);
    await recordJobAttempt(store, "cal-sync", ago(now, 900));
    const alerts = await jobAlerts(store, now);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe("job_interrupted:cal-sync");
    expect(alerts[0]!.label).toBe("job interrupted");
    expect(alerts[0]!.message).toContain("started and never finished");

    // and one completed run silences it
    await recordJobResult(store, "cal-sync", { ok: true }, now);
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("staleness still wins: a long silence keeps saying so rather than hiding behind one dead run", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["gmail-sync"] });
    await recordJobAttempt(store, "gmail-sync", ago(now, 30 * DAY));
    await recordJobResult(store, "gmail-sync", { ok: true }, ago(now, 30 * 3600));
    await recordJobAttempt(store, "gmail-sync", ago(now, 3600));
    const keys = (await jobAlerts(store, now)).map((a) => a.key);
    expect(keys).toEqual(["job_stale:gmail-sync"]);
    expect((await jobHealth(store, { now })).find((h) => h.job === "gmail-sync")!.state).toBe("stale");
  });

  test("a KeepAlive process blocking forever is not an interrupted run", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["web", "whatsapp-bridge"] });
    // both are up and blocking: an attempt from days ago that will never resolve until they stop
    await recordJobAttempt(store, "web", ago(now, 3 * DAY));
    await recordJobAttempt(store, "whatsapp-bridge", ago(now, 3 * DAY));
    expect((await jobAlerts(store, now))).toEqual([]);
    const by = new Map((await jobHealth(store, { now })).map((h) => [h.job, h]));
    expect(by.get("web")!.state).toBe("unscheduled");
    expect(by.get("whatsapp-bridge")!.state).toBe("unscheduled");
  });
});

// ob 222. The third instance of the same class in two days: `ob jobs` printed
// `slack-sync  ok  last success never  2 fail(s) in a row` (that job is retired by ob 208; the label
// defect it exposed is not). The alerting was right to stay quiet at two
// failures; the LABEL was wrong, because the alert threshold was its only input. These cases pin the two
// questions apart: the state says whether the job works, the thresholds say whether it shouts.
describe("the label answers 'is it working', not 'should it alert' (222)", () => {
  test("THE LIVE DEFECT: one and two failures read as degraded, and the third is still the alert", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    const state = async () => (await jobHealth(store, { now })).find((h) => h.job === "cal-sync")!;

    // exactly the live row: it has never once succeeded and it is failing right now
    await failRepeatedly(store, "cal-sync", { now, everyS: 900, count: 1, error: "cannot read the token" });
    expect((await state()).state).toBe("degraded");
    expect((await state()).last_success_at).toBeNull();
    expect((await jobAlerts(store, now))).toEqual([]);

    await failRepeatedly(store, "cal-sync", { now, everyS: 600, count: 1, error: "cannot read the token" });
    expect((await state()).consecutive_failures).toBe(2);
    expect((await state()).state).toBe("degraded");
    expect((await jobAlerts(store, now))).toEqual([]);

    // the alert threshold is untouched: the third failure is still the one that shouts
    await failRepeatedly(store, "cal-sync", { now, everyS: 300, count: 1, error: "cannot read the token" });
    expect((await state()).state).toBe("failing");
    expect((await jobAlerts(store, now)).map((a) => a.key)).toEqual(["job_failing:cal-sync"]);

    // and one success is the only thing that earns `ok` back
    await recordJobResult(store, "cal-sync", { ok: true }, now);
    expect((await state()).state).toBe("ok");
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("a job that HAS succeeded before is degraded too the moment it fails: the streak, not the history", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await recordJobAttempt(store, "cal-sync", ago(now, 30 * DAY));
    await recordJobResult(store, "cal-sync", { ok: true }, ago(now, 2 * 900));
    await failRepeatedly(store, "cal-sync", { now, everyS: 900, count: 1, error: "network unreachable" });

    const h = (await jobHealth(store, { now })).find((j) => j.job === "cal-sync")!;
    expect(h.state).toBe("degraded");
    expect(h.last_success_at).not.toBeNull();
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("`ok` is never reached without a success on record, in any of the reconstructed cases", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync", "sync", "creds-check", "web"] });
    await failRepeatedly(store, "cal-sync", { now, everyS: 900, count: 2, error: "cannot read the token" });
    await recordJobAttempt(store, "sync", ago(now, 600));
    await recordJobAttempt(store, "web", ago(now, 3 * DAY));

    for (const h of (await jobHealth(store, { now }))) {
      if (h.state === "ok") expect(h.last_success_at).not.toBeNull();
    }
    const by = new Map((await jobHealth(store, { now })).map((h) => [h.job, h]));
    expect(by.get("cal-sync")!.state).toBe("degraded");
    expect(by.get("sync")!.state).toBe("running");
    expect(by.get("creds-check")!.state).toBe("never_ran");
    expect(by.get("web")!.state).toBe("unscheduled");
  });

  test("never succeeded and never failed keeps its old answer: nothing here calls that degraded", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    // no record at all, and no fleet to be late against: still `untracked`, still silent
    expect((await jobHealth(store, { now })).every((h) => h.state === "untracked" || h.state === "unscheduled")).toBe(true);
    expect((await jobAlerts(store, now))).toEqual([]);

    // a fleet that HAS been running makes the same silence `never_ran` (212), not `degraded`
    const db2 = freshDb();
    const store2 = sqliteStoreFor(db2);
    await seedHealthyFleet(store2, now, { skip: ["creds-check"] });
    expect((await jobHealth(store2, { now })).find((h) => h.job === "creds-check")!.state).toBe("never_ran");

    // an attempt with no result of either kind is still 221's answer, not this ticket's
    const db3 = freshDb();
    const store3 = sqliteStoreFor(db3);
    await seedHealthyFleet(store3, now, { skip: ["cal-sync"] });
    await recordJobAttempt(store3, "cal-sync", ago(now, 60));
    expect((await jobHealth(store3, { now })).find((h) => h.job === "cal-sync")!.state).toBe("running");
  });

  test("a KeepAlive process that came back broken says so instead of hiding behind `unscheduled`", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["whatsapp-bridge"] });
    await recordJobAttempt(store, "whatsapp-bridge", ago(now, 300));
    await recordJobResult(store, "whatsapp-bridge", { ok: false, error: "port 8099 held by a foreign process" }, ago(now, 300));

    // having no cadence to be late against is not a reason to call a failed run fine
    expect((await jobHealth(store, { now })).find((h) => h.job === "whatsapp-bridge")!.state).toBe("degraded");
    // and it is still below the alert threshold, so it stays quiet
    expect((await jobAlerts(store, now))).toEqual([]);
  });

  test("a failure streak does not relabel a run in flight, so rule 10 still fires", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await recordJobAttempt(store, "cal-sync", ago(now, 30 * DAY));
    await recordJobResult(store, "cal-sync", { ok: true }, ago(now, 8 * 900));
    await failRepeatedly(store, "cal-sync", { now: ago(now, 5 * 900), everyS: 900, count: 1, error: "network unreachable" });

    // it then dies before recording anything, run after run: that is rule 10's case and one old failure
    // must not take the label away from it
    for (let i = 4; i >= 1; i--) await recordJobAttempt(store, "cal-sync", ago(now, i * 900));
    const h = (await jobHealth(store, { now })).find((j) => j.job === "cal-sync")!;
    expect(h.consecutive_failures).toBe(1);
    expect(h.state).toBe("interrupted");
    expect((await jobAlerts(store, now)).map((a) => a.key)).toEqual(["job_interrupted:cal-sync"]);
  });

  test("`ob jobs` prints the new label beside the evidence rather than contradicting it", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["config", "set", "whatsapp_db_path", `/tmp/ob-222-absent-${Date.now()}.sqlite`]);
    expect((await runCli(dbPath, ["whatsapp", "sync"])).code).not.toBe(0);

    const listed = await runCli(dbPath, ["jobs"]);
    const line = listed.out.split("\n").find((l) => l.startsWith("whatsapp-sync"))!;
    expect(line).toContain("degraded");
    expect(line).toContain("1 fail(s) in a row");
    expect(line).not.toContain(" ok ");
  });
});

describe("job-health alerts snooze like every other alert (218)", () => {
  test("a snoozed failing job stays quiet while it fails the same way, and returns when the failure changes", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["cal-sync"] });
    await failRepeatedly(store, "cal-sync", { now, everyS: 900, count: 5, error: "no token" });

    const key = "job_failing:cal-sync";
    (await snoozeAlert(sqliteStoreFor(db), key, null));
    expect((await filterSnoozed(sqliteStoreFor(db), (await jobAlerts(store, now))))).toEqual([]);

    // more of the SAME failure must not resurface it -- otherwise a 15-minute job un-snoozes itself
    await failRepeatedly(store, "cal-sync", { now, everyS: 60, count: 3, error: "no token" });
    expect((await filterSnoozed(sqliteStoreFor(db), (await jobAlerts(store, now))))).toEqual([]);

    // a DIFFERENT failure is news, and the snooze expires on it
    await recordJobResult(store, "cal-sync", { ok: false, error: "Google API 429 rate limited" }, now);
    expect((await filterSnoozed(sqliteStoreFor(db), (await jobAlerts(store, now)))).map((a) => a.key)).toEqual([key]);
  });

  test("a never-ran job stays snoozed until it actually runs", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    await seedHealthyFleet(store, now, { skip: ["creds-check"] });
    (await snoozeAlert(sqliteStoreFor(db), "job_never_ran:creds-check", null));
    expect((await filterSnoozed(sqliteStoreFor(db), (await jobAlerts(store, now))))).toEqual([]);
    await recordJobAttempt(store, "creds-check", now);
    await recordJobResult(store, "creds-check", { ok: true }, now);
    expect((await filterSnoozed(sqliteStoreFor(db), (await jobAlerts(store, now))))).toEqual([]);
  });
});

describe("the recording seam runs itself (218)", () => {
  test("a real job invocation records its success without any connector's help", async () => {
    const dbPath = freshDbPath();
    // `ob alerts --digest --notify` IS the 08:00 job, and it reads only this database (a clean one sends no push)
    expect((await runCli(dbPath, ["alerts", "--digest", "--notify"])).code).toBe(0);

    const listed = await runCli(dbPath, ["jobs", "--json"]);
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.out) as Array<{ job: string; state: string; last_success_at: string | null }>;
    const alertsJob = rows.find((r) => r.job === "alerts")!;
    expect(alertsJob.last_success_at).not.toBeNull();
    expect(alertsJob.state).toBe("ok");
  });

  test("a job invocation that throws records the failure and its message", async () => {
    const dbPath = freshDbPath();
    // whatsapp-sync reads the bridge's own SQLite store; point it at a path that is not there, which is
    // a purely local failure (no bridge, no network) of a genuinely declared job
    await runCli(dbPath, ["config", "set", "whatsapp_db_path", `/tmp/ob-218-absent-${Date.now()}.sqlite`]);
    expect((await runCli(dbPath, ["whatsapp", "sync"])).code).not.toBe(0);

    const listed = await runCli(dbPath, ["jobs", "--json"]);
    const rows = JSON.parse(listed.out) as Array<{ job: string; consecutive_failures: number; last_error: string | null }>;
    const waSync = rows.find((r) => r.job === "whatsapp-sync")!;
    expect(waSync.consecutive_failures).toBe(1);
    expect(waSync.last_error).not.toBeNull();
  });

  test("a command that is not a declared job records nothing", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["add", "a thing"]);
    const listed = await runCli(dbPath, ["jobs", "--json"]);
    const rows = JSON.parse(listed.out) as Array<{ state: string }>;
    expect(rows.every((r) => r.state === "untracked" || r.state === "unscheduled")).toBe(true);
  });
});
