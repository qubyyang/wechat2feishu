---
name: wechat-account-markdown-export
description: Batch export recent articles from a WeChat public account ID as Markdown or HTML files in a zip using the W2F local web app.
---

# WeChat Account Batch Export

Use this skill when a user provides a WeChat public account ID (`__biz`) and asks to batch download that account's articles as Markdown or HTML.

## Requirements

- The W2F app must be running locally.
- `.env` must include:
  - `W2F_WECHAT_MP_TOKEN`: the `token` query value from an authenticated `mp.weixin.qq.com` session.
  - `W2F_WECHAT_MP_COOKIE`: the request `Cookie` header from the same authenticated session.

These credentials expire. If the API reports login expiry or article-list failure, refresh them from a current WeChat public platform browser session.

## API

Call the local API. `format` is optional and accepts `"markdown"` (default) or `"html"`:

```bash
curl -X POST http://localhost:3000/api/account-export \
  -H 'content-type: application/json' \
  -d '{"accountId":"Mzk5MDcyODQ2Mw==","limit":20,"format":"html"}' \
  --output wechat-account.zip
```

The zip contains:

- `001-title.md` / `002-title.md` (or `001-title.html` / `002-title.html` when `format` is `html`) for successfully converted articles. HTML files are standalone styled documents that open directly in a browser.
- `manifest.json` with source URLs, conversion status, and the export format.
- `_errors.md` when some articles failed because of safety verification, removed articles, or network errors.

The `limit` value is clamped to `1..100`.
