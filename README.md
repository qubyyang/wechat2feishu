# W2F Vault

Self-hosted Wechat2feishu clone for personal use. Paste a WeChat public account article link, clean the article into Markdown, import it into Feishu Docs, and keep a local transfer history.

## Preview

Current web UI running locally:

![W2F Vault web UI](./resources/web.png)

## Setup

1. Fill `.env`:

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_FOLDER_TOKEN=xxx
FEISHU_APP_BASE_URL=https://open.feishu.cn
W2F_HISTORY_PATH=./data/history.json
W2F_CHROME_EXECUTABLE_PATH=
```

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

4. Run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Notes

- No OAuth is used. The app talks to Feishu with `APP_ID` and `APP_SECRET` from `.env`.
- WeChat sometimes returns a safety verification page to server-side fetches. If that happens locally, set `W2F_CHROME_EXECUTABLE_PATH` to a Chrome/Chromium executable path to enable the browser fallback.
- Transfer history is stored locally at `W2F_HISTORY_PATH`.

## Verification

```bash
npm test
npm run build
```
