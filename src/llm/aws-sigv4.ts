// ============================================================
// PRAANA — Pure Native AWS SigV4 Signer & EventStream Decoder
// Zero AWS SDK Dependencies
// ============================================================

import { createHmac, createHash } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Sign an HTTP request using AWS Signature Version 4 (SigV4).
 */
export function signAwsRequest(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  credentials: AwsCredentials;
}): Record<string, string> {
  const parsedUrl = new URL(opts.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  const canonicalHeadersMap: Record<string, string> = {
    host: parsedUrl.host,
    "x-amz-date": amzDate,
    ...(opts.credentials.sessionToken ? { "x-amz-security-token": opts.credentials.sessionToken } : {}),
  };

  for (const [k, v] of Object.entries(opts.headers)) {
    canonicalHeadersMap[k.toLowerCase()] = v.trim();
  }

  const sortedHeaderKeys = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${canonicalHeadersMap[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const payloadHash = sha256(opts.body);
  const canonicalRequest = [
    opts.method.toUpperCase(),
    parsedUrl.pathname,
    parsedUrl.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.credentials.region}/${opts.credentials.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${opts.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, opts.credentials.region);
  const kService = hmacSha256(kRegion, opts.credentials.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...opts.headers,
    Host: parsedUrl.host,
    "X-Amz-Date": amzDate,
    ...(opts.credentials.sessionToken ? { "X-Amz-Security-Token": opts.credentials.sessionToken } : {}),
    Authorization: authorizationHeader,
  };
}

/**
 * Decode AWS binary EventStream chunk frames into JSON message payloads.
 */
export async function* parseAwsEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = Buffer.concat([buffer, Buffer.from(value)]);

      while (buffer.length >= 16) {
        const totalLength = buffer.readUInt32BE(0);
        if (buffer.length < totalLength) {
          // Wait for full frame
          break;
        }

        const headerLength = buffer.readUInt32BE(4);
        const payloadLength = totalLength - headerLength - 16;
        const payloadStart = 12 + headerLength;
        const payloadBytes = buffer.subarray(payloadStart, payloadStart + payloadLength);

        // Advance buffer past this frame
        buffer = buffer.subarray(totalLength);

        if (payloadBytes.length > 0) {
          try {
            const payloadStr = payloadBytes.toString("utf8");
            const parsed = JSON.parse(payloadStr);
            if (parsed && typeof parsed === "object") {
              yield parsed as Record<string, unknown>;
            }
          } catch {
            // Non-JSON or binary event frame, skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
