import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type FailureReason =
  | "no-credential"
  | "auth"
  | "subscription"
  | "quota"
  | "unreachable"
  | "model"
  | "sdk"
  | "power"
  | "disk"
  | "locked";

export interface PreflightFailure {
  reason: FailureReason;
  /** Shown to the user (notification, shell, status). */
  message: string;
  /** ISO time the quota resets, when known. */
  resetsAt?: string;
}

export const SETUP_HINT = "run `claude setup-token`";

/** Default spec models; the module passes its own. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ESCALATION_MODEL = "claude-opus-5-5";

const failure = (reason: FailureReason, message: string, resetsAt?: string): PreflightFailure =>
  resetsAt ? { reason, message, resetsAt } : { reason, message };

/** `resetsAt` is epoch seconds; tolerate milliseconds. */
function resetTime(resetsAt: number | undefined): string | undefined {
  if (!resetsAt) return undefined;
  return new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt).toISOString();
}

function quota(resetsAt?: string): PreflightFailure {
  return failure("quota", resetsAt ? `Quota exhausted, resets ~${resetsAt}` : "Quota exhausted", resetsAt);
}

const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed|timed? ?out|unable to connect/i;

/** Text of an assistant message, for error details. */
function textOf(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return message.message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

/**
 * Map what one minimal SDK call produced to a preflight failure, or null when
 * the subscription is usable. `thrown` is an exception from the query itself.
 */
export function classifyPing(messages: SDKMessage[], thrown?: unknown): PreflightFailure | null {
  // a rejected subscription rate limit, with its reset time
  const limit = messages
    .filter((m): m is Extract<SDKMessage, { type: "rate_limit_event" }> => m.type === "rate_limit_event")
    .reverse()
    .find((m) => m.rate_limit_info.status === "rejected");

  for (const m of messages) {
    if (m.type !== "assistant" || !m.error) continue;
    const detail = textOf(m);
    switch (m.error) {
      case "authentication_failed":
      case "oauth_org_not_allowed":
      case "verification_required":
      case "cloud_credential_error":
        return failure("auth", `Not logged in or token expired — ${SETUP_HINT}`);
      case "billing_error":
      case "account_on_hold":
        return failure("subscription", "Subscription inactive or not paid");
      case "rate_limit":
        return quota(resetTime(limit?.rate_limit_info.resetsAt));
      case "model_not_found":
      case "invalid_request":
        return failure("model", `Model not usable: ${detail || m.error}`);
      case "max_output_tokens":
        break; // the call worked
      default:
        // overloaded, server_error, unknown
        return failure("unreachable", `Claude API unreachable${detail ? `: ${detail}` : ""}`);
    }
  }
  if (limit) return quota(resetTime(limit.rate_limit_info.resetsAt));

  if (thrown !== undefined) {
    const text = thrown instanceof Error ? thrown.message : String(thrown);
    return NETWORK.test(text)
      ? failure("unreachable", `Claude API unreachable: ${text}`)
      : failure("sdk", `Claude Code could not run: ${text}`);
  }

  const result = messages.find((m): m is Extract<SDKMessage, { type: "result" }> => m.type === "result");
  if (!result) return failure("unreachable", "Claude API unreachable: no result");
  if (result.subtype === "success" && !result.is_error) return null;
  // error_max_turns still means the API answered
  if (result.subtype === "error_max_turns") return null;
  const errors = "errors" in result ? result.errors.join("; ") : "";
  return NETWORK.test(errors) || !errors
    ? failure("unreachable", `Claude API unreachable${errors ? `: ${errors}` : ""}`)
    : failure("sdk", `Claude Code failed: ${errors}`);
}

export interface PingOptions {
  token: string;
  model: string;
  /** Claude Code executable; the package wraps nixpkgs' claude-code. */
  executable?: string;
  /** HOME for Claude Code's own config (the agent's state dir in the unit). */
  home?: string;
}

/** One tiny call on the configured model: no tools, no settings, one turn, nothing persisted. */
export async function pingSubscription(opts: PingOptions): Promise<PreflightFailure | null> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: opts.home ?? process.env.HOME ?? "/tmp",
    CLAUDE_CODE_OAUTH_TOKEN: opts.token,
    CLAUDE_AGENT_SDK_CLIENT_APP: "flake-agent/preflight",
  };
  const options: Options = {
    model: opts.model,
    maxTurns: 1,
    tools: [],
    allowedTools: [],
    settingSources: [],
    persistSession: false,
    // replaces the inherited environment: no ANTHROPIC_API_KEY can shadow the token
    env,
    ...(opts.executable ? { pathToClaudeCodeExecutable: opts.executable } : {}),
  };

  const messages: SDKMessage[] = [];
  try {
    for await (const m of query({ prompt: "Reply with OK.", options })) messages.push(m);
  } catch (err) {
    return classifyPing(messages, err);
  }
  return classifyPing(messages);
}
