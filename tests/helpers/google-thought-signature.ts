// Synthetic opaque base64, including a detector-shaped substring (not a credential).
export const THOUGHT_SIGNATURE = "AKIAIOSFODNN7EXAMPLE/" + "Ab9+".repeat(80) + "w==";
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export function parallelCallParts() {
  return [
    { functionCall: { name: "read_file", args: { path: "a.txt" }, id: "provider-a" }, thoughtSignature: THOUGHT_SIGNATURE },
    { functionCall: { name: "read_file", args: { path: "b.txt" }, id: "provider-b" } },
  ];
}

export function googleSse(parts: unknown[]): Response {
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
