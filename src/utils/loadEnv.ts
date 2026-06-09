import { existsSync } from "node:fs";
import process from "node:process";

/** Load a local `.env` (the one `.env.example` tells you to copy) into
 *  `process.env` before anything reads provider config.
 *
 *  No-op when the file is missing, so CI and production still run on shell env
 *  alone. Uses Node's built-in dotenv parser (`process.loadEnvFile`, Node 20.12+
 *  / 21.7+); it does NOT overwrite variables already present in the environment,
 *  so an explicit shell `export` / `$env:` — and CI secrets — always win over the
 *  file. A malformed `.env` is swallowed rather than crashing the CLI. */
export function loadLocalEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // Keep running on shell env if the file can't be parsed.
  }
}
