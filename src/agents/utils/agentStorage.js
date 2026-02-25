import fs from "fs";
import path from "path";
import os from "os";

/**
 * Agent Storage
 * Simple file-based storage for agent metadata
 * Stores metadata specific to the OpenClaw Wrapper REST API
 *
 * This is separate from OpenClaw's native config to keep concerns cleanly separated:
 * - OpenClaw config: $OPENCLAW_STATE_DIR/openclaw.json (at /data/.openclaw on Railway)
 * - OpenClaw workspace: $OPENCLAW_WORKSPACE_DIR (at /data/workspace on Railway)
 * - Wrapper API metadata: $OPENCLAW_WRAPPER_DIR/agents.json (at /data/openclaw-wrapper on Railway)
 *
 * Location: Uses OPENCLAW_WRAPPER_DIR env var
 * Defaults: /data/openclaw-wrapper (Railway), ~/.openclaw-wrapper (local development)
 */
class AgentStorage {
  constructor() {
    // Determine wrapper data directory
    // On Railway: OPENCLAW_WRAPPER_DIR=/data/openclaw-wrapper
    // Locally: ~/.openclaw-wrapper
    let wrapperDir;

    if (process.env.OPENCLAW_WRAPPER_DIR?.trim()) {
      wrapperDir = process.env.OPENCLAW_WRAPPER_DIR.trim();
    } else if (
      process.env.NODE_ENV === "production" ||
      process.env.RAILWAY_ENVIRONMENT_NAME
    ) {
      // Default to /data/openclaw-wrapper on Railway
      wrapperDir = "/data/openclaw-wrapper";
    } else {
      // Local development: ~/.openclaw-wrapper
      wrapperDir = path.join(os.homedir(), ".openclaw-wrapper");
    }

    this.wrapperDir = wrapperDir;
    this.agentsFile = path.join(this.wrapperDir, "agents.json");
    this.ensureStorage();
  }

  /**
   * Ensure storage directory exists
   */
  ensureStorage() {
    if (!fs.existsSync(this.wrapperDir)) {
      fs.mkdirSync(this.wrapperDir, { recursive: true });
    }
    if (!fs.existsSync(this.agentsFile)) {
      fs.writeFileSync(this.agentsFile, JSON.stringify({}, null, 2), "utf8");
    }
  }

  /**
   * Read all agents metadata
   * @returns {object} - Agent metadata map
   */
  readAgents() {
    try {
      const content = fs.readFileSync(this.agentsFile, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`Error reading agents storage: ${error.message}`);
      return {};
    }
  }

  /**
   * Write agents metadata
   * @param {object} agents - Agent metadata map
   */
  writeAgents(agents) {
    try {
      fs.writeFileSync(
        this.agentsFile,
        JSON.stringify(agents, null, 2),
        "utf8",
      );
    } catch (error) {
      throw {
        statusCode: 500,
        message: `Failed to write agents metadata: ${error.message}`,
      };
    }
  }

  /**
   * Save agent metadata
   * @param {string} agentId - Agent ID
   * @param {object} metadata - Metadata to save
   */
  saveAgent(agentId, metadata) {
    const agents = this.readAgents();
    agents[agentId] = {
      id: agentId,
      createdAt: agents[agentId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...metadata,
    };
    this.writeAgents(agents);
    return agents[agentId];
  }

  /**
   * Get agent metadata
   * @param {string} agentId - Agent ID
   * @returns {object|null}
   */
  getAgent(agentId) {
    const agents = this.readAgents();
    return agents[agentId] || null;
  }

  /**
   * Get all agents
   * @returns {array}
   */
  getAllAgents() {
    const agents = this.readAgents();
    return Object.values(agents);
  }

  /**
   * Delete agent metadata
   * @param {string} agentId - Agent ID
   */
  deleteAgent(agentId) {
    const agents = this.readAgents();
    delete agents[agentId];
    this.writeAgents(agents);
  }

  /**
   * Update agent metadata (merge)
   * @param {string} agentId - Agent ID
   * @param {object} metadata - Metadata to merge
   */
  updateAgent(agentId, metadata) {
    const existingAgent = this.getAgent(agentId);
    if (!existingAgent) {
      throw {
        statusCode: 404,
        message: `Agent ${agentId} not found`,
      };
    }

    return this.saveAgent(agentId, {
      ...existingAgent,
      ...metadata,
    });
  }
}

export default new AgentStorage();
