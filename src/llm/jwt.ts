/** ChatGPT account id carried in a Codex access token. */

export function extractAccountId(token: string): string {
  let accountId: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error("Malformed JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    throw new Error("OpenAI Codex access token is not a valid JWT; run /login openai-codex again");
  }
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("OpenAI Codex access token missing chatgpt_account_id; run /login openai-codex again");
  }
  return accountId;
}
