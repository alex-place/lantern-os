/**
 * Web search endpoint (#2506)
 *
 * GET /api/web-search?q=<query>[&n=<max>]
 *
 * Exposes the same web-search capability the chat/factcheck/grounding paths use
 * (lib/web-search-client → MCP, then direct/wiki/news fallbacks) over HTTP, so the
 * API-keys settings "Test" self-test can genuinely exercise web search instead of
 * hitting a 404 that the client mistook for success.
 *
 * Contract:
 *   200 { query, source, count, results:[{title,url,snippet,...}] }  — search worked
 *   400 { error }                                                     — missing q
 *   502 { error, source? }                                           — search failed/unavailable
 */

const { webSearch } = require('../lib/web-search-client');

module.exports = async function(req, res, url, deps) {
  if (url.pathname === '/api/web-search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) {
      deps.sendJson(res, { error: 'missing query parameter q' }, 400);
      return true;
    }
    const nRaw = parseInt(url.searchParams.get('n'), 10);
    const maxResults = Math.min(Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 5, 10);

    try {
      const r = await webSearch(q, maxResults);
      if (r && r.success) {
        deps.sendJson(res, {
          query: q,
          source: r.source,
          fromCache: !!r.fromCache,
          count: (r.results || []).length,
          results: r.results || [],
        });
      } else {
        // A real failure (all providers down / no results) — report it honestly
        // with a 5xx so the caller's resp.ok check flips the badge to "Error".
        deps.sendJson(res, { error: (r && r.error) || 'web search failed', source: r && r.source }, 502);
      }
    } catch (e) {
      deps.sendJson(res, { error: e && e.message ? e.message : 'web search error' }, 502);
    }
    return true;
  }

  return false;
};
