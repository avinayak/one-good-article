# one-good-article

A Cloudflare Worker. Open it to read a random *best* Hacker News article from
the last few years, embedded in an iframe under a black bar — `oga.tulv.in` on
the left, a shuffle icon on the right. Live at **https://oga.tulv.in**.

A queue of top links is cached in KV so each load is a single KV read — no live
API call on the hot path.

Articles are embedded through a same-origin proxy (`/read?u=...`) that strips
`X-Frame-Options` / CSP `frame-ancestors` and injects a `<base>` tag, so sites
that normally refuse to be framed still render.

> Note: the proxy can't help with sites behind a JS bot-challenge (e.g.
> Cloudflare's "Just a moment…"), hard SPAs, or login walls — a server-side
> fetch never gets the real page. The bar's "open original ↗" link is the
> fallback for those.

## How it works

- **`fetch`** reads the cached queue from KV and renders a random entry in the
  viewer, then fires an async job (`ctx.waitUntil`) to add one fresh article for
  next time. The shuffle icon / brand link point back to `/` for a new article.
  The queue is a rolling window capped at `QUEUE_LENGTH`: each visit adds one and
  drops the oldest. **No cron** — the queue is built and refreshed purely on
  demand, by usage.
- A cold/empty cache adds one article synchronously so the first visit still
  redirects.
- **`/queue`** returns the current cached queue as JSON, for inspection.

Candidate articles come from HN's [Algolia search API](https://hn.algolia.com/api)
(it can query a historical window, which the Firebase top/best feeds can't):
stories from the last `YEARS` years scoring `>= MIN_SCORE`, top `POOL_SIZE` by
score. That pool fetch happens only off the hot path and is edge-cached, so the
per-visit top-up is cheap.

## Configuration (`wrangler.toml`)

| Var            | Meaning                                                   | Default |
| -------------- | --------------------------------------------------------- | ------- |
| `QUEUE_LENGTH` | Rolling queue size the redirect picks from                | `50`    |
| `MIN_SCORE`    | Minimum HN points to qualify as "best"                    | `200`   |
| `YEARS`        | How far back to look                                      | `5`     |
| `POOL_SIZE`    | Candidate pool the on-demand top-up samples (max 1000)    | `500`   |

## Setup

```sh
npm install

# KV namespace `oga_links` is already wired into wrangler.toml.
# (To recreate: npx wrangler kv namespace create oga_links)

npm run dev      # run locally
npm run deploy   # deploy
npm run tail     # stream live logs
```
