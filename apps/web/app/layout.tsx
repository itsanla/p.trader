import type { Metadata } from "next";
import { Karla, Syne } from "next/font/google";
import "./globals.css";

const display = Syne({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-display" });
const body = Karla({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Trader — AI Crypto Agent",
  description: "Dashboard agen trading kripto otomatis: ringkasan wallet & kontrol bot.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" className={`${display.variable} ${body.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <div className="app-ambient" aria-hidden="true" />
        <main className="mx-auto w-full max-w-5xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
