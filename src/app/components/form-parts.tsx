import type { FormState } from "@/app/(website)/_actions/bookings";

export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

/** Announced to screen readers when it appears. */
export function FormError({ state, id }: { state: FormState; id?: string }) {
  if (!state.error) return null;
  return (
    <p id={id} role="alert" className="mt-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      {state.error}
    </p>
  );
}

export function Button({ pending, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) {
  return (
    <button
      {...rest}
      disabled={pending || rest.disabled}
      aria-disabled={pending || rest.disabled}
      className={`rounded bg-blue-800 px-4 py-2 text-sm font-medium text-white hover:bg-blue-900 disabled:opacity-60 ${focusRing}`}
    >
      {children}
    </button>
  );
}
