import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { generateForensicSummary } from './api/_forensicSummary.js';
import { generateForensicFlags } from './api/_forensicFlags.js';

/**
 * Dev-server proxy — this is how API calls are handled "properly" so the
 * browser never makes a cross-origin request and never triggers a CORS
 * preflight. The app fetches RELATIVE paths (/api/... and /occ-api/...),
 * Vite forwards them to the real upstreams server-side, and the responses
 * come back same-origin.
 *
 *   /api/*       ->  https://omkaradata.com/api/*      (main data hub)
 *   /occ-api/*   ->  https://omkaracapital.in/api/*    (TV bytes endpoint)
 *
 * EXCEPTION: /api/forensic-summary is handled LOCALLY by the dev shim below
 * (it must not be proxied to omkaradata.com). In production the same path is
 * served by the serverless function at api/forensic-summary.js.
 *
 * `changeOrigin: true` rewrites the Host header to the target so the
 * upstream sees a request that looks like it came from its own origin.
 *
 * For PRODUCTION you need the equivalent rewrite at your host. On Vercel,
 * add to vercel.json:
 *   { "rewrites": [
 *       { "source": "/api/:path*",     "destination": "https://omkaradata.com/api/:path*" },
 *       { "source": "/occ-api/:path*", "destination": "https://omkaracapital.in/api/:path*" }
 *   ]}
 * (Vercel matches the api/forensic-summary.js function before these rewrites,
 *  so the AI endpoint resolves to the function and everything else proxies to
 *  the data hub. If you front the app with nginx/Cloudflare instead, do the
 *  same path forwarding and route /api/forensic-summary to your function.)
 */

const proxyConfig = {
  '/occ-api': {
    target: 'https://omkaracapital.in',
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/occ-api/, '/api'),
  },
  '/api': {
    target: 'https://omkaradata.com',
    changeOrigin: true,
    secure: true,
  },
};

/**
 * Dev-only middleware that serves the server-side AI endpoints locally using
 * the SAME logic as the production functions. Registered in the configureServer
 * body (no returned function), so it installs BEFORE Vite's internal
 * middlewares — including the proxy — and intercepts these paths before they
 * can be forwarded to omkaradata.com. The Anthropic key is read from the
 * (non-VITE_) env, so it stays server-side and is never bundled into the client.
 *
 *   POST /api/forensic-summary  -> Earning Quality / Fund Flow 2-3 line summary
 *   POST /api/forensic-flags    -> green/red flag cards (structured JSON)
 */
function forensicAIDevPlugin(env) {
  const jsonPost = (run) => (req, res, next) => {
    if (req.method !== 'POST') return next();
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 1000000) req.destroy(); });
    req.on('end', async () => {
      const send = (code, obj) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      try {
        const body = JSON.parse(raw || '{}');
        send(200, await run(body));
      } catch (e) {
        send((e && e.statusCode) || 500, { error: (e && e.message) || 'Internal error' });
      }
    });
  };
  return {
    name: 'omkara-forensic-ai-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/forensic-summary',
        jsonPost((body) => generateForensicSummary(body, env.ANTHROPIC_API_KEY, env.FORENSIC_SUMMARY_MODEL)));
      server.middlewares.use('/api/forensic-flags',
        jsonPost((body) => generateForensicFlags(body, env.ANTHROPIC_API_KEY, env.FORENSIC_FLAGS_MODEL)));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load ALL env vars (empty prefix) so non-VITE_ server secrets like
  // ANTHROPIC_API_KEY are available to the dev shim but NOT exposed to the client.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), forensicAIDevPlugin(env)],
    server: {
      port: 5173,
      open: true,
      proxy: proxyConfig,
    },
    preview: {
      port: 4173,
      proxy: proxyConfig,
    },
  };
});
