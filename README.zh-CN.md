# W2F Vault

一个可自托管、面向个人使用的 Wechat2feishu 克隆工具。粘贴微信公众号文章链接后，应用会将正文清洗为 Markdown，导入到飞书文档，并在本地保存转存历史。

## 页面预览

当前本地运行界面如下：

![W2F Vault 页面预览](./resources/web.png)

## 环境配置

1. 填写 `.env`：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_FOLDER_TOKEN=xxx
FEISHU_APP_BASE_URL=https://open.feishu.cn
W2F_HISTORY_PATH=./data/history.json
W2F_CHROME_EXECUTABLE_PATH=
```

2. 在飞书开放平台中，为你的自建应用开通以下权限：

- `docs:document:import`
- `docs:document.media:upload`
- `drive:drive`

即使已经开启导入权限，飞书的 `ccm_import_open` 上传端点在缺少 `drive:drive` 时，也可能拒绝 app token 请求。

3. 给应用添加目标文件夹的访问权限。使用 `tenant_access_token` 时，飞书要求应用机器人对目标文件夹有编辑权限。常见做法是：启用应用机器人，将其加入某个群组，把目标文件夹以“可编辑”权限共享给该群组，然后将该文件夹 token 填入 `FEISHU_FOLDER_TOKEN`。

获取 `FEISHU_FOLDER_TOKEN` 的方法：在浏览器打开目标飞书文件夹，从 URL 中复制 token：

```text
https://xxx.feishu.cn/drive/folder/fldxxxxxxxxxxxxxxxx
                                  ^^^^^^^^^^^^^^^^^^^^
                                  FEISHU_FOLDER_TOKEN
```

该 token 通常以 `fld` 开头。

4. 运行：

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 说明

- 不使用 OAuth。应用通过 `.env` 中的 `APP_ID` 和 `APP_SECRET` 与飞书接口通信。
- 微信对服务端抓取请求有时会返回“安全验证”页面。如果你在本地遇到该问题，请将 `W2F_CHROME_EXECUTABLE_PATH` 设置为 Chrome/Chromium 可执行文件路径，以启用浏览器兜底抓取。
- 转存历史保存在本地 `W2F_HISTORY_PATH` 指定的位置。

## 验证

```bash
npm test
npm run build
```
