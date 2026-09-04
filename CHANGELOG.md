# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Added asset localization for account batch export. Article images (and optionally `mpvoice` audio / `mpvideo` video) are downloaded into an `assets/` folder inside the ZIP, and the exported Markdown/HTML references them via relative `./assets/...` paths. Downloads are serialized through the shared pacing helpers, deduplicated by URL hash across articles, and capped per file; failures degrade to keeping the original remote URL. New env vars: `W2F_ASSET_INTERVAL_MS`, `W2F_ASSET_MAX_BYTES`, `W2F_DOWNLOAD_MEDIA`.
- Added HTML as an export format for both single-article export and account batch export. The HTML output is a standalone, styled document; the format is shared by both export paths and recorded in `manifest.json`.

## 0.1.0 - 2026-05-17

- Added single WeChat article export to Markdown.
- Added optional Feishu Docs import.
- Added public account ID extraction from WeChat article links.
- Added public account batch export to Markdown zip.
- Added local transfer history.
- Added Codex skills for account ID extraction and batch Markdown export.
