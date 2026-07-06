/**
 * POST /api/forensic-summary
 *
 * Production serverless endpoint (Vercel / standard Node handler signature).
 * Holds the Anthropic key server-side and returns a 2-3 line Earning Quality
 * forensic summary. The browser only ever sends the table data + company name.
 *
 * Request  body : { company, mode: 'con'|'std', tab, tableText }
 * Response body : { summary, model }   (or { error } with a non-2xx status)
 *
 * Env: ANTHROPIC_API_KEY (required), FORENSIC_SUMMARY_MODEL (optional).
 *
 * NOTE: this file coexists with the catch-all "/api/:path*" data rewrite to
 * omkaradata.com — Vercel matches filesystem functions BEFORE rewrites, so
 * /api/forensic-summary resolves here while every other /api/* still proxies
 * to the data hub. The dev server replicates this routing (see vite.config.js).
 */
import { generateForensicSummary } from './_forensicSummary.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await generateForensicSummary(
      body,
      process.env.ANTHROPIC_API_KEY,
      process.env.FORENSIC_SUMMARY_MODEL
    );
    res.status(200).json(out);
  } catch (e) {
    res.status((e && e.statusCode) || 500).json({ error: (e && e.message) || 'Internal error' });
  }
}
