/**
 * POST /api/forensic-flags
 *
 * Production serverless endpoint (Vercel / standard Node handler). Returns
 * structured green/red flags for the Forensic page cards. The browser only
 * sends the table data + company name; the Anthropic key stays server-side.
 *
 * Request  body : { company, mode: 'con'|'std', tab, tableText }
 * Response body : { flags: [ { metric, type:'green'|'red', statement } ], model }
 *
 * Env: ANTHROPIC_API_KEY (required), FORENSIC_FLAGS_MODEL (optional).
 *
 * Like /api/forensic-summary, this filesystem function is matched before the
 * catch-all "/api/:path*" data rewrite, so it resolves here while every other
 * /api/* still proxies to omkaradata.com. The dev server mirrors this routing.
 */
import { generateForensicFlags } from './_forensicFlags.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await generateForensicFlags(
      body,
      process.env.ANTHROPIC_API_KEY,
      process.env.FORENSIC_FLAGS_MODEL
    );
    res.status(200).json(out);
  } catch (e) {
    res.status((e && e.statusCode) || 500).json({ error: (e && e.message) || 'Internal error' });
  }
}
