import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
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

      // Run openclaw command to add agent with explicit workspace
      const command = `openclaw agents add ${agentId} --workspace ${workspace}`;
      logger.command(command, { agentId, workspace });

      const { stdout, stderr } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        stdout: stdout.substring(0, 200), // Log first 200 chars
        stderr: stderr ? stderr.substring(0, 200) : null,
      });

      return {
        success: true,
        agentId,
        workspace,
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
        // Always remove the openclaw session directory, even for user agents
        // whose agentDir lives under /data/user-agents/ instead.
        ...(options.agentDir ? [`/data/.openclaw/agents/${agentId}`] : []),
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
   * @returns {Promise<array>} - Array of agent objects from openclaw
   */
  async listAgents() {
    try {
      const command = `openclaw agents list --json`;
      logger.command(command);

      const { stdout } = await execAsync(command);

      logger.commandResult(command, {
        success: true,
        outputLength: stdout.length,
      });

      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
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
      const agents = await this.listAgents();
      const exists = agents.some((a) => a.id === agentId);
      logger.debug("Agent existence check result", { agentId, exists });
      return exists;
    } catch (error) {
      logger.warn("agentExists check failed, falling back to false", {
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
   * Reset all active sessions for an agent via the gateway's sessions.reset RPC.
   * Mirrors what the openclaw TUI does when you type /reset or /new:
   * archives transcripts, aborts active runs, clears queues.
   *
   * Requires the gateway to be running. Uses `openclaw gateway call` to invoke
   * the RPC without needing a full WebSocket client.
   *
   * @param {string} agentId
   * @param {string} [sessionKey] - specific session key to reset; if omitted, resets all sessions for the agent
   * @returns {Promise<{ success: boolean, results: object[] }>}
   */
  async resetAgentSession(agentId, sessionKey) {
    // If a specific session key is provided, reset just that one
    if (sessionKey) {
      return this._resetSessionByKey(agentId, sessionKey);
    }

    // Otherwise list all sessions and reset any belonging to this agent
    let sessions = [];
    try {
      const command = `openclaw gateway call sessions.list --json`;
      logger.command(command);
      const { stdout } = await execAsync(command);
      const parsed = JSON.parse(stdout);
      // Response may be { sessions: [...] } or a bare array
      const all = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
      // Session keys follow the format "agent:<agentId>:<scope>"
      sessions = all.filter((s) => s.key?.startsWith(`agent:${agentId}:`));
    } catch (err) {
      logger.warn("resetAgentSession: could not list sessions", { error: err.message });
    }

    if (sessions.length === 0) {
      logger.info("resetAgentSession: no active sessions found for agent", { agentId });
      return { success: true, results: [] };
    }

    const results = [];
    for (const session of sessions) {
      const key = session.key ?? session.sessionKey;
      if (!key) continue;
      const result = await this._resetSessionByKey(agentId, key);
      results.push({ key, ...result });
    }

    return { success: true, results };
  }

  async _resetSessionByKey(agentId, sessionKey) {
    try {
      const payload = JSON.stringify({ key: sessionKey, reason: "reset" });
      const command = `openclaw gateway call sessions.reset --json --params '${payload}'`;
      logger.command(command, { agentId, sessionKey });
      const { stdout } = await execAsync(command);
      logger.info("resetAgentSession: session reset via gateway RPC", { agentId, sessionKey });
      return { success: true, output: stdout.trim() };
    } catch (err) {
      const details = (err.stderr || err.stdout || err.message || "").trim();
      logger.error("resetAgentSession: gateway RPC failed", { agentId, sessionKey, details });
      return { success: false, error: details };
    }
  }

  /**
   * Restart the openclaw gateway.
   * @returns {Promise<{ success: boolean, details: string }>}
   */
  /**
   * Validate an openclaw.json config object before writing.
   * Writes to a temp file and runs `openclaw config validate` against it.
   * @param {object} config - Config object to validate
   * @returns {Promise<{ valid: boolean, error: string|null }>}
   */
  async validateConfig(config) {
    const tmpPath = path.join(os.tmpdir(), `openclaw-validate-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
      const command = `openclaw config validate`;
      logger.command(command, { tmpPath });
      await execAsync(command, {
        env: { ...process.env, OPENCLAW_CONFIG_PATH: tmpPath },
      });
      return { valid: true, error: null };
    } catch (error) {
      const message = (error.stderr || error.stdout || error.message || "").trim();
      logger.warn("Config validation failed", { message });
      return { valid: false, error: message };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  /**
   * Check gateway health.
   * @returns {Promise<{ healthy: boolean, details: string }>}
   */
  async gatewayHealth() {
    try {
      const command = `openclaw gateway health`;
      logger.command(command);
      const { stdout, stderr } = await execAsync(command);
      const details = (stdout || stderr || "").trim();
      return { healthy: true, details };
    } catch (error) {
      const details = (error.stderr || error.stdout || error.message || "").trim();
      logger.warn("Gateway health check failed", { details });
      return { healthy: false, details };
    }
  }

  /**
   * Poll gateway health until it responds healthy or max attempts are exhausted.
   * @param {number} attempts - Number of attempts (default 4)
   * @param {number} intervalMs - Delay between attempts in ms (default 1500)
   * @returns {Promise<{ healthy: boolean, details: string }>}
   */
  async pollGatewayHealth(attempts = 4, intervalMs = 1500) {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      const result = await this.gatewayHealth();
      if (result.healthy) return result;
    }
    return { healthy: false, details: "Gateway did not recover after config update" };
  }

  /**
   * Approve a device pairing request by requestId.
   * Runs `openclaw devices approve <requestId>`.
   * @param {string} requestId
   * @returns {Promise<{ success: boolean, output: string }>}
   */
  async approveDevice(requestId) {
    try {
      const command = `openclaw devices approve ${requestId}`;
      logger.command(command, { requestId });
      const { stdout, stderr } = await execAsync(command);
      const output = (stdout || stderr || "").trim();
      logger.info("approveDevice: approved", { requestId });
      return { success: true, output };
    } catch (error) {
      const details = (error.stderr || error.stdout || error.message || "").trim();
      logger.error("approveDevice failed", { requestId, details });
      throw { statusCode: 500, message: details || `Failed to approve device ${requestId}` };
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
