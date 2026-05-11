import logger from "../utils/logger.js";
import { applyToolsUpdate } from "../utils/toolsManifest.js";
import configManager from "../utils/configManager.js";
import { getTenantId } from "../utils/tenantMappings.js";

const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();

/**
 * Patch tools.allow for the specified agent in openclaw.json.
 * Non-fatal — logs errors but does not throw.
 */
async function applyAgentToolsAllow(action, agentId, tools) {
  const toolNames = tools.map((t) => t.name);

  try {
    const existing = configManager.getAgentConfig(agentId);
    if (!existing) {
      logger.warn("toolsController: agent not found in config, skipping tools.allow patch", { agentId });
      return;
    }

    const currentAllow = existing.tools?.allow ?? [];

    let newAllow;
    if (action === "add") {
      const toAdd = toolNames.filter((n) => !currentAllow.includes(n));
      newAllow = [...currentAllow, ...toAdd];
    } else {
      const toRemove = new Set(toolNames);
      newAllow = currentAllow.filter((n) => !toRemove.has(n));
    }

    const newTools = { ...(existing.tools ?? {}), allow: newAllow };
    await configManager.patchAgentConfig(agentId, { tools: newTools });
    logger.info("toolsController: patched agent tools.allow", { agentId, action, toolNames });
  } catch (err) {
    logger.error("toolsController: failed to patch agent tools.allow", { agentId, error: err.message });
  }
}

/**
 * POST /api/tools/register
 * Called by orchestrator to push tool definitions to this instance.
 * Auth: OPENCLAW_GATEWAY_TOKEN Bearer (enforced by router).
 *
 * Body: { action, agent_id, tools, restart? }
 *   - restart (default true): when false, applies the writes but skips the trailing
 *     gateway restart. Caller is then responsible for issuing POST /api/gateway/restart
 *     once after batching multiple per-agent registers — avoids overlapping restarts.
 */
export async function register(req, res, restartGateway) {
  const { action, agent_id, tools, restart } = req.body;

  if (!agent_id) {
    return res.status(400).json({ error: "agent_id is required" });
  }
  if (!action || !["add", "remove"].includes(action)) {
    return res.status(400).json({ error: 'action must be "add" or "remove"' });
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    return res.status(400).json({ error: "tools must be a non-empty array" });
  }
  if (restart !== undefined && typeof restart !== "boolean") {
    return res.status(400).json({ error: "restart must be a boolean" });
  }
  const shouldRestart = restart !== false;

  try {
    applyToolsUpdate(action, tools);
  } catch (err) {
    logger.error("toolsController.register: manifest update failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update tools manifest" });
  }

  // Patch the agent's tools.allow in openclaw.json before restarting the gateway.
  await applyAgentToolsAllow(action, agent_id, tools);

  // Also update the global tools.alsoAllow — plugin tools must appear here to be
  // injected into agent sessions. alsoAllow is additive and does not restrict built-in tools.
  const toolNames = tools.map((t) => t.name);
  try {
    await configManager.patchGlobalToolsAlsoAllow(action, toolNames);
  } catch (err) {
    logger.error("toolsController.register: failed to patch global tools.alsoAllow", { error: err.message });
  }

  res.json({ ok: true });

  if (!shouldRestart) {
    logger.info("toolsController.register: writes applied, restart skipped (caller will batch)", {
      action,
      agentId: agent_id,
      toolCount: tools.length,
    });
    return;
  }

  try {
    await restartGateway();
    logger.info("toolsController.register: gateway restarted after tool update", {
      action,
      agentId: agent_id,
      toolCount: tools.length,
    });
  } catch (err) {
    logger.error("toolsController.register: gateway restart failed", { error: err.message });
  }
}

/**
 * POST /api/tools/invoke
 * Called by the third-party-tools plugin (loopback only — no auth).
 * Resolves the calling agent's tenant from the tenant-mapping cache and
 * forwards to the orchestrator's /internal/tools/:tenantId/invoke endpoint
 * with the agentId carried in the body (Wrapper Impl #3).
 */
export async function invoke(req, res) {
  const { agent_id, tool, params } = req.body;

  if (!agent_id || !tool) {
    return res.status(400).json({ error: "agent_id and tool are required" });
  }

  const orchestratorUrl = ORCHESTRATOR_URL();
  const secret = ORCHESTRATOR_SECRET();

  if (!orchestratorUrl || !secret) {
    logger.error("toolsController.invoke: missing ORCHESTRATOR_URL or ORCHESTRATOR_SECRET");
    return res.status(503).json({ error: "UPSTREAM_ERROR", message: "Orchestrator not configured" });
  }

  // Resolve tenantId from the tenant-mapping cache. Single-flight re-fetch on
  // miss; if still missing after re-fetch, the agent is unknown to this shard
  // (e.g. tenant just removed mid-call). Return the structured `unknown_agent`
  // code per Decision #8.
  let tenantId;
  try {
    tenantId = await getTenantId(agent_id);
  } catch (err) {
    logger.error("toolsController.invoke: tenant lookup failed", { agentId: agent_id, error: err.message });
    return res.status(502).json({ code: "tenant_lookup_failed", message: err.message });
  }
  if (!tenantId) {
    logger.warn("toolsController.invoke: unknown agentId after cache refetch", { agentId: agent_id });
    return res.status(404).json({ code: "unknown_agent", message: `Unknown agent: ${agent_id}` });
  }

  try {
    const response = await fetch(
      `${orchestratorUrl}/internal/tools/${encodeURIComponent(tenantId)}/invoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ tenant_id: tenantId, agent_id, tool, params: params ?? {} }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      logger.warn("toolsController.invoke: orchestrator returned error", {
        status: response.status,
        code: data.code,
        tool,
        agentId: agent_id,
      });
      return res.status(response.status).json(data);
    }

    return res.json(data);
  } catch (err) {
    logger.error("toolsController.invoke: orchestrator call failed", {
      tool,
      agentId: agent_id,
      error: err.message,
    });
    return res.status(502).json({ error: "UPSTREAM_ERROR", message: err.message });
  }
}
