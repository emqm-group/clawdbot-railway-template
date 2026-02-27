import openclawService from "../utils/openclawService.js";
import configManager from "../utils/configManager.js";
import agentStorage from "../utils/agentStorage.js";
import logger from "../utils/logger.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

/**
 * Agent Controller
 * Handles all agent-related API requests
 */

/**
 * POST /api/agents
 * Create a new agent from an existing openclaw template agent.
 * Body: { agentId: string (existing template), name: string }
 *
 * - agentId: must be an existing agent in openclaw (used as template)
 * - name: display name for the new agent (also used to derive its ID)
 *
 * The model is inherited from the template agent's configuration.
 *
 * Copies AGENTS.md, BOOTSTRAP.md, HEARTBEAT.md, IDENTITY.md, SOUL.md,
 * TOOLS.md, USER.md from the template agent's workspace into the new agent's workspace.
 */
export const createAgent = async (req, res) => {
  try {
    const { agentId: templateId, name } = req.body;

    logger.info("POST /api/agents - Create agent from template", {
      templateId,
      name,
    });

    // Validate required fields
    if (!templateId || !name) {
      logger.warn("Create agent failed: missing required fields", {
        templateId,
        name,
      });
      return res
        .status(400)
        .json({ error: "agentId (template) and name are required" });
    }

    // Verify the template agent exists in openclaw
    // Primary check: openclaw CLI; fallback: local config and storage
    const existsInCli = await openclawService.agentExists(templateId);
    const templateConfig = configManager.getAgentConfig(templateId);
    const templateMeta = agentStorage.getAgent(templateId);

    if (!existsInCli && !templateConfig && !templateMeta) {
      logger.warn("Template agent not found in openclaw", { templateId });
      return res
        .status(404)
        .json({ error: `Agent ${templateId} not found in openclaw` });
    }

    // Derive new agent ID: templateId + random 8-char hex suffix
    const newAgentId = `${templateId}-${randomBytes(4).toString("hex")}`;

    // Check if the new agent already exists
    const existingNew =
      agentStorage.getAgent(newAgentId) ||
      configManager.getAgentConfig(newAgentId);
    if (existingNew) {
      logger.warn("Create agent failed: new agent already exists", {
        newAgentId,
      });
      return res
        .status(409)
        .json({ error: `Agent ${newAgentId} already exists` });
    }

    // Resolve template workspace path
    const homeDir = process.env.HOME || os.homedir();
    const expand = (p) =>
      p.startsWith("~") ? path.join(homeDir, p.slice(1)) : p;

    const rawTemplateWorkspace =
      (templateConfig && templateConfig.workspace) ||
      (templateMeta && templateMeta.workspace) ||
      `~/data/.openclaw/workspace-${templateId}`;

    // Try several candidate paths to locate the actual template workspace
    const resolveExisting = async (candidates) => {
      for (const c of candidates) {
        try {
          await fs.stat(c);
          return c;
        } catch {
          // not found, try next
        }
      }
      return null;
    };

    const templateWorkspaceExpanded = expand(rawTemplateWorkspace);
    const templateWorkspace =
      (await resolveExisting([
        templateWorkspaceExpanded,
        path.join(homeDir, ".openclaw", `workspace-${templateId}`),
        path.join(homeDir, "data", ".openclaw", `workspace-${templateId}`),
      ])) || templateWorkspaceExpanded;

    logger.debug("Resolved template workspace", {
      templateId,
      templateWorkspace,
    });

    // Create the new agent via openclaw CLI
    logger.info("Creating new agent via OpenClaw CLI", { newAgentId, name });
    const ocResult = await openclawService.createAgent(newAgentId, { name });
    logger.debug("OpenClaw agent created", { newAgentId, output: ocResult });

    // Determine new agent paths (under /data/user-agents to distinguish from templates)
    const newWorkspace = `~/data/user-agents/workspace-${newAgentId}`;
    const newAgentDir = `~/data/user-agents/agents/${newAgentId}/agent`;
    const newWorkspaceExpanded = expand(newWorkspace);

    // Ensure new workspace directory exists
    await fs.mkdir(newWorkspaceExpanded, { recursive: true });

    // Copy the 7 workspace MD files from the template to the new agent
    const mdFiles = [
      "AGENTS.md",
      "BOOTSTRAP.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
    ];

    logger.info("Copying template MD files to new workspace", {
      templateWorkspace,
      newWorkspaceExpanded,
    });

    for (const file of mdFiles) {
      const srcFile = path.join(templateWorkspace, file);
      const dstFile = path.join(newWorkspaceExpanded, file);
      try {
        await fs.copyFile(srcFile, dstFile);
        logger.debug(`Copied ${file}`, { srcFile, dstFile });
      } catch (e) {
        logger.error(`Failed to copy ${file}`, e, { srcFile, dstFile });
        throw new Error(
          `Failed to copy ${file} from template workspace: ${e.message}`,
        );
      }
    }

    logger.info("Template MD files copied successfully", {
      newAgentId,
      templateId,
    });

    // Inherit the model from the template agent's config
    const model =
      (templateConfig && templateConfig.model) ||
      (templateMeta && templateMeta.model) ||
      null;

    logger.debug("Inherited model from template", { templateId, model });

    // Persist agent config to openclaw with the inherited model
    const agentConfig = {
      workspace: newWorkspace,
      agentDir: newAgentDir,
      name,
      ...(model && { model }),
    };

    logger.info("Updating agent config in OpenClaw", { newAgentId, model });
    configManager.updateAgentInConfig(newAgentId, agentConfig);

    // Save agent metadata in wrapper storage
    const metadata = {
      id: newAgentId,
      name,
      workspace: newWorkspace,
      agentDir: newAgentDir,
      model,
      template: templateId,
      createdAt: new Date().toISOString(),
      status: "created",
    };

    logger.info("Saving agent metadata", { newAgentId, model });
    const savedAgent = agentStorage.saveAgent(newAgentId, metadata);

    logger.info("Agent created successfully", {
      newAgentId,
      name,
      model: model || "inherited from template",
      template: templateId,
    });

    return res.status(201).json({
      success: true,
      agentId: newAgentId,
      agent: savedAgent,
      openclawOutput: ocResult,
    });
  } catch (error) {
    logger.error("Create agent failed", error, {
      templateId: req.body?.agentId,
      name: req.body?.name,
    });
    return res
      .status(500)
      .json({ error: error.message || "Failed to create agent" });
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
      agentIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
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
