#!/usr/bin/env node
"use strict";
// Phase 2b envelope controls (design §14.4). Pure engine only — no PHP, no production API.
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
const { STS } = ctx;

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

// ---------- cycleEnd is effectiveNextPayday (Spec note 1) ----------
{
  const db = miniDb();
  db.settings.asOfDate = "2026-09-20"; // before nextPayday, so the window has not rolled
  const bounds = STS.envelopeCycleBounds(db, STS.asOf(db));
  eq("cycleEnd === effectiveNextPayday", bounds.cycleEnd, STS.effectiveNextPayday(db, STS.asOf(db)));
  eq("cycleStart is lastPayday when next has not arrived", bounds.cycleStart, "2026-09-18");
  eq("cycleEnd is nextPayday when it hasn't arrived", bounds.cycleEnd, "2026-10-02");
  const rolled = STS.envelopeCycleBounds(db, "2026-10-02");
  eq("rolled cycleEnd still matches effectiveNextPayday", rolled.cycleEnd, STS.effectiveNextPayday(db, "2026-10-02"));
  eq("rolled cycleStart is the payday that arrived", rolled.cycleStart, "2026-10-02");
}

// ---------- 14.1 Move money ----------
{
  const db = miniDb();
  STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "pay-1" });
  const gro0 = STS.envelopeRemaining(db, "groceries");
  const buf0 = STS.envelopeRemaining(db, "buffer");
  const sid = "move-uuid-1";
  const mv = STS.recordReallocate(db, {
    from: "groceries", to: "buffer", amount: 25, date: "2026-10-03", sourceId: sid
  });
  ok("move ok", mv.ok);
  eq("move eventType", mv.event.eventType, "reallocate");
  ok("move has id", !!mv.event.id);
  eq("move sourceId is the uuid", mv.event.sourceId, sid);
  eq("groceries remaining down 25", STS.envelopeRemaining(db, "groceries"), STS.r2(gro0 - 25));
  eq("buffer remaining up 25", STS.envelopeRemaining(db, "buffer"), STS.r2(buf0 + 25));
  ok("move appears in log", db.envelopePlan.fundingEvents.some(e => e.eventType === "reallocate" && e.sourceId === sid));

  const n = db.envelopePlan.fundingEvents.length;
  const again = STS.recordReallocate(db, {
    from: "groceries", to: "buffer", amount: 25, date: "2026-10-03", sourceId: sid
  });
  ok("double-submit is no-op", again.alreadyFunded && !again.ok);
  eq("log length unchanged after double-submit", db.envelopePlan.fundingEvents.length, n);
  eq("remaining unchanged after double-submit", STS.envelopeRemaining(db, "groceries"), STS.r2(gro0 - 25));

  const fromFixed = STS.recordReallocate(db, { from: "mortgage", to: "buffer", amount: 10, date: "2026-10-03", sourceId: "x1" });
  ok("fixed source refused", !fromFixed.ok);
  const toFixed = STS.recordReallocate(db, { from: "buffer", to: "mortgage", amount: 10, date: "2026-10-03", sourceId: "x2" });
  ok("fixed dest refused", !toFixed.ok);
  const same = STS.recordReallocate(db, { from: "buffer", to: "buffer", amount: 10, date: "2026-10-03", sourceId: "x3" });
  ok("from === to refused", !same.ok);
}

// ---------- 14.2 Edit plan targets ----------
{
  const db = miniDb();
  const fund1 = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "p1" });
  ok("first fund ok", fund1.ok);
  const groPast = fund1.event.amounts.groceries;
  ok("past groceries amount recorded", groPast > 0);
  const defMonthly = STS.envelopeMonthly("groceries", 1);
  eq("default groceries monthly (no override)", defMonthly, 940);

  const edit = STS.setEnvelopeMonthly(db, "groceries", 500, 1);
  ok("target edit ok", edit.ok);
  eq("monthly column updates immediately", STS.envelopeMonthly("groceries", 1, db.envelopePlan), 500);
  eq("past event amount unchanged", db.envelopePlan.fundingEvents[0].amounts.groceries, groPast);

  const fund2 = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-16", sourceId: "p2" });
  ok("second fund ok", fund2.ok);
  ok("future fund uses new target (not equal to past)", fund2.event.amounts.groceries !== groPast);
  const expected = STS.allocateFundingEvent(STS.monthlyByIdForEvent("paycheck", 1, db.envelopePlan), 26);
  eq("future groceries matches alloc from overrides", fund2.event.amounts.groceries, expected.amounts.groceries);

  const fixedEdit = STS.setEnvelopeMonthly(db, "mortgage", 1, 1);
  ok("fixed target edit refused", !fixedEdit.ok);
  eq("mortgage monthly still catalog", STS.envelopeMonthly("mortgage", 1, db.envelopePlan), 1189.29);

  const tot = STS.envelopePlanTotal(db, 1);
  ok("plan total is a number", typeof tot === "number" && tot > 0);
  eq("adopted monthly constant", STS.ADOPTED_PLAN_MONTHLY, 6499.99);
}

// ---------- 14.3 Correct funding (reversal) ----------
{
  const db = miniDb();
  const fund = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "pay-void" });
  ok("fund ok", fund.ok);
  const origId = fund.event.id;
  ok("funding event has id", !!origId);
  const groFunded = STS.envelopeFunded(db, "groceries");
  ok("groceries funded before void", groFunded > 0);

  const void1 = STS.recordReversal(db, { reverses: origId, date: "2026-10-03", sourceId: "rev-1" });
  ok("void ok", void1.ok);
  eq("reversal eventType", void1.event.eventType, "reversal");
  eq("reversal uses original accounting date", void1.event.date, fund.event.date);
  eq("reverses original id", void1.event.reverses, origId);
  const orig = fund.event.amounts;
  const neg = void1.event.amounts;
  ok("reversal keys match original", Object.keys(neg).sort().join(",") === Object.keys(orig).sort().join(","));
  let allNeg = true;
  for (const id of Object.keys(orig)) {
    if (STS.r2(neg[id]) !== STS.r2(-orig[id])) allNeg = false;
  }
  ok("reversal amounts exactly negate original", allNeg);
  eq("funded after void is 0", STS.envelopeFunded(db, "groceries"), 0);
  eq("two events in log (original + reversal)", db.envelopePlan.fundingEvents.length, 2);

  const n = db.envelopePlan.fundingEvents.length;
  const void2 = STS.recordReversal(db, { reverses: origId, date: "2026-10-04", sourceId: "rev-2" });
  ok("second void is no-op", void2.alreadyFunded && !void2.ok);
  eq("log length unchanged after second void", db.envelopePlan.fundingEvents.length, n);

  // fallback id for events written before this change
  const db2 = miniDb();
  STS.ensureEnvelopes(db2);
  db2.envelopePlan.envelopeEpoch = "2026-10-02";
  db2.envelopePlan.fundingEvents.push({
    eventType: "paycheck", date: "2026-10-02", phase: 1, sourceId: "legacy",
    amounts: { groceries: 10, buffer: 5 }
  });
  const fallbackId = STS.fundingEventId(db2.envelopePlan.fundingEvents[0], 0);
  eq("fallback id shape", fallbackId, "paycheck:legacy:0");
  const voidLegacy = STS.recordReversal(db2, { reverses: fallbackId, date: "2026-10-03" });
  ok("void by fallback id ok", voidLegacy.ok);
  eq("legacy groceries funded after void", STS.envelopeFunded(db2, "groceries"), 0);
}

// A correction made before a future-dated funding event must still cancel it.
{
  const db = miniDb();
  db.settings.asOfDate = "2026-09-24";
  const before = STS.envelopeFunded(db, "groceries");
  const fund = STS.recordFundingEvent(db, { eventType: "paycheck", date: "2026-10-02", sourceId: "future-pay" });
  ok("future funding recorded", fund.ok);
  ok("future funding changes balance", STS.envelopeFunded(db, "groceries") > before);
  const correctionTime = "2026-09-24T15:30:00Z";
  const voided = STS.recordReversal(db, { reverses: fund.event.id, date: "2026-09-24", createdAt: correctionTime });
  ok("future funding voided", voided.ok);
  eq("reversal accounting date matches original", voided.event.date, fund.event.date);
  eq("correction time remains in audit field", voided.event.createdAt, correctionTime);
  eq("future funding fully canceled", STS.envelopeFunded(db, "groceries"), before);
}

console.log(failed ? `FAILED ${failed}  passed ${passed}` : `ok ${passed} passed`);
process.exit(failed ? 1 : 0);
