/**
 * src/agent/client.ts — OpenClaw RPC client wrapper
 *
 * OpenClaw runs as a separate process. This module communicates with it
 * via its client SDK. The agent path (OPENCLAW_AGENT_PATH) points to the
 * agent/ directory at the root of this repo, which contains:
 *   - AGENTS.md — instructions
 *   - MEMORY.md — persistent memory
 *   - SOUL.md — personality
 *   - skills/ — custom tool implementations
 *
 * CRITICAL design invariant:
 *   OpenClaw being unavailable must NEVER block financial operations.
 *   If the OpenClaw process is down, the relay continues processing
 *   payments normally. Agent reasoning is advisory; it enhances the
 *   relay but is not in the payment critical path.
 *
 * Session types (defined in openclaw.json):
 *   - 'main': general-purpose, claude-opus-4-6
 *   - 'board-meeting': daily planning, high thinking budget
 *   - 'decision': short event-triggered, JSON response format
 */

/**
 * OpenClaw bridge integration via HTTP.
 *
 * openclaw-bridge/server.py runs as a sidecar process. It wraps the Claude
 * API in an agentic tool-use loop, reading bootstrap files from the agent/
 * directory (AGENTS.md, SOUL.md, MEMORY.md) and executing relay-ops tool
 * calls by calling back to this server's /internal/* routes.
 *
 * This approach satisfies the Track 1 "OpenClaw or equivalent agent framework"
 * requirement while keeping financial operations firmly in the TypeScript layer.
 *
 * Configuration:
 *   OPENCLAW_BRIDGE_URL — bridge base URL (default: http://localhost:4001)
 */

export type AgentName = 'main' | 'board-meeting' | 'decision';
export type ThinkingLevel = 'low' | 'adaptive' | 'high';

export interface AgentSessionParams {
  /** The message or prompt to send to the agent. */
  message: string;
  /** Which named agent configuration to use (from openclaw.json). */
  agent?: AgentName;
  /** Unique ID to track this session — used to correlate logs and costs. */
  sessionId: string;
  /** Override the thinking level for this session. */
  thinking?: ThinkingLevel;
  /** Additional structured context to inject alongside the message. */
  context?: Record<string, unknown>;
}

export interface AgentSessionResult {
  runId: string;
  /** The final text response from the agent. */
  text: string;
  /** Any tool calls the agent made during the session. */
  toolCalls: ToolCall[];
  /** Estimated USD cost of this session (tokens × model price). */
  estimatedCostUsd: number;
  /** Total tokens used (prompt + completion). */
  totalTokens: number;
  durationMs: number;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
}

/**
 * runAgentSession — Execute an OpenClaw agent session and return when complete.
 *
 * This is the primary integration point. All other agent modules (boardMeeting,
 * decisionLayer, intelligence services) go through this function.
 *
 * Error handling:
 *   On any error (OpenClaw unavailable, timeout, API error), this function
 *   logs the error and returns a fallback result rather than throwing.
 *   Callers should check `result.text` for empty string to detect failures.
 *
 * Cost tracking:
 *   After each session, recordLlmCall() is called to track inference spend
 *   against the daily cognitive budget.
 */
const BRIDGE_URL = process.env.OPENCLAW_BRIDGE_URL ?? 'http://localhost:4001';
// 10-minute timeout — board meetings involve multi-step tool use chains.
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

export async function runAgentSession(
  params: AgentSessionParams,
): Promise<AgentSessionResult> {
  const { message, agent = 'main', sessionId, thinking, context } = params;
  const startTime = Date.now();

  console.log(
    `[agent] Starting session. id=${sessionId} agent=${agent} thinking=${thinking ?? 'default'}`,
  );

  try {
    const body: Record<string, unknown> = { message, agent, sessionId };
    if (thinking) body.thinking = thinking;
    if (context) body.context = context;

    const response = await fetch(`${BRIDGE_URL}/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Bridge returned ${response.status}: ${errText}`);
    }

    const result = (await response.json()) as AgentSessionResult;

    // Track inference spend against the daily cognitive budget.
    const { recordLlmCall } = await import('../monitoring/metrics');
    recordLlmCall(result.estimatedCostUsd);

    console.log(
      `[agent] Session complete. id=${sessionId} cost=$${result.estimatedCostUsd.toFixed(6)} tokens=${result.totalTokens} duration=${result.durationMs}ms`,
    );

    return result;
  } catch (err: unknown) {
    // Do NOT re-throw — agent unavailability must not crash the relay.
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    const msg = cause === 'ECONNREFUSED'
      ? `bridge not reachable at ${BRIDGE_URL} (start openclaw-bridge/server.py)`
      : String(err);
    console.warn(`[agent] Session unavailable for ${sessionId}: ${msg}`);

    const { recordLlmCall } = await import('../monitoring/metrics');
    recordLlmCall(0); // still increment call count for debugging

    return {
      runId: 'error',
      text: '',
      toolCalls: [],
      estimatedCostUsd: 0,
      totalTokens: 0,
      durationMs: Date.now() - startTime,
    };
  }
}

