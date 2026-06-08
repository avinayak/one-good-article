# one-good-article

A Cloudflare Worker. Open it, get 302-redirected to a random *best* Hacker News
article from the last few years. Live at **https://oga.tulv.in**.

A queue of top links is cached in KV so the redirect is a single KV read — no
live API call on the hot path.

## How it works

- **`fetch`** reads the cached queue from KV and 302s to a random entry, then
  fires an async job (`ctx.waitUntil`) to add one fresh article for next time.
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
