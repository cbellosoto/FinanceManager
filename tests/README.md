# Tests

Browser-driven regression tests for the Safe-to-Spend app (`../index.html`).

The whole app — financial engine and UI — runs in the browser from a single static file. These
tests load that file directly over `file://`, let it boot to its built-in **seed data** (the
`api/*.php` backend is unreachable over `file://`, so `boot()` falls back to the seed and shows the
UI without a Google login), then drive the real dialogs and assert on both the on-screen table and
the in-memory `DB`.

Stack is intentionally minimal: **[Playwright](https://playwright.dev/) + Node's built-in test
runner** (`node:test`). No extra test framework.

## Run them

From the repo root:

```bash
npm install            # installs the one dependency (playwright)
npm run test:install   # one-time: downloads the Chromium build Playwright drives
npm test               # runs the suite
```

`npm test` prints TAP output and exits non-zero if anything fails.

### Notes

- **No server needed.** Tests open `index.html` from disk; the PHP backend and Google Sign-In are
  not involved.
- **Custom Chromium path (CI/sandboxes).** If Playwright's managed browser isn't available, point the
  tests at an existing Chromium with `PW_CHROMIUM`:
  ```bash
  PW_CHROMIUM=/path/to/chrome npm test
  ```
- **Watch a run visually.** Launch headed by editing `chromium.launch(...)` in `app.test.js` to add
  `headless: false`, or add `slowMo: 250` to see each step.

## What's covered (`app.test.js`)

Each test boots a fresh, isolated page reset to the seed, then:

1. **No separate card-payment entry points remain** — the merged-in Pay flow: no `Pay` button on card
   rows, no "Card payment…" quick-add option, `openCardPayment` no longer defined.
2. **Reconcile schedules a payment on the due date and shows it** — a full-statement reconcile resets
   the balance, updates the due date, schedules the cash payment, and shows it under *Scheduled to pay*.
3. **Already paid clears the balance** — a reconcile payment marked *Already paid* (Cleared) zeroes the
   balance and leaves nothing scheduled.
4. **Payment date can differ from the due date** — the pay-ahead case: payment dated before the due date.
5. **Reconciling a debt links the recurring paydown** — a *Debt* card swaps the checking-payment fields
   for the "Paid by recurring" picker, pulls the due date from the recurring bill, removes any stale cash
   payment, keeps the recurring paydown, and shows it as *Scheduled to pay*.
6. **Generate-bills check-all / uncheck-all** — the toggle buttons, the live selected-count, and the
   Add button disabling when nothing is selected.

## Adding a test

Add another `appTest("name", async (page) => { ... })` in `app.test.js`. Inside `page.evaluate(...)`,
reach the app's globals **bare** — `DB`, `STS`, `render()`, `openReconcile()`, `switchTab()` — because
`DB`/`STS` are `let`/`const` bindings and are **not** properties of `window`.
