import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import logger from "./logger.js";

const execAsync = promisify(exec);

/**
 * OpenClaw Service
 * Wrapper around OpenClaw CLI commands with comprehensive logging
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

      // Run openclaw command to add agent with explicit workspace
      const command = `openclaw agents add ${agentId} --workspace ${workspace}`;
      logger.command(command, { agentId, workspace, name });

      const { stdout, stderr } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        stdout: stdout.substring(0, 200), // Log first 200 chars
        stderr: stderr ? stderr.substring(0, 200) : null,
      });

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
      logger.error("createAgent failed", error, { agentId });
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
   * @param {object} options - Optional paths to remove
   * @param {string} [options.workspace] - Workspace directory path
   * @param {string} [options.agentDir] - Agent state directory path
   * @returns {Promise<object>} - Result of deletion
   */
  async deleteAgent(agentId, options = {}) {
    try {
      // Run openclaw CLI delete — updates openclaw.json but may fail to Trash
      // directories in containerised environments (no Trash available).
      const command = `openclaw agents delete ${agentId} --force`;
      logger.command(command, { agentId });

      const { stdout, stderr } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        stdout: stdout.substring(0, 200),
        stderr: stderr ? stderr.substring(0, 200) : null,
      });

      // Openclaw may fail to move directories to Trash and leave them behind.
      // Manually remove the workspace and agent directories to ensure a clean delete.
      // Use caller-supplied paths when available (user agents live under /data/user-agents/,
      // not /data/.openclaw/).
      const pathsToRemove = [
        options.workspace || `/data/.openclaw/workspace-${agentId}`,
        options.agentDir  || `/data/.openclaw/agents/${agentId}`,
      ];

      // agentDir is typically the inner /agent subdirectory
      // (e.g. /data/user-agents/agents/<id>/agent). Remove the parent
      // so no empty <id>/ directory is left behind.
      if (options.agentDir) {
        pathsToRemove.push(path.dirname(options.agentDir));
      }

      for (const p of pathsToRemove) {
        try {
          await execAsync(`rm -rf ${p}`);
          logger.debug("Removed leftover path", { path: p });
        } catch (rmErr) {
          // Non-fatal: log and continue
          logger.warn("Could not remove path during agent delete", {
            path: p,
            error: rmErr.message,
          });
        }
      }

      return {
        success: true,
        agentId,
        message: `Agent ${agentId} deleted successfully`,
      };
    } catch (error) {
      logger.error("deleteAgent failed", error, { agentId });
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
      logger.command(command);

      const { stdout } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        outputLength: stdout.length,
      });

      // Parse the output (openclaw agents list returns tabular data)
      // For now, return raw output - user can parse as needed
      return {
        success: true,
        agents: stdout,
        raw: stdout,
      };
    } catch (error) {
      logger.error("listAgents failed", error);
      throw {
        statusCode: 400,
        message: `Failed to list agents: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * List all cron jobs
   * @returns {Promise<Array>} - Array of cron job objects
   */
  async listCronJobs() {
    try {
      const command = `openclaw cron list --json`;
      logger.command(command);

      const { stdout } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        outputLength: stdout.length,
      });

      const parsed = JSON.parse(stdout);
      // CLI may return a bare array or an object like { jobs: [...] }
      const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
      return jobs;
    } catch (error) {
      logger.error("listCronJobs failed", error);
      throw {
        statusCode: 400,
        message: `Failed to list cron jobs: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * Delete a cron job by ID
   * @param {string} jobId - Cron job ID to delete
   * @returns {Promise<object>}
   */
  async deleteCronJob(jobId) {
    try {
      const command = `openclaw cron remove ${jobId}`;
      logger.command(command, { jobId });

      const { stdout, stderr } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        stdout: stdout.substring(0, 200),
        stderr: stderr ? stderr.substring(0, 200) : null,
      });

      return { success: true, jobId };
    } catch (error) {
      logger.error("deleteCronJob failed", error, { jobId });
      throw {
        statusCode: 400,
        message: `Failed to delete cron job ${jobId}: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * Check if a specific agent exists in openclaw
   * @param {string} agentId - Agent ID to check
   * @returns {Promise<boolean>}
   */
  async agentExists(agentId) {
    try {
      const command = `openclaw agents list`;
      logger.debug("Checking if agent exists in openclaw", { agentId, command });

      const { stdout } = await execAsync(command);
      const exists = stdout.includes(agentId);

      logger.debug("Agent existence check result", { agentId, exists });
      return exists;
    } catch (error) {
      logger.warn("agentExists CLI check failed, falling back to false", {
        agentId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Validate OpenClaw is installed and running
   * @returns {Promise<boolean>}
   */
  async isOpenClawAvailable() {
    try {
      const command = "which openclaw";
      logger.debug("Checking OpenClaw availability", { command });

      execSync(command, { stdio: "ignore" });
      logger.debug("OpenClaw is available");
      return true;
    } catch {
      logger.warn("OpenClaw not found in PATH");
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
      logger.command(command);

      const { stdout } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        outputLength: stdout.length,
      });

      return {
        success: true,
        status: stdout,
      };
    } catch (error) {
      logger.error("getGatewayStatus failed", error);
      return {
        success: false,
        status: error.message,
      };
    }
  }
}

export default new OpenClawService();
