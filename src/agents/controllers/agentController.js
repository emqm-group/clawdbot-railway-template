import openclawService from "../utils/openclawService.js";
import configManager from "../utils/configManager.js";
import agentStorage from "../utils/agentStorage.js";
import logger from "../utils/logger.js";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

/**
 * Agent Controller
 * Handles all agent-related API requests
 */

/**
 * POST /api/agents
 * Create a new agent from an existing openclaw template agent.
 * Body: { templateId: string, configVars: { AGENT_NAME: string, ...placeholderVars } }
 *
 * - templateId: template agent ID; its workspace must have a /templates/ subfolder
 * - configVars: key/value pairs for every {{VAR}} found in template files;
 *                AGENT_NAME is required and used as the agent display name
 *
 * Reads template files from /data/.openclaw/workspace-{templateId}/templates/,
 * substitutes all {{VAR}} placeholders, and writes processed files to
 * /data/user-agents/workspace-{newAgentId}/.
 */
export const createAgent = async (req, res) => {
  try {
    const { templateId, configVars: placeholderVars = {} } = req.body;
    const name = placeholderVars.AGENT_NAME;

    logger.info("POST /api/agents - Create agent from template", {
      templateId,
      name,
      placeholderKeys: Object.keys(placeholderVars),
    });

    // Validate required fields
    if (!templateId || !name) {
      return res
        .status(400)
        .json({ error: "templateId and configVars.AGENT_NAME are required" });
    }

    // Verify template agent exists on the filesystem
    const templateAgentDir = `/data/.openclaw/agents/${templateId}`;
    try {
      await fs.stat(templateAgentDir);
    } catch {
      logger.warn("Template agent not found on filesystem", { templateId });
      return res
        .status(404)
        .json({ error: `Template agent ${templateId} not found` });
    }

    // Read template files from /data/.openclaw/workspace-{templateId}/templates/
    const templateFilesDir = `/data/.openclaw/workspace-${templateId}/templates`;
    let templateFileNames;
    try {
      templateFileNames = await fs.readdir(templateFilesDir);
    } catch {
      return res.status(404).json({
        error: `Templates directory not found for agent ${templateId}`,
      });
    }

    // Load all template file contents
    const fileContents = {};
    for (const file of templateFileNames) {
      fileContents[file] = await fs.readFile(
        path.join(templateFilesDir, file),
        "utf8",
      );
    }

    // Extract all unique {{VAR}} placeholders across all template files
    const allContent = Object.values(fileContents).join("\n");
    const requiredVars = [
      ...new Set(
        [...allContent.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]),
      ),
    ];

    // Validate all placeholders are supplied
    const missingVars = requiredVars.filter((v) => !(v in placeholderVars));
    if (missingVars.length > 0) {
      logger.warn("Create agent failed: missing template variables", {
        templateId,
        missingVars,
      });
      return res.status(400).json({
        error: "Missing required template variables",
        missingVars,
      });
    }

    // Derive new agent ID: templateId + random 8-char hex suffix
    const newAgentId = `${templateId}-${randomBytes(4).toString("hex")}`;

    // Create new workspace directory before registering with openclaw
    const newWorkspaceDir = `/data/user-agents/workspace-${newAgentId}`;
    await fs.mkdir(newWorkspaceDir, { recursive: true });

    // Create the new agent via openclaw CLI, pointing it at the workspace
    logger.info("Creating new agent via OpenClaw CLI", { newAgentId, name, workspace: newWorkspaceDir });
    const ocResult = await openclawService.createAgent(newAgentId, { name, workspace: newWorkspaceDir });
    logger.debug("OpenClaw agent created", { newAgentId, output: ocResult });

    // Substitute {{VAR}} placeholders and write processed files
    logger.info("Writing processed template files to new workspace", {
      newWorkspaceDir,
      files: templateFileNames,
    });
    for (const [file, content] of Object.entries(fileContents)) {
      let processed = content;
      for (const [varName, value] of Object.entries(placeholderVars)) {
        processed = processed.replaceAll(`{{${varName}}}`, value);
      }
      await fs.writeFile(path.join(newWorkspaceDir, file), processed, "utf8");
      logger.debug(`Written ${file}`, { newWorkspaceDir });
    }

    // Inherit model from template config/storage
    const templateConfig = configManager.getAgentConfig(templateId);
    const templateMeta = agentStorage.getAgent(templateId);
    const model =
      (templateConfig && templateConfig.model) ||
      (templateMeta && templateMeta.model) ||
      null;

    // Persist agent config
    const newAgentDir = `/data/user-agents/agents/${newAgentId}/agent`;
    configManager.updateAgentInConfig(newAgentId, {
      workspace: newWorkspaceDir,
      agentDir: newAgentDir,
      name,
      ...(model && { model }),
    });

    // Save agent metadata
    const metadata = {
      id: newAgentId,
      name,
      workspace: newWorkspaceDir,
      agentDir: newAgentDir,
      model,
      template: templateId,
      templateVars: placeholderVars,
      createdAt: new Date().toISOString(),
      status: "created",
    };
    const savedAgent = agentStorage.saveAgent(newAgentId, metadata);

    logger.info("Agent created successfully", {
      newAgentId,
      name,
      template: templateId,
    });

    return res.status(201).json({
      success: true,
      agentId: newAgentId,
      agent: savedAgent,
    });
  } catch (error) {
    logger.error("Create agent failed", error, {
      templateId: req.body?.templateId,
      name: req.body?.configVars?.AGENT_NAME,
    });
    return res
      .status(500)
      .json({ error: error.message || "Failed to create agent" });
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
 * GET /api/agents/:agentId
 * Get agent details
 */
export const getAgent = async (req, res) => {
  try {
    const { agentId } = req.params;

    logger.info("GET /api/agents/:agentId - Get agent details", { agentId });

    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
      logger.warn("Get agent failed: agent not found", { agentId });
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Enrich with config data
    const configAgent = configManager.getAgentConfig(agentId);
    logger.debug("Agent retrieved successfully", { agentId });

    res.json({
      success: true,
      agent: {
        ...agent,
        ...(configAgent && { openclawConfig: configAgent }),
      },
    });
  } catch (error) {
    logger.error("Get agent failed", error, { agentId: req.params?.agentId });
    res
      .status(500)
      .json({ error: error.message || "Failed to retrieve agent" });
  }
};

/**
 * GET /api/agents
 * List template agents by scanning /data/.openclaw/agents/ directly.
 * Each subdirectory is an agent; enriched with config and storage metadata.
 */
export const listAgents = async (req, res) => {
  try {
    logger.info("GET /api/agents - List template agents from /data/.openclaw");

    const openclawAgentsDir = "/data/.openclaw/agents";

    let agentIds = [];
    try {
      const entries = await fs.readdir(openclawAgentsDir, {
        withFileTypes: true,
      });
      agentIds = entries
        .filter((e) => e.isDirectory() && e.name !== "main")
        .map((e) => e.name);
      logger.debug("Agent directories found in /data/.openclaw/agents", {
        count: agentIds.length,
      });
    } catch (e) {
      logger.warn("Could not read /data/.openclaw/agents directory", {
        error: e.message,
      });
    }

    const agents = agentIds.map((agentId) => {
      const configAgent = configManager.getAgentConfig(agentId);
      const storedAgent = agentStorage.getAgent(agentId);
      return {
        id: agentId,
        workspace: `/data/.openclaw/workspace-${agentId}`,
        agentDir: `/data/.openclaw/agents/${agentId}/agent`,
        ...(storedAgent || {}),
        ...(configAgent || {}),
      };
    });

    logger.debug("Template agents listed from /data/.openclaw", {
      count: agents.length,
    });

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
      configManager.patchAgentConfig(agentId, configUpdate);
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
    const updatedConfig = configManager.patchAgentConfig(
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
 * DELETE /api/agents/:agentId
 * Delete an agent
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

    // Delete from openclaw
    logger.info("Deleting agent from OpenClaw", { agentId });
    await openclawService.deleteAgent(agentId);

    // Remove from config
    logger.debug("Removing agent from OpenClaw config", { agentId });
    configManager.removeAgentFromConfig(agentId);

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
