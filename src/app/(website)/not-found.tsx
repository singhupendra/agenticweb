import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-zinc-700">We couldn&apos;t find what you were looking for.</p>
      <p className="mt-4"><Link className="underline" href="/services">Browse services</Link></p>
    </>
  );
}
