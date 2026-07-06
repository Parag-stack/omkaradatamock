/* =====================================================================
   Omkara Data Room — legacy application logic.

   This is a faithful, line-for-line port of the original single-file
   app's <script> block. The only changes from the original are:
     1. API endpoint constants rewritten to RELATIVE paths so Vite's
        dev-server proxy (see vite.config.js) forwards them and the
        browser makes same-origin requests (no CORS preflight needed):
          https://omkaradata.com/api/*     ->  /api/*
          https://omkaracapital.in/api/*   ->  /occ-api/*
     2. The whole body is wrapped in initLegacyApp() and exported, so
        React can invoke it exactly once after the markup is in the DOM.

   The code remains imperative and owns its own DOM (querySelector /
   getElementById / insertAdjacentHTML). React mounts the static markup
   once and never re-renders it, so the two never fight over the DOM.
   ===================================================================== */

let __omkaraInitialized = false;

export function initLegacyApp() {
  // Guard against React StrictMode / double-invocation: the imperative
  // bootstrap (event listeners, modal injection, timers) must run once.
  if (__omkaraInitialized) return;
  __omkaraInitialized = true;

/* ============================ CORP ANNOUNCEMENT — PROXY CONFIG ============================
   Live data is fetched through your proxy at PROXY_URL. The proxy receives a JSON POST body
   with { pageNumber, perPageCount, qsTime } and returns the Trendlyne response unchanged.

   Note: PROXY_URL is on a different origin than this page, so the proxy MUST return CORS
   headers for the browser to accept the response:
       Access-Control-Allow-Origin:  *      (or the specific site origin)
       Access-Control-Allow-Methods: POST
       Access-Control-Allow-Headers: Content-Type
   And it must respond to the browser's OPTIONS preflight with 204 No Content.

   DEMO_MODE: set true only for local UI preview without a backend.
   =========================================================================================== */
const DEMO_MODE = false;
const PROXY_URL = '/api/trendlyne-proxy';
const PER_PAGE   = 2000;    // single bulk fetch — store everything in memory
const CHUNK_SIZE = 100;     // render the latest 100 first, then Load more in 100s

// Reports / Repository — four direct endpoints on omkaradata.com.
// The repository list is POST + JSON body; the three masters are GET, cached for the session.
const REPO_URL    = '/api/RepositoryListTesting';
const SECTOR_URL  = '/api/sectormaster';
const SYMBOL_URL  = '/api/SymbolMaster';
const BROKER_URL  = '/api/brokermaster';
// Forensic — per-company financial integrity tables (used by the Company
// page's Forensic tab). POST + JSON body { CompanyId, type }, where type
// is 'con' (Consolidated) or 'std' (Standalone). Returns a Data array
// of 10 themed tabs (Snapshot, Averages, Earnings quality, Fund Flow,
// Working capital analysis, Asset efficiency, Capital structure,
// Expense Analysis, Du Pont Analysis, ShareHolding Pattern).
const FORENSIC_URL = '/api/Forensic_DetailedTables';
// Company Note — the Forensic page header card is enriched from this.
// POST + JSON body { CompanyID }. Response Data[0] carries the canonical
// CompanyName, NSEcode/BSEcode and the exchange deep-links (NSELink/BSELink).
const COMPANYNOTE_URL = '/api/companynote';
// Forensic AI summary — server-side endpoint that turns the Earning Quality
// table into a 2-3 line forensic summary. POST { company, mode, tab, tableText }
// -> { summary, model }. The Anthropic key lives only on the server (the dev
// shim in vite.config.js handles this path locally; in prod it is the
// serverless function api/forensic-summary.js). NOT proxied to omkaradata.com.
const FORENSIC_SUMMARY_URL = '/api/forensic-summary';
// Forensic green/red flag cards — server-side endpoint that turns the
// Fund Flow table into structured flags. POST { company, mode, tab,
// tableText } -> { flags:[{ metric, type:'green'|'red', statement }] }.
// Auto-loaded above the Snapshot table, cached per company + mode.
const FORENSIC_FLAGS_URL = '/api/forensic-flags';
// Watchlist persistence — server-backed CRUD for named watchlists.
// POST + JSON body { ID, UserID, WatchListNAme, status, input }. When
// ID is empty the server creates a new watchlist and returns it in the
// Data array; when ID is populated the same endpoint updates the name.
// Response Data is the full per-user watchlist list, each entry with
// { ID, UserID, WatchListNAme, isCompany }. Note the unusual
// WatchListNAme casing — that's the server-side field name, kept
// verbatim so the payload matches the API contract.
const WATCHLIST_ADD_URL = '/api/Watch_list_Add';
// Sibling endpoint that links a company into a specific watchlist.
// Payload contract (verified against the user's example):
//   { ID:"", WatchListID:<num>, AccordCode:<num>, CompanyName:<str>,
//     status:false, input:1, UserID:<num> }
// The server responds with { Data: [ <new-entry> ] } where each
// entry carries an `ID` field (the new server-side primary key for
// the watchlist↔company association — useful for a future delete).
// Note UserID is a NUMBER here, unlike the watchlist endpoint where
// it's a string — the integration code respects this difference.
const WATCHLIST_ADD_COMPANY_URL = '/api/WatchList_AddCompany';
// UserID is the authenticated user's identifier. Hardcoded to "2"
// today (demo / single-user backend); when real auth is wired this
// should read from the session/profile store. Keeping it in one
// constant so the swap is a single-line change.
const WL_USER_ID = '2';
const REP_PER_PAGE = 500;       // batch size per fetch; one fetch is usually enough
const REP_MAX_PAGES = 50;       // safety cap when auto-paginating — 50×500 = 25,000 items, headroom for a 12-month window (~19k reports observed live). Bumped from 10 (which produced a hard 5k visible-data cap) once client-side rendering became page-size-bounded.
const REP_PARALLEL_WORKERS = 6; // pages 2..N are fetched in parallel with this concurrency cap. 6 is the sweet spot empirically: cuts a 38-page sequential walk (~38s at 1s/page) to ~7s, without overwhelming the proxy or hitting browser per-host connection limits.
const REP_AUTO_REFRESH_MS = 5 * 60 * 1000;

const DEMO_PAGES = [];

/* ============================ DATA SOURCES ============================
   No sample data. Populate these from your API/backend.

   COMPANIES — keyed by ticker. `c` is the avatar/marker colour.
       TICKER: { n:'Company Name', s:'Sector', c:'#2C7A7B' }

   WATCHLISTS — `companies` is an array of tickers from COMPANIES.
       { id:'banking', name:'Banking', companies:['HDFC', ...] }

   DATA — one array per tab. `t` (ticker) links each item to COMPANIES.
   Expected shapes:
       announcements: { t, kind, cls, title, when }
                      cls ∈ '', 'buy', 'green', 'amber', 'accent', 'red'
       reports:       { t, kind, analyst, rating, rc, when }
                      rc  ∈ '', 'buy', 'amber', 'green', 'red'
       tvbytes:       { t, chan, title, dur, when }
       news:          { t, src, sent, head, when }
                      sent ∈ 'pos' | 'neg' | 'neu'
   ===================================================================== */
const COMPANIES = {
  // e.g. TICKER: { n:'Company Name', s:'Sector', c:'#2C7A7B' },
};

// User-managed watchlists. Seeded with the default groups; mutations
// (rename / delete / add company / remove company / create) flow through
// the writeWatchlists() persistence hook below, so changes survive a
// reload until a real backend is wired.
//
// Company entry shape (current):
//   { CompanyID, CompanyName, NSESymbol, BSECode }
// Backward-compat: pre-migration entries that are plain strings (legacy
// ticker codes) are still understood by annScope() / scopeTickers().
// The Default watchlist is a CLIENT-SIDE pinned sentinel. It is NEVER
// sent to the Watch_list_Add API, never renamed, never deleted, and
// always sits at index 0. It represents the "all companies / no
// filter" scope for the Corp Announcement view on Daily Reading.
// `isSystem: true` is the marker the create/rename/delete code uses
// to short-circuit any server side-effects.
const DEFAULT_WL_ID = 'default';
function makeDefaultWatchlist() {
  return {
    id: DEFAULT_WL_ID,
    name: 'Default',
    color: '#0F172A',
    companies: [],
    serverId: null,
    isSystem: true,
  };
}

// All non-Default watchlists are loaded from the server on page load
// (and any subsequent create/rename refreshes the list from the API
// response's Data array). We start with just Default so first paint
// is instant; the server sync runs immediately after and fills the
// rest in. No seeded Portfolio/Banking/IT/FMCG/Pharma anymore — those
// were a pre-API placeholder and are no longer carried by the
// localStorage fallback either.
let WATCHLISTS = [makeDefaultWatchlist()];

// Color pool for newly-created watchlists. Picks the first colour not
// already in use; falls back to round-robin if every colour is taken.
const WL_COLOR_POOL = ['#0F172A', '#334155', '#2563EB', '#7C3AED', '#059669', '#DB2777', '#EA580C', '#0891B2', '#65A30D', '#9333EA', '#0D9488', '#BE185D'];

const DATA = {
  announcements: [],
  reports: [],
  tvbytes: [],
  news: [],
};

/* ============================ STATE ============================ */
const state = {
  view: 'daily',                    // active top-level view: daily | settings | company | forensic
  forensicMode: false,              // armed by the Forensic nav: next company pick opens its Forensic tab
  selected: new Set(['default']),   // multi-select set of watchlist ids
  tab: 'announcements',
  ann: {                            // Corp Announcement (live API) state
    items: [],                      // ALL fetched announcements (sorted newest-first)
    visible: CHUNK_SIZE,            // how many of the filtered list to render right now
    qsTime: null,
    loaded: false,                  // bulk fetch has completed at least once
    loading: false,
    error: null,
    query: '',                      // current search string (lowercased, trimmed)
    dateFrom: '',                   // 'YYYY-MM-DD' lower bound on pubDate (inclusive). '' = no lower bound.
    dateTo:   '',                   // 'YYYY-MM-DD' upper bound on pubDate (inclusive, treated as end-of-day). '' = no upper bound.
    categories: new Set(['all']),  // MULTI-SELECT set of category pill ids; 'all' is mutually exclusive with specific ids. Default = 'all' so every watchlist opens showing the full feed; user narrows from there.
    cache: { sig: null, items: null }, // memoized filter result
    catCountsCache: null,           // memoized per-category counts
  },
  reports: {                        // Daily Reading > Reports tab state
    filters: {
      dateFrom: '',                 // YYYY-MM-DD (defaults to yesterday→today on init)
      dateTo: '',
      period: 'yesterday',          // quick-preset id: 'yesterday' | '1w' | '1m' | '2m' | '3m' | '6m' | '12m' | 'custom'. Drives dateFrom/dateTo via REP_PERIODS.
      // Multi-select arrays. Empty array means "all" (no filter on that axis).
      sectorIds: [],                // array of sectorID strings
      companyIds: [],               // array of CompanyID strings
      brokerIds: [],                // array of broker ID strings
      query: '',                    // free-text passed to server `search` field
      sortColumn: 'Date',           // 'Date' | 'CompanyName' | 'BrokerName' | 'SectorName'
      sortOrder: 'desc',            // 'asc' | 'desc'
      typeFilter: new Set(),        // CLIENT-side filter on ReportType pills
    },
    // Pending filter values being collected in the UI before the user hits Apply.
    // The five "main" filters (dates + sector/company/broker arrays) and the search
    // string all live here until applied. typeFilter and sort are immediate.
    pendingFilters: {
      dateFrom: '', dateTo: '',
      period: 'yesterday',
      sectorIds: [], companyIds: [], brokerIds: [],
      query: '',
    },
    page: 1,
    pageSize: 50,                   // VIEW-only — how many filtered rows to render at once (default 50). Not a server pagination cursor; the cached set holds the full data and pageSize just slices the rendered slab. -1 sentinel means "All".
    items: [],                      // accumulated across pages (filters reset to []]
    totalRows: 0,
    loaded: false,                  // first fetch has completed
    loading: false,
    error: null,
    lastRefreshedAt: null,
    // Date-range cache. Key = 'YYYY-MM-DD|YYYY-MM-DD'. Value = { items, totalRows, fetchedAt }.
    // The fetch loop now requests the FULL unfiltered set for a given date
    // window; all narrowing (sector / company / broker / keyword search /
    // report-type pill) runs client-side against the cached items. Result:
    // changing any narrowing filter is a re-render (sub-ms) instead of a
    // re-fetch. Switching to a previously-loaded period is also instant.
    // Manual refresh and the auto-refresh timer both bypass the cache via
    // force:true and overwrite the entry on success.
    cache: new Map(),
    // Soft cap — keep the most-recently-touched N entries, drop the oldest
    // by fetchedAt. 6 entries × ~10k items × ~1KB ≈ tens of MB worst case,
    // comfortable for an internal research tool.
    cacheMax: 6,
  },
  masters: {                        // Cached master data (one fetch per session)
    sectors: { byId: {}, list: [], loaded: false, loading: false },
    symbols: { byId: {}, list: [], loaded: false, loading: false },
    brokers: { byId: {}, list: [], loaded: false, loading: false },
    error: null,
  },
  tv: {                             // Mgmt TV Bytes (live API) state
    items: [],                      // per-company entries parsed out of addon HTML blobs
    availableDates: [],             // [{date:'YYYY-MM-DD', id}] from BlogAddonTot_date_new
    loadedAddonIds: new Set(),      // addon ids we've already parsed (don't re-fetch)
    rawShape: null,                 // top-level keys of last API response (debug aid)
    loaded: false,
    loading: false,
    error: null,
    query: '',
    sector: new Set(['all']),       // MULTI-select industry/sector pill set; 'all' = wildcard
    dateFrom: '',                   // YYYY-MM-DD inclusive lower bound (empty = no lower bound)
    dateTo: '',                     // YYYY-MM-DD inclusive upper bound (empty = no upper bound)
    visible: 100,                   // pagination cap on rendered cards
    expanded: new Set(),            // entry ids with bullet list expanded
    cache: { sig: null, items: null },
    lastRefreshedAt: null,
  },
};

/* ============================ HELPERS ============================ */
const $ = s => document.querySelector(s);
const wlById = id => WATCHLISTS.find(w => w.id === id);

function scopeTickers() {
  const set = new Set();
  state.selected.forEach(id => {
    const w = wlById(id);
    if (!w) return;
    w.companies.forEach(c => {
      if (typeof c === 'string') { if (c) set.add(c); return; }
      if (!c) return;
      if (c.NSESymbol) set.add(String(c.NSESymbol));
      if (c.BSECode)   set.add(String(c.BSECode));
    });
  });
  return set;
}

function filteredItems(tab) {
  if (tab === 'announcements') return annFiltered();
  if (state.selected.size === 0) return [];
  const scope = scopeTickers();
  if (scope.size === 0) return [];
  return DATA[tab].filter(it => scope.has(it.t));
}

/* ============================ RENDER: WATCHLIST CHIPS ============================ */
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n>>16)&255}, ${(n>>8)&255}, ${n&255}, ${a})`;
}
function renderChips() {
  const wrap = $('#wlChips');
  wrap.innerHTML = '';
  const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  WATCHLISTS.forEach(w => {
    const on = state.selected.has(w.id);
    const chip = document.createElement('button');
    chip.className = 'wl-chip' + (on ? ' active' : '');
    if (w.color) {
      chip.style.setProperty('--c', w.color);
      chip.style.setProperty('--c-soft', rgba(w.color, 0.07));
      chip.style.setProperty('--c-tint', rgba(w.color, 0.15));
    }
    chip.innerHTML = `<span class="cbox">${check}</span><span class="name">${escapeHtml(w.name)}</span><span class="cnt num">${w.companies.length}</span>`;
    chip.onclick = () => toggleWl(w.id);
    wrap.appendChild(chip);
  });
  const more = document.createElement('button');
  more.className = 'wl-chip wl-chip-more';
  more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>More';
  // Routes to Settings > Watchlists where the user can create, rename,
  // delete watchlists and manage their companies.
  more.onclick = () => {
    if (typeof showView === 'function') showView('settings');
    if (typeof setSettingsTab === 'function') setSettingsTab('watchlists');
  };
  wrap.appendChild(more);
}

function renderActiveBadge() {
  $('#wlActiveCount').textContent = state.selected.size;
}

/* ============================ RENDER: TAB COUNTS ============================ */
function renderTabCounts() {
  document.querySelectorAll('#tabs .tab').forEach(btn => {
    const tab = btn.dataset.tab;
    let n;
    if (tab === 'announcements') n = annFiltered().length;
    else if (tab === 'reports')   n = state.reports.totalRows || 0;
    else if (tab === 'tvbytes')   n = state.tv.loaded ? tvFiltered().length : 0;
    else                          n = filteredItems(tab).length;
    btn.querySelector('.tcnt').textContent = n.toLocaleString('en-IN');
  });
}

/* ============================ RENDER: PANEL ============================ */
function mark(t) {
  return `<div class="tk-mark" style="background:${COMPANIES[t].c}">${t.slice(0,3)}</div>`;
}
function docIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>';
}
function emptyState() {
  return `<div class="card empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z"/><path d="M12 8v4l3 2"/></svg><div class="et">Awaiting data</div><div class="es">Items for this tab will appear here once the data source is connected.</div></div>`;
}
function noSelectionState() {
  return `<div class="card empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg><div class="et">No watchlist selected</div><div class="es">Choose at least one watchlist above, or tap “Reset to Default”.</div></div>`;
}

function renderPanel() {
  const panel = $('#panel');
  const tab = state.tab;
  if (state.selected.size === 0) { panel.innerHTML = noSelectionState(); return; }
  if (tab === 'announcements') { renderAnnouncementsPanel(); return; }
  if (tab === 'reports')       { renderReportsPanel();       return; }
  if (tab === 'tvbytes')       { renderTvBytesPanel();       return; }

  // Fallback (no other tabs currently rely on this path)
  const items = filteredItems(tab);
  if (!items.length) { panel.innerHTML = emptyState(); return; }
  panel.innerHTML = '<div class="panel">' + emptyState() + '</div>';
}

/* ============================ CORP ANNOUNCEMENT (LIVE API) ============================ */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function safeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

// Category pills shown below the search bar.
//   matchPostType — exact (case-insensitive, trimmed) postType strings that map into this pill.
//   matchTitle    — substrings searched inside the title AND description; ONLY consulted
//                   when postType is "Company Update", per spec. First match in array order wins.
//   color         — hex used for the pill in its active state AND the cat-badge on cards in this category.
//                   Each category gets a distinct hue so multi-select stays visually decodable.
// Array order = pill display order = category-match priority for Company Update titles.
const ANN_CATEGORIES = [
  { id: 'all',             label: 'All',                     color: '#0F172A', matchPostType: null,                                                                  matchTitle: null },
  { id: 'bm-results',      label: 'Board Meeting / Results', color: '#2563EB',
    matchPostType: ['board meeting', 'results', 'result'],
    matchTitle:    ['earning release', 'earnings release', 'board meeting', 'audited financial results'] },
  { id: 'inv-pres',        label: 'Investor Presentation',   color: '#7C3AED', matchPostType: ['investor presentation'],                                              matchTitle: null },
  { id: 'earn-call',       label: 'Trendlyne Earnings Call', color: '#DC2626', matchPostType: ['trendlyne earnings call', 'trendlyne earning call'],                  matchTitle: null },
  { id: 'concall',         label: 'Concall Transcript',      color: '#DB2777', matchPostType: ['concall transcript', 'earnings call'],                                matchTitle: null },
  { id: 'agm',             label: 'AGM',                     color: '#059669', matchPostType: ['agm'],                                                                matchTitle: null },
  { id: 'corp-action',     label: 'Corp Action',             color: '#92400E', matchPostType: ['corp action', 'corp. action'],                                                        matchTitle: null },
  { id: 'analyst-meet',    label: 'Analyst / Investor Meet', color: '#0891B2', matchPostType: null,
    matchTitle: ['analyst(s)/investor(s) meet', 'analyst(s) / investor(s) meet',
                 'analyst / investor meet', 'analyst/investor meet',
                 'analysts / investors meet', 'analysts/investors meet',
                 // Bare "X meet" — works as a substring tester for ALL the
                 // user-listed variants because of how the slashed forms
                 // shake out: "investor/analyst meet" → 'analyst meet'
                 // matches the tail; "investors/analyst meets" → same; bare
                 // "Analyst Meets" → 'analyst meet' matches as prefix. Same
                 // logic for the investor-first variants via 'investor meet'.
                 'investor meet', 'analyst meet'] },
  { id: 'change-auditor',  label: 'Change in Auditor',       color: '#475569', matchPostType: null,
    matchTitle: ['appointment of internal auditor', 'appointment of interna auditor',
                 "auditors' intimation", 'auditors intimation'] },
  { id: 'moa',             label: 'MOA',                     color: '#4F46E5', matchPostType: null, searchInDesc: true,
    matchTitle: ['memorandum of understanding /agreements', 'memorandum of understanding',
                 'memorandum of agreement', 'moa', 'agreements', 'agreement'] },
  { id: 'fund-raising',    label: 'Fund Raising',            color: '#CA8A04', matchPostType: null, searchInDesc: true,
    matchTitle: ['qualified institutional placement', 'qip',
                 'fully convertible warrants', 'convertible warrants', 'warrant',
                 'preferential issue', 'preferential allotment',
                 'further public offer', 'fpo',
                 'rights issue', 'right issue',
                 // Board Meeting Intimations for fund raising (per spec)
                 'borrowing/raising funds', 'raising of funds', 'raising of fund',
                 // Corp. Note NCD compliance intimations (per spec)
                 'compliances-reg. 57 (1)', 'ncd'] },
  { id: 'change-mgmt',     label: 'Change in Mgmt',          color: '#9333EA', matchPostType: null,
    matchTitle: ['reconstitution of nomination and remuneration committee',
                 'change in directorate', 'change in management',
                 'disclosure under regulation 30 of the securities and exchange board of india',
                 'disclosure under regulation 30 of the sebi'] },
  { id: 'cocp',            label: 'COCP',                    color: '#16A34A', matchPostType: null,
    matchTitle: ['commencement of commercial production', 'commercial production',
                 'commence of commercial production'] },
  { id: 'business-update', label: 'Business Update',         color: '#0EA5E9', matchPostType: null,
    matchTitle: ['monthly business updates', 'monthly update', 'sales update'] },
  { id: 'order-receipt',   label: 'Order Receipt',           color: '#65A30D', matchPostType: null,
    matchTitle: ['announcement under regulation 30 (lodr)-award of order receipt of order',
                 'award of order receipt of order', 'order receipt', 'order'] },
  // USFDA — routing is handled exclusively by a preempt in categorize() that
  // scans BOTH the title and the description for USFDA / ANDA references
  // (regulatory filings often hide the keyword in the description body
  // beneath a generic "Disclosure under Regulation 30 of SEBI" title). No
  // matchTitle is wired here because the preempt is the entire match path
  // — and that's deliberate per spec: description-scanning is restricted
  // to this single category, not folded into the generic searchInDesc
  // mechanism that MOA / Fund Raising use.
  { id: 'usfda',           label: 'USFDA',                   color: '#0D9488', matchPostType: null, matchTitle: null },
  // Annual Report — Corp. Note items whose title contains the SEBI Reg. 34(1)
  // marker. Routed via a preempt in categorize() (matchTitle is null because
  // we deliberately want this to fire ONLY for Corp. Note postType, not for
  // Company Update's unrestricted title-routing path).
  { id: 'annual-report',   label: 'Annual Report',           color: '#B45309', matchPostType: null, matchTitle: null },
  // Merger&Acquisition — Corp. Note items announcing acquisitions, open
  // offers, scheme of arrangement, SAST disclosures, or corporate-action
  // amalgamation/merger/demerger. Same preempt-based routing as
  // annual-report; matchTitle stays null for the same reason.
  { id: 'merger-acq',      label: 'Merger&Acquisition',      color: '#BE185D', matchPostType: null, matchTitle: null },
  { id: 'co-update',       label: 'Company Update',          color: '#6B7280', matchPostType: ['company update'],                                                     matchTitle: null },
];
const ANN_CAT_BY_ID = Object.fromEntries(ANN_CATEGORIES.map(c => [c.id, c]));

// Decide the single category an announcement belongs to. Returns the category id
// or null if it doesn't fit any.
//
// Two-stage logic:
//   1. Find the "natural" category for this postType (matchPostType lookup) — that's
//      the fallback if no more-specific title rule fires.
//   2. For specific postTypes, try to re-route to a MORE specific category by
//      scanning title + description for matchTitle substrings:
//         • "Company Update"  — unrestricted (can route to ANY matchTitle category)
//         • "Board Meeting"   — restricted to Fund Raising only (per spec)
//         • "Corp. Note"      — restricted to Fund Raising only (per spec)
//      Other postTypes don't participate in title routing.
function categorize(it) {
  if (!it) return null;
  const pt    = (it.postType    || '').toLowerCase().trim();
  const title = (it.title       || '').toLowerCase();
  const desc  = (it.description || '').toLowerCase();

  // Stage 1: natural category by exact postType match
  let naturalCatId = null;
  for (let i = 0; i < ANN_CATEGORIES.length; i++) {
    const c = ANN_CATEGORIES[i];
    if (c.matchPostType && c.matchPostType.indexOf(pt) !== -1) { naturalCatId = c.id; break; }
  }

  // Preempt: Company Update items whose title contains "newspaper" or "news paper"
  // stay in the Company Update bucket — they're newspaper publications of various
  // corporate events (audited results, board meeting notices, etc.) and the
  // financial-result keywords inside those titles (e.g. "Submission Of Newspaper
  // Publications Of The Audited Financial Results …", "Copy Of News Paper Cutting
  // Of Un-Audited Financial Results …") would otherwise pull them into bm-results.
  // Title-only check, per spec.
  if (pt === 'company update' &&
      (title.indexOf('newspaper') !== -1 || title.indexOf('news paper') !== -1)) {
    return 'co-update';
  }

  // Preempt: USFDA / ANDA — unique among preempts in that it scans BOTH the
  // title AND the description. Regulatory filings often surface the
  // USFDA / ANDA reference inside the description body while the title
  // reads as a generic boilerplate ("Disclosure under Regulation 30 of
  // SEBI"). Per spec, this dual-field scan is exclusive to USFDA — no
  // other category looks at the description through this path.
  //
  // Word boundaries (\b) are load-bearing: the 'anda' keyword would
  // otherwise false-match common words like "panda", "amanda", "andaman"
  // — so 'anda' must be a stand-alone token, not a substring fragment.
  // The same anchors let 'usfda' match in punctuated contexts like
  // "USFDA-approved" or "USFDA's inspection". Placed early so USFDA
  // wins over downstream Company Update preempts (presentation,
  // investor conference, concall) when a title mentions both.
  if (pt === 'company update' && /\b(usfda|anda)\b/.test(title + ' ' + desc)) {
    return 'usfda';
  }

  // Preempt: Investor Presentation route. Word-boundary regex matches
  // "Presentation" / "Presentations" / "Presentation for Investor Day" as
  // whole words, but deliberately NOT the substring inside "Representation",
  // "Misrepresentation", "Representations and Warranties" — those are
  // common in Reg 30 disclosures and would false-match a naive substring search.
  // Runs after the newspaper preempt so newspapers-of-presentations still
  // route to co-update.
  if (pt === 'company update' && /\bpresentations?\b/.test(title)) {
    return 'inv-pres';
  }

  // Preempt: Investor Conference titles also route to Investor Presentation.
  // Catches:
  //   • "Regulation 30 Of The SEBI … Update On Participation In The Investor Conference Held On"
  //   • "Participation In The Investor Conference"
  //   • "Investor Conference"
  //   • "Investor Conference Outcome"
  // Word boundaries make "investor conference" match as a phrase but reject
  // edge concatenations like "reinvestor conference" (theoretical, but cheap).
  if (pt === 'company update' && /\binvestor conference\b/.test(title)) {
    return 'inv-pres';
  }

  // Preempt: Concall / Earning(s) Call titles route to Concall Transcript —
  // when a Company Update is announcing or distributing a concall, the
  // semantic home is the Concall Transcript pill, not Analyst / Investor
  // Meet. Catches:
  //   • "Earning Concall"
  //   • "Concall"           ← bare
  //   • "Earning Call" / "Earnings Call"
  //   • "Q4FY26 Concall Notice", "Pre-earnings call update", etc.
  // The 's?' covers singular and plural; \b anchors stop "concallback" and
  // similar concatenations from false-matching.
  if (pt === 'company update' && /\b(concall|earnings? call)\b/.test(title)) {
    return 'concall';
  }

  // Preempt: Annual Report — Corp. Note items whose title contains the
  // SEBI Reg. 34(1) annual-report marker. Strict Corp. Note scope per
  // spec; the marker is precise enough that no description-scan rescue
  // is needed. Placed before COCP so an annual report whose description
  // happens to mention "capacity" or "expansion" still routes here
  // (annual reports cover the entire business and routinely use those
  // words; COCP's broad description scan would otherwise intercept
  // them).
  if ((pt === 'corp. note' || pt === 'corp note') &&
      title.indexOf('reg. 34 (1) annual report') !== -1) {
    return 'annual-report';
  }

  // Preempt: Merger & Acquisition — title-only, post-type AGNOSTIC.
  // These keywords appear across multiple postTypes in the live feed:
  //   • "Corporate Action-Amalgamation/ Merger / Demerger" → Corp Action
  //   • "Announcement under Regulation 30 (LODR)-Acquisition" → typically Company Update
  //   • "Scheme of Arrangement" → can sit under Board Meeting / Corp. Note / Company Update
  // Earlier spec restricted this to Corp. Note, which missed the bulk
  // of real M&A announcements (chip showed 0 despite data being
  // present). All seven matchers below are specific enough that
  // postType-agnostic matching doesn't false-fire — see comments on
  // individual keywords for risk notes. Placed before COCP for the
  // same description-scan reason as Annual Report above: an
  // acquisition announcement mentioning capacity in its description
  // body should still land in M&A, not COCP.
  const maMatchers = [
    'announcement under regulation 30 (lodr)-acquisition',
    'disclosure of number of equity shares tendered in connection with the open offer',
    'announcement under regulation 30 (lodr)-scheme of arrangement',
    'scheme of arrangement',
    'disclosures under reg. 10(5) in respect of acquisition under reg. 10(1)(a) of sebi (sast) regulations, 2011',
    'updates on open offer',
    'corporate action-amalgamation/ merger / demerger',
  ];
  for (let i = 0; i < maMatchers.length; i++) {
    if (title.indexOf(maMatchers[i]) !== -1) return 'merger-acq';
  }

  // Preempt: COCP — operational announcements (Expansion, capacity addition,
  // Trial run) hiding inside Company Update or Corp. Note items. Scans BOTH
  // title AND description per spec, since the operational signal often lives
  // in the description body while the title reads as generic Reg 30
  // boilerplate. Analogous to the USFDA preempt above — dual-field, scoped
  // to a single target category, exclusive to COCP.
  //
  // Keywords per user spec: "Expansion", "New capacity", "capacity", "Trial run".
  //   • "new capacity" is implicitly covered by the bare "capacity" stem —
  //     the broader phrase is a strict superset, so an explicit "new capacity"
  //     branch would be dead code.
  //   • singular + plural covered: "expansions?" and "trial runs?" handle
  //     both forms; "capacit(y|ies)" handles "capacity" and "capacities".
  //
  // Word boundaries (\b) reject false positives:
  //   • "incapacity" / "incapacitated"  — boundary before "capacit" fails
  //   • "preexpansion" / "expansionary" — boundary at one end fails
  //
  // Restricted to two postTypes only — Company Update and Corp. Note (in
  // both spelling variants 'corp. note' and 'corp note') — per spec.
  // Placed after USFDA / concall / inv-pres preempts so those more specific
  // signals win when present in the same title (e.g. "Concall on capacity
  // expansion" routes to Concall Transcript, not COCP). Does not affect
  // any other category's routing path.
  if ((pt === 'company update' || pt === 'corp. note' || pt === 'corp note') &&
      /\b(expansions?|capacit(y|ies)|trial runs?)\b/.test(title + ' ' + desc)) {
    return 'cocp';
  }

  // Stage 2: which targets is this postType allowed to route INTO via title rules?
  //   null       = unrestricted (any matchTitle category fair game)
  //   Set        = restricted to listed ids only
  //   empty Set  = no title routing (just use natural cat)
  let allowedTargets;
  if (pt === 'company update') {
    allowedTargets = null;
  } else if (pt === 'board meeting' || pt === 'corp. note' || pt === 'corp note') {
    allowedTargets = new Set(['fund-raising']);
  } else {
    allowedTargets = new Set();
  }

  if (allowedTargets === null || allowedTargets.size > 0) {
    // Description scanning is intentionally narrow:
    //   • only Company Update items consult descriptions (the user's spec says
    //     "title/description contain" only for Company Update; Board Meeting
    //     and Corp. Note specs say "title contain" only);
    //   • even then, only categories with searchInDesc=true opt in. This
    //     prevents bm-results' generic title keywords ("board meeting",
    //     "audited financial results") from matching newspaper-publication
    //     descriptions that happen to mention those terms.
    const checkDesc = (pt === 'company update');
    for (let i = 0; i < ANN_CATEGORIES.length; i++) {
      const c = ANN_CATEGORIES[i];
      if (!c.matchTitle) continue;
      if (allowedTargets !== null && !allowedTargets.has(c.id)) continue;
      if (c.id === naturalCatId) continue;     // never re-route to own postType bucket
      const m = c.matchTitle;
      for (let j = 0; j < m.length; j++) {
        if (title.indexOf(m[j]) !== -1) return c.id;
        if (checkDesc && c.searchInDesc && desc.indexOf(m[j]) !== -1) return c.id;
      }
    }
  }

  return naturalCatId;
}

// Dedupe announcements that the API returns more than once for the same
// company. The duplicate cards seen in Merger&Acquisition (and elsewhere)
// have identical NSEcode/BSECode + identical title + identical pubDate
// timestamp — two cards rendered from two raw API rows. Key: (company
// identity, lowercased+trimmed title). For each key we keep the row
// with the latest pubDate; when timestamps tie (the common case here,
// since the duplicates ARE identical to the second), the first
// occurrence wins, which preserves the API's incoming order. Applied
// once at fetch time before items hits state, so every downstream
// consumer (filter pipeline, category counts, search) reads the same
// deduped list.
function annDedupe(items) {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  const winners = new Map();  // key → { index, ts }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const co = (it.NSEcode || it.BSEcode || it.stockName || '').toString().trim();
    const ti = (it.title   || '').toString().toLowerCase().trim();
    if (!co && !ti) continue;       // nothing to key on — leave it alone
    const key = co + '||' + ti;
    const rawTs = new Date(it.pubDate || it.lastUpdated || 0).getTime();
    const ts = isNaN(rawTs) ? -Infinity : rawTs;
    const prev = winners.get(key);
    if (!prev || ts > prev.ts) winners.set(key, { index: i, ts });
  }
  const keepIdx = new Set();
  winners.forEach(w => keepIdx.add(w.index));
  return items.filter((_, i) => keepIdx.has(i));
}

// Resolve scope of NSE/BSE codes from selected watchlists. Empty set = no filter (show all).
function annScope() {
  const scope = new Set();
  state.selected.forEach(id => {
    const w = wlById(id);
    if (!w) return;
    w.companies.forEach(c => {
      // Backward-compat: legacy entries are plain ticker strings.
      if (typeof c === 'string') { if (c) scope.add(c); return; }
      if (!c) return;
      // Object shape: add both NSE symbol and BSE code so a match on
      // either field on the announcement (it.NSEcode / it.BSEcode)
      // brings the item into scope.
      if (c.NSESymbol) scope.add(String(c.NSESymbol));
      if (c.BSECode)   scope.add(String(c.BSECode));
    });
  });
  return scope;
}

// Build a cheap signature so memoization invalidates on the only inputs that matter:
// the selection, the query string, the categories set, the date-range bounds,
// and whether items has been replaced.
function annFilterSig() {
  const sel = [...state.selected].sort().join(',');
  const cats = [...state.ann.categories].sort().join(',');
  return sel + '|' + state.ann.items.length + '|' + (state.ann.qsTime || 0) + '|' + (state.ann.query || '') + '|' + cats + '|' + (state.ann.dateFrom || '') + '|' + (state.ann.dateTo || '');
}

function annFiltered() {
  const sig = annFilterSig();
  const cache = state.ann.cache;
  if (cache.sig === sig && cache.items) return cache.items;

  const scope = annScope();
  const q = state.ann.query;
  const cats = state.ann.categories;
  let out = state.ann.items;

  // Watchlist filter — only when there are actual codes to match against.
  if (scope.size > 0) {
    out = out.filter(it =>
      it && (scope.has(String(it.NSEcode)) || scope.has(String(it.BSEcode)))
    );
  }

  // Search filter — matches company name, NSE / BSE code.
  if (q) {
    out = out.filter(it => {
      if (!it) return false;
      const name = (it.stockName || it.get_full_name || '').toLowerCase();
      const nse  = (it.NSEcode || '').toLowerCase();
      const bse  = (it.BSEcode || '').toLowerCase();
      return name.indexOf(q) !== -1 || nse.indexOf(q) !== -1 || bse.indexOf(q) !== -1;
    });
  }

  // Date-range filter — inclusive on both ends. 'From' is start-of-day,
  // 'To' is end-of-day. Skipped when both bounds are empty. Items with a
  // missing or unparseable pubDate are dropped from a windowed view —
  // an item with no known date doesn't belong in any specific window,
  // and treating its timestamp as epoch-0 (the JS default) would let
  // such items slip past upper-only bounds.
  if (state.ann.dateFrom || state.ann.dateTo) {
    const fromTs = state.ann.dateFrom ? new Date(state.ann.dateFrom + 'T00:00:00').getTime() : -Infinity;
    const toTs   = state.ann.dateTo   ? new Date(state.ann.dateTo   + 'T23:59:59.999').getTime() :  Infinity;
    out = out.filter(it => {
      const raw = it && (it.pubDate || it.lastUpdated);
      if (!raw) return false;
      const ts = new Date(raw).getTime();
      if (isNaN(ts)) return false;
      return ts >= fromTs && ts <= toTs;
    });
  }

  // Category filter — multi-select. 'all' is a wildcard that disables the
  // filter. ALSO skipped when a search query is active: a company-name
  // search should surface results wherever they live in the taxonomy, so
  // we bypass the category gate and let the pill row become an
  // informational mirror of where the matches landed.
  if (!q && !cats.has('all')) {
    out = out.filter(it => cats.has(categorize(it)));
  }

  // Latest-first ordering. The Trendlyne feed generally arrives in this
  // order, but mixed-postType filtering — particularly the USFDA preempt,
  // which pulls a subset out of the heterogeneous Company Update bucket
  // — can surface items that aren't strictly date-desc. Sorting once
  // here, after filters, guarantees the newest item is at the top in
  // every category (USFDA included) without depending on the API's
  // ordering contract. .slice() is defensive: when no filters narrowed
  // the set, `out` still aliases state.ann.items, and we don't want
  // sort() to mutate the original.
  out = out.slice().sort((a, b) => {
    const da = new Date(a.pubDate || a.lastUpdated || 0).getTime();
    const db = new Date(b.pubDate || b.lastUpdated || 0).getTime();
    return db - da;
  });

  state.ann.cache = { sig, items: out };
  return out;
}

// Per-category counts, based on the watchlist+search+date filtered subset (NOT the
// category filter itself — clicking a different pill shouldn't shrink them).
// The same trio of filters as annFiltered, minus the category step, so a count
// of 0 reliably means "no items in this category given the current scope".
function annCategoryCountsKey() {
  return [...state.selected].sort().join(',') + '|' + state.ann.items.length + '|' + (state.ann.qsTime || 0) + '|' + (state.ann.query || '') + '|' + (state.ann.dateFrom || '') + '|' + (state.ann.dateTo || '');
}
function annCategoryCounts() {
  const key = annCategoryCountsKey();
  const cc = state.ann.catCountsCache;
  if (cc && cc.key === key) return cc.counts;

  const scope = annScope();
  const q = state.ann.query;
  let base = state.ann.items;
  if (scope.size > 0) {
    base = base.filter(it => it && (scope.has(String(it.NSEcode)) || scope.has(String(it.BSEcode))));
  }
  if (q) {
    base = base.filter(it => {
      if (!it) return false;
      const name = (it.stockName || it.get_full_name || '').toLowerCase();
      const nse  = (it.NSEcode || '').toLowerCase();
      const bse  = (it.BSEcode || '').toLowerCase();
      return name.indexOf(q) !== -1 || nse.indexOf(q) !== -1 || bse.indexOf(q) !== -1;
    });
  }
  if (state.ann.dateFrom || state.ann.dateTo) {
    const fromTs = state.ann.dateFrom ? new Date(state.ann.dateFrom + 'T00:00:00').getTime() : -Infinity;
    const toTs   = state.ann.dateTo   ? new Date(state.ann.dateTo   + 'T23:59:59.999').getTime() :  Infinity;
    base = base.filter(it => {
      const raw = it && (it.pubDate || it.lastUpdated);
      if (!raw) return false;
      const ts = new Date(raw).getTime();
      if (isNaN(ts)) return false;
      return ts >= fromTs && ts <= toTs;
    });
  }

  const counts = { all: base.length };
  for (let i = 1; i < ANN_CATEGORIES.length; i++) counts[ANN_CATEGORIES[i].id] = 0;
  for (let i = 0; i < base.length; i++) {
    const id = categorize(base[i]);
    if (id) counts[id]++;
  }

  state.ann.catCountsCache = { key, counts };
  return counts;
}

function annInvalidateCache() {
  state.ann.cache = { sig: null, items: null };
  state.ann.catCountsCache = null;
}
function annResetVisible()    { state.ann.visible = CHUNK_SIZE; }

// One bulk fetch. We pull `PER_PAGE` items in a single call and keep them in memory;
// "Load more" never hits the network again, it just enlarges the rendered slice.
// On a refresh (state already loaded), we deliberately do NOT re-render the whole
// panel — that would recreate the search input and steal focus from a typing user.
// Instead we only toggle the refresh button visual + update the list.
async function loadAnnouncements(force) {
  if (state.ann.loading) return;
  if (state.ann.loaded && !force) return;

  const isRefresh = state.ann.loaded;
  state.ann.loading = true;
  state.ann.error = null;

  if (isRefresh) {
    const btn = document.getElementById('annRefresh');
    if (btn) { btn.classList.add('refreshing'); btn.disabled = true; }
  } else if (state.tab === 'announcements') {
    renderPanel();   // first load → skeleton
  }

  const qsTime = Math.floor(Date.now() / 1000);

  try {
    let json;
    if (DEMO_MODE) {
      await new Promise(r => setTimeout(r, 450));
      json = DEMO_PAGES[0] || { head: { isNextPage: false, status: "0", thisPageNumber: 1, qsTime }, body: { newsList: [], qsTime } };
    } else {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ pageNumber: 1, perPageCount: PER_PAGE, qsTime: String(qsTime) })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
    }
    if (!json || !json.head) throw new Error('Bad response');
    if (json.head.status !== '0') throw new Error(json.head.statusDescription || 'API failure');

    const list = (json.body && Array.isArray(json.body.newsList)) ? json.body.newsList : [];
    // Sort newest first once, here — the renderer never resorts.
    list.sort((a, b) => new Date(b.pubDate || b.lastUpdated || 0) - new Date(a.pubDate || a.lastUpdated || 0));

    state.ann.items   = annDedupe(list);
    state.ann.qsTime  = json.head.qsTime || (json.body && json.body.qsTime) || qsTime;
    state.ann.loaded  = true;
    state.ann.lastRefreshedAt = Date.now();
    annResetVisible();
    annInvalidateCache();
  } catch (e) {
    state.ann.error = e && e.message ? e.message : 'Network error';
  } finally {
    state.ann.loading = false;
    const btn = document.getElementById('annRefresh');
    if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }

    if (state.tab === 'announcements') {
      if (isRefresh && document.getElementById('annListWrap')) {
        // Quiet update — list refreshes, search input keeps focus.
        renderAnnList();
        updateUpdatedCaption();
      } else {
        renderPanel();
      }
    }
    renderTabCounts();
    notifyDrSearch();
  }
}

function skeletonList(n) {
  let html = '<div class="ann-list">';
  for (let i = 0; i < n; i++) {
    html += `<div class="ann-card sk">
      <div class="sk-line w30"></div>
      <div class="sk-line w70"></div>
      <div class="sk-line w90"></div>
      <div class="sk-line w50"></div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtNum(v) {
  if (v == null || isNaN(v)) return null;
  const n = Number(v);
  return (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stripTitlePrefix(title) {
  if (!title) return '';
  // Strip "<company name> - <BSE code> - " when the title starts with that pattern.
  // The leading segment is non-greedy, then ' - ', then a run of digits (BSE code),
  // then ' - '. If the title doesn't match, it's returned unchanged.
  return title.replace(/^.+?\s+-\s+\d+\s+-\s+/, '');
}

// Pull the first YouTube URL out of arbitrary text (handles watch?v=, youtu.be,
// live/, embed/, mobile m. and www. subdomains). Returns null if none found.
function extractYouTubeUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

function ytIcon() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.5 6.5a3 3 0 0 0-2.1-2.1C19.4 4 12 4 12 4s-7.4 0-9.4.4A3 3 0 0 0 .5 6.5C.1 8.5 0 12 0 12s.1 3.5.5 5.5a3 3 0 0 0 2.1 2.1c2 .4 9.4.4 9.4.4s7.4 0 9.4-.4a3 3 0 0 0 2.1-2.1c.4-2 .5-5.5.5-5.5s-.1-3.5-.5-5.5ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"/></svg>';
}

function renderAnnCard(it, idx) {
  const co = escapeHtml(it.stockName || it.get_full_name || '—');
  const title = escapeHtml(stripTitlePrefix(it.title || ''));
  const postType = escapeHtml(it.postType || '');
  const src = escapeHtml(it.source || '');
  const when = escapeHtml(fmtDateTime(it.pubDate || it.lastUpdated));
  const nse = it.NSEcode ? `<span class="code-chip">NSE: ${escapeHtml(it.NSEcode)}</span>` : '';
  const bse = it.BSEcode ? `<span class="code-chip">BSE: ${escapeHtml(it.BSEcode)}</span>` : '';

  // optional mini-stats
  const cp = it.currentPrice, dc = it.dayChangeP;
  const cpS = fmtNum(cp), dcS = fmtNum(dc);
  const statParts = [];
  if (cpS != null) statParts.push(`<span class="ann-stat"><b>₹${cpS}</b></span>`);
  if (dcS != null) statParts.push(`<span class="ann-stat ${Number(dc) >= 0 ? 'pos' : 'neg'}"><b>${Number(dc) >= 0 ? '+' : ''}${dcS}%</b></span>`);
  const stats = statParts.length ? `<span class="ann-stats">${statParts.join('')}</span>` : '';

  const pdfBtn = it.pdfUrl
    ? `<a class="doc-btn" href="${safeAttr(it.pdfUrl)}" target="_blank" rel="noopener noreferrer">${docIcon()}PDF</a>`
    : '';

  // Trendlyne Earnings Call cards: surface the YouTube link parked in the
  // description as a clickable CTA next to the PDF button.
  const catId    = categorize(it);
  const catObj   = catId ? ANN_CAT_BY_ID[catId] : null;
  const catLabel = catObj ? catObj.label : null;
  const catColor = catObj && catObj.color ? catObj.color : null;
  const catStyle = catColor
    ? `--c:${catColor};--c-soft:${rgba(catColor, 0.08)};--c-border:${rgba(catColor, 0.30)}`
    : '';
  const ytUrl    = (catId === 'earn-call') ? extractYouTubeUrl(it.description) : null;
  const ytBtn    = ytUrl
    ? `<a class="yt-btn" href="${safeAttr(ytUrl)}" target="_blank" rel="noopener noreferrer" title="Watch on YouTube">${ytIcon()}YouTube</a>`
    : '';

  return `<article class="ann-card">
    <header class="ann-head">
      <div class="ann-meta">
        <span class="ann-co">${co}</span>
        <span class="ann-codes">${nse}${bse}</span>
        ${catLabel ? `<span class="badge cat-badge" style="${catStyle}">${escapeHtml(catLabel)}</span>` : ''}
      </div>
      <span class="ann-when">${when}</span>
    </header>
    ${stats ? `<div class="ann-tag-row">${stats}</div>` : ''}
    <div class="ann-title-row">
      <h3 class="ann-title">${title}</h3>
      ${ytBtn}
      ${pdfBtn}
    </div>
    ${src ? `<footer class="ann-foot">
      <span class="ann-src">Source: ${src}</span>
    </footer>` : ''}
  </article>`;
}

const ANN_AUTO_REFRESH_MS = 5 * 60 * 1000;   // 5 minutes
let annSearchDebounceTimer = null;
let annAutoRefreshTimer = null;
let annUpdatedCaptionTimer = null;

function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 30) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 60 * 60) return Math.floor(s / 60) + ' min ago';
  if (s < 60 * 60 * 2) return '1 hr ago';
  return Math.floor(s / 3600) + ' hr ago';
}

function updateUpdatedCaption() {
  const el = document.getElementById('annUpdated');
  if (!el) return;
  if (!state.ann.lastRefreshedAt) { el.textContent = ''; return; }
  el.textContent = 'Updated ' + fmtAgo(state.ann.lastRefreshedAt);
}

function refreshAnnouncements() {
  if (state.ann.loading) return;
  loadAnnouncements(true);   // force a re-fetch
}

function startAnnAutoRefresh() {
  if (annAutoRefreshTimer) clearInterval(annAutoRefreshTimer);
  annAutoRefreshTimer = setInterval(() => {
    if (document.hidden) return;       // pause while the browser tab isn't visible
    if (state.ann.loading) return;
    loadAnnouncements(true);
  }, ANN_AUTO_REFRESH_MS);

  // Keep the "Updated X ago" caption alive without a full re-render.
  if (annUpdatedCaptionTimer) clearInterval(annUpdatedCaptionTimer);
  annUpdatedCaptionTimer = setInterval(updateUpdatedCaption, 30 * 1000);

  // If the tab was hidden long enough that the interval elapsed, refresh on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    updateUpdatedCaption();
    if (!state.ann.lastRefreshedAt) return;
    if (Date.now() - state.ann.lastRefreshedAt >= ANN_AUTO_REFRESH_MS && !state.ann.loading) {
      loadAnnouncements(true);
    }
  });
}

function annListEmptyHtml() {
  const parts = [];
  const cats = state.ann.categories;
  if (!cats.has('all') && cats.size > 0) {
    const labels = [...cats].map(id => ANN_CAT_BY_ID[id] && ANN_CAT_BY_ID[id].label).filter(Boolean);
    if (labels.length === 1)      parts.push(`in “${escapeHtml(labels[0])}”`);
    else if (labels.length > 1)   parts.push(`in ${labels.length} categories`);
  }
  if (state.ann.query) parts.push(`matching “${escapeHtml(state.ann.query)}”`);
  const tail = parts.length ? ' ' + parts.join(' ') : '';
  return `<div class="card empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <div class="et">No announcements found</div>
    <div class="es">No items${tail} in the loaded feed.</div>
  </div>`;
}

// List-only re-render. Touches #annListWrap and #annSearchCount — leaves the
// search input alone so focus and caret position are preserved while typing.
function renderAnnList() {
  const wrap = document.getElementById('annListWrap');
  if (!wrap) return;

  const items = annFiltered();

  // Update the live count chip next to the search bar.
  const countEl = document.getElementById('annSearchCount');
  if (countEl) {
    if (state.ann.query) {
      countEl.textContent = `${items.length.toLocaleString('en-IN')} ${items.length === 1 ? 'match' : 'matches'}`;
      countEl.style.display = '';
    } else {
      countEl.style.display = 'none';
    }
  }

  if (items.length === 0) { wrap.innerHTML = annListEmptyHtml(); return; }

  const visible = Math.min(state.ann.visible, items.length);
  const slice = items.slice(0, visible);
  const parts = new Array(slice.length);
  for (let i = 0; i < slice.length; i++) parts[i] = renderAnnCard(slice[i], i);
  let html = '<div class="ann-list">' + parts.join('') + '</div>';

  if (visible < items.length) {
    html += `<div class="lm-wrap">
      <button class="lm-btn" id="annLoadMore">Load more <span class="lm-count">${visible.toLocaleString('en-IN')} of ${items.length.toLocaleString('en-IN')}</span></button>
    </div>`;
  } else {
    html += `<div class="lm-end">Showing all ${items.length.toLocaleString('en-IN')} announcements</div>`;
  }
  wrap.innerHTML = html;

  const lm = document.getElementById('annLoadMore');
  if (lm) lm.onclick = () => {
    state.ann.visible = Math.min(state.ann.visible + CHUNK_SIZE, items.length);
    renderAnnList();
  };
}

function renderCategoryPills() {
  const counts = annCategoryCounts();
  return `<div class="cat-row" id="annCatRow">${ANN_CATEGORIES.map(c => {
    const active = isCatActive(c.id);
    const cnt = counts[c.id] || 0;
    // Muted = nothing in this category for the current scope (watchlist
    // + search + date range). Visually de-emphasised but still clickable
    // — same pattern as Reports' rep-type-muted. The "All" pill is never
    // muted (it represents the unfiltered total, and even when the total
    // is genuinely zero the user shouldn't see All look broken).
    const muted = (c.id !== 'all' && cnt === 0) ? ' cat-muted' : '';
    // Per-pill CSS variables so each category renders in its own colour when active.
    const styleVar = c.color
      ? `--c:${c.color};--c-soft:${rgba(c.color, 0.08)};--c-tint:${rgba(c.color, 0.18)}`
      : '';
    return `<button class="cat-pill${active ? ' active' : ''}${muted}" data-cat="${c.id}" style="${styleVar}" type="button">${escapeHtml(c.label)}<span class="cat-cnt num">${cnt.toLocaleString('en-IN')}</span></button>`;
  }).join('')}</div>`;
}

// Pill activation rule:
//   • When a search query is active, the pill row becomes informational —
//     every category that contains at least one match lights up. This is so
//     a company-name search surfaces results across the whole taxonomy
//     (e.g. "SunRakshakk" with hits in Investor Presentation + Concall
//     Transcript causes both pills to highlight) without the user having
//     to manually expand their category selection first.
//   • When there's no search, the user's explicit category selection
//     (state.ann.categories) drives activation as usual.
function isCatActive(catId) {
  if (state.ann.query) {
    const counts = annCategoryCounts();
    return (counts[catId] || 0) > 0;
  }
  return state.ann.categories.has(catId);
}

// Toggle rules for the multi-select pill row:
//   • Clicking "All" clears every other pill and leaves only "All" selected.
//   • Clicking any specific pill removes "All" (mutually exclusive) and toggles
//     the clicked pill in/out of the set.
//   • The set can never go empty — deselecting the last specific pill falls
//     back to "All" so the user always sees something.
function wireCategoryPills() {
  document.querySelectorAll('.cat-pill[data-cat]').forEach(btn => {
    btn.onclick = () => {
      const cat  = btn.dataset.cat;
      const cats = state.ann.categories;

      if (cat === 'all') {
        cats.clear();
        cats.add('all');
      } else {
        cats.delete('all');
        if (cats.has(cat)) {
          cats.delete(cat);
          if (cats.size === 0) cats.add('all');
        } else {
          cats.add(cat);
        }
      }

      // Update pill active classes via the search-aware resolver. When a
      // search is active, isCatActive is driven by counts > 0, so clicks
      // during search update the underlying state.ann.categories (preserved
      // for when the search clears) but don't visually mutate the pills.
      document.querySelectorAll('.cat-pill[data-cat]').forEach(b => {
        b.classList.toggle('active', isCatActive(b.dataset.cat));
      });

      onScopeChanged();
      renderAnnList();
      renderTabCounts();
    };
  });
}

// Called after search query, watchlist, or date-range changes, so the count
// chips inside category pills reflect the new watchlist+search+date subset.
// Also refreshes the active class (during a search the active set is derived
// from match counts) AND the cat-muted class (which depends on whether the
// new count is 0). Without re-evaluating cat-muted here, pills that started
// with count > 0 would stay un-muted even after a filter dropped them to 0
// — the exact mismatch that caused several "0" chips to look identical to
// chips with real data.
function updateCategoryPillCounts() {
  const counts = annCategoryCounts();
  document.querySelectorAll('.cat-pill[data-cat]').forEach(btn => {
    const id = btn.dataset.cat;
    const cnt = counts[id] || 0;
    const cntEl = btn.querySelector('.cat-cnt');
    if (cntEl) cntEl.textContent = cnt.toLocaleString('en-IN');
    btn.classList.toggle('active', isCatActive(id));
    btn.classList.toggle('cat-muted', id !== 'all' && cnt === 0);
  });
}

function wireAnnSearch() {
  const input = document.getElementById('annSearchInput');
  const clear = document.getElementById('annSearchClear');
  const search = document.getElementById('annSearch');
  if (!input || !clear || !search) return;

  search.classList.toggle('has-value', !!input.value);

  input.oninput = e => {
    const val = e.target.value;
    search.classList.toggle('has-value', val.length > 0);
    clearTimeout(annSearchDebounceTimer);
    annSearchDebounceTimer = setTimeout(() => {
      const q = val.trim().toLowerCase();
      if (q === state.ann.query) return;
      state.ann.query = q;
      // Treat search like any other filter change: reset chunk + invalidate
      // memo. Then update only the list and the category counts (input keeps focus).
      onScopeChanged();
      updateCategoryPillCounts();
      renderAnnList();
      renderTabCounts();
    }, 150);
  };

  clear.onclick = () => {
    clearTimeout(annSearchDebounceTimer);
    input.value = '';
    search.classList.remove('has-value');
    if (state.ann.query) {
      state.ann.query = '';
      onScopeChanged();
      updateCategoryPillCounts();
      renderAnnList();
      renderTabCounts();
    }
    input.focus();
  };

  const refreshBtn = document.getElementById('annRefresh');
  if (refreshBtn) refreshBtn.onclick = refreshAnnouncements;

  // Date range — two native date inputs + a clear button. Each input's
  // change writes its value to state.ann.dateFrom/dateTo and runs the
  // same downstream pipeline as the company-search filter: cache reset
  // via onScopeChanged, refresh the category-pill counts (which now
  // reflect the date-filtered base), repaint the list, update tab
  // counts. Cross-bound min/max attributes are kept in sync so the
  // native picker won't let the user pick a "from" later than "to".
  const dateRange = document.getElementById('annDateRange');
  const fromInput = document.getElementById('annDateFrom');
  const toInput   = document.getElementById('annDateTo');
  const dateClear = document.getElementById('annDateClear');

  function applyDateChange() {
    if (dateRange) dateRange.classList.toggle('has-range', !!(state.ann.dateFrom || state.ann.dateTo));
    // Keep the cross-bound limits live so the picker UI itself prevents
    // an invalid range, instead of relying on a post-hoc empty result.
    if (fromInput) fromInput.max = state.ann.dateTo || '';
    if (toInput)   toInput.min   = state.ann.dateFrom || '';
    onScopeChanged();
    updateCategoryPillCounts();
    renderAnnList();
    renderTabCounts();
  }

  if (fromInput) fromInput.onchange = e => {
    state.ann.dateFrom = e.target.value || '';
    applyDateChange();
  };
  if (toInput) toInput.onchange = e => {
    state.ann.dateTo = e.target.value || '';
    applyDateChange();
  };
  if (dateClear) dateClear.onclick = () => {
    if (!state.ann.dateFrom && !state.ann.dateTo) return;
    state.ann.dateFrom = '';
    state.ann.dateTo = '';
    if (fromInput) fromInput.value = '';
    if (toInput)   toInput.value   = '';
    applyDateChange();
  };
}

function renderAnnouncementsPanel() {
  const panel = $('#panel');

  // First-load skeleton: only while the bulk fetch is in flight and nothing's cached yet.
  if (state.ann.loading && !state.ann.loaded) {
    panel.innerHTML = skeletonList(6);
    return;
  }
  // Error with nothing to fall back on → full error card with Retry.
  if (state.ann.error && state.ann.items.length === 0) {
    panel.innerHTML = `<div class="err-card">
      <div class="et">Couldn’t load announcements</div>
      <div class="es">${escapeHtml(state.ann.error)}. Check that the proxy at ${escapeHtml(PROXY_URL)} is reachable and returns CORS headers for this origin.</div>
      <button class="btn-accent" id="annRetry">Retry</button>
    </div>`;
    const r = document.getElementById('annRetry');
    if (r) r.onclick = () => loadAnnouncements(true);
    return;
  }

  // Data state: render the search bar shell once; the list lives in a child
  // container so it can be updated independently without disturbing the input.
  panel.innerHTML = `
    <div class="ann-search-wrap">
      <div class="ann-search" id="annSearch">
        <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="annSearchInput" type="text" placeholder="Search company name, NSE or BSE code…" value="${escapeHtml(state.ann.query || '')}" autocomplete="off" spellcheck="false">
        <button class="sclear" id="annSearchClear" aria-label="Clear search" title="Clear">×</button>
      </div>
      <div class="ann-date-range ${(state.ann.dateFrom || state.ann.dateTo) ? 'has-range' : ''}" id="annDateRange">
        <input type="date" class="ann-date-input" id="annDateFrom" value="${escapeHtml(state.ann.dateFrom || '')}" max="${escapeHtml(state.ann.dateTo || '')}" title="From date — filters announcements by pubDate">
        <span class="ann-date-sep">→</span>
        <input type="date" class="ann-date-input" id="annDateTo" value="${escapeHtml(state.ann.dateTo || '')}" min="${escapeHtml(state.ann.dateFrom || '')}" title="To date — filters announcements by pubDate">
        <button class="ann-date-clear" id="annDateClear" type="button" title="Clear date range">Clear</button>
      </div>
      <span class="ann-search-count" id="annSearchCount" style="display:none"></span>
      <div class="ann-meta-right">
        <span class="ann-updated" id="annUpdated"></span>
        <button class="ann-refresh ${state.ann.loading ? 'refreshing' : ''}" id="annRefresh" ${state.ann.loading ? 'disabled' : ''} title="Refresh — auto-refreshes every 5 min" aria-label="Refresh announcements">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><polyline points="21 3 21 8 16 8"/><polyline points="3 21 3 16 8 16"/></svg>
        </button>
      </div>
    </div>
    ${renderCategoryPills()}
    <div id="annListWrap"></div>
  `;
  wireAnnSearch();
  wireCategoryPills();
  updateUpdatedCaption();
  renderAnnList();
}

/* ============================ REPORTS TAB ============================
   Repository view at Daily Reading > Reports. Pulls from four endpoints:
     - POST /api/RepositoryListTesting (the report list, paginated)
     - GET  /api/sectormaster  | sectormaster  → dropdown values
     - GET  /api/SymbolMaster  | symbol master → company dropdown + per-row symbol lookup
     - GET  /api/brokermaster  | broker master → broker dropdown
   Masters are fetched once per session in parallel; the report list is fetched
   on filter change (with pagination via Load more). Report-type filtering is
   client-side so the pill row reflects what's actually in the current response. */

let repAutoRefreshTimer = null;
let repUpdatedCaptionTimer = null;
let repSearchDebounceTimer = null;
let openSsel = null;            // currently-open searchable dropdown element (if any)

function fmtIsoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Stable hash → palette index for sector marks.
const REP_PALETTE = ['#2C7A7B', '#B7791F', '#C0392B', '#6B46C1', '#1E40AF', '#0F8A5F', '#9F1239', '#0E7490', '#7C2D12', '#4338CA', '#0369A1', '#854D0E'];
function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return REP_PALETTE[Math.abs(h) % REP_PALETTE.length];
}

function repDefaultDateRange() {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  return { from: fmtIsoDate(yesterday), to: fmtIsoDate(today) };
}

// Period quick-presets shown above the Sector/Company/Broker row. Each
// resolves to a from→to date range anchored at "today". The taxonomy is
// fixed (order is the display order). 'custom' is the escape hatch — when
// active, the From/To date inputs become visible below the pill row so
// the user can pick an arbitrary window.
const REP_PERIODS = [
  { id: 'yesterday', label: 'Yesterday',  days: 1 },
  { id: '1w',        label: '1 week',     days: 7 },
  { id: '1m',        label: '1 month',    months: 1 },
  { id: '2m',        label: '2 months',   months: 2 },
  { id: '3m',        label: '3 months',   months: 3 },
  { id: '6m',        label: '6 months',   months: 6 },
  { id: '12m',       label: '12 months',  months: 12 },
  { id: 'custom',    label: 'Custom',     custom: true },
];

// Compute the from/to dates for a given period id, anchored at today.
// 'days' presets subtract whole days. 'months' presets subtract calendar
// months via setMonth (so "3 months" lands on the same day-of-month
// three months back, with JS's automatic Feb-29 / month-length rollover).
// Returns null for 'custom' — the caller leaves dates as the user set them.
function periodToDateRange(periodId) {
  if (!periodId || periodId === 'custom') return null;
  const p = REP_PERIODS.find(x => x.id === periodId);
  if (!p) return null;
  const today = new Date();
  const from = new Date(today);
  if (p.days)   from.setTime(today.getTime() - p.days * 24 * 60 * 60 * 1000);
  if (p.months) from.setMonth(from.getMonth() - p.months);
  return { from: fmtIsoDate(from), to: fmtIsoDate(today) };
}

// Reverse mapping: given concrete dateFrom/dateTo, decide which period
// pill should show as active. A date pair matches a preset only when
// dateTo is today AND dateFrom equals the preset's computed from. Any
// other combination (different "to", manual edit, refresh on a day
// where presets shifted) lands on 'custom'.
function detectPeriod(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return 'custom';
  const todayIso = fmtIsoDate(new Date());
  if (dateTo !== todayIso) return 'custom';
  for (const p of REP_PERIODS) {
    if (p.custom) continue;
    const r = periodToDateRange(p.id);
    if (r && r.from === dateFrom) return p.id;
  }
  return 'custom';
}

// One-time init of filter defaults — the dates need today's value.
function repInitFiltersIfNeeded() {
  if (!state.reports.filters.dateFrom) {
    const { from, to } = repDefaultDateRange();
    state.reports.filters.dateFrom = from;
    state.reports.filters.dateTo   = to;
    state.reports.pendingFilters.dateFrom = from;
    state.reports.pendingFilters.dateTo   = to;
  }
}

/* ---- Master data loader (one-shot, parallel) ---- */
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadMasters() {
  const m = state.masters;
  if (m.sectors.loaded && m.symbols.loaded && m.brokers.loaded) return;
  if (m.sectors.loading || m.symbols.loading || m.brokers.loading) return;

  m.sectors.loading = m.symbols.loading = m.brokers.loading = true;
  m.error = null;

  try {
    const [sectors, symbols, brokers] = await Promise.all([
      fetchJson(SECTOR_URL),
      fetchJson(SYMBOL_URL),
      fetchJson(BROKER_URL),
    ]);

    // Sectors: sectorID -> Sector
    const sList = (Array.isArray(sectors) ? sectors : []).slice().sort((a, b) => String(a.Sector).localeCompare(String(b.Sector)));
    const sById = {};
    for (const s of sList) sById[String(s.sectorID)] = s;
    m.sectors = { byId: sById, list: sList, loaded: true, loading: false };

    // Symbols: CompanyID -> { CompanyName, NSESymbol, ... }
    const symList = (Array.isArray(symbols) ? symbols : []).slice().sort((a, b) => String(a.CompanyName).localeCompare(String(b.CompanyName)));
    const symById = {};
    for (const s of symList) symById[String(s.CompanyID)] = s;
    m.symbols = { byId: symById, list: symList, loaded: true, loading: false };

    // Brokers: trim whitespace/newline noise the API has in a few rows
    const bList = (Array.isArray(brokers) ? brokers : []).map(b => ({ ID: b.ID, BrokerName: String(b.BrokerName || '').replace(/[\r\n]/g, '').trim() }))
      .slice().sort((a, b) => a.BrokerName.localeCompare(b.BrokerName));
    const bById = {};
    for (const b of bList) bById[String(b.ID)] = b;
    m.brokers = { byId: bById, list: bList, loaded: true, loading: false };
  } catch (e) {
    m.error = e && e.message ? e.message : 'Failed to load master data';
    m.sectors.loading = m.symbols.loading = m.brokers.loading = false;
  }
}

/* ---- Report list loader ---- */
function buildRepoBody(opts) {
  opts = opts || {};
  const f = state.reports.filters;
  // Page comes from opts when present (the parallel-worker path), falling
  // back to state.reports.page for any legacy callsite. Eliminates the
  // race that would otherwise let two workers stamp the same `page`
  // because they read state.reports.page at different microtask points.
  const page = (opts.page != null) ? opts.page : state.reports.page;
  // ⚠ Important: this body intentionally OMITS sector / company / broker /
  // search. The fetch is keyed only by the date range — the server returns
  // the full unfiltered set for that window, and all narrowing runs
  // client-side in visibleReportItems(). This is the foundation of the
  // date-range cache: one fetch per period, instant filter changes after.
  // ReportType is also always sent empty (taxonomy filter has always been
  // a pill-row toggle, never a server filter).
  return {
    Date: [f.dateFrom || '', f.dateTo || ''],
    sectorId: '',
    WatchListID: '0',
    IndustryId: '',
    CompanyId: '',
    BrokerId:  '',
    ReportType: ['', ''],
    page,
    order: f.sortOrder,
    order_column: f.sortColumn,
    numPerPage: String(REP_PER_PAGE),
    search: '',
  };
}

let repAbortController = null;       // tracks the in-flight repository fetch (if any)

// Cache helpers — keyed by date range. Eviction policy is "drop oldest by
// fetchedAt when over cap" so the cache stays bounded across long sessions.
function repCacheKey() {
  const f = state.reports.filters;
  return (f.dateFrom || '') + '|' + (f.dateTo || '');
}
function repCacheGet() {
  return state.reports.cache.get(repCacheKey()) || null;
}
function repCachePut(items, totalRows) {
  state.reports.cache.set(repCacheKey(), {
    items:      items.slice(),    // shallow copy; downstream filtering must never mutate the cached array
    totalRows,
    fetchedAt:  Date.now(),
  });
  // Eviction: when above the cap, drop the entry with the oldest fetchedAt.
  // Map iteration order is insertion order, but we want oldest by *timestamp*,
  // which can drift if entries were refreshed in place — hence the explicit min.
  while (state.reports.cache.size > state.reports.cacheMax) {
    let oldestKey = null;
    let oldestTs  = Infinity;
    state.reports.cache.forEach((v, k) => {
      if (v.fetchedAt < oldestTs) { oldestTs = v.fetchedAt; oldestKey = k; }
    });
    if (oldestKey == null) break;     // safety: nothing to evict
    state.reports.cache.delete(oldestKey);
  }
}

async function loadReports({ force = false } = {}) {
  if (state.reports.loaded && !force) return;
  repInitFiltersIfNeeded();

  // Make sure master data is ready — the dropdowns need their option lists.
  // If the panel was already rendered with empty masters, force a re-render
  // once masters arrive so the dropdowns get populated.
  const mastersWereStale = !state.masters.sectors.loaded || !state.masters.symbols.loaded || !state.masters.brokers.loaded;
  if (mastersWereStale) {
    await loadMasters();
    if (state.tab === 'reports' && state.masters.sectors.loaded) {
      renderReportsPanel();
    }
  }

  // Cache HIT path — skip the network entirely when we already have the
  // full unfiltered set for this date range. Narrowing filters apply at
  // render-time via visibleReportItems(). Force=true bypasses this so the
  // refresh button and auto-refresh timer still hit the API.
  if (!force) {
    const cached = repCacheGet();
    if (cached) {
      state.reports.items     = cached.items;
      state.reports.totalRows = cached.totalRows;
      state.reports.loaded    = true;
      state.reports.loading   = false;
      state.reports.error     = null;
      if (state.tab === 'reports') {
        if (!document.getElementById('repListWrap')) renderReportsPanel();
        else renderReportsList();
        renderTabCounts();
      }
      notifyDrSearch();
      return;
    }
  }

  // Cancel any fetch already in flight — when the user clicks a filter while a
  // previous request is still resolving, that previous request would otherwise
  // arrive late and clobber the new (correct) one. Aborting it makes the
  // latest filter selection always win.
  if (repAbortController) repAbortController.abort();
  repAbortController = new AbortController();
  const signal = repAbortController.signal;

  state.reports.loading = true;
  state.reports.error = null;
  state.reports.items = [];
  state.reports.page = 1;

  if (state.tab === 'reports') {
    const list = document.getElementById('repListWrap');
    if (list) list.classList.add('is-loading');
    // Re-render the list area immediately so the user sees the spinner kick
    // in the moment they hit Apply (rather than waiting for the fetch to
    // complete and the finally-block render to run).
    renderReportsList();
  }

  // Helper: fetch one page. Throws AbortError when the controller fires,
  // surfacing the same shape JS native fetch uses so the worker / outer
  // try block can detect it uniformly. Returns { data, totalRows } so
  // callers can plan downstream work after the first response.
  async function fetchReportPage(pageNum) {
    const body = buildRepoBody({ page: pageNum });
    const res = await fetch(REPO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');
    return {
      data: Array.isArray(json.Data) ? json.Data : [],
      totalRows: Number(json.total_rows) || 0,
    };
  }

  try {
    // ---- Stage 1: page 1 sequential ----
    // The first page must complete before we can plan the parallel batch
    // (we need totalRows to know how many pages exist). It's also the
    // cheapest perceived-speedup: render it the moment it arrives so the
    // user sees the first 50 rows in ~1-2s instead of waiting for the
    // whole 38-page walk to finish.
    const p1 = await fetchReportPage(1);
    if (signal.aborted) return;
    state.reports.items = p1.data;
    const totalRows = p1.totalRows || p1.data.length;
    state.reports.totalRows = totalRows;
    state.reports.loaded = true;            // enough to render — don't show skeletons anymore
    if (state.tab === 'reports') {
      renderReportsList();                  // ← user sees first batch right here
      renderTabCounts();
    }

    // If the whole set fits in page 1, we're done.
    const stop = (p1.data.length === 0) || (state.reports.items.length >= totalRows);
    if (!stop) {
      // ---- Stage 2: pages 2..N in parallel ----
      // Build the page-number queue once; workers grab the next index
      // atomically (since JS is single-threaded between awaits, a simple
      // nextIdx++ is race-free in the way we need). Results land in
      // pageResults at the same index, so we can append in order as
      // contiguous prefix becomes available.
      const totalPages = Math.min(REP_MAX_PAGES, Math.ceil(totalRows / REP_PER_PAGE));
      const remainingPageNums = [];
      for (let p = 2; p <= totalPages; p++) remainingPageNums.push(p);
      const pageResults = new Array(remainingPageNums.length);
      let nextIdx       = 0;     // claim index for workers
      let appendIdx     = 0;     // next consecutive index ready to append

      async function repPageWorker() {
        while (true) {
          if (signal.aborted) return;
          const myIdx = nextIdx++;
          if (myIdx >= remainingPageNums.length) return;
          const myPage = remainingPageNums[myIdx];

          const result = await fetchReportPage(myPage);
          if (signal.aborted) return;
          pageResults[myIdx] = result.data;

          // Append a contiguous run of completed pages from the front.
          // If page 5 finishes before page 3, page 5 just sits in
          // pageResults until 3 (and 4) arrive — the user never sees
          // out-of-order data.
          let appended = false;
          while (appendIdx < pageResults.length && pageResults[appendIdx] !== undefined) {
            state.reports.items = state.reports.items.concat(pageResults[appendIdx]);
            appendIdx++;
            appended = true;
          }
          // Re-render only when this worker actually contributed new
          // visible data — skip the paint when our chunk is held back
          // waiting on an earlier sibling.
          if (appended && state.tab === 'reports') {
            renderReportsList();
            renderTabCounts();
          }
        }
      }

      const workerCount = Math.min(REP_PARALLEL_WORKERS, remainingPageNums.length);
      const workerPromises = [];
      for (let i = 0; i < workerCount; i++) workerPromises.push(repPageWorker());
      await Promise.all(workerPromises);
      if (signal.aborted) return;
    }

    state.reports.lastRefreshedAt = Date.now();
    // Persist this date-range's full result set into the cache so any
    // subsequent return to this period (or any narrowing-filter change
    // that doesn't move the date range) is instant.
    repCachePut(state.reports.items, state.reports.totalRows);
  } catch (e) {
    if (signal.aborted || (e && e.name === 'AbortError')) return;
    state.reports.error = e && e.message ? e.message : 'Network error';
  } finally {
    // The aborted run shouldn't touch shared UI state — the newer call has
    // taken over by now.
    if (signal.aborted) return;
    state.reports.loading = false;
    const list = document.getElementById('repListWrap');
    if (list) list.classList.remove('is-loading');
    if (state.tab === 'reports') {
      if (!document.getElementById('repListWrap')) {
        renderReportsPanel();
      } else {
        renderReportsList();
      }
      renderTabCounts();
    }
    notifyDrSearch();
  }
}

/* ---- Filter actions ---- */
function repResetPageAndReload() {
  loadReports({ force: true });
}

// All five main filters (dates + sector/company/broker) plus search live in
// pendingFilters until the user hits Apply. typeFilter and sort apply immediately.
function setPendingFilter(key, value) {
  state.reports.pendingFilters[key] = value;
  updateApplyResetButton();
}

// Set-equality helper for the multi-select arrays in pending vs applied filters.
function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function pendingHasDirty() {
  const p = state.reports.pendingFilters;
  const f = state.reports.filters;
  return p.dateFrom !== f.dateFrom
      || p.dateTo   !== f.dateTo
      || p.period   !== f.period
      || !arrEq(p.sectorIds,  f.sectorIds)
      || !arrEq(p.companyIds, f.companyIds)
      || !arrEq(p.brokerIds,  f.brokerIds)
      || p.query !== f.query;
}

function updateApplyResetButton() {
  const btn = document.getElementById('repApplyReset');
  if (!btn) return;
  const dirty = pendingHasDirty();
  btn.textContent = dirty ? 'Apply' : 'Reset';
  btn.classList.toggle('is-apply', dirty);
}

// Backwards-compat shim used by repSearchClear — earlier code referenced
// refreshApplyResetButton(); keep the alias so future searches grep
// either name.
const refreshApplyResetButton = updateApplyResetButton;

function applyRepFilters() {
  // Copy pending → applied. Arrays are deep-cloned so applied and pending
  // remain independent (no shared reference that mutates both on next edit).
  const p = state.reports.pendingFilters;
  const f = state.reports.filters;
  // The ONLY pending change that requires the network is a date-range
  // change — that's the cache key, so a new key means a possible miss.
  // Every other pending change (sector / company / broker / keyword) is
  // pure client-side narrowing against the cached set.
  const dateChanged = (p.dateFrom !== f.dateFrom) || (p.dateTo !== f.dateTo);

  state.reports.filters.dateFrom   = p.dateFrom;
  state.reports.filters.dateTo     = p.dateTo;
  state.reports.filters.period     = p.period;
  state.reports.filters.sectorIds  = [...p.sectorIds];
  state.reports.filters.companyIds = [...p.companyIds];
  state.reports.filters.brokerIds  = [...p.brokerIds];
  state.reports.filters.query      = p.query;
  state.reports.filters.typeFilter = new Set();

  if (dateChanged) {
    // New date range → check cache first, fall back to fetch. loadReports()
    // with force:false handles both paths and renders for us.
    state.reports.loaded = false;
    loadReports({ force: false });
  } else {
    // Same date range, only narrowing filters changed — no network needed,
    // just paint the new client-filtered view. This is the fast path the
    // caching layer was built for.
    if (state.tab === 'reports') {
      renderReportsList();
      renderTabCounts();
    }
    notifyDrSearch();
  }
  updateApplyResetButton();
}

function applyOrResetClick() {
  if (pendingHasDirty()) applyRepFilters();
  else resetRepFilters();
}

function setRepFilter(key, value) {
  // Legacy path kept for sort etc. Most code paths now use setPendingFilter.
  state.reports.filters[key] = value;
  if (key !== 'sortColumn' && key !== 'sortOrder') {
    state.reports.filters.typeFilter.clear();
  }
  repResetPageAndReload();
}

function resetRepFilters() {
  const { from, to } = repDefaultDateRange();
  state.reports.filters = {
    dateFrom: from, dateTo: to,
    period: 'yesterday',
    sectorIds: [], companyIds: [], brokerIds: [],
    query: '',
    sortColumn: 'Date', sortOrder: 'desc',
    typeFilter: new Set(),
  };
  state.reports.pendingFilters = {
    dateFrom: from, dateTo: to,
    period: 'yesterday',
    sectorIds: [], companyIds: [], brokerIds: [],
    query: '',
  };
  state.reports.loaded = false;
  state.reports.pageSize = 50;          // view default — Reset wipes the view choice too
  renderReportsPanel();
  // Cache-aware reset: default range is yesterday→today, which is the
  // most-likely-cached period. force:false → instant if cached.
  loadReports({ force: false });
}
function toggleRepType(t) {
  const s = state.reports.filters.typeFilter;
  if (s.has(t)) s.delete(t); else s.add(t);
  renderReportsList();
}

/* ---- Derived views ---- */
function visibleReportItems() {
  const f = state.reports.filters;
  let items = state.reports.items;

  // Client-side narrowing — all five filters (sector, company, broker,
  // keyword, report-type) run here against the cached unfiltered set.
  // Pipeline order is cheapest filter first (id-set membership beats
  // substring scan), so a strict-narrow case (e.g. sector + company)
  // shrinks the pool BEFORE the more expensive keyword pass touches it.
  if (f.sectorIds && f.sectorIds.length) {
    const wanted = new Set();
    for (const id of f.sectorIds) {
      const s = state.masters.sectors.byId[id];
      if (s && s.Sector) wanted.add(String(s.Sector).toLowerCase());
    }
    if (wanted.size) items = items.filter(it => wanted.has(String(it.SectorName || '').toLowerCase()));
  }
  if (f.companyIds && f.companyIds.length) {
    const wanted = new Set(f.companyIds.map(String));
    items = items.filter(it => wanted.has(String(it.CompanyID || '')));
  }
  if (f.brokerIds && f.brokerIds.length) {
    const wanted = new Set();
    for (const id of f.brokerIds) {
      const b = state.masters.brokers.byId[id];
      if (b && b.BrokerName) wanted.add(String(b.BrokerName).toLowerCase().trim());
    }
    if (wanted.size) items = items.filter(it => wanted.has(String(it.BrokerName || '').toLowerCase().trim()));
  }

  // Keyword search — moved from server-side (where it was the `search` param
  // in the request body) to client-side now that the cached set is the full
  // unfiltered data. Matches company name, sector, broker, report-type, AND
  // the report title (the server's `search` field covered the same fields,
  // give or take title precision).
  const q = (f.query || '').toLowerCase().trim();
  if (q) {
    items = items.filter(it => {
      const co = String(it.CompanyName || '').toLowerCase();
      const se = String(it.SectorName  || '').toLowerCase();
      const br = String(it.BrokerName  || '').toLowerCase();
      const ti = String(it.Title       || '').toLowerCase();
      const ty = Array.isArray(it.ReportType) ? it.ReportType.join(' ').toLowerCase() : '';
      return co.indexOf(q) !== -1
          || se.indexOf(q) !== -1
          || br.indexOf(q) !== -1
          || ti.indexOf(q) !== -1
          || ty.indexOf(q) !== -1;
    });
  }

  // Report-type pill filter — case-insensitive so the fixed pill names
  // (e.g. "Top picks") still match data values like "TOP PICKS" or "top picks".
  const types = f.typeFilter;
  if (types.size > 0) {
    const wantedCI = new Set([...types].map(t => String(t).toLowerCase().trim()));
    items = items.filter(it => {
      const rt = Array.isArray(it.ReportType) ? it.ReportType : [];
      for (const t of rt) if (wantedCI.has(String(t).toLowerCase().trim())) return true;
      return false;
    });
  }

  return items;
}
function reportTypeCounts() {
  const counts = new Map();
  for (const it of state.reports.items) {
    const rt = Array.isArray(it.ReportType) ? it.ReportType : [];
    for (const t of rt) counts.set(t, (counts.get(t) || 0) + 1);
  }
  // Stable order: by descending count, then label
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Page-size presets for the visible-row slicing control. Pure view state —
// doesn't affect the fetch (which always caches the full date-range result
// set). -1 is the "All" sentinel: render everything currently in scope.
const REP_PAGE_SIZE_OPTIONS = [50, 100, 250, 500, -1];
function repPageSizeLabel(n) { return n === -1 ? 'All' : String(n); }

// The Report Type pill row is a fixed list — these 19 types always render in
// this order, with counts drawn from the loaded data. Types with zero items
// are still shown (visually muted) so the user sees the full taxonomy and
// can predict what's available.
const REP_FIXED_TYPES = [
  'Annual Report',
  'Budget Report',
  'Concall Transcript',
  'Conference Notes',
  'Credit Report',
  'Economy',
  'General Update',
  'Global Report',
  'Good Read',
  'Initial Coverage',
  'Investor Presentation',
  'Management Meet',
  'Promoter Update',
  'Quarterly Report',
  'Result Preview',
  'Result Review',
  'Sector Update',
  'Strategy Report',
  'Top picks',
];

// Each report type gets a distinct hex so the pill (when active) AND the
// chip on each report card carry the same color. Keys lowercased to match
// the case-insensitive lookup. Chosen for visual distinctness — none repeat
// across pills, none collide with the brand accent.
const REP_TYPE_COLORS = {
  'annual report':         '#2563EB',  // blue
  'budget report':         '#059669',  // emerald
  'concall transcript':    '#DB2777',  // pink
  'conference notes':      '#0891B2',  // cyan
  'credit report':         '#92400E',  // brown
  'economy':               '#475569',  // slate-600
  'general update':        '#6B7280',  // gray
  'global report':         '#1E40AF',  // deep blue
  'good read':             '#16A34A',  // green
  'initial coverage':      '#14B8A6',  // teal
  'investor presentation': '#7C3AED',  // violet
  'management meet':       '#C2410C',  // deep orange
  'promoter update':       '#B45309',  // amber/dark
  'quarterly report':      '#4F46E5',  // indigo
  'result preview':        '#65A30D',  // lime
  'result review':         '#CA8A04',  // gold
  'sector update':         '#9333EA',  // purple
  'strategy report':       '#DC2626',  // red
  'top picks':             '#0F172A',  // slate-ink
};
function repTypeColor(name) {
  return REP_TYPE_COLORS[String(name).toLowerCase().trim()] || '#6B7280';
}

// Items visible after all server/client filters EXCEPT the type-pill filter.
// Used by the type-pill counts so the count next to each pill reflects what
// would be shown if the user clicked that pill — narrows as the user adds
// sector / company / broker filters.
function reportsItemsBeforeTypeFilter() {
  const f = state.reports.filters;
  let items = state.reports.items;
  if (f.sectorIds && f.sectorIds.length) {
    const wanted = new Set();
    for (const id of f.sectorIds) {
      const s = state.masters.sectors.byId[id];
      if (s && s.Sector) wanted.add(String(s.Sector).toLowerCase());
    }
    if (wanted.size) items = items.filter(it => wanted.has(String(it.SectorName || '').toLowerCase()));
  }
  if (f.companyIds && f.companyIds.length) {
    const wanted = new Set(f.companyIds.map(String));
    items = items.filter(it => wanted.has(String(it.CompanyID || '')));
  }
  if (f.brokerIds && f.brokerIds.length) {
    const wanted = new Set();
    for (const id of f.brokerIds) {
      const b = state.masters.brokers.byId[id];
      if (b && b.BrokerName) wanted.add(String(b.BrokerName).toLowerCase().trim());
    }
    if (wanted.size) items = items.filter(it => wanted.has(String(it.BrokerName || '').toLowerCase().trim()));
  }
  return items;
}

// Build a case-insensitive count map keyed by lowercased name. Lets pills
// hit the right count even if the API returns "TOP PICKS" or "top picks"
// while the fixed list says "Top picks". Sources from the filtered set so
// counts narrow as dropdown filters apply.
function repTypeCountsCI() {
  const out = new Map();
  const items = reportsItemsBeforeTypeFilter();
  for (const it of items) {
    const rt = Array.isArray(it.ReportType) ? it.ReportType : [];
    for (const t of rt) {
      const k = String(t).toLowerCase().trim();
      out.set(k, (out.get(k) || 0) + 1);
    }
  }
  return out;
}

/* ---- Searchable multi-select dropdown component ---- */
// Specs accepted by render / wire:
//   { id, key, placeholder, options, searchPlaceholder, hideSub?, withSearch? }
// `key` references a state.reports.pendingFilters array (e.g. 'sectorIds').
// `hideSub: true` suppresses the right-side .ssel-opt-sub (used for Company so
// the full company name has the whole row to itself instead of being squeezed
// next to the NSE symbol).
function renderSearchableSelect(spec) {
  const cur = state.reports.pendingFilters[spec.key] || [];
  const selectedSet = new Set(cur.map(String));
  const selOptions = spec.options.filter(o => selectedSet.has(String(o.value)));

  let labelText, hasValue;
  if (selOptions.length === 0) {
    labelText = spec.placeholder;
    hasValue = false;
  } else if (selOptions.length === 1) {
    labelText = selOptions[0].label;
    hasValue = true;
  } else {
    labelText = `${selOptions.length} selected`;
    hasValue = true;
  }

  return `<div class="ssel ssel-multi" data-key="${spec.key}" id="${spec.id}">
    <button type="button" class="ssel-btn ${hasValue ? 'has-value' : ''}" aria-haspopup="listbox" aria-expanded="false" title="${escapeHtml(labelText)}">
      <span class="ssel-label">${escapeHtml(labelText)}</span>
      <span class="ssel-clear" title="Clear selection" aria-label="Clear selection">×</span>
      <span class="ssel-caret" aria-hidden="true"><svg viewBox="0 0 10 6" width="10" height="6"><path fill="currentColor" d="M0 0l5 6 5-6z"/></svg></span>
    </button>
    <div class="ssel-panel" role="listbox" aria-multiselectable="true">
      ${spec.withSearch !== false ? `<div class="ssel-search-wrap"><input class="ssel-search" type="text" placeholder="${escapeHtml(spec.searchPlaceholder || 'Search…')}" /></div>` : ''}
      <div class="ssel-list">${renderSselOptions(spec.options, selectedSet, !!spec.hideSub)}</div>
    </div>
  </div>`;
}
function renderSselOptions(options, selectedSet, hideSub) {
  if (!options.length) return '<div class="ssel-empty">No matches</div>';
  return options.map(o => {
    const isSel = selectedSet.has(String(o.value));
    return `<div class="ssel-opt ${isSel ? 'selected' : ''}" data-value="${safeAttr(String(o.value))}">
      <span class="ssel-cbox" aria-hidden="true"></span>
      <span class="ssel-opt-main">${escapeHtml(o.label)}</span>
      ${!hideSub && o.sub ? `<span class="ssel-opt-sub">${escapeHtml(o.sub)}</span>` : ''}
    </div>`;
  }).join('');
}

function buildSectorOptions() {
  const opts = [];
  for (const s of state.masters.sectors.list) {
    opts.push({ value: String(s.sectorID), label: s.Sector });
  }
  return opts;
}
function buildCompanyOptions() {
  // No cap — the company dropdown must expose ALL companies from the master,
  // otherwise a search for any name beyond the first batch silently fails
  // (e.g. "KNR Constructions Ltd" living past position 500 in load order).
  // The DOM render still caps the *visible* list (200 unfiltered / 150 matches)
  // for browser performance; the data behind the search is unrestricted.
  // `sub` still carries the NSE/BSE symbol so the search panel can match by
  // symbol typing — but the option renderer is told hideSub=true so the chip
  // shows only the full company name.
  const list = state.masters.symbols.list;
  const opts = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    opts[i] = { value: String(s.CompanyID), label: s.CompanyName, sub: s.NSESymbol || s.BSESymbol || '' };
  }
  return opts;
}
function buildBrokerOptions() {
  const opts = [];
  for (const b of state.masters.brokers.list) {
    opts.push({ value: String(b.ID), label: b.BrokerName });
  }
  return opts;
}

// Filter ssel options live as the user types in the panel's search input.
function filterSselOptions(spec, query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return spec.allOptions.slice(0, spec.maxVisible || 200);
  const matches = [];
  for (const o of spec.allOptions) {
    if (o.value === '') continue; // always include "any" at top below
    const main = String(o.label || '').toLowerCase();
    const sub  = String(o.sub || '').toLowerCase();
    if (main.indexOf(q) !== -1 || sub.indexOf(q) !== -1) matches.push(o);
    if (matches.length >= (spec.maxVisible || 100)) break;
  }
  return [spec.allOptions[0]].concat(matches);
}

/* ---- Renderers ---- */
function renderReportsPanel() {
  const panel = $('#panel');

  // Masters not loaded yet? Show skeletons in the list area while the parallel
  // master fetch + first report fetch run. The shell still renders so users
  // see the filter scaffolding immediately.
  if (state.masters.error) {
    panel.innerHTML = `<div class="card empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div class="et">Couldn't load master data</div>
      <div class="es">${escapeHtml(state.masters.error)}</div>
      <div style="margin-top:10px"><button class="btn-accent" id="repRetryMasters">Retry</button></div>
    </div>`;
    const r = document.getElementById('repRetryMasters');
    if (r) r.onclick = async () => { await loadMasters(); renderReportsPanel(); if (state.masters.sectors.loaded) loadReports({ force: false }); };
    return;
  }
  if (state.reports.error && !state.reports.items.length) {
    panel.innerHTML = `<div class="card empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div class="et">Couldn't load reports</div>
      <div class="es">${escapeHtml(state.reports.error)}</div>
      <div style="margin-top:10px"><button class="btn-accent" id="repRetry">Retry</button></div>
    </div>`;
    const r = document.getElementById('repRetry');
    if (r) r.onclick = () => loadReports({ force: true });
    return;
  }

  repInitFiltersIfNeeded();
  const f = state.reports.filters;
  const p = state.reports.pendingFilters;
  const fmt = n => n ? n.toLocaleString('en-IN') : '0';
  const sectorN = state.masters.sectors.list.length;
  const companyN = state.masters.symbols.list.length;
  const brokerN  = state.masters.brokers.list.length;
  const dirty = pendingHasDirty();

  panel.innerHTML = `
    <section class="rep-filters" aria-label="Report filters">
      <div class="rep-period-section">
        <span class="rep-field-label">Period</span>
        <div class="rep-period-row" id="repPeriodRow">
          ${REP_PERIODS.map(pp => `<button type="button" class="cat-pill${p.period === pp.id ? ' active' : ''}" data-period="${pp.id}">${escapeHtml(pp.label)}</button>`).join('')}
          ${p.period === 'custom' ? `
          <span class="rep-period-custom-inline" id="repCustomDates">
            <label class="rep-date-pill" title="From date">
              <span class="rep-date-prefix">From</span>
              <input class="rep-date-inline" type="date" id="repFrom" value="${escapeHtml(p.dateFrom)}" max="${escapeHtml(p.dateTo)}">
            </label>
            <span class="rep-period-sep">→</span>
            <label class="rep-date-pill" title="To date">
              <span class="rep-date-prefix">To</span>
              <input class="rep-date-inline" type="date" id="repTo" value="${escapeHtml(p.dateTo)}" min="${escapeHtml(p.dateFrom)}">
            </label>
          </span>` : ''}
        </div>
      </div>
      <div class="rep-fr1">
        <div class="rep-field rep-field-grow"><span class="rep-field-label">Sector${sectorN ? ` (${fmt(sectorN)})` : ''}</span>
          ${renderSearchableSelect({ id: 'repSelSector', key: 'sectorIds', placeholder: 'All sectors', searchPlaceholder: 'Search sector…', options: buildSectorOptions() })}</div>
        <div class="rep-field rep-field-grow"><span class="rep-field-label">Company${companyN ? ` (${fmt(companyN)})` : ''}</span>
          ${renderSearchableSelect({ id: 'repSelCompany', key: 'companyIds', placeholder: 'All companies', searchPlaceholder: 'Search company name or NSE symbol…', options: buildCompanyOptions(), hideSub: true })}</div>
        <div class="rep-field rep-field-grow"><span class="rep-field-label">Broker${brokerN ? ` (${fmt(brokerN)})` : ''}</span>
          ${renderSearchableSelect({ id: 'repSelBroker', key: 'brokerIds', placeholder: 'All brokers', searchPlaceholder: 'Search broker…', options: buildBrokerOptions() })}</div>
        <button class="rep-apply-reset ${dirty ? 'is-apply' : ''}" id="repApplyReset" type="button">${dirty ? 'Apply' : 'Reset'}</button>
      </div>
      <div class="rep-type-section">
        <span class="rep-field-label">Report Type</span>
        <div class="rep-type-row" id="repTypeRow"></div>
      </div>
      <div class="rep-fr2">
        <div class="rep-search-wrap ${p.query ? 'has-value' : ''}" id="repSearchWrap">
          <input class="rep-text" id="repSearch" type="text" placeholder="Search reports by keyword (press Enter to apply)…" value="${escapeHtml(p.query)}" autocomplete="off" spellcheck="false">
          <button class="rep-search-clear" id="repSearchClear" type="button" aria-label="Clear search" title="Clear">×</button>
        </div>
      </div>
    </section>
    <div id="repListWrap"></div>
  `;

  wireReportsFilters();
  renderReportsList();
}

function renderReportsList() {
  const wrap = document.getElementById('repListWrap');
  if (!wrap) return;

  // Type pills (client-side filter) — fixed taxonomy of 19 types, counts from data
  const typeRow = document.getElementById('repTypeRow');
  if (typeRow) {
    const countsCI = repTypeCountsCI();
    const tf = state.reports.filters.typeFilter;
    typeRow.innerHTML = REP_FIXED_TYPES.map(t => {
      const n = countsCI.get(t.toLowerCase().trim()) || 0;
      const active = tf.has(t);
      const muted  = n === 0 ? ' rep-type-muted' : '';
      // Per-pill colour for active state and count chip — same hue as the
      // corresponding card chip so the pill and the card read together.
      const c = repTypeColor(t);
      const styleVar = `--c:${c};--c-soft:${rgba(c, 0.08)};--c-tint:${rgba(c, 0.18)}`;
      return `<button class="cat-pill${active ? ' active' : ''}${muted}" type="button" data-type="${safeAttr(t)}" style="${styleVar}">${escapeHtml(t)}<span class="cat-cnt num">${n.toLocaleString('en-IN')}</span></button>`;
    }).join('');
    typeRow.querySelectorAll('button[data-type]').forEach(b => {
      b.onclick = () => toggleRepType(b.dataset.type);
    });
  }

  const items = visibleReportItems();

  // Page-size slice — render at most `pageSize` rows from the filtered set.
  // -1 ("All") renders everything. This is the perf knob: DOM stays small
  // (50 rows by default) even when the cached set is 19k items. Counts and
  // category pills still see the FULL filtered set, only the rendered card
  // list is truncated.
  const total   = items.length;
  const ps      = state.reports.pageSize;
  const visible = (ps === -1) ? items : items.slice(0, ps);
  const showing = visible.length;

  // Status row sits above the list:
  //   • count text (showing X of Y when truncated, just X reports otherwise)
  //   • spinner shown while state.reports.loading is true
  //   • page-size pill selector on the right (pure view control)
  const countText = (ps !== -1 && total > ps)
    ? `Showing ${showing.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} report${total === 1 ? '' : 's'}`
    : `${total.toLocaleString('en-IN')} report${total === 1 ? '' : 's'}`;
  const pageSizePillsHtml = `<span class="rep-pagesize" id="repPageSizeRow">
    <span class="rep-pagesize-label">Show</span>
    ${REP_PAGE_SIZE_OPTIONS.map(n => `<button type="button" class="rep-pagesize-pill${ps === n ? ' active' : ''}" data-pagesize="${n}">${escapeHtml(repPageSizeLabel(n))}</button>`).join('')}
  </span>`;
  const statusHtml = `<div class="rep-list-status">
    <span class="rep-list-count">${state.reports.loaded ? countText : ''}${state.reports.loading ? '<span class="rep-list-spinner" aria-label="Loading" style="margin-left:10px;vertical-align:middle"></span><span class="rep-list-loading-text">Loading…</span>' : ''}</span>
    ${state.reports.loaded ? pageSizePillsHtml : ''}
  </div>`;

  // First load → skeletons; subsequent renders never show skeletons (dim instead)
  if (!state.reports.loaded && !state.reports.items.length) {
    wrap.innerHTML = statusHtml + skeletonList(6);
    return;
  }
  if (!items.length) {
    wrap.innerHTML = statusHtml + renderReportsEmptyHtml();
    const c = document.getElementById('repClearFilters');
    if (c) c.onclick = (e) => { e.preventDefault(); resetRepFilters(); };
    wirePageSizePills();
    return;
  }

  let html = statusHtml + '<div class="rep-list" role="list">';
  for (const it of visible) html += renderReportCard(it);
  html += '</div>';

  wrap.innerHTML = html;
  wirePageSizePills();

  // Post-render: ask media_Web which of the newly-visible companies
  // actually have interview videos, and inject the Interviews button
  // only into those cards. Concurrency-capped; cached results from
  // earlier renders skip the network entirely.
  kickoffRepVideoPrechecks();
}

// Wire the page-size pill clicks. Pulled out so all renderReportsList exit
// paths (empty state included) wire identically without duplicating the
// listener loop.
function wirePageSizePills() {
  const row = document.getElementById('repPageSizeRow');
  if (!row) return;
  row.querySelectorAll('button[data-pagesize]').forEach(btn => {
    btn.onclick = () => {
      const n = parseInt(btn.dataset.pagesize, 10);
      if (Number.isNaN(n)) return;
      if (state.reports.pageSize === n) return;     // no-op when already active
      state.reports.pageSize = n;
      renderReportsList();
    };
  });
}

function renderReportsEmptyHtml() {
  const f = state.reports.filters;
  const parts = [];
  // Multi-select arrays — summarise as a label (single id) or a count (many).
  const summariseFilter = (ids, lookup, nameOf, singular, plural) => {
    if (!Array.isArray(ids) || !ids.length) return null;
    if (ids.length === 1) {
      const o = lookup[ids[0]];
      return o ? `${singular} <strong>${escapeHtml(nameOf(o))}</strong>` : null;
    }
    return `${ids.length} ${plural}`;
  };
  const secStr = summariseFilter(f.sectorIds,  state.masters.sectors.byId,  o => o.Sector,      'sector',  'sectors');
  const coStr  = summariseFilter(f.companyIds, state.masters.symbols.byId,  o => o.CompanyName, 'company', 'companies');
  const brStr  = summariseFilter(f.brokerIds,  state.masters.brokers.byId,  o => o.BrokerName,  'broker',  'brokers');
  if (secStr) parts.push(secStr);
  if (coStr)  parts.push(coStr);
  if (brStr)  parts.push(brStr);
  if (f.query) parts.push(`matching <strong>"${escapeHtml(f.query)}"</strong>`);
  if (state.reports.filters.typeFilter.size > 0) parts.push(`type ${[...state.reports.filters.typeFilter].map(t => `<strong>${escapeHtml(t)}</strong>`).join(' / ')}`);
  const filterSummary = parts.length ? ' for ' + parts.join(', ') : '';
  return `<div class="card empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
    <div class="et">No reports found</div>
    <div class="es">No items${filterSummary} between ${escapeHtml(f.dateFrom)} and ${escapeHtml(f.dateTo)}. <a href="#" id="repClearFilters" style="color:var(--accent-hover);text-decoration:underline">Clear filters</a></div>
  </div>`;
}

function renderReportCard(it) {
  const sector = String(it.SectorName || '').trim();
  const broker = String(it.BrokerName || '').trim();
  const period = String(it.Period || '').trim();
  const date   = String(it.Date || it.ReportDate || '').trim();
  const title  = String(it.Title || '').trim();
  const types  = Array.isArray(it.ReportType) ? it.ReportType : [];

  // Company name fallback to sector for sector-level reports
  const companyName = (it.CompanyName && String(it.CompanyName).trim()) || sector || '—';

  // Coloured sector mark, deterministic per sector
  const markLetters = sector ? sector.slice(0, 3).toUpperCase() : 'REP';
  const markColor = colorFromString(sector || broker || title);

  // Action buttons: per-type chips + PDF (and Summary if available).
  // Each chip carries its own colour (matching the pill above) via inline
  // CSS variables — the chip CSS reads --c / --c-soft / --c-border.
  const chips = types.map(t => {
    const c = repTypeColor(t);
    const style = `--c:${c};--c-soft:${rgba(c, 0.08)};--c-border:${rgba(c, 0.30)}`;
    return `<span class="rep-type-chip" style="${style}">${escapeHtml(t)}</span>`;
  }).join('');
  const pdfBtn = it.link ? `<a class="doc-btn" href="${safeAttr(it.link)}" target="_blank" rel="noopener noreferrer">${docIcon()}PDF</a>` : '';
  const sumBtn = it.Pdf_Summerylink ? `<a class="doc-btn" href="${safeAttr(it.Pdf_Summerylink)}" target="_blank" rel="noopener noreferrer">${docIcon()}Summary</a>` : '';
  // The Interviews button is NOT rendered up-front. Instead, after the
  // list paints, kickoffRepVideoPrechecks() asks the media_Web endpoint
  // (concurrency-capped at 6) whether each unique CompanyID has any
  // RR_Media rows. If it does, the button is injected into the actions
  // area of every card for that company. Companies with no videos never
  // get a button — clean cards, no dead controls. See the
  // "MANAGEMENT INTERVIEWS MODAL" block below for the implementation. */

  // Header line: assemble visible parts (sector highlighted, dashes between
  // sector / broker / period). Company name only shows when it differs from
  // the sector — sector-level reports just lead with the sector chip.
  const hasCompany = it.CompanyName && String(it.CompanyName).trim() && String(it.CompanyName).trim() !== sector;
  const metaParts = [];
  if (sector) metaParts.push(`<span class="rep-sector-tag">${escapeHtml(sector)}</span>`);
  if (broker) metaParts.push(`<span class="rep-broker">${escapeHtml(broker)}</span>`);
  if (period) metaParts.push(`<span class="rep-period">${escapeHtml(period)}</span>`);
  const metaHtml = metaParts.join('<span class="rep-sep">-</span>');

  // Carry CompanyID and CompanyName on the card so the post-render
  // precheck pass can find which card to inject the Interviews button into.
  const cardDataAttrs = it.CompanyID
    ? ` data-cid="${safeAttr(String(it.CompanyID))}" data-cname="${safeAttr(companyName)}"`
    : '';

  return `<article class="rep-card" role="listitem"${cardDataAttrs}>
    <div class="tk-mark" style="background:${markColor}">${markLetters}</div>
    <div class="rep-body">
      <div class="rep-head">
        <div class="rep-meta">
          ${hasCompany ? `<span class="rep-co">${escapeHtml(companyName)}</span>` : ''}
          ${metaHtml}
        </div>
        ${date ? `<span class="rep-when">${escapeHtml(date)}</span>` : ''}
      </div>
      <div class="rep-title-row">
        <h3 class="rep-title">${escapeHtml(title)}</h3>
        <div class="rep-actions">${chips}${sumBtn}${pdfBtn}</div>
      </div>
    </div>
  </article>`;
}

/* ============================ MANAGEMENT INTERVIEWS MODAL ============================
   Per-company historical YouTube interviews, fetched from
   `/api/media_Web`. The endpoint takes a SINGLE-ITEM
   ARRAY (the [] wrapper is required) with the request `Type: "RR_Comments"`
   and returns rows with `Type: "RR_Media"` for the matching CompanyID.

   Why a modal and not an inline expansion: the Reports list is long and
   scrollable; expanding a card inline would reflow the list and lose the
   user's reading position. A modal sits above the page and closes cleanly.

   Cache: state.repVideos.cache is a Map keyed by CompanyID. Once a
   company's videos are fetched, reopening the modal for the same company
   is instant — no second network round-trip. Cleared on page reload only.

   Empty state: companies without RR_Media rows hit the "no videos" branch
   in renderRepVideoModal(). We surface that explicitly rather than trying
   to pre-flight which CompanyIDs have content (which would be one HTTP
   request per unique company in the report list — too many).

   Response shape:
     { response_code: 200, status: 1, Data: [
         { videoCode: "<YouTube ID>", videoTitle, dateTime: "M/D/YYYY h:mm:ss A", ... }
     ]} */

const REP_VIDEOS_URL = '/api/media_Web';

state.repVideos = {
  loading: false,
  error: null,
  data: [],
  companyId: null,
  companyName: '',
  open: false,
  // Map<CompanyID, videos[]> — full per-company response, populated by
  // both the precheck pass and the modal open path. Reopening a modal
  // for a previously-checked company hits this cache, no network.
  cache: new Map(),
  // Map<CompanyID, boolean> — "do we know whether this company has any
  // videos at all". Read by injectRepVideosButtonInto / the kickoff
  // sweep so we never re-fetch the same company twice in a session.
  hasVideosMap: new Map(),
  // Map<CompanyID, Promise> — deduplicates in-flight precheck fetches.
  // Two cards for the same company rendered at the same time will share
  // one Promise instead of firing two requests.
  inFlight: new Map(),
};

function videoIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:13px;height:13px;vertical-align:-2px;margin-right:4px"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
}

function fmtVideoDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return String(s); }
}

async function loadCompanyVideos(companyId, companyName) {
  if (!companyId) return;
  const cid = String(companyId);
  state.repVideos.companyId = cid;
  state.repVideos.companyName = companyName || '';
  state.repVideos.open = true;

  // Cache hit — instant render, no network. The precheck pass typically
  // populates this for every visible company, so most modal opens hit
  // the cache directly.
  if (state.repVideos.cache.has(cid)) {
    state.repVideos.data = state.repVideos.cache.get(cid);
    state.repVideos.loading = false;
    state.repVideos.error = null;
    renderRepVideoModal();
    return;
  }

  state.repVideos.loading = true;
  state.repVideos.error = null;
  state.repVideos.data = [];
  renderRepVideoModal();

  try {
    const res = await fetch(REP_VIDEOS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      // Payload is a SINGLE-ITEM ARRAY; the endpoint won't accept the bare
      // object. Note: `userid` is lowercase, `Type: "RR_Comments"` (request
      // side) elicits the RR_Media rows in the response, `IndustryID` is an
      // empty array (not empty string).
      body: JSON.stringify([{
        CompanyID: cid,
        userid: 1,
        videoCode: '',
        videoId: '',
        videoType: '',
        videoTitle: '',
        videoDescription: '',
        DocumentType: '',
        Type: 'RR_Comments',
        SectorID: '',
        IndustryID: []
      }])
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const videos = (json && Array.isArray(json.Data)) ? json.Data : [];
    state.repVideos.cache.set(cid, videos);
    state.repVideos.data = videos;
    state.repVideos.loading = false;
    renderRepVideoModal();
  } catch (e) {
    state.repVideos.error = e && e.message ? e.message : 'Failed to load videos';
    state.repVideos.loading = false;
    renderRepVideoModal();
  }
}

function closeRepVideoModal() {
  state.repVideos.open = false;
  renderRepVideoModal();
}

/* ============================ INTERVIEWS PRECHECK PIPELINE ============================
   After the report list renders, we walk the DOM, collect every unique
   CompanyID present, and for any we haven't already classified, fire a
   media_Web request to ask "does this company have any videos?". Result
   is cached in state.repVideos.hasVideosMap (boolean per company) AND
   state.repVideos.cache (full payload, so a subsequent modal-open hits
   the same cache).

   Concurrency is capped at 6. Without a cap, a 100-company report list
   would queue 100 simultaneous requests against the same endpoint —
   rude to the API and bad for first-paint network budget. With the cap,
   we get a small steady stream of requests while the user reads the page.

   When a company turns out to have videos, the Interviews button is
   injected into every visible card for that company via DOM manipulation
   (no whole-list re-render). When the user later changes filters and the
   same company reappears, the kickoff sweep finds the existing
   classification and injects the button immediately. */

const REP_VIDEOS_PRECHECK_CONCURRENCY = 6;

async function precheckCompanyVideos(companyId) {
  const cid = String(companyId);
  if (!cid) return;
  if (state.repVideos.hasVideosMap.has(cid)) return;             // already classified
  if (state.repVideos.inFlight.has(cid)) return state.repVideos.inFlight.get(cid); // dedupe

  const promise = (async () => {
    try {
      const res = await fetch(REP_VIDEOS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify([{
          CompanyID: cid, userid: 1, videoCode: '', videoId: '',
          videoType: '', videoTitle: '', videoDescription: '',
          DocumentType: '', Type: 'RR_Comments', SectorID: '', IndustryID: []
        }])
      });
      if (!res.ok) return;                                        // leave unclassified — may retry on next render
      const json = await res.json();
      const videos = (json && Array.isArray(json.Data))
        ? json.Data.filter(v => v && String(v.videoCode || '').trim())
        : [];
      // Populate both maps so the modal-open path uses the same data
      // (no second network request when the user actually clicks).
      state.repVideos.cache.set(cid, videos);
      state.repVideos.hasVideosMap.set(cid, videos.length > 0);
      if (videos.length > 0) injectRepVideosButtonInto(cid);
    } catch (_) {
      // Silent: a network failure shouldn't surface anywhere on the
      // report card. The button just doesn't appear; user can still
      // interact with the rest of the card normally.
    } finally {
      state.repVideos.inFlight.delete(cid);
    }
  })();

  state.repVideos.inFlight.set(cid, promise);
  return promise;
}

// Runs `worker(item)` over `items` with up to `limit` running concurrently.
// Resolves once every item is done (or worker has thrown — errors are
// swallowed so one bad item doesn't poison the rest of the queue).
async function runWithConcurrency(items, limit, worker) {
  if (!items.length) return;
  const queue = items.slice();
  const tasks = [];
  const n = Math.min(limit, queue.length);
  for (let i = 0; i < n; i++) {
    tasks.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        try { await worker(item); } catch (_) { /* swallow */ }
      }
    })());
  }
  await Promise.all(tasks);
}

// Inserts an "Interviews" button into every visible report card belonging
// to the given CompanyID. Safe to call multiple times — the .rep-videos-btn
// duplicate guard prevents the button from being added twice.
function injectRepVideosButtonInto(companyId) {
  const cid = String(companyId);
  if (!cid) return;
  // CSS.escape() defends against any odd characters in the id, though in
  // practice the API only returns numeric strings.
  const escaped = (window.CSS && CSS.escape) ? CSS.escape(cid) : cid;
  const cards = document.querySelectorAll(`.rep-card[data-cid="${escaped}"]`);
  cards.forEach(card => {
    const actions = card.querySelector('.rep-actions');
    if (!actions) return;
    if (actions.querySelector('.rep-videos-btn')) return;          // already injected

    const cname = card.dataset.cname || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'doc-btn rep-videos-btn';
    btn.dataset.cid = cid;
    btn.dataset.cname = cname;
    btn.title = 'Management interview videos';
    btn.innerHTML = videoIcon() + 'Interviews';
    actions.appendChild(btn);
  });
}

// Called from the report list render path (right after wrap.innerHTML is
// set) — scans the DOM, identifies unique CompanyIDs, and starts/resumes
// the precheck queue. Already-classified companies trigger immediate
// injection if they have videos; unclassified ones get queued.
function kickoffRepVideoPrechecks() {
  const cards = document.querySelectorAll('.rep-card[data-cid]');
  if (!cards.length) return;
  const uniqueCids = new Set();
  cards.forEach(c => { if (c.dataset.cid) uniqueCids.add(c.dataset.cid); });

  const toCheck = [];
  uniqueCids.forEach(cid => {
    if (state.repVideos.hasVideosMap.has(cid)) {
      // Already classified — inject immediately if the answer was "yes"
      if (state.repVideos.hasVideosMap.get(cid) === true) {
        injectRepVideosButtonInto(cid);
      }
    } else if (!state.repVideos.inFlight.has(cid)) {
      toCheck.push(cid);
    }
  });

  if (toCheck.length) {
    runWithConcurrency(toCheck, REP_VIDEOS_PRECHECK_CONCURRENCY, precheckCompanyVideos);
  }
}

function renderVideoCard(v) {
  const code = String(v.videoCode || '').trim();
  if (!code) return '';
  // videoCode is the YouTube video ID; hqdefault thumbnails are 480×360
  // and always present (YouTube serves a placeholder if the ID is invalid,
  // and we hide the <img> on error so the gradient backdrop shows through).
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(code)}`;
  const thumb = `https://img.youtube.com/vi/${encodeURIComponent(code)}/hqdefault.jpg`;
  const title = String(v.videoTitle || 'Management Interview').trim();
  const date = fmtVideoDate(v.dateTime);
  return `<a class="rep-video-card" href="${safeAttr(url)}" target="_blank" rel="noopener noreferrer">
    <div class="rep-video-thumb">
      <img src="${safeAttr(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">
      <div class="rep-video-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
    </div>
    <div class="rep-video-info">
      <div class="rep-video-title">${escapeHtml(title)}</div>
      <div class="rep-video-date">${escapeHtml(date)}</div>
    </div>
  </a>`;
}

function renderRepVideoModal() {
  const modal = document.getElementById('repVideoModal');
  const body  = document.getElementById('repVideoModalBody');
  const titleEl = document.getElementById('repVideoModalCompany');
  if (!modal || !body) return;

  if (!state.repVideos.open) {
    modal.hidden = true;
    document.body.style.overflow = '';
    return;
  }

  modal.hidden = false;
  // Lock page scroll while the modal is open
  document.body.style.overflow = 'hidden';
  if (titleEl) titleEl.textContent = state.repVideos.companyName || 'Company';

  if (state.repVideos.loading) {
    body.innerHTML = '<div class="rep-video-status"><span class="rvm-spinner"></span>Loading interview videos…</div>';
    return;
  }

  if (state.repVideos.error) {
    body.innerHTML = `<div class="rep-video-status">Couldn't load videos — ${escapeHtml(state.repVideos.error)}</div>`;
    return;
  }

  const videos = (state.repVideos.data || []).filter(v => v && String(v.videoCode || '').trim());
  if (!videos.length) {
    body.innerHTML = '<div class="rep-video-status">No management interview videos available for this company.</div>';
    return;
  }

  // Sort latest first by dateTime — the API returns rows newest-first
  // already, but resort defensively in case the order changes.
  const sorted = videos.slice().sort((a, b) => {
    const da = new Date(a.dateTime || 0).getTime() || 0;
    const db = new Date(b.dateTime || 0).getTime() || 0;
    return db - da;
  });

  const word = sorted.length === 1 ? 'interview' : 'interviews';
  body.innerHTML = `
    <div class="rep-video-count">${sorted.length} ${word} · latest first</div>
    <div class="rep-video-grid">
      ${sorted.map(renderVideoCard).join('')}
    </div>
  `;
}

// Event delegation: a single click listener on the document handles both
// opening (a .rep-videos-btn was clicked) and closing (X button or
// backdrop). Avoids per-card listeners which would leak when the report
// list re-renders.
document.addEventListener('click', e => {
  const openBtn = e.target.closest('.rep-videos-btn[data-cid]');
  if (openBtn) {
    e.preventDefault();
    loadCompanyVideos(openBtn.dataset.cid, openBtn.dataset.cname || '');
    return;
  }
  if (e.target.closest('.rep-video-modal-close')) {
    closeRepVideoModal();
    return;
  }
  if (e.target.classList && e.target.classList.contains('rep-video-modal-backdrop')) {
    closeRepVideoModal();
    return;
  }
});

// Esc closes the modal if open. Scoped to when state says it's open so
// we don't intercept Esc for other components.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.repVideos && state.repVideos.open) {
    closeRepVideoModal();
  }
});

/* ---- Wiring ---- */
function wireReportsFilters() {
  // Period pill row — clicking a preset writes that period id AND its
  // computed from/to dates into pendingFilters (so Apply picks them up
  // as a normal date change). Clicking Custom just flips into the
  // editable-date mode; dates stay whatever they were. Then we re-render
  // the whole panel so the Custom inputs appear/disappear correctly —
  // cheap because pendingFilters drives the next paint.
  document.querySelectorAll('#repPeriodRow [data-period]').forEach(btn => {
    btn.onclick = () => {
      const pid = btn.dataset.period;
      setPendingFilter('period', pid);
      if (pid !== 'custom') {
        const r = periodToDateRange(pid);
        if (r) {
          setPendingFilter('dateFrom', r.from);
          setPendingFilter('dateTo',   r.to);
        }
      }
      renderReportsPanel();
    };
  });

  // From / To inputs only exist in the DOM when Custom is the active
  // period. Their onchange writes the new date AND pins period to
  // 'custom' (in case the user later un-pins it by clicking a preset).
  const repFrom = document.getElementById('repFrom');
  const repTo   = document.getElementById('repTo');
  if (repFrom) repFrom.onchange = (e) => { setPendingFilter('dateFrom', e.target.value); setPendingFilter('period', 'custom'); };
  if (repTo)   repTo.onchange   = (e) => { setPendingFilter('dateTo',   e.target.value); setPendingFilter('period', 'custom'); };

  // Search: typing is also "pending"; Enter triggers Apply. The wrapper
  // gets/loses the .has-value class so the × clear button shows/hides.
  const search  = document.getElementById('repSearch');
  const sWrap   = document.getElementById('repSearchWrap');
  const sClear  = document.getElementById('repSearchClear');
  search.oninput = () => {
    setPendingFilter('query', search.value.trim());
    if (sWrap) sWrap.classList.toggle('has-value', search.value.length > 0);
  };
  search.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyOrResetClick(); }
  };
  if (sClear) sClear.onclick = () => {
    search.value = '';
    if (sWrap) sWrap.classList.remove('has-value');
    setPendingFilter('query', '');
    search.focus();
    // If the search was the only dirty bit, Apply→Reset toggle should
    // recompute; the next setPendingFilter already ran so the dirty
    // check has fresh state. Just force a header repaint:
    if (typeof refreshApplyResetButton === 'function') refreshApplyResetButton();
  };

  // Single Apply/Reset toggle button
  document.getElementById('repApplyReset').onclick = applyOrResetClick;

  // Wire each searchable dropdown — all three are multi-select now.
  wireSearchableSelect(document.getElementById('repSelSector'),  { key: 'sectorIds',  placeholder: 'All sectors',   buildOptions: buildSectorOptions });
  wireSearchableSelect(document.getElementById('repSelCompany'), { key: 'companyIds', placeholder: 'All companies', buildOptions: buildCompanyOptions, hideSub: true });
  wireSearchableSelect(document.getElementById('repSelBroker'),  { key: 'brokerIds',  placeholder: 'All brokers',   buildOptions: buildBrokerOptions });
}

function wireSearchableSelect(el, spec) {
  if (!el) return;
  const btn      = el.querySelector('.ssel-btn');
  const labelEl  = el.querySelector('.ssel-label');
  const clearEl  = el.querySelector('.ssel-clear');
  const panel    = el.querySelector('.ssel-panel');
  const list     = el.querySelector('.ssel-list');
  const search   = el.querySelector('.ssel-search');
  const allOptions = spec.buildOptions();
  const hideSub  = !!spec.hideSub;

  // Re-derive the label + clear-button visibility from the pending array.
  function syncTrigger() {
    const cur = state.reports.pendingFilters[spec.key] || [];
    const selSet = new Set(cur.map(String));
    const selected = allOptions.filter(o => selSet.has(String(o.value)));
    let text, hasValue;
    if (selected.length === 0)      { text = spec.placeholder;   hasValue = false; }
    else if (selected.length === 1) { text = selected[0].label;  hasValue = true; }
    else                            { text = `${selected.length} selected`; hasValue = true; }
    labelEl.textContent = text;
    btn.title = text;
    btn.classList.toggle('has-value', hasValue);
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    if (el.classList.contains('open')) { closeOpenSsel(); return; }
    openSselPanel(el);
    const selSet = new Set((state.reports.pendingFilters[spec.key] || []).map(String));
    list.innerHTML = renderSselOptions(allOptions.slice(0, 200), selSet, hideSub);
    bindOptionClicks();
    focusFirstSselOpt(el);
    if (search) { search.value = ''; setTimeout(() => search.focus(), 30); }
  };

  if (clearEl) {
    clearEl.onclick = (e) => {
      e.stopPropagation();          // don't bubble into the trigger button
      // The user just told us they want this filter gone. Clear BOTH pending
      // AND applied for this single axis. Narrowing filters are now
      // client-side, so dropping one is an instant re-render against the
      // cached set — no network call. Other pending changes (dates,
      // search, other dropdowns) stay pending — Apply still governs those.
      state.reports.pendingFilters[spec.key] = [];
      state.reports.filters[spec.key]        = [];
      state.reports.filters.typeFilter       = new Set();   // type pills are scoped to the current dataset
      syncTrigger();
      if (el.classList.contains('open')) {
        list.querySelectorAll('.ssel-opt.selected').forEach(o => o.classList.remove('selected'));
      }
      updateApplyResetButton();
      if (state.tab === 'reports') {
        renderReportsList();
        renderTabCounts();
      }
      notifyDrSearch();
    };
  }

  if (search) {
    search.oninput = () => {
      const q = search.value.toLowerCase().trim();
      let opts;
      if (!q) opts = allOptions.slice(0, 200);
      else {
        const out = [];
        for (let i = 0; i < allOptions.length; i++) {
          const o = allOptions[i];
          if (String(o.label).toLowerCase().indexOf(q) !== -1 ||
              String(o.sub   || '').toLowerCase().indexOf(q) !== -1) out.push(o);
          if (out.length >= 150) break;
        }
        opts = out;
      }
      const selSet = new Set((state.reports.pendingFilters[spec.key] || []).map(String));
      list.innerHTML = renderSselOptions(opts, selSet, hideSub);
      bindOptionClicks();
      focusFirstSselOpt(el);
    };
  }

  function bindOptionClicks() {
    list.querySelectorAll('.ssel-opt').forEach(o => {
      o.onclick = (e) => {
        e.stopPropagation();          // panel stays open for multi-pick
        const v = o.dataset.value;
        const current = (state.reports.pendingFilters[spec.key] || []).slice();
        const idx = current.indexOf(v);
        if (idx >= 0) current.splice(idx, 1);
        else current.push(v);
        setPendingFilter(spec.key, current);
        o.classList.toggle('selected');
        syncTrigger();
      };
    });
  }
}

// Mark the first visible option as keyboard-focused so Enter selects it.
function focusFirstSselOpt(sselEl) {
  if (!sselEl) return;
  sselEl.querySelectorAll('.ssel-opt').forEach(o => o.classList.remove('focused'));
  const first = sselEl.querySelector('.ssel-opt');
  if (first) first.classList.add('focused');
}

// Move keyboard focus by `delta` options (wraps), scroll into view.
function moveSselFocus(delta) {
  if (!openSsel) return;
  const opts = openSsel.querySelectorAll('.ssel-opt');
  if (!opts.length) return;
  let idx = -1;
  opts.forEach((o, i) => { if (o.classList.contains('focused')) idx = i; });
  let next = idx + delta;
  if (next < 0) next = opts.length - 1;
  if (next >= opts.length) next = 0;
  opts.forEach((o, i) => o.classList.toggle('focused', i === next));
  opts[next].scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

function activateFocusedSselOpt() {
  if (!openSsel) return;
  const focused = openSsel.querySelector('.ssel-opt.focused');
  if (focused) focused.click();
}

function openSselPanel(el) {
  if (openSsel === el) return;
  closeOpenSsel();
  openSsel = el;
  el.classList.add('open');
  el.querySelector('.ssel-btn').setAttribute('aria-expanded', 'true');
}
function closeOpenSsel() {
  if (!openSsel) return;
  openSsel.classList.remove('open');
  const btn = openSsel.querySelector('.ssel-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  openSsel = null;
}
// Click outside any dropdown closes it.
document.addEventListener('click', (e) => {
  if (openSsel && !e.target.closest('.ssel')) closeOpenSsel();
});
// Keyboard: Escape closes; Up/Down navigate the visible option list; Enter selects.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSsel) { closeOpenSsel(); return; }
  if (!openSsel) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSselFocus(1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); moveSselFocus(-1); }
  else if (e.key === 'Enter')     { e.preventDefault(); activateFocusedSselOpt(); }
});

/* ---- Auto-refresh + updated caption ---- */
function updateRepUpdatedCaption() {
  const el = document.getElementById('repUpdated');
  if (!el) return;
  if (!state.reports.lastRefreshedAt) { el.textContent = ''; return; }
  el.textContent = 'Updated ' + fmtAgo(state.reports.lastRefreshedAt);
}
function startRepAutoRefresh() {
  if (repAutoRefreshTimer) clearInterval(repAutoRefreshTimer);
  repAutoRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.tab !== 'reports') return;
    if (state.reports.loading) return;
    if (!state.reports.loaded) return;
    loadReports({ force: true });
  }, REP_AUTO_REFRESH_MS);

  if (repUpdatedCaptionTimer) clearInterval(repUpdatedCaptionTimer);
  repUpdatedCaptionTimer = setInterval(updateRepUpdatedCaption, 30 * 1000);
}


/* ============================ ACTIONS ============================ */
// Anything that changes the filter scope needs to reset the chunk cursor and
// invalidate the memo so the next render picks up the new filter.
function onScopeChanged() {
  state.ann.visible = CHUNK_SIZE;
  annInvalidateCache();
  // TV bytes: bust the memoized filter result + reset visible chunk so the
  // new watchlist scope flows through on the next render.
  state.tv.cache.sig = null;
  state.tv.visible = 50;
}

function toggleWl(id) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    state.selected.add(id);
    // Activating a watchlist scope: make sure its companies are loaded from
    // the server (input:4) so the Corp Announcement filter has the real
    // company set, not just whatever was in localStorage.
    const w = WATCHLISTS.find(x => x.id === id);
    if (w) ensureWatchlistCompaniesLoaded(w, false);
  }
  onScopeChanged();
  refresh();
}
function resetWl() {
  state.selected = new Set(['default']);
  onScopeChanged();
  refresh();
}

/* ============================ MGMT TV BYTES ============================
   Live API: management video appearances (TV / podcast / social clips),
   per-company, with bulleted takeaways and a YouTube link. Defensive
   normalizer because the raw API shape isn't documented here — see
   normalizeTvEntry() for the field-name aliases it tries.
   ====================================================================== */
const TV_API_URL = '/occ-api/companyblogdetails2';
const TV_PAYLOAD = { slug: 'management-bytes-on-media', user_id: 1534 };

let tvSearchDebounceTimer = null;
let tvAbortController = null;

/* ---- Helpers: video / date / bullets ---- */
function tvGetVideoId(url) {
  if (!url) return null;
  const s = String(url);
  // watch?v=ID, &v=ID
  let m = s.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  // youtu.be/ID, /embed/ID, /live/ID, /shorts/ID, /v/ID
  m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:embed|live|shorts|v)\/)([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  return null;
}
function tvExtractYouTubeUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}
function tvThumbUrl(videoId) {
  return videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
}
function tvParseDate(s) {
  if (!s) return null;
  // ISO, RFC, "YYYY-MM-DD …", "DD-MM-YYYY", "DD/MM/YYYY". Try Date() first
  // (handles ISO and most variants), then fall back to a DD-MM-YYYY parse.
  let d = new Date(s);
  if (!isNaN(d)) return d;
  const m = String(s).match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) {
    d = new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    if (!isNaN(d)) return d;
  }
  return null;
}
function tvFmtDayLabel(d) {
  if (!d) return 'Undated';
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = n => String(n).padStart(2,'0');
  return `${days[d.getDay()]}, ${p(d.getDate())}-${mons[d.getMonth()]}-${d.getFullYear()}`;
}
function tvDayKey(d) {
  if (!d) return 'undated';
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// Parse a Market Cap string (e.g. "23,108 cr", "8,92,785 cr", "₹3,169 cr") into
// a numeric value in crores. Indian numbering with multiple commas — handle
// by stripping ALL commas, the ₹ symbol, whitespace, and the "cr"/"crore"
// /"crores" suffix, then parsing what's left as a float. Returns null when
// nothing usable comes out (so callers can fall the entry to the bottom of
// the sort instead of treating a missing value as zero).
function tvParseMarketCap(s) {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/[₹,]/g, '')
    .replace(/\s+/g, '')
    .replace(/cr(ore)?s?$/i, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Pull bulleted takeaways out of arbitrary content. Order of attempts:
// 1) if value is already an array of strings, use it
// 2) if it looks like HTML, extract <li> contents
// 3) split on bullet glyphs (•) or newlines
function tvExtractBullets(content) {
  if (!content) return [];
  if (Array.isArray(content)) {
    return content.map(s => String(s).trim()).filter(Boolean);
  }
  const s = String(content);

  if (/<li[\s>]/i.test(s)) {
    const out = [];
    const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      // Strip nested tags and decode common entities
      const txt = m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      if (txt) out.push(txt);
    }
    if (out.length) return out;
  }

  // Strip remaining HTML, then split on bullet glyphs or newlines
  const plain = s.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').trim();
  const parts = plain.split(/[\n•\u2022]+/).map(p => p.trim()).filter(Boolean);
  return parts;
}

/* ---- Parser: addon HTML blob -> per-company entries ----
   Real API shape (verified 2026-06-03):
     {
       msg, blog,                                                 (metadata)
       BlogAddonTot_date:     ["2026-06-03", "2026-06-02", ...]   (date strings, may have dupes)
       BlogAddonTot_date_new: ["2026-06-03__2851", ...]           (date__addonId pairs)
       BlogAddonTot:          [{ id, slug, discription, tag, ... }]  (typically one addon: the latest date)
     }

   The 'discription' field is a single HTML blob holding ~10-15 company
   sections in this repeating pattern (one section per company):

     <ol [start="N"]><li><strong>Company Name (Person, Role):</strong></li></ol>
     <p>...<strong>Industry: Auto Ancillary</strong>...</p>
     <p>...<strong>Market Cap: 23,108 cr</strong>...</p>
     <ul>
       <li>Bullet 1</li>
       <li>Bullet 2 (may contain nested <ul> with sub-bullets)</li>
       ...
     </ul>
     <p>Link: <a href="https://youtu.be/...">https://youtu.be/...</a></p>

   The parser walks the body's direct children left-to-right. State machine:
     <ol>  -> flush previous entry, open new entry (extract company + person from text)
     <p>   -> check if Industry / Market Cap / Link prefix, fill that slot on the open entry
     <ul>  -> collect bullets into the open entry, flattening any nested <ul>/<ol>
*/
function tvParseAddonToEntries(addon, dateStr) {
  const html = addon && addon.discription;
  if (!html) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const entries = [];
  const dateObj = tvParseDate(dateStr);
  const dateLbl = tvFmtDayLabel(dateObj);
  const dayK = dateStr || (dateObj ? tvDayKey(dateObj) : 'undated');
  let current = null;
  let idx = 0;

  const flush = () => {
    if (current && current.company) entries.push(current);
    current = null;
  };

  for (const el of Array.from(doc.body.children)) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text && tag !== 'ul' && tag !== 'ol') continue;   // skip empty spacer paragraphs

    if (tag === 'ol') {
      flush();
      // Strip trailing colon; try to extract "(person, role)" parenthetical
      let head = text.replace(/[:\s]+$/, '').trim();
      let company, person;
      const m = head.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (m) { company = m[1].trim(); person = m[2].trim(); }
      else   { company = head;        person = null; }
      current = {
        id: 'tv-' + addon.id + '-' + idx,
        idx,
        date: dateObj,
        dateLabel: dateLbl,
        dayKey: dayK,
        company,
        person,
        industry: null,
        marketCap: null,
        marketCapValue: null,    // numeric crores parsed from marketCap, used for sorting
        bullets: [],
        youtubeUrl: null,
        videoId: null,
        thumbUrl: null,
      };
      idx++;
      continue;
    }

    if (!current) continue;       // anything before the first <ol> is the header banner; skip

    if (tag === 'p') {
      if (/^industry\s*:/i.test(text)) {
        current.industry = text.replace(/^industry\s*:\s*/i, '').trim();
      } else if (/^market\s*cap\s*:/i.test(text)) {
        current.marketCap = text.replace(/^market\s*cap\s*:\s*/i, '').trim();
        current.marketCapValue = tvParseMarketCap(current.marketCap);
      } else if (/^link\s*:/i.test(text)) {
        const a = el.querySelector('a[href]');
        if (a) {
          current.youtubeUrl = a.getAttribute('href');
          current.videoId = tvGetVideoId(current.youtubeUrl);
          current.thumbUrl = tvThumbUrl(current.videoId);
        } else {
          // Fallback: scan raw text for any YouTube URL
          const u = tvExtractYouTubeUrl(text);
          if (u) {
            current.youtubeUrl = u;
            current.videoId = tvGetVideoId(u);
            current.thumbUrl = tvThumbUrl(current.videoId);
          }
        }
      }
      continue;
    }

    if (tag === 'ul') {
      // Walk every descendant <li>, but strip nested <ul>/<ol> from each so a
      // parent bullet doesn't swallow its children's text (which would then be
      // duplicated when those children are themselves visited).
      el.querySelectorAll('li').forEach(li => {
        const clone = li.cloneNode(true);
        clone.querySelectorAll('ul, ol').forEach(n => n.remove());
        const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) current.bullets.push(t);
      });
      continue;
    }
  }

  flush();
  return entries;
}

/* ---- Fetch ---- */
async function loadTvBytes({ force = false } = {}) {
  if (state.tv.loading) return;
  if (state.tv.loaded && !force) return;

  if (tvAbortController) tvAbortController.abort();
  tvAbortController = new AbortController();
  const signal = tvAbortController.signal;

  state.tv.loading = true;
  state.tv.error = null;
  if (state.tab === 'tvbytes') renderTvBytesPanel();   // immediate spinner

  try {
    const res = await fetch(TV_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(TV_PAYLOAD),
      signal,
    });
    if (signal.aborted) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (signal.aborted) return;

    state.tv.rawShape = (json && typeof json === 'object' && !Array.isArray(json))
      ? Object.keys(json)
      : (Array.isArray(json) ? '[array]' : typeof json);

    // Parse each addon (each is one day's HTML blob) into per-company entries.
    // The date for each addon is recovered by matching its id against the
    // BlogAddonTot_date_new array (entries are "YYYY-MM-DD__<id>").
    const addons = Array.isArray(json && json.BlogAddonTot) ? json.BlogAddonTot : [];
    const dateNew = Array.isArray(json && json.BlogAddonTot_date_new) ? json.BlogAddonTot_date_new : [];
    const dateById = new Map();
    for (const p of dateNew) {
      const i = String(p).indexOf('__');
      if (i > 0) dateById.set(Number(p.slice(i + 2)), p.slice(0, i));
    }
    const items = [];
    for (const addon of addons) {
      const dateStr = dateById.get(addon.id) || null;
      items.push(...tvParseAddonToEntries(addon, dateStr));
    }

    state.tv.items = items;
    state.tv.loadedAddonIds = new Set(addons.map(a => a.id));
    state.tv.availableDates = dateNew
      .map(p => { const i = String(p).indexOf('__'); return i > 0 ? { date: p.slice(0, i), id: Number(p.slice(i + 2)) } : null; })
      .filter(Boolean);
    // Default the from-to range to the latest available date so the page opens
    // showing today's bytes scoped to "today only". Only applied when the
    // user hasn't already set a range — re-fetches don't clobber user input.
    if (state.tv.availableDates.length && !state.tv.dateFrom && !state.tv.dateTo) {
      const latest = state.tv.availableDates[0].date;
      state.tv.dateFrom = latest;
      state.tv.dateTo = latest;
    }
    state.tv.loaded = true;
    state.tv.lastRefreshedAt = Date.now();
  } catch (e) {
    if (signal.aborted || (e && e.name === 'AbortError')) return;
    state.tv.error = e && e.message ? e.message : 'Network error';
  } finally {
    if (signal.aborted) return;
    state.tv.loading = false;
    if (state.tab === 'tvbytes') renderTvBytesPanel();
    renderTabCounts();
    notifyDrSearch();
  }
}

/* ---- Historical fetch ----
   When the user picks a from-to date range that includes days other than
   the latest, fire one fetch per missing addon and merge the parsed
   entries into state.tv.items.

   Payload shape (verified against the live API on 2026-06-04):
     { slug, user_id, date: "YYYY-MM-DD", addon_id: "<id as string>" }
   addon_id is sent as a STRING because the API sample shows it quoted
   ("2848"), not as an integer — coerce defensively to match.

   Concurrency: all missing addons are fetched in parallel via
   Promise.allSettled — wide ranges (30+ days) will produce a burst, which
   is fine for typical usage. If rate limiting becomes an issue, chunk this
   with a small concurrency window. */
let tvHistAbortController = null;

async function loadTvBytesAddons(addonIds) {
  if (!Array.isArray(addonIds) || !addonIds.length) return;
  const toLoad = addonIds.filter(id => !state.tv.loadedAddonIds.has(id));
  if (!toLoad.length) return;

  // Abort any in-flight historical fetches so the latest range wins
  if (tvHistAbortController) tvHistAbortController.abort();
  tvHistAbortController = new AbortController();
  const signal = tvHistAbortController.signal;

  state.tv.loading = true;
  if (state.tab === 'tvbytes') renderTvList();   // show spinner immediately

  // Build a quick id->date lookup so each response knows what day it's for
  const dateById = new Map(state.tv.availableDates.map(d => [d.id, d.date]));

  const promises = toLoad.map(async id => {
    const dateStr = dateById.get(id);
    if (!dateStr) return null;        // shouldn't happen — guard anyway
    try {
      const res = await fetch(TV_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          ...TV_PAYLOAD,
          date: dateStr,
          addon_id: String(id),       // API expects this quoted; coerce
        }),
        signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const addons = Array.isArray(json && json.BlogAddonTot) ? json.BlogAddonTot : [];
      // Pick the addon matching the requested id; fall back to whatever came back
      const addon = addons.find(a => a.id === id) || addons[0];
      if (!addon) return null;
      return { id, entries: tvParseAddonToEntries(addon, dateStr) };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // Surface to console rather than throwing — one bad day shouldn't
      // wipe out the whole batch.
      console.warn('TV bytes: failed to load addon', id, e && e.message);
      return null;
    }
  });

  const results = await Promise.allSettled(promises);
  if (signal.aborted) return;

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      state.tv.items.push(...r.value.entries);
      state.tv.loadedAddonIds.add(r.value.id);
    }
  }

  state.tv.loading = false;
  state.tv.cache.sig = null;
  if (state.tab === 'tvbytes') {
    renderTvSectorRow();
    renderTvList();
  }
  renderTabCounts();
  notifyDrSearch();
}

// Resolve a from-to date range against the available-dates list, return the
// addon ids that fall inside it.
function tvAddonIdsInRange(from, to) {
  if (!from && !to) return [];
  const fromT = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
  const toT   = to   ? new Date(to   + 'T23:59:59.999').getTime() : Infinity;
  const ids = [];
  for (const d of state.tv.availableDates) {
    const t = new Date(d.date + 'T12:00:00').getTime();   // noon avoids DST edge cases
    if (t >= fromT && t <= toT) ids.push(d.id);
  }
  return ids;
}

/* ---- Filter pipeline ----
   Pipeline order: search → date range → industry. The watchlist scope is
   NOT applied here: the addon HTML doesn't carry NSE / BSE codes, so a
   reliable match against state.selected's ticker scope isn't possible.
   The watchlist row above the page still drives Corp Announcement and
   Reports as usual; TV bytes simply ignores it. */
function tvFilterSig() {
  const sec = [...(state.tv.sector || [])].sort().join(',');
  return state.tv.items.length + '|' + (state.tv.lastRefreshedAt || 0) + '|' + state.tv.query + '|' + state.tv.dateFrom + '|' + state.tv.dateTo + '|' + sec;
}

// Items that pass everything EXCEPT the industry filter. Used by the
// industry-pill count chips so they shrink with the search query without
// shrinking when the user picks a different industry pill.
function tvSearchedItems() {
  const q = state.tv.query;
  const from = state.tv.dateFrom ? new Date(state.tv.dateFrom + 'T00:00:00') : null;
  const to   = state.tv.dateTo   ? new Date(state.tv.dateTo   + 'T23:59:59.999') : null;
  let out = state.tv.items;
  if (q) {
    out = out.filter(it => {
      const co = (it.company || '').toLowerCase();
      const pe = (it.person || '').toLowerCase();
      const ind = (it.industry || '').toLowerCase();
      if (co.indexOf(q) !== -1 || pe.indexOf(q) !== -1 || ind.indexOf(q) !== -1) return true;
      for (const b of it.bullets) if (b.toLowerCase().indexOf(q) !== -1) return true;
      return false;
    });
  }
  if (from || to) {
    out = out.filter(it => {
      if (!it.date) return false;
      const t = it.date.getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    });
  }
  return out;
}

function tvFiltered() {
  const sig = tvFilterSig();
  if (state.tv.cache.sig === sig && state.tv.cache.items) return state.tv.cache.items;

  let out = tvSearchedItems();
  const sec = state.tv.sector;
  if (sec && sec.size && !sec.has('all')) {
    out = out.filter(it => sec.has((it.industry || '').toLowerCase()));
  }

  // Sort:
  //   1. Date desc (newest day first — drives the date headers)
  //   2. Within a day, Market Cap desc (largest company at the top of the day)
  //   3. Entries with no parseable market cap fall to the bottom of their day,
  //      preserving editorial order among themselves so the visual order stays
  //      stable for missing data
  //   4. Editorial order (idx) is the final tiebreaker when two companies share
  //      both day and market cap (rare in practice)
  out = out.slice().sort((a, b) => {
    const da = a.date ? a.date.getTime() : 0;
    const db = b.date ? b.date.getTime() : 0;
    if (db !== da) return db - da;
    const ma = a.marketCapValue;
    const mb = b.marketCapValue;
    if (ma == null && mb == null) return (a.idx || 0) - (b.idx || 0);
    if (ma == null) return 1;
    if (mb == null) return -1;
    if (mb !== ma) return mb - ma;
    return (a.idx || 0) - (b.idx || 0);
  });

  state.tv.cache = { sig, items: out };
  return out;
}

// Industry pill set is dynamic — derived from whatever industries are
// present in the loaded entries (typically one day's set). Each pill
// carries a count from the search-filtered subset.
function tvIndustryList() {
  const counts = new Map();
  for (const it of tvSearchedItems()) {
    const k = (it.industry || '').trim();
    if (!k) continue;
    counts.set(k.toLowerCase(), { label: k, count: (counts.get(k.toLowerCase())?.count || 0) + 1 });
  }
  return [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function tvGroupByDay(items) {
  const map = new Map();
  for (const it of items) {
    const k = it.dayKey;
    if (!map.has(k)) map.set(k, { key: k, label: it.dateLabel, items: [] });
    map.get(k).items.push(it);
  }
  return [...map.values()];
}

/* ---- Render: panel shell ---- */
function renderTvBytesPanel() {
  const panel = $('#panel');
  if (!panel) return;

  // Error w/ no fallback data → full error card
  if (state.tv.error && !state.tv.items.length) {
    panel.innerHTML = `<div class="tv-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div class="et">Couldn’t load TV bytes</div>
      <div class="es">${escapeHtml(state.tv.error)}.<br>Check that <code>${escapeHtml(TV_API_URL)}</code> is reachable and returns CORS headers for this origin.</div>
      <button class="btn-accent" id="tvRetry">Retry</button>
    </div>`;
    const r = document.getElementById('tvRetry');
    if (r) r.onclick = () => loadTvBytes({ force: true });
    return;
  }

  // Build shell (search + date range + status + industry-pill row + feed
  // slot). Each subsequent render only touches inner #tvListWrap /
  // #tvSectorRow so the search input retains focus across keystrokes.
  // Date range min/max comes from BlogAddonTot_date_new (the available
  // history window from the API).
  const dates = state.tv.availableDates;
  const minDate = dates.length ? dates[dates.length - 1].date : '';
  const maxDate = dates.length ? dates[0].date : '';
  panel.innerHTML = `<div class="tv-wrap">
    <section class="tv-filters" aria-label="TV Bytes filters">
      <div class="tv-filter-row">
        <div class="tv-search ${state.tv.query ? 'has-value' : ''}" id="tvSearchShell">
          <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="tvSearchInput" type="text" placeholder="Search company, person, industry, or takeaway…" value="${escapeHtml(state.tv.query || '')}" autocomplete="off" spellcheck="false">
          <button class="sclear" id="tvSearchClear" aria-label="Clear search" title="Clear">×</button>
        </div>
        <span class="tv-search-count" id="tvSearchCount"></span>
        <div class="tv-date-range" id="tvDateRange" role="group" aria-label="Filter by date">
          <label class="tv-date-field">
            <span class="tv-date-label">From</span>
            <input type="date" id="tvDateFrom" value="${escapeHtml(state.tv.dateFrom)}" min="${escapeHtml(minDate)}" max="${escapeHtml(maxDate)}">
          </label>
          <span class="tv-date-sep" aria-hidden="true">→</span>
          <label class="tv-date-field">
            <span class="tv-date-label">To</span>
            <input type="date" id="tvDateTo" value="${escapeHtml(state.tv.dateTo)}" min="${escapeHtml(minDate)}" max="${escapeHtml(maxDate)}">
          </label>
          <button class="tv-date-clear" id="tvDateClear" type="button" title="Clear date range">Clear</button>
        </div>
      </div>
      <div id="tvSectorRow" class="tv-sector-row"></div>
    </section>
    <div id="tvListWrap"></div>
  </div>`;

  wireTvSearch();
  wireTvDateRange();
  renderTvSectorRow();
  renderTvList();
}

/* ---- Date range wiring ----
   Two HTMl <input type="date"> fields. 'change' fires only when the user
   commits the value (picks a day in the popup or types and tabs out), so
   we don't need additional debouncing. On commit, recompute the addon
   IDs in range and fire historical fetches for any not yet loaded. The
   filter sig change re-runs the list automatically. */
function wireTvDateRange() {
  const fromEl = document.getElementById('tvDateFrom');
  const toEl   = document.getElementById('tvDateTo');
  const clrEl  = document.getElementById('tvDateClear');
  if (!fromEl || !toEl) return;

  const applyRange = () => {
    const from = fromEl.value || '';
    const to   = toEl.value || '';
    // Auto-correct flipped range (user picked end before start)
    if (from && to && new Date(from) > new Date(to)) {
      toEl.value = from;
      state.tv.dateTo = from;
    } else {
      state.tv.dateTo = to;
    }
    state.tv.dateFrom = from;
    state.tv.cache.sig = null;
    state.tv.visible = 100;

    // Fetch any missing historical addons for the new range
    const ids = tvAddonIdsInRange(state.tv.dateFrom, state.tv.dateTo);
    const missing = ids.filter(id => !state.tv.loadedAddonIds.has(id));
    if (missing.length) {
      loadTvBytesAddons(missing);   // fires its own re-render when complete
    } else {
      renderTvSectorRow();
      renderTvList();
      renderTabCounts();
    }
  };

  fromEl.onchange = applyRange;
  toEl.onchange   = applyRange;
  // The Clear button restores the DEFAULT range — both fields set to the
  // latest available date — rather than emptying them. With empty fields
  // the date filter would be inactive (showing all loaded days, which is
  // confusing in a feed grouped by date); resetting to the latest is the
  // more predictable "back to default view" affordance.
  if (clrEl) clrEl.onclick = () => {
    const latest = state.tv.availableDates.length ? state.tv.availableDates[0].date : '';
    fromEl.value = latest;
    toEl.value   = latest;
    state.tv.dateFrom = latest;
    state.tv.dateTo   = latest;
    state.tv.cache.sig = null;
    state.tv.visible = 100;
    renderTvSectorRow();
    renderTvList();
    renderTabCounts();
  };
}

/* ---- Render: industry pill row (dynamic, derived from loaded entries) ---- */
function renderTvSectorRow() {
  const row = document.getElementById('tvSectorRow');
  if (!row) return;
  const list = tvIndustryList();
  const sel = state.tv.sector;
  const totalCount = tvSearchedItems().length;
  if (!list.length) { row.innerHTML = ''; return; }

  const allActive = sel.has('all');
  const pills = [
    `<button class="cat-pill${allActive ? ' active' : ''}" data-sec="all" type="button" style="--c:#0F172A;--c-soft:rgba(15,23,42,0.08);--c-tint:rgba(15,23,42,0.18)">All<span class="cat-cnt num">${totalCount.toLocaleString('en-IN')}</span></button>`,
    ...list.map(s => {
      const active = sel.has(s.key);
      // Per-pill color via colorFromString — deterministic from the industry
      // string so the same industry keeps the same hue across reloads.
      const c = colorFromString(s.label);
      const style = `--c:${c};--c-soft:${rgba(c, 0.08)};--c-tint:${rgba(c, 0.18)}`;
      return `<button class="cat-pill${active ? ' active' : ''}" data-sec="${safeAttr(s.key)}" type="button" style="${style}">${escapeHtml(s.label)}<span class="cat-cnt num">${s.count.toLocaleString('en-IN')}</span></button>`;
    }),
  ].join('');
  row.innerHTML = pills;

  row.querySelectorAll('button[data-sec]').forEach(btn => {
    btn.onclick = () => toggleTvSector(btn.dataset.sec);
  });
}

// Industry pill toggle (mirrors Corp Announcement category logic): "All" is
// mutually exclusive with specific pills; the set can never go empty (last
// pill removed falls back to "All").
function toggleTvSector(key) {
  const sel = state.tv.sector;
  if (key === 'all') {
    sel.clear();
    sel.add('all');
  } else {
    sel.delete('all');
    if (sel.has(key)) {
      sel.delete(key);
      if (sel.size === 0) sel.add('all');
    } else {
      sel.add(key);
    }
  }
  state.tv.cache.sig = null;
  renderTvSectorRow();
  renderTvList();
  renderTabCounts();
}

/* ---- Render: list (called on filter change without rebuilding shell) ---- */
function renderTvList() {
  const wrap = document.getElementById('tvListWrap');
  if (!wrap) return;

  const items = tvFiltered();
  const total = items.length;
  // No standalone count line — the per-day header carries its own count
  // ("Wednesday, 03-Jun-2026 · 5 bytes"). A small inline spinner appears
  // only while a fetch is in flight.
  const spinnerHtml = state.tv.loading
    ? `<div class="tv-status"><span class="tv-spinner" aria-label="Loading"></span><span class="tv-loading-text">Loading…</span></div>`
    : '';

  // Live search-count chip (visible only while a query is active)
  const sc = document.getElementById('tvSearchCount');
  if (sc) {
    if (state.tv.query) { sc.textContent = `${total} ${total === 1 ? 'match' : 'matches'}`; sc.style.display = ''; }
    else { sc.style.display = 'none'; }
  }

  // First load → skeletons
  if (!state.tv.loaded && state.tv.loading) {
    wrap.innerHTML = spinnerHtml + tvSkeletonHtml(3);
    return;
  }
  if (!total) {
    wrap.innerHTML = spinnerHtml + tvEmptyHtml();
    const clr = document.getElementById('tvClearFilters');
    if (clr) clr.onclick = (e) => { e.preventDefault(); tvClearAllFilters(); };
    return;
  }

  // Date sections
  const visible = Math.min(state.tv.visible, total);
  const slice = items.slice(0, visible);
  const groups = tvGroupByDay(slice);

  const sections = groups.map(g => `
    <section class="tv-date-section">
      <div class="tv-date-header">
        <span class="tv-date-day">${escapeHtml(g.label)}</span>
        <span class="tv-date-dot"></span>
        <span class="tv-date-count num">${g.items.length} byte${g.items.length === 1 ? '' : 's'}</span>
      </div>
      ${g.items.map(it => renderTvCard(it)).join('')}
    </section>`).join('');

  let html = spinnerHtml + `<div class="tv-feed ${state.tv.loading ? 'is-loading' : ''}">${sections}</div>`;

  if (visible < total) {
    html += `<div class="lm-wrap"><button class="lm-btn" id="tvLoadMore">Load more <span class="lm-count">${visible.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}</span></button></div>`;
  } else if (total > 1) {
    html += `<div class="lm-end">Showing all ${total.toLocaleString('en-IN')} bytes</div>`;
  }

  wrap.innerHTML = html;

  // Wire card-level interactions
  wireTvCardActions();
  const lm = document.getElementById('tvLoadMore');
  if (lm) lm.onclick = () => { state.tv.visible = Math.min(state.tv.visible + 50, total); renderTvList(); };
}

function renderTvCard(it) {
  const expanded = state.tv.expanded.has(it.id);
  const MAX = 2;       // first 2 bullets visible by default; "Read more" reveals the rest
  const showAll = expanded || it.bullets.length <= MAX;
  const visibleBullets = showAll ? it.bullets : it.bullets.slice(0, MAX);

  const thumbInner = it.thumbUrl
    ? `<img src="${safeAttr(it.thumbUrl)}" alt="" loading="lazy" onerror="this.onerror=null;this.style.display='none'">`
    : `<svg class="tv-thumb-fallback-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;

  const thumb = it.youtubeUrl
    ? `<a class="tv-thumb" href="${safeAttr(it.youtubeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Watch ${escapeHtml(it.company)} on YouTube">
         ${thumbInner}
         <span class="tv-thumb-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>
       </a>`
    : `<div class="tv-thumb" aria-hidden="true">
         <svg class="tv-thumb-fallback-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
       </div>`;

  // Header line: company name + person/role + industry chip + market-cap chip,
  // all inline on one row. A subtle middle-dot separator distinguishes the
  // company text from the person text (chips have their own borders so they
  // don't need a separator). The row flex-wraps on narrow viewports so nothing
  // overflows on mobile.
  const personSegment = it.person
    ? `<span class="tv-co-sep" aria-hidden="true">·</span><span class="tv-person">${escapeHtml(it.person)}</span>`
    : '';
  const industryChip = it.industry ? `<span class="tv-sector-chip">${escapeHtml(it.industry)}</span>` : '';
  const mcapChip = it.marketCap ? `<span class="tv-mcap-chip">₹${escapeHtml(it.marketCap.replace(/^₹\s*/, ''))}</span>` : '';

  // "Read more / Read less" toggle — inlined at the tail of the LAST visible
  // bullet rather than rendered as a separate row below the list. When
  // collapsed (showAll=false), the last visible bullet is bullet 2 so the
  // button reads as a continuation of that line. When expanded, the toggle
  // sits at the end of the final bullet as "Read less ▴". An empty title=""
  // overrides the parent <li>'s title attribute so hovering the button
  // doesn't surface the bullet's full text as a tooltip.
  const hasMore = it.bullets.length > MAX;
  const toggleHtml = hasMore
    ? ` <button class="tv-show-more" data-id="${safeAttr(it.id)}" type="button" title="">${expanded ? 'Read less ▴' : 'Read more ▾'}</button>`
    : '';

  const bulletsHtml = visibleBullets.map((b, idx) => {
    const full = b;
    const trimmed = b.length > 240 ? b.slice(0, 240).trim() + '…' : b;
    const isLast = idx === visibleBullets.length - 1;
    const tail = (isLast && hasMore) ? toggleHtml : '';
    return `<li class="tv-bullet" title="${safeAttr(full)}">${escapeHtml(trimmed)}${tail}</li>`;
  }).join('');

  return `<article class="tv-card" data-id="${safeAttr(it.id)}">
    ${thumb}
    <div class="tv-body">
      <div class="tv-co-row">
        <span class="tv-co">${escapeHtml(it.company)}</span>
        ${personSegment}
        ${industryChip}
        ${mcapChip}
      </div>
      <ul class="tv-bullets">${bulletsHtml}</ul>
    </div>
  </article>`;
}

/* ---- Render: skeletons / empty ---- */
function tvSkeletonHtml(n) {
  let s = '<div class="tv-feed">';
  for (let i = 0; i < n; i++) {
    s += `<div class="tv-skel">
      <div class="tv-skel-thumb"></div>
      <div class="tv-skel-body">
        <div class="tv-skel-line" style="width:55%;height:13px"></div>
        <div class="tv-skel-line" style="width:90%"></div>
        <div class="tv-skel-line" style="width:75%"></div>
        <div class="tv-skel-line" style="width:80%"></div>
      </div>
    </div>`;
  }
  return s + '</div>';
}
function tvEmptyHtml() {
  const filtered = state.tv.query || state.tv.dateFrom || state.tv.dateTo || (state.tv.sector && state.tv.sector.size && !state.tv.sector.has('all'));
  return `<div class="tv-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg>
    <div class="et">No bytes to show</div>
    <div class="es">${filtered
      ? `Nothing matches the current filter.&nbsp;<a href="#" id="tvClearFilters" style="color:var(--accent-hover);text-decoration:underline">Clear filters</a>`
      : 'Items will appear here once the data source returns results.'}</div>
  </div>`;
}
function tvClearAllFilters() {
  state.tv.query = '';
  state.tv.dateFrom = '';
  state.tv.dateTo = '';
  state.tv.sector = new Set(['all']);
  state.tv.cache.sig = null;
  renderTvBytesPanel();
  renderTabCounts();
}

/* ---- Wiring ---- */
function wireTvSearch() {
  const input = document.getElementById('tvSearchInput');
  const clear = document.getElementById('tvSearchClear');
  const shell = document.getElementById('tvSearchShell');
  if (!input || !clear || !shell) return;

  input.oninput = e => {
    const v = e.target.value;
    shell.classList.toggle('has-value', v.length > 0);
    clearTimeout(tvSearchDebounceTimer);
    tvSearchDebounceTimer = setTimeout(() => {
      const q = v.trim().toLowerCase();
      if (q === state.tv.query) return;
      state.tv.query = q;
      state.tv.visible = 100;
      state.tv.cache.sig = null;       // bust cache when query changes
      renderTvSectorRow();             // industry pill counts depend on search
      renderTvList();
      renderTabCounts();
    }, 150);
  };
  clear.onclick = () => {
    clearTimeout(tvSearchDebounceTimer);
    input.value = '';
    shell.classList.remove('has-value');
    if (state.tv.query) {
      state.tv.query = '';
      state.tv.visible = 100;
      state.tv.cache.sig = null;
      renderTvSectorRow();
      renderTvList();
      renderTabCounts();
    }
    input.focus();
  };
}
function wireTvCardActions() {
  // Read more / Read less toggles — flip the entry's expanded state and
  // re-render the list. Filter sig didn't change, so the memoized result
  // is reused (cheap).
  document.querySelectorAll('.tv-show-more[data-id]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (state.tv.expanded.has(id)) state.tv.expanded.delete(id);
      else state.tv.expanded.add(id);
      renderTvList();
    };
  });
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderPanel();
  if (tab === 'announcements' && !state.ann.loaded && !state.ann.loading && !state.ann.error) {
    loadAnnouncements(false);
  }
  if (tab === 'reports' && !state.reports.loaded && !state.reports.loading && !state.reports.error) {
    loadReports({ force: true });
  }
  if (tab === 'tvbytes' && !state.tv.loaded && !state.tv.loading && !state.tv.error) {
    loadTvBytes({ force: true });
  }
  updateFabVisibility();
}

function refresh() {
  renderChips();
  renderActiveBadge();
  renderTabCounts();
  renderPanel();
}

/* ============================ WIRING ============================ */
document.querySelectorAll('#tabs .tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#wlReset').onclick = resetWl;

/* ============================ GLOBAL COMPANY SEARCH ============================
   Wires the topbar search input to the SymbolMaster_WithCode endpoint so the
   user can type a few letters of a company name and see live-fetched results
   in a dropdown. Selecting a row navigates to the company's detail page.

   API contract (verified against the live response sample):
     POST https://omkaradata.com/api/SymbolMaster_WithCode
     Body:  { "Search": "<query>", "Type": "", "sector_id": [], "industry_id": [], "company_id": [] }
     Returns an array of company objects:
       { CompanyID, AccordCode, CompanyName, NSESymbol, BSECode, ISIONNo, BSESymbol, sectorID, Sector, IndustryID, Industry }
     NSESymbol / BSECode / BSESymbol may be null for unlisted companies; CompanyName and AccordCode are always present.

   Behavior:
     - 2-character minimum before firing a request.
     - 300ms debounce on input so we don't fire one request per keystroke.
     - AbortController cancels the previous in-flight request whenever a new
       one starts — avoids out-of-order updates when the user types quickly.
     - Keyboard nav: ↑/↓ moves selection, Enter selects, Esc closes.
     - Cmd/Ctrl-K focuses the input from anywhere on the page.
     - Click outside closes the dropdown.

   Navigation:
     buildCompanyPageURL() is a single-source-of-truth function for the
     destination URL pattern. Edit it to match the actual route once the
     company detail page is wired up on the backend. Currently it builds
     `/company/<NSESymbol or BSESymbol or AccordCode>` and navigates in the
     same tab. */

const SEARCH_API_URL = '/api/SymbolMaster_WithCode';
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;

state.gsearch = {
  query: '',
  results: [],
  loading: false,
  open: false,
  highlighted: -1,
  abortController: null,
  debounceTimer: null,
  error: null,
};

// SINGLE SOURCE OF TRUTH for where a clicked result navigates. Update this
// function (and only this function) when the real company-detail route is
// known. Currently: same-tab navigation to a pretty-URL path keyed on the
// stock symbol. If the actual route uses AccordCode, sectors, slugs, or
// query strings, change the return value accordingly.
function buildCompanyPageURL(company) {
  const code = company.NSESymbol || company.BSESymbol || company.AccordCode;
  return `/company/${encodeURIComponent(code)}`;
}

async function fetchCompanies(query) {
  if (state.gsearch.abortController) state.gsearch.abortController.abort();
  state.gsearch.abortController = new AbortController();
  state.gsearch.loading = true;
  state.gsearch.error = null;
  renderSearchDropdown();
  try {
    const res = await fetch(SEARCH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        Search: query,
        Type: '',
        sector_id: [],
        industry_id: [],
        company_id: [],
      }),
      signal: state.gsearch.abortController.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    state.gsearch.results = Array.isArray(json) ? json : [];
    state.gsearch.loading = false;
    state.gsearch.highlighted = -1;
    renderSearchDropdown();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    state.gsearch.error = (e && e.message) ? e.message : 'Request failed';
    state.gsearch.loading = false;
    state.gsearch.results = [];
    renderSearchDropdown();
  }
}

function onSearchInput(e) {
  const q = e.target.value.trim();
  state.gsearch.query = q;
  clearTimeout(state.gsearch.debounceTimer);
  if (q.length === 0) {
    state.gsearch.open = false;
    state.gsearch.results = [];
    state.gsearch.loading = false;
    renderSearchDropdown();
    return;
  }
  state.gsearch.open = true;
  if (q.length < SEARCH_MIN_CHARS) {
    state.gsearch.results = [];
    state.gsearch.loading = false;
    renderSearchDropdown();
    return;
  }
  state.gsearch.debounceTimer = setTimeout(() => fetchCompanies(q), SEARCH_DEBOUNCE_MS);
}

function renderSearchDropdown() {
  const dropdown = document.getElementById('globalSearchDropdown');
  if (!dropdown) return;
  if (!state.gsearch.open) {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    return;
  }
  dropdown.classList.add('open');

  if (state.gsearch.query.length < SEARCH_MIN_CHARS) {
    dropdown.innerHTML = `<div class="gs-status">Type at least <strong>${SEARCH_MIN_CHARS}</strong> characters to search…</div>`;
    return;
  }
  if (state.gsearch.loading) {
    dropdown.innerHTML = `<div class="gs-status"><span class="gs-spinner"></span> Searching…</div>`;
    return;
  }
  if (state.gsearch.error) {
    dropdown.innerHTML = `<div class="gs-status">Couldn't fetch results — ${escapeHtml(state.gsearch.error)}</div>`;
    return;
  }
  if (state.gsearch.results.length === 0) {
    dropdown.innerHTML = `<div class="gs-status">No companies match <strong>"${escapeHtml(state.gsearch.query)}"</strong></div>`;
    return;
  }

  dropdown.innerHTML = state.gsearch.results.map((c, i) => {
    const cls = (i === state.gsearch.highlighted) ? ' highlighted' : '';
    // Display: company name only. NSE/BSE codes, sector, and industry are
    // intentionally omitted from the dropdown row per design — the user
    // can still SEARCH by symbol or code (the server's name+symbol+code
    // substring matcher handles that side of the contract), but the row
    // itself shows only the canonical company name to keep the list scannable.
    return `<div class="gs-result${cls}" data-index="${i}" role="option">
      <div class="gs-result-name">${escapeHtml(c.CompanyName || '')}</div>
    </div>`;
  }).join('');

  dropdown.querySelectorAll('.gs-result').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.index, 10);
      if (!Number.isNaN(idx) && state.gsearch.results[idx]) selectCompany(state.gsearch.results[idx]);
    };
    el.onmouseenter = () => {
      const idx = parseInt(el.dataset.index, 10);
      if (!Number.isNaN(idx)) {
        state.gsearch.highlighted = idx;
        dropdown.querySelectorAll('.gs-result').forEach(x => x.classList.remove('highlighted'));
        el.classList.add('highlighted');
      }
    };
  });

  // Keep the highlighted row in view when navigating via keyboard
  if (state.gsearch.highlighted >= 0) {
    const active = dropdown.querySelector(`.gs-result[data-index="${state.gsearch.highlighted}"]`);
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

// ---- Remember the last company opened in Forensic ----
// Persisted to localStorage so reopening the Forensic module restores that
// company's data instead of the empty landing. We store the whole search
// result row (small) so the header paints instantly and resolveCompanyId()
// works identically to a live pick. Always restored in Consolidated mode.
const FORENSIC_LAST_CO_KEY = 'omkara.forensic.lastCompany';
function writeLastForensicCompany(company) {
  try {
    if (company && resolveCompanyId(company)) {
      localStorage.setItem(FORENSIC_LAST_CO_KEY, JSON.stringify(company));
    }
  } catch (_) { /* quota / private mode — selection just won't persist */ }
}
function readLastForensicCompany() {
  try {
    const raw = localStorage.getItem(FORENSIC_LAST_CO_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) { return null; }
}
function clearLastForensicCompany() {
  try { localStorage.removeItem(FORENSIC_LAST_CO_KEY); } catch (_) {}
}

function selectCompany(company) {
  if (!company) return;
  state.gsearch.open = false;
  // Clear the input so the dropdown's hover state doesn't linger when the
  // user comes back to the topbar later. The opened company is now
  // identified via the page itself, not the search field.
  if (typeof state.gsearch.query === 'string') state.gsearch.query = '';
  const inputEl = document.getElementById('globalSearchInput');
  if (inputEl) inputEl.value = '';
  renderSearchDropdown();
  // Open the in-app Company view rather than navigating to a separate URL.
  // The sidebar + topbar stay mounted; only the main content area swaps.
  state.company.data = company;
  // The Forensic page is header-only: just the company name section (header
  // card incl. live-price panel), no tab bar, no panes, and no
  // Forensic_DetailedTables call. The normal top-search company page is
  // untouched (full tabs + forensic). headerOnly mirrors the forensic flow.
  state.company.headerOnly = !!state.forensicMode;
  state.company.tab = 'overview';
  // Hard-reset the forensic sub-state so the new company can't show
  // a previous company's cached data. This used to happen lazily inside
  // renderForensicView via a `cachedFor !== cid` check, but that check
  // is only effective when `cid` is reliably different — and if the
  // SymbolMaster response is ever missing the company id field, both
  // companies fall back to the same default and the cache check
  // silently passes. Resetting here makes the contract unambiguous:
  // a new company selection = a fresh forensic load, every time.
  if (state.company.forensic) {
    const f = state.company.forensic;
    if (f.abortController) f.abortController.abort();
    f.abortController = null;
    f.data = { con: null, std: null };
    f.mode = 'con';
    f.activeCategoryIdx = 1;
    f.loading = false;
    f.error = null;
  }
  showView('company');
  // Header-only (Forensic page): no tabs to activate. Normal flow syncs the
  // visible tab to state (Overview), which also resets it on company switch.
  if (!state.company.headerOnly) {
    activateCompanyTab(state.company.tab);
  } else {
    // Forensic page: enrich the header card from companynote (canonical name
    // + NSE/BSE chips + exchange links). The card already shows search data;
    // this overrides it when the note lands. One companynote call per select.
    loadForensicHeaderNote(company);
    // Forensic page "Single Page" tab — load Consolidated tables by default.
    startForensicSinglePage();
    // Remember this pick so reopening the Forensic module restores it.
    writeLastForensicCompany(company);
  }
  // Eager Forensic_DetailedTables fetch — NORMAL company page only. The
  // Forensic page is header-only and must not fire this call.
  if (!state.company.headerOnly && resolveCompanyId(company)) {
    const startMode = (state.company.forensic && state.company.forensic.mode) || 'con';
    loadForensic(startMode);
  }
}

// Programmatically activate a Company-view tab (mirrors the click handler in
// wireCompanyTabs). Used to land on the Forensic tab from the Forensic flow
// and to reset the visible tab when switching companies.
function activateCompanyTab(tabId) {
  const bar = document.getElementById('cvTabs');
  if (!bar) return;
  const btn = bar.querySelector('.cv-tab[data-cvtab="' + tabId + '"]');
  if (!btn) return;
  bar.querySelectorAll('.cv-tab').forEach(t => t.classList.toggle('active', t === btn));
  document.querySelectorAll('#companyView .cv-pane').forEach(p => {
    p.hidden = (p.dataset.pane !== tabId);
  });
  state.company.tab = tabId;
  if (tabId === 'overview') ensureCompanyCharts();
  if (tabId === 'forensic') renderForensicView();
}

// ===========================================================================
// FORENSIC HEADER ENRICHMENT — companynote (Forensic page only)
// ===========================================================================
// On the Forensic page the header card is enriched from the companynote API.
// The card renders instantly from the search result; this fills in the
// canonical CompanyName and the NSE/BSE chips + exchange deep-links once the
// note arrives. Sector / Industry / ISIN stay as rendered from the search
// (SymbolMaster_WithCode). One call per selection, mapped by CompanyID.

// POST { CompanyID } and return Data[0], or null. Failures are swallowed —
// the search-derived header already shows, so a miss just means no links.
async function loadCompanyNote(companyId) {
  if (companyId == null || String(companyId).trim() === '') return null;
  try {
    const res = await fetch(COMPANYNOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ CompanyID: String(companyId).trim() }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = json && Array.isArray(json.Data) ? json.Data : [];
    return rows[0] || null;
  } catch (_) {
    return null;
  }
}

// Kick off the note fetch for the just-selected company and apply it when it
// lands. Guarded by CompanyID so a late response for a previously-selected
// company is ignored.
function loadForensicHeaderNote(company) {
  const cid = (company && company.CompanyID != null && String(company.CompanyID).trim() !== '')
    ? String(company.CompanyID).trim()
    : resolveCompanyId(company);
  state.company.note = { companyId: cid, data: null };
  if (!cid) return;
  loadCompanyNote(cid).then(note => {
    if (!note) return;
    if (String(state.company.note.companyId) !== String(cid)) return; // stale
    state.company.note.data = note;
    applyForensicNote();
  });
}

// Override the Forensic header with companynote fields: canonical name and
// the two exchange chips (with deep-links). Meta line is left as-is.
function applyForensicNote() {
  const note = state.company.note && state.company.note.data;
  if (!note) return;
  const nameEl = document.getElementById('cvCompanyName');
  if (nameEl && note.CompanyName) nameEl.textContent = note.CompanyName;
  setExchangeChip(document.getElementById('cvChipNse'), 'NSE', note.NSEcode, note.NSELink);
  setExchangeChip(document.getElementById('cvChipBse'), 'BSE', note.BSEcode, note.BSELink);
  // Rebuild the meta line so the website link (companynote) appears first.
  renderCompanyMeta();
}

// Build the header meta line: Website · Sector · Industry · ISIN, all on one
// line (flex-wrap) with dot separators. The website (companynote, Forensic
// card only) comes FIRST, before Sector, as a clickable link that opens the
// company site in a new tab; it's omitted entirely when WebSiteLink is absent.
// Sector / Industry / ISIN come from the search result. Single source of truth
// for #cvMeta — called on open and again when the companynote note lands.
function renderCompanyMeta() {
  const metaEl = document.getElementById('cvMeta');
  if (!metaEl) return;
  const c = state.company.data || {};
  const note = (state.company.headerOnly && state.company.note && state.company.note.data) || null;
  const parts = [];
  const webRaw = note && note.WebSiteLink ? String(note.WebSiteLink).trim() : '';
  if (webRaw) {
    const href = /^https?:\/\//i.test(webRaw) ? webRaw : 'https://' + webRaw;
    const label = webRaw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    parts.push(
      '<a class="co-web" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer" title="Open company website">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg>'
      + '<span>' + escapeHtml(label) + '</span></a>'
    );
  }
  if (c.Sector)   parts.push('<span>Sector · ' + escapeHtml(c.Sector) + '</span>');
  if (c.Industry) parts.push('<span>Industry · ' + escapeHtml(c.Industry) + '</span>');
  if (c.ISIONNo)  parts.push('<span>ISIN · ' + escapeHtml(c.ISIONNo) + '</span>');
  metaEl.innerHTML = parts.join('<span class="dot"></span>');
}

// ===========================================================================
// FORENSIC PAGE — "Single Page" tab (Forensic_DetailedTables)
// ===========================================================================
// Renders below the company header card on the Forensic page. A tab bar
// (Single Page + 6 disabled placeholders) sits on top; the Single Page tab
// shows a Consolidated/Standalone toggle, the Snapshot table, a sticky bar of
// jump-chips, then the remaining tables stacked. Reuses the proven table
// renderers (renderForensicCardGrid / renderForensicTimeSeriesTable). con/std
// are cached per mode so toggling is instant after the first fetch.

const FP_TABS = ['Analysis', 'Ratios', 'Capital Structure', 'Directors and Auditor', 'Capital History', 'Dividend History', 'ESOP'];

// Fetch the Forensic_DetailedTables data for a mode and render. Cache hit →
// render instantly (no refetch). Guarded against stale responses by id+mode.
async function loadForensicSinglePage(mode) {
  const fp = state.company.fp;
  const cid = resolveCompanyId(state.company.data);
  fp.mode = mode;
  if (!cid) { fp.loading = false; fp.error = 'Company id not available for this selection.'; renderForensicPage(); return; }
  // Cache hit — instant Consolidated⇄Standalone switch.
  if (fp.data[mode]) { fp.loading = false; fp.error = null; renderForensicPage(); requestForensicFlags(); return; }

  if (fp.abortController) fp.abortController.abort();
  fp.abortController = new AbortController();
  const signal = fp.abortController.signal;
  const reqCid = String(cid);
  fp.loading = true; fp.error = null;
  renderForensicPage();
  try {
    const res = await fetch(FORENSIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      // CompanyId (lowercase "d") mapped from the search result's CompanyID.
      body: JSON.stringify({ CompanyId: reqCid, type: mode }),
      signal,
    });
    if (signal.aborted) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (signal.aborted) return;
    // Company changed mid-flight — drop this response.
    if (String(resolveCompanyId(state.company.data)) !== reqCid) return;
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');
    fp.data[mode] = Array.isArray(json.Data) ? json.Data : [];
    fp.buttonStatus = (json.button_status && typeof json.button_status === 'object')
      ? { con: !!json.button_status.con, std: !!json.button_status.std }
      : { con: true, std: true };

    // Consolidated not available for this company → default to Standalone and
    // keep the Consolidated pill greyed out, instead of showing an empty view.
    // Detected either via button_status.con === false or an empty consolidated
    // payload; only falls back when Standalone is actually available.
    if (mode === 'con' && fp.buttonStatus.std
        && (!fp.buttonStatus.con || fp.data['con'].length === 0)) {
      fp.data['con'] = null;                 // discard the empty consolidated payload
      await loadForensicSinglePage('std');   // fetch + render Standalone
      if (state.company.fp === fp && fp.buttonStatus) fp.buttonStatus.con = false; // authoritative: no consolidated
      renderForensicPage();
      return;
    }

    fp.loading = false;
    renderForensicPage();
    requestForensicFlags();   // auto-generate the green/red cards (cached per mode)
  } catch (e) {
    if (signal.aborted || (e && e.name === 'AbortError')) return;
    // Consolidated request failed outright → try Standalone once before erroring.
    if (mode === 'con') {
      fp.data['con'] = null;
      await loadForensicSinglePage('std');
      if (state.company.fp === fp) {
        if (fp.buttonStatus) fp.buttonStatus.con = false;      // no consolidated
        if (fp.data['std']) { renderForensicPage(); return; }  // Standalone shown
      }
    }
    fp.loading = false;
    fp.error = (e && e.message) || 'Network error';
    renderForensicPage();
  }
}

function renderForensicPage() {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  const fp = state.company.fp;
  const bs = fp.buttonStatus || { con: true, std: true };

  const tabsHtml = FP_TABS.map((name, i) => {
    const isActive = i === 0;                       // only Single Page is live
    return '<button type="button" class="fp-tab' + (isActive ? ' active' : '') + '"'
      + (isActive ? '' : ' disabled aria-disabled="true"')
      + ' data-fptab="' + i + '">' + escapeHtml(name) + '</button>';
  }).join('');

  const modesHtml = '<div class="fp-modes" role="tablist" aria-label="Statement type">'
    + '<button type="button" class="fp-mode' + (fp.mode === 'con' ? ' active' : '') + '" data-fpmode="con"' + (bs.con ? '' : ' disabled') + '>Consolidated</button>'
    + '<button type="button" class="fp-mode' + (fp.mode === 'std' ? ' active' : '') + '" data-fpmode="std"' + (bs.std ? '' : ' disabled') + '>Standalone</button>'
    + '</div>';

  let body;
  if (fp.loading)      body = '<div class="fr-loading"><div class="fr-loading-text">Loading forensic tables…</div></div>';
  else if (fp.error)   body = '<div class="fr-error"><p>' + escapeHtml(fp.error) + '</p><button type="button" class="fp-retry" data-fpretry>Retry</button></div>';
  else                 body = renderForensicPageTables();

  host.innerHTML =
    '<nav class="fp-tabs" role="tablist" aria-label="Forensic sections">' + tabsHtml + '</nav>'
    + '<div class="fp-singlepage">' + modesHtml
    + '<div class="fp-tables cv-forensic">' + body + '</div>'
    + '</div>';
  wireForensicPage();
}

// Snapshot first, then the sticky jump-chips bar, then the remaining tables.
function renderForensicPageTables() {
  const fp = state.company.fp;
  const data = fp.data[fp.mode] || [];
  if (!data.length) return '<div class="fr-placeholder"><p>No forensic data available for this company.</p></div>';

  const sectionHtml = (tab, i) => {
    const tabName = String(tab.tabName || '');
    const name = displayForensicTabName(tab.tabName);
    const aiKey = Object.keys(FP_SUMMARY_SECTIONS)
      .find(k => FP_SUMMARY_SECTIONS[k].match.test(tabName));
    // Compare-enabled tables (Earning Quality, Fund Flow, Working capital, Asset
    // efficiency, Expense Analysis) get their own inner renderer — +Compare
    // controls + chips + compare/normal table. Everything compare related lives
    // inside that one section; nothing else on the page is touched.
    if (aiKey && FP_SUMMARY_SECTIONS[aiKey].compare) {
      return '<section class="fp-section" id="fp-sec-' + i + '" data-cmp-section="' + aiKey + '">'
        + compareSectionInnerHtml(tab, fp, aiKey) + '</section>';
    }
    const content = (Array.isArray(tab.tableContent) && tab.tableContent.length > 0)
      ? renderForensicCardGrid(tab)
      : renderForensicTimeSeriesTable(tab);
    const isSh = /shareholding\s*pattern/i.test(tabName);
    let head;
    let belowHead = '';
    if (isSh) {
      // ShareHolding Pattern: Quarterly / Yearly toggle + "Generate AI Summary"
      // button on the heading line; the summary reflects the selected view.
      const y = !!(fp && fp.shYearly);
      head = '<div class="fp-sec-head"><h3 class="fp-sec-title">' + escapeHtml(name) + '</h3>'
        + '<div class="fp-sec-head-actions">'
        + forensicAIBtnHtml('sh')
        + '<div class="fp-shtoggle" role="tablist" aria-label="Period">'
        + '<button type="button" class="fp-shbtn' + (!y ? ' active' : '') + '" data-shview="q">Quarterly</button>'
        + '<button type="button" class="fp-shbtn' + (y ? ' active' : '') + '" data-shview="y">Yearly</button>'
        + '</div></div></div>';
      belowHead = '<div class="fp-ai" data-fp-ai="sh">' + forensicAIPanelHtml('sh') + '</div>';
    } else if (aiKey) {
      // Capital structure / Du Pont: "Generate AI Summary" button only.
      head = '<div class="fp-sec-head"><h3 class="fp-sec-title">' + escapeHtml(name) + '</h3>'
        + forensicAIBtnHtml(aiKey) + '</div>';
      belowHead = '<div class="fp-ai" data-fp-ai="' + aiKey + '">' + forensicAIPanelHtml(aiKey) + '</div>';
    } else {
      head = '<h3 class="fp-sec-title">' + escapeHtml(name) + '</h3>';
    }
    return '<section class="fp-section" id="fp-sec-' + i + '">' + head + belowHead + content + '</section>';
  };

  const chips = '<nav class="fp-chips" aria-label="Jump to table">'
    + data.map((tab, i) => {
        // The Snapshot section is hidden; its pill is the "Summary" pill and
        // jumps to the flag cards (which now sit directly below the pill bar).
        const isSnap = /snapshot/i.test(String(tab.tabName || ''));
        const label = isSnap ? escapeHtml('Summary') : escapeHtml(displayForensicTabName(tab.tabName));
        const target = isSnap ? 'fp-flags' : ('fp-sec-' + i);
        return '<button type="button" class="fp-chip" data-fpjump="' + target + '">' + label + '</button>';
      }).join('')
    + '</nav>';

  // Render every section EXCEPT Snapshot (kept out of the page on purpose;
  // re-enable by removing the isSnap skip below). The jump-pill bar now sits
  // ABOVE the flag cards; the "Summary" pill scrolls down to those cards.
  const sections = data
    .map((tab, i) => (/snapshot/i.test(String(tab.tabName || '')) ? '' : sectionHtml(tab, i)))
    .join('');
  return chips + forensicFlagsRowHtml() + sections;
}

function wireForensicPage() {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  // Consolidated / Standalone toggle.
  host.querySelectorAll('.fp-mode[data-fpmode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const m = btn.dataset.fpmode;
      if (m === state.company.fp.mode && state.company.fp.data[m]) return;
      loadForensicSinglePage(m);
    });
  });
  // Jump chips → smooth-scroll to the table section.
  host.querySelectorAll('.fp-chip[data-fpjump]').forEach(chip => {
    chip.addEventListener('click', () => {
      const el = document.getElementById(chip.dataset.fpjump);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // ShareHolding Pattern Quarterly / Yearly toggle.
  host.querySelectorAll('.fp-shbtn[data-shview]').forEach(btn => {
    btn.addEventListener('click', () => {
      const yearly = btn.dataset.shview === 'y';
      const fp = state.company.fp;
      if (!!(fp && fp.shYearly) === yearly) return;
      if (fp) {
        fp.shYearly = yearly;
        // The ShareHolding summary is view-specific — drop it (both modes) so it
        // regenerates for the newly-selected view rather than showing a stale one.
        if (fp.summaries) { if (fp.summaries.con) delete fp.summaries.con.sh; if (fp.summaries.std) delete fp.summaries.std.sh; }
      }
      renderForensicPage();
    });
  });
  // Retry after an error.
  const retry = host.querySelector('[data-fpretry]');
  if (retry) retry.onclick = () => loadForensicSinglePage(state.company.fp.mode);
  // Capital structure / Du Pont — Generate / Regenerate the AI summary. The
  // compare-enabled tables (eq/ff/wc/ae/ea) wire their own AI button inside
  // wireCompareSection so they aren't double-bound on section re-render.
  host.querySelectorAll('[data-fp-ai-btn]').forEach(btn => {
    const key = btn.getAttribute('data-fp-ai-btn');
    if (isCompareKey(key)) return;
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      requestForensicSummary(key, fpSummaryState(key).status === 'done');  // done → force regenerate
    });
  });
  wireCompareSections();
  // The 6 placeholder tabs are disabled; no handlers needed.
}

// Reset Single Page state for a freshly-selected company and load Consolidated.
function startForensicSinglePage() {
  state.company.fp = { mode: 'con', data: { con: null, std: null }, loading: false, error: null, buttonStatus: { con: true, std: true }, abortController: null, shYearly: false, summaries: { con: {}, std: {} }, summaryAbort: {}, flags: { con: null, std: null }, flagsAbort: null,
    // Peer comparison. compare: independent per-table picker + peer list, keyed
    // by section (eq/ff/wc/ae/ea). peerCache: shared payload cache keyed by
    // company id so the same peer is fetched only once across all tables.
    compare: freshCompareState(), peerCache: {} };
  const host = document.getElementById('forensicPage');
  if (host) host.hidden = false;
  loadForensicSinglePage('con');
}

/* ---- Peer comparison for cumulative tables ------------------------------
   A "+ Compare" button on Earning Quality, Fund Flow, Working capital, Asset
   efficiency and Expense Analysis lets the user add up to two peer companies
   (three total). While comparing, the per-period history is hidden and the
   table shows only the cumulative 3yr/5yr/10yr block per company, grouped by
   company (all rows), with each company's own tint. Peer selection is
   INDEPENDENT per table (fp.compare[key]); peer DATA is fetched once per
   company (con→std) into a SHARED cache (fp.peerCache) — the same peer added to
   several tables is fetched only once. Only the touched section re-renders. */

// Which forensic tables get the +Compare treatment (must also be in FP_SUMMARY_SECTIONS).
function isCompareKey(key) { return !!(FP_SUMMARY_SECTIONS[key] && FP_SUMMARY_SECTIONS[key].compare); }

// Fresh per-table compare state (independent peers + picker per table).
function freshCompareState() {
  const mk = () => ({ peers: [], search: { open: false, query: '', results: [], loading: false, error: null, abort: null, timer: null, _view: [], highlighted: -1 } });
  const out = {};
  Object.keys(FP_SUMMARY_SECTIONS).forEach(k => { if (FP_SUMMARY_SECTIONS[k].compare) out[k] = mk(); });
  return out;
}

// Normalise a metric name for cross-company row matching.
function cmpNormMetric(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

const CMP_ACCENTS = ['#4F46E5', '#0D9488', '#B45309'];

// Pull the cumulative (3/5/10yr) block out of any time-series tab, keyed by
// metric name and year-span, mirroring renderForensicTimeSeriesTable's split.
function extractCumulative(tab) {
  const ct = (tab && tab.childTable) || [];
  if (ct.length < 2) return { order: [], byMetric: {}, spans: [] };
  const schema = ct[0];
  const dataRows = ct.slice(1);
  const allRowKeys = ['Row1','Row2','Row3','Row4','Row5','Row6','Row7','Row8','Row9','Row10','Row11'];
  const activeKeys = allRowKeys.filter(key => {
    if (parseForensicMetric(schema[key]).name) return true;
    return dataRows.some(r => String(r[key] || '').trim());
  });
  const cagrRows = dataRows.filter(r => isForensicPeriodLabel(String(r.description || '').trim()));
  const spanOf = r => parseInt(String(r.description || '').replace(/[^\d]/g, ''), 10) || 0;
  cagrRows.sort((a, b) => spanOf(a) - spanOf(b));
  const spans = cagrRows.map(spanOf);
  const order = [];
  const byMetric = {};
  activeKeys.forEach(key => {
    const name = parseForensicMetric(schema[key]).name || ('Col ' + key.slice(3));
    order.push(name);
    const spanCells = {};
    cagrRows.forEach((row, idx) => { spanCells[spans[idx]] = parseForensicCell(row[key]); });
    byMetric[cmpNormMetric(name)] = spanCells;
  });
  return { order, byMetric, spans };
}

// Final tint for a compare cell. Earning Quality colours by sign (its feed
// doesn't tint), every other table keeps the API-flagged tint — matching each
// table's normal rendering.
function cmpTint(isEq, cell) {
  if (!cell) return '';
  if (!String(cell.value || '').trim().length) return '';
  if (isEq) { const n = forensicNumericValue(cell.value); return n == null ? '' : (n > 0 ? ' fr-pos' : (n < 0 ? ' fr-neg' : '')); }
  return cell.tint === 'pos' ? ' fr-pos' : (cell.tint === 'neg' ? ' fr-neg' : '');
}

// Resolve a peer's cumulative extract for a given section from the shared cache.
function peerExtractFor(fp, peerId, key) {
  const entry = fp.peerCache[peerId];
  if (!entry) return { status: 'loading' };
  if (entry.status !== 'done') return { status: entry.status, error: entry.error };
  if (!entry.extract) entry.extract = {};
  if (!(key in entry.extract)) {
    const sec = FP_SUMMARY_SECTIONS[key];
    const tab = entry.data.find(t => sec.match.test(String(t.tabName || '')));
    entry.extract[key] = tab ? extractCumulative(tab) : null;
  }
  const ex = entry.extract[key];
  if (!ex) return { status: 'error', error: 'No ' + FP_SUMMARY_SECTIONS[key].tab + ' data' };
  return { status: 'done', extract: ex };
}

// The compare table: rows = metrics, columns = companies × cumulative 3/5/10.
function renderCompareTable(baseTab, fp, key) {
  const base = extractCumulative(baseTab);
  const spans = base.spans.length ? base.spans : [3, 5, 10];
  const typeLabel = cagrGroupLabel(baseTab.tabName);   // CAGR / Averages / Cumulative…
  const isEq = /earnings?\s*quality/i.test(String(baseTab.tabName || ''));
  const baseName = (state.company.data && state.company.data.CompanyName) || 'Current company';
  const cols = [{ id: '__base', name: baseName, status: 'done', extract: base }];
  fp.compare[key].peers.forEach(p => {
    const pe = peerExtractFor(fp, p.id, key);
    cols.push({ id: p.id, name: p.name, status: pe.status, extract: pe.extract, error: pe.error });
  });

  let h = '<tr class="fr-thead-super"><th class="fr-th-period fr-th-super-blank" rowspan="2">Description</th>';
  cols.forEach((c, ci) => {
    h += '<th class="fr-cagr-super ff-cmp-grp' + (ci > 0 ? ' ff-co-start' : '') + '" colspan="' + spans.length + '">'
      + '<span class="ff-co-dot" style="background:' + CMP_ACCENTS[ci % 3] + '"></span>'
      + '<span class="ff-cmp-co">' + escapeHtml(c.name) + '</span>'
      + '<span class="ff-cmp-type">' + escapeHtml(typeLabel) + '</span></th>';
  });
  h += '</tr><tr>';
  cols.forEach((c, ci) => {
    spans.forEach((s, si) => {
      h += '<th class="fr-cagr-col' + (si === 0 && ci > 0 ? ' ff-co-start' : '') + '">' + escapeHtml(s + 'yrs') + '</th>';
    });
  });
  h += '</tr>';

  const body = base.order.map(name => {
    let tds = '<td class="fr-td-period fr-td-metric">' + escapeHtml(name) + '</td>';
    cols.forEach((c, ci) => {
      const lead = ci > 0 ? ' ff-co-start' : '';
      if (c.status === 'loading') {
        tds += '<td class="ff-co-wait' + lead + '" colspan="' + spans.length + '"><span class="ff-skel"></span></td>';
      } else if (c.status === 'error') {
        tds += '<td class="ff-co-wait' + lead + '" colspan="' + spans.length + '" title="' + escapeHtml(c.error || 'Unavailable') + '">—</td>';
      } else {
        const rec = c.extract && c.extract.byMetric[cmpNormMetric(name)];
        spans.forEach((s, si) => {
          const cell = rec && rec[s];
          const val = cell ? cell.value : '';
          const hasVal = String(val || '').trim().length > 0;
          const tint = cmpTint(isEq, cell);
          const cls = (hasVal ? 'fr-cagr-col' + tint : '') + (si === 0 && ci > 0 ? ' ff-co-start' : '');
          tds += '<td class="' + cls.trim() + '">' + escapeHtml(bracketNegative(val)) + '</td>';
        });
      }
    });
    return '<tr>' + tds + '</tr>';
  }).join('');

  return '<div class="fr-table-scroll"><table class="fr-table fr-table-transposed fr-cagr-conditional ff-compare-table">'
    + '<thead>' + h + '</thead><tbody>' + body + '</tbody></table></div>';
}

// Full inner HTML of a compare-enabled <section> (head + panel + chips + table).
function compareSectionInnerHtml(tab, fp, key) {
  const name = displayForensicTabName(tab.tabName);
  const c = fp.compare[key];
  const comparing = c.peers.length > 0;
  const canAdd = c.peers.length < 2;
  const plus = '<svg class="ff-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const cmpBtn = '<button type="button" class="fp-cmp-btn" data-cmp-btn="' + key + '"' + (canAdd ? '' : ' disabled') + '>'
    + plus + '<span>' + (comparing ? 'Add company' : 'Compare') + '</span></button>';
  const head = '<div class="fp-sec-head"><h3 class="fp-sec-title">' + escapeHtml(name) + '</h3>'
    + '<div class="fp-sec-head-actions">'
    + '<div class="ff-search" data-cmp-search="' + key + '">' + cmpSearchInnerHtml(fp, key) + '</div>'
    + cmpBtn
    + (comparing ? '' : forensicAIBtnHtml(key))
    + '</div></div>';
  const aiPanel = comparing ? '' : '<div class="fp-ai" data-fp-ai="' + key + '">' + forensicAIPanelHtml(key) + '</div>';
  const chips = comparing ? cmpChipsHtml(fp, key) : '';
  const normal = (Array.isArray(tab.tableContent) && tab.tableContent.length > 0) ? renderForensicCardGrid(tab) : renderForensicTimeSeriesTable(tab);
  const body = comparing ? renderCompareTable(tab, fp, key) : normal;
  return head + aiPanel + chips + '<div class="ff-body">' + body + '</div>';
}

function cmpSearchInnerHtml(fp, key) {
  const s = fp.compare[key].search;
  if (!s.open) return '';
  return '<input type="text" class="ff-search-in" data-cmp-search-in placeholder="Search a company to compare…" value="' + escapeHtml(s.query) + '" autocomplete="off" spellcheck="false">'
    + '<div class="ff-menu" data-cmp-menu>' + cmpMenuHtml(fp, key) + '</div>';
}

function cmpMenuHtml(fp, key) {
  const s = fp.compare[key].search;
  s._view = [];
  if (s.query.trim().length < 2) return '<div class="ff-menu-note">Type at least 2 characters…</div>';
  if (s.loading) return '<div class="ff-menu-note"><span class="gs-spinner"></span> Searching…</div>';
  if (s.error) return '<div class="ff-menu-note">' + escapeHtml(s.error) + '</div>';
  const taken = new Set();
  const baseId = resolveCompanyId(state.company.data);
  if (baseId) taken.add(String(baseId));
  fp.compare[key].peers.forEach(p => taken.add(String(p.id)));
  const list = (s.results || []).filter(c => { const id = resolveCompanyId(c); return id && !taken.has(String(id)); }).slice(0, 8);
  s._view = list;
  if (s.highlighted >= list.length) s.highlighted = list.length - 1;
  if (!list.length) return '<div class="ff-menu-note">No other companies match</div>';
  return list.map((c, i) => '<button type="button" class="ff-menu-item' + (i === s.highlighted ? ' is-hl' : '') + '" data-cmp-pick="' + i + '">'
    + escapeHtml(c.CompanyName || '') + '</button>').join('');
}

function cmpChipsHtml(fp, key) {
  const baseName = (state.company.data && state.company.data.CompanyName) || 'Current company';
  const chips = [{ id: '__base', name: baseName, base: true }].concat(fp.compare[key].peers.map(p => ({ id: p.id, name: p.name })));
  const inner = chips.map((c, ci) => {
    const dot = '<span class="ff-co-dot" style="background:' + CMP_ACCENTS[ci % 3] + '"></span>';
    if (c.base) return '<span class="ff-chip ff-chip-base">' + dot + escapeHtml(c.name) + '<span class="ff-chip-tag">CURRENT</span></span>';
    return '<span class="ff-chip">' + dot + escapeHtml(c.name)
      + '<button type="button" class="ff-chip-x" data-cmp-remove="' + escapeHtml(String(c.id)) + '" aria-label="Remove">&times;</button></span>';
  }).join('');
  return '<div class="ff-cmp-bar"><span class="ff-cmp-lbl">Comparing</span>' + inner
    + '<span class="ff-cmp-hint">' + fp.compare[key].peers.length + '/2 peers · cumulative only</span></div>';
}

// Re-render ONLY one compare section (compare changes never touch the rest).
function rerenderCompareSection(key) {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  const fp = state.company.fp;
  const data = (fp && fp.data[fp.mode]) || [];
  const sc = FP_SUMMARY_SECTIONS[key];
  const tab = data.find(t => sc.match.test(String(t.tabName || '')));
  const sec = host.querySelector('[data-cmp-section="' + key + '"]');
  if (!sec || !tab) return;
  sec.innerHTML = compareSectionInnerHtml(tab, fp, key);
  wireCompareSection(key);
}

// Re-render every compare section that currently includes the given peer id.
function rerenderCompareSectionsForPeer(id) {
  const fp = state.company.fp;
  if (!fp || !fp.compare) return;
  Object.keys(fp.compare).forEach(key => {
    if (fp.compare[key].peers.some(p => String(p.id) === String(id))) rerenderCompareSection(key);
  });
}

function wireCompareSections() {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  host.querySelectorAll('[data-cmp-section]').forEach(sec => wireCompareSection(sec.getAttribute('data-cmp-section')));
}

function wireCompareSection(key) {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  const sec = host.querySelector('[data-cmp-section="' + key + '"]');
  if (!sec) return;
  const fp = state.company.fp;
  const cbtn = sec.querySelector('[data-cmp-btn]');
  if (cbtn) cbtn.addEventListener('click', e => {
    e.stopPropagation();
    if (cbtn.disabled) return;
    const s = fp.compare[key].search;
    s.open = !s.open; s.query = ''; s.results = []; s.error = null; s.loading = false; s.highlighted = -1;
    const sh = sec.querySelector('[data-cmp-search]');
    if (sh) sh.innerHTML = cmpSearchInnerHtml(fp, key);
    wireCmpSearch(sec, fp, key);
  });
  const aibtn = sec.querySelector('[data-fp-ai-btn]');
  if (aibtn) aibtn.addEventListener('click', () => { if (aibtn.disabled) return; requestForensicSummary(key, fpSummaryState(key).status === 'done'); });
  sec.querySelectorAll('[data-cmp-remove]').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-cmp-remove');
    fp.compare[key].peers = fp.compare[key].peers.filter(p => String(p.id) !== String(id));
    rerenderCompareSection(key);
  }));
  wireCmpSearch(sec, fp, key);
}

function wireCmpSearch(sec, fp, key) {
  const input = sec.querySelector('[data-cmp-search-in]');
  if (input) {
    input.addEventListener('input', () => {
      const s = fp.compare[key].search;
      s.query = input.value; s.highlighted = -1;
      clearTimeout(s.timer);
      const q = input.value.trim();
      if (q.length < 2) { s.results = []; s.loading = false; s.error = null; updateCmpMenu(sec, fp, key); return; }
      s.loading = true; s.error = null; updateCmpMenu(sec, fp, key);
      s.timer = setTimeout(() => cmpFetchPeers(q, sec, fp, key), 300);
    });
    input.addEventListener('keydown', e => {
      const s = fp.compare[key].search;
      const n = (s._view || []).length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!n) return; s.highlighted = (s.highlighted + 1) % n; cmpHighlight(sec, s); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!n) return; s.highlighted = (s.highlighted - 1 + n) % n; cmpHighlight(sec, s); }
      else if (e.key === 'Enter') { e.preventDefault(); const i = s.highlighted >= 0 ? s.highlighted : 0; const co = s._view && s._view[i]; if (co) cmpAddPeer(co, fp, key); }
      else if (e.key === 'Escape') { e.preventDefault(); s.open = false; const sh = sec.querySelector('[data-cmp-search]'); if (sh) sh.innerHTML = ''; }
    });
    input.focus();
    const v = input.value; input.value = ''; input.value = v;  // caret → end
  }
  cmpWirePicks(sec, fp, key);
}

// Toggle the highlight class without re-rendering the menu (keeps input focus).
function cmpHighlight(sec, s) {
  const items = sec.querySelectorAll('.ff-menu-item');
  items.forEach((el, i) => el.classList.toggle('is-hl', i === s.highlighted));
  const cur = items[s.highlighted];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function cmpWirePicks(sec, fp, key) {
  sec.querySelectorAll('[data-cmp-pick]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(b.getAttribute('data-cmp-pick'), 10);
      const co = fp.compare[key].search._view && fp.compare[key].search._view[idx];
      if (co) cmpAddPeer(co, fp, key);
    });
    b.addEventListener('mouseenter', () => {
      const idx = parseInt(b.getAttribute('data-cmp-pick'), 10);
      if (!Number.isNaN(idx)) { fp.compare[key].search.highlighted = idx; cmpHighlight(sec, fp.compare[key].search); }
    });
  });
}

function updateCmpMenu(sec, fp, key) {
  const menu = sec.querySelector('[data-cmp-menu]');
  if (menu) menu.innerHTML = cmpMenuHtml(fp, key);
  cmpWirePicks(sec, fp, key);
}

async function cmpFetchPeers(q, sec, fp, key) {
  const s = fp.compare[key].search;
  if (s.abort) s.abort.abort();
  s.abort = new AbortController();
  const signal = s.abort.signal;
  try {
    const res = await fetch(SEARCH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ Search: q, Type: '', sector_id: [], industry_id: [], company_id: [] }),
      signal,
    });
    if (signal.aborted) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (signal.aborted) return;
    s.results = Array.isArray(json) ? json : [];
    s.loading = false;
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    s.error = 'Search failed'; s.loading = false; s.results = [];
  }
  if (state.company.fp !== fp || !s.open) return;
  updateCmpMenu(sec, fp, key);
}

function cmpAddPeer(co, fp, key) {
  const peers = fp.compare[key].peers;
  if (peers.length >= 2) return;
  const id = resolveCompanyId(co);
  if (!id || peers.some(p => String(p.id) === String(id))) return;
  const peer = { id: String(id), name: co.CompanyName || 'Company', co };
  peers.push(peer);
  const s = fp.compare[key].search;
  s.open = false; s.query = ''; s.results = []; s._view = []; s.highlighted = -1;
  rerenderCompareSection(key);   // show the new column immediately (loading/cached)
  fetchPeerData(peer);           // fetch once per company, then fill
}

// Fetch a peer's FULL forensic payload once (con→std fallback), cached by
// company id in fp.peerCache and shared across every compare table.
async function fetchPeerData(peer) {
  const fp = state.company.fp;
  const id = peer.id;
  const existing = fp.peerCache[id];
  if (existing && (existing.status === 'done' || existing.status === 'loading')) {
    if (existing.status === 'done') rerenderCompareSectionsForPeer(id);  // reuse cache instantly
    return;
  }
  const entry = { status: 'loading', data: null, error: null, extract: {} };
  fp.peerCache[id] = entry;
  const cid = resolveCompanyId(peer.co);
  if (!cid) { entry.status = 'error'; entry.error = 'No company id'; if (state.company.fp === fp) rerenderCompareSectionsForPeer(id); return; }

  const call = async type => {
    const res = await fetch(FORENSIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ CompanyId: String(cid), type }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');
    return { data: Array.isArray(json.Data) ? json.Data : [], bs: json.button_status || {} };
  };
  try {
    let data = null;
    try {
      const con = await call('con');
      const conUnavail = con.bs.con === false || con.data.length === 0;
      data = conUnavail ? null : con.data;
      if (!data && con.bs.std !== false) { const std = await call('std'); data = std.data; }
    } catch (e1) {
      const std = await call('std'); data = std.data;
    }
    if (state.company.fp !== fp) return;
    if (!data || !data.length) { entry.status = 'error'; entry.error = 'No data'; }
    else { entry.status = 'done'; entry.data = data; }
  } catch (e) {
    if (state.company.fp !== fp) return;
    entry.status = 'error'; entry.error = (e && e.message) || 'Network error';
  }
  if (state.company.fp === fp) rerenderCompareSectionsForPeer(id);
}

/* ---- Forensic AI summary (Earning Quality + Fund Flow) ----
   One machinery drives a "Generate AI Summary" button on both the Earning
   Quality and Fund Flow section headers. Results are cached per company +
   statement mode (con/std) AND per section key in state.company.fp.summaries,
   so re-opening or switching back is instant and never re-bills. The Anthropic
   call happens server-side (FORENSIC_SUMMARY_URL) with the prompt chosen from
   the section's tab; the browser only ships the table text + company name. */
const FP_SUMMARY_SECTIONS = {
  eq: { match: /earnings?\s*quality/i, tab: 'Earnings Quality',         empty: 'No Earning Quality data to summarise.', compare: true },
  ff: { match: /fund\s*flow/i,         tab: 'Fund Flow',                empty: 'No Fund Flow data to summarise.', compare: true },
  wc: { match: /working\s*capital/i,   tab: 'Working capital analysis', empty: 'No Working capital data to summarise.', compare: true },
  ae: { match: /asset\s*efficiency/i,  tab: 'Asset efficiency',         empty: 'No Asset efficiency data to summarise.', compare: true },
  cs: { match: /capital\s*structure/i, tab: 'Capital structure',         empty: 'No Capital structure data to summarise.' },
  ea: { match: /expense\s*analysis/i,  tab: 'Expense Analysis',          empty: 'No Expense Analysis data to summarise.', compare: true },
  dp: { match: /du\s*pont/i,           tab: 'Du Pont Analysis',          empty: 'No Du Pont Analysis data to summarise.' },
  sh: { match: /shareholding\s*pattern/i, tab: 'ShareHolding Pattern (In %)', empty: 'No ShareHolding Pattern data to summarise.', yearlyToggle: true },
};

function fpSummaryState(key) {
  const fp = state.company.fp;
  if (!fp || !fp.summaries || !fp.summaries[fp.mode]) return { status: 'idle' };
  return fp.summaries[fp.mode][key] || { status: 'idle' };
}
function fpWriteSummary(key, mode, patch) {
  const fp = state.company.fp;
  if (!fp) return;
  if (!fp.summaries) fp.summaries = { con: {}, std: {} };
  if (!fp.summaries[mode]) fp.summaries[mode] = {};
  fp.summaries[mode][key] = Object.assign({}, fp.summaries[mode][key] || {}, patch);
}

function aiSparkSvg() {
  return '<svg class="fp-ai-spark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"/>'
    + '<path d="M19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6L15.5 17.5l2.6-.9L19 14z" opacity="0.6"/>'
    + '</svg>';
}

function forensicAIBtnHtml(key) {
  const st = fpSummaryState(key);
  const loading = st.status === 'loading';
  let label = 'Generate AI Summary';
  if (loading)               label = 'Generating…';
  else if (st.status === 'done')  label = 'Regenerate';
  else if (st.status === 'error') label = 'Retry';
  return '<button type="button" class="fp-ai-btn' + (loading ? ' is-loading' : '') + '"'
    + (loading ? ' disabled' : '') + ' data-fp-ai-btn="' + key + '">'
    + aiSparkSvg() + '<span class="fp-ai-btn-label">' + label + '</span></button>';
}

function forensicAIPanelHtml(key) {
  const st = fpSummaryState(key);
  if (st.status === 'loading') {
    return '<div class="fp-ai-box fp-ai-loading"><span class="fp-ai-spin" aria-hidden="true"></span>'
      + '<span>Analysing the table and writing the forensic summary…</span></div>';
  }
  if (st.status === 'error') {
    return '<div class="fp-ai-box fp-ai-error"><p>' + escapeHtml(st.error || 'Could not generate the summary.') + '</p></div>';
  }
  if (st.status === 'done') {
    return '<div class="fp-ai-box fp-ai-result">'
      + '<div class="fp-ai-badge">' + aiSparkSvg() + '<span>AI forensic summary</span></div>'
      + '<p class="fp-ai-text">' + escapeHtml(st.text || '') + '</p>'
      + '<p class="fp-ai-dis">AI-generated from the table above — verify before use.</p>'
      + '</div>';
  }
  return '';  // idle — nothing shown until the button is clicked
}

// Targeted DOM update for the AI panel + button (avoids re-rendering all the
// forensic tables on each AI state transition — keeps the page snappy).
function renderForensicAIPanel(key) {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  const panel = host.querySelector('[data-fp-ai="' + key + '"]');
  if (panel) panel.innerHTML = forensicAIPanelHtml(key);
  const btn = host.querySelector('[data-fp-ai-btn="' + key + '"]');
  if (btn) {
    const st = fpSummaryState(key);
    const loading = st.status === 'loading';
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    const lbl = btn.querySelector('.fp-ai-btn-label');
    if (lbl) lbl.textContent = loading ? 'Generating…'
      : (st.status === 'done' ? 'Regenerate' : (st.status === 'error' ? 'Retry' : 'Generate AI Summary'));
  }
}

async function requestForensicSummary(key, force) {
  const fp = state.company.fp;
  if (!fp) return;
  const sec = FP_SUMMARY_SECTIONS[key];
  if (!sec) return;
  const st = fpSummaryState(key);
  if (st.status === 'loading') return;          // already running
  if (st.status === 'done' && !force) return;    // cached — show as-is

  const data = fp.data[fp.mode] || [];
  const tab = data.find(t => sec.match.test(String(t.tabName || '')));
  const ttOpts = (sec.yearlyToggle && fp.shYearly) ? { yearlyOnly: true } : undefined;
  const tableText = tab ? forensicTabToText(tab, ttOpts) : '';
  if (!tableText) {
    fpWriteSummary(key, fp.mode, { status: 'error', error: sec.empty });
    renderForensicAIPanel(key);
    return;
  }

  const cid = String(resolveCompanyId(state.company.data) || '');
  const reqMode = fp.mode;
  const nameEl = document.querySelector('#companyView .co-name');
  const company = (nameEl && nameEl.textContent.trim())
    || (state.company.data && (state.company.data.CompanyName || state.company.data.NSESymbol)) || '';

  if (!fp.summaryAbort) fp.summaryAbort = {};
  if (fp.summaryAbort[key]) fp.summaryAbort[key].abort();
  fp.summaryAbort[key] = new AbortController();
  const signal = fp.summaryAbort[key].signal;

  fpWriteSummary(key, reqMode, { status: 'loading', error: null });
  renderForensicAIPanel(key);

  try {
    const res = await fetch(FORENSIC_SUMMARY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ company, mode: reqMode, tab: sec.tab, tableText }),
      signal,
    });
    if (signal.aborted) return;
    // Company changed mid-flight — drop this response.
    if (String(resolveCompanyId(state.company.data) || '') !== cid) return;
    const json = await res.json().catch(() => ({}));
    if (signal.aborted) return;
    if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
    const summary = String((json && json.summary) || '').trim();
    if (!summary) throw new Error('The AI returned an empty summary.');
    fpWriteSummary(key, reqMode, { status: 'done', text: summary, error: null });
    if (fp.mode === reqMode) renderForensicAIPanel(key);
  } catch (e) {
    if (signal.aborted || (e && e.name === 'AbortError')) return;
    fpWriteSummary(key, reqMode, { status: 'error', error: (e && e.message) || 'Network error' });
    if (fp.mode === reqMode) renderForensicAIPanel(key);
  }
}

/* ---- Green / Red flag cards (above Snapshot) ----
   Computed deterministically in-code (see FORENSIC_FLAG_METRICS) when the
   Forensic page opens and cached per company + mode in state.company.fp.flags.
   Each metric is looked up in its source table and bucketed against its rule —
   Fund Flow: Cash From Operations(pre tax), Pre tax CFO/EBITDA(%), Free Cash
   Flow; Asset efficiency: Capex / EBIDTA(%); Expense analysis: Income tax paid /
   Income Tax Expenses (band); Working capital: Net Working Capital as % of
   sales, Debtors % of Sales, Inventory % Sales (3yr/5yr vs the 10yr benchmark).
   A mixed metric appears in both cards. No AI / network call: always instant. */
function fpFlagsState() {
  const fp = state.company.fp;
  if (!fp || !fp.flags) return { status: 'idle' };
  return fp.flags[fp.mode] || { status: 'idle' };
}
function fpWriteFlags(mode, patch) {
  const fp = state.company.fp;
  if (!fp) return;
  if (!fp.flags) fp.flags = { con: null, std: null };
  fp.flags[mode] = Object.assign({}, fp.flags[mode] || {}, patch);
}

function flagIconSvg(type) {
  return type === 'green'
    ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
}

function forensicFlagCardHtml(type) {
  const st = fpFlagsState();
  const isGreen = type === 'green';
  const title = isGreen ? 'Green Flags' : 'Red Flags';
  let inner;
  if (st.status === 'loading') {
    inner = '<div class="fp-flag-loading"><span class="fp-flag-spin" aria-hidden="true"></span><span>Scanning the tables…</span></div>';
  } else if (st.status === 'error') {
    inner = '<p class="fp-flag-empty">Could not load flags.</p>';
  } else if (st.status === 'done') {
    const items = (isGreen ? st.green : st.red) || [];
    inner = items.length
      ? '<ul class="fp-flag-list">' + items.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>'
      : '<p class="fp-flag-empty">No ' + (isGreen ? 'green' : 'red') + ' flags detected.</p>';
  } else {
    inner = '<p class="fp-flag-empty">&nbsp;</p>';
  }
  return '<div class="fp-flag-card ' + (isGreen ? 'green' : 'red') + '">'
    + '<div class="fp-flag-head">' + flagIconSvg(type) + '<span>' + title + '</span></div>'
    + inner + '</div>';
}

function forensicFlagsRowHtml() {
  return '<div class="fp-flags" id="fp-flags" data-fp-flags>'
    + forensicFlagCardHtml('green') + forensicFlagCardHtml('red') + '</div>';
}

// Targeted update of the two cards (avoids re-rendering the tables).
function renderForensicFlagsCards() {
  const host = document.getElementById('forensicPage');
  if (!host) return;
  const row = host.querySelector('[data-fp-flags]');
  if (row) row.innerHTML = forensicFlagCardHtml('green') + forensicFlagCardHtml('red');
}

// Flag metric config (Fund Flow). Each metric is bucketed per period against
// its threshold; >threshold periods → green flag, <threshold → red flag, a
// mixed metric yields both. Add metrics by appending here (match = how to find
// the row; threshold = the cut-off; gapZero = treat a 0 value as a data gap).
const FORENSIC_FLAG_METRICS = [
  { table: /fund\s*flow/i, name: 'Cash From Operations(pre tax)', match: /cash\s*from\s*operations/i, threshold: 0, gapZero: false,
    green: 'consistent operating cash generation.', red: 'weak cash flows despite profits.' },
  { table: /fund\s*flow/i, name: 'Pre tax CFO / EBITDA(%)', match: /pre\s*tax\s*cfo/i, threshold: 80, gapZero: true,
    green: 'strong profit-to-cash conversion.', red: 'poor cash conversion, a long-term red flag.' },
  { table: /fund\s*flow/i, name: 'Free Cash Flow', match: /free\s*cash\s*flow/i, threshold: 0, gapZero: false,
    green: 'surplus cash post capex, interest, and tax.', red: 'cash burn and funding dependence.' },
  { table: /asset\s*efficiency/i, name: 'Capex / EBIDTA(%)', match: /capex\s*\/\s*ebidta/i, threshold: 0, gapZero: false, word: 'cumulative',
    green: 'the company is investing in capex to support future growth.', red: 'inadequate or stressed investment in the business.' },
  { table: /expense\s*analysis/i, name: 'Income tax paid / Income Tax Expenses', match: /income\s*tax\s*paid\s*\/\s*income\s*tax\s*expense/i, band: [-15, 15], gapZero: false, word: 'cumulative',
    green: 'cash tax paid is broadly in line with P&L tax expense over the long term.', red: 'timing differences, deferrals, or aggressive tax assumptions, requiring closer scrutiny.' },
  { table: /working\s*capital/i, name: 'Net Working Capital as % of sales', match: /net\s*working\s*capital\s*as\s*%\s*of\s*sales/i, vsLongTerm: true, word: 'average',
    green: 'indicate structurally improving operational efficiency.', red: 'indicate no meaningful improvement.' },
  { table: /working\s*capital/i, name: 'Debtors % of Sales', match: /debtors?\s*%\s*of\s*sales/i, vsLongTerm: true, word: 'average',
    green: 'indicate structurally improving operational efficiency.', red: 'indicate no meaningful improvement.' },
  { table: /working\s*capital/i, name: 'Inventory % Sales', match: /inventory\s*%\s*sales/i, vsLongTerm: true, word: 'average',
    green: 'indicate structurally improving operational efficiency.', red: 'indicate no meaningful improvement.' },
  // ShareHolding Pattern — no 3/5/10yr summary columns, so this reads the LATEST
  // populated period (e.g. 202603): 0% → green (no promoter leverage), > 0% → red.
  { table: /shareholding\s*pattern/i, name: 'Pledged Shares(%)', match: /pledged\s*shares/i, latestZero: true,
    green: 'indicates no promoter leverage.', red: 'indicates funding risk and potential forced selling risk.' },
];

// Normalise a summary cell to a display figure: "(-14.20)" -> "-14.20",
// "(-138.66%)" -> "-138.66%", "6.94" -> "6.94", "412.04%" -> "412.04%".
function fmtFlagFigure(raw) {
  let s = String(raw == null ? '' : raw).trim();
  const neg = /^\(.*\)$/.test(s) || /^[-−–—]/.test(s);
  s = s.replace(/[()]/g, '').replace(/^[-−–—]\s*/, '');
  return (neg ? '-' : '') + s;
}

// Parse a forensic tab once into { schema, periodRows (3yr/5yr/10yr), order, word }.
function prepForensicTab(tab) {
  const ct = (tab && tab.childTable) || [];
  if (ct.length < 2) return null;
  const periodRows = {};
  ct.slice(1).forEach(r => {
    const m = String(r.description || '').trim().match(/^(\d+)\s*yrs?$/i);
    if (m) periodRows[m[1] + 'yr'] = r;
  });
  return {
    schema: ct[0],
    periodRows,
    order: ['3yr', '5yr', '10yr'].filter(p => periodRows[p]),
    word: String(cagrGroupLabel(tab.tabName) || 'cumulative').toLowerCase(),
  };
}

// Deterministically build green/red flag statements from the loaded forensic
// tabs, per FORENSIC_FLAG_METRICS. Each metric is looked up in its source
// table and bucketed per period against its threshold, band, or 10yr
// benchmark (vsLongTerm). No AI.
function buildForensicFlags(data) {
  const allKeys = ['Row1','Row2','Row3','Row4','Row5','Row6','Row7','Row8','Row9','Row10','Row11'];
  const tabInfo = new Map();   // tab object -> prepForensicTab(tab)
  const green = [], red = [];

  FORENSIC_FLAG_METRICS.forEach(cfg => {
    const tab = (data || []).find(t => t && cfg.table.test(String(t.tabName || '')));
    if (!tab) return;
    if (!tabInfo.has(tab)) tabInfo.set(tab, prepForensicTab(tab));
    const info = tabInfo.get(tab);
    if (!info) return;
    const key = allKeys.find(k => cfg.match.test(parseForensicMetric(info.schema[k]).name || ''));
    if (!key) return;

    if (cfg.latestZero) {
      // Metric with no 3/5/10yr summary (ShareHolding): evaluate the LATEST
      // populated period column — 0% → green, > 0% → red — and cite that period.
      const rows = (tab.childTable || []).slice(1)
        .filter(r => /^\d{6}$/.test(String(r.description || '').trim()))
        .sort((a, b) => (parseInt(String(a.description).replace(/[^\d]/g, ''), 10) || 0)
                      - (parseInt(String(b.description).replace(/[^\d]/g, ''), 10) || 0));
      let latest = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const cell = parseForensicCell(rows[i][key]);
        const n = forensicNumericValue(cell.value);
        if (n == null) continue;                     // blank / "-" → skip, look earlier
        let f = fmtFlagFigure(cell.value);
        if (!/%\s*$/.test(f)) f += '%';              // Pledged Shares cells are bare numbers
        latest = { n, fig: f + ' (' + String(rows[i].description).trim() + ')' };
        break;
      }
      if (!latest) return;
      if (latest.n === 0)      green.push(cfg.name + ': ' + latest.fig + ' — ' + cfg.green);
      else if (latest.n > 0)   red.push(cfg.name + ': ' + latest.fig + ' — ' + cfg.red);
      return;
    }

    const word = cfg.word || info.word;            // per-metric override wins
    const figOf = (p) => {
      const r = info.periodRows[p] ? parseForensicCell(info.periodRows[p][key]).value : '';
      return { n: forensicNumericValue(r), fig: fmtFlagFigure(r) + ' (' + p + ')' };
    };
    const greenP = [], redP = [];

    if (cfg.vsLongTerm) {
      // Compare 3yr/5yr to the 10yr benchmark: below → green, at/above → red.
      // The 10yr is the reference — cited in every card the metric produces,
      // never bucketed on its own. No 10yr value → no benchmark → no flag.
      if (!info.periodRows['10yr']) return;
      const base = figOf('10yr');
      if (base.n == null) return;
      ['3yr', '5yr'].forEach(p => {
        if (!info.periodRows[p]) return;
        const c = figOf(p);
        if (c.n == null) return;
        (c.n < base.n ? greenP : redP).push(c.fig);   // at/above benchmark → red
      });
      if (greenP.length) green.push(cfg.name + ': ' + greenP.concat(base.fig).join(', ') + ' ' + word + ' — ' + cfg.green);
      if (redP.length)   red.push(cfg.name + ': ' + redP.concat(base.fig).join(', ') + ' ' + word + ' — ' + cfg.red);
      return;
    }

    info.order.forEach(p => {
      const c = figOf(p);
      if (c.n == null) return;                     // blank / "-" → data gap
      if (cfg.gapZero && c.n === 0) return;        // 0% → data gap (ratio metric)
      let bucket;
      if (cfg.band) {                              // green inside [lo, hi], red outside
        bucket = (c.n >= cfg.band[0] && c.n <= cfg.band[1]) ? 'green' : 'red';
      } else {                                     // green > threshold, red < threshold
        bucket = c.n > cfg.threshold ? 'green' : (c.n < cfg.threshold ? 'red' : null);
      }
      if (bucket === 'green') greenP.push(c.fig);
      else if (bucket === 'red') redP.push(c.fig);
    });
    if (greenP.length) green.push(cfg.name + ': ' + greenP.join(', ') + ' ' + word + ' — ' + cfg.green);
    if (redP.length)   red.push(cfg.name + ': ' + redP.join(', ') + ' ' + word + ' — ' + cfg.red);
  });
  return { green, red };
}

// Compute the flag cards for the current mode (instant, deterministic, cached).
function requestForensicFlags() {
  const fp = state.company.fp;
  if (!fp) return;
  if (fpFlagsState().status === 'done') return;   // already computed for this mode
  const { green, red } = buildForensicFlags(fp.data[fp.mode] || []);
  fpWriteFlags(fp.mode, { status: 'done', green, red, error: null });
  renderForensicFlagsCards();
}

// Reset a chip's link affordances back to a plain (non-clickable) chip.
function resetExchangeChip(chip) {
  if (!chip) return;
  chip.classList.remove('chip-link');
  chip.removeAttribute('role');
  chip.removeAttribute('tabindex');
  chip.removeAttribute('title');
  chip.onclick = null;
  chip.onkeydown = null;
}

// Set a ticker chip's label and, when a valid http(s) link is present, make
// it a keyboard-accessible deep-link that opens the exchange page in a NEW
// tab. No link → a plain chip (keeps the current chip colour/style either way).
function setExchangeChip(chip, prefix, code, link) {
  if (!chip) return;
  if (!code) { chip.hidden = true; resetExchangeChip(chip); return; }
  chip.hidden = false;
  chip.textContent = prefix + ': ' + code;
  const url = (link && /^https?:\/\//i.test(String(link).trim())) ? String(link).trim() : '';
  if (!url) { resetExchangeChip(chip); return; }
  const open = () => window.open(url, '_blank', 'noopener,noreferrer');
  chip.classList.add('chip-link');
  chip.setAttribute('role', 'link');
  chip.setAttribute('tabindex', '0');
  chip.title = 'Open on ' + prefix;
  chip.onclick = open;
  chip.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
}

function onSearchKeydown(e) {
  if (!state.gsearch.open) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const n = state.gsearch.results.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (n === 0) return;
    state.gsearch.highlighted = (state.gsearch.highlighted + 1) % n;
    renderSearchDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (n === 0) return;
    state.gsearch.highlighted = (state.gsearch.highlighted - 1 + n) % n;
    renderSearchDropdown();
  } else if (e.key === 'Enter') {
    const i = state.gsearch.highlighted;
    if (i >= 0 && state.gsearch.results[i]) {
      e.preventDefault();
      selectCompany(state.gsearch.results[i]);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    state.gsearch.open = false;
    renderSearchDropdown();
    e.target.blur();
  }
}

// Click anywhere outside the search shell to close the dropdown
document.addEventListener('click', e => {
  if (!e.target.closest('#globalSearchShell')) {
    if (state.gsearch.open) {
      state.gsearch.open = false;
      renderSearchDropdown();
    }
  }
  // Compare "+ Compare" pickers (per table): close when clicking outside a
  // section's own search host/button.
  const fp = state.company && state.company.fp;
  if (fp && fp.compare) {
    Object.keys(fp.compare).forEach(key => {
      const s = fp.compare[key].search;
      if (s && s.open
          && !e.target.closest('[data-cmp-search="' + key + '"]')
          && !e.target.closest('[data-cmp-btn="' + key + '"]')) {
        s.open = false;
        const sh = document.querySelector('#forensicPage [data-cmp-section="' + key + '"] [data-cmp-search]');
        if (sh) sh.innerHTML = '';
      }
    });
  }
});

// Cmd/Ctrl-K focuses the search from anywhere on the page (matching the ⌘K hint)
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const input = document.getElementById('globalSearchInput');
    if (input) { input.focus(); input.select(); }
  }
});

(function wireGlobalSearch() {
  const input = document.getElementById('globalSearchInput');
  if (!input) return;
  input.addEventListener('input', onSearchInput);
  input.addEventListener('keydown', onSearchKeydown);
  input.addEventListener('focus', () => {
    if (state.gsearch.query.length > 0) {
      state.gsearch.open = true;
      renderSearchDropdown();
    }
  });
})();

/* ============================ DAILY READING GLOBAL SEARCH ============================
   A prominent search section that filters the currently-loaded items from
   each of the three Daily Reading tabs and renders matches grouped by tab
   in card form, with the matched keyword highlighted wherever it appears
   in any visible text field of the card.

   Scope:
     state.drsearch.scope ∈ 'all' | 'announcements' | 'reports' | 'tv'
     Scope pills are mutually exclusive; clicking a pill re-filters live.

   Fields searched per tab (unchanged from prior implementation, the
   matchers below are reused for both the live filter and the scoped
   filter):
     • Corp Announcement: stockName + category label
     • Reports:           CompanyName + SectorName + BrokerName + ReportType[]
     • Mgmt TV Bytes:     company + industry

   Strategy:
     - Substring match (case-insensitive), 200ms debounce on input.
     - Search button re-runs the query immediately (clears the debounce
       and re-renders). Enter key does the same.
     - Lazy-load: focusing the input triggers loadReports() and
       loadTvBytes() if those tabs haven't been visited yet. Each loader's
       finally block calls notifyDrSearch() so late-arriving data surfaces
       in the results without requiring a retype.
     - Each section capped at 10 cards; overflow shown as "+ N more".
     - Click a card → opens the natural URL (PDF / YouTube) in a new tab.
       Items without a URL render slightly muted with cursor: default. */

state.drsearch = {
  query: '',
  scope: 'all',
  debounceTimer: null,
};

function drAnnMatch(it, q) {
  const name = String(it.stockName || it.get_full_name || '').toLowerCase();
  const catId = categorize(it);
  const cat = (catId && ANN_CAT_BY_ID[catId] ? ANN_CAT_BY_ID[catId].label : '').toLowerCase();
  return name.indexOf(q) !== -1 || cat.indexOf(q) !== -1;
}
function drReportsMatch(it, q) {
  const co = String(it.CompanyName || '').toLowerCase();
  const se = String(it.SectorName  || '').toLowerCase();
  const br = String(it.BrokerName  || '').toLowerCase();
  const types = Array.isArray(it.ReportType) ? it.ReportType.join(' ').toLowerCase() : '';
  return co.indexOf(q) !== -1 || se.indexOf(q) !== -1 || br.indexOf(q) !== -1 || types.indexOf(q) !== -1;
}
function drTvMatch(it, q) {
  const co  = String(it.company  || '').toLowerCase();
  const ind = String(it.industry || '').toLowerCase();
  return co.indexOf(q) !== -1 || ind.indexOf(q) !== -1;
}

// Wraps every case-insensitive occurrence of `query` inside `text` with
// <span class="dr-hl">. Operates on raw text and escapes each segment
// individually so HTML stays safe and the highlight wrapper isn't itself
// escaped. Empty query → just escapes the text.
function drHighlight(text, query) {
  const t = String(text == null ? '' : text);
  const q = String(query == null ? '' : query);
  if (!q) return escapeHtml(t);
  const tl = t.toLowerCase();
  const ql = q.toLowerCase();
  let out = '';
  let i = 0;
  while (i < t.length) {
    const idx = tl.indexOf(ql, i);
    if (idx === -1) { out += escapeHtml(t.slice(i)); break; }
    out += escapeHtml(t.slice(i, idx));
    out += '<span class="dr-hl">' + escapeHtml(t.slice(idx, idx + q.length)) + '</span>';
    i = idx + q.length;
  }
  return out;
}

function renderDrAnnCard(it, q) {
  const name = it.stockName || it.get_full_name || '—';
  const catId = categorize(it);
  const catObj = catId && ANN_CAT_BY_ID[catId] ? ANN_CAT_BY_ID[catId] : null;
  const catLabel = catObj ? catObj.label : '';
  const catColor = catObj && catObj.color ? catObj.color : null;
  const title = typeof stripTitlePrefix === 'function' ? stripTitlePrefix(it.title || '') : (it.title || '');
  const date = fmtDateTime(it.pubDate || it.lastUpdated) || '';
  const url = it.pdfUrl || '';
  const initials = (name || 'XX').slice(0, 3).toUpperCase();
  const markColor = colorFromString(name);
  const tagStyle = catColor
    ? `background:${rgba(catColor, 0.08)};color:${catColor};border-color:${rgba(catColor, 0.30)}`
    : '';
  const tag = catLabel
    ? `<span class="dr-result-tag" style="${tagStyle}">${escapeHtml(catLabel)}</span>`
    : '';
  const tag_ = tag;

  const titleHtml = drHighlight(title || name, q);
  const descParts = [drHighlight(name, q)];
  if (date) descParts.push(`<span class="dr-result-date">${escapeHtml(date)}</span>`);
  const descHtml = descParts.join('<span class="sep">·</span>');

  const tag2 = url ? 'a' : 'div';
  const attrs = url ? `href="${safeAttr(url)}" target="_blank" rel="noopener noreferrer"` : '';
  return `<${tag2} class="dr-result-card${url ? '' : ' dr-result-card-no-link'}" ${attrs}>
    <div class="tk-mark" style="background:${markColor}">${escapeHtml(initials)}</div>
    <div class="dr-result-body">
      <div class="dr-result-head">
        <span class="dr-result-title">${titleHtml}</span>
        ${tag_}
      </div>
      <div class="dr-result-desc">${descHtml}</div>
    </div>
  </${tag2}>`;
}

function renderDrReportCard(it, q) {
  const sector = String(it.SectorName || '').trim();
  const broker = String(it.BrokerName || '').trim();
  const types = Array.isArray(it.ReportType) ? it.ReportType : [];
  const title = String(it.Title || '').trim();
  const date = String(it.Date || it.ReportDate || '').trim();
  const url = it.link || '';

  // Distinguish a true company-level report from a sector-level one. The
  // Reports API returns `CompanyName` empty (or equal to the sector) for
  // sector reports — in those cases the visible "company" must fall back
  // to the sector for the mark/title, but we must NOT then render the
  // sector AGAIN in the description, or the same value reads twice
  // ("Capital Goods · Yes Securities · Capital Goods"). Mirrors the
  // identical guard in the Reports tab's own renderReportCard.
  const companyRaw = String(it.CompanyName || '').trim();
  const hasRealCompany = !!companyRaw && companyRaw !== sector;
  const displayCo = companyRaw || sector || '—';

  const initials = sector ? sector.slice(0, 3).toUpperCase() : (displayCo.slice(0, 3).toUpperCase());
  const markColor = colorFromString(sector || displayCo || broker);

  // Render ALL report types as separate chips — matches the Reports tab's
  // own multi-chip display. A report frequently carries more than one type
  // (e.g. "Sector Update" + "Result Review"), and showing only the first
  // hides material context. The .dr-result-head row uses flex-wrap, so
  // multiple chips lay out cleanly even on narrow widths.
  const tagsHtml = types
    .filter(t => t && String(t).trim())
    .map(t => {
      const name = String(t).trim();
      let style = '';
      if (typeof repTypeColor === 'function') {
        const c = repTypeColor(name);
        style = `background:${rgba(c, 0.08)};color:${c};border-color:${rgba(c, 0.30)}`;
      }
      return `<span class="dr-result-tag" style="${style}">${escapeHtml(name)}</span>`;
    })
    .join('');

  const titleHtml = drHighlight(title || displayCo, q);

  // Description parts — company is suppressed when it would duplicate
  // the sector. So a sector-level Capital Goods report reads as
  // "Capital Goods · Yes Securities · 04-Jun-2026" (one Capital Goods),
  // while a company report under that sector reads as
  // "Reliance Industries · Capital Goods · Yes Securities · 04-Jun-2026"
  // (the two values are distinct so both appear).
  const descParts = [];
  if (hasRealCompany) descParts.push(drHighlight(companyRaw, q));
  if (sector)         descParts.push(drHighlight(sector, q));
  if (broker)         descParts.push(drHighlight(broker, q));
  if (date)           descParts.push(`<span class="dr-result-date">${escapeHtml(date)}</span>`);
  const descHtml = descParts.join('<span class="sep">·</span>');

  const tag2 = url ? 'a' : 'div';
  const attrs = url ? `href="${safeAttr(url)}" target="_blank" rel="noopener noreferrer"` : '';
  return `<${tag2} class="dr-result-card${url ? '' : ' dr-result-card-no-link'}" ${attrs}>
    <div class="tk-mark" style="background:${markColor}">${escapeHtml(initials)}</div>
    <div class="dr-result-body">
      <div class="dr-result-head">
        <span class="dr-result-title">${titleHtml}</span>
        ${tagsHtml}
      </div>
      <div class="dr-result-desc">${descHtml}</div>
    </div>
  </${tag2}>`;
}

function renderDrTvCard(it, q) {
  const co = it.company || '—';
  const industry = it.industry || '';
  const person = it.person || '';
  const date = it.dateStr || '';
  const url = it.youtubeUrl || '';
  const initials = (co || 'XX').slice(0, 3).toUpperCase();
  const markColor = colorFromString(co);

  const tag = industry
    ? `<span class="dr-result-tag">${drHighlight(industry, q)}</span>`
    : '';

  const titleHtml = drHighlight(co, q);
  const descParts = [];
  if (person) descParts.push(escapeHtml(person));
  if (date)   descParts.push(`<span class="dr-result-date">${escapeHtml(date)}</span>`);
  const descHtml = descParts.join('<span class="sep">·</span>');

  const tag2 = url ? 'a' : 'div';
  const attrs = url ? `href="${safeAttr(url)}" target="_blank" rel="noopener noreferrer"` : '';
  return `<${tag2} class="dr-result-card${url ? '' : ' dr-result-card-no-link'}" ${attrs}>
    <div class="tk-mark" style="background:${markColor}">${escapeHtml(initials)}</div>
    <div class="dr-result-body">
      <div class="dr-result-head">
        <span class="dr-result-title">${titleHtml}</span>
        ${tag}
      </div>
      ${descHtml ? `<div class="dr-result-desc">${descHtml}</div>` : ''}
    </div>
  </${tag2}>`;
}

function renderDrSearchResults() {
  const wrap = document.getElementById('drSearchResults');
  if (!wrap) return;
  const q = String(state.drsearch.query || '').trim();
  if (!q) {
    wrap.innerHTML = '';
    wrap.hidden = true;
    return;
  }
  const ql = q.toLowerCase();
  const scope = state.drsearch.scope;
  const includeAnn = (scope === 'all' || scope === 'announcements');
  const includeRep = (scope === 'all' || scope === 'reports');
  const includeTv  = (scope === 'all' || scope === 'tv');

  const annM = includeAnn ? (state.ann.items     || []).filter(it => drAnnMatch(it, ql))    : [];
  const repM = includeRep ? (state.reports.items || []).filter(it => drReportsMatch(it, ql)) : [];
  const tvM  = includeTv  ? (state.tv.items      || []).filter(it => drTvMatch(it, ql))     : [];
  const total = annM.length + repM.length + tvM.length;

  let html = `<div class="dr-results-meta">
    <div class="dr-results-meta-label">Showing results for <strong>"${escapeHtml(q)}"</strong></div>
    <button type="button" class="dr-results-clear" id="drResultsClear"><span class="dr-results-clear-x">×</span> Clear results</button>
  </div>`;

  if (total === 0) {
    const loading = state.ann.loading || state.reports.loading || state.tv.loading;
    html += `<div class="dr-no-results">
      No matches for <strong>"${escapeHtml(q)}"</strong>
      ${loading ? '<br><span style="font-size:11px;opacity:0.8">Some tabs still loading — results may appear shortly.</span>' : ''}
    </div>`;
  } else {
    const CAP = 10;
    if (annM.length) {
      html += `<section class="dr-results-group">
        <header class="dr-results-group-head">Corp Announcements <span class="dr-results-group-count">(${annM.length})</span></header>
        ${annM.slice(0, CAP).map(it => renderDrAnnCard(it, q)).join('')}
        ${annM.length > CAP ? `<div class="dr-more">+ ${annM.length - CAP} more in Corp Announcements</div>` : ''}
      </section>`;
    }
    if (repM.length) {
      html += `<section class="dr-results-group">
        <header class="dr-results-group-head">Reports <span class="dr-results-group-count">(${repM.length})</span></header>
        ${repM.slice(0, CAP).map(it => renderDrReportCard(it, q)).join('')}
        ${repM.length > CAP ? `<div class="dr-more">+ ${repM.length - CAP} more in Reports</div>` : ''}
      </section>`;
    }
    if (tvM.length) {
      html += `<section class="dr-results-group">
        <header class="dr-results-group-head">Mgmt TV Bytes <span class="dr-results-group-count">(${tvM.length})</span></header>
        ${tvM.slice(0, CAP).map(it => renderDrTvCard(it, q)).join('')}
        ${tvM.length > CAP ? `<div class="dr-more">+ ${tvM.length - CAP} more in Mgmt TV Bytes</div>` : ''}
      </section>`;
    }
  }

  wrap.innerHTML = html;
  wrap.hidden = false;

  const clearBtn = document.getElementById('drResultsClear');
  if (clearBtn) clearBtn.addEventListener('click', clearDrSearch);
}

function onDrSearchInput(e) {
  const q = e.target.value;
  state.drsearch.query = q;
  clearTimeout(state.drsearch.debounceTimer);
  state.drsearch.debounceTimer = setTimeout(renderDrSearchResults, 200);
}
function clearDrSearch() {
  state.drsearch.query = '';
  const input = document.getElementById('drSearchInput');
  if (input) input.value = '';
  const results = document.getElementById('drSearchResults');
  if (results) { results.innerHTML = ''; results.hidden = true; }
}

// Post-load hook — re-render results when a lazy-loaded tab finishes.
// Cheap no-op when no query is active.
function notifyDrSearch() {
  if (state.drsearch && state.drsearch.query) renderDrSearchResults();
}

(function wireDrSearch() {
  const input = document.getElementById('drSearchInput');
  const btn   = document.getElementById('drSearchBtn');
  const bar   = document.getElementById('drSearchBar');
  if (!input || !bar) return;

  input.addEventListener('input', onDrSearchInput);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(state.drsearch.debounceTimer);
      renderDrSearchResults();
    } else if (e.key === 'Escape') {
      clearDrSearch();
      input.blur();
    }
  });
  input.addEventListener('focus', () => {
    // Kick off any unloaded tabs so the search can surface results across
    // all three. Loaders are idempotent — they no-op when already loaded
    // or in flight; the post-load notifyDrSearch() hook re-renders results
    // when each load completes.
    if (!state.reports.loaded && !state.reports.loading && !state.reports.error) {
      loadReports({ force: false });
    }
    if (!state.tv.loaded && !state.tv.loading && !state.tv.error) {
      loadTvBytes({ force: false });
    }
  });

  // Search button — immediate-run (clears debounce, re-renders now).
  if (btn) btn.addEventListener('click', () => {
    clearTimeout(state.drsearch.debounceTimer);
    renderDrSearchResults();
    input.focus();
  });

  // Scope pills — single-select. Clicking sets state.drsearch.scope and
  // re-renders if a query is active. Active pill carries .active + aria-pressed.
  bar.querySelectorAll('.dr-scope-pill[data-scope]').forEach(pill => {
    pill.addEventListener('click', () => {
      const scope = pill.dataset.scope;
      if (scope === state.drsearch.scope) return;
      state.drsearch.scope = scope;
      bar.querySelectorAll('.dr-scope-pill').forEach(p => {
        const on = (p.dataset.scope === scope);
        p.classList.toggle('active', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (state.drsearch.query) renderDrSearchResults();
    });
  });
})();

/* ============================ SIDEBAR USER MENU ============================
   Opens an upward-anchored popup when the user clicks the 3-dot button in
   the sidebar bottom profile card. The popup contains placeholder menu
   items (Account / Settings / Watchlists / Sign out) that currently log
   to the console; wire real handlers when auth and user-settings flows
   exist. Closes on outside-click or Escape. */
/* ============================ SETTINGS PAGE ============================
   The Settings view is a sibling of #dailyView and only one is visible at
   a time (toggled via the `hidden` attribute on each .content block).
   Sub-tabs (Profile / Watchlists / Notifications / Password) live entirely
   in state.settings.tab; only Profile has built-out content for now.

   Persistence: state.settings.profile is mirrored to localStorage under
   'omkara.settings' on every save. When a real backend is wired, swap the
   readSettings/writeSettings calls with API calls — the rest of the page
   is decoupled from the storage mechanism. Avatar is stored as a data
   URL; we cap at 2 MB on upload to keep localStorage within budget. */

const SETTINGS_STORAGE_KEY = 'omkara.settings';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap, shown in the UI hint
const AVATAR_ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

state.view = 'daily';
// Company-view state — populated when the user picks a search result.
//   data: the SymbolMaster row for the currently-displayed company
//         ({ CompanyID, CompanyName, NSESymbol, BSECode, Sector, Industry, ... }).
//         null when no company has been opened in this session yet.
//   tab : which Company-page tab is active ('overview' is default; other
//         tabs render the cv-coming-soon placeholder for now).
//   shellBuilt: latched true after the static skeleton has been injected
//         once; further opens reuse the DOM and only update dynamic
//         strings (company name, tickers, sector meta) via renderCompanyDynamic().
state.company = {
  data: null,
  tab: 'overview',
  shellBuilt: false,
  headerOnly: false,   // Forensic page shows only the .co-header card (no tabs/panes/forensic API)
  // companynote enrichment for the Forensic header card. `companyId` is the
  // id we requested so a late response for a previous company is ignored.
  note: { companyId: null, data: null },
  // Forensic PAGE "Single Page" tab (separate from the normal company view's
  // Forensic tab). con/std data is cached per mode for instant toggling.
  fp: { mode: 'con', data: { con: null, std: null }, loading: false, error: null, buttonStatus: { con: true, std: true }, abortController: null, shYearly: false },
  // Forensic-tab sub-state. The Forensic tab is itself a mini-app with
  // a Single Page sub-tab and Consolidated / Standalone mode pills, so
  // it gets its own little reducer-ish block. `data[mode]` holds the
  // full API response per mode for the CURRENTLY LOADED company —
  // there is no cross-company cache; selectCompany clears the whole
  // sub-state on every company switch, and loadForensic always does
  // a fresh fetch when invoked. activeCategoryIdx is the index into
  // Data[] for the category tab strip below the hero (Snapshot is
  // permanent hero so we default to index 1 = Averages).
  forensic: {
    mode: 'con',
    activeCategoryIdx: 1,
    data: { con: null, std: null },
    loading: false,
    error: null,
    rendered: false,
    abortController: null,
    buttonStatus: { con: true, std: true },
  },
};
state.settings = {
  tab: 'profile',
  profile: {
    fullName: 'Profile',
    email: 'profile@omkaracapital.in',
    avatarDataUrl: null,
  },
  // Per-field status: 'idle' | 'saving' | 'saved' | 'error'. Used to
  // briefly flip the action button to a "Saved" state, then back.
  status: { name: 'idle', email: 'idle' },
};

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.profile) {
      Object.assign(state.settings.profile, parsed.profile);
    }
  } catch (_) { /* corrupt storage — ignore and keep defaults */ }
}
function writeSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ profile: state.settings.profile }));
  } catch (_) { /* quota or private-mode — silently degrade */ }
}

/* ---- View router ---- */
function showView(name) {
  // Sibling .content blocks live under <main>. The router toggles `hidden`
  // on each so exactly one is visible. Anything outside them (topbar,
  // sidebar) stays mounted — they're shared chrome.
  const valid = ['daily', 'settings', 'company', 'forensic'];
  const target = valid.indexOf(name) >= 0 ? name : 'daily';
  state.view = target;

  // Forensic flow flag. Entering Forensic arms "forensic intent" so the next
  // company picked from the top search opens on the Forensic tab. Leaving to
  // a normal page (Daily Reading / Settings) disarms it; opening a Company
  // page leaves it as-is so a pick made from the Forensic landing stays in
  // the forensic flow.
  if (target === 'forensic') state.forensicMode = true;
  else if (target === 'daily' || target === 'settings') state.forensicMode = false;

  const dailyEl    = document.getElementById('dailyView');
  const settingsEl = document.getElementById('settingsView');
  const companyEl  = document.getElementById('companyView');
  const forensicEl = document.getElementById('forensicView');
  if (dailyEl)    dailyEl.hidden    = (target !== 'daily');
  if (settingsEl) settingsEl.hidden = (target !== 'settings');
  if (companyEl)  companyEl.hidden  = (target !== 'company');
  if (forensicEl) forensicEl.hidden = (target !== 'forensic');

  // Sidebar active-state — only the nav-item matching data-view is active.
  // The Company view has no matching nav-item, so all items deactivate —
  // EXCEPT when we're in the forensic flow, where the Company page is the
  // forensic result, so the Forensic nav stays highlighted.
  document.querySelectorAll('.sidebar .nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === target);
  });
  if (state.forensicMode && target === 'company') {
    const fnav = document.querySelector('.sidebar .nav-item[data-view="forensic"]');
    if (fnav) fnav.classList.add('active');
  }

  if (target === 'settings') renderSettingsPanel();
  if (target === 'company')  renderCompanyView();
  if (target === 'forensic') {
    // Reopen the Forensic module on the LAST selected company (persisted to
    // localStorage) instead of the empty landing. First-time users — or a
    // stale/unresolvable saved entry — still get the "Select a company" state.
    const saved = readLastForensicCompany();
    if (saved && resolveCompanyId(saved)) {
      const savedId = String(resolveCompanyId(saved));
      const curId = state.company.data ? String(resolveCompanyId(state.company.data) || '') : '';
      const alreadyLoaded = state.company.headerOnly && curId && curId === savedId
        && state.company.fp && (state.company.fp.data.con || state.company.fp.loading);
      if (alreadyLoaded) {
        // Same company already in memory — just reveal it, no refetch.
        showView('company');
      } else {
        // Fresh load (Consolidated); selectCompany switches to the company view.
        selectCompany(saved);
      }
      return;
    }
    if (saved) clearLastForensicCompany();  // unresolvable — drop it
    // Drop focus into the top search so the user can type a company
    // immediately, matching "select a company from the search bar above".
    const gs = document.getElementById('globalSearchInput');
    if (gs) { try { gs.focus(); } catch (_) {} }
  }

  // Give each named top-level view a stable URL hash. Daily Reading is the
  // site HOME page ("#home"); Forensic gets "#forensic"; the Company sub-page
  // clears the hash since it's reached by selecting a company, not a route.
  // replaceState (not location.hash =) means no scroll jump, no history spam,
  // and it does NOT fire the hashchange listener, so there's no routing loop.
  try {
    const hashFor = { daily: '#home', settings: '#settings', forensic: '#forensic', company: '' };
    const want = hashFor[target] != null ? hashFor[target] : '';
    if ((location.hash || '') !== want) {
      history.replaceState(null, '', location.pathname + location.search + want);
    }
  } catch (_) { /* history API unavailable — navigation still works */ }
  // Re-evaluate the floating "back to categories" FAB. Without this, the
  // FAB would only refresh on next scroll, leaving a stale orange bubble
  // hanging over Settings or Company right after a view switch.
  if (typeof updateFabVisibility === 'function') updateFabVisibility();
  // Snap to top so a tall page underneath doesn't leave the new view
  // half-scrolled. Cheap and feels right when switching contexts.
  try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (_) { window.scrollTo(0, 0); }
}

/* ============================================================
   COMPANY VIEW — rendering
   ============================================================
   The Company page is rendered in two halves:

   1. Static shell  (renderCompanyShell)
      Built once on first open and stashed inside #companyShell. The
      KPI strip, valuation table, donut, financial table, peer table,
      and tab bar are all visual scaffolding — they don't change when
      the user opens a different company. Building once avoids 30+
      financial-row table cells being re-stringified on every open.

   2. Dynamic strings  (renderCompanyDynamic)
      Runs on every open with the current state.company.data. Updates
      the H1, the NSE/BSE chips, sector / industry / promoter meta,
      description, and the ticker-mark initials. This is the only path
      that should write to the DOM during a tab-pane reveal.

   Tab handling:
      Only Overview is built out. The other 11 tabs all render the
      same cv-coming-soon placeholder card. Tab switching just toggles
      a `[data-pane]` visibility flag — no per-tab DOM tree.

   Charts:
      Three Chart.js charts live on the Overview pane: the main bar+line
      Operating Performance chart, plus row-expand trend charts for Net
      Sales / Operating Profit / Net Profit. They're created lazily on
      first Overview reveal so the page doesn't pay the chart-init cost
      if the user just opens the company and immediately bounces.
      Sparkline (header) + donut (shareholding) are inline SVG, no library.
   ============================================================ */

/* ---- Demo data for Overview ----
   These are placeholder numbers shared across all companies — the page
   uses them so the visual lines up. Wire real per-company financials
   here once the data API is available. */
const CV_QLABELS = ['Sep 22','Dec 22','Mar 23','Jun 23','Sep 23','Dec 23','Mar 24','Jun 24','Sep 24','Dec 24','Mar 25','Jun 25','Sep 25','Dec 25'];
const CV_REV     = [1417,1496,1418,1200,1093,1341,1413,1514,1451,1316,1325,1316,1339,1612];
const CV_OPP     = [ 324, 469, 465, 363, 236, 417, 407, 510, 533, 357, 365, 489, 406, 678];
const CV_NP      = [  92, 211, 203, 135,  53, 111, 177, 223, 221,  61, 128, 273, 161, 320];
const CV_DEP     = [ 190, 195, 196, 197, 200, 251, 241, 220, 234, 255, 243, 250, 256, 271];
const CV_EBI     = CV_OPP.map((v,i) => v + CV_DEP[i]);
const CV_OPM     = CV_OPP.map((v,i) => +(v / CV_REV[i] * 100).toFixed(1));
// YoY% rolling — '—' for the first 4 (no comparable quarter), then qoq YoY
function cvYoY(arr) {
  return arr.map((v, i) => {
    if (i < 4) return '—';
    const prev = arr[i - 4];
    if (!prev) return '—';
    const p = ((v - prev) / prev) * 100;
    return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
  });
}
const CV_REV_YOY = cvYoY(CV_REV);
const CV_EPS = CV_NP.map(v => +(v / 46.84).toFixed(2)); // demo share count

// Financial table rows. Each row: { label, kind, values, fmt } — kind
// drives styling ('bold', 'subtle', undefined for normal), fmt is the
// per-value formatter, values is either a number array or a string array
// (already formatted, used for YoY% and EPS).
const CV_FIN_ROWS = [
  { label: 'Net Sales',                  kind: 'bold',   values: CV_REV,  hasChart: 'rev' },
  { label: 'YoY Growth',                 kind: 'subtle', values: CV_REV_YOY, preformatted: true, signed: true },
  { label: 'Cost of Goods Sold',         kind: '',       values: new Array(14).fill('—'), preformatted: true },
  { label: 'Gross Profit',               kind: 'bold',   values: CV_REV },
  { label: 'Gross Profit Margin (%)',    kind: 'subtle', values: new Array(14).fill('100%'), preformatted: true },
  { label: 'Employee Expense',           kind: '',       values: [111,110,160,107,116,135,145,119,123,163,163,127,132,154] },
  { label: '% of Sales',                 kind: 'subtle', values: ['7.8%','7.4%','11.3%','8.9%','10.6%','10.1%','10.3%','7.9%','8.5%','12.4%','12.3%','9.6%','9.9%','9.6%'], preformatted: true },
  { label: 'Other Expenditure',          kind: '',       values: [983,917,793,731,741,789,860,885,795,795,797,700,800,779] },
  { label: '% of Sales',                 kind: 'subtle', values: ['69%','61%','56%','61%','68%','59%','61%','58%','55%','60%','60%','53%','60%','48%'], preformatted: true },
  { label: 'Operating Profit (Ex OI)',   kind: 'bold',   values: CV_OPP, hasChart: 'op' },
  { label: 'OPM %',                      kind: 'bold',   values: CV_OPM.map(v => v.toFixed(1) + '%'), preformatted: true },
  { label: 'Depreciation',               kind: '',       values: CV_DEP },
  { label: 'PBT',                        kind: 'bold',   values: [125,282,274,182,73,151,239,299,299,83,171,365,215,428] },
  { label: 'Tax',                        kind: '',       values: [33,71,71,47,20,40,62,76,78,22,43,92,54,108] },
  { label: 'Net Profit',                 kind: 'bold',   values: CV_NP, hasChart: 'np' },
  { label: 'EPS (₹)',                    kind: 'subtle', values: CV_EPS.map(v => v.toFixed(2)), preformatted: true },
];

// Peer table. CMP / Mkt Cap etc. are demo numbers; only the highlight
// row's company name + ticker change per-company at render time.
const CV_PEER_ROWS = [
  { tk:'GES', nm:'Great Eastern Shipping',    sub:'NSE: GESHIP',     cmp:'1,142.50', mc:'16,308', pe:'5.90',  pbv:'1.10',  ev:'3.85',  roce:'22.40%', roe:'19.80%', opm:'57.1%', de:'0.42', sales:'5,840', ret:'+14.2%', retCls:'pos' },
  { tk:'MZD', nm:'Mazagon Dock Shipbuilders', sub:'NSE: MAZDOCK',    cmp:'4,238.10', mc:'85,470', pe:'42.30', pbv:'10.20', ev:'27.40', roce:'38.70%', roe:'34.20%', opm:'14.8%', de:'0.01', sales:'9,467', ret:'+58.3%', retCls:'pos' },
  { tk:'CSL', nm:'Cochin Shipyard',           sub:'NSE: COCHINSHIP', cmp:'1,608.40', mc:'42,196', pe:'38.50', pbv:'7.80',  ev:'23.10', roce:'21.40%', roe:'18.90%', opm:'15.6%', de:'0.04', sales:'4,275', ret:'+72.9%', retCls:'pos' },
  { tk:'GRS', nm:'Garden Reach Shipbuilders', sub:'NSE: GRSE',       cmp:'1,820.65', mc:'20,838', pe:'52.10', pbv:'9.40',  ev:'34.20', roce:'17.20%', roe:'19.80%', opm:'9.4%',  de:'0.00', sales:'3,852', ret:'+44.5%', retCls:'pos' },
  { tk:'SMC', nm:'Seamec Ltd.',               sub:'NSE: SEAMECLTD',  cmp:'1,058.20', mc:'2,693',  pe:'14.20', pbv:'1.60',  ev:'7.10',  roce:'11.80%', roe:'10.40%', opm:'32.5%', de:'0.18', sales:'578',   ret:'−5.2%',  retCls:'neg' },
];

const CV_TABS = [
  { id:'overview',   label:'Overview' },
  { id:'chart',      label:'Chart' },
  { id:'financials', label:'Financials', count:'14Q' },
  { id:'peers',      label:'Peers', count:'11' },
  { id:'stats',      label:'Stock Stats' },
  { id:'brief',      label:'Brief' },
  { id:'deliveries', label:'Deliveries' },
  { id:'docs',       label:'Client Docs', count:'142' },
  { id:'exchange',   label:'Exchange & Reports' },
  { id:'forensic',   label:'Forensic' },
  { id:'notes',      label:'Notes', count:'8' },
  { id:'media',      label:'Media' },
];

// Live-price + KPI demo numbers. These don't depend on the company
// (same for everyone) — the dynamic binding only changes the NAME and
// the NSE/BSE chip values. Wire to a real-time price API later.
const CV_DEMO_PRICE   = 288.29;
const CV_DEMO_DELTA   = -4.30;
const CV_DEMO_DELTAPC = -1.47;
const CV_DEMO_LOW52W  = 158;
const CV_DEMO_HIGH52W = 323;

// Holds Chart.js instances so we can dispose / update them on re-render
// without leaking. Keyed by chart slot ('main', 'rev', 'op', 'np').
const cvCharts = {};

/* ---- Entry point: render the Company view ---- */
function renderCompanyView() {
  if (!state.company.data) return;       // defensive — selectCompany always sets it first
  if (!state.company.shellBuilt) {
    renderCompanyShell();
    state.company.shellBuilt = true;
    wireCompanyTabs();
  }
  renderCompanyDynamic();
  // Forensic page = header-only: hide the tab bar + panes (CSS via this
  // class) and skip the chart build entirely. Only the .co-header card —
  // name, badges, sector/industry/ISIN, description, live-price panel —
  // remains. The normal company page clears the class and renders fully.
  const cv = document.getElementById('companyView');
  if (cv) cv.classList.toggle('cv-header-only', !!state.company.headerOnly);
  // The Forensic page's Single Page section lives only in the forensic flow.
  const fpEl = document.getElementById('forensicPage');
  if (fpEl) fpEl.hidden = !state.company.headerOnly;
  if (state.company.headerOnly) return;
  // Charts depend on Chart.js being loaded. The script tag has `defer`,
  // so on first reveal it may still be in flight; poll briefly.
  ensureCompanyCharts();
}

/* ---- Static shell: built once, reused ---- */
function renderCompanyShell() {
  const root = document.getElementById('companyShell');
  if (!root) return;

  // Header sparkline path is computed once with a deterministic-ish
  // synthetic series so we don't churn the SVG every open.
  const sparkPath = cvBuildSparkPath();

  // Build the financial-table tbody from CV_FIN_ROWS so we don't have
  // 30+ rows of identical HTML soup. Each row optionally includes a
  // chart-toggle button (hasChart) and may have a paired chart-row that
  // can expand below it.
  const finTbodyRows = CV_FIN_ROWS.map((r, i) => {
    const labelCell = r.hasChart
      ? `<td class="sticky-left">
           <div class="row-label-wrap" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
             <span>${escapeHtml(r.label)}</span>
             <button type="button" class="cv-icon-btn" data-rowchart="${r.hasChart}" aria-label="Toggle ${escapeHtml(r.label)} trend chart" title="Show trend chart" style="width:24px;height:22px">
               <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="9" width="1.6" height="5" rx="0.6"/><rect x="7.2" y="5" width="1.6" height="9" rx="0.6"/><rect x="11.4" y="7" width="1.6" height="7" rx="0.6"/></svg>
             </button>
           </div>
         </td>`
      : `<td class="sticky-left">${escapeHtml(r.label)}</td>`;
    const dataCells = r.values.map((v) => {
      let text;
      let cls = '';
      if (r.preformatted) {
        text = String(v);
        if (r.signed) {
          if (text.startsWith('+')) cls = ' class="pos"';
          else if (text.startsWith('−') || text.startsWith('-')) cls = ' class="neg"';
        }
      } else {
        text = (typeof v === 'number') ? v.toLocaleString('en-IN') : String(v);
      }
      return `<td${cls}>${text}</td>`;
    }).join('');
    const klass = r.kind ? ` class="${r.kind}"` : '';
    let chartRow = '';
    if (r.hasChart) {
      chartRow = `<tr class="cv-chart-row" id="cvChartRow-${r.hasChart}" hidden>
        <td colspan="${CV_QLABELS.length + 1}" style="background:var(--bg-soft);padding:14px 22px;border-bottom:1px solid var(--line)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11.5px;color:var(--muted);letter-spacing:0.04em">Trend · ${escapeHtml(r.label)}</div>
            <button type="button" class="cv-icon-btn" data-closerow="${r.hasChart}" aria-label="Close chart" style="width:22px;height:22px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div style="position:relative;height:140px"><canvas id="cvRowChart-${r.hasChart}"></canvas></div>
        </td>
      </tr>`;
    }
    return `<tr${klass}>${labelCell}${dataCells}</tr>${chartRow}`;
  }).join('');

  const finHeadCells = ['<th class="sticky-left">Description</th>']
    .concat(CV_QLABELS.map(q => `<th>${escapeHtml(q)}</th>`))
    .join('');

  // Peer table — the highlighted row (current company) sits at the top;
  // peers fill the rest. Rendered as a placeholder for the current row;
  // renderCompanyDynamic() updates the name + ticker + sub.
  const peerHighlight = `<tr class="highlight" id="cvPeerSelf">
    <td>1</td>
    <td><div class="ticker-cell"><div class="ticker-mark" id="cvPeerSelfMark">—</div><div><div class="nm" id="cvPeerSelfName">—</div><div class="sub" id="cvPeerSelfSub">—</div></div></div></td>
    <td>${CV_DEMO_PRICE.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>13,429</td><td>11.80</td><td>1.50</td><td>6.59</td>
    <td class="pos">10.00%</td><td class="pos">12.74%</td><td>34.7%</td><td>0.30</td><td>5,569</td><td class="pos">+18.6%</td>
  </tr>`;
  const peerRows = CV_PEER_ROWS.map((p, i) => `<tr>
    <td>${i + 2}</td>
    <td><div class="ticker-cell"><div class="ticker-mark">${escapeHtml(p.tk)}</div><div><div class="nm">${escapeHtml(p.nm)}</div><div class="sub">${escapeHtml(p.sub)}</div></div></div></td>
    <td>${escapeHtml(p.cmp)}</td><td>${escapeHtml(p.mc)}</td><td>${escapeHtml(p.pe)}</td><td>${escapeHtml(p.pbv)}</td><td>${escapeHtml(p.ev)}</td>
    <td class="pos">${escapeHtml(p.roce)}</td><td class="pos">${escapeHtml(p.roe)}</td><td>${escapeHtml(p.opm)}</td>
    <td>${escapeHtml(p.de)}</td><td>${escapeHtml(p.sales)}</td><td class="${p.retCls}">${escapeHtml(p.ret)}</td>
  </tr>`).join('');

  // Tab bar
  const tabsHtml = CV_TABS.map(t => `<button type="button" class="cv-tab${t.id === 'overview' ? ' active' : ''}" data-cvtab="${t.id}">${escapeHtml(t.label)}${t.count ? ` <span class="count">${escapeHtml(t.count)}</span>` : ''}</button>`).join('');

  root.innerHTML = `
    <!-- COMPANY HEADER -->
    <section class="co-header">
      <div class="co-id">
        <div class="top-row">
          <h1 id="cvCompanyName">—</h1>
          <span class="chip exch" id="cvChipNse" hidden></span>
          <span class="chip"       id="cvChipBse" hidden></span>
        </div>
        <div class="co-meta" id="cvMeta"></div>
        <p class="co-desc" id="cvDesc"></p>
      </div>
      <div class="co-price">
        <div class="price-label">Live Price · NSE · demo</div>
        <div class="price-row">
          <div class="price"><span class="cur">₹</span>${CV_DEMO_PRICE.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
          <span class="delta down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 10l5 5 5-5"/></svg>
            ${CV_DEMO_DELTA.toFixed(2)} · ${CV_DEMO_DELTAPC.toFixed(2)}%
          </span>
        </div>
        <div class="price-sub">Demo data · wire live price API to bind</div>
        <svg class="spark" viewBox="0 0 240 38" preserveAspectRatio="none" aria-hidden="true">${sparkPath}</svg>
        <div class="range-bar">
          <div class="labels"><span>52W LOW · ${CV_DEMO_LOW52W}</span><span>HIGH · ${CV_DEMO_HIGH52W}</span></div>
          <div class="range-track">
            <div class="range-fill" style="width:100%"></div>
            <div class="range-marker" style="left:${(((CV_DEMO_PRICE - CV_DEMO_LOW52W) / (CV_DEMO_HIGH52W - CV_DEMO_LOW52W)) * 100).toFixed(1)}%"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- TABS -->
    <nav class="cv-tabs" id="cvTabs">${tabsHtml}</nav>

    <!-- OVERVIEW PANE -->
    <div class="cv-pane" data-pane="overview">

      <!-- KPI strip -->
      <section class="kpi-strip">
        <div class="kpi-strip-head">
          <button type="button" class="customize-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M3 4h7M3 12h13M14 4l4 4-4 4M21 12l-4-4M5 16l-2 2 2 2"/></svg>
            Customize Ratios
          </button>
        </div>
        <div class="kpi-grid">
          <div class="kpi"><div class="k-label">Market Cap</div>      <div class="k-value">13,429<span class="unit">Cr</span></div></div>
          <div class="kpi"><div class="k-label">Enterprise Value</div><div class="k-value">15,253<span class="unit">Cr</span></div></div>
          <div class="kpi"><div class="k-label">P / E (TTM)</div>     <div class="k-value">11.8<span class="unit">x</span></div></div>
          <div class="kpi"><div class="k-label">EV / EBITDA</div>     <div class="k-value">6.59<span class="unit">x</span></div></div>
          <div class="kpi"><div class="k-label">P / BV</div>          <div class="k-value">1.50<span class="unit">x</span></div></div>
          <div class="kpi"><div class="k-label">ROCE (FY25)</div>     <div class="k-value">10.0<span class="unit">%</span></div></div>
          <div class="kpi"><div class="k-label">Debt / Equity</div>   <div class="k-value">0.30<span class="unit">x</span></div></div>
          <div class="kpi"><div class="k-label">Div Yield</div>       <div class="k-value">1.45<span class="unit">%</span></div></div>
        </div>
      </section>

      <!-- Operating perf + side stack -->
      <section class="grid-2">
        <div class="cv-card">
          <div class="card-head">
            <h3>Operating Performance <span class="ph-tag">Consolidated</span></h3>
            <div class="cv-actions">
              <div class="cv-seg">
                <button type="button">1Y</button>
                <button type="button">3Y</button>
                <button type="button" class="on">5Y</button>
                <button type="button">10Y</button>
                <button type="button">Max</button>
              </div>
            </div>
          </div>
          <div class="chart-body">
            <div class="chart-toolbar">
              <div class="metric-toggle" id="cvMetricToggle">
                <button type="button" class="mt rev on" data-key="rev">Net Revenue</button>
                <button type="button" class="mt ebitda on" data-key="ebitda">EBITDA</button>
                <button type="button" class="mt np" data-key="np">Net Profit</button>
                <button type="button" class="mt opm on" data-key="opm">OPM%</button>
              </div>
              <div class="small mono" style="font-size:11px;color:var(--muted)">All figures in ₹ Crore · Latest: Dec 2025 · demo</div>
            </div>
            <canvas id="mainChart"></canvas>
          </div>
        </div>

        <div class="side-stack">
          <div class="cv-card">
            <div class="card-head">
              <h3>Valuation Summary</h3>
              <div class="cv-seg">
                <button type="button" class="on">TTM</button>
                <button type="button">3Y</button>
                <button type="button">5Y</button>
              </div>
            </div>
            <div class="val-grid">
              <div class="col-l">
                <div class="val-row"><span class="lbl">P / E</span><span class="v">11.80x <span class="delta-mini up">▼ vs 14.2x sector</span></span></div>
                <div class="val-row"><span class="lbl">P / BV</span><span class="v">1.50x</span></div>
                <div class="val-row"><span class="lbl">EV / EBITDA</span><span class="v">6.59x</span></div>
                <div class="val-row"><span class="lbl">EV / Sales</span><span class="v">2.74x</span></div>
                <div class="val-row"><span class="lbl">Price / Sales</span><span class="v">2.41x</span></div>
                <div class="val-row"><span class="lbl">PEG</span><span class="v">0.84</span></div>
              </div>
              <div class="col-r">
                <div class="val-row"><span class="lbl">Gross Margin</span><span class="v">100.0% <span class="delta-mini up">▲ 71 bps</span></span></div>
                <div class="val-row"><span class="lbl">EBITDA Margin</span><span class="v">34.66%</span></div>
                <div class="val-row"><span class="lbl">Net Margin</span><span class="v">22.10%</span></div>
                <div class="val-row"><span class="lbl">ROCE</span><span class="v">10.00%</span></div>
                <div class="val-row"><span class="lbl">ROE</span><span class="v">12.74%</span></div>
                <div class="val-row"><span class="lbl">CCC Days</span><span class="v">— <span style="color:var(--muted-2);font-size:10px">N/A</span></span></div>
              </div>
            </div>
          </div>

          <div class="cv-card">
            <div class="card-head"><h3>Shareholding · Mar 2026</h3></div>
            <div class="donut-wrap">
              <svg id="donut" viewBox="0 0 36 36" aria-hidden="true">${cvBuildDonut()}</svg>
              <div class="holdings">
                <div class="h-row"><span class="sw" style="background:#E8743B"></span><span class="name">Promoter</span><span class="pct">63.7%</span></div>
                <div class="h-row"><span class="sw" style="background:#D86529"></span><span class="name">FII</span><span class="pct">2.4%</span></div>
                <div class="h-row"><span class="sw" style="background:#0F8A5F"></span><span class="name">DII</span><span class="pct">11.6%</span></div>
                <div class="h-row"><span class="sw" style="background:#6B7280"></span><span class="name">Public</span><span class="pct">22.3%</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- FINANCIAL TABLE -->
      <section class="cv-card fin-table-card">
        <div class="card-head">
          <h3>Interim Results — Quarterly</h3>
          <div class="cv-actions">
            <div class="cv-seg">
              <button type="button" class="on">Quarterly</button>
              <button type="button">Half-Yearly</button>
              <button type="button">Annually</button>
            </div>
            <div class="cv-seg">
              <button type="button" class="on">Consolidated</button>
              <button type="button">Standalone</button>
            </div>
          </div>
        </div>
        <div class="fin-toolbar">
          <div class="left"><span class="updated"><span class="pulse-dot"></span> Demo · wire real filing source to bind</span></div>
          <div class="right"><span class="units">Figures in ₹ Crore unless stated</span></div>
        </div>
        <div class="fin-scroll">
          <table class="fin">
            <thead><tr>${finHeadCells}</tr></thead>
            <tbody>${finTbodyRows}</tbody>
          </table>
        </div>
      </section>

      <!-- PEERS -->
      <section class="cv-card peers-card">
        <div class="card-head">
          <h3 id="cvPeerHead">Peer Comparison</h3>
          <div class="cv-actions">
            <div class="cv-seg">
              <button type="button" class="on">Industry</button>
              <button type="button">Sector</button>
              <button type="button">Custom</button>
            </div>
          </div>
        </div>
        <div class="fin-scroll">
          <table class="peers">
            <thead>
              <tr>
                <th>#</th><th>Company</th><th>CMP (₹)</th><th>Mkt Cap (Cr)</th>
                <th>P/E</th><th>P/BV</th><th>EV/EBITDA</th><th>ROCE</th><th>ROE</th>
                <th>OPM</th><th>D/E</th><th>Sales TTM</th><th>1Y Return</th>
              </tr>
            </thead>
            <tbody>${peerHighlight}${peerRows}</tbody>
          </table>
        </div>
      </section>

    </div><!-- /cv-pane overview -->

    <!-- COMING-SOON PANES + special-cased FORENSIC mount.
         The forensic tab gets a stable mount point (#cvForensicRoot) that
         renderForensicView() targets on first reveal. Other tabs still
         show the placeholder so they self-document their intent. -->
    ${CV_TABS.filter(t => t.id !== 'overview').map(t => {
      if (t.id === 'forensic') return `
      <div class="cv-pane" data-pane="forensic" hidden>
        <div class="cv-forensic" id="cvForensicRoot"></div>
      </div>`;
      return `
      <div class="cv-pane" data-pane="${t.id}" hidden>
        <div class="cv-coming-soon">
          <h4>${escapeHtml(t.label)} · coming soon</h4>
          <p>This tab will be wired up in a later pass. For now, all per-company analytics live under the Overview tab.</p>
        </div>
      </div>`;
    }).join('')}
  `;
}

/* ---- Dynamic strings: name, tickers, sector meta, peer highlight row ---- */
function renderCompanyDynamic() {
  const c = state.company.data;
  if (!c) return;

  // Company name + ticker chips
  const nameEl  = document.getElementById('cvCompanyName');
  const nseChip = document.getElementById('cvChipNse');
  const bseChip = document.getElementById('cvChipBse');
  if (nameEl) nameEl.textContent = c.CompanyName || '—';
  if (nseChip) {
    if (c.NSESymbol) { nseChip.textContent = 'NSE: ' + c.NSESymbol; nseChip.hidden = false; }
    else             { nseChip.hidden = true; }
  }
  if (bseChip) {
    if (c.BSECode)   { bseChip.textContent = 'BSE: ' + c.BSECode; bseChip.hidden = false; }
    else             { bseChip.hidden = true; }
  }
  // Reset any link affordances from a previous (Forensic) open so the normal
  // company page shows plain chips. The Forensic flow re-applies links via
  // applyForensicNote() once companynote returns.
  resetExchangeChip(nseChip);
  resetExchangeChip(bseChip);

  // Sector / Industry / ISIN meta line (+ website link first, on the Forensic
  // card). Single source of truth — see renderCompanyMeta().
  renderCompanyMeta();

  // Description — placeholder copy for the normal company page. The Forensic
  // card removes the description entirely (skipped here, hidden via CSS).
  const descEl = document.getElementById('cvDesc');
  if (descEl && !state.company.headerOnly) {
    descEl.textContent = `${c.CompanyName || 'This company'} · ${c.Sector || 'sector'} ${c.Industry ? '/ ' + c.Industry : ''}. Per-company description text will be wired to the data API in a later pass.`;
  }

  // Peer highlight row — first row reflects the opened company
  const selfMark = document.getElementById('cvPeerSelfMark');
  const selfName = document.getElementById('cvPeerSelfName');
  const selfSub  = document.getElementById('cvPeerSelfSub');
  if (selfMark) selfMark.textContent = cvInitials(c.CompanyName);
  if (selfName) selfName.textContent = c.CompanyName || '—';
  if (selfSub)  selfSub.textContent  = c.NSESymbol ? ('NSE: ' + c.NSESymbol) : (c.BSECode ? ('BSE: ' + c.BSECode) : '—');

  // Peer card title — show the sector/industry the comparison is keyed to
  const peerHead = document.getElementById('cvPeerHead');
  if (peerHead) peerHead.textContent = c.Industry ? `Peer Comparison · ${c.Industry}` : 'Peer Comparison';
}

/* ---- Helpers ---- */
function cvInitials(name) {
  if (!name) return '—';
  const tokens = String(name).replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '—';
  if (tokens.length === 1) return tokens[0].slice(0, 3).toUpperCase();
  return (tokens[0][0] + tokens[1][0] + (tokens[2] ? tokens[2][0] : '')).toUpperCase();
}

function cvBuildSparkPath() {
  // Synthetic 90-day-ish price series ending near CV_DEMO_PRICE. Sin
  // wave + small noise reads like a real chart at this resolution.
  const N = 90, w = 240, h = 38, pad = 1;
  const arr = [];
  let v = 280;
  for (let i = 0; i < N; i++) {
    v += Math.sin(i / 9) * 0.5 + ((i * 7919) % 17 - 8) / 18; // deterministic-ish pseudo-noise
    arr.push(v);
  }
  arr[arr.length - 1] = CV_DEMO_PRICE;
  const max = Math.max(...arr), min = Math.min(...arr), range = max - min || 1;
  const stepX = (w - pad * 2) / (arr.length - 1);
  const points = arr.map((y, i) => {
    const px = pad + i * stepX;
    const py = pad + (h - pad * 2) * (1 - (y - min) / range);
    return (i ? 'L' : 'M') + px.toFixed(2) + ',' + py.toFixed(2);
  }).join(' ');
  const lastX = pad + (arr.length - 1) * stepX;
  const lastY = pad + (h - pad * 2) * (1 - (arr[arr.length - 1] - min) / range);
  const area = `${points} L ${lastX.toFixed(2)},${(h - 1).toFixed(2)} L ${pad},${(h - 1).toFixed(2)} Z`;
  // The down delta colours the spark with the negative tone.
  return `
    <path d="${area}" fill="${CV_DEMO_DELTA >= 0 ? 'var(--positive)' : 'var(--negative)'}" opacity="0.18"></path>
    <path d="${points}" fill="none" stroke="${CV_DEMO_DELTA >= 0 ? 'var(--positive)' : 'var(--negative)'}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="2" fill="${CV_DEMO_DELTA >= 0 ? 'var(--positive)' : 'var(--negative)'}"></circle>
  `;
}

function cvBuildDonut() {
  // Donut from inline SVG. Each slice is a circle with a strategic
  // stroke-dasharray so segments don't overlap — classic SVG donut trick.
  const segs = [
    { val: 63.7, color: '#E8743B' },
    { val:  2.4, color: '#D86529' },
    { val: 11.6, color: '#0F8A5F' },
    { val: 22.3, color: '#6B7280' },
  ];
  let offset = 25;        // start at top
  const r = 15.91549;     // circumference 100 — easy percentage math
  return segs.map(s => {
    const dash = `${s.val} ${100 - s.val}`;
    const seg  = `<circle cx="18" cy="18" r="${r}" fill="transparent" stroke="${s.color}" stroke-width="3.6" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"></circle>`;
    offset = ((offset - s.val) % 100 + 100) % 100;
    return seg;
  }).join('') + `
    <circle cx="18" cy="18" r="11" fill="var(--bg-card)"></circle>
    <text x="18" y="20" text-anchor="middle" style="font-family:var(--font);font-size:5px;font-weight:600;fill:var(--ink)">63.7%</text>
  `;
}

/* ---- Tab switching within the company page ---- */
function wireCompanyTabs() {
  const bar = document.getElementById('cvTabs');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.cv-tab');
    if (!btn) return;
    const targetId = btn.dataset.cvtab;
    bar.querySelectorAll('.cv-tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('#companyView .cv-pane').forEach(p => {
      p.hidden = (p.dataset.pane !== targetId);
    });
    state.company.tab = targetId;
    // Switching back to Overview after a fresh page render may need
    // chart re-init (canvases dropped their context if hidden).
    if (targetId === 'overview') ensureCompanyCharts();
    if (targetId === 'forensic') renderForensicView();
  });

  // Financial-row chart toggle buttons
  const shell = document.getElementById('companyShell');
  if (shell) {
    shell.addEventListener('click', (e) => {
      const open = e.target.closest('[data-rowchart]');
      if (open) {
        const key = open.dataset.rowchart;
        const row = document.getElementById('cvChartRow-' + key);
        if (row) {
          row.hidden = !row.hidden;
          if (!row.hidden) cvInitRowChart(key);
        }
        return;
      }
      const close = e.target.closest('[data-closerow]');
      if (close) {
        const key = close.dataset.closerow;
        const row = document.getElementById('cvChartRow-' + key);
        if (row) row.hidden = true;
      }
    });
  }
}

/* ---- Chart.js init — main bar+line chart + row charts ---- */
function ensureCompanyCharts() {
  // Chart.js loads via <script defer>. If it's not on globalThis yet,
  // poll until it is. Cheap; resolves within a tick of the script tag.
  if (typeof Chart === 'undefined') {
    setTimeout(ensureCompanyCharts, 100);
    return;
  }
  // Only build the main chart if its canvas is currently visible.
  // Row charts initialize on toggle.
  if (state.company.tab !== 'overview') return;
  if (!cvCharts.main) cvInitMainChart();
}

function cvInitMainChart() {
  const cv = document.getElementById('mainChart');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  cvCharts.main = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: CV_QLABELS,
      datasets: [
        { _key: 'rev',    type: 'bar',  label: 'Net Revenue', data: CV_REV, backgroundColor: 'rgba(232,116,59,0.85)',  yAxisID: 'y',  borderRadius: 2, categoryPercentage: 0.78, barPercentage: 0.82 },
        { _key: 'ebitda', type: 'bar',  label: 'EBITDA',      data: CV_EBI, backgroundColor: 'rgba(216,101,41,0.65)',  yAxisID: 'y',  borderRadius: 2, categoryPercentage: 0.78, barPercentage: 0.82 },
        { _key: 'np',     type: 'bar',  label: 'Net Profit',  data: CV_NP,  backgroundColor: 'rgba(31,41,55,0.85)',    yAxisID: 'y',  borderRadius: 2, categoryPercentage: 0.78, barPercentage: 0.82, hidden: true },
        { _key: 'opm',    type: 'line', label: 'OPM %',       data: CV_OPM, borderColor: '#0F172A', backgroundColor: '#0F172A', borderWidth: 1.6, pointRadius: 3, pointHoverRadius: 5, tension: 0.32, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0F172A', padding: 10, cornerRadius: 6,
          titleFont: { family: 'Inter', weight: '600', size: 11 },
          bodyFont: { family: 'Inter', size: 11 },
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              const suffix = c.dataset.label === 'OPM %' ? '%' : ' Cr';
              return `${c.dataset.label}: ${v.toLocaleString('en-IN')}${suffix}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: '#E5E7EB' },
          ticks: { color: '#6B7280', font: { size: 10.5, family: 'Inter' } },
        },
        y: {
          position: 'left',
          grid: { color: '#E5E7EB', drawBorder: false },
          border: { display: false },
          ticks: {
            color: '#6B7280', font: { family: 'Inter' },
            callback: (v) => '₹ ' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v) + ' Cr',
          },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          border: { display: false },
          min: 0, max: 50,
          ticks: { color: '#6B7280', font: { family: 'Inter' }, callback: (v) => v + '%' },
        },
      },
      animation: { duration: 700, easing: 'easeOutQuart' },
    },
  });

  // Metric toggle pills
  const tg = document.getElementById('cvMetricToggle');
  if (tg) {
    tg.addEventListener('click', (e) => {
      const btn = e.target.closest('.mt');
      if (!btn) return;
      btn.classList.toggle('on');
      const key = btn.dataset.key;
      const ds = cvCharts.main.data.datasets.find(d => d._key === key);
      if (ds) { ds.hidden = !btn.classList.contains('on'); cvCharts.main.update(); }
    });
  }
}

const CV_ROW_CHART_DATA = {
  rev: { values: CV_REV, label: 'Net Sales' },
  op:  { values: CV_OPP, label: 'Operating Profit' },
  np:  { values: CV_NP,  label: 'Net Profit' },
};
function cvInitRowChart(key) {
  if (typeof Chart === 'undefined') { setTimeout(() => cvInitRowChart(key), 100); return; }
  if (cvCharts[key]) return;
  const cv = document.getElementById('cvRowChart-' + key);
  if (!cv) return;
  const cfg = CV_ROW_CHART_DATA[key];
  const data = cfg.values;
  // Trend line + thin bars below it
  cvCharts[key] = new Chart(cv.getContext('2d'), {
    type: 'bar',
    data: {
      labels: CV_QLABELS,
      datasets: [
        { type: 'bar',  label: cfg.label,    data, backgroundColor: 'rgba(232,116,59,0.55)', borderRadius: 2, categoryPercentage: 0.78, barPercentage: 0.82 },
        { type: 'line', label: cfg.label + ' (trend)', data, borderColor: '#0F172A', borderWidth: 1.4, pointRadius: 2, pointHoverRadius: 4, tension: 0.3, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0F172A', padding: 8, cornerRadius: 5, titleFont: { family: 'Inter', size: 10.5 }, bodyFont: { family: 'Inter', size: 10.5 } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#6B7280', font: { size: 9.5, family: 'Inter' } } },
        y: { grid: { color: '#E5E7EB' }, ticks: { color: '#6B7280', font: { size: 9.5, family: 'Inter' } } },
      },
      animation: { duration: 500 },
    },
  });
}

/* ============================================================
   FORENSIC TAB — module
   ============================================================
   Lives inside the Company view's Forensic tab pane. The pane has its
   own mount point (#cvForensicRoot) injected by renderCompanyShell()
   so this module owns everything inside that subtree.

   The forensic API returns 10 themed tab objects. Two of them
   (Snapshot, Averages) have a card-grid shape (.tableContent[]);
   the other eight have a time-series shape (.childTable[]). The
   Snapshot tab is promoted to a permanent hero strip at the top of
   the page so the most important KPIs are always in view. The other
   nine (including Averages) live behind a pill-style category tab
   strip below the hero.

   The hook is the Forensic Score banner above the hero — a 1-second
   read of overall financial integrity: signal-mix proportion bar,
   a letter grade, and a rule-based verdict sentence built from the
   API's own colour hints. ============================================================ */

/* ---- Parsers ---- */

// Cell value parser. The API encodes "value,#hex" in summary-row cells
// where the hex is a tint hint. We split on the FIRST comma to preserve
// any commas in formatted numbers (defensive — not seen in this dataset,
// but cheap insurance).
function parseForensicCell(raw) {
  if (raw == null) return { value: '', tint: null };
  const s = String(raw);
  const comma = s.indexOf(',');
  if (comma < 0) return { value: s, tint: null };
  const value = s.slice(0, comma);
  const hex = s.slice(comma + 1).trim().toUpperCase();
  let tint = null;
  if (hex === '#E9F9F0')      tint = 'pos';   // green — positive signal
  else if (hex === '#FEE2E2') tint = 'neg';   // red — red flag
  // Other hexes pass through silently — value still renders without tint.
  return { value, tint };
}

// Metric-name parser. The schema row (description == "Description")
// embeds explanatory tooltip text after the first comma in Row1..RowN.
// Example: "Revenue,Revenue: >0 (Green) indicates topline expansion..."
function parseForensicMetric(raw) {
  if (raw == null) return { name: '', tooltip: '' };
  const s = String(raw);
  const comma = s.indexOf(',');
  if (comma < 0) return { name: s, tooltip: '' };
  return { name: s.slice(0, comma).trim(), tooltip: s.slice(comma + 1).trim() };
}

// Date stamp formatter. Handles three shapes:
//   "200703"   → "FY07"   (Indian fiscal year ending March)
//   "202309"   → "Sep '23" (quarter-end, not March)
//   "3yrs"     → "3 Years"
//   "Description" → "" (caller should filter this out earlier anyway)
const FR_MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatForensicDate(stamp) {
  if (!stamp) return '';
  const s = String(stamp).trim();
  // Period labels — "3yrs", "5Yrs", "10 Years", etc.
  const periodMatch = s.match(/^(\d+)\s*yrs?$/i);
  if (periodMatch) {
    const n = parseInt(periodMatch[1], 10);
    return n + ' Year' + (n === 1 ? '' : 's');
  }
  // YYYYMM
  const m = s.match(/^(\d{4})(\d{2})$/);
  if (!m) return s;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (mo === 3) {
    // March = fiscal year end. FY07 = April 2006 - March 2007.
    return 'FY' + String(y).slice(-2);
  }
  return (FR_MONTH_NAMES[mo] || ('M' + mo)) + " '" + String(y).slice(-2);
}

// Parse the signed numeric value from a forensic display cell, e.g.
// "8.17%" -> 8.17, "(-38.69%)" -> -38.69, "-0.59%" -> -0.59, "0%"/"-"/"" -> 0/null.
// Used to colour Earning Quality CAGR cells by sign per the i-button condition.
function forensicNumericValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '-') return null;
  const neg = /^\(.*\)$/.test(s) || /^[-−–—]/.test(s);
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!isFinite(num)) return null;
  return neg ? -num : num;
}

function isForensicPeriodLabel(desc) {
  return /^\d+\s*yrs?$/i.test(String(desc || '').trim());
}

// Serialise a time-series forensic tab (e.g. Earnings Quality) into a compact
// tab-separated grid for the AI summary prompt: one row per metric, columns =
// periods (oldest -> latest) then the 3yrs/5yrs/10yrs summary columns. Mirrors
// the on-screen transposed view and strips the API's "value,#hex" colour hints.
function forensicTabToText(tab, opts) {
  const ct = (tab && tab.childTable) || [];
  if (ct.length < 2) return '';
  const schema = ct[0];
  const dataRows = ct.slice(1);
  const allKeys = ['Row1','Row2','Row3','Row4','Row5','Row6','Row7','Row8','Row9','Row10','Row11'];
  const activeKeys = allKeys.filter(k =>
    parseForensicMetric(schema[k]).name || dataRows.some(r => String(r[k] || '').trim()));
  if (!activeKeys.length) return '';

  let periods = [];
  const cagr = [];
  dataRows.forEach(r => {
    (isForensicPeriodLabel(String(r.description || '').trim()) ? cagr : periods).push(r);
  });
  // Yearly view (ShareHolding Pattern) keeps only the March (…03) year-ends,
  // matching the on-screen Quarterly/Yearly toggle.
  if (opts && opts.yearlyOnly) periods = periods.filter(r => /03$/.test(String(r.description || '').trim()));
  const num = d => parseInt(String(d).replace(/[^\d]/g, ''), 10) || 0;
  periods.sort((a, b) => num(a.description) - num(b.description));
  cagr.sort((a, b) => num(a.description) - num(b.description));

  const cols = periods.concat(cagr);
  const colLabel = (r) => {
    const d = String(r.description || '').trim();
    const m = d.match(/^(\d+)\s*yrs?$/i);
    return m ? m[1] + 'yrs' : d;
  };
  const header = ['Metric'].concat(cols.map(colLabel)).join('\t');
  const lines = activeKeys.map(k => {
    const name = parseForensicMetric(schema[k]).name || k;
    const vals = cols.map(r => {
      const v = parseForensicCell(r[k]).value;
      const s = (v == null ? '' : String(v)).trim();
      return s || '-';
    });
    return [name].concat(vals).join('\t');
  });
  return [header].concat(lines).join('\n');
}

/* ---- Fetcher ---- */

// Resolve a company's identifier for the Forensic API. The
// SymbolMaster_WithCode response is undocumented, so we don't know
// whether the field is `CompanyID`, `Company_ID`, `CompanyId`,
// `AccordCode`, or something else. Walk a priority list of plausible
// keys and return the first non-empty one. If none match, attempt a
// best-effort scan: any field whose value is a 4-7 digit integer is
// probably the company id (the Acutaas example is 122241, a 6-digit
// integer; Indian listed-company ids are universally in this range).
// Logs a diagnostic if nothing matches so a field-name mismatch
// surfaces in the console instead of silently falling back.
function resolveCompanyId(co) {
  if (!co || typeof co !== 'object') return null;
  const candidates = [
    'CompanyID', 'Company_ID', 'CompanyId', 'company_id',
    'AccordCode', 'accordcode', 'AccordCD',
    'Co_Code', 'co_code', 'CoCode', 'cocode',
    'company_code', 'CompanyCode', 'comp_id', 'CompId', 'cid'
  ];
  for (const k of candidates) {
    const v = co[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  // Best-effort scan: any field whose value is a 4-7 digit integer
  // (and isn't a known non-id like BSECode/ISIN) probably IS the
  // company id. Excludes well-known stock identifiers that share the
  // numeric shape so we don't accidentally send BSECode as CompanyId.
  const blocklist = new Set([
    'BSECode', 'BSESymbol', 'NSESymbol', 'ISIN', 'Series',
    'CompanyName', 'Sector', 'Industry', 'SectorID', 'IndustryID'
  ]);
  for (const k of Object.keys(co)) {
    if (blocklist.has(k)) continue;
    const v = co[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (/^\d{4,7}$/.test(s)) {
      // eslint-disable-next-line no-console
      console.log('[Forensic] Inferred company id from field "' + k + '" =', s);
      return s;
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[Forensic] Could not resolve a company id from SymbolMaster object. Available keys:', Object.keys(co), 'Sample values:', co);
  return null;
}

// Test-only: clone the "Earnings quality" tab data as "Earning_Test"
// and append it to the end of the forensic data array, so it appears
// as the last pill in the category strip (after ShareHolding Pattern).
// Marked as a test scaffolding shim — slated to be removed once the
// data validation it supports is complete. Safe to call repeatedly:
// bails out if a tab with this name is already present.
function injectEarningTestTab(data) {
  if (!Array.isArray(data)) return;
  if (data.some(t => t && t.tabName === 'Earning_Test')) return;
  const src = data.find(t => t && /^earnings?\s*quality$/i.test(String(t.tabName || '').trim()));
  if (!src) return;
  const clone = JSON.parse(JSON.stringify(src));
  clone.tabName = 'Earning_Test';
  data.push(clone);
}

async function loadForensic(mode) {
  const f = state.company.forensic;
  const cid = resolveCompanyId(state.company.data);

  // Fail fast when no company id is available — fetching with an empty
  // or default id would either return stale Acutaas data (when the
  // server treats missing id as the seed company) or render an error
  // panel further downstream after a wasted round-trip. Showing the
  // error here is louder, faster, and keeps any prior company's cached
  // data from being painted on top of a different company's header.
  if (!cid) {
    f.loading = false;
    f.error = 'Company id not available for this selection.';
    renderForensicError(f.error);
    return;
  }

  // Cache removed per design directive — every loadForensic call
  // performs a fresh network fetch. Trade-off: extra round trips when
  // toggling modes back and forth within the same company, gained: it
  // is structurally impossible for one company's data to be painted
  // onto another company's view. The in-flight fetch is still aborted
  // on mode/company switch so only one request is in flight at a time.

  // Cancel any in-flight fetch (e.g., user toggled modes mid-load, or
  // rapidly switched companies).
  if (f.abortController) f.abortController.abort();
  f.abortController = new AbortController();
  const signal = f.abortController.signal;

  f.mode = mode;
  f.loading = true;
  f.error = null;
  renderForensicLoading();

  // Diagnostic — pair this log with the Network panel's
  // Forensic_DetailedTables row to confirm the right id was wired.
  // eslint-disable-next-line no-console
  console.log('[Forensic] Fetching', { CompanyId: String(cid), type: mode, company: state.company.data && state.company.data.CompanyName });

  try {
    const res = await fetch(FORENSIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      // CompanyId is the selected company's identifier, sourced from
      // the SymbolMaster_WithCode response (via resolveCompanyId).
      // Coerced to a string because the Forensic API expects
      // "CompanyId" as a string, not a number.
      body: JSON.stringify({ CompanyId: String(cid), type: mode }),
      signal,
    });
    if (signal.aborted) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (signal.aborted) return;
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');

    const data = Array.isArray(json.Data) ? json.Data : [];
    injectEarningTestTab(data);
    f.data[mode] = data;
    f.buttonStatus = (json.button_status && typeof json.button_status === 'object')
      ? { con: !!json.button_status.con, std: !!json.button_status.std }
      : { con: true, std: true };
    f.loading = false;
    renderForensicData();
  } catch (e) {
    if (signal.aborted || (e && e.name === 'AbortError')) return;
    f.loading = false;
    f.error = e && e.message ? e.message : 'Network error';
    renderForensicError(f.error);
  }
}

/* ---- Score + verdict engine (the HOOK) ---- */

// Walks every time-series tab's summary rows (3yrs / 5yrs / 10yrs) and
// counts green vs red tinted cells. Also tags which category tabs
// carry red signals so the tab strip can show a red-dot indicator.
function computeForensicScore(data) {
  let green = 0, red = 0, neutral = 0;
  const tabsWithRed = new Set();
  const tabsWithGreen = new Set();

  (data || []).forEach(tab => {
    const ct = tab.childTable || [];
    if (ct.length < 2) return;
    ct.slice(1).forEach(row => {
      if (!isForensicPeriodLabel(row.description)) return;
      for (let k = 1; k <= 11; k++) {
        const raw = row['Row' + k];
        if (raw == null || raw === '') continue;
        const cell = parseForensicCell(raw);
        if (cell.tint === 'pos') { green++; tabsWithGreen.add(tab.tabName); }
        else if (cell.tint === 'neg') { red++; tabsWithRed.add(tab.tabName); }
        else if (cell.value !== '') { neutral++; }
      }
    });
  });

  return { green, red, neutral, tabsWithRed, tabsWithGreen };
}

// Letter grade from green vs red ratio. Conservative: a single red flag
// drops the grade meaningfully because forensic red flags compound.
function forensicGrade(score) {
  const total = score.green + score.red;
  if (total === 0) return { letter: '—', tone: '', sub: 'Insufficient data' };
  const ratio = score.green / total;
  // The penalty multiplier weights red signals 1.5× heavier than green
  // boosts — a single accounting red flag matters more than a single
  // positive metric, which is how forensic analysts actually think.
  const adj = score.green / (score.green + score.red * 1.5);
  if (adj >= 0.85) return { letter: 'A',  tone: 'tone-a', sub: 'Clean financials' };
  if (adj >= 0.70) return { letter: 'B+', tone: 'tone-a', sub: 'Largely healthy' };
  if (adj >= 0.55) return { letter: 'B',  tone: 'tone-b', sub: 'Mostly clean' };
  if (adj >= 0.40) return { letter: 'C+', tone: 'tone-c', sub: 'Mixed signals' };
  if (adj >= 0.25) return { letter: 'C',  tone: 'tone-c', sub: 'Caution warranted' };
  if (adj >= 0.10) return { letter: 'D',  tone: 'tone-d', sub: 'Elevated stress' };
  return                     { letter: 'F',  tone: 'tone-f', sub: 'Multiple red flags' };
}

// Rule-based verdict sentence. Walks specific metric cells in the 3-year
// summary rows and composes a 1-2 sentence narrative. Designed to read
// like an analyst's note — punchy, specific, anchored to the data.
function buildForensicVerdict(data) {
  const positives = [];
  const concerns  = [];
  const byTab = {};
  (data || []).forEach(t => { byTab[t.tabName] = t; });

  // Helper: find the 3yrs (preferred) or 5yrs row in a tab's childTable
  function periodRow(tab, prefer) {
    if (!tab || !tab.childTable) return null;
    const wanted = prefer || '3yrs';
    const candidates = tab.childTable.slice(1);
    return candidates.find(r => String(r.description || '').toLowerCase().replace(/\s/g, '') === wanted)
        || candidates.find(r => isForensicPeriodLabel(r.description))
        || null;
  }

  // Fund Flow → cash conversion + FCF (the two most-watched forensic signals)
  const ff = periodRow(byTab['Fund Flow']);
  if (ff) {
    const cfoConv = parseForensicCell(ff.Row6);
    if (cfoConv.tint === 'pos') positives.push('cash conversion is healthy over the last 3 years (CFO / EBITDA ' + cfoConv.value + ')');
    else if (cfoConv.tint === 'neg') concerns.push('cash-to-profit conversion has been weak (CFO / EBITDA ' + cfoConv.value + ')');
    const fcf = parseForensicCell(ff.Row10);
    if (fcf.tint === 'neg') concerns.push('FCF has stayed negative — capex-funded growth carries refinancing risk');
    else if (fcf.tint === 'pos') positives.push('FCF generation has been positive');
  }
  // Asset efficiency → capex intensity
  const ae = periodRow(byTab['Asset efficiency']);
  if (ae) {
    const capex = parseForensicCell(ae.Row3);
    if (capex.tint === 'pos') positives.push('capex intensity is supported by operating cash');
  }
  // Working capital → debtor / inventory stretch
  const wc = periodRow(byTab['Working capital analysis']);
  if (wc) {
    const dbt = parseForensicCell(wc.Row4);
    if (dbt.tint === 'neg') concerns.push('debtor days have stretched vs the long-term average');
    const inv = parseForensicCell(wc.Row5);
    if (inv.tint === 'neg') concerns.push('inventory days have expanded');
  }
  // Expense analysis → tax reconciliation
  const ea = periodRow(byTab['Expense Analysis']);
  if (ea) {
    const tax = parseForensicCell(ea.Row6);
    if (tax.tint === 'neg') concerns.push('cash tax paid diverges meaningfully from the P&L tax expense — worth a closer look');
  }

  if (!positives.length && !concerns.length) {
    return 'No standout signals detected in the forensic checks — the financials read clean across the period under review.';
  }
  function joinList(items) {
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return items[0] + ', and ' + items[1];
    return items.slice(0, -1).join('; ') + '; and ' + items[items.length - 1];
  }
  const parts = [];
  if (positives.length) parts.push(joinList(positives));
  if (concerns.length)  parts.push((positives.length ? 'but ' : '') + joinList(concerns));
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

/* ---- Renderers ---- */

function renderForensicView() {
  // Lazy init guard: only run once per tab open per company. Re-runs
  // are cheap (cache-hit branch) but we still avoid them.
  const f = state.company.forensic;
  // cid is read here only to validate that a company id is available
  // for this view; the actual fetch happens inside loadForensic.
  const cid = resolveCompanyId(state.company.data);
  if (!cid) {
    renderForensicError('Company id not available for this selection.');
    return;
  }
  // No cross-company cache to invalidate — selectCompany resets the
  // forensic sub-state on every company switch, and loadForensic
  // always does a fresh fetch when called.
  if (f.data[f.mode]) {
    renderForensicData();
  } else if (!f.loading) {
    loadForensic(f.mode);
  } else {
    renderForensicLoading();
  }
}

function renderForensicShellChrome(innerHtml) {
  // The chrome — sub-tab strip, mode pills, and the slot for whatever
  // state-dependent body we want underneath. Reused across loading,
  // error, and data states so the controls stay visible even mid-load.
  const f = state.company.forensic;
  const conDisabled = !f.buttonStatus.con;
  const stdDisabled = !f.buttonStatus.std;
  return `
    <div class="fr-subtabs" role="tablist" aria-label="Forensic sub-tabs">
      <button type="button" class="fr-subtab active" role="tab" aria-selected="true">Single Page</button>
    </div>
    <div class="fr-modes" role="tablist" aria-label="Consolidated or Standalone">
      <button type="button" class="fr-mode${f.mode === 'con' ? ' active' : ''}"${conDisabled ? ' disabled' : ''} data-frmode="con" role="tab" aria-selected="${f.mode === 'con'}">Consolidated</button>
      <button type="button" class="fr-mode${f.mode === 'std' ? ' active' : ''}"${stdDisabled ? ' disabled' : ''} data-frmode="std" role="tab" aria-selected="${f.mode === 'std'}">Standalone</button>
    </div>
    ${innerHtml}
  `;
}

function renderForensicLoading() {
  const root = document.getElementById('cvForensicRoot');
  if (!root) return;
  root.innerHTML = renderForensicShellChrome(`
    <div class="fr-loading" role="status" aria-live="polite">
      <div class="fr-spin" aria-hidden="true"></div>
      <div class="fr-loading-text">Pulling forensic detail tables…</div>
      <div class="fr-loading-sub">Decoding cash conversion, working capital, and capital structure signals</div>
    </div>
  `);
  wireForensicChrome();
}

function renderForensicError(message) {
  const root = document.getElementById('cvForensicRoot');
  if (!root) return;
  root.innerHTML = renderForensicShellChrome(`
    <div class="fr-error">
      <h4>Couldn't load forensic data</h4>
      <p>${escapeHtml(message || 'Something went wrong fetching the forensic tables.')}</p>
      <button type="button" class="fr-retry" id="frRetry">Retry</button>
    </div>
  `);
  wireForensicChrome();
  const retry = document.getElementById('frRetry');
  if (retry) retry.onclick = () => loadForensic(state.company.forensic.mode);
}

function renderForensicData() {
  const root = document.getElementById('cvForensicRoot');
  if (!root) return;
  const f = state.company.forensic;

  // Standalone branch — no data yet; show a placeholder so the chrome
  // still works (user can toggle back to Consolidated).
  if (f.mode === 'std') {
    root.innerHTML = renderForensicShellChrome(`
      <div class="fr-placeholder">
        <h4>Standalone view coming soon</h4>
        <p>Standalone forensic tables will be wired up in a later pass. Toggle back to Consolidated to view the current data.</p>
      </div>
    `);
    wireForensicChrome();
    return;
  }

  const data = f.data[f.mode] || [];
  if (!data.length) {
    root.innerHTML = renderForensicShellChrome(`
      <div class="fr-placeholder">
        <h4>No forensic data returned</h4>
        <p>The API responded successfully but with no tables. Try refreshing.</p>
      </div>
    `);
    wireForensicChrome();
    return;
  }

  // Compose the full data view: score banner → snapshot hero →
  // category tab strip → active category content.
  const snapshotTab = data[0];                              // Snapshot is always Data[0]
  const categories  = data.slice(1);                        // remaining 9 = category tab strip

  const score       = computeForensicScore(data);
  const grade       = forensicGrade(score);
  const verdict     = buildForensicVerdict(data);
  // Score banner is intentionally not rendered — the hook wasn't pulling
  // its weight as the page's lead element. The score / grade / verdict
  // are still computed above so the per-category red-dot indicators
  // (which depend on score.tabsWithRed) keep working. If we ever want
  // the banner back, just put `${renderForensicScoreBanner(score, grade, verdict)}`
  // back into the template below.

  root.innerHTML = renderForensicShellChrome(`
    ${renderForensicHero(snapshotTab)}
    ${renderForensicCategoryTabs(categories, score.tabsWithRed)}
    <div id="frCategoryContent">
      ${renderForensicCategoryContent(categories[f.activeCategoryIdx - 1])}
    </div>
  `);

  wireForensicChrome();
  wireForensicCategoryTabs();
}

function renderForensicScoreBanner(score, grade, verdict) {
  const total = Math.max(1, score.green + score.neutral + score.red);
  const pg = (score.green / total) * 100;
  const pn = (score.neutral / total) * 100;
  const pr = (score.red / total) * 100;
  return `
    <section class="fr-score">
      <div class="fr-score-top">
        <div class="fr-score-left">
          <div class="fr-score-title">Forensic Health Score · 3-year window</div>
          <div class="fr-signals-row">
            <span class="fr-signal"><span class="fr-signal-dot pos"></span><strong>${score.green}</strong> Green</span>
            <span class="fr-signal"><span class="fr-signal-dot neu"></span><strong>${score.neutral}</strong> Neutral</span>
            <span class="fr-signal"><span class="fr-signal-dot neg"></span><strong>${score.red}</strong> Red</span>
          </div>
          <div class="fr-propbar" aria-hidden="true">
            ${score.green   ? `<div class="seg-pos" style="width:${pg.toFixed(1)}%"></div>` : ''}
            ${score.neutral ? `<div class="seg-neu" style="width:${pn.toFixed(1)}%"></div>` : ''}
            ${score.red     ? `<div class="seg-neg" style="width:${pr.toFixed(1)}%"></div>` : ''}
          </div>
        </div>
        <div class="fr-grade" title="Composite forensic grade based on weighted green vs red signals">
          <div class="fr-grade-label">Grade</div>
          <div class="fr-grade-letter ${grade.tone}">${escapeHtml(grade.letter)}</div>
          <div class="fr-grade-sub">${escapeHtml(grade.sub)}</div>
        </div>
      </div>
      <div class="fr-verdict">${escapeHtml(verdict)}</div>
    </section>
  `;
}

function renderForensicHero(snapshotTab) {
  // Snapshot tab has tableContent[] with up to 4 cards × up to 5 rows.
  // Each row has 2 columns: label, value. Render as a 4-card grid; each
  // card lays out rows top-to-bottom.
  const cards = (snapshotTab && Array.isArray(snapshotTab.tableContent))
    ? snapshotTab.tableContent : [];
  const cardHtml = cards.map(card => {
    const rows = ['row1','row2','row3','row4','row5']
      .map(k => Array.isArray(card[k]) ? card[k] : [])
      .filter(r => r.length >= 2);
    if (!rows.length) return '';
    const rowHtml = rows.map(cells => {
      const lbl = cells[0] && cells[0].column != null ? cells[0].column : '';
      const val = cells[1] && cells[1].column != null ? cells[1].column : '';
      return `<div class="fr-hero-row"><span class="lbl">${escapeHtml(lbl)}</span><span class="v">${escapeHtml(val)}</span></div>`;
    }).join('');
    return `<div class="fr-hero-card">${rowHtml}</div>`;
  }).join('');
  return `<section class="fr-hero">${cardHtml}</section>`;
}

function renderForensicCategoryTabs(categories, tabsWithRed) {
  const f = state.company.forensic;
  const tabsHtml = categories.map((tab, i) => {
    const idx = i + 1; // map back to Data[] index (Snapshot is 0, so category 0 here = Data[1])
    const hasRed = tabsWithRed.has(tab.tabName);
    const active = (f.activeCategoryIdx === idx);
    return `<button type="button" class="fr-cattab${active ? ' active' : ''}" data-fridx="${idx}" role="tab" aria-selected="${active}" title="${hasRed ? 'Has red signals in this category' : ''}">${escapeHtml(displayForensicTabName(tab.tabName))}${hasRed ? '<span class="fr-redflag" aria-label="red signal"></span>' : ''}</button>`;
  }).join('');
  return `<nav class="fr-cattabs" role="tablist" aria-label="Forensic category">${tabsHtml}</nav>`;
}

// API tabName → display tabName. Currently rewrites "Earnings quality"
// to "Earning Quality" per the latest design direction. Other tabs
// pass through unchanged. Centralised so the tab pill, the article
// h3, and aria-labels all show the same string.
function displayForensicTabName(name) {
  const s = String(name || '');
  // Display labels for the Single Page pills / section headers (each pill and
  // its section header share this one label).
  if (/earnings?\s*quality/i.test(s)) return 'Earning Quality';
  if (/^\s*averages\s*$/i.test(s)) return 'Average';
  if (/working\s*capital/i.test(s)) return 'Working Capital Analysis';
  if (/capital\s*structure/i.test(s)) return 'Capital Structure';
  if (/expense\s*analysis/i.test(s)) return 'Expenses Analysis';
  if (/shareholding\s*pattern/i.test(s)) return 'ShareHolding Pattern (In%)';
  return s;
}

function renderForensicCategoryContent(tab) {
  if (!tab) return '<div class="fr-placeholder"><p>No data for this category.</p></div>';
  const isCardGrid = Array.isArray(tab.tableContent) && tab.tableContent.length > 0;
  const isAverages = (tab.tabName === 'Averages');
  // On the Averages tab, each card carries its own .fr-card-title
  // so the outer category heading would just duplicate it — skip
  // the outer .fr-content-head wrapper for that tab only.
  //
  // For all other (time-series) tabs the right-side "Annual progression
  // with 3 / 5 / 10-year period verdicts" caption has been removed per
  // latest design direction — the new transposed layout speaks for
  // itself and the caption was noise.
  const displayName = displayForensicTabName(tab.tabName);
  return `
    <article class="fr-content" role="tabpanel" aria-label="${escapeHtml(displayName)}">
      ${isAverages ? '' : `
        <div class="fr-content-head">
          <h3>${escapeHtml(displayName)}</h3>
        </div>
      `}
      ${isCardGrid ? renderForensicCardGrid(tab) : renderForensicTimeSeriesTable(tab)}
    </article>
  `;
}

// ====================================================================
// Share Holding card — pie-chart visualization of the ownership
// breakdown, with Pledged shown separately as a non-ownership metric.
//
// Pie chart: 4 holder categories (Promoters / Public / DIIs / FIIs)
// summing to 100%. Pledged is a risk indicator (% of promoter shares
// pledged as collateral), shown below the chart as its own row.
//
// Header is normalized from the API's "Share Holding(%)" to
// "Shareholding (%)" — the casing the rest of the app uses.
//
// Returns null if the data doesn't contain a recognisable breakdown,
// so the caller can fall back to the generic list renderer.
// ====================================================================
function renderShareHoldingCard(card) {
  const header = String(card.header || '').trim();

  const entries = ['row1','row2','row3','row4','row5']
    .map(k => Array.isArray(card[k]) ? card[k] : [])
    .filter(r => r.length >= 2)
    .map(cells => {
      const label = (cells[0] && cells[0].column != null) ? String(cells[0].column) : '';
      const raw   = (cells[1] && cells[1].column != null) ? String(cells[1].column) : '0';
      const n     = parseFloat(raw.replace(/[^\d.\-]/g, ''));
      return { label, raw, value: isNaN(n) ? 0 : n };
    });

  const lookup = (kw) =>
    entries.find(e => e.label.toLowerCase().includes(kw.toLowerCase()))
    || { label: '', raw: '0', value: 0 };

  const promo   = lookup('promoter');
  const fii     = lookup('fii');
  const dii     = lookup('dii');
  const pub     = lookup('public');
  const pledged = lookup('pledged');

  if ((promo.value + fii.value + dii.value + pub.value) <= 0) return null;

  // 5-entry breakdown: 4 holder categories + Pledged. Pledged is
  // included so the legend lists everything in one place (per latest
  // design direction). It's also included in the pie geometry — when
  // Pledged is 0 the slice collapses to nothing; when non-zero it
  // appears as a distinct red slice flagging risk.
  const breakdown = [
    { key: 'promo',  label: 'Promoters', value: promo.value,   raw: promo.raw },
    { key: 'public', label: 'Public',    value: pub.value,     raw: pub.raw },
    { key: 'dii',    label: 'DIIs',      value: dii.value,     raw: dii.raw },
    { key: 'fii',    label: 'FIIs',      value: fii.value,     raw: fii.raw },
    { key: 'pledge', label: 'Pledged',   value: pledged.value, raw: pledged.raw }
  ];
  const total = breakdown.reduce((s, x) => s + x.value, 0) || 1;

  // Pie SVG geometry — starts at 12 o'clock, sweeps clockwise. Single-
  // segment edge case (one bucket holds 100%) is rendered as a circle
  // because an arc covering exactly 2π is degenerate in path syntax.
  // Data labels: each slice with value >= 5% gets a centered text label
  // showing the raw number; smaller slices skip the label to avoid
  // overlap (the legend still carries exact values).
  const size = 144;
  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - 1;
  const labelThreshold = 5;       // % below which we omit on-slice text
  const labelRadius = r * 0.62;   // 62% of radius — roughly mid-slice

  let cumulative = 0;
  const visible = breakdown.filter(b => b.value > 0);
  const pieParts = visible.map((b, i, arr) => {
    // Geometry first
    let slicePath;
    if (arr.length === 1) {
      slicePath = `<circle cx="${cx}" cy="${cy}" r="${r}" class="fr-sh-pie-seg fr-sh-pie-seg-${b.key}"><title>${escapeHtml(b.label)}: ${escapeHtml(b.raw)}%</title></circle>`;
    } else {
      const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
      cumulative += b.value;
      const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
      const startX = cx + r * Math.cos(startAngle);
      const startY = cy + r * Math.sin(startAngle);
      const endX = cx + r * Math.cos(endAngle);
      const endY = cy + r * Math.sin(endAngle);
      const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
      slicePath = `<path d="M ${cx} ${cy} L ${startX.toFixed(2)} ${startY.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z" class="fr-sh-pie-seg fr-sh-pie-seg-${b.key}"><title>${escapeHtml(b.label)}: ${escapeHtml(b.raw)}%</title></path>`;
    }
    // Then optional data label at slice midpoint
    let label = '';
    if (b.value >= labelThreshold && arr.length > 1) {
      // Midpoint angle for THIS slice. Re-derive (independent of
      // mutable `cumulative`) so the label sits at the visual centre.
      const sliceStart = (cumulative - b.value) / total * 2 * Math.PI - Math.PI / 2;
      const sliceEnd   =  cumulative           / total * 2 * Math.PI - Math.PI / 2;
      const mid = (sliceStart + sliceEnd) / 2;
      const lx = cx + labelRadius * Math.cos(mid);
      const ly = cy + labelRadius * Math.sin(mid);
      label = `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" class="fr-sh-pie-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(b.raw)}%</text>`;
    } else if (arr.length === 1 && b.value > 0) {
      // Single-slice case (one holder owns 100%): centre the label.
      label = `<text x="${cx}" y="${cy}" class="fr-sh-pie-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(b.raw)}%</text>`;
    }
    return slicePath + label;
  }).join('');

  // Legend rows — colored marker maps 1:1 to the corresponding pie
  // slice. Pledged is included as the 5th row (no separate bottom
  // section anymore — everything lives in one legend).
  const legendRows = breakdown.map(b =>
    `<div class="fr-sh-leg-row">
       <span class="fr-sh-dot fr-sh-dot-${b.key}"></span>
       <span class="lbl">${escapeHtml(b.label)}</span>
       <span class="v">${escapeHtml(b.raw)}%</span>
     </div>`
  ).join('');

  // Look up the latest filing quarter from the "ShareHolding Pattern
  // (In %)" tab (a separate time-series tab in the same forensic
  // response). Its childTable is shaped [schemaRow, dateRow, dateRow…]
  // where each dateRow's `description` is a YYYYMM-style numeric.
  // We grab the largest such value and reformat it as "MMM YYYY"
  // (e.g. 202603 → "Mar 2026"). Falls back to the raw string if the
  // input doesn't look like a well-formed YYYYMM, and falls back to
  // no subtitle at all if the tab is missing or empty.
  let latestPeriodText = '';
  try {
    // Prefer the Single Page dataset (state.company.fp) when the Forensic
    // page is showing; otherwise fall back to the normal company view's
    // forensic state. Both shape data[mode] as the array of tabs.
    const co = (typeof state !== 'undefined' && state.company) ? state.company : null;
    const fp = co && co.fp;
    const f  = co && co.forensic;
    const useFp = !!(co && co.headerOnly && fp && fp.data && fp.data[fp.mode]);
    const allTabs = useFp
      ? fp.data[fp.mode]
      : ((f && f.data && f.data[f.mode]) ? f.data[f.mode] : []);
    const patternTab = allTabs.find(t =>
      /shareholding\s*pattern/i.test(String(t.tabName || ''))
    );
    if (patternTab && Array.isArray(patternTab.childTable) && patternTab.childTable.length > 1) {
      const numericDates = patternTab.childTable.slice(1)
        .map(r => String(r.description || '').trim())
        .filter(d => /^\d{4,6}$/.test(d))
        .map(d => parseInt(d, 10));
      if (numericDates.length > 0) {
        const latest = String(Math.max.apply(null, numericDates));
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const m = parseInt(latest.substring(4, 6), 10);
        latestPeriodText = (latest.length === 6 && m >= 1 && m <= 12)
          ? `${months[m - 1]}-${latest.substring(0, 4)}`
          : latest;
      }
    }
  } catch (e) { /* silent — header just renders without the subtitle */ }

  return `
    <div class="fr-card-mini fr-card-sh">
      <div class="fr-card-title">
        <h4>Shareholding (%)${latestPeriodText ? ` <span class="fr-sh-period">${escapeHtml(latestPeriodText)}</span>` : ''}</h4>
      </div>
      <div class="fr-sh-body">
        <svg viewBox="0 0 ${size} ${size}" class="fr-sh-pie" role="img" aria-label="Shareholding breakdown pie chart">
          ${pieParts}
        </svg>
        <div class="fr-sh-legend">${legendRows}</div>
      </div>
    </div>
  `;
}

function renderForensicCardGrid(tab) {
  // ============================================================
  // Two-pass rendering for card-grid tabs (e.g. Averages):
  //
  //   1. Cards whose rows are period-labelled (TTM / N yrs / Avg N yr)
  //      AND that carry a header → merged into a SINGLE unified table.
  //      Rows are periods (TTM, Avg 3yrs, Avg 5yrs, Avg 10yrs), columns
  //      are the per-card headers (Gross Margin %, EBITDA Margin %, PAT %).
  //      Trend chip in each header shows TTM vs longest-available period.
  //
  //   2. Cards whose rows are NOT period-labelled (e.g. Share Holding —
  //      rows are Promoters / FIIs / DIIs / Public / Pledged) → rendered
  //      as standalone mini-cards beside / below the merged table.
  //
  // The classification is heuristic and works for any future card-grid
  // tab the API returns — no hardcoded "Averages" check.
  // ============================================================
  const cards = tab.tableContent || [];

  // Normalize row labels to a canonical period token. The API uses
  // slightly different spellings across cards in the same tab —
  // "Avg 3yr" in Gross Margin vs "3yrs" in PAT — so we collapse
  // them to one form so the merge groups properly.
  function normalizePeriod(label) {
    const s = String(label || '').trim();
    if (/^TTM$/i.test(s)) return 'TTM';
    const m = s.match(/(\d+)\s*yrs?/i);
    if (m) return 'Avg ' + parseInt(m[1], 10) + 'yrs';
    return s;
  }
  function periodOrder(p) {
    if (p === 'TTM') return -1;
    const m = p.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 999;
  }
  // A card's row collected as [{ rawLabel, value, period }]
  function cardEntries(card) {
    const out = [];
    for (const k of ['row1','row2','row3','row4','row5']) {
      const arr = Array.isArray(card[k]) ? card[k] : [];
      if (arr.length < 2) continue;
      const lbl = arr[0] && arr[0].column != null ? String(arr[0].column).trim() : '';
      const val = arr[1] && arr[1].column != null ? String(arr[1].column).trim() : '';
      if (!lbl) continue;
      out.push({ rawLabel: lbl, value: val, period: normalizePeriod(lbl) });
    }
    return out;
  }

  // Classification pass — header set + all rows period-shaped = mergeable
  const PERIOD_RE = /^(TTM|Avg\s*\d+yrs?)$/i;
  const eligible = [];
  const standalone = [];
  for (const card of cards) {
    const entries = cardEntries(card);
    const header = String(card.header || '').trim();
    if (header && entries.length >= 2 && entries.every(e => PERIOD_RE.test(e.period))) {
      eligible.push({ header, entries });
    } else {
      standalone.push(card);
    }
  }

  let html = '';

  // Stage 1 — merged unified table (≥2 eligible cards)
  if (eligible.length >= 2) {
    // Collect the union of all periods seen across the eligible cards.
    // Sort: TTM first, then 3yr → 5yr → 10yr ascending. Missing values
    // get an em-dash so column widths stay aligned across cards.
    const periodSet = new Set();
    eligible.forEach(c => c.entries.forEach(e => periodSet.add(e.period)));
    const allPeriods = Array.from(periodSet).sort((a, b) => periodOrder(a) - periodOrder(b));

    // Trend chips were removed per the latest design direction — the
    // column headers stay clean (just the metric names). The narrative
    // "is margin expanding or compressing?" is still readable from
    // comparing the TTM row to the Avg 10yrs row at a glance.

    // Header text normalization — the API uses no space before "(%)":
    // "Gross Margin(%)" / "PAT(%)". We insert a space so the rendered
    // labels read as "Gross Margin (%)" / "PAT (%)" — matching the
    // requested title-case format.
    const normalizeHeader = (raw) => String(raw || '').replace(/(\S)\(/g, '$1 (');

    // Margin card is now rendered with grid-based divs (not a <table>)
    // so it matches the snapshot + share holding cards visually. No
    // internal column/row borders — just a single header bar and
    // horizontal row separators, identical to .fr-card-mini-row pattern.
    // This also kills the table hover effect by removing the <table>
    // entirely (the base .fr-table tr:hover rule no longer has a target).
    const headerCells = eligible.map(c =>
      `<div class="hv">${escapeHtml(normalizeHeader(c.header))}</div>`
    ).join('');

    const bodyRows = allPeriods.map(p => {
      const cells = eligible.map(c => {
        const entry = c.entries.find(e => e.period === p);
        return `<div class="v">${entry ? escapeHtml(bracketNegative(entry.value)) : '<span class="fr-na">—</span>'}</div>`;
      }).join('');
      const isTtm = (p === 'TTM');
      return `<div class="fr-margin-row${isTtm ? ' fr-margin-row-ttm' : ''}"><div class="lbl">${escapeHtml(p)}</div>${cells}</div>`;
    }).join('');

    const marginCardHtml = `
      <div class="fr-card-mini fr-card-margin">
        <div class="fr-card-title">
          <h4>Margin Trends</h4>
        </div>
        <div class="fr-margin-head">
          <div class="lbl">Description</div>
          ${headerCells}
        </div>
        ${bodyRows}
      </div>
    `;

    // If there are standalone cards too (typical Averages tab: 1
    // Share Holding card), lay margin + standalone side-by-side in a
    // 2-column grid. The standalone cards reuse .fr-card-mini so the
    // visual rhythm matches. Otherwise the margin card sits alone in
    // a single-card wrap with consistent padding.
    if (standalone.length > 0) {
      const standaloneCardsHtml = standalone.map(card => {
        const header = String(card.header || '').trim();
        // Share Holding gets the bespoke pie-chart renderer. Other
        // standalone cards fall through to the generic label/value list.
        if (/share\s*holding/i.test(header)) {
          const sh = renderShareHoldingCard(card);
          if (sh) return sh;
        }
        const rows = ['row1','row2','row3','row4','row5']
          .map(k => Array.isArray(card[k]) ? card[k] : [])
          .filter(r => r.length >= 2);
        const rowHtml = rows.map(cells => {
          const lbl = cells[0] && cells[0].column != null ? cells[0].column : '';
          const val = cells[1] && cells[1].column != null ? cells[1].column : '';
          return `<div class="fr-card-mini-row"><span class="lbl">${escapeHtml(lbl)}</span><span class="v">${escapeHtml(bracketNegative(val))}</span></div>`;
        }).join('');
        return `
          <div class="fr-card-mini">
            ${header ? `<div class="fr-card-mini-head">${escapeHtml(header)}</div>` : ''}
            ${rowHtml}
          </div>`;
      }).join('');
      html += `<div class="fr-avg-grid">${marginCardHtml}${standaloneCardsHtml}</div>`;
    } else {
      html += `<div class="fr-avg-solo">${marginCardHtml}</div>`;
    }
  } else if (standalone.length > 0) {
    // No merged margin card — just standalone cards on their own.
    // Same single-column constraint pattern as before for a lone card.
    const standaloneHtml = standalone.map(card => {
      const header = String(card.header || '').trim();
      if (/share\s*holding/i.test(header)) {
        const sh = renderShareHoldingCard(card);
        if (sh) return sh;
      }
      const rows = ['row1','row2','row3','row4','row5']
        .map(k => Array.isArray(card[k]) ? card[k] : [])
        .filter(r => r.length >= 2);
      const rowHtml = rows.map(cells => {
        const lbl = cells[0] && cells[0].column != null ? cells[0].column : '';
        const val = cells[1] && cells[1].column != null ? cells[1].column : '';
        return `<div class="fr-card-mini-row"><span class="lbl">${escapeHtml(lbl)}</span><span class="v">${escapeHtml(bracketNegative(val))}</span></div>`;
      }).join('');
      return `
        <div class="fr-card-mini">
          ${header ? `<div class="fr-card-mini-head">${escapeHtml(header)}</div>` : ''}
          ${rowHtml}
        </div>`;
    }).join('');
    const gridStyle = (standalone.length === 1)
      ? 'grid-template-columns: minmax(280px, 380px);'
      : '';
    html += `<div class="fr-cards"${gridStyle ? ` style="${gridStyle}"` : ''}>${standaloneHtml}</div>`;
  }

  // Defensive fallback — shouldn't happen but keeps render output non-empty
  if (!html) html = '<div class="fr-placeholder"><p>No card data for this category.</p></div>';

  return html;
}

// Wrap a negative numeric display value in parentheses, e.g. "-45.90" →
// "(-45.90)" and "−364.64" → "(−364.64)". Non-negative values, blanks, and
// already-bracketed accounting values are returned unchanged.
function bracketNegative(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return s;
  if (/^\(.*\)$/.test(s)) return s;          // already bracketed
  if (/^[-−]\s*\d/.test(s)) return '(' + s + ')';
  return s;
}

// Label for the trailing summary-column group (3yrs / 5yrs / 10yrs). For most
// tables this is a true CAGR; a few tables use cumulative sums or averages, so
// the group header is renamed per the table it belongs to.
function cagrGroupLabel(tabName) {
  const n = String(tabName || '').toLowerCase();
  if (n.includes('fund flow')) return 'Cumulative';
  if (n.includes('working capital')) return 'Averages';
  if (n.includes('asset efficiency')) return 'Cumulative/Average';
  if (n.includes('expense analysis')) return 'Cumulative/Average';
  return 'CAGR';
}

function renderForensicTimeSeriesTable(tab) {
  const ct = tab.childTable || [];
  if (ct.length < 2) {
    return '<div class="fr-placeholder"><p>No time-series data for this category.</p></div>';
  }
  const schema = ct[0];
  const dataRows = ct.slice(1);

  // Determine which Row keys are actually populated. A column-key is
  // "active" if EITHER the schema names a metric for it OR any data
  // row has a non-empty value. This suppresses Row6-Row11 from the
  // rendered table when the API uses fewer than 11 columns.
  const allRowKeys = ['Row1','Row2','Row3','Row4','Row5','Row6','Row7','Row8','Row9','Row10','Row11'];
  const activeRows = allRowKeys.filter(key => {
    const schemaVal = parseForensicMetric(schema[key]).name;
    if (schemaVal) return true;
    return dataRows.some(r => String(r[key] || '').trim());
  });

  // TRANSPOSED LAYOUT
  // ─────────────────
  // Originally this table was rendered with rows = periods, columns
  // = metrics. We now transpose:
  //   • rows    = metrics  (Revenue, Gross Profit, GP Margin %, …)
  //   • columns = periods  (200703, 200803, …, 202403, then 3yrs/5yrs/10yrs)
  // CAGR period labels (3yrs / 5yrs / 10yrs) get grouped under a
  // "CAGR" super-header and tinted positive-soft so the eye can
  // separate them from the raw annual columns to their left.
  const yyyymmRows = [];
  const cagrRows   = [];
  dataRows.forEach(row => {
    const desc = String(row.description || '').trim();
    if (isForensicPeriodLabel(desc)) cagrRows.push(row);
    else yyyymmRows.push(row);
  });

  // Sort YYYYMM rows ascending (oldest → newest, left → right).
  yyyymmRows.sort((a, b) => {
    const pa = parseInt(String(a.description || '').replace(/[^\d]/g, ''), 10) || 0;
    const pb = parseInt(String(b.description || '').replace(/[^\d]/g, ''), 10) || 0;
    return pa - pb;
  });

  // Sort CAGR rows by year span (3yrs < 5yrs < 10yrs).
  cagrRows.sort((a, b) => {
    const pa = parseInt(String(a.description || '').replace(/[^\d]/g, ''), 10) || 0;
    const pb = parseInt(String(b.description || '').replace(/[^\d]/g, ''), 10) || 0;
    return pa - pb;
  });

  // ShareHolding Pattern (Single Page only): a Quarterly / Yearly toggle.
  // Yearly keeps only the March (…03) columns — the fiscal year-ends.
  const isShPattern = /shareholding\s*pattern/i.test(String(tab.tabName || ''));
  const onSinglePage = !!(typeof state !== 'undefined' && state.company && state.company.headerOnly);
  const shYearly = onSinglePage && isShPattern && !!(state.company.fp && state.company.fp.shYearly);
  const displayPeriods = shYearly
    ? yyyymmRows.filter(r => /03$/.test(String(r.description || '').trim()))
    : yyyymmRows;

  const yyyymmCount = displayPeriods.length;
  const cagrCount   = cagrRows.length;

  // ---- Column headers ---------------------------------------------
  const dateColHeaders = displayPeriods.map(row =>
    `<th>${escapeHtml(String(row.description || ''))}</th>`
  ).join('');
  // CAGR / Cumulative / Average sub-columns — normalized to "3yrs/5yrs/10yrs".
  const cagrColHeaders = cagrRows.map(row => {
    const d = String(row.description || '').trim();
    const m = d.match(/(\d+)/);
    return `<th class="fr-cagr-col">${escapeHtml(m ? m[1] + 'yrs' : d)}</th>`;
  }).join('');

  // ---- Body rows (one per metric) ---------------------------------
  const tbody = activeRows.map(key => {
    const m = parseForensicMetric(schema[key]);
    const infoIcon = m.tooltip
      ? `<span class="fr-info" data-tip="${escapeHtml(m.tooltip)}" aria-label="More info">i</span>`
      : '';
    const metricName = m.name || ('Col ' + key.slice(3));

    const dateCells = displayPeriods.map(row => {
      const cell = parseForensicCell(row[key]);
      // Colour comes ONLY from the API "value,#hex" condition hints (the
      // 'i'-button fields): fr-pos = green bg+number, fr-neg = red bg+number.
      // Negative numbers are NOT auto-reddened — they render in the default
      // text colour; the bracket formatting is kept for readability.
      const tintCls = cell.tint === 'pos' ? ' fr-pos' : (cell.tint === 'neg' ? ' fr-neg' : '');
      return `<td class="${tintCls.trim()}">${escapeHtml(bracketNegative(cell.value))}</td>`;
    }).join('');

    // Earning Quality metrics (Revenue, Gross Profit, EBITDA Excl OI, PAT, Adj
    // PAT) are all "higher is better", so its CAGR cells are coloured by the
    // value's sign per the i-button condition (>0 green, <0 red, 0%/blank
    // neutral) — the feed doesn't reliably tint this table. Other tables keep
    // their API hint, whose green/red may encode a different good-direction.
    const isEqTable = /earnings?\s*quality/i.test(String(tab.tabName || ''));
    const cagrCells = cagrRows.map(row => {
      const cell = parseForensicCell(row[key]);
      const hasValue = String(cell.value || '').trim().length > 0;
      let tint = cell.tint;
      if (isEqTable && hasValue) {
        const n = forensicNumericValue(cell.value);
        tint = n == null ? null : (n > 0 ? 'pos' : (n < 0 ? 'neg' : null));
      }
      const tintCls = tint === 'neg' ? ' fr-neg' : (tint === 'pos' ? ' fr-pos' : '');
      const cls = hasValue ? `fr-cagr-col${tintCls}` : '';
      return `<td class="${cls.trim()}">${escapeHtml(bracketNegative(cell.value))}</td>`;
    }).join('');

    return `<tr>
      <td class="fr-td-period fr-td-metric">${escapeHtml(metricName)}${infoIcon}</td>
      ${dateCells}
      ${cagrCells}
    </tr>`;
  }).join('');

  // ---- Two-level header -------------------------------------------
  // Top row: blank cells over Description + YYYYMM range, "CAGR"
  //          super-header spanning the trailing CAGR columns.
  // Bottom row: Description, YYYYMM headers, CAGR period headers.
  const superHeader = cagrCount > 0
    ? `<tr class="fr-thead-super">
         <th class="fr-th-period fr-th-super-blank" rowspan="2">Description</th>
         ${yyyymmCount > 0 ? `<th class="fr-th-super-blank" colspan="${yyyymmCount}"></th>` : ''}
         <th class="fr-cagr-super" colspan="${cagrCount}">${escapeHtml(cagrGroupLabel(tab.tabName))}</th>
       </tr>
       <tr>
         ${dateColHeaders}
         ${cagrColHeaders}
       </tr>`
    : `<tr>
         <th class="fr-th-period">Description</th>
         ${dateColHeaders}
       </tr>`;

  // Fund Flow, Expense Analysis, Asset efficiency & Working capital analysis:
  // the trailing summary columns are NOT a blanket-green block — only the
  // API-flagged condition cells carry colour. (For Working capital this leaves
  // the 10yr baseline column neutral, since the API only flags 3yr/5yr.)
  const condClass = /fund flow|expense analysis|asset efficiency|working capital|earnings?\s*quality/i.test(String(tab.tabName || ''))
    ? ' fr-cagr-conditional' : '';

  return `
    <div class="fr-table-scroll">
      <table class="fr-table fr-table-transposed${condClass}">
        <thead>
          ${superHeader}
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  `;
}

/* ---- Wiring ---- */

function wireForensicChrome() {
  // Mode-pill clicks: switch between Consolidated and Standalone
  const root = document.getElementById('cvForensicRoot');
  if (!root) return;
  root.querySelectorAll('.fr-mode[data-frmode]').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      const newMode = btn.dataset.frmode;
      if (newMode === state.company.forensic.mode) return;
      loadForensic(newMode);
    };
  });
}

function wireForensicCategoryTabs() {
  const bar = document.querySelector('#cvForensicRoot .fr-cattabs');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.fr-cattab');
    if (!btn) return;
    const idx = parseInt(btn.dataset.fridx, 10);
    if (Number.isNaN(idx)) return;
    if (state.company.forensic.activeCategoryIdx === idx) return;
    state.company.forensic.activeCategoryIdx = idx;
    // Update active state on tabs
    bar.querySelectorAll('.fr-cattab').forEach(t => t.classList.toggle('active', t === btn));
    bar.querySelectorAll('.fr-cattab').forEach(t => t.setAttribute('aria-selected', t === btn ? 'true' : 'false'));
    // Re-render just the content area, not the whole tab. Keeps the
    // hero / score banner / tab strip stable across category switches.
    const data = state.company.forensic.data[state.company.forensic.mode] || [];
    const categories = data.slice(1);
    const target = document.getElementById('frCategoryContent');
    if (target) target.innerHTML = renderForensicCategoryContent(categories[idx - 1]);
  });
}

/* ---- Sidebar profile card sync ---- */
function syncSidebarUserCard() {
  const p = state.settings.profile;
  const nameEl   = document.getElementById('sidebarUserName');
  const emailEl  = document.getElementById('sidebarUserEmail');
  const avatarEl = document.getElementById('sidebarUserAvatar');
  if (nameEl)  nameEl.textContent  = p.fullName  || 'Profile';
  if (emailEl) emailEl.textContent = p.email     || '';
  if (avatarEl) {
    if (p.avatarDataUrl) {
      avatarEl.innerHTML = `<img src="${safeAttr(p.avatarDataUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
      avatarEl.style.background = 'transparent';
    } else {
      const initial = (p.fullName || 'P').trim().charAt(0).toUpperCase() || 'P';
      avatarEl.innerHTML = escapeHtml(initial);
      avatarEl.style.background = '';
    }
  }
}

/* ---- Settings sub-tab strip ---- */
function setSettingsTab(tab) {
  state.settings.tab = tab;
  document.querySelectorAll('#settingsTabs .s-tab').forEach(b => {
    const on = b.dataset.stab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderSettingsPanel();
}

/* ---- Tab content renderers ---- */
function renderProfileTab() {
  const p = state.settings.profile;
  const initial = (p.fullName || 'P').trim().charAt(0).toUpperCase() || 'P';
  const hasAvatar = !!p.avatarDataUrl;
  // Avatar fragment — either an <img> if uploaded, or the initial inside
  // the gradient background.
  const avatarInner = hasAvatar
    ? `<img src="${safeAttr(p.avatarDataUrl)}" alt="Profile picture">`
    : escapeHtml(initial);

  const nameStatus = state.settings.status.name === 'saved'
    ? '<span class="field-status">Saved</span>' : '';
  // Email field mirrors the name field exactly — same green "Saved" status
  // text and same ✓ Saved button transformation. The old "Verification
  // email sent" copy and the help line under the input have been dropped
  // per the latest spec.
  const emailStatus = state.settings.status.email === 'saved'
    ? '<span class="field-status">Saved</span>' : '';

  return `
    <section class="settings-card">
      <div class="settings-card-head">
        <h2>Profile picture</h2>
        <p>Shown on the sidebar and on shared report cards.</p>
      </div>
      <div class="pp-row">
        <div class="pp-avatar" id="ppAvatar" style="${hasAvatar ? 'background:transparent' : ''}">${avatarInner}</div>
        <div class="pp-actions">
          <button type="button" class="settings-btn" id="ppReplaceBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            ${hasAvatar ? 'Replace' : 'Upload'}
          </button>
          <button type="button" class="settings-btn danger" id="ppRemoveBtn" ${hasAvatar ? '' : 'disabled'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Remove
          </button>
          <input type="file" id="ppFileInput" accept="${AVATAR_ACCEPT_TYPES.join(',')}" style="display:none">
        </div>
      </div>
      <div class="pp-hint">JPG, PNG, or WebP &middot; max 2 MB</div>
    </section>

    <section class="settings-card">
      <div class="settings-card-head">
        <h2>Account details</h2>
        <p>Your name and email address.</p>
      </div>
      <div class="field">
        <label class="field-label" for="settingsFullName">Full name</label>
        <input class="field-input" id="settingsFullName" type="text" value="${safeAttr(p.fullName || '')}" autocomplete="name" />
        <div class="field-action-row">
          ${nameStatus}
          <button type="button" class="field-action ${state.settings.status.name === 'saved' ? 'saved' : ''}" id="settingsSaveName">
            ${state.settings.status.name === 'saved' ? '✓ Saved' : 'Save name'}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="settingsEmail">Email</label>
        <input class="field-input" id="settingsEmail" type="email" value="${safeAttr(p.email || '')}" autocomplete="email" />
        <div class="field-action-row">
          ${emailStatus}
          <button type="button" class="field-action ${state.settings.status.email === 'saved' ? 'saved' : ''}" id="settingsSaveEmail">
            ${state.settings.status.email === 'saved' ? '✓ Saved' : 'Save email'}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderPlaceholderTab(title, sub) {
  return `<div class="settings-placeholder">
    <div class="settings-placeholder-title">${escapeHtml(title)}</div>
    <div class="settings-placeholder-sub">${escapeHtml(sub)}</div>
  </div>`;
}

function renderSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  const tab = state.settings.tab;
  let html = '';
  if (tab === 'profile') html = renderProfileTab();
  else if (tab === 'watchlists')    html = renderWatchlistsTab();
  else if (tab === 'notifications') html = renderPlaceholderTab('Notifications',       'Email alerts for new reports, USFDA notes, and concall transcripts. Coming soon.');
  else if (tab === 'password')      html = renderPlaceholderTab('Password',             'Change your password. Coming soon — for now, signing out and back in via Google handles it.');
  panel.innerHTML = html;
  if (tab === 'profile')    wireProfileTab();
  if (tab === 'watchlists') wireWatchlistsTab();
}

/* ---- Profile tab interactions ---- */
function wireProfileTab() {
  const replaceBtn = document.getElementById('ppReplaceBtn');
  const removeBtn  = document.getElementById('ppRemoveBtn');
  const fileInput  = document.getElementById('ppFileInput');
  const nameInput  = document.getElementById('settingsFullName');
  const emailInput = document.getElementById('settingsEmail');
  const saveNameBtn   = document.getElementById('settingsSaveName');
  // Renamed from settingsChangeEmail → settingsSaveEmail to match the
  // new button label. The behaviour is unchanged: the email field now
  // mirrors the name field's "✓ Saved" flash pattern.
  const saveEmailBtn  = document.getElementById('settingsSaveEmail');

  if (replaceBtn && fileInput) replaceBtn.addEventListener('click', () => fileInput.click());
  if (fileInput) fileInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) handleAvatarFile(file);
    // Reset value so picking the same file twice re-fires change
    e.target.value = '';
  });
  if (removeBtn) removeBtn.addEventListener('click', () => {
    state.settings.profile.avatarDataUrl = null;
    writeSettings();
    syncSidebarUserCard();
    renderSettingsPanel();
  });
  if (saveNameBtn) saveNameBtn.addEventListener('click', () => {
    const v = (nameInput && nameInput.value || '').trim();
    if (!v) return;
    state.settings.profile.fullName = v;
    writeSettings();
    syncSidebarUserCard();
    flashStatus('name');
  });
  if (saveEmailBtn) saveEmailBtn.addEventListener('click', () => {
    const v = (emailInput && emailInput.value || '').trim();
    // Light client-side check; the real save flow lives server-side and
    // is a no-op here until the backend is wired.
    if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
    state.settings.profile.email = v;
    writeSettings();
    syncSidebarUserCard();
    flashStatus('email');
  });
}

function flashStatus(field) {
  state.settings.status[field] = 'saved';
  renderSettingsPanel();
  setTimeout(() => {
    state.settings.status[field] = 'idle';
    if (state.view === 'settings' && state.settings.tab === 'profile') renderSettingsPanel();
  }, 1800);
}

/* ============================ WATCHLISTS TAB (Settings) ============================
   Two-card management UI. Top card lists every watchlist with select /
   rename / delete; bottom card edits the companies of the currently-
   selected watchlist via SymbolMaster_WithCode search-to-add. Every
   mutation flows through writeWatchlists() → re-renders Daily Reading
   chips → invalidates the Corp Announcement filter cache so the next
   tab visit reflects the change. */

const WATCHLISTS_STORAGE_KEY = 'omkara.watchlists';

state.settings.wl = {
  editing: 'default',   // CompanyID of currently-selected watchlist (for company management)
  renaming: null,       // watchlist id currently in rename-mode, or null
  search: {
    query: '',
    results: [],
    loading: false,
    error: null,
    debounceTimer: null,
    abortController: null,
    open: false,
    highlighted: -1,        // index in results that's currently keyboard-highlighted (-1 = none)
  },
  bulk: {
    open: false,
    text: '',
    importing: false,
    progress: { done: 0, total: 0 },
    result: null,       // { added, duplicates, notFound:[] } once import completes
  },
};

function readWatchlists() {
  try {
    const raw = localStorage.getItem(WATCHLISTS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return;
    // Two cleanup passes on hydration so a previous buggy session's
    // localStorage can't survive into the new clean model:
    //   (a) Rebuild Default fresh from the factory — guarantees
    //       isSystem=true even if the stored row was missing it.
    //       Carry forward stored Default companies.
    //   (b) Dedupe non-Default rows by serverId. The earlier broken
    //       migration loop could have left several local rows all
    //       pointing at the same server entry — keep only the first.
    //       Rows with no serverId pass through (they're local-only).
    const storedDefault = parsed.find(w => w && w.id === DEFAULT_WL_ID);
    const defaultRow = makeDefaultWatchlist();
    if (storedDefault && Array.isArray(storedDefault.companies)) {
      defaultRow.companies = storedDefault.companies;
    }
    const seenSids = new Set();
    const rest = parsed
      .filter(w => w && w.id !== DEFAULT_WL_ID)
      .filter(w => {
        if (w.serverId == null) return true;
        const sid = String(w.serverId);
        if (seenSids.has(sid)) return false;
        seenSids.add(sid);
        return true;
      });
    WATCHLISTS.length = 0;
    WATCHLISTS.push(defaultRow);
    rest.forEach(w => WATCHLISTS.push(w));
  } catch (_) { /* corrupt storage — keep [Default] */ }
}
function writeWatchlists() {
  try { localStorage.setItem(WATCHLISTS_STORAGE_KEY, JSON.stringify(WATCHLISTS)); } catch (_) {}
}

// After any watchlist mutation: refresh Daily Reading chips, invalidate
// the Corp Announcement cache (whose signature depends on state.selected
// but the underlying companies list changed too), re-render whatever DR
// panel is visible. This is the bridge that makes Settings changes
// surface live on the Daily Reading page.
function watchlistsChanged() {
  writeWatchlists();
  if (state.ann && state.ann.cache) state.ann.cache = { sig: null, items: null };
  if (typeof renderChips === 'function') renderChips();
  if (typeof renderActiveBadge === 'function') renderActiveBadge();
  if (typeof renderTabCounts === 'function') renderTabCounts();
  // Re-render whichever main view is visible. Previously this only
  // refreshed Daily Reading and SKIPPED the Settings panel — which
  // meant any rename, create, or delete made on the Settings tab
  // updated WATCHLISTS but never repainted the row. Now both views
  // get refreshed.
  if (state.view === 'settings') {
    if (typeof renderSettingsPanel === 'function') renderSettingsPanel();
  } else if (typeof renderPanel === 'function') {
    renderPanel();
  }
}

function ensureWlEditingValid() {
  // The currently-edited watchlist might have been deleted, or might
  // never have been set on a fresh page load. Snap to the first one.
  if (!WATCHLISTS.length) return;
  if (!WATCHLISTS.find(w => w.id === state.settings.wl.editing)) {
    state.settings.wl.editing = WATCHLISTS[0].id;
    writeWlEditing();
  }
}

// ---- Persist which watchlist is selected (Settings "Companies in X") ----
// On page load only the SELECTED watchlist's companies are fetched (a single
// WatchList_AddCompany input:4 call), instead of one call per watchlist. For
// that single call to target the watchlist the user was last looking at, the
// selection has to survive a reload — so we mirror it to localStorage.
const WL_EDITING_STORAGE_KEY = 'omkara.wl.editing';
function writeWlEditing() {
  try {
    localStorage.setItem(WL_EDITING_STORAGE_KEY, String(state.settings.wl.editing || ''));
  } catch (_) { /* quota / private mode — selection just won't persist */ }
}
function readWlEditing() {
  try {
    const id = localStorage.getItem(WL_EDITING_STORAGE_KEY);
    // Applied as-is; ensureWlEditingValid() (run after watchlists load)
    // snaps it back to a real watchlist if this id no longer exists.
    if (id) state.settings.wl.editing = id;
  } catch (_) { /* ignore */ }
}

function makeWlId() {
  return 'wl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}
function pickNextWlColor() {
  const used = new Set(WATCHLISTS.map(w => (w.color || '').toLowerCase()));
  const free = WL_COLOR_POOL.find(c => !used.has(c.toLowerCase()));
  return free || WL_COLOR_POOL[WATCHLISTS.length % WL_COLOR_POOL.length];
}

// ---- Server sync for watchlist CRUD ----
// One endpoint does everything:
//   POST https://omkaradata.com/api/Watch_list_Add
//   Payload: { ID, UserID, WatchListNAme, status, input }
// Modes (chosen by ID + name):
//   ID="" and WatchListNAme=""    → list mode: returns user's watchlists
//   ID="" and WatchListNAme=X     → create mode: creates "X", returns full list
//   ID=N and WatchListNAme=X      → update mode: renames N→X, returns full list
// Every response contains Data[]: the full per-user watchlist list.
// We always pipe Data[] through applyServerWatchlistData() so the
// local state mirrors the server after every successful call — no
// merge or migration logic, just one canonical refresh.

// ---- Single-flight POST queue ----
// Many servers (and ours appears to be one) handle parallel writes
// badly: they process the first few requests and silently drop
// later ones, or commit them out of order. When the user creates
// several watchlists in quick succession (commit, click+, type,
// commit, click+, type, commit...), 5 commits would fire 5
// simultaneous POSTs and only 3 might land — which is exactly the
// "more than 3 don't save" symptom we saw. Serializing the API
// queue forces strict one-at-a-time ordering: each POST waits for
// the previous one's response to land before starting. The total
// wall-clock time is slightly longer, but every commit is preserved.
let _wlApiQueue = Promise.resolve();
function callWatchlistApi(payload) {
  const run = () => _doCallWatchlistApi(payload);
  // Chain onto the existing queue. Catch any prior failure so it
  // can't poison subsequent calls — every link in the chain runs.
  const next = _wlApiQueue.then(run, run);
  _wlApiQueue = next.catch(() => {});
  return next;
}

async function _doCallWatchlistApi(payload) {
  // eslint-disable-next-line no-console
  console.log('[Watchlist] POST →', payload);
  try {
    const res = await fetch(WATCHLIST_ADD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');
    const data = Array.isArray(json.Data) ? json.Data : [];
    // eslint-disable-next-line no-console
    console.log('[Watchlist] ✓ response Data:', data.length, 'entries');
    return data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[Watchlist] Failed:', e);
    return null;
  }
}

// ---- Single-flight POST queue for WatchList_AddCompany ----
// Same rationale as _wlApiQueue, applied to the sibling endpoint
// that attaches companies to watchlists. A user rapidly picking
// several companies from the dropdown would otherwise fire several
// parallel POSTs; this serializes them so each adds cleanly.
let _companyApiQueue = Promise.resolve();
function callAddCompanyApi(payload) {
  const run = () => _doCallAddCompanyApi(payload);
  const next = _companyApiQueue.then(run, run);
  _companyApiQueue = next.catch(() => {});
  return next;
}

async function _doCallAddCompanyApi(payload) {
  // eslint-disable-next-line no-console
  console.log('[Company] POST →', payload);
  try {
    const res = await fetch(WATCHLIST_ADD_COMPANY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.status !== 1) throw new Error((json && json.msg) || 'API failure');
    const data = Array.isArray(json.Data) ? json.Data : [];
    // eslint-disable-next-line no-console
    console.log('[Company] ✓ response Data:', data.length, 'entries');
    return data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[Company] Failed:', e);
    return null;
  }
}

// Add a company to a watchlist on the server. Returns the server-
// assigned entry ID and the enriched server record on success,
// or null on failure.
// Payload exactly matches the user's spec:
//   { ID:"", WatchListID:<num>, AccordCode:<num>, CompanyName:<str>,
//     status:false, input:1, UserID:<num> }
async function addCompanyToWatchlistOnServer(watchListId, company) {
  if (!watchListId || !company || company.AccordCode == null) return null;
  const data = await callAddCompanyApi({
    ID: '',
    WatchListID: Number(watchListId),
    AccordCode: Number(company.AccordCode),
    CompanyName: String(company.CompanyName || '').trim(),
    status: false,
    input: 1,
    UserID: Number(WL_USER_ID),
  });
  if (data == null) return null;
  // Identify our new entry: match by AccordCode + WatchListID. The
  // server returns just the newly-created row(s), so this is almost
  // always data[0], but the explicit match guards against the
  // server ever returning the full list.
  const match = data.find(e =>
    e
    && String(e.AccordCode) === String(company.AccordCode)
    && String(e.WatchListID) === String(watchListId)
  ) || data[0];
  if (!match || match.ID == null) return null;
  return { entryId: match.ID, enriched: match };
}

// ===========================================================================
// LIST COMPANIES IN A WATCHLIST — WatchList_AddCompany, input:4
// ===========================================================================
// The WatchList_AddCompany endpoint doubles as the company LISTING endpoint
// when called with input:4. It returns every company row attached to the
// given WatchListID. This is the call that fixes the reported bug: the
// watchlist names synced but their companies were only ever read from
// localStorage, so a watchlist populated elsewhere showed a stale/short
// list (or nothing) on this device.
//
// Payload (verified against the spec / Network tab):
//   { ID:"", WatchListID:<num>, AccordCode:"", CompanyName:"",
//     status:false, input:4, UserID:"2" }
// Response Data[] rows:
//   { ID, UserID, WatchListID, AccordCode, CompanyName, BseCode,
//     NSESymbol, BSESymbol, Date }
// The server may return DUPLICATE rows for one company (same AccordCode,
// different ID) — we de-dupe by AccordCode for display, keeping the first
// row's ID as the deletable watchlistEntryId.

// Map one server company row to the local company-entry shape used
// everywhere else (chips, dedupe, Daily Reading scope). The server uses
// "BseCode" (lowercase "se"); we normalize to local "BSECode". AccordCode
// is the stable per-company identifier the server keys on, so it becomes
// the CompanyID for server-sourced rows. Daily Reading scope matches on
// NSESymbol + BSECode (see annScope), both populated here.
function mapServerCompanyEntry(srv) {
  if (!srv) return null;
  const accord = srv.AccordCode != null ? String(srv.AccordCode) : '';
  return {
    CompanyID:        accord,
    CompanyName:      String(srv.CompanyName || '').trim(),
    NSESymbol:        srv.NSESymbol ? String(srv.NSESymbol) : '',
    BSECode:          srv.BseCode != null ? String(srv.BseCode) : '',
    BSESymbol:        srv.BSESymbol ? String(srv.BSESymbol) : '',
    AccordCode:       accord,
    watchlistEntryId: srv.ID != null ? srv.ID : null,
  };
}

// Fetch the canonical company list for one watchlist from the server.
// Returns a de-duped array of local company entries, or null on failure
// (so callers can tell "empty watchlist" [] apart from "fetch failed" null).
// Routed through the same single-flight queue as add/remove so it never
// races those mutations.
async function loadWatchlistCompaniesFromServer(watchListId) {
  if (watchListId == null || watchListId === '') return null;
  const data = await callAddCompanyApi({
    ID: '',
    WatchListID: Number(watchListId),
    AccordCode: '',
    CompanyName: '',
    status: false,
    input: 4,
    UserID: String(WL_USER_ID),
  });
  if (data == null) return null;
  const seen = new Set();
  const out = [];
  data.forEach(srv => {
    const entry = mapServerCompanyEntry(srv);
    if (!entry) return;
    const key = entry.AccordCode || entry.CompanyID
      || (entry.CompanyName + '|' + entry.BSECode);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  });
  return out;
}

// Ensure one watchlist's companies are populated from the server. The
// server list is authoritative, so a successful fetch REPLACES the local
// companies for that watchlist. `_companiesLoaded` is a per-session guard
// (cleared at boot, never trusted across reloads) so selecting/toggling a
// watchlist doesn't re-fetch every time; pass force:true to bypass it.
async function ensureWatchlistCompaniesLoaded(w, force) {
  if (!w || w.serverId == null) return;   // Default / local-only — nothing to fetch
  if (w._companiesLoaded && !force) return;
  const companies = await loadWatchlistCompaniesFromServer(w.serverId);
  if (companies == null) return;          // fetch failed — keep whatever we had
  w.companies = companies;
  w._companiesLoaded = true;
  writeWatchlists();
  watchlistsChanged();                    // refresh Daily Reading chips + counts
  // If this watchlist is the one open in the Settings > Watchlists tab,
  // re-render so its company chips appear immediately.
  if (state.view === 'settings'
      && state.settings && state.settings.tab === 'watchlists'
      && state.settings.wl && state.settings.wl.editing === w.id) {
    renderSettingsPanel();
  }
}

// Page-load: fetch companies for ONLY the currently-selected watchlist
// (the one shown in Settings → "Companies in X"). This fires exactly ONE
// WatchList_AddCompany (input:4) POST on page load — not one per watchlist —
// which is the requested behaviour. Every other watchlist loads lazily the
// moment it's selected (Settings list) or its chip is activated (Daily
// Reading); see ensureWatchlistCompaniesLoaded callers.
async function syncSelectedWatchlistCompaniesFromServer() {
  ensureWlEditingValid();
  const w = WATCHLISTS.find(x => x.id === state.settings.wl.editing);
  if (w) await ensureWatchlistCompaniesLoaded(w, true);
}

// Take the server's Data[] and make WATCHLISTS reflect it.
// Order in the local array: Default first, then each server entry in
// the order the server returned. Empty-named server rows and
// isCompany:"Yes" rows are filtered out (they're API artifacts, not
// real watchlists). Color is assigned deterministically by serverId
// so the same watchlist gets the same color on every device.
// Companies attached to existing local rows are preserved by
// matching old rows to new ones via serverId.
function applyServerWatchlistData(dataArray) {
  if (!Array.isArray(dataArray)) return;
  // Filter rules:
  //   • empty WatchListNAme → API artifact left over from earlier
  //     debugging sessions when the wrong input value was used;
  //     they don't represent real watchlists
  //   • isCompany "Yes"     → company entry, not a watchlist
  const named = dataArray.filter(e =>
    e && String(e.WatchListNAme || '').trim() !== ''
    && String(e.isCompany || '') !== 'Yes'
  );

  // Map old rows by serverId so we can carry forward locally-attached
  // companies (the API doesn't carry those today).
  const oldBySid = new Map();
  WATCHLISTS.forEach(w => {
    if (w.serverId != null) oldBySid.set(String(w.serverId), w);
  });

  // Default watchlist: rebuild fresh but carry forward its companies.
  const oldDefault = WATCHLISTS.find(w => w.id === DEFAULT_WL_ID);
  const newDefault = makeDefaultWatchlist();
  if (oldDefault && Array.isArray(oldDefault.companies)) {
    newDefault.companies = oldDefault.companies;
  }

  // Server entries: re-use old local row (companies + id) when we have
  // it; otherwise mint a fresh local row with a deterministic color.
  // The server's name is the source of truth — input:2 (update) now
  // actually persists renames, so we no longer need a client-side
  // override layer to defend against stale responses.
  const next = [newDefault];
  named.forEach(srv => {
    const sid = String(srv.ID);
    const old = oldBySid.get(sid);
    const incomingName = String(srv.WatchListNAme || '').trim();
    if (old) {
      next.push({
        ...old,
        name: incomingName,
        serverId: srv.ID,
      });
    } else {
      next.push({
        id: makeWlId(),
        name: incomingName,
        color: pickColorForServerId(srv.ID),
        companies: [],
        serverId: srv.ID,
      });
    }
  });

  // Preserve an in-progress draft row, if any, so a concurrent sync
  // can't drop the local draft the user is currently typing into.
  const editingId = state.settings && state.settings.wl ? state.settings.wl.renaming : null;
  if (editingId) {
    const liveDraft = WATCHLISTS.find(w => w.id === editingId && w.isDraft);
    if (liveDraft && !next.some(w => w.id === liveDraft.id)) {
      next.push(liveDraft);
    }
  }

  // Preserve any LOCAL-ONLY rows whose POST hasn't been confirmed
  // by the server yet (e.g. POST in flight, transient network
  // failure). Without this, the sync would silently drop creates
  // the user is waiting on. They keep their isPending marker so
  // the UI can show them differently if we want.
  WATCHLISTS.forEach(w => {
    if (w.isSystem) return;
    if (w.isDraft) return;          // handled by the editing-id branch above
    if (w.serverId != null) return; // already on server, no preservation needed
    if (next.some(n => n.id === w.id)) return; // already preserved
    next.push({ ...w, isPending: true });
  });

  // Replace in place so anything holding a reference to WATCHLISTS
  // sees the update.
  WATCHLISTS.length = 0;
  next.forEach(w => WATCHLISTS.push(w));

  ensureWlEditingValid();
  writeWatchlists();      // localStorage backup for instant first paint next time
  watchlistsChanged();    // re-render Daily Reading chips + Settings list
}

// Deterministic color from serverId so the same watchlist gets the
// same color on every device. Uses the existing WL_COLOR_POOL.
function pickColorForServerId(sid) {
  const n = Math.abs(Number(sid) || 0);
  return WL_COLOR_POOL[n % WL_COLOR_POOL.length];
}

// Page-load sync: fetch all watchlists from the server and replace
// local state with the response. List mode is triggered by sending
// empty ID and empty name.
// LIST / SELECT — input:4
// Page-load sync: fetch all watchlists for the current user.
// Payload: { ID:"", UserID, WatchListNAme:"", status:false, input:4 }
async function syncWatchlistsFromServer() {
  const data = await callWatchlistApi({
    ID: '',
    UserID: WL_USER_ID,
    WatchListNAme: '',
    status: false,
    input: 4,
  });
  if (data == null) {
    showWlToast('Could not sync watchlists from server', 'error');
    return false;
  }
  applyServerWatchlistData(data);
  // No green "synced" toast — the UI itself shows the watchlists,
  // which is feedback enough. Toasts only fire on errors now.
  return true;
}

// CREATE — input:1
// Payload: { ID:"", UserID, WatchListNAme: name, status:false, input:1 }
// Returns the new server-assigned numeric ID on success, or null on
// failure. We don't run applyServerWatchlistData here — the caller
// (renameWatchlist) stitches the returned ID onto the existing
// optimistic local row, which preserves the row's local id, color,
// and companies without a full rebuild.
async function createWatchlistOnServer(name) {
  const trimmedName = String(name || '').trim();
  const data = await callWatchlistApi({
    ID: '',
    UserID: WL_USER_ID,
    WatchListNAme: trimmedName,
    status: false,
    input: 1,
  });
  if (data == null) return null;
  // The response is the full user list including the new entry.
  // Identify our new row: prefer an exact-name match; fall back to
  // the highest ID we don't already know locally.
  const named = data.filter(e =>
    e && String(e.WatchListNAme || '').trim() !== ''
    && String(e.isCompany || '') !== 'Yes'
  );
  const byName = named.find(e =>
    String(e.WatchListNAme || '').trim().toLowerCase() === trimmedName.toLowerCase()
  );
  if (byName) return byName.ID;
  const knownSids = new Set();
  WATCHLISTS.forEach(w => { if (w.serverId != null) knownSids.add(String(w.serverId)); });
  const fresh = named.filter(e => !knownSids.has(String(e.ID)));
  if (fresh.length) {
    const highest = fresh.reduce((best, e) =>
      (!best || Number(e.ID) > Number(best.ID)) ? e : best, null);
    return highest.ID;
  }
  return null;
}

// UPDATE — input:2
// Payload: { ID: <number>, UserID, WatchListNAme: newName, status:false, input:2 }
// Returns true on success. The server's response is the full user
// list with the rename applied; we trust it but don't rebuild
// WATCHLISTS here — renameWatchlist has already applied the new
// name optimistically and the next page-load sync will reconcile.
async function updateWatchlistOnServer(serverId, name) {
  if (!serverId) return false;
  const data = await callWatchlistApi({
    ID: Number(serverId),
    UserID: WL_USER_ID,
    WatchListNAme: String(name || ''),
    status: false,
    input: 2,
  });
  return data != null;
}

// DELETE — input:3
// Payload: { ID: <number>, UserID, WatchListNAme:"", status:false, input:3 }
// Returns true on success. deleteWatchlist performs the optimistic
// local removal before this call and rolls back on failure, so the
// UI reflects success the moment the trash icon is clicked.
async function deleteWatchlistOnServer(serverId) {
  if (!serverId) return false;
  const data = await callWatchlistApi({
    ID: Number(serverId),
    UserID: WL_USER_ID,
    WatchListNAme: '',
    status: false,
    input: 3,
  });
  return data != null;
}

/* ---- CRUD: watchlist ---- */
// Adds an unsaved DRAFT row at the bottom of the list and opens it
// in rename mode. NO server POST happens here — the create fires
// only when the user commits a real name through commitRename →
// renameWatchlist (which routes a no-serverId row through
// createWatchlistOnServer using the user-typed name, NOT the
// placeholder). If the user blurs/Escapes without typing, the draft
// is discarded silently (commitRename / cancelRename handle that).
// Only one draft can exist at a time: clicking the button again
// while a draft is open just focuses the existing draft instead of
// stacking more.
function createWatchlist() {
  const existingDraft = WATCHLISTS.find(w => w.isDraft);
  if (existingDraft) {
    state.settings.wl.editing = existingDraft.id;
    state.settings.wl.renaming = existingDraft.id;
    writeWlEditing();
    renderSettingsPanel();
    return;
  }
  // Distinct placeholder so the input has something to show. The
  // placeholder is NEVER POSTed — it's only visible until the user
  // overwrites it.
  const base = 'New watchlist';
  let n = 1, name = base;
  while (WATCHLISTS.some(w => w.name === name)) { n++; name = base + ' ' + n; }
  const w = {
    id: makeWlId(),
    name,
    color: pickNextWlColor(),
    companies: [],
    serverId: null,
    isDraft: true,    // marker: unsaved, never POSTed yet
  };
  WATCHLISTS.push(w);
  state.settings.wl.editing = w.id;
  state.settings.wl.renaming = w.id;
  writeWlEditing();
  // Don't persist drafts to localStorage — they shouldn't survive a
  // refresh. Just refresh the UI; writeWatchlists will run when the
  // user commits a real name (via applyServerWatchlistData on POST
  // success).
  if (typeof renderChips === 'function') renderChips();
  if (typeof renderActiveBadge === 'function') renderActiveBadge();
  if (typeof renderTabCounts === 'function') renderTabCounts();
  renderSettingsPanel();
}

function renameWatchlist(id, nextName) {
  const w = WATCHLISTS.find(x => x.id === id);
  if (!w) return;
  // The Default watchlist is a pinned system row — it never goes to
  // the server and its name never changes.
  if (w.isSystem) return;
  const trimmed = String(nextName || '').trim();
  if (!trimmed || trimmed === w.name) return;

  // Optimistic local rename — apply the new name immediately so the
  // UI shows what the user typed without waiting for the server.
  w.name = trimmed;
  if (w.isDraft) delete w.isDraft;

  if (w.serverId) {
    // Existing row — fire the EDIT POST (input:2). No override
    // layer needed: input:2 actually persists the rename server-
    // side, so the next sync will return the new name correctly.
    watchlistsChanged();
    updateWatchlistOnServer(w.serverId, trimmed).then(ok => {
      if (!ok) showWlToast('Could not update name on server', 'error');
    });
  } else {
    // No serverId — this is a draft committing for the first time.
    // Fire CREATE (input:1) and stitch the returned ID onto THIS
    // local row (no list rebuild — keeps the row's local id,
    // companies, and selection state stable; only adds serverId).
    // The row is marked isPending while the POST is in flight so
    // applyServerWatchlistData on a concurrent sync knows to
    // preserve it instead of dropping it as orphan-local.
    w.isPending = true;
    watchlistsChanged();
    createWatchlistOnServer(trimmed).then(newServerId => {
      if (newServerId != null) {
        w.serverId = newServerId;
        // Now that we have a serverId, switch to the deterministic
        // color so this row gets the same color on every device.
        w.color = pickColorForServerId(newServerId);
        delete w.isPending;
        watchlistsChanged();
      } else {
        showWlToast('Could not save to server', 'error');
      }
    });
  }
}

function deleteWatchlist(id) {
  const w = WATCHLISTS.find(x => x.id === id);
  if (!w) return;
  // Default cannot be deleted — it's the pinned client-side scope
  // for the Corp Announcement view.
  if (w.isSystem) {
    alert('The Default watchlist cannot be deleted.');
    return;
  }
  if (!confirm(`Delete watchlist "${w.name}"?\nIts ${w.companies.length} ${w.companies.length === 1 ? 'company' : 'companies'} will be removed from the group (the companies themselves stay in the master list).`)) return;

  // Snapshot the row + its position so we can roll back if the
  // server delete fails. Without this, a network blip would leave
  // the user thinking the delete happened but the server still has
  // the row, and the next sync would silently restore it.
  const idx = WATCHLISTS.findIndex(x => x.id === id);
  const snapshot = { row: w, idx, wasSelected: state.selected.has(id), wasEditing: state.settings.wl.editing === id };

  // Optimistic local delete — the trash icon should feel instant.
  if (idx >= 0) WATCHLISTS.splice(idx, 1);
  state.selected.delete(id);
  if (state.selected.size === 0) state.selected.add(DEFAULT_WL_ID);
  if (snapshot.wasEditing) state.settings.wl.editing = DEFAULT_WL_ID;
  ensureWlEditingValid();
  writeWlEditing();
  watchlistsChanged();

  // If the row was never on the server (still pending or never
  // POSTed), no server call needed.
  if (w.serverId == null) return;

  // Fire DELETE POST (input:3). On failure, restore the row so the
  // UI stays consistent with what the server actually holds.
  deleteWatchlistOnServer(w.serverId).then(ok => {
    if (ok) return;
    WATCHLISTS.splice(snapshot.idx, 0, snapshot.row);
    if (snapshot.wasSelected) state.selected.add(id);
    if (snapshot.wasEditing) state.settings.wl.editing = id;
    ensureWlEditingValid();
    watchlistsChanged();
    showWlToast('Could not delete on server — restored', 'error');
  });
}

// Lightweight toast used for watchlist sync feedback. Reuses a single
// DOM node, replaces text + class on each call, auto-fades after 2.5s.
// `kind` ∈ 'info' | 'success' | 'error' — drives the accent color.
function showWlToast(message, kind) {
  let el = document.getElementById('wlToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wlToast';
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px',
      'padding:10px 16px',
      'border-radius:6px',
      'font-family:Inter,sans-serif',
      'font-size:12.5px',
      'font-weight:500',
      'color:#FFFFFF',
      'box-shadow:0 8px 24px rgba(15,23,42,0.18)',
      'z-index:9999',
      'opacity:0',
      'transform:translateY(8px)',
      'transition:opacity .18s, transform .18s',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(el);
  }
  const palette = {
    info:    '#1F2937',
    success: '#0F8A5F',
    error:   '#C0392B'
  };
  el.style.background = palette[kind] || palette.info;
  el.textContent = message;
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
  }, 2500);
}

// Remove a company from a watchlist on the server. Returns true on
// success, false on failure. The `entryId` is the server-assigned
// primary key returned in the create response (stored locally as
// `watchlistEntryId` on each company row) — NOT the master CompanyID.
//
// Payload exactly matches the user's spec:
//   { ID:<entryId>, WatchListID:<num>, AccordCode:"", CompanyName:"",
//     status:false, input:3, UserID:"2" }
//
// Note UserID is a STRING here, where it's a NUMBER on the add
// payload — that asymmetry is intentional per the user's spec
// and respected verbatim so the API contract is satisfied.
async function removeCompanyFromWatchlistOnServer(watchListId, entryId) {
  if (!watchListId || !entryId) return false;
  const data = await callAddCompanyApi({
    ID: Number(entryId),
    WatchListID: Number(watchListId),
    AccordCode: '',
    CompanyName: '',
    status: false,
    input: 3,
    UserID: String(WL_USER_ID),
  });
  return data != null;
}

/* ---- CRUD: companies inside a watchlist ---- */
function addCompanyToWatchlist(wid, company) {
  const w = WATCHLISTS.find(x => x.id === wid);
  if (!w || !company || !company.CompanyID) return;
  // De-dupe before POSTing. Match on CompanyID (search-sourced rows) OR
  // AccordCode (server-listing rows use AccordCode as their CompanyID), so a
  // company already present from the input:4 listing isn't added twice.
  if (w.companies.some(c => c && (
        (c.CompanyID && String(c.CompanyID) === String(company.CompanyID)) ||
        (c.AccordCode && company.AccordCode != null
          && String(c.AccordCode) === String(company.AccordCode))
      ))) return;

  // Optimistic local add — the row shows up in "Companies in <name>"
  // the instant the user picks it from the dropdown. AccordCode is
  // carried forward so we can identify this row on the server later
  // (e.g. for a future delete). isPending stays until the POST lands
  // so applyServerWatchlistData (if it runs concurrently) knows not
  // to drop this row as orphan-local.
  const localEntry = {
    CompanyID:   String(company.CompanyID),
    CompanyName: String(company.CompanyName || '').trim(),
    NSESymbol:   company.NSESymbol ? String(company.NSESymbol) : '',
    BSECode:     company.BSECode   ? String(company.BSECode)   : '',
    AccordCode:  company.AccordCode != null ? String(company.AccordCode) : '',
    isPending:   true,
  };
  w.companies.push(localEntry);
  watchlistsChanged();
  renderSettingsPanel();

  // If the watchlist hasn't been confirmed on the server yet (its
  // own create POST is still in flight, or never landed), there's
  // no server-side WatchListID to attach the company to. Keep the
  // local entry and warn — the user will see the row but it won't
  // sync until they retry on a fully-saved watchlist.
  if (w.serverId == null) {
    // eslint-disable-next-line no-console
    console.warn('[Company] Watchlist "' + w.name + '" has no serverId; ' +
      'company added locally only. Wait for the watchlist to save and re-add.');
    delete localEntry.isPending;
    writeWatchlists();
    return;
  }
  // If the company has no AccordCode, the API can't accept it — keep
  // it local and surface the limitation. This is rare; the search
  // endpoint always returns AccordCode.
  if (company.AccordCode == null) {
    // eslint-disable-next-line no-console
    console.warn('[Company] No AccordCode on selection; company added locally only');
    delete localEntry.isPending;
    writeWatchlists();
    return;
  }

  // Fire the server POST. On success, stitch the new server-side
  // entryId (used by future delete-from-watchlist) and enrich
  // missing fields from the server's normalized record. On failure,
  // roll back the local add so the UI matches the server.
  addCompanyToWatchlistOnServer(w.serverId, company).then(result => {
    if (result) {
      localEntry.watchlistEntryId = result.entryId;
      // Enrich any fields the search dropdown left blank using the
      // server's authoritative record. Note the server uses "BseCode"
      // (lowercase "se") — normalize to local "BSECode".
      const srv = result.enriched;
      if (!localEntry.BSECode  && srv.BseCode)   localEntry.BSECode  = String(srv.BseCode);
      if (!localEntry.NSESymbol && srv.NSESymbol) localEntry.NSESymbol = String(srv.NSESymbol);
      if (!localEntry.BSESymbol && srv.BSESymbol) localEntry.BSESymbol = String(srv.BSESymbol);
      delete localEntry.isPending;
      writeWatchlists();
      watchlistsChanged();
      renderSettingsPanel();
    } else {
      // Server rejected or network failed — roll back.
      const idx = w.companies.indexOf(localEntry);
      if (idx >= 0) w.companies.splice(idx, 1);
      writeWatchlists();
      watchlistsChanged();
      renderSettingsPanel();
      showWlToast('Could not add company to server', 'error');
    }
  });
}

function removeCompanyFromWatchlist(wid, companyId) {
  const w = WATCHLISTS.find(x => x.id === wid);
  if (!w) return;
  const idx = w.companies.findIndex(c => c && String(c.CompanyID) === String(companyId));
  if (idx < 0) return;

  // Snapshot the row + its position so we can roll back if the
  // server delete fails. A network blip or 5xx must not leave the
  // user thinking the company was removed while the server still
  // holds it — the next sync would silently bring it back.
  const snapshot = { row: w.companies[idx], idx };
  const entryId = snapshot.row.watchlistEntryId;

  // Optimistic local removal — the × pill should feel instant.
  w.companies.splice(idx, 1);
  watchlistsChanged();
  renderSettingsPanel();

  // No server-side ID means this company was added in a session
  // when the watchlist had no serverId (or the original create POST
  // never confirmed). There's nothing to delete on the server, so
  // just leave the local removal as-is.
  if (entryId == null || w.serverId == null) {
    writeWatchlists();
    return;
  }

  // Fire DELETE POST (input:3). On failure, restore the company at
  // its original position so the UI stays consistent with what the
  // server actually holds.
  removeCompanyFromWatchlistOnServer(w.serverId, entryId).then(ok => {
    if (ok) {
      writeWatchlists();
      return;
    }
    // Rollback — re-insert at the same index, re-render, surface
    // the failure.
    w.companies.splice(snapshot.idx, 0, snapshot.row);
    writeWatchlists();
    watchlistsChanged();
    renderSettingsPanel();
    showWlToast('Could not remove company on server — restored', 'error');
  });
}

/* ---- Renderer ---- */
function renderWatchlistsTab() {
  ensureWlEditingValid();
  const editingW = WATCHLISTS.find(w => w.id === state.settings.wl.editing) || WATCHLISTS[0];

  const rowsHtml = WATCHLISTS.map(w => {
    const active = w.id === state.settings.wl.editing;
    const renaming = state.settings.wl.renaming === w.id;
    // Plain text by default; promoted to <input> only when this row is
    // in rename mode (set by dblclick handler in wireWatchlistsTab).
    const nameHtml = renaming
      ? `<input class="wl-row-name editing" data-wid="${safeAttr(w.id)}" value="${safeAttr(w.name)}" spellcheck="false" maxlength="50">`
      : `<span class="wl-row-name" data-wid="${safeAttr(w.id)}">${escapeHtml(w.name)}</span>`;
    // The outer element MUST be a <div>, not a <button>: the trash icon
    // inside is itself a <button>, and nested buttons are invalid HTML
    // — browsers auto-close the outer button when they see the inner,
    // ejecting the trash icon out of the row entirely (visible as a
    // dangling trash icon below the row, no longer end-aligned).
    return `<div class="wl-manage-row ${active ? 'active' : ''}" data-wid-row="${safeAttr(w.id)}" role="button" tabindex="0">
      <span class="wl-row-dot" style="background:${safeAttr(w.color || '#9CA3AF')}"></span>
      ${nameHtml}
      <span class="wl-row-count">${w.companies.length}</span>
      <button type="button" class="wl-row-icon-btn danger" data-wid-del="${safeAttr(w.id)}" title="Delete watchlist" aria-label="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </div>`;
  }).join('');

  // Compact company chips: just NSE symbol (or BSE code fallback) + ×.
  // No company name, no "NSE:" / "BSE:" prefix labels. Chips wrap onto
  // multiple lines via the .wl-companies flex container.
  const companiesHtml = (editingW && editingW.companies.length)
    ? `<div class="wl-companies">${editingW.companies.map(c => {
        const symbol = String(c.NSESymbol || c.BSECode || '').trim();
        if (!symbol) return '';
        return `<span class="wl-company-chip">
          ${escapeHtml(symbol)}
          <button type="button" class="wl-company-chip-remove" data-wid-co="${safeAttr(editingW.id)}" data-cid-co="${safeAttr(String(c.CompanyID))}" title="Remove ${escapeHtml(symbol)}" aria-label="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>`;
      }).join('')}</div>`
    : `<div class="wl-companies-empty">No companies in this watchlist yet. Use the search or bulk import above to add some.</div>`;

  return `
    <section class="settings-card">
      <div class="settings-card-head">
        <h2>Your watchlists</h2>
        <p>Single-click to select. Double-click the name to rename. Selecting a watchlist on the Daily Reading page filters Corp Announcements to those companies.</p>
      </div>
      <div class="wl-manage-list" id="wlManageList">${rowsHtml}</div>
      <div class="wl-manage-foot">
        <button type="button" class="settings-btn" id="wlAddNewBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New watchlist
        </button>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-head">
        <h2>Companies in <span id="wlEditingName">${escapeHtml(editingW ? editingW.name : '—')}</span></h2>
        <p>Search by company name, NSE symbol, or BSE code. Or paste a list via Bulk import.</p>
      </div>
      <div class="wl-add-controls">
        <div class="wl-add-shell ${state.settings.wl.search.query ? 'has-value' : ''}">
          <input class="field-input" id="wlAddInput" type="text" placeholder="Search to add a company…" autocomplete="off" spellcheck="false" value="${safeAttr(state.settings.wl.search.query)}">
          <svg class="wl-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <button type="button" class="wl-add-clear" id="wlAddClearBtn" aria-label="Clear search" title="Clear">&times;</button>
          <div class="wl-add-dropdown" id="wlAddDropdown" hidden></div>
        </div>
        <button type="button" class="settings-btn" id="wlBulkOpenBtn" title="Paste a list of NSE symbols or BSE codes">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Bulk import
        </button>
      </div>
      ${companiesHtml}
    </section>
  `;
}

function renderWlAddDropdown() {
  const dd = document.getElementById('wlAddDropdown');
  if (!dd) return;
  const s = state.settings.wl.search;
  if (!s.open || !s.query || s.query.length < SEARCH_MIN_CHARS) {
    dd.hidden = true;
    dd.innerHTML = '';
    return;
  }
  dd.hidden = false;
  if (s.loading) {
    dd.innerHTML = '<div class="wl-add-status">Searching…</div>';
    return;
  }
  if (s.error) {
    dd.innerHTML = `<div class="wl-add-status error">Couldn't reach the company directory — ${escapeHtml(s.error)}</div>`;
    return;
  }
  if (!s.results.length) {
    dd.innerHTML = `<div class="wl-add-status">No companies match <strong>"${escapeHtml(s.query)}"</strong></div>`;
    return;
  }
  const editingW = WATCHLISTS.find(w => w.id === state.settings.wl.editing);
  const existingIds = new Set((editingW ? editingW.companies : []).map(c => String(c.CompanyID || '')));
  const results = s.results.slice(0, 20);

  // Clamp the highlighted index: drop to first selectable row whenever
  // it's out of range or currently points at an already-added row. -1
  // is allowed (means "nothing highlighted"), e.g. when every visible
  // result is already in the watchlist.
  const isSelectable = idx => !existingIds.has(String((results[idx] || {}).CompanyID || ''));
  if (s.highlighted < 0 || s.highlighted >= results.length || !isSelectable(s.highlighted)) {
    s.highlighted = results.findIndex(c => !existingIds.has(String(c.CompanyID || '')));
  }

  dd.innerHTML = results.map((c, idx) => {
    const cid = String(c.CompanyID || '');
    const already = existingIds.has(cid);
    const isHl = idx === s.highlighted;
    const cls = already ? 'disabled' : (isHl ? 'highlighted' : '');
    const sym = c.NSESymbol || c.BSESymbol || c.BSECode || '';
    return `<div class="wl-add-row ${cls}" data-add-cid="${safeAttr(cid)}" data-add-idx="${idx}">
      <span class="wl-add-row-name">${escapeHtml(c.CompanyName || '—')}</span>
      <span class="wl-add-row-meta">${already ? 'Added' : escapeHtml(sym)}</span>
    </div>`;
  }).join('');
}

async function wlSearchCompanies(query) {
  const s = state.settings.wl.search;
  if (s.abortController) s.abortController.abort();
  s.abortController = new AbortController();
  s.loading = true;
  s.error = null;
  s.highlighted = -1;   // clear stale highlight; renderWlAddDropdown re-picks first selectable
  renderWlAddDropdown();
  try {
    const res = await fetch(SEARCH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ Search: query, Type: '', sector_id: [], industry_id: [], company_id: [] }),
      signal: s.abortController.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    s.results = Array.isArray(json) ? json : [];
    s.loading = false;
    s.highlighted = -1;  // results just changed; renderer will pick first selectable
    renderWlAddDropdown();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    s.error = (e && e.message) ? e.message : 'Request failed';
    s.loading = false;
    s.results = [];
    renderWlAddDropdown();
  }
}

function wireWatchlistsTab() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;

  // If a row is currently in rename mode, focus its input on render so
  // the user can start typing immediately after the double-click that
  // promoted the span to an input.
  if (state.settings.wl.renaming) {
    const sel = `input.wl-row-name.editing[data-wid="${(window.CSS && CSS.escape) ? CSS.escape(state.settings.wl.renaming) : state.settings.wl.renaming}"]`;
    const inp = document.querySelector(sel);
    if (inp) { inp.focus(); inp.select(); }
  }

  // ---- Manage list ----
  panel.querySelectorAll('.wl-manage-row[data-wid-row]').forEach(row => {
    // Single click anywhere on the row (except inner controls) selects
    // the watchlist for company editing.
    row.addEventListener('click', e => {
      if (e.target.closest('.wl-row-name.editing')) return;     // editing the name
      if (e.target.closest('[data-wid-del]')) return;            // delete handled separately
      // If this row is in rename mode, single-click on the span area
      // shouldn't bubble to "select" — it's just inside the rename UI.
      if (e.target.closest('.wl-row-name') && state.settings.wl.renaming === row.dataset.widRow) return;
      const id = row.dataset.widRow;
      if (id && id !== state.settings.wl.editing) {
        state.settings.wl.editing = id;
        writeWlEditing();
        renderSettingsPanel();
        // Pull this watchlist's companies from the server (input:4) if we
        // haven't this session, so "Companies in <name>" shows the real
        // server-side list the moment the user switches to it.
        const wsel = WATCHLISTS.find(x => x.id === id);
        if (wsel) ensureWatchlistCompaniesLoaded(wsel, false);
      }
    });
    // Double-click on the name promotes the span → input.
    row.addEventListener('dblclick', e => {
      const nameEl = e.target.closest('.wl-row-name');
      if (!nameEl) return;
      if (e.target.closest('[data-wid-del]')) return;
      const id = row.dataset.widRow;
      if (!id) return;
      state.settings.wl.renaming = id;
      // Ensure the row is also selected so company panel reflects the
      // watchlist being renamed.
      state.settings.wl.editing = id;
      writeWlEditing();
      renderSettingsPanel();
    });
  });

  // Rename input handlers — only present when a row is in rename mode.
  panel.querySelectorAll('input.wl-row-name.editing[data-wid]').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(input.dataset.wid, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
    });
    input.addEventListener('blur', () => commitRename(input.dataset.wid, input.value));
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('dblclick', e => e.stopPropagation());
  });

  // Delete watchlist
  panel.querySelectorAll('[data-wid-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteWatchlist(btn.dataset.widDel);
    });
  });

  // ---- Add company (search) ----
  const input = document.getElementById('wlAddInput');
  const dd    = document.getElementById('wlAddDropdown');
  if (input) {
    input.addEventListener('input', e => {
      const q = String(e.target.value || '');
      state.settings.wl.search.query = q;
      state.settings.wl.search.open = true;
      state.settings.wl.search.highlighted = -1;  // a new query → new highlight
      // Toggle the clear button on the shell. Cheaper than re-rendering
      // the whole tab just to flip a class.
      const shell = input.closest('.wl-add-shell');
      if (shell) shell.classList.toggle('has-value', q.length > 0);
      clearTimeout(state.settings.wl.search.debounceTimer);
      if (q.length < SEARCH_MIN_CHARS) { renderWlAddDropdown(); return; }
      state.settings.wl.search.debounceTimer = setTimeout(() => wlSearchCompanies(q), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener('focus', () => {
      state.settings.wl.search.open = true;
      renderWlAddDropdown();
    });
    input.addEventListener('keydown', e => {
      const s = state.settings.wl.search;
      const results = (s.results || []).slice(0, 20);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!s.open) { s.open = true; renderWlAddDropdown(); return; }
        moveWlHighlight(+1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!s.open) return;
        moveWlHighlight(-1);
      } else if (e.key === 'Enter') {
        // Only consume Enter if the dropdown is open with a selectable
        // row highlighted — otherwise let it pass (e.g. for form submit
        // in other contexts; here it's a no-op).
        if (s.open && s.highlighted >= 0 && results[s.highlighted]) {
          e.preventDefault();
          const editingW = WATCHLISTS.find(w => w.id === state.settings.wl.editing);
          const already = editingW && editingW.companies.some(c => String(c.CompanyID) === String(results[s.highlighted].CompanyID));
          if (!already) {
            addCompanyToWatchlist(state.settings.wl.editing, results[s.highlighted]);
            // Reset for the next quick-add
            state.settings.wl.search.query = '';
            state.settings.wl.search.results = [];
            state.settings.wl.search.highlighted = -1;
            state.settings.wl.search.open = false;
            const ni = document.getElementById('wlAddInput');
            if (ni) ni.focus();
          }
        }
      } else if (e.key === 'Escape') {
        s.open = false;
        renderWlAddDropdown();
        input.blur();
      }
    });
  }
  // Clear-button × inside the search input — wipes the query and closes
  // the dropdown, keeping focus on the input so the user can immediately
  // start a new search.
  const clearBtn = document.getElementById('wlAddClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.settings.wl.search.query = '';
      state.settings.wl.search.results = [];
      state.settings.wl.search.highlighted = -1;
      state.settings.wl.search.open = false;
      const inp = document.getElementById('wlAddInput');
      if (inp) { inp.value = ''; inp.focus(); }
      const shell = clearBtn.closest('.wl-add-shell');
      if (shell) shell.classList.remove('has-value');
      renderWlAddDropdown();
    });
  }
  if (dd) {
    dd.addEventListener('click', e => {
      const row = e.target.closest('.wl-add-row[data-add-cid]');
      if (!row || row.classList.contains('disabled')) return;
      const cid = row.dataset.addCid;
      const company = (state.settings.wl.search.results || []).find(c => String(c.CompanyID) === String(cid));
      if (!company) return;
      addCompanyToWatchlist(state.settings.wl.editing, company);
      state.settings.wl.search.query = '';
      state.settings.wl.search.results = [];
      state.settings.wl.search.open = false;
      const newInput = document.getElementById('wlAddInput');
      if (newInput) newInput.focus();
    });
  }
  document.addEventListener('click', wlAddOutsideClick);

  // ---- Add new watchlist ----
  const addNewBtn = document.getElementById('wlAddNewBtn');
  if (addNewBtn) addNewBtn.addEventListener('click', createWatchlist);

  // ---- Bulk import ----
  const bulkOpenBtn = document.getElementById('wlBulkOpenBtn');
  if (bulkOpenBtn) bulkOpenBtn.addEventListener('click', openBulkImport);

  // ---- Remove company (chip ×) ----
  panel.querySelectorAll('[data-cid-co]').forEach(btn => {
    btn.addEventListener('click', () => {
      removeCompanyFromWatchlist(btn.dataset.widCo, btn.dataset.cidCo);
    });
  });
}

function commitRename(wid, value) {
  const w = WATCHLISTS.find(x => x.id === wid);
  if (!w) {
    state.settings.wl.renaming = null;
    renderSettingsPanel();
    return;
  }
  const trimmed = String(value || '').trim();
  // Draft + value is blank OR still the placeholder name → user
  // never typed a real name. Discard the draft silently so it
  // doesn't pollute the list or get accidentally POSTed.
  if (w.isDraft && (trimmed === '' || trimmed === w.name)) {
    discardDraftRow(wid);
    return;
  }
  renameWatchlist(wid, trimmed);
  state.settings.wl.renaming = null;
  renderSettingsPanel();
}
function cancelRename() {
  const wid = state.settings.wl.renaming;
  if (wid) {
    const w = WATCHLISTS.find(x => x.id === wid);
    if (w && w.isDraft) {
      // Escape on a draft → throw the draft away.
      discardDraftRow(wid);
      return;
    }
  }
  state.settings.wl.renaming = null;
  renderSettingsPanel();
}
// Shared helper: remove a draft row from WATCHLISTS, clean any
// selection/editing state that referenced it, re-render.
function discardDraftRow(wid) {
  const idx = WATCHLISTS.findIndex(x => x.id === wid);
  if (idx >= 0) WATCHLISTS.splice(idx, 1);
  state.selected.delete(wid);
  if (state.selected.size === 0) state.selected.add(DEFAULT_WL_ID);
  if (state.settings.wl.editing === wid) state.settings.wl.editing = DEFAULT_WL_ID;
  state.settings.wl.renaming = null;
  ensureWlEditingValid();
  // Don't writeWatchlists — drafts shouldn't survive a refresh anyway.
  if (typeof renderChips === 'function') renderChips();
  if (typeof renderActiveBadge === 'function') renderActiveBadge();
  if (typeof renderTabCounts === 'function') renderTabCounts();
  renderSettingsPanel();
}

function wlAddOutsideClick(e) {
  if (state.view !== 'settings' || state.settings.tab !== 'watchlists') return;
  if (!state.settings.wl.search.open) return;
  if (e.target.closest('.wl-add-shell')) return;
  state.settings.wl.search.open = false;
  renderWlAddDropdown();
}

// Move the keyboard highlight up or down through the dropdown results,
// skipping rows for companies already in the current watchlist (those
// render with the .disabled class and aren't actionable). Wraps top↔bottom.
// If every result is already in the watchlist, the highlight stays at -1.
function moveWlHighlight(dir) {
  const s = state.settings.wl.search;
  const results = (s.results || []).slice(0, 20);
  if (!results.length) return;
  const editingW = WATCHLISTS.find(w => w.id === state.settings.wl.editing);
  const existing = new Set((editingW ? editingW.companies : []).map(c => String(c.CompanyID || '')));
  const n = results.length;
  let i = (s.highlighted < 0) ? (dir > 0 ? -1 : 0) : s.highlighted;
  for (let step = 0; step < n; step++) {
    i = ((i + dir) % n + n) % n;
    if (!existing.has(String(results[i].CompanyID || ''))) {
      s.highlighted = i;
      renderWlAddDropdown();
      // Scroll the now-highlighted row into view (no smooth scroll —
      // arrow-key navigation should feel instant).
      const dd = document.getElementById('wlAddDropdown');
      const row = dd ? dd.querySelector(`[data-add-idx="${i}"]`) : null;
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  // All disabled — leave highlight where it is.
}

/* ============================ BULK IMPORT TO WATCHLIST ============================
   Paste-driven import: user pastes/types a list of NSE symbols or BSE
   codes (newline / comma / space separated), we resolve each against
   SymbolMaster_WithCode (concurrency-capped at 6), and add the matches
   to the currently-edited watchlist. Result screen tallies added /
   already-in-watchlist / not-found.

   We can't bulk-resolve in one request (the API takes a single Search
   string), but we can fan out N concurrent queries cheaply. A 50-symbol
   import resolves in well under a second on a good connection. */

const WL_BULK_CONCURRENCY = 6;

function openBulkImport() {
  state.settings.wl.bulk = {
    open: true,
    text: '',
    importing: false,
    progress: { done: 0, total: 0 },
    result: null,
  };
  renderBulkModal();
  // Focus the textarea so user can paste straight away
  setTimeout(() => {
    const ta = document.getElementById('wlBulkText');
    if (ta) ta.focus();
  }, 0);
}

function closeBulkImport() {
  // If we just finished an import with additions, the panel needs to
  // re-render so the new chips show up. Otherwise just close the modal.
  const hadAdds = state.settings.wl.bulk.result && state.settings.wl.bulk.result.added > 0;
  state.settings.wl.bulk.open = false;
  state.settings.wl.bulk.text = '';
  state.settings.wl.bulk.result = null;
  renderBulkModal();
  if (hadAdds) renderSettingsPanel();
}

// Resolve one user-input token (NSE symbol or BSE code) to a company
// object via SymbolMaster_WithCode. Returns null if no exact match.
// Exact = NSESymbol or BSECode (case-insensitive) equals the input.
async function resolveSymbol(token) {
  const q = String(token || '').trim();
  if (!q) return null;
  try {
    const res = await fetch(SEARCH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ Search: q, Type: '', sector_id: [], industry_id: [], company_id: [] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = Array.isArray(json) ? json : [];
    const Q = q.toUpperCase();
    // Exact match on NSESymbol or BSECode. We use exact (not fuzzy)
    // because the user pasted a specific code, not a name fragment;
    // a partial match could pick the wrong company.
    return results.find(r =>
      String(r.NSESymbol || '').toUpperCase() === Q ||
      String(r.BSECode   || '').toUpperCase() === Q
    ) || null;
  } catch (_) {
    return null;
  }
}

async function runBulkImport() {
  const wlId = state.settings.wl.editing;
  const w = WATCHLISTS.find(x => x.id === wlId);
  if (!w) return;
  const raw = String(state.settings.wl.bulk.text || '');
  // Split on commas, semicolons, whitespace (incl. newlines).
  const tokens = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  // Case-insensitive dedupe (HDFCBANK and hdfcbank are the same input).
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    const k = t.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(t);
  }
  if (!unique.length) return;

  state.settings.wl.bulk.importing = true;
  state.settings.wl.bulk.progress = { done: 0, total: unique.length };
  state.settings.wl.bulk.result = null;
  renderBulkModal();

  const existingIds = new Set(w.companies.map(c => String(c.CompanyID || '')));
  const added = [];
  const notFound = [];
  let duplicates = 0;

  const queue = unique.slice();
  async function worker() {
    while (queue.length) {
      const tok = queue.shift();
      if (tok === undefined) break;
      const co = await resolveSymbol(tok);
      if (!co || !co.CompanyID) {
        notFound.push(tok);
      } else if (existingIds.has(String(co.CompanyID))) {
        duplicates++;
      } else {
        existingIds.add(String(co.CompanyID));
        added.push(co);
      }
      state.settings.wl.bulk.progress.done++;
      // Progress updates are throttled by the next event-loop turn;
      // re-render after each token is cheap (only the modal body).
      renderBulkModal();
    }
  }
  const workers = [];
  const concurrency = Math.min(WL_BULK_CONCURRENCY, unique.length);
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  // Commit all adds in one go so localStorage gets a single write.
  if (added.length) {
    for (const co of added) {
      w.companies.push({
        CompanyID:   String(co.CompanyID),
        CompanyName: String(co.CompanyName || '').trim(),
        NSESymbol:   co.NSESymbol ? String(co.NSESymbol) : '',
        BSECode:     co.BSECode   ? String(co.BSECode)   : '',
      });
    }
    watchlistsChanged();
  }

  state.settings.wl.bulk.importing = false;
  state.settings.wl.bulk.result = {
    added: added.length,
    duplicates,
    notFound,
  };
  renderBulkModal();
}

function renderBulkModal() {
  const modal = document.getElementById('wlBulkModal');
  const body  = document.getElementById('wlBulkBody');
  const target = document.getElementById('wlBulkTarget');
  if (!modal || !body) return;
  const bulk = state.settings.wl.bulk;
  if (!bulk.open) { modal.hidden = true; return; }
  modal.hidden = false;

  const w = WATCHLISTS.find(x => x.id === state.settings.wl.editing);
  if (target) target.textContent = w ? w.name : '—';

  if (bulk.importing) {
    body.innerHTML = `<div class="wl-bulk-status">
      <div class="wl-bulk-spinner"></div>
      <p>Resolving ${bulk.progress.done} of ${bulk.progress.total}…</p>
    </div>`;
    return;
  }

  if (bulk.result) {
    const r = bulk.result;
    const lines = [];
    lines.push(`<div class="wl-bulk-result-line wl-bulk-result-ok">Added ${r.added} ${r.added === 1 ? 'company' : 'companies'}</div>`);
    if (r.duplicates) {
      lines.push(`<div class="wl-bulk-result-line wl-bulk-result-warn">Skipped ${r.duplicates} already in watchlist</div>`);
    }
    if (r.notFound.length) {
      const preview = r.notFound.slice(0, 12).map(escapeHtml).join(', ');
      const more = r.notFound.length > 12 ? ` and ${r.notFound.length - 12} more` : '';
      lines.push(`<div class="wl-bulk-result-line wl-bulk-result-err">${r.notFound.length} not found: ${preview}${more}</div>`);
    }
    body.innerHTML = `${lines.join('')}
      <div class="wl-bulk-foot" style="justify-content:flex-end">
        <div class="wl-bulk-actions">
          <button type="button" class="settings-btn" id="wlBulkRestartBtn">Import more</button>
          <button type="button" class="field-action" id="wlBulkDoneBtn">Done</button>
        </div>
      </div>`;
    return;
  }

  // Input state
  const tokens = (bulk.text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(); let n = 0;
  for (const t of tokens) { const k = t.toUpperCase(); if (!seen.has(k)) { seen.add(k); n++; } }
  body.innerHTML = `
    <p class="wl-bulk-hint">Paste NSE symbols or BSE codes — one per line, comma-separated, or space-separated. Duplicates are dropped automatically.</p>
    <textarea class="wl-bulk-textarea" id="wlBulkText" placeholder="HDFCBANK&#10;ICICIBANK&#10;500325&#10;RELIANCE&#10;SBIN">${escapeHtml(bulk.text)}</textarea>
    <div class="wl-bulk-foot">
      <span class="wl-bulk-count">${n} ${n === 1 ? 'entry' : 'entries'} detected</span>
      <div class="wl-bulk-actions">
        <button type="button" class="settings-btn" id="wlBulkCancelBtn">Cancel</button>
        <button type="button" class="field-action" id="wlBulkRunBtn" ${n === 0 ? 'disabled' : ''}>Import ${n > 0 ? n : ''} ${n === 1 ? 'company' : 'companies'}</button>
      </div>
    </div>`;

  // Wire inputs / buttons for this render
  const ta = document.getElementById('wlBulkText');
  if (ta) {
    ta.addEventListener('input', e => {
      state.settings.wl.bulk.text = String(e.target.value || '');
      // Re-render to update the live count + button label. Cheap.
      renderBulkModal();
      // Re-focus after re-render (innerHTML replacement loses focus)
      const next = document.getElementById('wlBulkText');
      if (next) {
        next.focus();
        // Restore cursor at the end
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }
  const cancel = document.getElementById('wlBulkCancelBtn');
  if (cancel) cancel.addEventListener('click', closeBulkImport);
  const run = document.getElementById('wlBulkRunBtn');
  if (run) run.addEventListener('click', runBulkImport);
}

// Global event delegation for the bulk modal — handles close button,
// backdrop click, and post-import action buttons (Restart / Done).
document.addEventListener('click', e => {
  if (!state.settings || !state.settings.wl || !state.settings.wl.bulk.open) return;
  if (e.target.closest('.wl-bulk-close')) { closeBulkImport(); return; }
  if (e.target.classList && e.target.classList.contains('wl-bulk-backdrop')) { closeBulkImport(); return; }
  if (e.target.closest('#wlBulkDoneBtn')) { closeBulkImport(); return; }
  if (e.target.closest('#wlBulkRestartBtn')) {
    // Reset to input state for another paste
    state.settings.wl.bulk.text = '';
    state.settings.wl.bulk.result = null;
    renderBulkModal();
    return;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.settings && state.settings.wl && state.settings.wl.bulk.open) {
    if (!state.settings.wl.bulk.importing) closeBulkImport();
  }
});

function handleAvatarFile(file) {
  if (!file) return;
  if (!AVATAR_ACCEPT_TYPES.includes(file.type)) {
    alert('Please choose a JPG, PNG, or WebP image.');
    return;
  }
  if (file.size > AVATAR_MAX_BYTES) {
    alert('Image is over 2 MB. Please choose a smaller file or compress it first.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.settings.profile.avatarDataUrl = String(reader.result || '');
    writeSettings();
    syncSidebarUserCard();
    renderSettingsPanel();
  };
  reader.onerror = () => alert("Couldn't read that file. Please try another.");
  reader.readAsDataURL(file);
}

/* ---- Sidebar nav wiring (Daily Reading / Settings) ---- */
(function wireSidebarViewNav() {
  document.querySelectorAll('.sidebar .nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      showView(el.dataset.view);
    });
  });
})();

/* ---- Collapsible sidebar ----
   The topbar hamburger toggles a .sidebar-collapsed class on .app; the grid
   column shrinks to a 64px icon rail and the 1fr main area reflows to fill it
   (no blank space, no content change). The app starts collapsed on every load
   (class set in the markup, so there's no expand→collapse flash and no
   persistence). While collapsed, each nav icon exposes its label as a native
   hover tooltip; expanded nav items don't need one. */
(function wireSidebarToggle() {
  const app = document.querySelector('.app');
  const btn = document.getElementById('sidebarToggle');
  if (!app || !btn) return;
  const navs = Array.from(app.querySelectorAll('.sidebar .nav-item'));
  const sync = () => {
    const collapsed = app.classList.contains('sidebar-collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    navs.forEach(a => {
      const t = a.querySelector('.nav-text');
      if (collapsed && t) a.setAttribute('title', t.textContent.trim());
      else a.removeAttribute('title');
    });
  };
  btn.addEventListener('click', () => { app.classList.toggle('sidebar-collapsed'); sync(); });
  sync();   // markup starts collapsed → set initial tooltips + aria
})();

/* ---- Branding area = home button ----
   Clicking the logo/wordmark (or pressing Enter/Space when it's focused)
   navigates to the Daily Reading HOME page, the same destination as the
   "Daily Reading" nav item. This is the familiar "logo goes home" pattern. */
(function wireBrandHome() {
  const brand = document.querySelector('.sidebar .brand[data-home]');
  if (!brand) return;
  const goHome = () => showView('daily');
  brand.addEventListener('click', goHome);
  brand.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); }
  });
})();

/* ---- Forensic landing CTA ----
   The "Select a company" button on the Forensic empty state just drops focus
   into the top search bar, where the existing global-search flow takes over;
   picking a result opens that company's Forensic tab (see selectCompany). */
(function wireForensicLanding() {
  const cta = document.getElementById('forensicSearchCta');
  if (!cta) return;
  cta.addEventListener('click', () => {
    const gs = document.getElementById('globalSearchInput');
    if (gs) { try { gs.focus(); } catch (_) {} }
  });
})();

/* ---- Hash routing for the named top-level pages ----
   Lets the home page be reached/linked as "#home" (and Settings as
   "#settings"). The INITIAL route runs at the very end of init (after the
   FAB and views exist), because showView() touches the FAB. Here we only
   attach the listener for later hash changes. showView() uses
   history.replaceState, which does not fire hashchange, so this never loops. */
function viewForHash(h) {
  const clean = String(h || '').replace(/^#/, '').toLowerCase();
  if (clean === 'settings') return 'settings';
  if (clean === 'forensic') return 'forensic';
  return 'daily';   // '#home', empty, or anything unknown → home
}
window.addEventListener('hashchange', () => {
  const target = viewForHash(location.hash);
  if (target !== state.view) showView(target);
});

/* ---- Settings sub-tab wiring ---- */
(function wireSettingsTabs() {
  const tabs = document.getElementById('settingsTabs');
  if (!tabs) return;
  tabs.addEventListener('click', e => {
    const btn = e.target.closest('.s-tab[data-stab]');
    if (!btn) return;
    setSettingsTab(btn.dataset.stab);
  });
})();

/* ---- Init: rehydrate from localStorage, sync sidebar ---- */
readSettings();
readWatchlists();
readWlEditing();   // restore the last-selected watchlist (validated after sync)
// The `_companiesLoaded` guard is per-session only — a value persisted in a
// prior session's localStorage must not suppress this session's fetches.
WATCHLISTS.forEach(w => { delete w._companiesLoaded; });
syncSidebarUserCard();
// Pull canonical watchlist data from the server. localStorage hydration
// above renders instantly so the user doesn't see an empty list; this
// background sync then reconciles with whatever the server says, so a
// watchlist created on desktop shows up on laptop / mobile / etc. as
// soon as the page loads. First-time migration (one-time push of
// pre-existing local-only watchlists to the server) is handled inside
// the sync function — see syncWatchlistsFromServer for details.
syncWatchlistsFromServer().then(() => {
  // Once the watchlist names + their serverIds are known, pull the COMPANY
  // list for the SELECTED watchlist only via WatchList_AddCompany (input:4).
  // Exactly one company call fires on page load (for the selected watchlist),
  // not one per watchlist. Others load on demand when selected.
  syncSelectedWatchlistCompaniesFromServer();
});

// Boot banner — surfaces the active build marker + watchlist API
// endpoint so the user can verify (without checking View Source) that
// the latest integration is loaded. If this line does NOT appear in
// the dev console on page load, the deployed build is stale (Vercel
// cache or browser disk cache) — hard-refresh (Cmd-Shift-R) to fix.
// eslint-disable-next-line no-console
console.log(
  '%c[Omkara]%c Watchlist API integration active\n' +
  '  Build:    20260619-123730 | watchlist-removecompany-integration\n' +
  '  Watchlist endpoint: POST ' + WATCHLIST_ADD_URL + '\n' +
  '  Company   endpoint: POST ' + WATCHLIST_ADD_COMPANY_URL + ' (input:1 add · input:3 remove · input:4 list)\n' +
  '  Debug:    window.testWatchlistAPI("name") · window.listWatchlistCompanies(<WatchListID>)',
  'background:#E8743B;color:white;padding:2px 6px;border-radius:3px;font-weight:600',
  'color:#6B7280'
);
// Expose a window-level test helper — paste this in the console to
// fire the API on demand and inspect the request in the Network tab.
//   window.testWatchlistAPI('Test from console')
window.testWatchlistAPI = function (name) {
  return createWatchlistOnServer(name || ('Test ' + Date.now().toString(36)));
};

// Fire WatchList_AddCompany (input:4) for a given WatchListID on demand so
// the request + payload are easy to inspect in the Network tab. Example:
//   window.listWatchlistCompanies(175)
window.listWatchlistCompanies = function (watchListId) {
  return loadWatchlistCompaniesFromServer(watchListId).then(rows => {
    // eslint-disable-next-line no-console
    console.log('[Company] input:4 WatchListID=' + watchListId + ' →',
      rows == null ? 'FAILED' : (rows.length + ' unique companies'), rows || '');
    return rows;
  });
};

// Runtime state dumper — paste `window.dumpWatchlistState()` in the
// dev console to see exactly what the client thinks. Useful when the
// UI doesn't match expectations: prints the build marker, the in-
// memory WATCHLISTS array, the tombstones, the rename overrides,
// and the current view/tab so you can confirm whether
// watchlistsChanged is actually reaching the settings-panel render
// branch.
window.dumpWatchlistState = function () {
  // eslint-disable-next-line no-console
  console.group('[Omkara] Watchlist runtime state');
  // eslint-disable-next-line no-console
  console.log('state.view:           ', state.view);
  // eslint-disable-next-line no-console
  console.log('state.settings.tab:   ', state.settings && state.settings.tab);
  // eslint-disable-next-line no-console
  console.log('WATCHLISTS in memory: ', WATCHLISTS.map(w => ({ id: w.id, name: w.name, serverId: w.serverId, isDraft: !!w.isDraft, isPending: !!w.isPending, isSystem: !!w.isSystem, companies: w.companies.length })));
  // eslint-disable-next-line no-console
  console.log('localStorage rows:    ', JSON.parse(localStorage.getItem(WATCHLISTS_STORAGE_KEY) || '[]').map(w => ({ name: w.name, serverId: w.serverId })));
  // eslint-disable-next-line no-console
  console.groupEnd();
  return 'See expanded group above.';
};

(function wireSidebarUserMenu() {
  const btn = document.getElementById('sidebarUserMenu');
  const popup = document.getElementById('sidebarUserPopup');
  if (!btn || !popup) return;

  function close() {
    popup.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function open() {
    popup.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (popup.classList.contains('open')) close();
    else open();
  });

  // Outside-click closes the popup. Click on the button itself is handled
  // above (which stopPropagation), so this only fires when the user clicks
  // anywhere else on the page.
  document.addEventListener('click', e => {
    if (!e.target.closest('.sidebar-user-menu-wrap')) close();
  });

  // Escape closes the popup
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popup.classList.contains('open')) close();
  });

  // Item clicks — Settings navigates to the Settings page; Sign out is
  // stubbed until auth is wired.
  popup.querySelectorAll('.popup-item[data-action]').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      close();
      if (action === 'settings') {
        showView('settings');
      } else {
        // 'signout' — stub until auth is wired
        console.log('[user menu] action:', action);
      }
    });
  });
})();

/* ============================ FAB: back to categories ============================
   A floating button parked at the bottom-right of the viewport. It appears once
   the user has scrolled past the category-pill row and, when clicked, scrolls
   the page back to the pill row so they can pick a different category without
   having to scroll up by hand. Hidden whenever the active tab isn't Corp
   Announcement (the pill row doesn't exist on other tabs). */
document.body.insertAdjacentHTML('beforeend', `
  <!-- WATCHLIST BULK IMPORT MODAL — opened from the Watchlists tab's
       "Bulk import" button. The body has three states (input, importing,
       result) rendered by renderBulkModal(). Always present in the DOM;
       toggled via the hidden attribute. -->
  <div class="wl-bulk-modal" id="wlBulkModal" role="dialog" aria-modal="true" aria-labelledby="wlBulkTarget" hidden>
    <div class="wl-bulk-backdrop"></div>
    <div class="wl-bulk-content">
      <header class="wl-bulk-header">
        <h3>Bulk import to <span id="wlBulkTarget">—</span></h3>
        <button class="wl-bulk-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="wl-bulk-body" id="wlBulkBody"></div>
    </div>
  </div>

  <!-- MANAGEMENT INTERVIEWS MODAL — populated by renderRepVideoModal()
       from state.repVideos. Always present in the DOM; toggled via the
       'hidden' attribute. Clicks on the .rep-video-modal-backdrop or the
       close button trigger closeRepVideoModal(). -->
  <div class="rep-video-modal" id="repVideoModal" role="dialog" aria-modal="true" aria-labelledby="repVideoModalCompany" hidden>
    <div class="rep-video-modal-backdrop"></div>
    <div class="rep-video-modal-content">
      <header class="rep-video-modal-header">
        <div class="rep-video-modal-title">
          <h3 id="repVideoModalCompany">Company</h3>
          <p class="rep-video-modal-sub">Management interview videos · historical</p>
        </div>
        <button class="rep-video-modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="rep-video-modal-body" id="repVideoModalBody"></div>
    </div>
  </div>

  <button class="fab-scroll" id="fabScroll" type="button" aria-label="Back to categories" title="Back to categories">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
  </button>
`);
const fab = document.getElementById('fabScroll');

fab.onclick = () => {
  // On Corp Announcement, the natural scroll target is the category pill row.
  // On Reports, it's the top of the filter card.
  // On Mgmt TV Bytes, it's the top of the .tv-filters card (search + date + pills).
  // On any other tab, fall back to top of page.
  const candidate = document.getElementById('annCatRow')
                 || document.querySelector('.rep-filters')
                 || document.querySelector('.tv-filters');
  const topbar = document.querySelector('.topbar');
  const offset = (topbar ? topbar.offsetHeight : 0) + 12;
  if (candidate) {
    const y = candidate.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};

function updateFabVisibility() {
  // The FAB only belongs on Daily Reading. Settings and Company views are
  // self-contained scrolls with their own tab bars / sub-navigation — a
  // "back to categories" button there would point at Daily Reading's
  // category row from the wrong context. Bail before the per-tab logic
  // so the button can't leak in from a stale state.tab value.
  if (state.view !== 'daily') { fab.classList.remove('visible'); return; }
  // FAB lives on the three tabs that have a top-of-feed filter area worth
  // returning to: Corp Announcement (category pills), Reports (filter card),
  // Mgmt TV Bytes (filter + pills card). Other tabs (e.g. news in future)
  // hide it entirely.
  if (state.tab !== 'announcements' && state.tab !== 'reports' && state.tab !== 'tvbytes') { fab.classList.remove('visible'); return; }
  const target = document.getElementById('annCatRow')
              || document.querySelector('.rep-filters')
              || document.querySelector('.tv-filters');
  if (!target) { fab.classList.remove('visible'); return; }
  const topbar = document.querySelector('.topbar');
  const trigger = topbar ? topbar.offsetHeight : 0;
  fab.classList.toggle('visible', target.getBoundingClientRect().bottom < trigger);
}

window.addEventListener('scroll', updateFabVisibility, { passive: true });
window.addEventListener('resize', updateFabVisibility);

refresh();
// Position the tabs row right under the sticky topbar so it's the first thing
// the user sees. The Watchlists card and the "Daily Reading" title still sit
// in the DOM above; scrolling up reveals them.
//
// This needs to be robust against:
//   1. Browser scroll-restoration (auto-restoring previous session's position)
//   2. The Inter font loading and reflowing all text (FOUT) AFTER our initial
//      scroll fires, which shifts the tabs row down by 10–30px
//   3. Any other late layout shift (slow images, fonts)
// The strategy is: disable browser restoration, then repeatedly re-pin for
// ~1 second, bailing the moment the user interacts so we never fight them.
let _repinUserScrolled = false;
['wheel', 'touchstart', 'pointerdown'].forEach(ev => {
  window.addEventListener(ev, () => { _repinUserScrolled = true; }, { passive: true });
});

function scrollTabsToTop() {
  if (_repinUserScrolled) return;
  const tabs   = document.getElementById('tabs');
  const topbar = document.querySelector('.topbar');
  if (!tabs) return;
  const offset = topbar ? topbar.offsetHeight : 0;
  const y = tabs.getBoundingClientRect().top + window.scrollY - offset;
  if (y > 0) window.scrollTo(0, y);
}

let _repinAttempts = 0;
function pinTabsUntilStable() {
  if (_repinUserScrolled || _repinAttempts >= 15) return;
  _repinAttempts++;
  scrollTabsToTop();
  setTimeout(pinTabsUntilStable, 80);   // 15 × 80ms ≈ 1.2 s of attempts
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
requestAnimationFrame(pinTabsUntilStable);
// Re-pin once everything is loaded, in case font/image loads shift layout.
window.addEventListener('load', () => requestAnimationFrame(scrollTabsToTop));
// Re-pin once the Inter web font finishes loading (this is the most common
// post-load layout shift on this page).
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => requestAnimationFrame(scrollTabsToTop));
}
// Kick off the initial Corp Announcement fetch (this is the default tab).
if (state.tab === 'announcements') loadAnnouncements(false);
// Start the 5-minute auto-refresh + the relative-time caption tick.
startAnnAutoRefresh();

// Initial route — runs last, so showView() (which touches the FAB) is safe.
// A fresh open or "#home" lands on the Daily Reading HOME page; "#settings"
// deep-links to Settings. This also stamps "#home" onto a hash-less URL.
showView(viewForHash(location.hash));

}
