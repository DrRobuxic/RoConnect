// Optional minimal proxy for Roblox Friend Analyzer (Cloudflare Worker).
//
// Why this exists: Roblox's web APIs often refuse requests that come from other websites
// (a browser rule called CORS). This Worker fetches the same PUBLIC, read-only data
// on your behalf and adds the header the browser needs.
//
// It only accepts GET requests, only for the five Roblox hosts below, and never forwards
// cookies or any credentials.
//
// Deploy: dash.cloudflare.com > Workers & Pages > Create > Hello World > Edit code >
// paste this file > Deploy. Then paste the *.workers.dev address into "Proxy settings"
// on the site.

const ALLOWED_HOSTS = new Set(["users", "friends", "thumbnails", "avatar", "economy"]);

// Recommended: lock this to your own site, e.g. "https://yourname.github.io"
const ALLOWED_ORIGIN = "*";

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Access-Control-Expose-Headers": "Retry-After",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

    // Request looks like: https://your-worker.workers.dev/<host>/v1/users/123
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/([a-z]+)(\/v\d+\/.*)$/);
    if (!m || !ALLOWED_HOSTS.has(m[1])) {
      return new Response(JSON.stringify({ error: "Host or path not allowed" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let upstream;
    try {
      upstream = await fetch(`https://${m[1]}.roblox.com${m[2]}${url.search}`, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (RobloxFriendAnalyzer)" },
        cf: { cacheTtl: 30, cacheEverything: false },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream unreachable" }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const headers = { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" };
    const retry = upstream.headers.get("Retry-After");
    if (retry) headers["Retry-After"] = retry;
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
