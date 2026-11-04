/**
 * HTTP status implied by a provider error code or type string.
 * Retry classification uses this status, not the message text.
 */
export function statusForProviderErrorCode(code: unknown): number | undefined {
  if (typeof code !== "string" || code.length === 0) return undefined;
  if (/rate_limit|insufficient_quota/.test(code)) return 429;
  if (/server_error|internal_error/.test(code)) return 500;
  return undefined;
}
