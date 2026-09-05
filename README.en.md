# W2F Vault

Self-hosted Wechat2feishu tool. Paste a WeChat public account article link, clean the article into Markdown or HTML, import it into Feishu Docs or download it locally; it also supports batch-fetching all published articles of a public account by its ID and packaging them as a Markdown / HTML zip.

中文文档：[README.md](./README.md)

## Description

中文：自托管的微信公众号文章归档工具，支持单篇文章导出 Markdown / HTML、导入飞书文档、提取公众号 ID，并按公众号 ID 批量导出历史文章为 Markdown / HTML zip。

English: A self-hosted WeChat public account article archiver that exports articles to Markdown or HTML, imports them into Feishu Docs, extracts public account IDs, and batch-downloads account articles as Markdown / HTML zip files.

## Screenshot

The local app looks like this:

![W2F Vault screenshot](./resources/web.png)

## Features

- Export a single WeChat public account article to Markdown, HTML, PDF, DOCX or MHTML (the HTML output is a standalone, styled document that opens directly in a browser; PDF, DOCX and MHTML all embed article images, so they render offline).
- Import a single WeChat public account article into Feishu Docs.
- Extract the public account ID (`__biz`) from an article link.
- Batch fetch articles by public account ID and download them as a Markdown / HTML / PDF / DOCX / MHTML zip, or as a single summary CSV manifest.
- Bundle article images into the zip's `assets/` folder and rewrite the body to relative paths (audio/video optional).
- Incremental export: archived articles are tracked per account and skipped on later runs, so WeChat's rate-limited quota is not spent twice.
- List filtering by title keyword, published-date range and original-only, applied before any article body is fetched.
- Live batch export progress: listing, per-article fetching and packaging are reported over SSE and rendered as a progress bar; the finished ZIP is staged server-side and picked up by a second request that consumes it.
- Scheduled incremental archiving: configured accounts are exported at a fixed interval into timestamped ZIPs under `data/archives/`, with per-account status and a manual trigger in the console.
- Full-text search over archives: the index is built during export, Chinese is tokenized with bigrams and terms are combined with AND, so past archives can be searched with snippets straight from the console.
- Resumable export: each finished article is flushed to disk at once, so retrying an interrupted export with the same parameters only fills the gaps and never re-spends WeChat quota on what was already fetched.
- Keep a local transfer history.

## Project Status

This is a self-hosted utility for personal knowledge workflows. WeChat and Feishu web APIs may change; if extraction or import breaks, please open an issue with redacted logs and reproduction steps.

## Setup

1. Fill `.env`:

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_FOLDER_TOKEN=xxx
FEISHU_APP_BASE_URL=https://open.feishu.cn
W2F_HISTORY_PATH=./data/history.json
W2F_CHROME_EXECUTABLE_PATH=
W2F_WECHAT_MP_TOKEN=
W2F_WECHAT_MP_COOKIE=

# Fetch rate limiting. Defaults follow a "better slow than blocked" policy and usually need no changes.
W2F_WECHAT_LIST_INTERVAL_MS=3000      # Interval between article-list pages
W2F_WECHAT_LIST_PAGE_SIZE=5           # Articles per page, 1..20
W2F_WECHAT_ARTICLE_INTERVAL_MS=1200   # Interval between article body fetches
W2F_WECHAT_MAX_RETRIES=3              # Retries after hitting freq control
W2F_WECHAT_RETRY_BASE_MS=6000         # Backoff base; actual wait is base × 2^n

# Asset localization (batch export bundles images into the ZIP's assets/ folder)
W2F_ASSET_INTERVAL_MS=300             # Delay between individual asset downloads
W2F_ASSET_MAX_BYTES=20971520          # Per-asset size cap, 20MB by default; larger files are skipped
W2F_DOWNLOAD_MEDIA=false              # Also download audio/video; images only by default

# Incremental export across runs
W2F_ARCHIVE_INDEX_PATH=./data/archive-index.json  # Archived-article index used to skip duplicates
W2F_EXPORT_JOB_DIR=./data/export-jobs             # Server-side staging dir for streamed export ZIPs
W2F_EXPORT_JOB_TTL_MS=1800000                     # Staged package lifetime; expired ones are swept on the next export

# Scheduled incremental archiving (no built-in cron; an external timer POSTs /api/schedule)
W2F_SCHEDULE_ENABLED=false                        # Master switch; when off a tick only records the check time
W2F_SCHEDULE_ACCOUNTS=                            # Account IDs to archive, separated by commas or spaces
W2F_SCHEDULE_INTERVAL_MS=86400000                 # Minimum gap between two runs of the same account, floor 5 minutes
W2F_SCHEDULE_FORMAT=markdown                      # Archive format; invalid values fall back to markdown
W2F_SCHEDULE_LIMIT=0                              # Max articles per run, 0 means unlimited
W2F_SCHEDULE_ARCHIVE_DIR=./data/archives          # Where archive ZIPs land, filenames carry a timestamp
W2F_SCHEDULE_STATE_PATH=./data/schedule-state.json # Last run time and result per account

# Full-text search over archives (index is written during export; search never re-fetches WeChat)
W2F_SEARCH_INDEX_ENABLED=true                     # Whether batch export writes the search index
W2F_SEARCH_INDEX_PATH=./data/search-index.json    # Index file location

# Resumable export (a retry only fills the gaps)
W2F_CHECKPOINT_ENABLED=true                       # Whether resumable export is enabled
W2F_CHECKPOINT_DIR=./data/checkpoints             # Where checkpoint shards are stored
W2F_CHECKPOINT_TTL_MS=604800000                   # Checkpoint lifetime, 7 days by default
```

## Scheduled Incremental Archiving

Once `W2F_SCHEDULE_ACCOUNTS` is set, a "scheduled archive" panel appears in the console showing each account's last run time, result and consecutive failure count, with a manual "run now" button.

Automatic execution requires an external timer to call the endpoint. The service **deliberately ships no cron daemon**: a Next.js route handler has a completely different lifetime under serverless versus long-running deployments, so an in-process `setInterval` silently disappears when the instance is recycled — and under multi-instance deployment it would hit WeChat concurrently, which is the fastest way to trigger rate limiting.

```bash
# crontab example: check every 10 minutes; whether it actually runs is decided by last-run time + interval
*/10 * * * * curl -s -X POST http://localhost:3000/api/schedule -H 'content-type: application/json' -d '{}'
```

Calling it more often is harmless: accounts that are not due are skipped, and accounts are processed **serially**. Failures also advance the last-run timestamp — rate limiting is the most common failure cause, and retrying tightly only extends the penalty. "No new articles" is recorded as `skipped`, counted as neither success nor failure, and produces no empty package.

## Full-Text Search Over Archives

During batch export, each article's body is also written to `data/search-index.json`, which powers the "archive search" panel in the console. The index is built at export time because the plain text is already in hand — indexing afterwards would mean fetching every article from WeChat again, and that quota is the scarcest resource in this project.

Chinese text is tokenized with **bigrams**: 「公众号文章」becomes 「公众 / 众号 / 号文 / 文章」, and queries are split the same way before intersecting. This recalls arbitrary substrings without shipping a dictionary, while avoiding the single-character approach that would treat 「上海」and 「海上」as equivalent. Multiple query terms are combined with **AND** — archived articles on one topic are highly similar, so OR would drag in weakly related results.

The inverted index is built on demand at query time rather than persisted: the index file already stores the full text, so writing the postings would double its size, while search itself is a low-frequency operation. Each article body is capped at 20,000 characters so a long piece cannot blow up a JSON file that is read and written as a whole.

```bash
curl 'http://localhost:3000/api/search?q=大模型&limit=10'
```

Without `q`, the endpoint returns only the indexed document count and update time per account. A missing or corrupted index degrades to an empty index and never blocks export.

## Resumable Export

When a batch export dies on article 150, the quota spent on the first 149 would normally be wasted — and a rate-limit penalty can last for hours. Resumable export closes that hole: **every finished article is flushed to disk immediately**, rendered output and image bytes included, so a retry replays those shards straight from disk without touching WeChat or waiting on the pacing queue.

Shards go to disk rather than memory because process crashes, container restarts and serverless instance recycling are exactly the failures that kill long-running jobs, and in-memory state does not survive any of them.

The checkpoint ID is derived by hashing account ID + export format + filter, deliberately **deterministic** instead of a random UUID: on retry the user only has those parameters in hand and has no ID to pass. Identical parameters always land on the same checkpoint, while a different format or filter forks naturally, so markdown shards can never be mistaken for pdf output.

To resume, simply run the export again with the **same account ID, format and filter**. The "unfinished exports" panel in the console lists what can be resumed.

```bash
curl http://localhost:3000/api/checkpoint                      # list resumable jobs
curl -X DELETE 'http://localhost:3000/api/checkpoint?checkpointId=<id>'  # discard
```

Checkpoints are cleared automatically once an export succeeds. If a shard file is gone while its state entry remains, that article **falls back to being re-fetched** instead of producing a package with missing images — half a payload is worse than one extra fetch, because the user would get a ZIP that looks complete but is not.

2. In Feishu Open Platform, grant your custom app these permissions:

- `docs:document:import`
- `docs:document.media:upload`
- `drive:drive`

Feishu's `ccm_import_open` upload point may reject app tokens without `drive:drive`, even when the import permission is enabled.

3. Give the app access to the destination folder. With `tenant_access_token`, Feishu requires the app bot to have folder edit permission. The common path is: enable the app bot, add it to a group, share the target folder to that group with edit permission, then put that folder token in `FEISHU_FOLDER_TOKEN`.

To get `FEISHU_FOLDER_TOKEN`, open the target Feishu folder in your browser and copy the token from the URL:

```text
https://xxx.feishu.cn/drive/folder/fldxxxxxxxxxxxxxxxx
                                  ^^^^^^^^^^^^^^^^^^^^
                                  FEISHU_FOLDER_TOKEN
```

The token usually starts with `fld`.

4. Optional: fill WeChat public platform credentials for account batch export.

`W2F_WECHAT_MP_TOKEN` and `W2F_WECHAT_MP_COOKIE` are required only when you want to batch fetch articles by public account ID. Single-article Markdown export and account ID extraction do not require them.

These values come from your own authenticated `mp.weixin.qq.com` session. Treat them like login credentials: do not share them and do not commit them to Git.

### Get W2F_WECHAT_MP_TOKEN on macOS

1. Open [WeChat Official Accounts Platform](https://mp.weixin.qq.com/) in Chrome or Edge.
2. Log in.
3. Check the browser address bar. It usually looks like:

```text
https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=123456789
```

The value after `token=` is `W2F_WECHAT_MP_TOKEN`:

```env
W2F_WECHAT_MP_TOKEN=123456789
```

If the current URL does not include `token`, open another admin page in the platform, such as Content, Drafts, or Home, and check the address bar again. Copy only the value after `token=`, not `token=` itself.

### Get W2F_WECHAT_MP_COOKIE on macOS

1. Keep the logged-in `mp.weixin.qq.com` page open.
2. Press `Command + Option + I` to open DevTools.
3. Open the `Network` panel.
4. Refresh the page.
5. Click any `mp.weixin.qq.com` request, such as `home`, `appmsgpublish`, or `searchbiz`.
6. In `Headers`, find `Request Headers`.
7. Copy the full value after `Cookie:`.

Write it to `.env` without the `Cookie:` prefix:

```env
W2F_WECHAT_MP_COOKIE=ua_id=xxx; wxuin=xxx; mm_lang=zh_CN; ...
```

Keep it on one line. Preserve the semicolons and spaces. The token and cookie expire; if batch export reports an expired login, copy fresh values from the browser.

5. Run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Notes

- No OAuth is used. The app talks to Feishu with `APP_ID` and `APP_SECRET` from `.env`.
- Local export (Markdown / HTML) does not require Feishu credentials. It uses the same WeChat extraction and cleanup pipeline as Feishu import. HTML preserves the original rich-text structure (bold, tables, images) for direct reading; Markdown is better for knowledge-base post-processing.
- Pasting a WeChat article link can extract the public account ID (`__biz`). Short `/s/...` links are fetched once so the ID can be read from the article HTML.
- Batch account export uses WeChat's `appmsgpublish` article-list endpoint, similar to `wechat-article-exporter`. It requires an authenticated `mp.weixin.qq.com` session: copy the `token` query value into `W2F_WECHAT_MP_TOKEN` and the browser request `Cookie` header into `W2F_WECHAT_MP_COOKIE`. These credentials expire and only enable listing article URLs; each article is still converted with the local Markdown pipeline.
- The Feishu transfer button is shown only when `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_FOLDER_TOKEN` are all configured. Otherwise the app stays in local-export mode.
- WeChat sometimes returns a safety verification page to server-side fetches. If that happens locally, set `W2F_CHROME_EXECUTABLE_PATH` to a Chrome/Chromium executable path to enable the browser fallback. If the configured path does not exist, the app prints a warning and falls back to auto-detected browsers.
- Batch export is rate-limited by default: a 3s interval between list pages and a 1.2s interval between article fetches, with automatic exponential backoff on `freq control`. If rate-limited midway through the list, the app returns the articles fetched so far instead of failing the whole batch.
- Transfer history is stored locally at `W2F_HISTORY_PATH`.

## Batch Export Flow

1. Paste any article link from the target public account.
2. Click `提取公众号 ID` to extract the account ID.
3. Confirm that the account ID is filled into the account ID input.
4. Choose an article limit from `1..100`.
5. Click `下载 ZIP`.

The downloaded zip contains:

- `001-title.md`, `002-title.md`, etc. for successfully converted articles.
- `manifest.json` with source URLs and conversion status.
- `_errors.md` when some articles failed because of safety verification, removed articles, or network errors.

## Troubleshooting `freq control`

If batch export fails with `freq control`, WeChat's `/cgi-bin/appmsgpublish` endpoint has hit its rate limit (`ret=200013`). This is a WeChat quota, not a code error. Run the self-check script first to see which case you are in:

```bash
npm run probe:wechat -- MzI3MzYwODk2MQ==
```

The script validates your login session first, then probes the article-list endpoint. There are three outcomes:

| Output | Meaning | Action |
| --- | --- | --- |
| Login invalid, `searchbiz` returns `200003` | Cookie or token has expired | Log in to the platform again and update `W2F_WECHAT_MP_TOKEN` and `W2F_WECHAT_MP_COOKIE` in `.env` |
| Login valid, but `appmsgpublish` returns `200013` | The endpoint's independent quota is exhausted | Wait for cooldown (usually minutes; severe cases last until the next daily quota reset). Do not retry repeatedly |
| Both pass | Normal | Verify with a small `limit` (e.g. 5) first, then increase gradually |

Notes:

- The `appmsgpublish` rate-limit quota is independent of other admin endpoints such as `searchbiz` and `home`, so a valid login does not mean the list endpoint is available.
- Sending more requests during cooldown extends the cooldown. Both the script and the app back off automatically; do not retry manually.
- Larger exports mean more list requests: 100 articles = 20 list requests + 100 article fetches. Export in batches of 20 or fewer.

## Verification

```bash
npm test
npm run build
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

For security issues, follow [SECURITY.md](./SECURITY.md) and report privately instead of opening a public issue.

## License

[MIT](./LICENSE)
