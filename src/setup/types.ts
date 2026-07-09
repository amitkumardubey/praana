export interface SetupResult {
  success: boolean;
  provider?: string;
  message: string;
}

export interface WriteConfigResult {
  written: boolean;
  path: string;
  message: string;
}
