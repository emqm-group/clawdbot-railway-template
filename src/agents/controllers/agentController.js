import openclawService from "../utils/openclawService.js";
import configManager from "../utils/configManager.js";
import agentStorage from "../utils/agentStorage.js";
import logger from "../utils/logger.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

/**
 * Agent Controller
 * Handles all agent-related API requests
 */

/**
 * POST /api/agents
 * Create a new agent
 */
export const createAgent = async (req, res, next) => {
  try {
    const { agentId, name, workspace, model, config, templateId } = req.body;

    logger.info("POST /api/agents - Create agent request", {
      agentId,
      name,
      templateId,
    });

    // Validate required fields
    if (!agentId) {
      logger.warn("Create agent failed: missing agentId");
      return res.status(400).json({ error: "agentId is required" });
    }

    // Check if agent already exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (existingAgent) {
      logger.warn("Create agent failed: agent already exists", { agentId });
      return res.status(409).json({ error: `Agent ${agentId} already exists` });
    }

    logger.info("Creating agent via OpenClaw CLI", {
      agentId,
      workspace,
      name,
    });

    // Create agent using OpenClaw CLI
    const ocResult = await openclawService.createAgent(agentId, {
      workspace,
      name,
    });

    logger.debug("OpenClaw agent created", { agentId, output: ocResult });

    // Prepare default paths
    const defaultWorkspace =
      workspace || `~/data/.openclaw/workspace-${agentId}`;
    const defaultAgentDir = `~/data/.openclaw/agents/${agentId}/agent`;

    let agentConfig = {
      workspace: defaultWorkspace,
      agentDir: defaultAgentDir,
      ...(name && { name }),
      ...(model && { model }),
      ...(config && config),
    };

    // If a templateId is provided, clone the template's files exactly
    if (templateId) {
      logger.info("Template cloning requested", { agentId, templateId });

      // Find template config (from openclaw config) or storage
      const templateConfig = configManager.getAgentConfig(templateId);
      const templateMeta = agentStorage.getAgent(templateId);
      if (!templateConfig && !templateMeta) {
        logger.error("Template agent not found", null, { templateId });
        return res
          .status(404)
          .json({ error: `Template agent ${templateId} not found` });
      }

      // Resolve template paths (prefer configManager values)
      const templateWorkspace =
        (templateConfig && templateConfig.workspace) ||
        (templateMeta && templateMeta.workspace) ||
        `~/data/.openclaw/workspace-${templateId}`;
      const templateAgentDir =
        (templateConfig && templateConfig.agentDir) ||
        (templateMeta && templateMeta.agentDir) ||
        `~/data/.openclaw/agents/${templateId}/agent`;

      logger.debug("Template paths resolved", {
        templateWorkspace,
        templateAgentDir,
      });

      // Resolve actual filesystem paths (expand ~)
      const homeDir = process.env.HOME || os.homedir();
      const expand = (p) =>
        p.startsWith("~") ? path.join(homeDir, p.slice(1)) : p;
      const srcAgentDirCandidate = expand(templateAgentDir);
      const srcWorkspaceCandidate = expand(templateWorkspace);

      // Resolve existing source paths from several common locations
      const resolveExisting = async (candidates) => {
        for (const c of candidates) {
          try {
            const stat = await fs.stat(c);
            if (stat) return c;
          } catch (e) {
            // continue
          }
        }
        return null;
      };

      const srcAgentDir =
        (await resolveExisting([
          srcAgentDirCandidate,
          path.join(homeDir, ".openclaw", "agents", templateId, "agent"),
          path.join(
            homeDir,
            "data",
            ".clawdbot",
            "agents",
            templateId,
            "agent",
          ),
          path.join(process.cwd(), templateAgentDir),
        ])) || srcAgentDirCandidate;

      const srcWorkspace =
        (await resolveExisting([
          srcWorkspaceCandidate,
          path.join(homeDir, ".openclaw", `workspace-${templateId}`),
          path.join(homeDir, "data", ".clawdbot", `workspace-${templateId}`),
          path.join(process.cwd(), templateWorkspace),
        ])) || srcWorkspaceCandidate;
      const dstAgentDir = expand(defaultAgentDir);
      const dstWorkspace = expand(defaultWorkspace);

      // Ensure destination directories exist
      await fs.mkdir(path.dirname(dstAgentDir), { recursive: true });
      await fs.mkdir(dstWorkspace, { recursive: true });

      // Debug info: resolved source and destination paths
      logger.debug("Template copy paths resolved", {
        templateId,
        srcAgentDir,
        srcWorkspace,
        dstAgentDir,
        dstWorkspace,
      });

      // Copy agentDir and workspace from template to new agent (overwrite)
      // Use fs.cp when available (Node 22+), fallback to manual copy otherwise
      logger.info("Copying template files", {
        srcAgentDir,
        dstAgentDir,
        srcWorkspace,
        dstWorkspace,
      });

      if (fs.cp) {
        logger.debug("Using fs.cp for file copy");
        await fs.cp(srcAgentDir, dstAgentDir, { recursive: true, force: true });
        await fs.cp(srcWorkspace, dstWorkspace, {
          recursive: true,
          force: true,
        });
      } else {
        logger.debug("Using fallback copyRecursive for file copy");
        // Simple recursive copy implementation fallback
        const copyRecursive = async (src, dest) => {
          const stats = await fs.stat(src);
          if (stats.isDirectory()) {
            await fs.mkdir(dest, { recursive: true });
            const entries = await fs.readdir(src);
            for (const entry of entries) {
              await copyRecursive(
                path.join(src, entry),
                path.join(dest, entry),
              );
            }
          } else {
            await fs.copyFile(src, dest);
          }
        };
        await copyRecursive(srcAgentDir, dstAgentDir);
        await copyRecursive(srcWorkspace, dstWorkspace);
      }

      logger.info("Template files copied successfully", {
        agentId,
        templateId,
      });

      // Clone template's agent config into new agent config (preserve fields)
      const cloned = {
        ...(templateConfig || {}),
        workspace: defaultWorkspace,
        agentDir: defaultAgentDir,
      };
      agentConfig = { ...agentConfig, ...cloned };
    }

    // Persist agent config to OpenClaw config
    logger.info("Updating agent config in OpenClaw", { agentId });
    configManager.updateAgentInConfig(agentId, agentConfig);

    // Save agent metadata
    const metadata = {
      id: agentId,
      name: name || agentId,
      workspace: agentConfig.workspace,
      agentDir: agentConfig.agentDir,
      model: agentConfig.model || model || "google/gemini-2.5-flash-lite",
      createdAt: new Date().toISOString(),
      status: "created",
      ...(config && { customConfig: config }),
      ...(templateId && { template: templateId }),
    };

    logger.info("Saving agent metadata", { agentId, model: metadata.model });
    const savedAgent = agentStorage.saveAgent(agentId, metadata);

    logger.info("Agent created successfully", { agentId, name: metadata.name });
    res.status(201).json({
      success: true,
      agent: savedAgent,
      openclawOutput: ocResult,
    });
  } catch (error) {
    logger.error("Create agent failed", error, { agentId: req.body?.agentId });
    res.status(500).json({ error: error.message || "Failed to create agent" });
  }
};

/**
 * GET /api/agents/:agentId
 * Get agent details
 */
export const getAgent = async (req, res, next) => {
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
    res.status(500).json({ error: error.message || "Failed to retrieve agent" });
  }
};

/**
 * GET /api/agents
 * List all agents
 */
export const listAgents = async (req, res, next) => {
  try {
    logger.info("GET /api/agents - List all agents");

    const agents = agentStorage.getAllAgents();
    logger.debug("Agents retrieved from storage", { count: agents.length });

    try {
      const ocStatus = await openclawService.listAgents();
      logger.debug("OpenClaw agent status retrieved");

      res.json({
        success: true,
        count: agents.length,
        agents,
        openclawStatus: ocStatus.raw || null,
      });
    } catch (ocError) {
      logger.warn("OpenClaw list failed, returning stored agents", {
        error: ocError.message,
      });
      // If openclaw list fails, still return stored agents
      const agents = agentStorage.getAllAgents();
      res.json({
        success: true,
        count: agents.length,
        agents,
        openclawStatus: "unavailable",
      });
    }
  } catch (error) {
    logger.error("List agents failed", error);
    res.status(500).json({ error: error.message || "Failed to list agents" });
  }
};

/**
 * PATCH /api/agents/:agentId
 * Update agent metadata
 */
export const updateAgent = async (req, res, next) => {
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
export const updateAgentConfig = async (req, res, next) => {
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
    res.status(500).json({ error: error.message || "Failed to update agent config" });
  }
};

/**
 * DELETE /api/agents/:agentId
 * Delete an agent
 */
export const deleteAgent = async (req, res, next) => {
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
