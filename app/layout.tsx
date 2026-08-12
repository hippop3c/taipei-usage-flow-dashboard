import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "雙北使用熱力圖",
  description: "依月份、日期、平假日與每小時查看雙北交易筆數、多日期平均及場站起訖關係。",
  openGraph: {
    title: "雙北使用熱力圖",
    description: "依月份、日期、平假日與每小時查看雙北交易筆數及場站起訖關係。",
    images: [{ url: "/social-preview.png", width: 1659, height: 948 }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b3954",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
