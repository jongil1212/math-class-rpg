import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "수학 클래스 RPG",
  description: "교사용 모둠·MP·스킬 관리 웹앱",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
