/**
 * one-good-article
 *
 * Opening the worker 302-redirects you to a random "best" Hacker News article
 * from the last few years.
 *
 * The queue is built and refreshed entirely on demand — there is no cron. The
 * hot path is a single KV read (binding `LINKS`, key `QUEUE_KEY`): read the
 * cached queue, redirect to a random entry. Then, asynchronously (via
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
    // Runs after the response is returned, so it never slows the redirect.
    ctx.waitUntil(addOne(env, queue));

    return new Response(null, {
      status: 302,
      headers: {
        location: pick.url,
        // Never let a CDN/browser cache the redirect — each visit is random.
        "cache-control": "no-store",
      },
    });
  },
};

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
