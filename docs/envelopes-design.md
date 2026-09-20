# Envelopes — design doc

**Status:** Draft for review
**Date:** 2026-09-19
**Author:** Spec (assistant) — incorporates review feedback from the repo's main code agent
**Target:** `docs/envelopes-design.md` in `cbellosoto737/FinanceManager`, then phased PRs

This document is the contract for the envelope-budgeting integration. Code comes after this is approved.

---

## 1. Goal and non-goals

**Goal:** Add envelope budgeting to the safe-to-spend app as a budget layer over the existing ledger, so every card swipe can be checked against its envelope *before* it happens, and the household's adopted $6,499.99/mo plan (Phase 1: debt payoff; Phase 2: debts cleared) is tracked in the same place as the money.

**Non-goals:**

- No second ledger. Envelope balances are derived from the existing ledger rows plus explicit funding events. One authoritative ledger, as before.
- No change to the safe-to-spend headline formula in Phase 1/2 of implementation. (Phase 3 may couple them; deferred.)
- No backend change. Everything rides the existing JSON blob (`safeToSpend.v1` / the `app_data` row).

## 2. Budget source of truth

The adopted household budget (Christopher + Sara, 2026-09-19). Both phases total **$6,499.99/mo**.

**Canonical envelope names** are the adopted budget names below — not the `Cleaned Category Map.json` variants ("Dining Out", "Fuel", "Elisa — Needs", etc.). Envelopes are keyed by **stable ids**; names are display labels.

| id | Envelope | Phase 1 | Phase 2 | Kind | Funded by |
|---|---|---:|---:|---|---|
| `mortgage` | Mortgage | 1189.29 | 1189.29 | fixed | recurring (derived) |
| `el-paso-rent` | El Paso Rent | 800.00 | 800.00 | fixed | recurring (derived) |
| `mobile-phone` | Mobile Phone | 71.81 | 71.81 | fixed | recurring (derived) |
| `home-internet` | Home Internet | 35.34 | 35.34 | fixed | recurring (derived) |
| `household-utilities` | Household Utilities | 330.00 | 330.00 | variable | paycheck event |
| `groceries` | Groceries | 940.00 | 940.00 | variable | paycheck event |
| `restaurants` | Restaurants | 300.00 | 400.00 | variable | paycheck event |
| `gas` | Gas | 150.00 | 150.00 | variable | paycheck event |
| `health-insurance` | Health Insurance | 219.63 | 219.63 | fixed | recurring (derived) |
| `life-insurance` | Life Insurance | 105.27 | 105.27 | fixed | recurring (derived) |
| `car-insurance-sinking` | Car Insurance Sinking Fund | 50.00 | 50.00 | sinking | paycheck event |
| `medical-financing` | Medical Financing | 0 | 0 | paused | — |
| `providence-plan` | Providence Payment Plan | 135.41 | 0 | fixed | recurring (derived) |
| `ui-health-plan` | UI Health Payment Plan | 100.00 | 0 | fixed | recurring (derived) |
| `oop-medical` | Out-of-Pocket Medical | 75.00 | 75.00 | variable | paycheck event |
| `elisa-spend` | Elisa Spend | 150.00 | 150.00 | variable | paycheck event |
| `elisa-savings` | Elisa Savings | 86.67 | 86.67 | fixed | recurring (derived) |
| `sara-personal-care` | Sara Personal Care | 150.00 | 150.00 | variable | paycheck event |
| `cats` | Cats | 60.00 | 60.00 | variable | paycheck event |
| `pest-control` | Pest Control | 87.00 | 87.00 | variable | paycheck event |
| `subscriptions` | Subscriptions & Digital Services | 60.00 | 60.00 | variable | paycheck event |
| `annual-renewals` | Known Annual Renewals | 27.00 | 27.00 | sinking | paycheck event |
| `rental-tax-reserve` | Rental Tax Reserve | 300.00 | 300.00 | sinking | rent event |
| `maintenance-reserve` | Home & Rental Maintenance Reserve | 100.00 | 100.00 | sinking | rent event |
| `christopher-fun` | Christopher Personal & Fun | 150.00 | 150.00 | variable | paycheck event |
| `sara-fun` | Sara Personal & Fun | 150.00 | 150.00 | variable | paycheck event |
| `extra-debt-payoff` | Extra Debt Payoff | 0 | 0 | goal | manual |
| `emergency-savings` | Emergency Savings | 300.00 | 400.00 | goal | paycheck event |
| `investing` | Investing | 300.00 | 400.00 | goal | paycheck event |
| `buffer` | Unassigned Buffer | 77.57 | 12.98 | buffer | paycheck event |

30 envelopes. Phase 1 → Phase 2 delta: the freed $235.41 (Providence + UI Health) goes to Restaurants +$100, Emergency Savings +$100, Investing +$100, Buffer −$64.59.

## 3. Data model

One new top-level blob key, `DB.envelopePlan`. No migration framework exists in the repo; follow the `ensureAccountAnchors(db)` lazy-backfill pattern, called in `boot()`.

```js
DB.envelopePlan = {
  version: 1,
  phase: 1,                          // active phase; 1 or 2
  phases: {
    1: { name: "Phase 1 — debt payoff",
         envelopes: [ { id, name, monthly, kind, fundedBy }, /* 30 */ ] },
    2: { name: "Phase 2 — debts cleared",
         envelopes: [ /* 30, per table above */ ] }
  },
  balances: { "<envelope-id>": 0 },  // funded-not-yet-spent; bookkeeping only
  fundingEvents: [],                 // audit log; see §7
  categoryToEnvelope: { "<legacy category>": "<envelope-id>", /* … */ }
}
```

`categoryToEnvelope` is built from the cleaned category map's `legacy_category_map` + `normalization` (typo fixes, merges), translated to stable ids. The map's `ordered_transaction_rules` drive auto-categorization (§8), not this table.

## 4. Funding math

**The divisor comes from settings, not a literal.** Map `settings.payFrequency` → periods per year:

| payFrequency | divisor |
|---|---|
| Weekly | 52 |
| Biweekly | 26 |
| Semimonthly | 24 |
| Monthly | 12 |

`fundingPerEvent(monthly, payFrequency) = r2(monthly × 12 / divisor)`.

**Two funding event types, driven by actual deposits** — not one flat per-paycheck constant. (A single $3,000/paycheck funding would run envelopes ~26% ahead of cash, because $784.61 of it is rental money on a monthly cadence.)

| Event | Trigger | Covers (Phase 1, biweekly) | Amount/event |
|---|---|---|---|
| Paycheck funding | each payday | variable ($2,602/mo) + car-insurance sinking ($50) + annual renewals ($27) + emergency ($300) + investing ($300) + buffer ($77.57) = **$3,356.57/mo** | **$1,549.18** |
| Rent funding | each rent receipt | rental-tax reserve ($300) + maintenance reserve ($100) = **$400/mo** | **$200.00 per receipt** |

> **Assumption (needs confirmation):** two $850/mo rent receipts → $200 each = $400/mo total. If there is a single monthly receipt, fund $400 on that one receipt instead. Idempotency is keyed by receipt date, so the rule is: total rent funding across receipts in a month must equal $400, never $400 × receipts. See open decision §13.4.

Affordability check (Phase 1, biweekly): paycheck $2,215.38 ≥ $1,549.18 ✓; rent $1,700 ≥ $400 + mortgage handled by its recurring row ✓. Envelopes never run ahead of their income source.

Phase 2 paycheck event (biweekly): $3,591.98/mo → **$1,657.84**. Rent event unchanged.

**Fixed envelopes are not funded by events at all** — see §5.

## 5. Fixed vs. funded envelopes (the double-counting rule)

Fixed bills (mortgage, rent, insurance, phone, internet, the two medical plans, Elisa savings transfer: **$2,743.42/mo** in Phase 1) already exist as recurring rows and are already reserved by the projection. Funding an envelope for them while the pending row sits in the projection counts the same dollar twice — the exact failure the app was built to prevent.

**Rule:** `kind: "fixed"` envelopes are **derived and display-only**.

- Displayed funded amount and next due date come from the recurring schedule (same source the projection uses).
- No funding action touches them. They do not appear in the funding checklist.
- They are excluded from any "total remaining" spendable sum. Their remaining answers one question: *paid or not yet this cycle?*

The **variable line ($2,602/mo)** is where envelopes add value: spending the headline formula cannot see today. The funding checklist covers **variable + sinking + goals + buffer only**.

## 6. Rollover policy

Balances persist across cycles — there is no monthly reset and no auto-sweep. "Groceries came in $60 under" has one explicit answer: the $60 stays in `groceries` until spent or deliberately moved.

- Per-envelope **"Sweep to buffer"** action for manual reallocation.
- No automatic month-end sweep. Explicit beats magic; the buffer envelope is the designated parking spot.

## 7. Funding idempotency and audit

"No ledger rows" keeps the projection clean, but two people share one database. Funding must be idempotent and auditable:

```js
fundingEvents: [
  { eventType: "paycheck" | "rent", date: "2026-10-02", phase: 1,
    amounts: { "<envelope-id>": 434.00, /* … */ },
    createdAt: "<iso>", createdBy: "<user>" }
]
```

- `fundPaycheck(db, paydayDate)` / `fundRent(db, receiptDate)` check the log first: a funding event for the same `(eventType, date)` is a **no-op** that reports "already funded" instead of double-funding.
- The Envelopes tab shows the funding log. No silent state changes.

## 8. Categorization (implementation Phase 1)

Useful on its own even if envelopes never ship.

1. **Stable ids first.** Confirm the 30 canonical names (§2) before rewriting rows.
2. **Legacy remap with preview.** Apply `legacy_category_map` + typo/merges to the ~400 ledger rows behind a **preview-then-apply** step reusing the existing `drawImportPreview` pattern. Export-first is already available, plus the server's version history — the preview means neither should be needed.
3. **Rules at entry time.** Wire `ordered_transaction_rules` into `doImport` (new CSV rows currently land with `category: ""`) and `quickAdd` (prefill from description match). Rows matching `manual_review_rules` (Amazon/Walmart/Costco/Sam's — merchants spanning envelopes) stay uncategorized for a human.

## 9. The Envelopes tab (implementation Phase 2)

- New `<section class="panel" id="panel-envelopes">` + `renderEnvelopes()`, called from `render()`. Reuse `fmt$`, `tile()`, `bindSortHeaders`, `openDlg`, `.frow` styles. `switchTab` is generic — no changes needed.
- **Phase toggle** (Phase 1 / Phase 2), same pattern as the dashboard mode buttons.
- **Funding checklist**: "Funded through <date>" + `[Fund paycheck]` / `[Fund rent receipt]` buttons, per-envelope event amounts, idempotent per §7, log visible.
- **Envelope table** (sortable): Envelope | Monthly | Per event | Funded (balance) | Spent (cycle) | Remaining | bar. Over-budget → `.pill.bad`; fixed section rendered separately as derived status (next due / paid).
- **Spent math** (pure, in the `STS` engine): Σ `−amount` over rows where `type ∈ {card_purchase, cash_expense, recurring}`, `status ≠ "Void"`, `date ≥ cycleStart`, `categoryToEnvelope[category] == id`. Refunds add back. `card_payment` / `Transfer` excluded (existing `exclude_from_spending_totals`).
- Cycle = payday-to-payday via the existing `effectiveNextPayday`.
- Mobile: Envelopes takes a bottom-bar slot; Accounts moves behind More (Envelopes is the check-before-swiping lookup; Accounts is set-and-forget).

## 10. Tests (part of the Phase 2 PR)

The repo has no tests. The envelope math is pure functions, so add a small test file asserting the lifecycle:

`fund → spend → rollover → refund → debt paydown`, plus: double-fund is a no-op, divisor variants (26/24/12), fixed envelopes derive from recurring and never take funding. This is what keeps Phase 3 from quietly breaking Phase 1.

## 11. Phase 3 — deferred

Optional coupling of envelope remaining to the safe-to-spend headline (e.g., the "can we spend" verdict also checking the envelope). Not designed here.

## 12. Implementation phases and ground rules

1. **This doc** — review first. Cheap to argue about a document; expensive to argue about a diff.
2. **Phase 1 PR** — category ids, legacy remap with preview, rules in `doImport`/`quickAdd`.
3. **Phase 2 PR** — `envelopePlan` + `ensureEnvelopes()` backfill + pure functions + the tab + tests (§10).
4. **Phase 3 PR** — only if the coupling is wanted.

Ground rules for every PR:

- Engine changes stay inside the `ENGINE-START` / `ENGINE-END` markers.
- No reformatting of untouched code.
- Any change to `cardOwedNow`, `cardFunded`, or `totalUnfunded` is called out explicitly in the PR description — a subtle regression there silently corrupts the headline number.
- **Never test against production.** `sts2` holds real data. Test by opening `index.html` directly (it falls back to localStorage) and importing the 2026-09-19 backup. A staging environment is a separate subdomain with its own database — not a second door into the same one.
- Merge and deploy handled by the repo's code agent after review.

## 13. Open decisions for Christopher

1. Confirm the 30 canonical envelope names in §2 (display labels; ids are stable regardless).
2. Which property the $1,189.29 mortgage belongs to (affects the rental-lane framing in the funding checklist).
3. Mobile tab placement — recommendation in §9 is Envelopes in the bottom bar, Accounts behind More.
4. Rent receipt cadence and amounts — §4 assumes two $850/mo receipts at $200 each ($400/mo total). Confirm: two receipts or one, and whether the $850 figures are gross or net.
