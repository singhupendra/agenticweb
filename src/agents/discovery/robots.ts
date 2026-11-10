/**
 * robots.txt generator. robots.txt is a voluntary, advisory convention for well-behaved crawlers.
 * It is NOT access control or security: private data is protected by authentication/authorization, never by this file.
 */
import { PRIVATE_PATHS } from "./content";

/** Classic search engine crawlers: allowed on public pages. */
export const SEARCH_CRAWLERS = ["Googlebot", "Bingbot", "DuckDuckBot"] as const;
/** AI assistants fetching a page on behalf of a user request (not for training): allowed on public pages. */
export const AI_USER_AGENTS = ["ChatGPT-User", "OAI-SearchBot", "Claude-User", "Claude-SearchBot", "Perplexity-User"] as const;
/** Crawlers collecting training data: disallowed by default. Edit this policy deliberately. */
export const AI_TRAINING_CRAWLERS = ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Applebot-Extended"] as const;

const group = (agents: readonly string[], rules: string[]) => [...agents.map((a) => `User-agent: ${a}`), ...rules].join("\n");
const publicRules = ["Allow: /", ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`)];

export function renderRobotsTxt(o: { baseUrl: string }): string {
  return [
    "# robots.txt is advisory only. It is not a security control; protected resources require authentication.",
    "# Policy: search engines and user-initiated AI agents may read public pages; AI training crawlers may not.",
    "# Machine-readable overview: /llms.txt",
    group(["*"], publicRules),
    group(SEARCH_CRAWLERS, publicRules),
    group(AI_USER_AGENTS, publicRules),
    group(AI_TRAINING_CRAWLERS, ["Disallow: /"]),
    `Sitemap: ${o.baseUrl.replace(/\/$/, "")}/sitemap.xml`,
  ].join("\n\n") + "\n";
}
