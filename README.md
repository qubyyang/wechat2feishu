# W2F Vault

自托管的 Wechat2feishu 工具。粘贴微信公众号文章链接后，可以清洗正文、生成 Markdown 或 HTML、导入飞书文档，或直接下载到本地；也支持通过公众号 ID 批量获取该账号发布的文章并打包为 Markdown / HTML zip。

English documentation: [README.en.md](./README.en.md)

## Description

中文：自托管的微信公众号文章归档工具，支持单篇文章导出 Markdown / HTML、导入飞书文档、提取公众号 ID，并按公众号 ID 批量导出历史文章为 Markdown / HTML zip。

English: A self-hosted WeChat public account article archiver that exports articles to Markdown, imports them into Feishu Docs, extracts public account IDs, and batch-downloads account articles as Markdown zip files.

## 页面预览

当前本地运行界面如下：

![W2F Vault 页面预览](./resources/web.png)

## 功能

- 单篇公众号文章链接转 Markdown 或 HTML（HTML 为带阅读样式、可直接在浏览器打开的独立文档）。
- 单篇公众号文章导入飞书文档。
- 从公众号文章链接提取公众号 ID（文章 URL 中的 `__biz`）。
- 使用公众号 ID 批量获取文章列表，并将文章内容导出为 Markdown 或 HTML zip。
- 批量导出时把正文图片一并下载进 zip 的 `assets/` 目录，正文改用相对路径引用（音视频可选开启）。
- 增量导出：按公众号维度记录已归档文章，重复导出时自动跳过，避免重复消耗微信频控配额。
- 列表筛选：按标题关键词、发布日期区间、是否原创过滤，筛选发生在抓正文之前。
- 本地保存处理历史。

## 项目状态

这是面向个人知识流的自托管工具。微信和飞书的网页接口可能变化；如果抓取或导入失效，请提交 issue，并附上已脱敏的日志和复现步骤。

## 环境变量

复制 `.env.example` 为 `.env`，然后按需填写：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_FOLDER_TOKEN=xxx
FEISHU_APP_BASE_URL=https://open.feishu.cn
W2F_HISTORY_PATH=./data/history.json
W2F_CHROME_EXECUTABLE_PATH=
W2F_WECHAT_MP_TOKEN=
W2F_WECHAT_MP_COOKIE=

# 抓取限速，默认值已按"宁慢勿封"设定，一般不需要改
W2F_WECHAT_LIST_INTERVAL_MS=3000      # 文章列表分页之间的间隔
W2F_WECHAT_LIST_PAGE_SIZE=5           # 每页条数，1..20
W2F_WECHAT_ARTICLE_INTERVAL_MS=1200   # 逐篇抓取正文之间的间隔
W2F_WECHAT_MAX_RETRIES=3              # 触发频控后的重试次数
W2F_WECHAT_RETRY_BASE_MS=6000         # 退避基数，实际等待为基数 × 2^n

# 正文资源本地化（批量导出时把图片一并打进 ZIP 的 assets/ 目录）
W2F_ASSET_INTERVAL_MS=300             # 资源逐个下载之间的间隔
W2F_ASSET_MAX_BYTES=20971520          # 单个资源体积上限，默认 20MB，超限跳过
W2F_DOWNLOAD_MEDIA=false              # 是否连音频/视频一起下载，默认只下图片

# 跨次增量导出
W2F_ARCHIVE_INDEX_PATH=./data/archive-index.json  # 已归档文章索引，勾选"增量导出"时据此跳过
```

## 获取飞书配置

### 权限

在飞书开放平台中，为你的自建应用开通以下权限：

- `docs:document:import`
- `docs:document.media:upload`
- `drive:drive`

飞书的 `ccm_import_open` 上传点可能会拒绝缺少 `drive:drive` 权限的 app token，即使文档导入权限已经开启。

### 文件夹 Token

应用需要目标文件夹的编辑权限。常见做法是：启用应用机器人，把机器人加入一个群，将目标飞书文件夹共享给该群并授予编辑权限，然后把文件夹 token 填到 `FEISHU_FOLDER_TOKEN`。

打开目标飞书文件夹，复制 URL 中 `/drive/folder/` 后面的部分：

```text
https://xxx.feishu.cn/drive/folder/fldxxxxxxxxxxxxxxxx
                                  ^^^^^^^^^^^^^^^^^^^^
                                  FEISHU_FOLDER_TOKEN
```

这个 token 通常以 `fld` 开头。

## 获取 W2F_WECHAT_MP_TOKEN 和 W2F_WECHAT_MP_COOKIE

这两个值只用于“根据公众号 ID 批量获取文章列表”。单篇文章导出、从文章链接提取公众号 ID 不需要它们。

`W2F_WECHAT_MP_TOKEN` 和 `W2F_WECHAT_MP_COOKIE` 来自你自己的微信公众平台登录态。它们相当于登录凭据，不要发给别人，不要提交到 Git。

### 1. 登录微信公众平台

在 Mac 上用 Chrome 或 Edge 打开：

```text
https://mp.weixin.qq.com/
```

登录你的微信公众平台账号。

### 2. 获取 W2F_WECHAT_MP_TOKEN

登录后，浏览器地址栏通常会出现类似下面的地址：

```text
https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=123456789
```

其中 `token=` 后面的数字就是 `W2F_WECHAT_MP_TOKEN`：

```env
W2F_WECHAT_MP_TOKEN=123456789
```

如果当前地址栏没有 `token`：

1. 点击公众平台左侧任意后台页面，例如“内容与互动”或“草稿箱”。
2. 观察地址栏是否出现 `token=...`。
3. 只复制 `token=` 后面的值，不要复制 `token=` 本身。

### 3. 获取 W2F_WECHAT_MP_COOKIE

1. 在微信公众平台页面按 `Command + Option + I` 打开开发者工具。
2. 切到 `Network` 面板。
3. 刷新页面。
4. 点击任意 `mp.weixin.qq.com` 请求，例如 `home`、`appmsgpublish`、`searchbiz`。
5. 在右侧 `Headers` 中找到 `Request Headers`。
6. 找到 `Cookie`，复制 `Cookie:` 后面的完整值。

写入 `.env` 时不要带 `Cookie:` 这几个字：

```env
W2F_WECHAT_MP_COOKIE=ua_id=xxx; wxuin=xxx; mm_lang=zh_CN; ...
```

注意：

- `W2F_WECHAT_MP_COOKIE` 必须是一整行，不能换行。
- Cookie 中的分号和空格都要保留。
- 不要额外加引号，除非你的 shell 环境明确要求。
- token 和 cookie 会过期。批量导出提示登录过期时，重新复制一次即可。

### 4. 重启本地服务

修改 `.env` 后重启开发服务：

```bash
npm run dev
```

打开：

```text
http://localhost:3000
```

页面右侧运行状态中，`MP Token` 和 `MP Cookie` 都显示 `READY` 后，就可以使用公众号 ID 批量导出。

## 批量导出流程

1. 粘贴任意一篇目标公众号文章链接。
2. 点击“提取公众号 ID”。
3. 确认公众号 ID 自动填入下方输入框。
4. 设置要导出的文章数量，范围是 `1..100`。
5. 选择导出格式（Markdown 或 HTML，与单篇导出共用同一设置）。
6. 点击“下载 ZIP”。

导出的 zip 包包含：

- `001-标题.md`（或 `001-标题.html`）等成功导出的文件，扩展名与所选格式一致。
- `manifest.json`，记录每篇文章的 URL、导出状态与本次导出格式。
- `_errors.md`，当部分文章因安全验证、文章删除或网络错误失败时会生成。

## freq control（频控）排查

批量导出时如果报错 `freq control`，说明微信后台的 `/cgi-bin/appmsgpublish` 接口触发了频率限制（`ret=200013`）。这是微信的配额限制，不是代码异常。先跑自检脚本判断属于哪种情况：

```bash
npm run probe:wechat -- MzI3MzYwODk2MQ==
```

脚本会先校验登录态，再探测文章列表接口，输出分三种：

| 输出 | 含义 | 处理 |
| --- | --- | --- |
| 登录态无效，`searchbiz` 返回 `200003` | cookie 或 token 已失效 | 重新登录后台，更新 `.env` 的 `W2F_WECHAT_MP_TOKEN` 与 `W2F_WECHAT_MP_COOKIE` |
| 登录态有效，但 `appmsgpublish` 返回 `200013` | 该接口的独立配额已耗尽 | 等待冷却（通常数分钟，严重时到次日额度重置），不要反复重试 |
| 两项都通过 | 正常 | 先用小 `limit`（比如 5）验证，再逐步加大 |

注意事项：

- `appmsgpublish` 的频控配额与 `searchbiz`、`home` 等后台接口相互独立，所以登录态有效不代表列表接口可用。
- 频控期间继续发请求会延长冷却时间，脚本与代码都会自动退避，不要手动连点。
- 一次导出篇数越大，列表分页请求越多。100 篇 = 20 次列表请求 + 100 次正文请求，建议分批（20 篇以内）执行。

## 启动

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:3000
```

## 说明

- 不使用 OAuth。飞书导入使用 `.env` 中的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
- 本地 Markdown 导出不需要飞书配置。
- 飞书配置不完整时，页面只启用本地导出（Markdown / HTML）。
- 微信可能向服务端抓取返回安全验证页。遇到这种情况时，可以在 `.env` 中填写 `W2F_CHROME_EXECUTABLE_PATH`，启用浏览器抓取回退。
- 批量导出默认限速：列表分页间隔 3s、正文间隔 1.2s，遇到 `freq control` 自动指数退避重试。列表中途被限流时会返回已抓到的部分文章，而不是整批失败。
- 处理历史保存在 `W2F_HISTORY_PATH`。

## 验证

```bash
npm test
npm run build
```

## 贡献

欢迎提交 issue 和 pull request。提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告，不要公开提交包含 token、cookie 或 app secret 的 issue。

## 开源协议

[MIT](./LICENSE)
