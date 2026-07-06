/**
 * Forensic green / red flag cards — shared server-side logic.
 *
 * Single source of truth for the flag prompt + Anthropic call. Imported by:
 *   • api/forensic-flags.js  — production serverless function (Vercel/Node)
 *   • vite.config.js         — dev-server shim, so `npm run dev` works too
 *
 * Returns STRUCTURED JSON: { flags: [ { metric, type:'green'|'red', statement } ] }.
 * The client buckets each flag into the green or red card. The Anthropic key
 * never reaches the browser. Dependency-free (global fetch, Node 18+).
 *
 * SCOPE (current): Fund Flow table — Cash From Operations(pre tax),
 * Pre tax CFO / EBITDA(%), Free Cash Flow. Each metric is bucketed per period
 * against its threshold (0, or 80% for the ratio); a mixed metric appears in
 * both cards. Add/adjust metrics by editing the SCOPE + rules in the prompt.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5';   // fast + cheap; one-line outputs
const MAX_TABLE_CHARS = 12000;

const SYSTEM_PROMPT = `You are a forensic accounting analyst. From the financial table provided, surface green flags (positive signals) and red flags (mis-accounting risks or weakness), each as ONE concise line that includes the actual numbers. Your output drives two cards on a research dashboard: a green-flag card and a red-flag card.

TABLE FORMAT: tab-separated. The first column is the metric name; the remaining columns are financial years (oldest to latest) followed by trailing 3yrs / 5yrs / 10yrs summary columns (these summary columns are CAGR / Average / Cumulative depending on the table). A "-" means no data.

DATA-GAP GUARD: A summary cell reading 0% (or blank) is a data-feed gap, NOT a real zero. Treat it as MISSING — ignore that period entirely; it never counts as "> 0" or "< 0" and is never cited.

SCOPE: Evaluate ONLY these metrics from the Fund Flow table (ignore every other row): Cash From Operations(pre tax), Pre tax CFO / EBITDA(%), Free Cash Flow. For every one of them, higher is better, and you read the 3yrs, 5yrs and 10yrs summary (Cumulative) columns.

HOW TO FLAG EACH METRIC — look only at its populated 3yr/5yr/10yr (Cumulative) figures (skip any data gap):

Cash From Operations(pre tax):
- Among those populated periods, the ones that are > 0 form a GREEN flag for that metric; the ones that are < 0 form a RED flag for that metric.
- All populated periods > 0 -> one GREEN flag only.
- All populated periods < 0 -> one RED flag only.
- Mixed 3yr/5yr/10yr figures (some > 0 and some < 0) -> BOTH: a GREEN flag citing ONLY the positive periods AND a RED flag citing ONLY the negative periods.
- No populated periods (all gaps) -> no flag for that metric.

Pre tax CFO / EBITDA(%):
- Among those populated periods, the ones that are > 80% form a GREEN flag for that metric; the ones that are < 80% form a RED flag for that metric.
- All populated periods > 80% -> one GREEN flag only.
- All populated periods < 80% -> one RED flag only.
- Mixed 3yr/5yr/10yr figures (some > 80% and some < 80%) -> BOTH: a GREEN flag citing ONLY the >80% periods AND a RED flag citing ONLY the <80% periods.
- No populated periods (all gaps) -> no flag for that metric.

Free Cash Flow:
- Among those populated periods, the ones that are > 0 form a GREEN flag for that metric; the ones that are < 0 form a RED flag for that metric.
- All populated periods > 0 -> one GREEN flag only.
- All populated periods < 0 -> one RED flag only.
- Mixed 3yr/5yr/10yr figures (some > 0 and some < 0) -> BOTH: a GREEN flag citing ONLY the positive periods AND a RED flag citing ONLY the negative periods.
- No populated periods (all gaps) -> no flag for that metric.

So a metric may appear in at most one green flag and at most one red flag.

INTERPRETATION PHRASE (text after the dash — pick the one matching the metric and card):
- Cash From Operations(pre tax) | green: Consistent operating cash generation. | red: Weak cash flows despite profits.
- Pre tax CFO / EBITDA(%)       | green: Strong profit-to-cash conversion.    | red: Poor cash conversion, a long-term red flag.
- Free Cash Flow                | green: Surplus cash post capex, interest, and tax. | red: Cash burn and funding dependence.

STATEMENT FORMAT (one line per flag): start with the metric name and a colon, then cite the relevant period figures WITH their period labels (only the periods that belong to that card — positive periods for a green flag, negative for a red flag), then a dash and the matching interpretation phrase. Use the exact figures from the table. Single sentence, no markdown, no extra commentary.
Examples:
- "Cash From Operations(pre tax): -15.08 (3yr), -15.90 (5yr), -31.16 (10yr) cumulative — weak cash flows despite profits."
- "Pre tax CFO / EBITDA(%): -138.66% (3yr), -45.62% (5yr), -66.35% (10yr) cumulative — poor cash conversion, a long-term red flag."
- "Free Cash Flow: -67.73 (3yr), -78.92 (5yr), -126.27 (10yr) cumulative — cash burn and funding dependence."
Mixed example (e.g. a metric at +6 3yr, -2 5yr, +4 10yr) -> green cites "6 (3yr), 4 (10yr)"; red cites "-2 (5yr)".

OUTPUT: Respond with ONLY valid minified JSON, no markdown fences, no preamble:
{"flags":[{"metric":"Free Cash Flow","type":"red","statement":"..."}]}
If nothing qualifies, return {"flags":[]}. At most one green and one red flag per metric.`;

export function buildUserContent({ company, mode, tab, tableText }) {
  const stmt = mode === 'std' ? 'Standalone' : 'Consolidated';
  return 'Company: ' + (company || 'N/A') + '\n'
    + 'Statement type: ' + stmt + '\n'
    + 'Table: ' + (tab || 'Fund Flow') + '\n\n'
    + 'Table data:\n' + tableText;
}

function safeParseFlags(text) {
  if (!text) return null;
  // Strip accidental ```json fences / preamble, then parse.
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
  let obj;
  try { obj = JSON.parse(s); } catch (_) { return null; }
  if (!obj || !Array.isArray(obj.flags)) return null;
  // Validate + normalise each flag; drop anything malformed.
  const flags = obj.flags
    .filter(f => f && typeof f.statement === 'string' && f.statement.trim()
      && (f.type === 'green' || f.type === 'red'))
    .map(f => ({ metric: String(f.metric || '').trim() || 'Flag', type: f.type, statement: f.statement.trim() }));
  return { flags };
}

export async function generateForensicFlags(body, apiKey, model) {
  const { company, mode, tab, tableText } = body || {};

  if (!apiKey) { const e = new Error('Server is missing ANTHROPIC_API_KEY.'); e.statusCode = 500; throw e; }
  if (!tableText || typeof tableText !== 'string' || !tableText.trim()) {
    const e = new Error('Missing table data.'); e.statusCode = 400; throw e;
  }
  const clipped = tableText.length > MAX_TABLE_CHARS ? tableText.slice(0, MAX_TABLE_CHARS) : tableText;

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 900,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserContent({ company, mode, tab, tableText: clipped }) }],
      }),
    });
  } catch (netErr) {
    const e = new Error('Could not reach the AI service.'); e.statusCode = 502; throw e;
  }

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
    const masked = res.status === 401 || res.status === 403;
    const e = new Error(masked ? 'AI service authentication failed (server config).'
                               : ('AI service error (' + res.status + ')' + (detail ? ': ' + detail : '')));
    e.statusCode = masked ? 500 : 502;
    throw e;
  }

  const data = await res.json();
  const text = Array.isArray(data && data.content)
    ? data.content.filter(b => b && b.type === 'text').map(b => b.text).join('').trim()
    : '';
  const parsed = safeParseFlags(text);
  if (!parsed) { const e = new Error('The AI returned an unparseable flags response.'); e.statusCode = 502; throw e; }
  return { flags: parsed.flags, model: (data && data.model) || model || DEFAULT_MODEL };
}
