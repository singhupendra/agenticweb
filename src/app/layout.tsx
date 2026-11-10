import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export const metadata: Metadata = {
  title: { default: "Northwind Studio — consulting", template: "%s · Northwind Studio" },
  description: "Book expert consulting sessions online. Also available to AI agents via a documented REST API.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
