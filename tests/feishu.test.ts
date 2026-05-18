import { describe, expect, test } from "vitest";

import { FeishuClient } from "@/lib/feishu";

describe("FeishuClient", () => {
  test("imports markdown through tenant token, upload, import task, and polling", async () => {
    const calls: Array<{ body?: unknown; method?: string; url: string }> = [];

    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ body, method, url });

      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return Response.json({
          code: 0,
          msg: "ok",
          tenant_access_token: "tenant-token",
          expire: 7200
        });
      }

      if (url.endsWith("/drive/v1/medias/upload_all")) {
        return Response.json({
          code: 0,
          msg: "success",
          data: { file_token: "box-file-token" }
        });
      }

      if (url.endsWith("/drive/v1/import_tasks") && method === "POST") {
        return Response.json({
          code: 0,
          msg: "success",
          data: { ticket: "ticket-1" }
        });
      }

      if (url.endsWith("/drive/v1/import_tasks/ticket-1")) {
        return Response.json({
          code: 0,
          msg: "success",
          data: {
            result: {
              ticket: "ticket-1",
              type: "docx",
              job_status: 0,
              job_error_msg: "success",
              token: "doc-token",
              url: "https://example.feishu.cn/docx/doc-token"
            }
          }
        });
      }

      return Response.json({ code: 404, msg: "unexpected" }, { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_test",
      appSecret: "secret",
      baseUrl: "https://open.feishu.cn",
      fetcher,
      folderToken: "folder-token",
      pollIntervalMs: 0
    });

    const result = await client.importMarkdown({
      markdown: "# 文章标题\n\n正文",
      title: "文章标题"
    });

    expect(result).toEqual({
      token: "doc-token",
      url: "https://example.feishu.cn/docx/doc-token"
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/drive/v1/medias/upload_all",
      "https://open.feishu.cn/open-apis/drive/v1/import_tasks",
      "https://open.feishu.cn/open-apis/drive/v1/import_tasks/ticket-1"
    ]);
    expect((calls[1].body as FormData).get("parent_type")).toBe(
      "ccm_import_open"
    );
    expect((calls[1].body as FormData).get("parent_node")).toBe("/");
    expect((calls[1].body as FormData).get("extra")).toBe(
      JSON.stringify({ file_extension: "md", obj_type: "docx" })
    );
    expect(calls[2].body).toMatchObject({
      file_extension: "md",
      file_name: "文章标题",
      file_token: "box-file-token",
      point: { mount_key: "folder-token", mount_type: 1 },
      type: "docx"
    });
  });
});
