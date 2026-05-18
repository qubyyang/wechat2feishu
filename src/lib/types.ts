export type WechatArticle = {
  author?: string;
  html: string;
  publishedAt?: string;
  sourceUrl: string;
  title: string;
};

export type WechatPublishedArticle = {
  cover?: string;
  publishedAt?: string;
  title: string;
  url: string;
};

export type TransferHistoryRecord = {
  createdAt: string;
  documentToken?: string;
  documentUrl?: string;
  error?: string;
  id: string;
  sourceUrl: string;
  status: "failed" | "success";
  target?: "feishu" | "markdown";
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
