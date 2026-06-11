import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { HistoryStore } from "@/lib/history";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "w2f-history-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("HistoryStore", () => {
  test("persists records newest first and can clear them", async () => {
    const store = new HistoryStore(join(dir, "history.json"));

    await store.add({
      title: "第一篇",
      sourceUrl: "https://mp.weixin.qq.com/s/a",
      documentUrl: "https://example.feishu.cn/docx/a",
      documentToken: "doc-a",
      status: "success"
    });
    await store.add({
      title: "第二篇",
      sourceUrl: "https://mp.weixin.qq.com/s/b",
      documentUrl: "https://example.feishu.cn/docx/b",
      documentToken: "doc-b",
      status: "success"
    });
    await store.add({
      title: "第三篇",
      sourceUrl: "https://mp.weixin.qq.com/s/c",
      status: "success",
      target: "markdown"
    });

    const records = await store.list();
    expect(records).toHaveLength(3);
    expect(records[0].title).toBe("第三篇");
    expect(records[0].target).toBe("markdown");
    expect(records[1].title).toBe("第二篇");
    expect(records[2].title).toBe("第一篇");
    expect(records[0].createdAt).toMatch(/T/);

    await store.clear();
    await expect(store.list()).resolves.toEqual([]);
  });
});
