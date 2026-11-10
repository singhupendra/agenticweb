"use client";
import { useEffect } from "react";
import { registerWebMcp, type WebMcpManifest } from "@/agents/discovery/webmcp";

/** Renders nothing. Registers WebMCP tools on mount when the browser supports it; a no-op otherwise. */
export function WebMcpClient({ manifest }: { manifest: WebMcpManifest }) {
  useEffect(
    () =>
      registerWebMcp(
        {
          document: document as unknown as Parameters<typeof registerWebMcp>[0]["document"],
          navigator: navigator as unknown as Parameters<typeof registerWebMcp>[0]["navigator"],
          fetch: (...a) => fetch(...a),
          confirm: (m) => window.confirm(m),
          randomUUID: () => crypto.randomUUID(),
        },
        manifest,
      ),
    [manifest],
  );
  return null;
}
