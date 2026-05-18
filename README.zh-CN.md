# W2F Vault

自托管的 Wechat2feishu 工具。粘贴微信公众号文章链接后，可以清洗正文、生成 Markdown、导入飞书文档，或直接下载到本地；也支持通过公众号 ID 批量获取该账号发布的文章并打包为 Markdown zip。

## 功能

- 单篇公众号文章链接转 Markdown。
- 单篇公众号文章导入飞书文档。
- 从公众号文章链接提取公众号 ID（文章 URL 中的 `__biz`）。
- 使用公众号 ID 批量获取文章列表，并将文章内容导出为 Markdown zip。
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
5. 点击“下载 ZIP”。

导出的 zip 包包含：

- `001-标题.md`、`002-标题.md` 等成功导出的 Markdown 文件。
- `manifest.json`，记录每篇文章的 URL 和导出状态。
- `_errors.md`，当部分文章因安全验证、文章删除或网络错误失败时会生成。

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
- 飞书配置不完整时，页面只启用本地 Markdown 导出。
- 微信可能向服务端抓取返回安全验证页。遇到这种情况时，可以在 `.env` 中填写 `W2F_CHROME_EXECUTABLE_PATH`，启用浏览器抓取回退。
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
