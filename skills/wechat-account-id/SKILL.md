---
name: wechat-account-id
description: Extract a WeChat public account ID (__biz) from a public account article link using the W2F local web app.
---

# WeChat Account ID Extractor

Use this skill when a user provides a WeChat public account article link and asks for the public account ID.

## Requirements

- The W2F app must be running locally.
- Short `https://mp.weixin.qq.com/s/...` links may require server-side article fetching.

## API

Call the local API:

```bash
curl -X POST http://localhost:3000/api/account-id \
  -H 'content-type: application/json' \
  -d '{"url":"https://mp.weixin.qq.com/s/..."}'
```

The response is:

```json
{
  "accountId": "Mzk5MDcyODQ2Mw=="
}
```

If the link already contains `__biz`, the API returns it directly. Otherwise it fetches the article HTML and reads `var biz` or embedded `__biz` references.
