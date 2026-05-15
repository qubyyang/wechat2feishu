"use client";

import {
  AlertTriangle,
  Archive,
  Check,
  Circle,
  Clipboard,
  FileText,
  Link2,
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
};

type HistoryRecord = {
  createdAt: string;
  documentUrl?: string;
  error?: string;
  id: string;
  sourceUrl: string;
  status: "failed" | "success";
  title: string;
};

const pipeline = ["抓取正文", "清洗排版", "生成 Markdown", "导入飞书"];

export function TransferConsole() {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [url, setUrl] = useState("");

  const statusLabel = useMemo(() => {
    if (!config) return "检查中";
    if (!config.ready) return ".env 未完成";
    if (!config.folderToken) return "根目录模式";
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
    setPending(true);
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
      setPending(false);
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
              <button
                className="inline-flex h-14 items-center justify-center gap-2 rounded-md bg-ink px-6 text-sm font-semibold text-white shadow-[0_14px_34px_rgba(21,21,21,.24)] transition hover:-translate-y-0.5 hover:bg-[#2b2b2b] disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={pending || !url}
                type="submit"
              >
                {pending ? <Loader2 className="animate-spin" size={18} /> : <Clipboard size={18} />}
                一键转存
              </button>
            </div>
          </form>

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
            </div>
            {!config?.folderToken ? (
              <p className="mt-5 rounded-md bg-white/8 px-3 py-3 text-sm leading-6 text-paper/70 [overflow-wrap:anywhere]">
                未填写文件夹 token 时，飞书会尝试挂载到应用可访问的根位置；失败时请补充
                `FEISHU_FOLDER_TOKEN`。
              </p>
            ) : null}
          </section>

          <section className="min-w-0 rounded-lg border border-black/10 bg-white/56 p-6 shadow-soft backdrop-blur-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">最近归档</h2>
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
                  暂无归档记录
                </div>
              )}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
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
  const content = (
    <div className="min-w-0 rounded-md border border-black/10 bg-[#fbfaf7] px-4 py-3 transition hover:bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{record.title}</p>
          <p className="mt-1 truncate text-xs text-stone-500">
            {new Date(record.createdAt).toLocaleString()}
          </p>
          {record.error ? (
            <p className="mt-2 text-xs leading-5 text-clay [overflow-wrap:anywhere]">
              {record.error}
            </p>
          ) : null}
        </div>
        {record.status === "success" ? (
          <Check className="shrink-0 text-emerald-600" size={18} />
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
