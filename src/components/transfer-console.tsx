"use client";

import {
  AlertTriangle,
  Archive,
  Check,
  Circle,
  Clipboard,
  Download,
  FileText,
  KeyRound,
  Link2,
  List,
  Loader2,
  LogIn,
  ShieldCheck,
  Sparkles,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type ConfigStatus = {
  appId: boolean;
  appSecret: boolean;
  baseUrl: string;
  folderToken: boolean;
  ready: boolean;
  wechatBatchReady: boolean;
  wechatMpCookie: boolean;
  wechatMpToken: boolean;
};

type HistoryRecord = {
  createdAt: string;
  documentUrl?: string;
  error?: string;
  id: string;
  sourceUrl: string;
  status: "failed" | "success";
  target?: "feishu" | "markdown";
  title: string;
};

type PendingAction = "account-export" | "account-id" | "export" | "transfer";

const pipeline = ["抓取正文", "清洗排版", "生成 Markdown", "归档或导出"];

export function TransferConsole() {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [accountId, setAccountId] = useState("");
  const [accountUrl, setAccountUrl] = useState("");
  const [batchLimit, setBatchLimit] = useState(20);
  const [url, setUrl] = useState("");
  const pending = pendingAction !== null;
  const canTransferToFeishu = Boolean(config?.ready);
  const canBatchExport = Boolean(config?.wechatBatchReady);

  const statusLabel = useMemo(() => {
    if (!config) return "检查中";
    if (!config.ready) return ".env 未完成";
    return "已连接";
  }, [config]);

  async function refresh() {
    const [statusResponse, historyResponse] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/history")
    ]);
    setConfig(await statusResponse.json());
    const historyJson = (await historyResponse.json()) as {
      records: HistoryRecord[];
    };
    setHistory(historyJson.records);
  }

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error instanceof Error ? error.message : "初始化失败");
    });
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canTransferToFeishu) {
      await handleExport();
      return;
    }

    setPendingAction("transfer");
    setMessage("");

    try {
      const response = await fetch("/api/transfer", {
        body: JSON.stringify({ url }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error ?? "转存失败");
      }

      setUrl("");
      setMessage(`已归档：${json.article.title}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "转存失败");
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleExport() {
    setPendingAction("export");
    setMessage("");

    try {
      const response = await fetch("/api/export", {
        body: JSON.stringify({ url }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "导出失败"));
      }

      const blob = await response.blob();
      const filename =
        getFilenameFromDisposition(response.headers.get("content-disposition")) ??
        "微信文章归档.md";
      downloadBlob(blob, filename);
      setMessage(`已导出 Markdown：${filename}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function handleExtractAccountId() {
    setPendingAction("account-id");
    setMessage("");

    try {
      const response = await fetch("/api/account-id", {
        body: JSON.stringify({ url: accountUrl }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const json = (await response.json()) as { accountId?: string; error?: string };

      if (!response.ok || !json.accountId) {
        throw new Error(json.error ?? "公众号 ID 提取失败");
      }

      setAccountId(json.accountId);
      setMessage(`已提取公众号 ID：${json.accountId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公众号 ID 提取失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleBatchExport() {
    setPendingAction("account-export");
    setMessage("");

    try {
      const response = await fetch("/api/account-export", {
        body: JSON.stringify({ accountId, limit: batchLimit }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "批量导出失败"));
      }

      const blob = await response.blob();
      const filename =
        getFilenameFromDisposition(response.headers.get("content-disposition")) ??
        "公众号文章.zip";
      downloadBlob(blob, filename);
      setMessage(`已导出公众号 Markdown 压缩包：${filename}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量导出失败");
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function clearHistory() {
    await fetch("/api/history", { method: "DELETE" });
    await refresh();
  }

  return (
    <main className="min-h-screen bg-[#f4f1ea] text-ink">
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-[-12vw] top-[-16vh] h-[44vh] w-[44vw] rotate-[-12deg] rounded-[45%] bg-[#e5d4be] blur-3xl" />
        <div className="absolute right-[-8vw] top-[12vh] h-[38vh] w-[38vw] rounded-[42%] bg-[#b7d1c4] blur-3xl" />
        <div className="absolute bottom-[-20vh] left-[25vw] h-[42vh] w-[46vw] rounded-[40%] bg-[#e7baa4] blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,.62),rgba(255,255,255,.26))]" />
      </div>

      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-ink text-paper shadow-soft">
            <Archive size={18} />
          </div>
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-stone-500">
              W2F Vault
            </p>
            <h1 className="text-lg font-semibold">Wechat2feishu</h1>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-md border border-black/10 bg-white/45 px-3 py-2 backdrop-blur-xl">
          <span
            className={`h-2 w-2 rounded-full ${
              config?.ready ? "bg-emerald-500" : "bg-clay"
            }`}
          />
          <span className="text-sm font-medium">{statusLabel}</span>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl gap-5 px-6 pb-10 pt-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
        <div className="min-w-0 rounded-lg border border-black/10 bg-white/56 p-6 shadow-soft backdrop-blur-2xl md:p-8">
          <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="mb-3 inline-flex items-center gap-2 rounded-md border border-black/10 bg-paper px-3 py-1 text-sm font-medium text-moss">
                <ShieldCheck size={15} />
                Self-hosted
              </p>
              <h2 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-normal text-[#252525] md:text-7xl">
                把公众号文章沉进飞书。
              </h2>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block text-sm font-semibold text-stone-600" htmlFor="url">
              微信文章链接
            </label>
            <div className="flex flex-col gap-3 rounded-lg border border-black/10 bg-[#fbfaf7] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,.7)] md:flex-row">
              <div className="flex min-h-14 flex-1 items-center gap-3 px-3">
                <Link2 className="shrink-0 text-stone-400" size={20} />
                <input
                  className="h-12 w-full bg-transparent text-base outline-none placeholder:text-stone-400"
                  id="url"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://mp.weixin.qq.com/s/..."
                  value={url}
                />
              </div>
              <div
                className={`grid gap-2 ${
                  canTransferToFeishu ? "md:grid-cols-2" : "md:min-w-44"
                }`}
              >
                {canTransferToFeishu ? (
                  <button
                    className="inline-flex h-14 items-center justify-center gap-2 rounded-md bg-ink px-5 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(21,21,21,.24)] transition hover:-translate-y-0.5 hover:bg-[#2b2b2b] disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-stone-400"
                    disabled={pending || !url}
                    type="submit"
                  >
                    {pendingAction === "transfer" ? (
                      <Loader2 className="animate-spin" size={18} />
                    ) : (
                      <Clipboard size={18} />
                    )}
                    一键转存
                  </button>
                ) : null}
                <button
                  className={`inline-flex h-14 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold shadow-[0_10px_24px_rgba(21,21,21,.08)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed ${
                    canTransferToFeishu
                      ? "border border-black/10 bg-white text-ink hover:border-black/20 hover:bg-paper disabled:bg-stone-100 disabled:text-stone-400"
                      : "bg-ink text-white hover:bg-[#2b2b2b] disabled:bg-stone-400"
                  }`}
                  disabled={pending || !url}
                  onClick={handleExport}
                  type="button"
                >
                  {pendingAction === "export" ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <FileText size={18} />
                  )}
                  导出 Markdown
                </button>
              </div>
            </div>
          </form>

          <section className="mt-7 rounded-lg border border-black/10 bg-[#fbfaf7] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
                  Account batch
                </p>
                <h3 className="mt-1 text-lg font-semibold">公众号批量 Markdown</h3>
              </div>
              <span
                className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${
                  canBatchExport
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-clay/10 text-clay"
                }`}
              >
                <KeyRound size={14} />
                {canBatchExport ? "列表凭据已配置" : "缺少列表凭据"}
              </span>
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(240px,.45fr)]">
              <div className="flex min-h-12 items-center gap-3 rounded-md border border-black/10 bg-white px-3">
                <Link2 className="shrink-0 text-stone-400" size={18} />
                <input
                  className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-stone-400"
                  onChange={(event) => setAccountUrl(event.target.value)}
                  placeholder="粘贴任意一篇公众号文章链接，用于提取 __biz"
                  value={accountUrl}
                />
              </div>
              <button
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-ink transition hover:bg-paper disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                disabled={pending || !accountUrl}
                onClick={handleExtractAccountId}
                type="button"
              >
                {pendingAction === "account-id" ? (
                  <Loader2 className="animate-spin" size={17} />
                ) : (
                  <List size={17} />
                )}
                提取公众号 ID
              </button>
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_120px_minmax(180px,.35fr)]">
              <div className="flex min-h-12 items-center gap-3 rounded-md border border-black/10 bg-white px-3">
                <KeyRound className="shrink-0 text-stone-400" size={18} />
                <input
                  className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-stone-400"
                  onChange={(event) => setAccountId(event.target.value)}
                  placeholder="公众号 ID / __biz，例如 Mzk5MDcyODQ2Mw=="
                  value={accountId}
                />
              </div>
              <input
                className="h-12 rounded-md border border-black/10 bg-white px-3 text-sm outline-none"
                max={100}
                min={1}
                onChange={(event) => setBatchLimit(Number(event.target.value))}
                type="number"
                value={batchLimit}
              />
              <button
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(21,21,21,.12)] transition hover:-translate-y-0.5 hover:bg-[#2b2b2b] disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={pending || !accountId}
                onClick={handleBatchExport}
                type="button"
              >
                {pendingAction === "account-export" ? (
                  <Loader2 className="animate-spin" size={17} />
                ) : (
                  <Download size={17} />
                )}
                下载 ZIP
              </button>
            </div>
          </section>

          {message ? (
            <div className="mt-5 flex min-w-0 items-start gap-3 rounded-md border border-black/10 bg-white/70 px-4 py-3 text-sm text-stone-700">
              {message.includes("失败") || message.includes("请先") ? (
                <AlertTriangle className="mt-0.5 shrink-0 text-clay" size={18} />
              ) : (
                <Check className="mt-0.5 shrink-0 text-emerald-600" size={18} />
              )}
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {message}
              </span>
            </div>
          ) : null}

          <div className="mt-8 grid gap-3 md:grid-cols-4">
            {pipeline.map((item, index) => (
              <div
                className="rounded-md border border-black/10 bg-white/46 px-4 py-3"
                key={item}
              >
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-xs font-semibold text-stone-500">
                    0{index + 1}
                  </span>
                  {pending ? (
                    <Circle className="text-stone-300" size={14} />
                  ) : (
                    <Sparkles className="text-moss" size={14} />
                  )}
                </div>
                <p className="text-sm font-semibold">{item}</p>
              </div>
            ))}
          </div>
        </div>

        <aside className="grid min-w-0 gap-5">
          <section className="min-w-0 rounded-lg border border-black/10 bg-[#20231f] p-6 text-paper shadow-soft">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-semibold">运行状态</h2>
              <LogIn size={18} />
            </div>
            <div className="space-y-3 text-sm">
              <StatusRow active={Boolean(config?.appId)} label="App ID" />
              <StatusRow active={Boolean(config?.appSecret)} label="App Secret" />
              <StatusRow active={Boolean(config?.folderToken)} label="Folder Token" />
              <StatusRow active={Boolean(config?.wechatMpToken)} label="MP Token" />
              <StatusRow active={Boolean(config?.wechatMpCookie)} label="MP Cookie" />
            </div>
            {!config?.ready ? (
              <p className="mt-5 rounded-md bg-white/8 px-3 py-3 text-sm leading-6 text-paper/70 [overflow-wrap:anywhere]">
                飞书配置未完整时仅启用本地 Markdown 导出；填写 `FEISHU_APP_ID`、
                `FEISHU_APP_SECRET` 和 `FEISHU_FOLDER_TOKEN` 后会显示飞书转存。
              </p>
            ) : null}
            {!config?.wechatBatchReady ? (
              <p className="mt-3 rounded-md bg-white/8 px-3 py-3 text-sm leading-6 text-paper/70 [overflow-wrap:anywhere]">
                批量获取公众号文章列表需要 `W2F_WECHAT_MP_TOKEN` 和
                `W2F_WECHAT_MP_COOKIE`；单篇 Markdown 导出不依赖它们。
              </p>
            ) : null}
          </section>

          <section className="min-w-0 rounded-lg border border-black/10 bg-white/56 p-6 shadow-soft backdrop-blur-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">最近处理</h2>
              <button
                className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-white"
                onClick={clearHistory}
                type="button"
              >
                <Trash2 size={15} />
                清空
              </button>
            </div>

            <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
              {history.length ? (
                history.map((record) => <HistoryItem key={record.id} record={record} />)
              ) : (
                <div className="rounded-md border border-dashed border-black/15 px-4 py-8 text-center text-sm text-stone-500">
                  暂无处理记录
                </div>
              )}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

async function readErrorMessage(response: Response, fallback: string) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? fallback;
}

function getFilenameFromDisposition(value: string | null) {
  if (!value) return null;

  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  return value.match(/filename="([^"]+)"/i)?.[1] ?? null;
}

function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function StatusRow({ active, label }: { active: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-white/10 bg-white/6 px-3 py-3">
      <span>{label}</span>
      <span
        className={`inline-flex items-center gap-2 text-xs font-semibold ${
          active ? "text-emerald-300" : "text-clay"
        }`}
      >
        {active ? <Check size={14} /> : <AlertTriangle size={14} />}
        {active ? "READY" : "EMPTY"}
      </span>
    </div>
  );
}

function HistoryItem({ record }: { record: HistoryRecord }) {
  const targetLabel = record.target === "markdown" ? "本地 Markdown" : "飞书文档";
  const StatusIcon =
    record.status === "success" && record.target === "markdown" ? FileText : Check;
  const content = (
    <div className="min-w-0 rounded-md border border-black/10 bg-[#fbfaf7] px-4 py-3 transition hover:bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{record.title}</p>
          <p className="mt-1 truncate text-xs text-stone-500">
            {targetLabel} · {new Date(record.createdAt).toLocaleString()}
          </p>
          {record.error ? (
            <p className="mt-2 text-xs leading-5 text-clay [overflow-wrap:anywhere]">
              {record.error}
            </p>
          ) : null}
        </div>
        {record.status === "success" ? (
          <StatusIcon className="shrink-0 text-emerald-600" size={18} />
        ) : (
          <AlertTriangle className="shrink-0 text-clay" size={18} />
        )}
      </div>
    </div>
  );

  if (record.documentUrl) {
    return (
      <a href={record.documentUrl} rel="noreferrer" target="_blank">
        {content}
      </a>
    );
  }

  return content;
}
