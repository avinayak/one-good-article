/**
 * one-good-article
 *
 * Opening the worker shows a random "best" Hacker News article from the last
 * few years, embedded in an iframe under a black bar (brand left, shuffle
 * right). Shuffling is just a link back to `/`, which serves a fresh random one.
 *
 * The queue is built and refreshed entirely on demand — there is no cron. The
 * hot path is a single KV read (binding `LINKS`, key `QUEUE_KEY`): read the
 * cached queue, render a random entry. Then, asynchronously (via
 * `ctx.waitUntil`, after the response is sent), one fresh article is added to
 * the queue for next time. The queue is a rolling window capped at
 * `QUEUE_LENGTH`, so each visit adds one and drops the oldest.
 *
 * Candidate articles come from HN's Algolia search API (which, unlike the
 * Firebase top/best feeds, can query a historical window): stories from the
 * last `YEARS` years scoring at least `MIN_SCORE` points, top `POOL_SIZE` by
 * score. That pool fetch only happens off the hot path, and is edge-cached, so
 * the per-visit top-up is cheap. All four knobs are set in wrangler.toml.
 */

const QUEUE_KEY = "queue";

const ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search";
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export default {
  /** HTTP entrypoint: redirect to a random cached article, then top up. */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Be a good web citizen.
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Lightweight health/inspection endpoint.
    if (url.pathname === "/queue") {
      const queue = await readQueue(env);
      return Response.json({ length: queue.length, queue });
    }

    let queue = await readQueue(env);

    // Cold cache (fresh deploy, KV wiped): add one synchronously so we can
    // redirect right now. Steady state never hits this branch.
    if (queue.length === 0) {
      queue = await addOne(env, queue);
    }

    if (queue.length === 0) {
      return new Response("No articles cached yet — try again in a moment.", {
        status: 503,
        headers: { "retry-after": "10" },
      });
    }

    const pick = queue[Math.floor(Math.random() * queue.length)];

    // On demand: kick off an async job to add one to the queue for next time.
    // Runs after the response is returned, so it never slows the page load.
    ctx.waitUntil(addOne(env, queue));

    return new Response(renderPage(pick), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Never cache — each load reshuffles to a random article.
        "cache-control": "no-store",
      },
    });
  },
};

/** Escape a string for safe use inside an HTML attribute or text node. */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the viewer: a fixed black top bar (brand left, shuffle right) above a
 * full-bleed iframe of the article. The shuffle link points back to `/`, which
 * serves a fresh random article — no JS required.
 */
function renderPage(pick) {
  const url = escapeHtml(pick.url);
  const title = escapeHtml(pick.title ?? "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oga.tulv.in — one good article</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  #bar {
    height: 44px; box-sizing: border-box; padding: 0 14px;
    background: #000; color: #fff;
    display: flex; align-items: center; justify-content: space-between;
    font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #bar .left { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  #bar .brand { color: #fff; text-decoration: none; letter-spacing: .02em; white-space: nowrap; }
  #bar .title {
    color: #888; font-weight: 400; font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #bar .right { display: flex; align-items: center; gap: 4px; }
  #bar a.icon, #bar a.ext {
    display: inline-flex; align-items: center; justify-content: center;
    color: #fff; text-decoration: none; border-radius: 6px;
  }
  #bar a.icon { width: 32px; height: 32px; }
  #bar a.ext { height: 32px; padding: 0 10px; color: #aaa; font-weight: 400; font-size: 13px; }
  #bar a.icon:hover, #bar a.ext:hover { background: #1c1c1c; color: #fff; }
  #bar a.icon svg { width: 20px; height: 20px; }
  iframe { display: block; border: 0; width: 100%; height: calc(100vh - 44px); background: #fff; }
</style>
</head>
<body>
  <div id="bar">
    <div class="left">
      <a class="brand" href="/">oga.tulv.in</a>
      <span class="title">${title}</span>
    </div>
    <div class="right">
      <a class="ext" href="${url}" target="_blank" rel="noopener noreferrer">open original ↗</a>
      <a class="icon" href="/" title="Shuffle" aria-label="Shuffle to another article">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
      </a>
    </div>
  </div>
  <iframe src="${url}" referrerpolicy="no-referrer-when-downgrade"></iframe>
</body>
</html>`;
}

/** Read and parse the cached queue from KV. Returns [] on miss/parse error. */
async function readQueue(env) {
  const raw = await env.LINKS.get(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Add one fresh article to the queue and persist it. Picks a random article
 * from the best-of-last-N-years pool that isn't already queued, appends it, and
 * trims the queue to a rolling `QUEUE_LENGTH`. Returns the updated queue.
 */
async function addOne(env, queue) {
  const queueLength = positiveInt(env.QUEUE_LENGTH, 50);

  const pool = await fetchPool(env);
  if (pool.length === 0) return queue;

  const queued = new Set(queue.map((it) => it.id));
  const candidates = pool.filter((it) => !queued.has(it.id));
  // If every pool item is already queued, fall back to the whole pool.
  const source = candidates.length > 0 ? candidates : pool;
  const chosen = source[Math.floor(Math.random() * source.length)];

  // Append and keep only the newest `queueLength` entries (rolling window).
  const next = [...queue, chosen].slice(-queueLength);
  await env.LINKS.put(QUEUE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Fetch the candidate pool: best HN stories (with outbound links) from the last
 * `YEARS` years scoring >= `MIN_SCORE`, top `POOL_SIZE` by score. The Algolia
 * response is edge-cached so repeated on-demand top-ups stay cheap.
 */
async function fetchPool(env) {
  const minScore = positiveInt(env.MIN_SCORE, 200);
  const years = positiveInt(env.YEARS, 5);
  // Algolia caps a single page at 1000 hits.
  const poolSize = Math.min(positiveInt(env.POOL_SIZE, 500), 1000);

  const since = Math.floor(Date.now() / 1000) - years * SECONDS_PER_YEAR;

  // Algolia ANDs comma-separated numericFilters.
  const params = new URLSearchParams({
    tags: "story",
    numericFilters: `created_at_i>=${since},points>=${minScore}`,
    hitsPerPage: String(poolSize),
  });

  const res = await fetch(`${ALGOLIA_SEARCH}?${params}`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return [];

  const data = await res.json();
  const hits = Array.isArray(data.hits) ? data.hits : [];

  return hits
    .filter((h) => h && typeof h.url === "string" && h.url.length > 0)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, poolSize)
    .map((h) => ({
      url: h.url,
      title: h.title,
      score: h.points,
      id: h.objectID,
    }));
}

/** Parse a string var into a positive integer, falling back to a default. */
function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
