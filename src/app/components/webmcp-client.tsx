"use client";
import { useEffect } from "react";
import { detectModelContext, registerWebMcp, type WebMcpEnv, type WebMcpManifest } from "@/agents/discovery/webmcp";

/**
 * Renders nothing. If (and only if) the browser supports WebMCP, fetches the visitor-specific manifest
 * from /webmcp.json (no-store) and registers the tools. Reading the actor server-side in the layout would
 * force every page dynamic, so this happens client-side after mount.
 */
export function WebMcpClient() {
  useEffect(() => {
    const env: WebMcpEnv = {
      document: document as unknown as WebMcpEnv["document"],
      navigator: navigator as unknown as WebMcpEnv["navigator"],
      fetch: (...a) => fetch(...a),
      confirm: (m) => window.confirm(m),
      randomUUID: () => crypto.randomUUID(),
    };
    if (!detectModelContext(env)) return;
    let cleanup: () => void = () => undefined;
    let cancelled = false;
    fetch("/webmcp.json", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<WebMcpManifest>) : null))
      .then((manifest) => {
        if (manifest && !cancelled) cleanup = registerWebMcp(env, manifest);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
  return null;
}
