#!/usr/bin/env node
"use strict";
// Phase 2 envelope math tests (design §10). Pure engine only — no PHP, no production API.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const start = html.indexOf("/*ENGINE-START*/");
const end = html.indexOf("/*ENGINE-END*/");
if (start < 0 || end < 0) throw new Error("ENGINE markers missing");
const engineSrc = html.slice(start + "/*ENGINE-START*/".length, end);
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(engineSrc + "\nthis.STS = STS; this.buildSeed = buildSeed;", ctx);
const { STS, buildSeed } = ctx;

let passed = 0, failed = 0;
function eq(name, a, b) {
  const ok = Object.is(a, b) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
  if (ok) { passed++; return; }
  failed++;
  console.error("FAIL", name, "got", a, "expected", b);
}
function ok(name, cond) {
  if (cond) { passed++; return; }
  failed++;
  console.error("FAIL", name);
}
function deep(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) { passed++; return; }
  failed++;
  console.error("FAIL", name, "got", sa, "expected", sb);
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function miniDb(overrides) {
  const db = {
    version: 1,
    settings: {
      payFrequency: "Biweekly",
      lastPayday: "2026-09-18",
      nextPayday: "2026-10-02",
      netPerPaycheck: 2215.38,
      reserve: 1000,
      mode: "Conservative",
      horizonDays: 60,
      asOfMode: "fixed",
      asOfDate: "2026-10-02"
    },
    accounts: [
      { name: "Checking", type: "Checking", institution: "Bank", balance: 4000, spendable: true, reconciledThrough: "2026-10-02" }
    ],
    cards: [
      { name: "Card", balance: 0, statementBalance: 0, dueDate: "2026-10-20", autopayMode: "Full", autopayAmount: null, activeForSpend: true, treatAs: "Card", payFrom: "Checking", reconciledThrough: "2026-10-02" }
    ],
    recurring: [
      { id: "MORT", name: "KC Mortgage", category: "KC Mortgage", amount: 1189.29, frequency: "Monthly", nextDate: "2026-10-15", payMethod: "Checking", kind: "expense", autopay: true, mandatory: true }
    ],
    ledger: [],
    nextId: 1
  };
  Object.assign(db, overrides);
  return STS.ensureEnvelopes(STS.ensureAccountAnchors(db));
}

function row(db, fields) {
  const e = {
    id: db.nextId++, date: "2026-10-02", type: "card_purchase", description: "x", category: "",
    amount: -10, source: "", dest: "Card", payMethod: "Card", cardName: "Card",
    cashImpact: false, mandatory: false, status: "Cleared", inSTS: true, recurringId: "", notes: "",
    envelopeId: "groceries",
    ...fields
  };
  db.ledger.push(e);
  return e;
}

// ---------- rounding Σ == total for 52/26/24/12 ----------
for (const [freq, div] of [["Weekly", 52], ["Biweekly", 26], ["Semimonthly", 24], ["Monthly", 12]]) {
  for (const phase of [1, 2]) {
    const monthly = STS.monthlyByIdForEvent("paycheck", phase);
    const a = STS.allocateFundingEvent(monthly, div);
    const sumCents = Object.values(a.cents).reduce((s, c) => s + c, 0);
    eq(`rounding paycheck p${phase} ${freq} Σ==total`, sumCents, a.totalCents);
    const a2 = STS.allocateFundingEvent(monthly, div);
    deep(`rounding deterministic p${phase} ${freq}`, a.cents, a2.cents);
  }
  const rent = STS.allocateFundingEvent(STS.monthlyByIdForEvent("rent", 1), 48);
  const rentSum = Object.values(rent.cents).reduce((s, c) => s + c, 0);
  eq(`rounding rent ${freq} unused-div-independent Σ`, rentSum, rent.totalCents);
}

const p1 = STS.allocateFundingEvent(STS.monthlyByIdForEvent("paycheck", 1), 26);
eq("Phase 1 biweekly paycheck total $1549.19", p1.total, 1549.19);
eq("Phase 1 biweekly paycheck totalCents", p1.totalCents, 154919);

const p2 = STS.allocateFundingEvent(STS.monthlyByIdForEvent("paycheck", 2), 26);
eq("Phase 2 biweekly paycheck total $1657.84", p2.total, 1657.84);

const rent = STS.allocateFundingEvent(STS.monthlyByIdForEvent("rent", 1), 48);
eq("rent event total $100", rent.total, 100);

ok("fixed envelopes never in paycheck alloc", !("mortgage" in p1.amounts) && !("providence-plan" in p1.amounts));
ok("rent envelopes not in paycheck alloc", !("rental-tax-reserve" in p1.amounts));
ok("paycheck envelopes not in rent alloc", !("groceries" in rent.amounts));

// ---------- fund → spend → rollover → refund → debt paydown ----------
{
  const db = miniDb();
  const fund = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "pay-1" });
  ok("fund ok", fund.ok);
  eq("epoch set on first fund", db.envelopePlan.envelopeEpoch, "2026-10-02");
  const groFunded = STS.envelopeFunded(db, "groceries");
  ok("groceries funded > 0", groFunded > 0);
  eq("remaining == funded before spend", STS.envelopeRemaining(db, "groceries"), groFunded);

  row(db, { date: "2026-10-03", amount: -40, envelopeId: "groceries", type: "card_purchase", status: "Cleared" });
  eq("spent after grocery swipe", STS.envelopeSpent(db, "groceries", false), 40);
  eq("remaining = funded - spent", STS.envelopeRemaining(db, "groceries"), STS.r2(groFunded - 40));

  // rollover: spent in previous cycle still counts against remaining (no monthly reset)
  db.settings.asOfDate = "2026-10-16"; // next payday window
  db.settings.lastPayday = "2026-10-02";
  db.settings.nextPayday = "2026-10-16";
  eq("cycle spent after rollover is 0 (new cycle)", STS.envelopeSpent(db, "groceries", true), 0);
  eq("remaining still reduced after rollover", STS.envelopeRemaining(db, "groceries"), STS.r2(groFunded - 40));

  row(db, { date: "2026-10-17", amount: 10, envelopeId: "groceries", type: "refund", status: "Cleared" });
  eq("refund adds back", STS.envelopeRemaining(db, "groceries"), STS.r2(groFunded - 30));

  const beforeDebt = STS.envelopeRemaining(db, "groceries");
  row(db, { date: "2026-10-17", amount: -50, envelopeId: null, type: "card_payment", status: "Cleared", category: "Transfer", cashImpact: true, inSTS: false });
  eq("debt/card_payment does not change remaining", STS.envelopeRemaining(db, "groceries"), beforeDebt);
}

// ---------- derived invariant: edit / void / refund / recategorize ----------
{
  const db = miniDb();
  STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: 1 });
  const funded = STS.envelopeFunded(db, "groceries");
  const r = row(db, { date: "2026-10-03", amount: -25, envelopeId: "groceries" });
  eq("after spend remaining", STS.envelopeRemaining(db, "groceries"), STS.r2(funded - 25));
  r.amount = -10; // edit
  eq("edit recomputes remaining", STS.envelopeRemaining(db, "groceries"), STS.r2(funded - 10));
  r.status = "Void";
  eq("void removes spend", STS.envelopeRemaining(db, "groceries"), funded);
  r.status = "Cleared";
  r.envelopeId = "gas"; // recategorize
  eq("recategorize empties groceries spent", STS.envelopeSpent(db, "groceries", false), 0);
  eq("recategorize hits gas", STS.envelopeSpent(db, "gas", false), 10);
  // duplicate-import analogue: a second identical row increases spent
  row(db, { date: "2026-10-03", amount: -10, envelopeId: "gas" });
  eq("duplicate import increases spent", STS.envelopeSpent(db, "gas", false), 20);
  ok("no stored balances key", !db.envelopePlan.balances);
}

// ---------- epoch: pre-epoch rows don't count; phase toggle keeps past events ----------
{
  const db = miniDb();
  STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "a" });
  row(db, { date: "2026-09-01", amount: -999, envelopeId: "groceries" });
  eq("pre-epoch spend ignored", STS.envelopeSpent(db, "groceries", false), 0);
  const ev1 = db.envelopePlan.fundingEvents[0];
  eq("first event stamped phase 1", ev1.phase, 1);
  STS.setEnvelopePhase(db, 2, "2026-11-01");
  eq("phase now 2", db.envelopePlan.phase, 2);
  eq("phaseActivatedAt[2] recorded", db.envelopePlan.phaseActivatedAt[2], "2026-11-01");
  eq("past funding event still phase 1", db.envelopePlan.fundingEvents[0].phase, 1);
  const fund2 = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-11-13", sourceId: "b" });
  ok("second fund ok", fund2.ok);
  eq("new event stamped phase 2", db.envelopePlan.fundingEvents[1].phase, 2);
  eq("epoch unchanged", db.envelopePlan.envelopeEpoch, "2026-10-02");
}

// ---------- idempotency ----------
{
  const db = miniDb();
  const a = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "src-1" });
  const b = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "src-1" });
  ok("first fund ok", a.ok);
  ok("second same key is no-op", b.alreadyFunded && !b.ok);
  eq("only one event", db.envelopePlan.fundingEvents.length, 1);
  const c = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "src-2" });
  ok("same date different source is a second event", c.ok);
  eq("two events", db.envelopePlan.fundingEvents.length, 2);
  const d = STS.recordFundingEvent(db, { eventType: "rent", date: "2026-10-05", sourceId: null });
  const e = STS.recordFundingEvent(db, { eventType: "rent", date: "2026-10-05", sourceId: null });
  ok("sourceless rent funds once", d.ok && e.alreadyFunded);
}

// ---------- spent eligibility allowlists ----------
{
  const db = miniDb();
  STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: 9 });
  const gro0 = STS.envelopeSpent(db, "groceries", false);
  row(db, { type: "card_payment", envelopeId: "groceries", amount: -80, category: "Transfer", cashImpact: true, inSTS: false });
  row(db, { type: "card_payment", envelopeId: "groceries", amount: -20, cashImpact: false, inSTS: false, notes: "debt paydown" });
  row(db, { type: "income", envelopeId: "groceries", amount: 100 });
  row(db, { type: "planned_spend", envelopeId: "groceries", amount: -15 });
  row(db, { type: "card_purchase", envelopeId: "groceries", amount: -12, status: "Void" });
  row(db, { type: "recurring", envelopeId: "groceries", amount: -30, status: "Pending", date: "2026-10-20" }); // future pending
  eq("excluded types/status do not spend", STS.envelopeSpent(db, "groceries", false), gro0);
  row(db, { type: "card_purchase", envelopeId: "groceries", amount: -7, status: "Pending", date: "2026-10-03" });
  eq("pending in-cycle purchase does spend", STS.envelopeSpent(db, "groceries", false), 7);
}

// ---------- review queue ----------
{
  const db = miniDb();
  STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: 1 });
  row(db, { envelopeId: null, amount: -18, type: "card_purchase", date: "2026-10-03", description: "Amazon" });
  const q = STS.envelopeReviewQueue(db);
  eq("review count", q.count, 1);
  eq("review total", q.total, 18);
  eq("uncategorized does not inflate groceries remaining", STS.envelopeSpent(db, "groceries", false), 0);
}

// ---------- safeToSpend byte-identical regression ----------
{
  const seed = STS.ensureAccountAnchors(buildSeed("2026-09-20"));
  const modes = ["Conservative", "Moderate", "Aggressive"];
  const before = {};
  for (const m of modes) before[m] = STS.safeToSpend(seed, m, STS.computeAll(seed, m));
  // load envelope code path
  const afterDb = STS.ensureEnvelopes(clone(seed));
  STS.recordFundingEvent(afterDb, { eventType: "paycheck", date: "2026-09-20", sourceId: "x" });
  STS.setEnvelopePhase(afterDb, 2, "2026-09-20");
  for (const m of modes) {
    const ctxBefore = STS.computeAll(seed, m);
    const ctxAfter = STS.computeAll(afterDb, m);
    eq(`safeToSpend ${m} identical`, STS.safeToSpend(afterDb, m, ctxAfter), STS.safeToSpend(seed, m, ctxBefore));
    eq(`computeAll.sts ${m} identical`, ctxAfter.sts, ctxBefore.sts);
  }
}

// ---------- fixed envelopes derive from recurring, never take funding ----------
{
  const db = miniDb();
  const bad = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: 1 });
  ok("paycheck fund ok", bad.ok);
  eq("mortgage funded is 0", STS.envelopeFunded(db, "mortgage"), 0);
  eq("mortgage spent is 0", STS.envelopeSpent(db, "mortgage", false), 0);
  eq("mortgage remaining is 0", STS.envelopeRemaining(db, "mortgage"), 0);
  row(db, { type: "recurring", envelopeId: "mortgage", amount: -1189.29, date: "2026-10-03", status: "Cleared", recurringId: "MORT" });
  eq("fixed still 0 spent even with stamped row", STS.envelopeSpent(db, "mortgage", false), 0);
  const derived = STS.fixedEnvelopeDerived(db, "mortgage", STS.asOf(db));
  eq("fixed next due from recurring", derived.nextDue, "2026-10-15");
  ok("fixed paid this cycle from cleared row", derived.paid === true);
  const realloc = STS.recordReallocate(db, { from: "mortgage", to: "buffer", amount: 10, date: "2026-10-03" });
  ok("cannot reallocate from fixed", !realloc.ok);
}

// ---------- ensureEnvelopes lazy backfill ----------
{
  const db = miniDb({ envelopePlan: undefined });
  delete db.envelopePlan;
  STS.ensureEnvelopes(db);
  eq("phase defaults 1", db.envelopePlan.phase, 1);
  ok("fundingEvents array", Array.isArray(db.envelopePlan.fundingEvents));
  eq("epoch starts null", db.envelopePlan.envelopeEpoch, null);
}

console.log(failed ? `FAILED ${failed}  passed ${passed}` : `ok ${passed} passed`);
process.exit(failed ? 1 : 0);
