# Envelopes — design doc

**Status:** Draft for review (rev 2.1 — incorporates Christopher's §13 answers + code-agent rev-2 corrections)
**Date:** 2026-09-19 / rev 2 2026-09-20 / rev 2.1 2026-09-20
**Author:** Spec (assistant) — incorporates review feedback from the repo's main code agent
**Target:** `docs/envelopes-design.md` in `cbellosoto/FinanceManager`, then phased PRs

This document is the contract for the envelope-budgeting integration. Code comes after this is approved.

---

## 1. Goal and non-goals

**Goal:** Add envelope budgeting to the safe-to-spend app as a budget layer over the existing ledger, so every card swipe can be checked against its envelope *before* it happens, and the household's adopted $6,499.99/mo plan (Phase 1: debt payoff; Phase 2: debts cleared) is tracked in the same place as the money.

**Non-goals:**

- No second ledger. Envelope balances are derived from the existing ledger rows plus explicit funding events. One authoritative ledger, as before.
- **No mutable envelope state.** There is no stored `balances` table. `remaining = funded − spent`, both computed from funding events and ledger rows (§3.1). Edits, voids, refunds, recategorization, and duplicate imports change the inputs and remaining follows — it cannot drift out of sync.
- No change to the safe-to-spend headline formula in Phase 1/2 of implementation. (Phase 3 may couple them; deferred.)
- No backend change. Everything rides the existing JSON blob (`safeToSpend.v1` / the `app_data` row).

## 2. Budget source of truth

The adopted household budget (Christopher + Sara, 2026-09-19). Both phases total **$6,499.99/mo**.

**Canonical envelope names** are the adopted budget names below — not the `Cleaned Category Map.json` variants ("Dining Out", "Fuel", "Elisa — Needs", etc.). Envelopes are keyed by **stable ids**; names are display labels.

| id | Envelope | Phase 1 | Phase 2 | Kind | Funded by |
|---|---|---:|---:|---|---|
| `mortgage` | KC Mortgage | 1189.29 | 1189.29 | fixed | recurring (derived) |
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
  phase: 1,                                // active phase; 1 or 2
  envelopeEpoch: "2026-10-01",             // set when the first funding event runs; see §3.2
  phaseActivatedAt: { 1: "2026-10-01" },   // when each phase became active; phase 2 added on toggle
  phases: {
    1: { name: "Phase 1 — debt payoff",
         envelopes: [ { id, name, monthly, kind, fundedBy }, /* 30 */ ] },
    2: { name: "Phase 2 — debts cleared",
         envelopes: [ /* 30, per table above */ ] }
  },
  fundingEvents: [],                       // audit log; see §7. funded() is derived from this log — no mutable balances.
  categoryToEnvelope: { "<legacy category>": "<envelope-id>", /* … */ }
}
```

`categoryToEnvelope` is built from the cleaned category map's `legacy_category_map` + `normalization` (typo fixes, merges), translated to stable ids. The map's `ordered_transaction_rules` drive auto-categorization (§8), not this table.

### 3.1 Derived-state invariant (the one balance rule)

There is exactly one way to compute an envelope's position — no stored balances, no parallel bookkeeping:

```
funded(id)    = Σ e.amounts[id] over funding events e with e.date ≥ envelopeEpoch
                (+ reallocations in, − reallocations out; §6)
spent(id)     = Σ −row.amount over eligible rows                    (§9 rule)
remaining(id) = funded(id) − spent(id)
```

Every input is either an explicit funding event or a ledger row. Editing, voiding, refunding, recategorizing, or duplicate-importing a row changes the inputs, and `remaining` follows on the next render. There is nothing to drift.

### 3.2 Envelope epoch and phase transitions

- `envelopeEpoch` is set once, when the first funding event is recorded. **Ledger rows and funding events dated before the epoch are invisible to envelope math.** Years of historical spending never consume newly-initialized balances.
- The Phase 1 → Phase 2 toggle records `phaseActivatedAt[2] = today`. Future funding events stamp the new phase and use its monthly amounts. Past funding events keep their recorded phase and amounts. Ledger rows are phase-agnostic: envelope ids are stable across phases, so a row dated before the toggle still counts against the same envelope.
- The toggle changes future funding and the displayed monthly targets. It never rewrites history.

### 3.3 Row identity: `envelopeId` is stamped once

Ledger rows carry `envelopeId` (a stable id from §2), assigned exactly once:

- **At creation:** `doImport` / `quickAdd` resolve the row's category → envelope id via the rules/map and store it alongside the free-text `category` string.
- **Backfill:** the Phase 1 legacy remap (§8, preview-then-apply) stamps `envelopeId` on the ~400 existing rows at apply time.
- **Spent math reads `row.envelopeId` only** — never the live `categoryToEnvelope` map. Editing a mapping changes future rows; it cannot move old spending.
- **Display names resolve at render time** (`envelopeId → phases[activePhase].envelopes[].name`). Renaming a label touches zero rows.
- Rows that cannot be resolved get `envelopeId: null` and land in the review queue (§9.1).

## 4. Funding math

**The divisor comes from settings, not a literal.** Map `settings.payFrequency` → periods per year:

| payFrequency | divisor |
|---|---|
| Weekly | 52 |
| Biweekly | 26 |
| Semimonthly | 24 |
| Monthly | 12 |

**Two funding event types, driven by actual deposits** — not one flat per-paycheck constant. (A single $3,000/paycheck funding would run envelopes ~26% ahead of cash, because $784.61 of it is rental money on a monthly cadence.)

| Event | Trigger | Covers (Phase 1, biweekly) | Amount/event |
|---|---|---|---|
| Paycheck funding | each payday | variable ($2,602/mo) + car-insurance sinking ($50) + annual renewals ($27) + emergency ($300) + investing ($300) + buffer ($77.57) = **$3,356.57/mo** | **$1,549.19** |
| Rent funding | each rent receipt | rental-tax reserve ($300) + maintenance reserve ($100) = **$400/mo** | **$100.00 per receipt** (~4 receipts/mo) |

> **Confirmed (Christopher, 2026-09-20):** two parties, each paying twice a month → ~4 deposits/mo of ~$425 (sometimes ~$450 when the tenants' Spectrum internet reimbursement is included). **$100 funded per receipt = $400/mo total** toward the two rental sinking funds. The occasional +$25 internet top-up is income noise, not an extra funding event. A month with fewer than 4 receipts simply under-funds that month — visible in the funding log, no catch-up magic.

Affordability check (Phase 1, biweekly): paycheck $2,215.38 ≥ $1,549.19 ✓; rent ~$1,700 ≥ $400 ✓ (KC Mortgage is a fixed derived envelope on the household side, handled by its recurring row). Envelopes never run ahead of their income source.

Phase 2 paycheck event (biweekly): $3,591.98/mo → **$1,657.84**. Rent event unchanged.

**Fixed envelopes are not funded by events at all** — see §5.

### 4.1 Deterministic rounding (integer cents)

Funding math is integer-cents, distributed by a pure function `allocateFundingEvent(monthlyById, divisor)`:

```
cents_i   = round(monthly_i × 1200 / divisor)      // per-envelope event amount, integer cents
target    = round(monthly_total × 1200 / divisor)   // the event total, integer cents
remainder = target − Σ cents_i                      // typically −2¢…+2¢
```

`remainder` is distributed 1¢ at a time to envelopes in **ascending stable-id order** — deterministic, no float drift, same result on every run.

**Invariant:** Σ per-envelope event amounts == event total, exactly, on every funding event. (Check: Phase 1 paycheck, biweekly: event total = round(335657 × 12 / 26) = 154919¢ = **$1,549.19**; Σ per-envelope = 154918¢, so the 1¢ remainder goes to the first envelope in id order → $1,549.19 ✓.)

## 5. Fixed vs. funded envelopes (the double-counting rule)

Fixed bills (mortgage, rent, insurance, phone, internet, the two medical plans, Elisa savings transfer: **$2,743.42/mo** in Phase 1) already exist as recurring rows and are already reserved by the projection. Funding an envelope for them while the pending row sits in the projection counts the same dollar twice — the exact failure the app was built to prevent.

**Rule:** `kind: "fixed"` envelopes are **derived and display-only**.

- Displayed funded amount and next due date come from the recurring schedule (same source the projection uses).
- No funding action touches them. They do not appear in the funding checklist.
- They are excluded from any "total remaining" spendable sum. Their remaining answers one question: *paid or not yet this cycle?*

The **variable line ($2,602/mo)** is where envelopes add value: spending the headline formula cannot see today. The funding checklist covers **variable + sinking + goals + buffer only**.

## 6. Rollover policy

Balances persist across cycles — there is no monthly reset and no auto-sweep. "Groceries came in $60 under" has one explicit answer: the $60 stays in `groceries` until spent or deliberately moved. (With derived state (§3.1) there is nothing to reset — `funded` only grows via funding events and `spent` only grows via ledger rows.)

- **"Sweep to buffer"** is a logged `reallocate` funding event (`{eventType: "reallocate", from, to, amount, date, …}`), not a balance mutation. It appears in the funding log like any other event.
- No automatic month-end sweep. Explicit beats magic; the buffer envelope is the designated parking spot.

## 7. Funding idempotency and audit

"No ledger rows" keeps the projection clean, but two people share one database. Funding must be idempotent and auditable:

```js
fundingEvents: [
  { eventType: "paycheck" | "rent" | "reallocate", date: "2026-10-02", phase: 1,
    sourceId: "<ledger row id of the deposit>" | null,   // stable source when the funding is tied to one
    amounts: { "<envelope-id>": 434.00, /* … */ },
    createdAt: "<iso>", createdBy: "<user>" }
]
```

- **Idempotency key: `(eventType, sourceId ?? date)`.** `fundPaycheck` / `fundRent` re-read the log immediately before writing; a matching event makes the tap a **no-op** that reports "already funded" instead of double-funding.
- **Same-date collision:** two rent receipts can share a date, so `(eventType, date)` alone is not a safe key — that is what `sourceId` is for. The fund UI lists candidate sources (deposit rows / receipt dates) with their funded state; funding an already-funded source is blocked, and a sourceless manual tap on an already-funded date warns instead of writing.
- **Concurrency:** the server (`api/data.php`) does optimistic versioning — it rejects stale writes with **409** when `baseVersion` ≠ current version, and `syncToServer` already surfaces that as a "reload to see the latest" banner. Funding must: 1. read the fresh blob + version, 2. check the funding log, 3. save with `baseVersion`, 4. on 409 → reload and re-check the log (**do not overwrite**). A repeat after reload is a no-op, not a double-fund.
- The Envelopes tab shows the funding log. No silent state changes.

## 8. Categorization (implementation Phase 1)

Useful on its own even if envelopes never ship.

1. **Stable ids first.** Confirm the 30 canonical names (§2) before rewriting rows.
2. **Legacy remap with preview.** Apply `legacy_category_map` + typo/merges to the ~400 ledger rows behind a **preview-then-apply** step reusing the existing `drawImportPreview` pattern. Applying the remap stamps `envelopeId` on each row (§3.3). Export-first is already available, plus the server's version history — the preview means neither should be needed.
3. **Rules at entry time.** Wire `ordered_transaction_rules` into `doImport` (new CSV rows currently land with `category: ""`) and `quickAdd` (prefill from description match). Each new row gets its `envelopeId` stamped at creation. Rows matching `manual_review_rules` (Amazon/Walmart/Costco/Sam's — merchants spanning envelopes) stay `envelopeId: null` for a human, and surface in the review queue (§9.1).

## 9. The Envelopes tab (implementation Phase 2)

- New `<section class="panel" id="panel-envelopes">` + `renderEnvelopes()`, called from `render()`. Reuse `fmt$`, `tile()`, `bindSortHeaders`, `openDlg`, `.frow` styles. `switchTab` is generic — no changes needed.
- **Phase toggle** (Phase 1 / Phase 2), same pattern as the dashboard mode buttons. Toggling records `phaseActivatedAt` and changes future funding + displayed targets; history is untouched (§3.2).
- **Funding checklist**: "Funded through <date>" + `[Fund paycheck]` / `[Fund rent receipt]` buttons, per-envelope event amounts (§4.1), idempotent per §7, log visible.
- **Envelope table** (sortable): Envelope | Monthly | Per event | Funded | Spent (cycle) | Remaining | bar. Over-budget → `.pill.bad`; fixed section rendered separately as derived status (next due / paid).
- **Spent math** (pure, in the `STS` engine). A ledger row counts toward its envelope's cycle spending iff **all** hold:

```
row.envelopeId != null
AND row.type ∈ {"card_purchase", "cash_expense", "recurring", "refund"}
AND row.status ∈ {"Cleared", "Pending"}        // explicit allowlist — "Void" never counts
AND row.date ≥ envelopeEpoch                    // §3.2 — history never consumes new balances
AND kind(row.envelopeId) ≠ "fixed"              // fixed envelopes never enter the funded spent table — see below
AND cycleStart ≤ row.date < cycleEnd            // half-open — each row belongs to exactly one cycle
AND NOT (row.type == "recurring" AND row.date > today AND row.status == "Pending")
                                                // future/planned recurring projections aren't spending yet
```

  - `spent(id) = Σ −row.amount` over matching rows. Refunds (`type: "refund"`, positive amounts, stamped with the original envelope where identifiable) add back naturally.
  - `card_payment` rows — statement payments (`category: "Transfer"`) and debt-paydown movements (`debtPaydownEvent`: `cashImpact: false`, `inSTS: false`) — are excluded by the type allowlist. The original purchases already counted; the payment must not count again.
  - `income` and `planned_spend` rows never count.
  - **Fixed envelopes have no `funded` / `spent` / `remaining`.** Their paid/not-paid status and next due date are derived separately from the recurring schedule (§5). Even if a fixed bill's generated recurring row carries an `envelopeId` for categorization, the `kind ≠ "fixed"` guard keeps it out of the funded spent table.
  - Cycle bounds reuse the existing `effectiveNextPayday` — envelopes do not reimplement payday math.
- **Cycle** = payday-to-payday, half-open `[cycleStart, cycleEnd)`.
- Mobile: Envelopes takes a bottom-bar slot; Accounts moves behind More (Envelopes is the check-before-swiping lookup; Accounts is set-and-forget).

### 9.1 Review queue (no silent drops)

Rows the rules can't resolve (`envelopeId: null`) are not ignored — they are counted:

```
reviewQueue = { count, total } over eligible-cycle rows with envelopeId == null
```

The Envelopes tab shows **"⚠ N transactions need review ($X)"** whenever `count > 0`. Remaining figures are presented with that caveat — an uncategorized grocery run must never make an envelope look more generous than it is. The §8 remap preview must drive historical uncategorized to zero before apply; entry-time rules keep it near zero going forward.

## 10. Tests (part of the Phase 2 PR)

The repo has no tests. The envelope math is pure functions, so add a small test file asserting the lifecycle:

`fund → spend → rollover → refund → debt paydown`, plus:

- **Derived invariant:** edit / void / refund / recategorize / duplicate-import a row → `remaining` recomputes from inputs; there is no stored balance to go stale.
- **Epoch:** rows dated before `envelopeEpoch` don't count; the Phase 1 → 2 toggle keeps past funding events and their phases intact.
- **Idempotency:** same `(eventType, sourceId)` twice → no-op; same date with different sources → two events.
- **Rounding:** Σ per-envelope amounts == event total for divisor variants (52/26/24/12); deterministic across runs.
- **Spent eligibility:** `card_payment` (statement + debt-paydown), `Transfer`, future/planned recurring rows, and `Void` rows never reduce an envelope.
- **Review queue:** an uncategorized row increments count/total and triggers the banner; it doesn't inflate any remaining.
- **Regression:** `safeToSpend` output is byte-identical before/after the envelope code loads, in all dashboard modes (Conservative/Moderate/Aggressive). Envelope work must not move the headline number.
- Double-fund is a no-op; fixed envelopes derive from recurring and never take funding.

## 11. Phase 3 — deferred

Optional coupling of envelope remaining to the safe-to-spend headline (e.g., the "can we spend" verdict also checking the envelope). Not designed here.

## 12. Implementation phases and ground rules

1. **This doc** — review first. Cheap to argue about a document; expensive to argue about a diff.
2. **Phase 1 PR** — category ids, legacy remap with preview, rules in `doImport`/`quickAdd`, `envelopeId` stamping.
3. **Phase 2 PR** — `envelopePlan` + `ensureEnvelopes()` backfill + pure functions + the tab + tests (§10).
4. **Phase 3 PR** — only if the coupling is wanted.

Ground rules for every PR:

- Engine changes stay inside the `ENGINE-START` / `ENGINE-END` markers.
- No reformatting of untouched code.
- **Envelope code must not change the outputs of the engine's existing functions** — the safe-to-spend totals (`safeToSpend`, `computeAll`, `cardOwedNow`, `cardFunded`, `cardUnfunded`, `totalUnfunded`), the projection path (`projection`, `windowFlows`, `countsInWindow`, `effectiveNextPayday`, `occurrences`, `missingRecurring`, `instanceEvents`), or the balance/account path (`spendableChecking`, `savingsBackup`, `accountBalanceNow`, `cardNewActivity`, `accountNewActivity`, `stalePending`, `overduePendingOut`). Envelope math lives in new pure functions; existing functions are called, never edited. Any behavioral change to a listed function is called out explicitly in the PR description.
- **Never test against production.** `sts2` holds real data. Test by opening `index.html` directly (it falls back to localStorage) and importing the 2026-09-19 backup. A staging environment is a separate subdomain with its own database — not a second door into the same one.
- Merge and deploy handled by the repo's code agent after review.

## 13. Decisions (resolved 2026-09-20 unless noted)

1. ✅ **30 canonical names confirmed** — Christopher's Phase 1 table matches the doc exactly ($6,499.99, 30 rows). One display-label change: `mortgage` → **"KC Mortgage"** (§2). Ids are stable regardless.
2. ✅ **Mortgage = KC property.** The $1,189.29 mortgage belongs to the KC property. It stays a fixed derived envelope on the household side (§5); the rental lane is the rent funding event → tax/maintenance reserves.
3. ✅ **Mobile tab placement confirmed (2026-09-20).** Envelopes in the bottom bar, Accounts behind More (current bar: Home | Ledger | Cards | Accounts | More).
4. ✅ **Rent cadence confirmed** — two parties, each paying twice a month → ~4 deposits/mo of ~$425 (sometimes ~$450 with the Spectrum internet reimbursement). **$100 funded per receipt = $400/mo.** The +$25 top-up is income noise, not a funding event (§4).

---

## Rev 2 changelog (2026-09-20, in response to code-agent review)

1. **One balance invariant** — §1 non-goal + §3.1: no mutable `balances`; `remaining = funded − spent`, fully derived. "Sweep to buffer" is now a logged `reallocate` event (§6), not a mutation.
2. **Envelope epoch / phase transitions** — §3.2: `envelopeEpoch` excludes pre-launch history; `phaseActivatedAt` + phase-stamped funding events make the Phase 1 → 2 toggle history-preserving.
3. **Row identity** — §3.3: `envelopeId` stamped once at creation or remap-apply; spent math never consults the live category map; display names resolve at render.
4. **Spent eligibility** — §9: explicit type allowlist (`card_purchase`, `cash_expense`, `recurring`, `refund`), status allowlist (`Cleared`, `Pending`), half-open cycle bounds, future/planned recurring exclusion; `card_payment`/debt-paydown/`Transfer`/`income`/`planned_spend`/`Void` explicitly out.
5. **Source-based idempotency** — §7: key is `(eventType, sourceId ?? date)`; UI lists fundable sources with funded state; read → check → write against the fresh log.
6. **Deterministic rounding** — §4.1: integer-cents allocation, remainder to ascending-id order, Σ == event total invariant.
7. **Review queue** — §9.1: uncategorized rows counted and bannered; remaining never presented as final while the queue is non-empty.
8. **Engine guardrails** — §12: named function list (headline, projection, and balance paths); §10 adds a `safeToSpend` byte-identical regression test.

## Rev 2.1 changelog (2026-09-20, Christopher's §13 answers + code-agent corrections)

- **A. Paycheck event total corrected: $1,549.19** (was $1,549.18). `round(335657 × 12 / 26) = 154919¢`; Σ per-envelope = 154918¢, 1¢ remainder → first envelope by id order. §4 table, affordability check, and §4.1 invariant example fixed. (My rev-2 arithmetic was off by 1¢ — recomputed from the §2 monthlies this round.)
- **B. Concurrency corrected: optimistic versioning, not last-write-wins.** §7 now specifies the `baseVersion` / 409 flow — `api/data.php` rejects stale writes with 409 and `syncToServer` surfaces the reload banner. Verified against the code.
- **C. Rent funding rewritten: 4 × ~$100** (§4, §13.4). Two parties × twice monthly, ~$425 deposits (~$450 with Spectrum); $100/receipt = $400/mo; source-keyed idempotency is what makes 4 same-month sources safe.
- **D. Fixed-envelope spent clarification** (§9): `kind ≠ "fixed"` guard in the spent predicate; fixed envelopes have no funded/spent/remaining — paid/not-paid derives from the recurring schedule.
- **E. Guardrails + `computeAll`, `countsInWindow`** (§12).
- **Display name: "KC Mortgage"** (§2); mortgage = KC property, household side (§13.2).
- §13.3 (mobile tab placement) confirmed 2026-09-20: Envelopes in the bottom bar, Accounts behind More. All §13 decisions resolved.
