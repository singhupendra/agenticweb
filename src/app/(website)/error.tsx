"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-zinc-700">We couldn&apos;t load this page. Please try again.</p>
      <button type="button" onClick={reset} className="mt-4 rounded bg-blue-800 px-4 py-2 text-sm font-medium text-white hover:bg-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
        Try again
      </button>
    </div>
  );
}
