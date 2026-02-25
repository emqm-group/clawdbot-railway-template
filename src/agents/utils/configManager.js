import fs from "fs";
import path from "path";
import os from "os";

/**
 * OpenClaw Config Manager
 * Handles reading and writing the /data/.openclaw/openclaw.json config file
 */
class ConfigManager {
  constructor() {
    this.configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    this.configDir = path.dirname(this.configPath);
  }

  /**
   * Ensure the .openclaw directory exists
   */
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Read the current OpenClaw config
   * @returns {object} - Current configuration
   */
  readConfig() {
    try {
      this.ensureConfigDir();
      if (!fs.existsSync(this.configPath)) {
        return this.getDefaultConfig();
      }
      const content = fs.readFileSync(this.configPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`Error reading config: ${error.message}`);
      return this.getDefaultConfig();
    }
  }

  /**
   * Write the OpenClaw config
   * @param {object} config - Configuration to write
   */
  writeConfig(config) {
    try {
      this.ensureConfigDir();
      const content = JSON.stringify(config, null, 2);
      fs.writeFileSync(this.configPath, content, "utf8");
      return true;
    } catch (error) {
      throw {
        statusCode: 500,
        message: `Failed to write config: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * Get default empty config
   * @returns {object}
   */
  getDefaultConfig() {
    return {
      agents: {
        list: [],
        defaults: {
          workspace: `/data/.openclaw/workspace`,
        },
      },
      channels: {},
      bindings: [],
    };
  }

  /**
   * Add or update an agent in the config
   * @param {string} agentId - Agent ID
   * @param {object} agentConfig - Agent configuration
   */
  updateAgentInConfig(agentId, agentConfig) {
    const config = this.readConfig();

    // Initialize agents.list if needed
    if (!config.agents) {
      config.agents = { list: [], defaults: {} };
    }
    if (!Array.isArray(config.agents.list)) {
      config.agents.list = [];
    }

    // Find or create agent entry
    const existingIndex = config.agents.list.findIndex((a) => a.id === agentId);
    const agentEntry = {
      id: agentId,
      workspace:
        agentConfig.workspace || `/data/.openclaw/workspace-${agentId}`,
      agentDir:
        agentConfig.agentDir || `/data/.openclaw/agents/${agentId}/agent`,
      ...agentConfig,
    };

    if (existingIndex >= 0) {
      config.agents.list[existingIndex] = {
        ...config.agents.list[existingIndex],
        ...agentEntry,
      };
    } else {
      config.agents.list.push(agentEntry);
    }

    this.writeConfig(config);
    return agentEntry;
  }

  /**
   * Remove an agent from the config
   * @param {string} agentId - Agent ID to remove
   */
  removeAgentFromConfig(agentId) {
    const config = this.readConfig();

    if (config.agents && Array.isArray(config.agents.list)) {
      config.agents.list = config.agents.list.filter((a) => a.id !== agentId);
    }

    // Remove bindings for this agent
    if (Array.isArray(config.bindings)) {
      config.bindings = config.bindings.filter((b) => b.agentId !== agentId);
    }

    this.writeConfig(config);
  }

  /**
   * Get agent config from the main config
   * @param {string} agentId - Agent ID
   * @returns {object|null}
   */
  getAgentConfig(agentId) {
    const config = this.readConfig();
    if (config.agents && Array.isArray(config.agents.list)) {
      return config.agents.list.find((a) => a.id === agentId) || null;
    }
    return null;
  }

  /**
   * Patch agent config (merge with existing)
   * @param {string} agentId - Agent ID
   * @param {object} configPatch - Partial config to merge
   */
  patchAgentConfig(agentId, configPatch) {
    const existingConfig = this.getAgentConfig(agentId);
    if (!existingConfig) {
      throw {
        statusCode: 404,
        message: `Agent ${agentId} not found in config`,
      };
    }

    const mergedConfig = {
      ...existingConfig,
      ...configPatch,
      id: agentId, // Ensure ID doesn't get overwritten
    };

    return this.updateAgentInConfig(agentId, mergedConfig);
  }

  /**
   * Add a binding to route messages to an agent
   * @param {string} agentId - Agent ID
   * @param {object} matchCriteria - Matching criteria (channel, accountId, peer, etc.)
   */
  addBinding(agentId, matchCriteria) {
    const config = this.readConfig();

    if (!Array.isArray(config.bindings)) {
      config.bindings = [];
    }

    const binding = {
      agentId,
      match: matchCriteria,
    };

    config.bindings.push(binding);
    this.writeConfig(config);
    return binding;
  }
}

export default new ConfigManager();
