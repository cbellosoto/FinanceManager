"use strict";
// Browser-driven regression tests for the Safe-to-Spend app.
//
// The app is a single static file (index.html) whose whole financial engine and UI run in the
// browser. These tests load it over file://, let it boot to its built-in seed data (the api/*.php
// backend is unreachable over file://, so boot() falls back to the seed and shows the UI without a
// login), then drive the real dialogs and assert on both the visible table and the in-memory DB.
//
// No test framework beyond Node's built-in runner (node:test) and Playwright. Run with:  npm test
// (after `npm install` and `npm run test:install` — see tests/README.md).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { chromium } = require("playwright");

const FILE_URL = "file://" + path.resolve(__dirname, "..", "index.html");
// In CI/sandboxes the browser may live at a custom path; locally Playwright's managed browser is used.
const EXEC = process.env.PW_CHROMIUM || undefined;

let browser;
before(async () => { browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {}); });
after(async () => { await browser.close(); });

// Fresh, isolated page booted to a known seed. Each test gets its own browser context (clean
// localStorage), then we explicitly reset DB to the demo seed so assertions never depend on state
// a previous run may have cached.
async function freshPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page._pageErrors = pageErrors;
  await page.goto(FILE_URL, { waitUntil: "domcontentloaded" });
  // DB / STS are top-level let/const bindings — lexical globals, NOT window properties — so they must
  // be referenced bare, not as window.DB. boot() sets DB from the seed once the (absent) backend fetch fails.
  await page.waitForFunction(() => typeof DB !== "undefined" && DB && DB.cards && typeof STS !== "undefined");
  // Reset to the demo seed and open the Cards tab (the app boots to Home, so #panel-cards starts hidden;
  // its rows must be visible for waitForSelector and innerText assertions to work).
  await page.evaluate(() => { DB = STS.ensureAccountAnchors(buildSeed()); render(); switchTab("cards"); renderCards(); });
  await page.waitForSelector("#cardsBody tr", { state: "visible" });
  return page;
}

// Run a test body against a fresh page and assert the page logged no uncaught JS errors.
function appTest(name, body) {
  test(name, async () => {
    const page = await freshPage();
    try {
      await body(page);
      assert.deepEqual(page._pageErrors, [], "page threw uncaught errors: " + page._pageErrors.join(" | "));
    } finally {
      await page.context().close();
    }
  });
}

// Index of the first normal (non-debt) card in the seed.
const firstCardIndex = (page) => page.evaluate(() => DB.cards.findIndex((c) => c.treatAs !== "Debt"));
// A date N days after the seed's "today", using the app's own date math.
const dueInDays = (page, n) => page.evaluate((days) => STS.addDays(STS.asOf(DB), days), n);

// ----------------------------------------------------------------------------------------------
// Pay is fully merged into Reconcile — the separate Pay button/modal/quick-add option are gone.
// ----------------------------------------------------------------------------------------------
appTest("no separate card-payment entry points remain", async (page) => {
  const kinds = await page.$eval("#qaKind", (el) => [...el.options].map((o) => o.value));
  assert.ok(!kinds.includes("cardpay"), 'quick-add still offers "Card payment…"');

  const payButtons = await page.$$eval("#cardsBody button", (bs) => bs.filter((b) => b.textContent.trim() === "Pay").length);
  assert.equal(payButtons, 0, 'a card row still shows a "Pay" button');

  const fn = await page.evaluate(() => typeof window.openCardPayment);
  assert.equal(fn, "undefined", "openCardPayment() should no longer exist");
});

// ----------------------------------------------------------------------------------------------
// Reconcile schedules the statement payment and surfaces it (amount + date) under Scheduled to pay.
// ----------------------------------------------------------------------------------------------
appTest("reconcile schedules a payment on the due date and shows it", async (page) => {
  const i = await firstCardIndex(page);
  const due = await dueInDays(page, 40);

  await page.evaluate((idx) => window.openReconcile(idx), i);
  await page.waitForSelector("#rcSave");
  await page.selectOption("#rcMode", "Full"); // pay the full statement
  await page.fill("#rcStmt", "900");
  await page.fill("#rcDue", due);
  await page.click("#rcSave");
  await page.waitForTimeout(100);

  const r = await page.evaluate((idx) => {
    const c = DB.cards[idx];
    const p = DB.ledger.find((e) => e.cardName === c.name && e.type === "card_payment" && e.status === "Pending" && e.cashImpact);
    return { balance: c.balance, due: c.dueDate, payAmt: p && p.amount, payDate: p && p.date, sched: STS.cardNextPayment(DB, c) };
  }, i);

  assert.equal(r.balance, 900, "balance should reset to the new statement");
  assert.equal(r.due, due, "due date should update");
  assert.equal(r.payAmt, -900, "a pending cash payment for the full statement should be scheduled");
  assert.equal(r.payDate, due, "payment should default to the due date");
  assert.equal(r.sched.total, 900, "Scheduled to pay total should equal the scheduled payment");

  const cell = await page.evaluate((idx) => document.querySelectorAll("#cardsBody tr")[idx].innerText, i);
  assert.ok(cell.includes("$900"), 'the row should display the scheduled "$900"');
});

// ----------------------------------------------------------------------------------------------
// "Already paid" (Cleared) pays the balance down now and leaves nothing scheduled.
// ----------------------------------------------------------------------------------------------
appTest("marking a reconcile payment Already paid clears the balance", async (page) => {
  const i = await firstCardIndex(page);
  const today = await dueInDays(page, 0);
  const due = await dueInDays(page, 40);

  await page.evaluate((idx) => window.openReconcile(idx), i);
  await page.waitForSelector("#rcSave");
  await page.selectOption("#rcMode", "Full");
  await page.fill("#rcStmt", "500");
  await page.fill("#rcDue", due);
  await page.fill("#rcPayDate", today);
  await page.selectOption("#rcPayStatus", "Cleared");
  await page.click("#rcSave");
  await page.waitForTimeout(100);

  const r = await page.evaluate((idx) => {
    const c = DB.cards[idx];
    return {
      owed: STS.cardOwedNow(DB, c),
      pendingCash: DB.ledger.filter((e) => e.cardName === c.name && e.type === "card_payment" && e.status === "Pending" && e.cashImpact).length,
    };
  }, i);

  assert.equal(r.owed, 0, "a cleared full payment should zero the balance");
  assert.equal(r.pendingCash, 0, "nothing should remain scheduled once it's paid");
});

// ----------------------------------------------------------------------------------------------
// The payment date can be set earlier than the due date (pay-ahead).
// ----------------------------------------------------------------------------------------------
appTest("payment date can differ from the due date", async (page) => {
  const i = await firstCardIndex(page);
  const due = await dueInDays(page, 50);
  const payEarly = await dueInDays(page, 20);

  await page.evaluate((idx) => window.openReconcile(idx), i);
  await page.waitForSelector("#rcSave");
  await page.selectOption("#rcMode", "Full");
  await page.fill("#rcStmt", "300");
  await page.fill("#rcDue", due);
  await page.fill("#rcPayDate", payEarly); // override after due, so it sticks
  await page.click("#rcSave");
  await page.waitForTimeout(100);

  const r = await page.evaluate((idx) => {
    const c = DB.cards[idx];
    const p = DB.ledger.find((e) => e.cardName === c.name && e.type === "card_payment" && e.status === "Pending" && e.cashImpact);
    return { due: c.dueDate, payDate: p && p.date };
  }, i);

  assert.equal(r.due, due, "due date is what was entered");
  assert.equal(r.payDate, payEarly, "payment is dated on the earlier pay-ahead date");
});

// ----------------------------------------------------------------------------------------------
// Reconciling a DEBT links it to the recurring bill that pays it down, hides the checking-payment
// fields, drops any stale cash payment, and surfaces the recurring paydown as Scheduled to pay.
// ----------------------------------------------------------------------------------------------
appTest("reconciling a debt links the recurring paydown and drops stale cash payments", async (page) => {
  const setup = await page.evaluate(() => {
    const debt = DB.cards[DB.cards.length - 1];
    debt.treatAs = "Debt";
    const payingCard = DB.cards.find((c) => c.name !== debt.name).name;
    const nextDate = STS.addDays(STS.asOf(DB), 25);
    DB.recurring.push({
      id: "TESTPAY", name: "Test paydown", category: "Financing", amount: 75, frequency: "Monthly",
      nextDate, payMethod: payingCard, payDownDebt: debt.name, kind: "expense", autopay: true, mandatory: true,
    });
    // A stale cash payment a previous (wrong) reconcile might have left on the debt.
    DB.ledger.push({
      id: useId(), date: STS.addDays(STS.asOf(DB), 10), type: "card_payment", description: debt.name + " statement payment",
      category: "Transfer", amount: -30, source: (DB.accounts.find((a) => a.type === "Checking") || {}).name || "",
      dest: debt.name, payMethod: "ACH", cardName: debt.name, cashImpact: true, mandatory: true, status: "Pending",
      inSTS: false, recurringId: "", notes: "",
    });
    // The recurring paydown instance (a card charge, no cash impact).
    DB.ledger.push({
      id: useId(), date: nextDate, type: "card_payment", description: "Test paydown", category: "Financing",
      amount: -75, source: "", dest: debt.name, payMethod: "Card", cardName: debt.name, cashImpact: false,
      mandatory: true, status: "Pending", inSTS: false, recurringId: "TESTPAY", notes: "Paid via " + payingCard,
    });
    render(); renderCards();
    return { debtName: debt.name, debtIndex: DB.cards.length - 1, nextDate };
  });

  await page.evaluate((idx) => window.openReconcile(idx), setup.debtIndex);
  await page.waitForSelector("#rcSave");

  const ui = await page.evaluate(() => ({
    cardPayHidden: getComputedStyle(document.getElementById("rcCardPay")).display === "none",
    debtPayShown: getComputedStyle(document.getElementById("rcDebtPay")).display !== "none",
    payFromHidden: getComputedStyle(document.getElementById("rcFromField")).display === "none",
    hasRecurringOption: [...document.getElementById("rcPaidBy").options].some((o) => o.value === "TESTPAY"),
  }));
  assert.ok(ui.cardPayHidden, "checking-payment fields should be hidden for a debt");
  assert.ok(ui.debtPayShown, '"Paid by recurring" fields should show for a debt');
  assert.ok(ui.payFromHidden, '"Pay from" should be hidden for a debt');
  assert.ok(ui.hasRecurringOption, "the linked recurring bill should be selectable");

  await page.selectOption("#rcPaidBy", "TESTPAY");
  const dueAfterPick = await page.$eval("#rcDue", (el) => el.value);
  assert.equal(dueAfterPick, setup.nextDate, "picking the recurring should pull its next charge onto the due date");

  await page.click("#rcSave");
  await page.waitForTimeout(100);

  const after = await page.evaluate((name) => {
    const d = DB.cards.find((c) => c.name === name);
    return {
      paidBy: d.paidBy, due: d.dueDate,
      pendingCash: DB.ledger.filter((e) => e.cardName === name && e.type === "card_payment" && e.cashImpact && e.status === "Pending").length,
      pendingPaydown: DB.ledger.filter((e) => e.cardName === name && e.type === "card_payment" && !e.cashImpact && e.status === "Pending").length,
      schedTotal: STS.cardNextPayment(DB, d).total,
    };
  }, setup.debtName);

  assert.equal(after.paidBy, "TESTPAY", "the debt should record its paying recurring bill");
  assert.equal(after.due, setup.nextDate, "the debt's due date should follow the recurring charge");
  assert.equal(after.pendingCash, 0, "the stale cash payment should be removed");
  assert.equal(after.pendingPaydown, 1, "the recurring paydown should be preserved");
  assert.equal(after.schedTotal, 75, "Scheduled to pay should reflect the upcoming recurring paydown");

  const cell = await page.evaluate((idx) => document.querySelectorAll("#cardsBody tr")[idx].innerText, setup.debtIndex);
  assert.ok(cell.includes("via recurring"), 'the debt row should label its schedule "via recurring"');
});

// ----------------------------------------------------------------------------------------------
// Generate upcoming bills: Check all / Uncheck all with a live count, and Add disabled at zero.
// ----------------------------------------------------------------------------------------------
appTest("generate-bills modal has working check-all / uncheck-all", async (page) => {
  const missingCount = await page.evaluate(() => STS.missingRecurring(DB, STS.asOf(DB), DB.settings.horizonDays).length);
  assert.ok(missingCount > 0, "seed should have upcoming bills to generate");

  await page.evaluate(() => window.openGenerate());
  await page.waitForSelector("#genNone");

  await page.click("#genNone");
  const none = await page.evaluate(() => ({
    checked: [...document.querySelectorAll("[data-gen]")].filter((c) => c.checked).length,
    disabled: document.getElementById("genSave").disabled,
    count: document.getElementById("genCount").textContent,
  }));
  assert.equal(none.checked, 0, "Uncheck all should clear every box");
  assert.equal(none.disabled, true, "Add should be disabled when nothing is selected");
  assert.match(none.count, /^0 of \d+ selected$/, "the counter should read 0 selected");

  await page.click("#genAll");
  const all = await page.evaluate(() => ({
    checked: [...document.querySelectorAll("[data-gen]")].filter((c) => c.checked).length,
    disabled: document.getElementById("genSave").disabled,
  }));
  assert.equal(all.checked, missingCount, "Check all should select every box");
  assert.equal(all.disabled, false, "Add should be enabled once boxes are selected");
});
