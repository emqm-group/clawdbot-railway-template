// Utility Tools plugin.
// Registers the "simple utility functions" tool group: pure, stateless,
// server-side helpers with NO third-party integration, NO OAuth/scopes, NO
// user-approval / artifact / task-state machinery, and NO per-tenant binding.
//
// First member: count_characters — agents pass post text and get back the exact
// character count, which they then check against the channel limit they already
// know (X 280, LinkedIn ~3000) before Buffer rejects an over-limit post. LLMs
// can compare two numbers but cannot reliably COUNT, so they need the tool.
//
// Transport: the tool posts to the wrapper's /api/utility/invoke loopback router
// (resolves tenantId and forwards to the orchestrator's /internal/utility/invoke,
// which dispatches the in-code REGISTRY and writes the audit row server-side).
// We forward rather than compute text.length locally so the orchestrator stays
// the single source of truth for the group and its audit logging is preserved.
//
// Factory form (`api.registerTool((ctx) => ...)`): openclaw resolves tools
// per-agent and passes that agent's ctx.agentId. Agents never pass their own ID
// as a tool parameter — the wrapper sources it from ctx. Per-agent `tools.allow`
// is the actual gate (propagated from base agents orchestrator-side).

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
// Generic utility-invoke path — forwards to /internal/utility/invoke.
const INVOKE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/utility/invoke`;

function log(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[UTILITY-TOOLS] [${tool}] ${msg}${metaStr}`);
}

function logError(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[UTILITY-TOOLS] [${tool}] ERROR: ${msg}${metaStr}`);
}

// Invoke a utility command via the loopback router. The router renames agentId
// → agent_id and injects tenantId before forwarding, so only { agentId, tool,
// params } is sent here.
async function callInvoke(agentId, tool, params) {
  const res = await fetch(INVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, tool, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Utility tool error [${data.code ?? res.status}]: ${data.message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

export default function register(api) {
  // count_characters — return the exact character length of `text`. Use before
  // posting to a character-limited channel so the agent can self-check against
  // the limit it already knows.
  api.registerTool((ctx) => ({
    name: "count_characters",
    description:
      "Return the exact character count of `text`. Use before posting to a character-limited channel (X 280, LinkedIn ~3000) — you cannot count characters reliably yourself.",
    parameters: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "The text to measure." },
      },
    },
    async execute(_toolCallId, { text }) {
      const agentId = ctx.agentId;
      log("count_characters", "called", { agentId, length: typeof text === "string" ? text.length : null });
      try {
        const data = await callInvoke(agentId, "count_characters", { text });
        log("count_characters", "success", { agentId, character_count: data.character_count });
        return okResult({ character_count: data.character_count });
      } catch (err) {
        logError("count_characters", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));
}
