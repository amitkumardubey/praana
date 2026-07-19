export interface SetupResult {
  success: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  keySaved?: boolean;
  message: string;
}

export interface WriteConfigResult {
  written: boolean;
  path: string;
  message: string;
}

/** Configuration for a custom OpenAI-compatible provider (wizard flow). */
export interface CustomProviderConfig {
  id: string;
  api: string;
  baseUrl: string;
  envKey?: string;
}
