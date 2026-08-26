import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signAwsRequest, type AwsCredentials } from "./aws-sigv4.js";
import { resolveBedrockBearerToken } from "../bedrock/credentials.js";

export interface AwsSigningKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Resolve SigV4 keys from the standard AWS ambient chain:
 * 1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN)
 * 2. Shared credentials / config files (AWS_PROFILE)
 * 3. Web identity token file (IRSA)
 * 4. ECS/EKS container credentials
 */
export async function resolveAwsSigningCredentials(): Promise<AwsSigningKeys | null> {
  const fromEnv = keysFromEnv();
  if (fromEnv) return fromEnv;

  const fromProfile = keysFromSharedFiles(process.env.AWS_PROFILE?.trim() || "default");
  if (fromProfile) return fromProfile;

  const fromWeb = await keysFromWebIdentity();
  if (fromWeb) return fromWeb;

  const fromContainer = await keysFromContainer();
  if (fromContainer) return fromContainer;

  return null;
}

export async function authorizeAwsRequest(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service?: string;
  bearerToken?: string;
}): Promise<Record<string, string>> {
  const bearer = opts.bearerToken?.trim() || resolveBedrockBearerToken();
  if (bearer) {
    return { ...opts.headers, Authorization: `Bearer ${bearer}` };
  }

  const keys = await resolveAwsSigningCredentials();
  if (!keys) {
    throw new Error(
      "Amazon Bedrock credentials are missing. Set AWS_ACCESS_KEY_ID / AWS_PROFILE / web identity / container role, or a Bedrock API key.",
    );
  }

  const credentials: AwsCredentials = {
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    sessionToken: keys.sessionToken,
    region: opts.region,
    service: opts.service ?? "bedrock",
  };

  return signAwsRequest({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    body: opts.body,
    credentials,
  });
}

function keysFromEnv(): AwsSigningKeys | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
  };
}

function credentialsFilePath(): string {
  return process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(homedir(), ".aws", "credentials");
}

function configFilePath(): string {
  return process.env.AWS_CONFIG_FILE?.trim() || join(homedir(), ".aws", "config");
}

export function keysFromSharedFiles(profile: string): AwsSigningKeys | null {
  const credsIni = parseIniFile(credentialsFilePath());
  const configIni = parseIniFile(configFilePath());
  const section = credsIni[profile] ?? credsIni[`profile ${profile}`];
  const configSection = configIni[profile] ?? configIni[`profile ${profile}`];
  const merged = { ...configSection, ...section };
  const accessKeyId = merged.aws_access_key_id?.trim();
  const secretAccessKey = merged.aws_secret_access_key?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: merged.aws_session_token?.trim() || undefined,
  };
}

function parseIniFile(path: string): Record<string, Record<string, string>> {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, Record<string, string>> = {};
  let current = "default";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const section = trimmed.match(/^\[(.+)\]$/);
    if (section) {
      current = section[1]!.trim();
      if (!out[current]) out[current] = {};
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (!out[current]) out[current] = {};
    out[current][trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

async function keysFromWebIdentity(): Promise<AwsSigningKeys | null> {
  const tokenFile = process.env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
  const roleArn = process.env.AWS_ROLE_ARN?.trim();
  if (!tokenFile || !roleArn) return null;
  if (!existsSync(tokenFile)) return null;

  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;

  const sessionName = process.env.AWS_ROLE_SESSION_NAME?.trim() || "praana";
  const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || "us-east-1";
  const endpoint = `https://sts.${region}.amazonaws.com/`;
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: token,
  }).toString();

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return keysFromStsXml(xml);
  } catch {
    return null;
  }
}

function keysFromStsXml(xml: string): AwsSigningKeys | null {
  const accessKeyId = xml.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1];
  const secretAccessKey = xml.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/)?.[1];
  const sessionToken = xml.match(/<SessionToken>([^<]+)<\/SessionToken>/)?.[1];
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, sessionToken };
}

async function keysFromContainer(): Promise<AwsSigningKeys | null> {
  const relative = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  const url = full || (relative ? `http://169.254.170.2${relative}` : null);
  if (!url) return null;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const auth = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
  if (auth) headers.Authorization = auth;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
    };
    if (!data.AccessKeyId || !data.SecretAccessKey) return null;
    return {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
    };
  } catch {
    return null;
  }
}
