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
 * Read AWS event-stream headers. String headers (`:exception-type`,
 * `:message-type`) are the ones drivers use to spot exception frames.
 */
function parseEventStreamHeaders(bytes: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 1 > bytes.length) break;
    const nameLen = bytes.readUInt8(offset);
    offset += 1;
    if (offset + nameLen + 1 > bytes.length) break;
    const name = bytes.subarray(offset, offset + nameLen).toString("utf8");
    offset += nameLen;
    const type = bytes.readUInt8(offset);
    offset += 1;
    if (type === 7) {
      if (offset + 2 > bytes.length) break;
      const valueLen = bytes.readUInt16BE(offset);
      offset += 2;
      if (offset + valueLen > bytes.length) break;
      headers[name] = bytes.subarray(offset, offset + valueLen).toString("utf8");
      offset += valueLen;
      continue;
    }
    if (type === 0 || type === 1) {
      headers[name] = type === 0 ? "true" : "false";
      continue;
    }
    if (type === 6) {
      if (offset + 2 > bytes.length) break;
      const len = bytes.readUInt16BE(offset);
      offset += 2 + len;
      continue;
    }
    const headerValueWidth: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
    const width = headerValueWidth[type] ?? 0;
    if (width === 0) break;
    offset += width;
  }
  return headers;
}

/**
 * Decode AWS binary EventStream chunk frames into JSON message payloads.
 * Exception frames keep `:message-type` and `:exception-type` from the headers.
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
        const headerBytes = buffer.subarray(12, payloadStart);
        const payloadBytes = buffer.subarray(payloadStart, payloadStart + payloadLength);

        // Advance buffer past this frame
        buffer = buffer.subarray(totalLength);

        const headers = parseEventStreamHeaders(headerBytes);
        const payloadStr = payloadBytes.length > 0 ? payloadBytes.toString("utf8") : "";
        let record: Record<string, unknown> | undefined;
        if (payloadStr) {
          try {
            const parsed = JSON.parse(payloadStr);
            if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
          } catch {
            record = undefined;
          }
        }
        const messageType = headers[":message-type"];
        const exceptionType = headers[":exception-type"];
        const errorCode = headers[":error-code"];
        const errorMessage = headers[":error-message"];
        const surfaced = messageType === "error" || exceptionType !== undefined || errorCode !== undefined || errorMessage !== undefined;
        if (!record) {
          if (!surfaced) continue;
          record = {};
          if (payloadStr) record.message = payloadStr;
        }
        const eventType = headers[":event-type"];
        if ((!messageType || messageType === "event") && eventType && !Object.hasOwn(record, eventType)) {
          record = { [eventType]: record };
        }
        if (messageType) record[":message-type"] = messageType;
        if (exceptionType) record[":exception-type"] = exceptionType;
        if (errorCode) record[":error-code"] = errorCode;
        if (errorMessage) record[":error-message"] = errorMessage;
        yield record;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
