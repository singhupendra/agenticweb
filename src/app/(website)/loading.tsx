export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="animate-pulse space-y-4">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-1/2 rounded bg-zinc-200" />
      <div className="h-4 w-3/4 rounded bg-zinc-200" />
      <div className="h-32 rounded bg-zinc-200" />
    </div>
  );
}
