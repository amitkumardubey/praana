/**
 * Host allow/deny for web_fetch.
 *
 * A rule matches a hostname when the two are equal, or the hostname ends with
 * "." plus the rule (a dot-boundary suffix). `example.com` therefore matches
 * that host and any subdomain, and does not match `notexample.com`. Deny is
 * checked first. A non-empty allow_domains list rejects hosts that match
 * neither list. An empty allow list is not an allowlist: those hosts need a
 * per-session confirmation (or a headless risk allow).
 */

import { displayFetchUrl } from "../../redact/url-query.js";
import type { WebToolsConfig } from "../../types.js";

export const DEFAULT_WEB_CONFIG: WebToolsConfig = {
  enabled: true,
  allow_domains: [],
  deny_domains: [],
  timeout_ms: 15_000,
  max_chars: 20_000,
};

export type WebHostDecision = "deny" | "allow" | "confirm";

export function normalizeHost(host: string): string {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  while (name.endsWith(".")) name = name.slice(0, -1);
  return name;
}

/** Config-file domain rule. A leading "*." is the same suffix match. */
export function normalizeDomainRule(raw: string): string | null {
  let rule = raw.trim().toLowerCase();
  if (rule.startsWith("*.")) rule = rule.slice(2);
  while (rule.startsWith(".")) rule = rule.slice(1);
  while (rule.endsWith(".")) rule = rule.slice(0, -1);
  if (!rule || /[\s/:*]/.test(rule) || rule.includes("://")) return null;
  return rule;
}

export function hostMatchesDomain(host: string, rule: string): boolean {
  const name = normalizeHost(host);
  const domain = normalizeHost(rule);
  if (!name || !domain) return false;
  return name === domain || name.endsWith(`.${domain}`);
}

export function decideWebHost(host: string, config: WebToolsConfig): WebHostDecision {
  if (config.deny_domains.some((rule) => hostMatchesDomain(host, rule))) return "deny";
  if (config.allow_domains.some((rule) => hostMatchesDomain(host, rule))) return "allow";
  if (config.allow_domains.length > 0) return "deny";
  return "confirm";
}

export type RedirectHopDecision =
  | { ok: true }
  | { ok: false; reason: string; redirect_to?: string };

export interface RedirectHopAccess {
  hostRemembered?: (host: string) => boolean;
  headless?: boolean;
  riskAllow?: readonly string[];
}

function redirectRefusal(host: string, target: URL): RedirectHopDecision {
  return {
    ok: false,
    reason: `redirected to ${host}, which is not allowed or not confirmed; call web_fetch again with that URL to confirm it`,
    redirect_to: displayFetchUrl(target.href) ?? target.href,
  };
}

/**
 * Policy for one redirect target. The same host is followed. A different host
 * is followed only when deny does not match, a non-empty allowlist matches,
 * and the host is already confirmed or covered by allow_domains / headless
 * `[risk].allow`. Otherwise the caller must stop before contacting it.
 */
export function createRedirectHopCheck(
  initial: URL,
  config: WebToolsConfig,
  access: RedirectHopAccess,
): (url: URL) => RedirectHopDecision {
  let currentHost = normalizeHost(initial.hostname);
  return (target) => {
    const host = normalizeHost(target.hostname);
    if (host && host === currentHost) return { ok: true };
    const decision = decideWebHost(host, config);
    const remembered = access.hostRemembered?.(host) ?? false;
    const headlessCovered =
      access.headless === true && (access.riskAllow?.includes("web_fetch_host") ?? false);
    if (decision === "deny" || (decision !== "allow" && !remembered && !headlessCovered)) {
      return redirectRefusal(host || "unknown", target);
    }
    currentHost = host;
    return { ok: true };
  };
}

export function hostnameOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalizeHost(url.hostname);
  return host || null;
}
