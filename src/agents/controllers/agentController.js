import openclawService from "../utils/openclawService.js";
import configManager from "../utils/configManager.js";
import agentStorage from "../utils/agentStorage.js";
import logger from "../utils/logger.js";
import { promises as fs } from "fs";
import path from "path";

/**
 * Agent Controller
 * Handles all agent-related API requests
 */

/**
 * POST /api/agents
 * Create a new agent in this openclaw instance.
 * Body: { agentId: string, name?: string }
 */
export const createAgent = async (req, res) => {
  try {
    const { agentId, name } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }

    const agentName = name || agentId;

    logger.info("POST /api/agents - Create agent", { agentId, name: agentName });

    const workspace = `/data/.openclaw/workspace-${agentId}`;
    await openclawService.createAgent(agentId, { workspace });

    const agentDir = `/data/.openclaw/agents/${agentId}/agent`;
    await configManager.updateAgentInConfig(agentId, { workspace, agentDir, name: agentName });

    const metadata = {
      id: agentId,
      name: agentName,
      workspace,
      agentDir,
      createdAt: new Date().toISOString(),
      status: "created",
    };
    const savedAgent = agentStorage.saveAgent(agentId, metadata);

    logger.info("Agent created successfully", { agentId });

    return res.status(201).json({ success: true, agentId, agent: savedAgent });
  } catch (error) {
    logger.error("Create agent failed", error, { agentId: req.body?.agentId });
    return res.status(500).json({ error: error.message || "Failed to create agent" });
  }
};

/**
 * GET /api/agents/:agentId/vars
 * Return the list of {{VAR}} placeholder names required by a template agent's
 * template files (/data/.openclaw/workspace-{agentId}/templates/).
 */
export const getTemplateVars = async (req, res) => {
  try {
    const { agentId } = req.params;

    logger.info("GET /api/agents/:agentId/vars - Get template variables", {
      agentId,
    });

    const templateFilesDir = `/data/.openclaw/workspace-${agentId}/templates`;
    let templateFileNames;
    try {
      templateFileNames = await fs.readdir(templateFilesDir);
    } catch {
      return res.status(404).json({
        error: `Templates directory not found for agent ${agentId}`,
      });
    }

    // Read all template files and extract unique {{VAR}} placeholders
    const allContent = (
      await Promise.all(
        templateFileNames.map((f) =>
          fs.readFile(path.join(templateFilesDir, f), "utf8"),
        ),
      )
    ).join("\n");

    const vars = [
      ...new Set(
        [...allContent.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]),
      ),
    ];

    logger.debug("Template variables extracted", { agentId, vars });

    return res.json({
      success: true,
      agentId,
      vars,
    });
  } catch (error) {
    logger.error("Get template vars failed", error, {
      agentId: req.params?.agentId,
    });
    return res
      .status(500)
      .json({ error: error.message || "Failed to get template variables" });
  }
};

/**
 * GET /api/agents/config
 * Return the full openclaw.json config
 */
export const getConfig = async (_req, res) => {
  try {
    logger.info("GET /api/agents/config - Get openclaw.json");
    const config = configManager.readConfig();
    return res.json({ success: true, path: configManager.configPath, config });
  } catch (error) {
    logger.error("Get config failed", error);
    return res.status(500).json({ error: error.message || "Failed to read config" });
  }
};

const GATEWAY_RESTART_WARNING =
  "This change requires a manual gateway restart to take effect — call POST /api/gateway/restart to apply it.";
const MODEL_FORMAT = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.:/+.-]+$/;

/**
 * Validates a proposed openclaw.json update against the current config.
 * Returns hard errors (write blocked) and warnings (write allowed but flagged).
 */
function validateConfigChange(prevConfig, newConfig) {
  const errors = [];
  const warnings = [];

  const prevAgents = prevConfig.agents?.list ?? [];
  const newAgents = newConfig.agents?.list ?? [];
  const newAgentIds = new Set(newAgents.map((a) => a.id));

  // 1. Agent removal — must use DELETE /api/agents/:agentId instead
  for (const agent of prevAgents) {
    if (!newAgentIds.has(agent.id)) {
      errors.push(
        `Agent "${agent.id}" exists in the system but is missing from the new config. ` +
        `Use DELETE /api/agents/${agent.id} to remove agents.`
      );
    }
  }

  // 2. agentDir uniqueness — sharing causes immediate session/state corruption
  const seenDirs = new Set();
  for (const agent of newAgents) {
    if (!agent.agentDir) continue;
    if (seenDirs.has(agent.agentDir)) {
      errors.push(
        `agentDir "${agent.agentDir}" is shared by multiple agents. Each agent must have a unique agentDir.`
      );
    }
    seenDirs.add(agent.agentDir);
  }

  // 3. Gateway token mismatch — would break all gateway connections on hot-reload
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const newToken = newConfig.gateway?.auth?.token;
  if (envToken && newToken && newToken !== envToken) {
    errors.push(
      `gateway.auth.token in the new config does not match the OPENCLAW_GATEWAY_TOKEN env var. ` +
      `This would break all gateway connections after hot-reload.`
    );
  }

  // 4. Dangling bindings — silent routing failure
  for (const binding of newConfig.bindings ?? []) {
    const agentId = binding.agent ?? binding.agentId;
    if (agentId && !newAgentIds.has(agentId)) {
      errors.push(
        `Binding references agent "${agentId}" which does not exist in agents.list.`
      );
    }
  }

  // 5. workspace or agentDir path change for existing agents — loses files and sessions
  const prevAgentMap = new Map(prevAgents.map((a) => [a.id, a]));
  for (const newAgent of newAgents) {
    const prev = prevAgentMap.get(newAgent.id);
    if (!prev) continue;
    if (prev.workspace && newAgent.workspace && prev.workspace !== newAgent.workspace) {
      warnings.push(
        `Agent "${newAgent.id}" workspace changed from "${prev.workspace}" to "${newAgent.workspace}". ` +
        `The agent will lose access to its config files (AGENTS.md, SOUL.md, memory, etc).`
      );
    }
    if (prev.agentDir && newAgent.agentDir && prev.agentDir !== newAgent.agentDir) {
      warnings.push(
        `Agent "${newAgent.id}" agentDir changed from "${prev.agentDir}" to "${newAgent.agentDir}". ` +
        `The agent will lose its sessions and state.`
      );
    }
  }

  // 6. gateway.bind or gateway.port change — requires restart, hot-reload won't apply
  const prevBind = prevConfig.gateway?.bind;
  const newBind = newConfig.gateway?.bind;
  if (prevBind && newBind && prevBind !== newBind) {
    warnings.push(`gateway.bind changed from "${prevBind}" to "${newBind}". ${GATEWAY_RESTART_WARNING}`);
  }
  const prevPort = prevConfig.gateway?.port;
  const newPort = newConfig.gateway?.port;
  if (prevPort && newPort && String(prevPort) !== String(newPort)) {
    warnings.push(`gateway.port changed from ${prevPort} to ${newPort}. ${GATEWAY_RESTART_WARNING}`);
  }

  // 7. Model format — must be "provider/modelId"
  const modelsToCheck = [];
  if (newConfig.agents?.defaults?.model && typeof newConfig.agents.defaults.model === "string") {
    modelsToCheck.push({ path: "agents.defaults.model", value: newConfig.agents.defaults.model });
  }
  for (const agent of newAgents) {
    if (agent.model && typeof agent.model === "string") {
      modelsToCheck.push({ path: `agents.list[${agent.id}].model`, value: agent.model });
    }
  }
  for (const { path: modelPath, value } of modelsToCheck) {
    if (!MODEL_FORMAT.test(value)) {
      warnings.push(
        `${modelPath} "${value}" does not match expected format "provider/modelId" ` +
        `(e.g. "anthropic/claude-sonnet-4-6"). Agent turns may fail.`
      );
    }
  }

  return { errors, warnings };
}

/**
 * PUT /api/agents/config
 * Replace the full openclaw.json config
 * Body: the config object
 */
export const updateConfig = async (req, res) => {
  try {
    logger.info("PUT /api/agents/config - Update openclaw.json");

    const config = req.body;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return res.status(400).json({ error: "Request body must be a config object" });
    }

    // Validate before writing
    const validation = await openclawService.validateConfig(config);
    if (!validation.valid) {
      logger.warn("Config validation failed — write aborted", { error: validation.error });
      return res.status(400).json({
        error: "Invalid config — openclaw.json not updated",
        details: validation.error,
      });
    }

    const prevConfig = configManager.readConfig();

    // Run guardrail checks against current config
    const { errors, warnings } = validateConfigChange(prevConfig, config);
    if (errors.length > 0) {
      logger.warn("Config update blocked by guardrails", { errors });
      return res.status(400).json({
        error: "Config update blocked",
        errors,
        ...(warnings.length > 0 && { warnings }),
      });
    }

    const prevAgents = prevConfig.agents?.list?.map((a) => a.id) ?? [];
    configManager.writeConfig(config);

    const nextAgents = config.agents?.list?.map((a) => a.id) ?? [];
    const added = nextAgents.filter((id) => !prevAgents.includes(id));
    const removed = prevAgents.filter((id) => !nextAgents.includes(id));

    logger.info("openclaw.json updated successfully", {
      agentsBefore: prevAgents,
      agentsAfter: nextAgents,
      added,
      removed,
      warnings,
    });

    // Poll gateway health to confirm it absorbed the change cleanly
    const health = await openclawService.pollGatewayHealth();
    if (!health.healthy) {
      logger.warn("Gateway unhealthy after config update", { details: health.details });
      return res.status(207).json({
        success: true,
        warning: "Config written but gateway is not healthy — it may have rejected the new config",
        gatewayDetails: health.details,
        path: configManager.configPath,
        config,
        ...(warnings.length > 0 && { warnings }),
      });
    }

    return res.json({
      success: true,
      path: configManager.configPath,
      config,
      gateway: { healthy: true, details: health.details },
      ...(warnings.length > 0 && { warnings }),
    });
  } catch (error) {
    logger.error("Update config failed", error);
    return res.status(500).json({ error: error.message || "Failed to write config" });
  }
};

/**
 * GET /api/agents/:agentId
 * Get agent details
 */
export const getAgent = async (req, res) => {
  try {
    const { agentId } = req.params;

    logger.info("GET /api/agents/:agentId - Get agent details", { agentId });

    const agents = await openclawService.listAgents();
    const agent = agents.find((a) => a.id === agentId);

    if (!agent) {
      logger.warn("Get agent failed: agent not found", { agentId });
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    logger.debug("Agent retrieved successfully", { agentId });
    res.json({ success: true, agent });
  } catch (error) {
    logger.error("Get agent failed", error, { agentId: req.params?.agentId });
    res.status(500).json({ error: error.message || "Failed to retrieve agent" });
  }
};

/**
 * GET /api/agents
 * List all agents from the openclaw instance.
 */
export const listAgents = async (req, res) => {
  try {
    logger.info("GET /api/agents - List agents");

    const agents = await openclawService.listAgents();

    logger.debug("Agents listed", { count: agents.length });

    return res.json({
      success: true,
      count: agents.length,
      agents,
    });
  } catch (error) {
    logger.error("List agents failed", error);
    res.status(500).json({ error: error.message || "Failed to list agents" });
  }
};

/**
 * PATCH /api/agents/:agentId
 * Update agent metadata
 */
export const updateAgent = async (req, res) => {
  try {
    const { agentId } = req.params;
    const updates = req.body;

    logger.info("PATCH /api/agents/:agentId - Update agent metadata", {
      agentId,
      updates,
    });

    // Verify agent exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      logger.warn("Update agent failed: agent not found", { agentId });
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Update storage
    logger.debug("Updating agent in storage", { agentId });
    const updatedAgent = agentStorage.updateAgent(agentId, updates);

    // Also update in openclaw config if name/workspace/model changed
    if (updates.name || updates.workspace || updates.model) {
      const configUpdate = {};
      if (updates.name) configUpdate.name = updates.name;
      if (updates.workspace) configUpdate.workspace = updates.workspace;
      if (updates.model) configUpdate.model = updates.model;

      logger.info("Updating agent config in OpenClaw", {
        agentId,
        configUpdate,
      });
      await configManager.patchAgentConfig(agentId, configUpdate);
    }

    logger.info("Agent updated successfully", { agentId });
    res.json({
      success: true,
      agent: updatedAgent,
    });
  } catch (error) {
    logger.error("Update agent failed", error, {
      agentId: req.params?.agentId,
    });
    res.status(500).json({ error: error.message || "Failed to update agent" });
  }
};

/**
 * PATCH /api/agents/:agentId/config
 * Update openclaw config for an agent
 * Body: { configUpdate: object } or { model, workspace, bindings, etc. }
 */
export const updateAgentConfig = async (req, res) => {
  try {
    const { agentId } = req.params;
    const configUpdate = req.body;

    logger.info("PATCH /api/agents/:agentId/config - Update agent config", {
      agentId,
      configKeys: Object.keys(configUpdate),
    });

    // Verify agent exists in storage
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      logger.warn("Update agent config failed: agent not found", { agentId });
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Parse the update
    // Support both { configUpdate: {...} } and direct properties
    let updatePayload = req.body.configUpdate || req.body;

    logger.debug("Merging config update into OpenClaw config", {
      agentId,
      updatePayload,
    });

    // Merge into openclaw config
    const updatedConfig = await configManager.patchAgentConfig(
      agentId,
      updatePayload,
    );

    // Update storage metadata to reflect custom config
    if (updatePayload.model) {
      logger.debug("Updating agent model in storage", {
        agentId,
        model: updatePayload.model,
      });
      agentStorage.updateAgent(agentId, { model: updatePayload.model });
    }

    logger.info("Agent config updated successfully", { agentId });
    res.json({
      success: true,
      message: `Config updated for agent ${agentId}`,
      config: updatedConfig,
    });
  } catch (error) {
    logger.error("Update agent config failed", error, {
      agentId: req.params?.agentId,
    });
    res
      .status(500)
      .json({ error: error.message || "Failed to update agent config" });
  }
};

/**
 * GET /api/agents/:agentId/config-files
 * Return all config files from the agent's workspace directory.
 */
export const getConfigFiles = async (req, res) => {
  const ALLOWED_FILES = [
    "AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md",
    "BOOTSTRAP.md", "MEMORY.md", "HEARTBEAT.md",
  ];

  try {
    const { agentId } = req.params;

    logger.info("GET /api/agents/:agentId/config-files - Get config files", { agentId });

    const storedAgent = agentStorage.getAgent(agentId);
    let workspaceDir = storedAgent?.workspace || null;

    if (!workspaceDir) {
      const agentDir = `/data/.openclaw/agents/${agentId}`;
      try {
        await fs.stat(agentDir);
        workspaceDir = `/data/.openclaw/workspace-${agentId}`;
      } catch {
        logger.warn("Get config files failed: agent not found", { agentId });
        return res.status(404).json({ error: `Agent ${agentId} not found` });
      }
    }

    const files = {};
    for (const fileName of ALLOWED_FILES) {
      const filePath = path.join(workspaceDir, fileName);
      try {
        files[fileName] = await fs.readFile(filePath, "utf8");
      } catch {
        // File doesn't exist — omit it from the response
      }
    }

    logger.debug("Config files read", { agentId, files: Object.keys(files) });

    return res.json({ success: true, agentId, workspaceDir, files });
  } catch (error) {
    logger.error("Get config files failed", error, { agentId: req.params?.agentId });
    return res.status(500).json({ error: error.message || "Failed to get config files" });
  }
};

/**
 * PUT /api/agents/:agentId/config-files
 * Upload/replace agent config files (AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md,
 * and optionally BOOTSTRAP.md and MEMORY.md) into the agent's workspace directory.
 *
 * Body: { files: { "AGENTS.md": "...", "IDENTITY.md": "...", ... } }
 *
 * Any subset of allowed files may be provided; only included files are written.
 * Allowed files: AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, BOOTSTRAP.md, MEMORY.md
 *
 * The workspace is resolved from agent storage (user-created agents) or derived as
 * /data/.openclaw/workspace-{agentId} (template/built-in agents).
 */
export const uploadConfigFiles = async (req, res) => {
  const ALLOWED_FILES = new Set([
    "AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md",
    "BOOTSTRAP.md", "MEMORY.md", "HEARTBEAT.md",
  ]);

  try {
    const { agentId } = req.params;
    const { files } = req.body;

    logger.info("PUT /api/agents/:agentId/config-files - Upload config files", {
      agentId,
      fileKeys: files ? Object.keys(files) : [],
    });

    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return res.status(400).json({ error: "Request body must include a 'files' object" });
    }

    if (Object.keys(files).length === 0) {
      return res.status(400).json({ error: "At least one file must be provided" });
    }

    // Validate no disallowed file names
    const unknownFiles = Object.keys(files).filter((f) => !ALLOWED_FILES.has(f));
    if (unknownFiles.length > 0) {
      return res.status(400).json({
        error: "Unknown file names provided",
        unknownFiles,
        allowedFiles: [...ALLOWED_FILES],
      });
    }

    // Validate all file values are strings
    const invalidFiles = Object.entries(files)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    if (invalidFiles.length > 0) {
      return res.status(400).json({
        error: "File contents must be strings",
        invalidFiles,
      });
    }

    // Resolve agent workspace — check storage first (user-created agents have custom paths),
    // then check /data/.openclaw/agents/{agentId} for built-in/template agents.
    const storedAgent = agentStorage.getAgent(agentId);
    let workspaceDir = storedAgent?.workspace || null;

    if (!workspaceDir) {
      // Verify the agent exists as a built-in agent in openclaw
      const agentDir = `/data/.openclaw/agents/${agentId}`;
      try {
        await fs.stat(agentDir);
        workspaceDir = `/data/.openclaw/workspace-${agentId}`;
      } catch {
        logger.warn("Upload config files failed: agent not found", { agentId });
        return res.status(404).json({ error: `Agent ${agentId} not found` });
      }
    }

    // Ensure workspace directory exists
    await fs.mkdir(workspaceDir, { recursive: true });

    // Write each file to the workspace
    const written = [];
    for (const [fileName, content] of Object.entries(files)) {
      const filePath = path.join(workspaceDir, fileName);
      await fs.writeFile(filePath, content, "utf8");
      written.push(fileName);
      logger.debug("Config file written", { agentId, filePath });
    }

    logger.info("Agent config files uploaded successfully", {
      agentId,
      workspaceDir,
      written,
    });

    return res.json({
      success: true,
      agentId,
      workspaceDir,
      written,
    });
  } catch (error) {
    logger.error("Upload config files failed", error, {
      agentId: req.params?.agentId,
    });
    return res.status(500).json({ error: error.message || "Failed to upload config files" });
  }
};

/**
 * PUT /api/agents/batch/config-files
 * Write config files for multiple agents and optionally reset their sessions.
 *
 * Body:
 *   {
 *     agents: [{ agentId: string, files: { "AGENTS.md"?: string, ... } }, ...],
 *     resetSessions?: boolean  // default true
 *   }
 *
 * Each agent is processed independently. Failures for one agent do not abort others.
 * Returns per-agent results; HTTP 207 if any agent failed, 200 if all succeeded.
 */
export const batchUpdateConfigFiles = async (req, res) => {
  const ALLOWED_FILES = new Set([
    "AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md",
    "BOOTSTRAP.md", "MEMORY.md", "HEARTBEAT.md",
  ]);

  try {
    const { agents, resetSessions = true } = req.body;

    if (!Array.isArray(agents) || agents.length === 0) {
      return res.status(400).json({ error: "'agents' must be a non-empty array" });
    }

    logger.info("PUT /api/agents/batch/config-files - Batch update config files", {
      agentCount: agents.length,
      resetSessions,
    });

    const results = [];
    let anyFailed = false;

    for (const entry of agents) {
      const { agentId, files } = entry;

      if (!agentId) {
        results.push({ agentId: null, success: false, error: "agentId is required" });
        anyFailed = true;
        continue;
      }

      if (!files || typeof files !== "object" || Array.isArray(files)) {
        results.push({ agentId, success: false, error: "'files' must be an object" });
        anyFailed = true;
        continue;
      }

      if (Object.keys(files).length === 0) {
        results.push({ agentId, success: false, error: "At least one file must be provided" });
        anyFailed = true;
        continue;
      }

      const unknownFiles = Object.keys(files).filter((f) => !ALLOWED_FILES.has(f));
      if (unknownFiles.length > 0) {
        results.push({ agentId, success: false, error: "Unknown file names", unknownFiles });
        anyFailed = true;
        continue;
      }

      const invalidFiles = Object.entries(files)
        .filter(([, v]) => typeof v !== "string")
        .map(([k]) => k);
      if (invalidFiles.length > 0) {
        results.push({ agentId, success: false, error: "File contents must be strings", invalidFiles });
        anyFailed = true;
        continue;
      }

      // Resolve workspace
      const storedAgent = agentStorage.getAgent(agentId);
      let workspaceDir = storedAgent?.workspace || null;

      if (!workspaceDir) {
        const agentDir = `/data/.openclaw/agents/${agentId}`;
        try {
          await fs.stat(agentDir);
          workspaceDir = `/data/.openclaw/workspace-${agentId}`;
        } catch {
          results.push({ agentId, success: false, error: `Agent ${agentId} not found` });
          anyFailed = true;
          continue;
        }
      }

      // Write files
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        const written = [];
        for (const [fileName, content] of Object.entries(files)) {
          await fs.writeFile(path.join(workspaceDir, fileName), content, "utf8");
          written.push(fileName);
        }
        logger.info("Batch: config files written", { agentId, written });

        // Reset sessions
        let sessionReset = null;
        if (resetSessions) {
          try {
            const result = await openclawService.resetAgentSession(agentId);
            sessionReset = {
              success: true,
              sessionsReset: result.results.length,
            };
            logger.info("Batch: session reset", { agentId, sessionsReset: result.results.length });
          } catch (resetErr) {
            sessionReset = { success: false, error: resetErr.message };
            logger.warn("Batch: session reset failed (files were written)", { agentId, error: resetErr.message });
          }
        }

        results.push({ agentId, success: true, written, workspaceDir, ...(resetSessions && { sessionReset }) });
      } catch (writeErr) {
        logger.error("Batch: failed to write config files", { agentId, error: writeErr.message });
        results.push({ agentId, success: false, error: writeErr.message });
        anyFailed = true;
      }
    }

    const status = anyFailed ? 207 : 200;
    return res.status(status).json({
      success: !anyFailed,
      results,
    });
  } catch (error) {
    logger.error("Batch update config files failed", error);
    return res.status(500).json({ error: error.message || "Failed to batch update config files" });
  }
};

/**
 * DELETE /api/agents/:agentId
 * Delete an agent
 * Template agents (those with a /templates/ subdirectory in their workspace) cannot be deleted.
 */
export const deleteAgent = async (req, res) => {
  try {
    const { agentId } = req.params;

    logger.info("DELETE /api/agents/:agentId - Delete agent", { agentId });

    // Verify agent exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      logger.warn("Delete agent failed: agent not found", { agentId });
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Block deletion of template agents (agents that have a templates/ directory)
    const templateFilesDir = `/data/.openclaw/workspace-${agentId}/templates`;
    try {
      await fs.stat(templateFilesDir);
      // If stat succeeds, this is a template agent — block deletion
      logger.warn("Delete agent blocked: agent is a template", { agentId, templateFilesDir });
      return res.status(400).json({
        error: `Agent ${agentId} is a template and cannot be deleted`,
      });
    } catch {
      // templates/ dir does not exist — not a template agent, proceed
    }

    // Cancel any cron jobs belonging to this agent
    try {
      const cronJobs = await openclawService.listCronJobs();
      const agentJobs = cronJobs.filter((job) => job.agentId === agentId);
      if (agentJobs.length > 0) {
        logger.info("Removing cron jobs for agent", { agentId, count: agentJobs.length });
        for (const job of agentJobs) {
          const jobId = job.jobId ?? job.id;
          await openclawService.deleteCronJob(jobId);
          logger.debug("Cron job removed", { agentId, jobId });
        }
      }
    } catch (cronErr) {
      // Non-fatal: log and continue with agent deletion
      logger.warn("Failed to clean up cron jobs for agent", {
        agentId,
        error: cronErr.message,
      });
    }

    // Delete from openclaw (pass stored paths so the correct workspace is removed)
    logger.info("Deleting agent from OpenClaw", { agentId });
    await openclawService.deleteAgent(agentId, {
      workspace: existingAgent.workspace,
      agentDir: existingAgent.agentDir,
    });

    // Remove from config
    logger.debug("Removing agent from OpenClaw config", { agentId });
    await configManager.removeAgentFromConfig(agentId);

    // Remove from storage
    logger.debug("Removing agent from storage", { agentId });
    agentStorage.deleteAgent(agentId);

    logger.info("Agent deleted successfully", { agentId });
    res.json({
      success: true,
      message: `Agent ${agentId} deleted successfully`,
    });
  } catch (error) {
    logger.error("Delete agent failed", error, {
      agentId: req.params?.agentId,
    });
    res.status(500).json({ error: error.message || "Failed to delete agent" });
  }
};

/**
 * POST /api/agents/:agentId/session/reset
 * Clear all session transcripts for an agent so it starts fresh on the next turn.
 * Use this after updating identity-critical config files (SOUL.md, IDENTITY.md, TOOLS.md)
 * where stale session history would override the new content.
 */
export const resetAgentSession = async (req, res) => {
  const { agentId } = req.params;
  try {
    logger.info("POST /api/agents/:agentId/session/reset - Reset agent session", { agentId });

    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    const { sessionKey } = req.body ?? {};
    const result = await openclawService.resetAgentSession(agentId, sessionKey);
    return res.json({
      success: true,
      agentId,
      results: result.results,
      message: result.results.length > 0
        ? `Reset ${result.results.length} session(s)`
        : "No active sessions found — nothing to reset",
    });
  } catch (error) {
    logger.error("Reset agent session failed", error, { agentId: req.params?.agentId });
    return res.status(500).json({ error: error.message || "Failed to reset session" });
  }
};
