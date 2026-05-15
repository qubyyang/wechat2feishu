import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  description: "Self-hosted WeChat article to Feishu document archiver.",
  title: "W2F Vault"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
