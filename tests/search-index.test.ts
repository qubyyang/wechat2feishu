import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSnippet,
  emptySearchIndex,
  markdownToSearchText,
  normalizeSearchIndex,
  SEARCH_TEXT_MAX_CHARS,
  SearchIndexStore,
  searchIndex,
  tokenize
} from "../src/lib/search-index";
import type { SearchIndexFile } from "../src/lib/types";

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "w2f-search-"));
});

afterEach(async () => {
  await rm(workDir, { force: true, recursive: true });
});

function makeIndex(): SearchIndexFile {
  return {
    accounts: {
      acc1: {
        documents: {
          "https://example.com/a": {
            indexedAt: "2026-01-02T00:00:00.000Z",
            publishedAt: "2026-01-02",
            text: "本文介绍公众号文章归档的实现细节，包含限速与增量索引。",
            title: "归档实现",
            url: "https://example.com/a"
          },
          "https://example.com/b": {
            indexedAt: "2026-01-01T00:00:00.000Z",
            publishedAt: "2026-01-01",
            text: "这里讨论 Next.js 与 TypeScript 的工程实践。",
            title: "工程实践",
            url: "https://example.com/b"
          }
        },
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    },
    version: 1
  };
}

describe("tokenize", () => {
  it("对 CJK 做二元切分", () => {
    expect(tokenize("公众号")).toEqual(["公众", "众号"]);
  });

  it("单个汉字退化为单字 token", () => {
    expect(tokenize("税")).toEqual(["税"]);
  });

  it("拉丁与数字按连续串小写切分", () => {
    expect(tokenize("Next.js 14")).toEqual(["next", "js", "14"]);
  });

  it("不会把「上海」与「海上」判为等价", () => {
    expect(tokenize("上海")).not.toEqual(tokenize("海上"));
  });
});

describe("searchIndex", () => {
  it("命中标题时得分更高并排在前面", () => {
    const hits = searchIndex(makeIndex(), "归档");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("归档实现");
    expect(hits[0]?.score).toBeGreaterThan(2);
  });

  it("多词之间是 AND 关系", () => {
    expect(searchIndex(makeIndex(), "归档 TypeScript")).toHaveLength(0);
    expect(searchIndex(makeIndex(), "TypeScript 工程")).toHaveLength(1);
  });

  it("空查询返回空结果", () => {
    expect(searchIndex(makeIndex(), "   ")).toEqual([]);
  });

  it("单字查询能召回（二元切分下文档侧无单字 token）", () => {
    const hits = searchIndex(makeIndex(), "档");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("归档实现");
  });

  it("可按公众号过滤并限制条数", () => {
    expect(searchIndex(makeIndex(), "实践", { accountId: "unknown" })).toEqual([]);
    expect(searchIndex(makeIndex(), "的", { limit: 1 })).toHaveLength(1);
  });
});

describe("buildSnippet", () => {
  it("以命中位置为中心截取并加省略号", () => {
    const text = `${"前".repeat(80)}关键词${"后".repeat(80)}`;
    const snippet = buildSnippet(text, "关键词", ["关键", "键词"]);

    expect(snippet).toContain("关键词");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("空正文返回空串", () => {
    expect(buildSnippet("", "x", ["x"])).toBe("");
  });
});

describe("markdownToSearchText", () => {
  it("剥掉代码块、图片与链接语法", () => {
    const text = markdownToSearchText(
      "# 标题\n\n```js\nconst a = 1;\n```\n\n![图](https://x/y.png)\n\n[文档](https://x)正文**加粗**"
    );

    expect(text).toContain("标题");
    expect(text).toContain("文档");
    expect(text).toContain("正文加粗");
    expect(text).not.toContain("const a");
    expect(text).not.toContain("https://x/y.png");
  });

  it("超长正文按上限截断", () => {
    expect(markdownToSearchText("字".repeat(SEARCH_TEXT_MAX_CHARS + 500))).toHaveLength(
      SEARCH_TEXT_MAX_CHARS
    );
  });
});

describe("normalizeSearchIndex", () => {
  it("非法输入退化为空索引", () => {
    expect(normalizeSearchIndex(null)).toEqual(emptySearchIndex());
    expect(normalizeSearchIndex({ accounts: 42 })).toEqual(emptySearchIndex());
  });

  it("补齐缺失字段并以键名回填 url", () => {
    const file = normalizeSearchIndex({
      accounts: { acc1: { documents: { "https://a": { title: "T" } } } }
    });

    expect(file.accounts.acc1?.documents["https://a"]).toMatchObject({
      text: "",
      title: "T",
      url: "https://a"
    });
  });
});

describe("SearchIndexStore", () => {
  it("索引文件缺失时返回空索引", async () => {
    const store = new SearchIndexStore(join(workDir, "missing", "index.json"));

    expect(await store.read()).toEqual(emptySearchIndex());
  });

  it("索引文件损坏时不抛错", async () => {
    const path = join(workDir, "broken.json");
    await writeFile(path, "{not json", "utf8");

    expect(await new SearchIndexStore(path).read()).toEqual(emptySearchIndex());
  });

  it("按 URL 覆盖写入，不产生重复条目", async () => {
    const path = join(workDir, "index.json");
    const store = new SearchIndexStore(path);

    await store.record("acc1", [
      { publishedAt: "2026-01-01", text: "第一版正文", title: "旧标题", url: "https://a" }
    ]);
    await store.record("acc1", [
      { publishedAt: "2026-01-01", text: "第二版正文", title: "新标题", url: "https://a" }
    ]);

    const file = JSON.parse(await readFile(path, "utf8")) as SearchIndexFile;

    expect(Object.keys(file.accounts.acc1?.documents ?? {})).toHaveLength(1);
    expect(file.accounts.acc1?.documents["https://a"]?.title).toBe("新标题");
  });

  it("空文档列表不写文件", async () => {
    const path = join(workDir, "empty.json");
    await new SearchIndexStore(path).record("acc1", []);

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("record 后可检索并统计", async () => {
    const store = new SearchIndexStore(join(workDir, "index.json"));

    await store.record("acc1", [
      { publishedAt: "2026-01-01", text: "限速与增量索引说明", title: "归档实现", url: "https://a" }
    ]);

    const hits = await store.search("增量索引");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.accountId).toBe("acc1");

    const stats = await store.stats();
    expect(stats).toEqual([
      expect.objectContaining({ accountId: "acc1", documentCount: 1 })
    ]);
  });
});
