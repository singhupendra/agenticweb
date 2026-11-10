import Link from "next/link";
import { WebMcpClient } from "@/app/components/webmcp-client";

export default function WebsiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:ring-2 focus:ring-blue-700">
        Skip to content
      </a>
      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Link href="/" className="rounded font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">Northwind Studio</Link>
          <nav aria-label="Primary">
            <ul className="flex gap-5 text-sm">
              <li><Link className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700" href="/">Home</Link></li>
              <li><Link className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700" href="/services">Services</Link></li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-6 py-10">{children}</main>
      <footer className="border-t border-zinc-200">
        <p className="mx-auto max-w-3xl px-6 py-6 text-sm text-zinc-600">
          Agent-friendly: see <a className="underline" href="/llms.txt">llms.txt</a>.
        </p>
      </footer>
      <WebMcpClient />
    </>
  );
}
