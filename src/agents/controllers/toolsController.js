import logger from "../utils/logger.js";
import { applyToolsUpdate } from "../utils/toolsManifest.js";
import configManager from "../utils/configManager.js";

const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();
const TENANT_ID = () => process.env.TENANT_ID?.trim();

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
 * Auth: ORCHESTRATOR_SECRET bearer token.
 */
export async function register(req, res, restartGateway) {
  const { action, agent_id, tools } = req.body;

  if (!agent_id) {
    return res.status(400).json({ error: "agent_id is required" });
  }
  if (!action || !["add", "remove"].includes(action)) {
    return res.status(400).json({ error: 'action must be "add" or "remove"' });
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    return res.status(400).json({ error: "tools must be a non-empty array" });
  }

  try {
    applyToolsUpdate(action, tools);
  } catch (err) {
    logger.error("toolsController.register: manifest update failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update tools manifest" });
  }

  // Patch the agent's tools.allow in openclaw.json before restarting the gateway.
  await applyAgentToolsAllow(action, agent_id, tools);

  // Respond immediately — gateway restart is async
  res.json({ ok: true });

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
 * Proxies the tool call to the orchestrator.
 */
export async function invoke(req, res) {
  const { agent_id, tool, params } = req.body;

  if (!agent_id || !tool) {
    return res.status(400).json({ error: "agent_id and tool are required" });
  }

  const orchestratorUrl = ORCHESTRATOR_URL();
  const secret = ORCHESTRATOR_SECRET();
  const tenantId = TENANT_ID();

  if (!orchestratorUrl || !secret || !tenantId) {
    logger.error("toolsController.invoke: missing ORCHESTRATOR_URL, ORCHESTRATOR_SECRET, or TENANT_ID");
    return res.status(503).json({ error: "UPSTREAM_ERROR", message: "Orchestrator not configured" });
  }

  try {
    const response = await fetch(
      `${orchestratorUrl}/internal/tools/${tenantId}/invoke`,
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
