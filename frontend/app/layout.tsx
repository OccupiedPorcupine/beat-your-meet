import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beat Your Meet",
  description: "AI-powered meeting bot, Beat, that keeps your meetings on track",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
