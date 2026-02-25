import openclawService from "../utils/openclawService.js";
import configManager from "../utils/configManager.js";
import agentStorage from "../utils/agentStorage.js";
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

    // Validate required fields
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }

    // Check if agent already exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (existingAgent) {
      return res.status(409).json({ error: `Agent ${agentId} already exists` });
    }

    // Create agent using OpenClaw CLI
    const ocResult = await openclawService.createAgent(agentId, {
      workspace,
      name,
    });

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
      // Find template config (from openclaw config) or storage
      const templateConfig = configManager.getAgentConfig(templateId);
      const templateMeta = agentStorage.getAgent(templateId);
      if (!templateConfig && !templateMeta) {
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
      console.debug("Template copy:", {
        templateId,
        srcAgentDir,
        srcWorkspace,
        dstAgentDir,
        dstWorkspace,
      });

      // Copy agentDir and workspace from template to new agent (overwrite)
      // Use fs.cp when available (Node 22+), fallback to manual copy otherwise
      if (fs.cp) {
        await fs.cp(srcAgentDir, dstAgentDir, { recursive: true, force: true });
        await fs.cp(srcWorkspace, dstWorkspace, {
          recursive: true,
          force: true,
        });
      } else {
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

      // Clone template's agent config into new agent config (preserve fields)
      const cloned = {
        ...(templateConfig || {}),
        workspace: defaultWorkspace,
        agentDir: defaultAgentDir,
      };
      agentConfig = { ...agentConfig, ...cloned };
    }

    // Persist agent config to OpenClaw config
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

    const savedAgent = agentStorage.saveAgent(agentId, metadata);

    res.status(201).json({
      success: true,
      agent: savedAgent,
      openclawOutput: ocResult,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/agents/:agentId
 * Get agent details
 */
export const getAgent = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    const agent = agentStorage.getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Enrich with config data
    const configAgent = configManager.getAgentConfig(agentId);

    res.json({
      success: true,
      agent: {
        ...agent,
        ...(configAgent && { openclawConfig: configAgent }),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/agents
 * List all agents
 */
export const listAgents = async (req, res, next) => {
  try {
    const agents = agentStorage.getAllAgents();
    const ocStatus = await openclawService.listAgents();

    res.json({
      success: true,
      count: agents.length,
      agents,
      openclawStatus: ocStatus.raw || null,
    });
  } catch (error) {
    // If openclaw list fails, still return stored agents
    const agents = agentStorage.getAllAgents();
    res.json({
      success: true,
      count: agents.length,
      agents,
      openclawStatus: "unavailable",
    });
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

    // Verify agent exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Update storage
    const updatedAgent = agentStorage.updateAgent(agentId, updates);

    // Also update in openclaw config if name/workspace/model changed
    if (updates.name || updates.workspace || updates.model) {
      const configUpdate = {};
      if (updates.name) configUpdate.name = updates.name;
      if (updates.workspace) configUpdate.workspace = updates.workspace;
      if (updates.model) configUpdate.model = updates.model;
      configManager.patchAgentConfig(agentId, configUpdate);
    }

    res.json({
      success: true,
      agent: updatedAgent,
    });
  } catch (error) {
    next(error);
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

    // Verify agent exists in storage
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Parse the update
    // Support both { configUpdate: {...} } and direct properties
    let updatePayload = req.body.configUpdate || req.body;

    // Merge into openclaw config
    const updatedConfig = configManager.patchAgentConfig(
      agentId,
      updatePayload,
    );

    // Update storage metadata to reflect custom config
    if (updatePayload.model) {
      agentStorage.updateAgent(agentId, { model: updatePayload.model });
    }

    res.json({
      success: true,
      message: `Config updated for agent ${agentId}`,
      config: updatedConfig,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/agents/:agentId
 * Delete an agent
 */
export const deleteAgent = async (req, res, next) => {
  try {
    const { agentId } = req.params;

    // Verify agent exists
    const existingAgent = agentStorage.getAgent(agentId);
    if (!existingAgent) {
      return res.status(404).json({ error: `Agent ${agentId} not found` });
    }

    // Delete from openclaw
    await openclawService.deleteAgent(agentId);

    // Remove from config
    configManager.removeAgentFromConfig(agentId);

    // Remove from storage
    agentStorage.deleteAgent(agentId);

    res.json({
      success: true,
      message: `Agent ${agentId} deleted successfully`,
    });
  } catch (error) {
    next(error);
  }
};
