---
name: wechat-account-markdown-export
description: Batch export recent articles from a WeChat public account ID as Markdown files in a zip using the W2F local web app.
---

# WeChat Account Markdown Export

Use this skill when a user provides a WeChat public account ID (`__biz`) and asks to batch download that account's articles as Markdown.

## Requirements

- The W2F app must be running locally.
- `.env` must include:
  - `W2F_WECHAT_MP_TOKEN`: the `token` query value from an authenticated `mp.weixin.qq.com` session.
  - `W2F_WECHAT_MP_COOKIE`: the request `Cookie` header from the same authenticated session.

These credentials expire. If the API reports login expiry or article-list failure, refresh them from a current WeChat public platform browser session.

## API

Call the local API:

```bash
curl -X POST http://localhost:3000/api/account-export \
  -H 'content-type: application/json' \
  -d '{"accountId":"Mzk5MDcyODQ2Mw==","limit":20}' \
  --output wechat-account.zip
```

The zip contains:

- `001-title.md`, `002-title.md`, etc. for successfully converted articles.
- `manifest.json` with source URLs and conversion status.
- `_errors.md` when some articles failed because of safety verification, removed articles, or network errors.

The `limit` value is clamped to `1..100`.
