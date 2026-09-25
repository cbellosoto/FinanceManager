#!/usr/bin/env node
"use strict";
// User-owned category mappings are evaluated in the pure engine only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const engine = html.split("/*ENGINE-START*/")[1].split("/*ENGINE-END*/")[0];
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(engine + "\nthis.STS = STS;", ctx);
const { STS } = ctx;

const db = STS.ensureEnvelopes({ ledger: [], settings: {} });
assert.equal(JSON.stringify(db.envelopePlan.userCategoryMap), "{}");
const olderDb = { envelopePlan: { phase: 1, phaseActivatedAt: {}, fundingEvents: [] } };
STS.ensureEnvelopes(olderDb);
assert.equal(JSON.stringify(olderDb.envelopePlan.userCategoryMap), "{}");
const cases = [
  { description: "Aldi", category: "Groceries", type: "card_purchase" },
  { description: "Aldi", category: "Grocery", type: "card_purchase" },
  { description: "Costco", category: "Food", type: "card_purchase" },
  { description: "Chipotle", category: "", type: "card_purchase" },
  { description: "Paycheck", category: "RF1", type: "income" }
];
for (const row of cases) {
  assert.equal(JSON.stringify(STS.resolveEnvelopeAssignment(row)),
    JSON.stringify(STS.resolveEnvelopeAssignment({ ...row, userCategoryMap: db.envelopePlan.userCategoryMap })));
}

assert.equal(STS.setUserCategoryMapping(db, "  Grocery  ", "restaurants").ok, true);
assert.equal(db.envelopePlan.userCategoryMap.grocery, "restaurants");
assert.equal(STS.userCategoryMappings(db)[0].overridesBuiltIn, true);
assert.equal(STS.resolveEnvelopeAssignment({ description: "Aldi", category: "Grocery", type: "card_purchase",
  userCategoryMap: db.envelopePlan.userCategoryMap }).envelopeId, "restaurants");
assert.equal(STS.setUserCategoryMapping(db, "gRoCeRy ", "gas").replaced, true);
assert.equal(Object.keys(db.envelopePlan.userCategoryMap).length, 1);
assert.equal(db.envelopePlan.userCategoryMap.grocery, "gas");
assert.equal(STS.resolveEnvelopeAssignment({ description: "Chipotle", category: "Grocery", type: "card_purchase",
  userCategoryMap: db.envelopePlan.userCategoryMap }).envelopeId, "gas");

assert.equal(STS.setUserCategoryMapping(db, "Costco Food", "groceries").ok, true);
const costco = { description: "Costco", category: "Costco Food", type: "card_purchase",
  userCategoryMap: db.envelopePlan.userCategoryMap };
assert.equal(STS.resolveEnvelopeAssignment(costco).envelopeId, "groceries");
assert.equal(STS.resolveEnvelopeAssignment({ ...costco, description: "Chipotle at Costco" }).envelopeId, "groceries");
assert.equal(STS.resolveEnvelopeAssignment({ ...costco, type: "income" }).envelopeId, null);
assert.equal(STS.resolveEnvelopeAssignment({ ...costco, category: "Transfer" }).envelopeId, null);
const typedMapping = STS.resolveTypedCategory("Costco Food", "card_purchase", db.envelopePlan.userCategoryMap);
assert.equal(typedMapping.envelopeId, "groceries");
assert.equal(typedMapping.category, "Groceries");
const editedMapping = STS.resolveEditEnvelopeChoice({
  description: "Chipotle", category: "Costco Food", type: "card_purchase",
  selectedEnvelopeId: "groceries", envelopeTouched: false,
  previousEnvelopeId: "groceries", previousCategory: "Groceries",
  previousDescription: "Chipotle", previousType: "card_purchase",
  userCategoryMap: db.envelopePlan.userCategoryMap
});
assert.equal(editedMapping.envelopeId, "groceries");
assert.equal(editedMapping.category, "Groceries");
const overrideMapping = STS.resolveEditEnvelopeChoice({
  description: "Chipotle", category: "Costco Food", type: "card_purchase",
  selectedEnvelopeId: "groceries", envelopeTouched: false,
  previousEnvelopeId: "groceries", previousCategory: "Groceries",
  previousDescription: "Chipotle", previousType: "card_purchase",
  userCategoryMap: { ...db.envelopePlan.userCategoryMap, "costco food": "restaurants" }
});
assert.equal(overrideMapping.envelopeId, "restaurants");
assert.equal(overrideMapping.category, "Restaurants");

for (const label of ["Groceries", "Transfer", "RF1", "Income"]) {
  assert.equal(STS.setUserCategoryMapping(db, label, "gas").ok, false);
}
assert.equal(STS.setUserCategoryMapping(db, "Mortgage alias", "mortgage").ok, false);
const paused = STS.setUserCategoryMapping(db, "Medical plan", "medical-financing");
assert.equal(paused.ok, true);
assert.equal(paused.paused, true);
assert.equal(STS.userCategoryMappings(db).find(m => m.label === "medical plan").paused, true);

const stamped = {
  type: "card_purchase", status: "Cleared", date: "2026-09-24", description: "Aldi",
  category: "Groceries", envelopeId: "groceries", amount: -20
};
const ledgerDb = STS.ensureEnvelopes({
  settings: { payFrequency: "Biweekly", lastPayday: "2026-09-18", nextPayday: "2026-10-02",
    asOfMode: "fixed", asOfDate: "2026-09-24" },
  ledger: [stamped, { ...stamped, id: 2, category: "Costco Food", envelopeId: null, description: "Costco" }]
});
ledgerDb.envelopePlan.envelopeEpoch = "2026-09-18";
const spentBefore = STS.envelopeSpent(ledgerDb, "groceries");
assert.equal(STS.setUserCategoryMapping(ledgerDb, "Grocer label", "restaurants").ok, true);
assert.equal(stamped.envelopeId, "groceries");
assert.equal(STS.envelopeSpent(ledgerDb, "groceries"), spentBefore);
const preview = STS.previewEnvelopeRemap(ledgerDb.ledger, db.envelopePlan.userCategoryMap);
assert.equal(preview[0].action, "keep");
assert.equal(preview[1].envelopeId, "groceries");
assert.equal(ledgerDb.ledger[1].envelopeId, null);

assert.equal(STS.deleteUserCategoryMapping(db, "  GROCERY "), true);
assert.equal(STS.resolveEnvelopeAssignment({ description: "", category: "Grocery", type: "card_purchase",
  userCategoryMap: db.envelopePlan.userCategoryMap }).envelopeId, "groceries");
assert.equal(STS.deleteUserCategoryMapping(db, "grocery"), false);
assert.equal(STS.setUserCategoryMapping(db, "Costco Groceries", "groceries", "Costco Food").ok, true);
assert.equal(db.envelopePlan.userCategoryMap["costco food"], undefined);
assert.equal(db.envelopePlan.userCategoryMap["costco groceries"], "groceries");

const exportDb = { ledger: [{ type: "card_purchase", description: "", category: "Grocery", envelopeId: null }] };
STS.alignLedgerCategories(exportDb);
assert.equal(exportDb.ledger[0].envelopeId, "groceries");
console.log("ok user category mappings");
