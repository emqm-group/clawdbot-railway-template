import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * OpenClaw Service
 * Wrapper around OpenClaw CLI commands
 */
class OpenClawService {
  /**
   * Create a new agent
   * @param {string} agentId - Unique agent identifier
   * @param {object} options - Agent creation options
   * @returns {Promise<object>} - Result of agent creation
   */
  async createAgent(agentId, options = {}) {
    try {
      const workspace =
        options.workspace || `/data/.openclaw/workspace-${agentId}`;
      const name = options.name || agentId;

      // Run openclaw command to add agent
      const command = `openclaw agents add ${agentId}`;
      const { stdout, stderr } = await execAsync(command);

      if (stderr && !stderr.includes("successfully")) {
        throw new Error(stderr);
      }

      return {
        success: true,
        agentId,
        workspace,
        name,
        message: `Agent ${agentId} created successfully`,
        output: stdout,
      };
    } catch (error) {
      throw {
        statusCode: 400,
        message: `Failed to create agent: ${error.message}`,
        details: error.stderr || error.message,
      };
    }
  }

  /**
   * Delete an agent
   * @param {string} agentId - Agent identifier to delete
   * @returns {Promise<object>} - Result of deletion
   */
  async deleteAgent(agentId) {
    try {
      // This is a placeholder as openclaw CLI may not have direct delete
      // In practice, you'd need to clean up the agent directory
      const command = `rm -rf /data/.openclaw/agents/${agentId}`;
      await execAsync(command);

      return {
        success: true,
        agentId,
        message: `Agent ${agentId} deleted successfully`,
      };
    } catch (error) {
      throw {
        statusCode: 400,
        message: `Failed to delete agent: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * List all agents
   * @returns {Promise<array>} - List of agents from openclaw
   */
  async listAgents() {
    try {
      const command = `openclaw agents list --bindings`;
      const { stdout } = await execAsync(command);

      // Parse the output (openclaw agents list returns tabular data)
      // For now, return raw output - user can parse as needed
      return {
        success: true,
        agents: stdout,
        raw: stdout,
      };
    } catch (error) {
      throw {
        statusCode: 400,
        message: `Failed to list agents: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * Validate OpenClaw is installed and running
   * @returns {Promise<boolean>}
   */
  async isOpenClawAvailable() {
    try {
      execSync("which openclaw", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get OpenClaw gateway status
   * @returns {Promise<object>} - Gateway status
   */
  async getGatewayStatus() {
    try {
      const command = `openclaw status`;
      const { stdout } = await execAsync(command);
      return {
        success: true,
        status: stdout,
      };
    } catch (error) {
      return {
        success: false,
        status: error.message,
      };
    }
  }
}

export default new OpenClawService();
