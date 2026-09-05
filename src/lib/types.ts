export type ExportFormat = "html" | "markdown";

export type WechatArticle = {
  author?: string;
  html: string;
  publishedAt?: string;
  sourceUrl: string;
  title: string;
};

/** 已下载到本地、待写入 ZIP 的正文资源 */
export type ArticleAsset = {
  contentType?: string;
  data: Buffer;
  kind: "audio" | "image" | "video";
  /** ZIP 内相对路径，例如 assets/ab12….jpg */
  path: string;
  sourceUrl: string;
};

export type LocalizedArticleAssets = {
  /** 正文引用已改写为 ./assets/… 相对路径的文章 */
  article: WechatArticle;
  assets: ArticleAsset[];
  coverPath?: string;
  failures: Array<{ error: string; url: string }>;
};

export type WechatPublishedArticle = {
  cover?: string;
  /** 列表接口未提供该字段时为 undefined（未知），不等同于「非原创」 */
  isOriginal?: boolean;
  publishedAt?: string;
  title: string;
  url: string;
};

/** 跨次导出去重索引里的一条文章记录 */
export type ArchiveIndexEntry = {
  archivedAt: string;
  filename?: string;
  publishedAt?: string;
  title: string;
  url: string;
};

export type ArchiveIndexFile = {
  accounts: Record<
    string,
    {
      /** key 为文章 URL */
      articles: Record<string, ArchiveIndexEntry>;
      updatedAt: string;
    }
  >;
  version: number;
};

export type TransferHistoryRecord = {
  createdAt: string;
  documentToken?: string;
  documentUrl?: string;
  error?: string;
  id: string;
  sourceUrl: string;
  status: "failed" | "success";
  target?: "feishu" | "html" | "markdown";
  title: string;
};

export type TransferHistoryInput = Omit<
  TransferHistoryRecord,
  "createdAt" | "id"
>;

export type TransferResult = {
  article: WechatArticle;
  documentToken: string;
  documentUrl: string;
  history: TransferHistoryRecord;
};
