import { safeDocumentTitle, safeMarkdownFilename } from "./safe";

type Fetcher = typeof fetch;

type FeishuClientOptions = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetcher?: Fetcher;
  folderToken?: string;
  pollIntervalMs?: number;
};

type FeishuEnvelope<T> = {
  code: number;
  data?: T;
  msg: string;
};

type TenantTokenResponse = {
  code: number;
  expire: number;
  msg: string;
  tenant_access_token: string;
};

type ImportResult = {
  token: string;
  url: string;
};

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly folderToken: string;
  private readonly pollIntervalMs: number;
  private tokenCache?: { expiresAt: number; value: string };

  constructor(options: FeishuClientOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = options.baseUrl ?? "https://open.feishu.cn";
    this.fetcher = options.fetcher ?? fetch;
    this.folderToken = options.folderToken ?? "";
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
  }

  async importMarkdown(input: {
    markdown: string;
    title: string;
  }): Promise<ImportResult> {
    const token = await this.getTenantAccessToken();
    const fileToken = await this.uploadMarkdown(token, input.title, input.markdown);
    const ticket = await this.createImportTask(token, input.title, fileToken);

    return this.pollImportTask(token, ticket);
  }

  async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.value;
    }

    const response = await this.fetchJson<TenantTokenResponse>(
      "/open-apis/auth/v3/tenant_access_token/internal",
      {
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret
        }),
        headers: {
          "content-type": "application/json; charset=utf-8"
        },
        method: "POST"
      }
    );

    if (response.code !== 0) {
      throw new Error(`飞书 tenant_access_token 获取失败：${response.msg}`);
    }

    this.tokenCache = {
      expiresAt: Date.now() + Math.max(response.expire - 60, 60) * 1000,
      value: response.tenant_access_token
    };

    return response.tenant_access_token;
  }

  private async uploadMarkdown(
    token: string,
    title: string,
    markdown: string
  ): Promise<string> {
    const fileName = safeMarkdownFilename(title);
    const form = new FormData();
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });

    form.append("file_name", fileName);
    form.append("parent_type", "ccm_import_open");
    form.append("parent_node", "/");
    form.append("size", String(Buffer.byteLength(markdown, "utf8")));
    form.append(
      "extra",
      JSON.stringify({ file_extension: "md", obj_type: "docx" })
    );
    form.append("file", blob, fileName);

    const response = await this.fetchJson<
      FeishuEnvelope<{ file_token: string }>
    >(
      "/open-apis/drive/v1/medias/upload_all",
      {
        body: form,
        headers: {
          authorization: `Bearer ${token}`
        },
        method: "POST"
      },
      "上传 Markdown 素材"
    );

    this.assertOk(response, "上传 Markdown 素材失败");

    if (!response.data?.file_token) {
      throw new Error("上传 Markdown 素材失败：飞书没有返回 file_token。");
    }

    return response.data.file_token;
  }

  private async createImportTask(
    token: string,
    title: string,
    fileToken: string
  ): Promise<string> {
    const response = await this.fetchJson<FeishuEnvelope<{ ticket: string }>>(
      "/open-apis/drive/v1/import_tasks",
      {
        body: JSON.stringify({
          file_extension: "md",
          file_name: safeDocumentTitle(title),
          file_token: fileToken,
          point: {
            mount_key: this.folderToken,
            mount_type: 1
          },
          type: "docx"
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8"
        },
        method: "POST"
      },
      "创建飞书导入任务"
    );

    this.assertOk(response, "创建飞书导入任务失败");

    if (!response.data?.ticket) {
      throw new Error("创建飞书导入任务失败：飞书没有返回 ticket。");
    }

    return response.data.ticket;
  }

  private async pollImportTask(
    token: string,
    ticket: string
  ): Promise<ImportResult> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await this.fetchJson<
        FeishuEnvelope<{
          result?: {
            job_error_msg?: string;
            job_status: number;
            token?: string;
            url?: string;
          };
        }>
      >(
        `/open-apis/drive/v1/import_tasks/${ticket}`,
        {
          headers: {
            authorization: `Bearer ${token}`
          },
          method: "GET"
        },
        "查询飞书导入结果"
      );

      this.assertOk(response, "查询飞书导入结果失败");
      const result = response.data?.result;

      if (!result) {
        throw new Error("查询飞书导入结果失败：飞书没有返回 result。");
      }

      if (result.job_status === 0) {
        if (!result.token || !result.url) {
          throw new Error("飞书导入成功但没有返回文档链接。");
        }

        return { token: result.token, url: result.url };
      }

      if (result.job_status !== 1 && result.job_status !== 2) {
        throw new Error(formatImportFailure(result.job_error_msg, result.job_status));
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error("飞书导入仍在处理中，请稍后到飞书云空间查看。");
  }

  private assertOk(response: FeishuEnvelope<unknown>, label: string): void {
    if (response.code !== 0) {
      throw new Error(`${label}：${response.msg}`);
    }
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit,
    label = "飞书接口"
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(`${label}请求失败：HTTP ${response.status} ${text}`);
    }

    return data as T;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatImportFailure(message: string | undefined, status: number): string {
  if (message === "mount_no_permission") {
    return [
      "飞书导入失败：目标文件夹没有授权给当前自建应用。",
      "请确认 FEISHU_FOLDER_TOKEN 是浏览器地址 /drive/folder/ 后面的文件夹 token，",
      "并把该文件夹以“可编辑”权限分享给包含应用机器人的群组。"
    ].join("");
  }

  return `飞书导入失败：${message ?? `状态码 ${status}`}`;
}
