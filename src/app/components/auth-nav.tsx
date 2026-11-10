"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface SessionInfo { authenticated: boolean; csrfToken?: string; role?: string }
const link = "underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700";

/** Sign in / sign out. Server-renders the signed-out link (crawlers, no-JS) and upgrades from /api/auth/session. */
export function AuthNav() {
  const router = useRouter();
  const [s, setS] = useState<SessionInfo>({ authenticated: false });
  useEffect(() => {
    let live = true;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (live && b?.data) setS(b.data as SessionInfo); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": s.csrfToken ?? "" } });
    router.push("/");
    router.refresh(); // drop cached server-rendered state of the signed-in user
  }
  return s.authenticated ? (
    <button type="button" onClick={signOut} data-testid="sign-out" className={link}>Sign out</button>
  ) : (
    <a data-testid="sign-in" className={link} href={`/api/auth/login?returnTo=${encodeURIComponent("/bookings")}`}>Sign in</a>
  );
}
