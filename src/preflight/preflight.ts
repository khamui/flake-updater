import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkEnvironment, type EnvironmentOptions } from "./environment.js";
import { SETUP_HINT, pingSubscription, type PingOptions, type PreflightFailure } from "./subscription.js";

/** systemd `LoadCredential=claude-token:<path>` exposes the token under this name. */
export const CREDENTIAL_NAME = "claude-token";

export interface CredentialSources {
  /** `$CREDENTIALS_DIRECTORY` set by systemd. */
  credentialsDir?: string;
  tokenFile?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN` from the environment (manual runs). */
  envToken?: string;
}

/** The subscription token, from the systemd credential, a token file, or the environment. */
export async function readToken(src: CredentialSources): Promise<string | undefined> {
  const files = [src.credentialsDir && join(src.credentialsDir, CREDENTIAL_NAME), src.tokenFile].filter(Boolean) as string[];
  for (const file of files) {
    try {
      const token = (await readFile(file, "utf8")).trim();
      if (token) return token;
    } catch {
      // try the next source
    }
  }
  return src.envToken?.trim() || undefined;
}

export interface PreflightDeps {
  readToken: () => Promise<string | undefined>;
  ping: (token: string) => Promise<PreflightFailure | null>;
  environment: () => Promise<PreflightFailure | null>;
}

/** Credential, subscription, environment — in that order; the first failure stops it. */
export async function preflight(deps: PreflightDeps): Promise<PreflightFailure | null> {
  const token = await deps.readToken();
  if (!token) return { reason: "no-credential", message: `No subscription token — ${SETUP_HINT}` };
  return (await deps.ping(token)) ?? (await deps.environment());
}

export interface PreflightConfig extends Omit<PingOptions, "token">, EnvironmentOptions {
  credentials: CredentialSources;
}

export function realPreflight(cfg: PreflightConfig): PreflightDeps {
  return {
    readToken: () => readToken(cfg.credentials),
    ping: (token) => pingSubscription({ token, model: cfg.model, executable: cfg.executable, home: cfg.home }),
    environment: () => checkEnvironment(cfg),
  };
}
