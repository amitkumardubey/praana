declare module "pino-roll" {
  import type { SonicBoom } from "sonic-boom";

  interface PinoRollLimit {
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  interface PinoRollOptions {
    file: string | (() => string);
    size?: number | string;
    frequency?: number | string;
    extension?: string;
    symlink?: boolean;
    limit?: PinoRollLimit;
    dateFormat?: string;
    mkdir?: boolean;
    sync?: boolean;
  }

  function pinoRoll(options?: PinoRollOptions): Promise<SonicBoom>;
  export = pinoRoll;
}
