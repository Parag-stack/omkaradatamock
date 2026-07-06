# Omkara Data Room — Vite + React

A Vite + React port of the single-file **Daily Reading — Omkara Data Room** app.

## Setup

```bash
npm install      # install dependencies (not bundled in this zip)
npm run dev      # start the dev server at http://localhost:5173
npm run build    # production build -> dist/
npm run preview  # preview the production build
```

## How API calls work (proxy)

The app calls **relative** paths and lets Vite's dev-server proxy forward
them to the real upstreams, so the browser only ever makes **same-origin**
requests — no CORS preflight, no `Access-Control-*` requirements.

| App fetches      | Proxied to                          | Host          |
| ---------------- | ----------------------------------- | ------------- |
| `/api/*`         | `https://omkaradata.com/api/*`      | main data hub |
| `/occ-api/*`     | `https://omkaracapital.in/api/*`    | TV bytes      |

Two prefixes are used because both upstreams expose their endpoints under
`/api/...`; `/occ-api` keeps them unambiguous and is rewritten back to
`/api` on the way out (see `vite.config.js`).

### Production

The Vite proxy only runs in `dev`/`preview`. For a deployed build, add the
equivalent rewrite at your host. On **Vercel** (`vercel.json`):

```json
{
  "rewrites": [
    { "source": "/api/:path*",     "destination": "https://omkaradata.com/api/:path*" },
    { "source": "/occ-api/:path*", "destination": "https://omkaracapital.in/api/:path*" }
  ]
}
```

Or front the static build with Cloudflare / nginx doing the same path forwarding.

## Architecture

This is a pragmatic port that preserves the original behaviour 1:1. The
original is an imperative, DOM-owning SPA (~8,300 lines), so React acts as a
thin shell rather than a full component rewrite:

```
index.html          Vite entry — fonts, Chart.js CDN, #root, module script
src/
  main.jsx          Mounts <App/>, imports global styles (no StrictMode — see note)
  App.jsx           Renders the original markup once, then runs initLegacyApp()
  appMarkup.html    The original <body> markup (imported with Vite ?raw)
  legacyApp.js      The original <script>, wrapped in initLegacyApp() and exported
  styles.css        The original <style> block, verbatim
vite.config.js      React plugin + dev proxy
```

**Why a shell and not full components?** The original code owns its DOM
directly (`getElementById`, `insertAdjacentHTML`, manual render functions).
React mounts the markup exactly once via `dangerouslySetInnerHTML` and never
re-renders it, so the imperative layer keeps full control and behaviour is
identical to the original file. `initLegacyApp()` is idempotent, so it runs
its bootstrap (event listeners, modal injection, timers, first fetch) once.

### What changed from the original

1. API endpoint string constants rewritten to relative paths
   (`https://omkaradata.com/api/*` → `/api/*`,
   `https://omkaracapital.in/api/*` → `/occ-api/*`).
2. The `<script>` body wrapped in `initLegacyApp()` and exported.
3. `<style>` and `<body>` markup split into their own files.

Nothing else — the application logic is unchanged.

## Update — watchlist company listing (WatchList_AddCompany, input:4)

The `WatchList_AddCompany` endpoint is now also used in **list mode**
(`input:4`) to load the companies belonging to each watchlist. Previously the
app synced watchlist *names* from the server but read their *companies* only
from localStorage, so a watchlist populated elsewhere showed a stale/short
list (the reported Portfolio bug).

What fires now:

- **On page load / refresh** — after the watchlist names sync, one
  `WatchList_AddCompany` POST (`input:4`) is sent per server-backed watchlist,
  so each shows up in the Network tab. Payload:
  `{"ID":"","WatchListID":<id>,"AccordCode":"","CompanyName":"","status":false,"input":4,"UserID":"2"}`
- **On selecting a watchlist** (Settings -> Watchlists) or **activating its
  chip** (Daily Reading) — its companies are loaded from the server (cached
  per session) and shown.

Server rows map to the app's company shape (`BseCode` -> `BSECode`,
`AccordCode` used as the stable id, server row `ID` kept as the deletable
`watchlistEntryId`) and are **de-duped by AccordCode** (the server can return
the same company twice). Console helper: `window.listWatchlistCompanies(175)`.

### Update — one company call per selection on page load

Earlier the page-load sync fetched companies for *every* watchlist (one
`WatchList_AddCompany` input:4 POST each), so the Network tab showed several
on load. Now page load fetches companies for **only the selected watchlist**
— a single input:4 POST — and every other watchlist loads lazily when it is
selected (Settings list) or its chip is activated (Daily Reading).

The selected watchlist is persisted (`localStorage: omkara.wl.editing`) so a
reload keeps the same selection and the single call targets it. Tradeoff:
unselected watchlists' company counts come from the local cache (or show 0
until first selected after a cache clear), since accurate counts for all
watchlists would require one call per watchlist.

### Feature — Collapsible sidebar (icon rail)

The topbar hamburger (`#sidebarToggle`, left of the search bar) toggles the
sidebar between the full 201px column and a **64px icon rail** by flipping a
`sidebar-collapsed` class on `.app`. Because the shell is a CSS grid
(`grid-template-columns`), the `1fr` main area **reflows to fill** the freed
space automatically — no blank gap, and Daily Reading / Forensic / company views
are untouched, just wider. A `.2s` transition animates the width.

- **Starts collapsed on every load** — the class is set in the markup, so there's
  no expand→collapse flash and no persisted state (per spec).
- **Collapsed** hides the section headings (`.nav-label`), nav labels
  (`.nav-text` spans), the brand wordmark (`.brand-text`, logo mark kept), and
  the profile name/email (`.sidebar-user`, round avatar kept). Icons centre in
  the rail, and the active nav still reads as selected on its icon (highlighted
  tile + accent icon). Each icon exposes its label as a native hover tooltip;
  expanding removes the tooltips (the text is visible again).
- **Expanded** restores the previous layout exactly (icon + label on one line).
- Wiring lives in `wireSidebarToggle()` in `legacyApp.js`; all visuals are CSS
  under `.sidebar-collapsed`. On mobile (≤820px) the sidebar is hidden and the
  grid is single-column for both states.

### Update — sidebar +1px and Daily Reading as the #home page

- The sidebar column width went from `200px` to `201px` in `.app`'s
  `grid-template-columns`. The sidebar, brand/heading, and nav all fill that
  grid column, so they widen by 1px with it; the `1fr` main content absorbs
  the remaining space. (Other `200px`/`1200px` values in the CSS are search
  inputs and company tables — unrelated to the sidebar.)
- The Daily Reading view is now the site's **home page**, reachable as
  `#home`. Clicking the **Daily Reading** nav item or the **branding/logo
  area** both navigate there. `#settings` deep-links to Settings. The view↔hash
  sync uses `history.replaceState` (no scroll jump, no routing loop).

### Fix — blank page on open (#home routing)

The initial hash-routing call ran too early in startup and invoked
`showView()` before the FAB element it touches was created, throwing a
temporal-dead-zone error that aborted the rest of init and left a blank page.
The initial route now runs at the very end of init (after the FAB and views
exist). Opening the app — or `#home` — shows the Daily Reading page as the
home page; `#settings` still deep-links to Settings. No separate landing page.

### Feature — Forensic page

A "Forensic" nav item now sits in the sidebar Quick Links, directly below
Daily Reading. Clicking it opens a Forensic landing (`#forensic`) that prompts
you to pick a company and focuses the top search bar. Selecting a company from
that search opens the existing Company page — with its header section (name,
NSE/BSE badges, sector/industry/ISIN, live-price panel) — directly on the
**Forensic** tab, and the Forensic nav stays highlighted. Navigating to Daily
Reading or Settings disarms the flow, so the normal search still opens
companies on Overview.

### Update — Forensic page is header-only

The Forensic page now shows ONLY the company name section. After picking a
company from the top search in the Forensic flow, the Company view opens with
just its `.co-header` card — name, NSE/BSE badges, sector · industry · ISIN —
with the tab bar and all panes hidden (via a `cv-header-only` class on
`#companyView`) and the `Forensic_DetailedTables` API call skipped. The normal
top-search company page is unchanged: full tab bar, Overview rendering, and the
Forensic tab + API.

On the Forensic page the demo **live-price panel** (`.co-price` — price, change,
52W range, sparkline, and the "Live Price · demo" / "wire live price API" labels)
is **hidden**, and the card collapses to a single full-width column of
company-note info (`#companyView.cv-header-only .co-header { grid-template-columns:
1fr }` + `.co-price { display:none }`). This is CSS-only and scoped to the
forensic (`cv-header-only`) state — the panel stays fully intact on the normal
Company view, and the markup is untouched so a real live-price API can be wired in
later. The card simply gets shorter, so the pill bar and tables below flow up.

### Feature — Forensic card enriched from companynote

On the Forensic page, selecting a company now calls `companynote`
(`POST /api/companynote { CompanyID }`, mapped from the search result's
`CompanyID`) and enriches the header card once it returns:

- **Company name** ← `companynote.CompanyName`
- **NSE / BSE chips** ← `companynote.NSEcode` / `BSEcode`, each a clickable
  deep-link (`NSELink` / `BSELink`) that opens the exchange page in a **new
  tab**. No link → plain chip. Existing chip colours are unchanged.
- **Sector · Industry · ISIN** ← from the search API (`SymbolMaster_WithCode`).
- The **description line is removed** on the Forensic card; the demo
  live-price panel is kept as-is.

The card renders instantly from the search result and is enriched when the
note lands (one call per selection, guarded by `CompanyID` against stale
responses). The normal top-search company page is unaffected — no companynote
call, plain (non-link) chips.

### Update — company website link on the Forensic card

The Forensic header meta line now leads with the company website, taken from
`companynote.WebSiteLink`. It renders as a globe icon + the address (e.g.
`www.sansera.in`) as the FIRST item, before Sector, in one line with
Sector · Industry · ISIN (dot-separated, wraps only if needed). It's a native
`<a target="_blank" rel="noopener noreferrer">` so it opens the company site
in a new tab. When `WebSiteLink` is absent the icon and link are omitted
entirely. Website link appears on the Forensic card only (companynote isn't
called on the normal company page).

### Feature — Forensic page "Analysis" tab (Forensic_DetailedTables)

Below the company header card on the Forensic page there's now a tab bar:
`Analysis | Ratios | Capital Structure | Directors and Auditor | Capital
History | Dividend History | ESOP`. Analysis (formerly "Single Page") is active;
the other six are greyed-out/disabled placeholders.

The Analysis tab integrates `Forensic_DetailedTables` (`POST` with
`{ CompanyId, type }`, CompanyId mapped from the search result's `CompanyID`):
- A **Consolidated / Standalone** toggle. Opening the tab loads `con` by
  default; `std` loads only when clicked. Each mode is cached, so toggling is
  instant after the first fetch (one request per type), with an in-flight
  abort + stale-response guard on company switch.
- **Auto-fallback to Standalone.** When a company has no consolidated data,
  the tab automatically loads and shows `std` instead, with the Standalone
  pill active and the Consolidated pill greyed out (disabled). "No consolidated"
  is detected whether the `con` request comes back successful-but-empty
  (`button_status.con === false` or an empty `Data`) or fails outright — either
  way it fetches `{ CompanyId, type: 'std' }` once and keeps Consolidated greyed.
- All **10 tables stacked** one below the other, reusing the existing table
  renderers (Snapshot/Averages KPI grids; the 8 time-series tables with their
  green/red CAGR cells).
- A **sticky jump-pill bar at the very top of the page — above the green/red
  flag cards.** Pills: `Summary · Average · Earning Quality · Fund Flow · Working
  Capital Analysis · Asset efficiency · Capital Structure · Expenses Analysis ·
  Du Pont Analysis · ShareHolding Pattern (In%)`. The **Summary** pill scrolls
  down to the flag cards; every other pill smooth-scrolls to its table. The bar
  stays pinned under the topbar while scrolling. Pill labels are the same source
  as each section's header (`displayForensicTabName`), so a pill and its heading
  always read identically.
- `button_status` drives whether each mode pill is available.

Scope: Forensic page only. The normal company page's Forensic tab is unchanged
(`#forensicPage` is hidden there).

### Feature — Peer comparison ("+ Compare")

Five forensic tables — **Earning Quality, Fund Flow, Working capital analysis,
Asset efficiency, and Expense Analysis** — each gain a **+ Compare** button on
their header to compare the current company against up to **2 peer companies**
(3 total). Capital structure, Du Pont, and ShareHolding are excluded (no
3/5/10yr summary columns to compare).

- Adding a peer switches that table into **compare mode**: the per-period
  history columns are hidden and the table shows only the **cumulative 3yr / 5yr
  / 10yr** block, repeated once per company and **grouped by company** (all rows
  shown). Each company group header carries the table's summary-type tag —
  **CAGR** (Earning Quality), **Cumulative** (Fund Flow), **Averages** (Working
  capital), **Cumulative/Average** (Asset efficiency, Expense Analysis). Removing
  every peer restores the full-history view.
- Tint follows each table's own rendering: Earning Quality colours cells by sign
  (its feed doesn't tint), the others keep their API-flagged green/red — i.e.
  each company's own signal.
- The picker is a company **search popover** on the table header, backed by the
  same `SymbolMaster_WithCode` endpoint as the global search (debounced, the
  current company and already-added peers filtered out). It is fully
  **keyboard-navigable**: ↑/↓ move the highlight, Enter adds the highlighted
  company (or the first result if none is highlighted), Esc closes it; mouse
  hover keeps the highlight in sync.
- **Peer selection is independent per table** (`fp.compare[key]`), but peer
  **data is shared**: a peer's full `Forensic_DetailedTables` payload is fetched
  once per company (**Consolidated with Standalone fallback**) into
  `fp.peerCache`, then each table extracts its own cumulative rows. Adding the
  same peer to several tables does **not** refetch. Each peer column shows a
  loading shimmer until data arrives, or a quiet "—" if that company lacks the
  table.
- The **AI Summary button is hidden while comparing** and returns when peers are
  cleared.
- Performance: compare changes **re-render only the touched section** — never the
  other tables, the flag cards, or the Consolidated/Standalone state. Searches
  are debounced with in-flight aborts, and typing updates only the results menu
  (the input keeps focus).

Implementation lives in `legacyApp.js`: a registry flag (`compare: true` on the
relevant `FP_SUMMARY_SECTIONS` entries) drives one keyed code path —
`compareSectionInnerHtml`, `renderCompareTable`, `extractCumulative`, the `cmp*`
picker helpers, `fetchPeerData` (shared cache), and `peerExtractFor`. `fp.compare`
holds per-table picker + peer state; `fp.peerCache` holds the shared per-company
payload cache.

### Polish — Single Page presentation redesign

The Single Page tables were rendering unstyled because the forensic table CSS
was scoped to the old `.cv-forensic` container; the new `#forensicPage` didn't
carry it. Fixed by scoping that proven styling into the page (the tables wrap
renders inside a `.fp-tables.cv-forensic` context), then layering:
- **Snapshot** → grouped metric cards (one card per API group, label → value
  rows; responsive grid).
- **Every table in its own white card** (border, rounded, padding, title).
- **Time-series tables** keep the pinned metric column + horizontal scroll,
  green/red CAGR tints, and metric tooltips; the (unneeded) vertical sticky
  header is dropped so it can't hide behind the topbar/chips.
- **Consolidated / Standalone** toggle restyled to a **white active pill** on a
  light track (was black).

No renderer rewrite and no extra API calls — pure CSS + a wrapper class, so
con/std stay cached and switching is still instant.

### Fixes — Single Page polish round 2

- Tab bar: removed the unused right-hand scroll affordance (tabs wrap instead).
- All tables: negative values now render in brackets, e.g. `(-45.90)` /
  `(-364.64)` (positives unchanged).
- Time-series summary-column group header is renamed per table: Fund Flow →
  "Cumulative", Working capital analysis → "Averages", Asset efficiency &
  Expense Analysis → "Cumulative/Average" (others keep "CAGR").
- Fixed the hidden first row + blank strip on the single-row-header tables
  (Capital structure, Du Pont, ShareHolding Pattern): the shared sticky-header
  offset (meant for two-row CAGR headers) was pushing single-row headers down
  30px. Headers are now static on the Single Page (tables are short and fully
  visible), and tables fit the card width with no horizontal scrollbar.
- Averages → Shareholding card heading now shows the latest filing period
  (e.g. "Shareholding (%) Mar-2026", the date in grey), sourced from the Single
  Page dataset.

### Fixes — Single Page polish round 3

- Fund Flow & Expense Analysis: removed the blanket green flood on the summary
  (3/5/10yr) columns. Cells are neutral/black by default; only the API-flagged
  cells (the condition rows — Cash from ops, CFO/EBITDA, FCF; and Income tax
  paid/expense) show green/red on number + background.
- Info ("i") tooltips now pop ABOVE the icon on the Single Page, so they no
  longer overflow the card bottom or force a scrollbar.
- Summary sub-column headers normalized to "3yrs / 5yrs / 10yrs" (fixes the
  "3Yrs" casing in Expense Analysis) across the CAGR / Cumulative / Average
  groups.
- ShareHolding Pattern: added a Quarterly / Yearly toggle (Quarterly default).
  Yearly filters to the March (…03) year-end columns only. Applies only to this
  table.

### Fixes — Single Page polish round 4

- Summary sub-column headers (3yrs / 5yrs / 10yrs) now render lowercase across
  all tables (the earlier rule lost a specificity tie to the shared uppercase
  header style; forced with !important). Group labels stay as-is.
- Negative values in the summary (3/5/10yr) columns show in red across the
  condition-coloured tables (Fund Flow, Expense Analysis, Asset efficiency).
  Rows carrying an "i"/API condition keep their API green/red instead.
- Asset efficiency joined the condition-coloured set: only Capex/EBIDTA(%)
  (the "i" row) keeps its colour; the other summary cells go neutral black.
- ShareHolding Pattern: the Quarterly / Yearly toggle now sits on the heading
  line, right-aligned.

### Fix — Working capital analysis 10yr neutral

- Working capital analysis joined the condition-coloured set. Its summary
  columns are no longer blanket-green: only the API-flagged cells carry colour.
  Since the API only flags the 3yr and 5yr averages (compared against the 10yr
  long-term baseline), the 10yrs column now renders neutral while 3yrs / 5yrs
  keep their green/red.

## Forensic Single Page — Earning Quality AI summary

A "Generate AI Summary" button sits on the right of the **Earning Quality**
section header (Forensic > Single Page). Clicking it produces a 2-3 line
forensic summary (revenue trend, margin cascade, core-vs-non-core earnings,
red flags) rendered directly below the header, above the table.

**How it reaches Claude (key stays server-side).** The browser never holds the
Anthropic key. It POSTs the already-loaded table (no extra data fetch) to
`/api/forensic-summary`:

```
POST /api/forensic-summary
{ company, mode: "con"|"std", tab, tableText }  ->  { summary, model }
```

- **Production:** the serverless function `api/forensic-summary.js` (standard
  Node/Vercel handler) reads `ANTHROPIC_API_KEY` and calls the Messages API.
  On Vercel this function is matched before the `/api/:path*` data rewrite, so
  the AI path resolves to the function while every other `/api/*` still proxies
  to omkaradata.com. If you host elsewhere, implement the same request/response
  contract at this path (the client and dev server are unchanged).
- **Development:** `vite.config.js` registers a dev-only middleware that serves
  the same path locally using the shared logic, so `npm run dev` works without
  a separate backend.
- Prompt + Anthropic call live in one place: `api/_forensicSummary.js`
  (imported by both the function and the dev shim).

**Setup.** Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` for local
dev; set the same variable in your host's environment for production. Optional
`FORENSIC_SUMMARY_MODEL` overrides the default fast model.

**Caching.** A generated summary is cached per company + statement mode
(con/std) in memory, so switching Consolidated <-> Standalone or re-opening is
instant and never re-bills. "Regenerate" forces a fresh call. State lives in
`state.company.fp.summaries` and resets when a new company is selected.

**Note:** `.env` is gitignored — never commit the key.


**Per-section AI summaries:** the Earning Quality, Fund Flow, Working capital, Asset efficiency, Capital structure, Expense Analysis, Du Pont Analysis, and ShareHolding Pattern sections each have their own "Generate AI Summary" button. All share the `/api/forensic-summary` endpoint; the server picks the matching prompt (`EARNING_QUALITY_PROMPT` / `FUND_FLOW_PROMPT` / `WORKING_CAPITAL_PROMPT` / `ASSET_EFFICIENCY_PROMPT` / `CAPITAL_STRUCTURE_PROMPT` / `EXPENSE_ANALYSIS_PROMPT` / `DU_PONT_PROMPT` / `SHAREHOLDING_PROMPT`) from the request `tab`. The ShareHolding button sits next to its Quarterly/Yearly toggle, and its summary reflects the selected view (Yearly sends only the March year-end columns); switching the toggle clears the summary so it regenerates for the new view. Each works for Consolidated and Standalone, is cached per company + mode + section, and is fully independent. Sections are registered in `FP_SUMMARY_SECTIONS` (client) and the section button is resolved from that registry — adding another is one registry entry plus its server prompt.

## Forensic — remember the last selected company

Opening the Forensic module restores the **last company you viewed there**
instead of the empty "Select a company" landing.

- The picked company (the search result row) is saved to `localStorage` under
  `omkara.forensic.lastCompany` whenever you open a company in Forensic.
- Entering Forensic (nav click, hash change, or a reload at `#forensic`)
  restores it: if that company is still loaded in memory it's revealed
  instantly with no refetch; otherwise it does one fresh Consolidated load.
- First-time users (no history) and any stale/unresolvable saved entry fall
  back to the "Select a company" landing.
- Always restores in Consolidated mode. Persistence is per browser (no backend).

## Forensic — Green / Red flag cards (above Snapshot)

Two rounded cards (Green Flags, Red Flags) sit at the top of the Forensic Single
Page, above the (hidden) Snapshot section. They are **computed deterministically
in the client** from the Fund Flow table when the page opens — no AI, no network
call, so they are always correct and instant. Cached per company + mode.

Scope (config: `FORENSIC_FLAG_METRICS` in `src/legacyApp.js`) — each metric
names its source table: Fund Flow → **Cash From Operations(pre tax)** & **Free
Cash Flow** (>0 green / <0 red) and **Pre tax CFO / EBITDA(%)** (>80% green /
<80% red); Asset efficiency → **Capex / EBIDTA(%)** (>0 green / <0 red); Expense analysis →
**Income tax paid / Income Tax Expenses** (a *band* rule: within −15%…+15% green,
outside red; a literal 0% counts as green); Working capital → **Net Working
Capital as % of sales**, **Debtors % of Sales**, **Inventory % Sales** (the 3yr &
5yr averages vs the 10yr benchmark: below 10yr green, at/above red; the 10yr is
the reference, cited in every statement); ShareHolding Pattern → **Pledged
Shares(%)**, which has no 3/5/10yr summary columns, so it uses a `latestZero`
rule instead — the **latest populated period** is read (e.g. `202603`): 0% →
green ("indicates no promoter leverage"), > 0% → red ("indicates funding risk and
potential forced selling risk"), citing that period (e.g. `60.7% (202603)`); a
blank latest period falls back to the most recent populated one. A metric uses a
`threshold`, a `band`, `vsLongTerm`, or `latestZero` (config decides). Each period is bucketed against the metric's threshold: periods above
form its green flag, below form its red flag, so a **mixed metric appears in
both cards** (e.g. FCF +6.94 (5yr) green; -14.20 (3yr), -23.86 (10yr) red). A
0%/blank period is treated as a data-gap and ignored. Add metrics by appending
to `FORENSIC_FLAG_METRICS` (name match, threshold, green/red phrases).

Note: the earlier AI endpoint (`/api/forensic-flags`, `api/_forensicFlags.js`,
dev shim) is left in place but is now dormant — the flags no longer call it.

