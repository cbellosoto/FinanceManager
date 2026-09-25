#!/usr/bin/env node
"use strict";
// Categories-as-envelopes + unpaid-holiday paycheck math. Pure engine only.
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
vm.runInContext(engineSrc + "\nthis.STS = STS;", ctx);
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

function assign(desc, cat, type) {
  return STS.resolveEnvelopeAssignment({ description: desc, category: cat, type: type || "card_purchase" });
}

{
  const r = assign("Aldi", "Groceries");
  eq("Groceries is envelope", r.envelopeId, "groceries");
  eq("Groceries keeps name", r.category, "Groceries");
  eq("Groceries why", r.why, "category is envelope");
}

const cases = [
  ["Aldi", "Grocery", "groceries", "Groceries"],
  ["Chipotle", "Food & Drink", "restaurants", "Restaurants"],
  ["Casey", "Gas", "gas", "Gas"],
  ["Evergy", "Utilities", "household-utilities", "Household Utilities"],
  ["Aimvo", "Pest Control", "pest-control", "Pest Control"],
  ["Petco", "Cats", "cats", "Cats"],
  ["Netflix", "Subscription", "subscriptions", "Subscriptions & Digital Services"],
  ["Schwab Elisa", "Elisa", "elisa-spend", "Elisa Spend"],
  ["Target", "Sara", "sara-fun", "Sara Personal & Fun"],
  ["Steam", "Christopher", "christopher-fun", "Christopher Personal & Fun"],
  ["Movie", "Entertainment", "christopher-fun", "Christopher Personal & Fun"],
  ["House", "Housing", "mortgage", "KC Mortgage"],
  ["House", "Mortgage", "mortgage", "KC Mortgage"],
  ["El Paso", "Rent", "el-paso-rent", "El Paso Rent"],
  ["Robinhood", "Investment", "investing", "Investing"],
  ["Home Depot", "Maintance", "maintenance-reserve", "Home & Rental Maintenance Reserve"],
  ["Home Depot", "Maintenance", "maintenance-reserve", "Home & Rental Maintenance Reserve"],
  ["AAA", "Membership", "annual-renewals", "Known Annual Renewals"],
  ["CVS", "Dentist", "oop-medical", "Out-of-Pocket Medical"],
  ["Rite Aid", "Medicine", "oop-medical", "Out-of-Pocket Medical"],
  ["Sierra Providen", "Medical Payment", "providence-plan", "Providence Payment Plan"],
  ["HP Instant Ink", "Pay-As-You-Go", "subscriptions", "Subscriptions & Digital Services"],
  ["Tip", "Tip", "restaurants", "Restaurants"]
];
for (const [desc, cat, id, name] of cases) {
  const r = assign(desc, cat);
  eq(`${cat} → ${id}`, r.envelopeId, id);
  eq(`${cat} name ${name}`, r.category, name);
}

{
  const health = assign("Health Insurance", "Insurance");
  eq("health insurance id", health.envelopeId, "health-insurance");
  const life = assign("Primerica (Chris)", "Insurance");
  eq("primerica → life", life.envelopeId, "life-insurance");
  const car = assign("Car Insurance", "Insurance");
  eq("car insurance sinking", car.envelopeId, "car-insurance-sinking");
}

for (const [desc, cat, type] of [
  ["Paycheck", "RF1", "income"],
  ["Discover statement payment", "Transfer", "card_payment"],
  ["KC Rent Income", "Business", "income"],
  ["Nain Internet Spectrum", "Rental", "income"],
  ["Interest", "Interest", "income"]
]) {
  const r = assign(desc, cat, type);
  eq(`${cat} not an envelope`, r.envelopeId, null);
  eq(`${cat} skip review`, r.needsReview, false);
}

{
  const r = assign("Amazon", "Shopping");
  eq("amazon review", r.needsReview, true);
  eq("amazon unassigned", r.envelopeId, null);
}

{
  const row = { description: "Aldi", category: "Groceries", type: "card_purchase" };
  const explicitBlank = STS.resolveEditEnvelopeChoice({ ...row, selectedEnvelopeId: "", envelopeTouched: true });
  eq("explicit unassigned stays unassigned", explicitBlank.envelopeId, null);
  eq("explicit unassigned keeps category for review", explicitBlank.category, "Groceries");
  const untouched = STS.resolveEditEnvelopeChoice({ ...row, selectedEnvelopeId: "", envelopeTouched: false });
  eq("untouched blank auto-resolves", untouched.envelopeId, "groceries");
  const selected = STS.resolveEditEnvelopeChoice({ ...row, selectedEnvelopeId: "restaurants", envelopeTouched: true });
  eq("explicit envelope selection wins", selected.envelopeId, "restaurants");
  eq("explicit selection syncs category", selected.category, "Restaurants");
  const laterEdit = STS.resolveEditEnvelopeChoice({ ...row, selectedEnvelopeId: "", envelopeTouched: false,
    previousEnvelopeId: null, previousCategory: "Groceries", previousDescription: "Aldi", previousType: "card_purchase" });
  eq("unassigned remains in review after a later unrelated edit", laterEdit.envelopeId, null);

  const db = {
    settings: { payFrequency: "Biweekly", lastPayday: "2026-09-18", nextPayday: "2026-10-02", asOfMode: "fixed", asOfDate: "2026-09-24" },
    envelopePlan: { phase: 1, envelopeEpoch: "2026-09-18", phaseActivatedAt: {}, fundingEvents: [] },
    ledger: [{ ...row, ...explicitBlank, date: "2026-09-24", amount: -20, status: "Cleared" }]
  };
  eq("explicit unassigned row appears in review queue", STS.envelopeReviewQueue(db).count, 1);
}

{
  const db = {
    ledger: [
      { id: 1, type: "card_purchase", description: "Aldi", category: "Grocery", amount: -20 },
      { id: 2, type: "income", description: "Paycheck", category: "RF1", amount: 2100 },
      { id: 3, type: "card_purchase", description: "Aldi", category: "Grocery", amount: -5, envelopeId: "groceries" }
    ]
  };
  const n = STS.alignLedgerCategories(db);
  ok("align changed rows", n >= 2);
  eq("grocery rewritten", db.ledger[0].category, "Groceries");
  eq("grocery stamped", db.ledger[0].envelopeId, "groceries");
  eq("paycheck unassigned", db.ledger[1].envelopeId, null);
  eq("already stamped category synced", db.ledger[2].category, "Groceries");
}

{
  const days = STS.weekdayFederalHolidays(2026);
  eq("2026 weekday holidays", days.length, 11);
  ok("2026-01-01 included", days.indexOf("2026-01-01") >= 0);
  ok("2026-07-03 observed Independence", days.indexOf("2026-07-03") >= 0);
  ok("2026-07-04 not a weekday holiday", days.indexOf("2026-07-04") < 0);
  eq("adj net per check", STS.holidayAdjustedNetPerPaycheck(2215.38, 2026), 2121.65);
  eq("adj paycheck monthly", STS.holidayAdjustedPaycheckMonthly(2215.38, 2026), 4596.91);
  eq("adopted plan still 6499.99", STS.ADOPTED_PLAN_MONTHLY, 6499.99);
  const p1 = STS.allocateFundingEvent(STS.monthlyByIdForEvent("paycheck", 1), 26);
  eq("Phase 1 biweekly paycheck total unchanged", p1.total, 1549.19);
}

console.log(failed ? `FAILED ${failed}  passed ${passed}` : `ok ${passed} passed`);
process.exit(failed ? 1 : 0);
