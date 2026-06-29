import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import logger from "./logger.js";

const execAsync = promisify(exec);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match gateway-down / mid-restart errors. The CLI surfaces these in stderr
// (or sometimes stdout) as:
//   - "ECONNREFUSED"            — port not yet bound
//   - "gateway closed (1006 ...)" / "abnormal closure" / "no close frame"
//     — WS dropped (gateway exiting) or attached too late
//   - "UNAVAILABLE"             — gateway RPC error code for not-ready
const TRANSIENT_GATEWAY_ERROR_RE =
  /econnrefused|gateway closed|abnormal closure|no close frame|unavailable|connection refused|socket hang up/i;

function isTransientGatewayError(err) {
  const blob = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`;
  return TRANSIENT_GATEWAY_ERROR_RE.test(blob);
}

/**
 * OpenClaw Service
 * Wrapper around OpenClaw CLI commands with comprehensive logging
 */
class OpenClawService {
  constructor() {
    // Optional probe injected by server.js. When set, methods that hit the
    // gateway over WS (sessions.list, sessions.reset, ...) await it first so
    // they don't race a SIGTERM'd-but-not-yet-respawned gateway.
    this._ensureGatewayResponsive = null;
  }

  setGatewayReadinessProbe(fn) {
    this._ensureGatewayResponsive = fn;
  }

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
    // Make sure a gateway process exists (or is being spawned). The HTTP
    // readiness probe inside ensureGatewayResponsive lies — it returns true
    // when the gateway's HTTP server is up but WS handlers aren't attached
    // yet (gateway startup attaches WS handlers last) — so we don't trust
    // it for "ready". The real readiness check is the retry loop in
    // _execGatewayCallWithRetry, which probes the actual RPC.
    if (this._ensureGatewayResponsive) {
      try {
        await this._ensureGatewayResponsive();
      } catch (err) {
        logger.warn("resetAgentSession: gateway probe failed, will retry RPC", {
          agentId,
          error: err.message,
        });
      }
    }

    // If a specific session key is provided, reset just that one. Normalize to
    // the same { success, results: [...] } shape the multi-session path returns
    // so callers (controller) can always read result.results.length.
    if (sessionKey) {
      const result = await this._resetSessionByKey(agentId, sessionKey);
      return { success: result.success, results: [{ key: sessionKey, ...result }] };
    }

    // Otherwise list all sessions and reset any belonging to this agent.
    // sessions.list failure must propagate — silently treating it as "no
    // sessions" would make the reset a silent no-op while reporting success.
    let parsed;
    try {
      parsed = await this._execGatewayCallWithRetry("sessions.list", null, { agentId });
    } catch (err) {
      const details = (err.stderr || err.stdout || err.message || "").trim();
      logger.error("resetAgentSession: sessions.list failed", { agentId, details });
      throw new Error(`could not list sessions: ${details}`);
    }

    // Response may be { sessions: [...] } or a bare array.
    // Session keys follow the format "agent:<agentId>:<scope>".
    const all = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
    const sessions = all.filter((s) => s.key?.startsWith(`agent:${agentId}:`));

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

    // success reflects reality — false if any individual reset failed. Mirrors
    // the keyed branch above so both paths return the same { success, results }.
    return { success: results.every((r) => r.success), results };
  }

  /**
   * Run `openclaw gateway call <method>` with retries on transient
   * gateway-down errors (mid-restart). Returns parsed JSON on success.
   *
   * Total wait budget: maxAttempts × delayMs (default 20 × 500ms = 10s),
   * which comfortably covers the ~1-2s gateway restart window we observe.
   */
  async _execGatewayCallWithRetry(method, params, ctx = {}, opts = {}) {
    const { maxAttempts = 20, delayMs = 500 } = opts;
    const paramsArg = params ? ` --params '${JSON.stringify(params)}'` : "";
    const command = `openclaw gateway call ${method} --json${paramsArg}`;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt === 1) logger.command(command, ctx);
        const { stdout } = await execAsync(command);
        if (attempt > 1) {
          logger.info(`${method}: succeeded after retry`, { ...ctx, attempts: attempt });
        }
        return JSON.parse(stdout);
      } catch (err) {
        lastErr = err;
        if (!isTransientGatewayError(err)) throw err;
        if (attempt < maxAttempts) {
          await sleep(delayMs);
        }
      }
    }
    throw lastErr;
  }

  async _resetSessionByKey(agentId, sessionKey) {
    try {
      const result = await this._execGatewayCallWithRetry(
        "sessions.reset",
        { key: sessionKey, reason: "reset" },
        { agentId, sessionKey },
      );
      logger.info("resetAgentSession: session reset via gateway RPC", { agentId, sessionKey });
      return { success: true, output: JSON.stringify(result) };
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
   * Enable or disable the system-wide heartbeat.
   * Calls `openclaw system heartbeat enable|disable` — runtime toggle, no config file change.
   * @param {"enable"|"disable"} action
   * @returns {Promise<{ success: boolean, action: string }>}
   */
  async setHeartbeat(action) {
    if (action !== "enable" && action !== "disable") {
      throw { statusCode: 400, message: 'action must be "enable" or "disable"' };
    }
    try {
      const command = `openclaw system heartbeat ${action}`;
      logger.command(command);
      const { stdout, stderr } = await execAsync(command);
      logger.commandResult(command, {
        success: true,
        stdout: stdout.substring(0, 200),
        stderr: stderr ? stderr.substring(0, 200) : null,
      });
      return { success: true, action };
    } catch (error) {
      const details = (error.stderr || error.stdout || error.message || "").trim();
      logger.error("setHeartbeat failed", { action, details });
      throw { statusCode: 500, message: details || `Failed to ${action} heartbeat` };
    }
  }

  /**
   * Get gateway-wide usage cost summary.
   * Wraps `openclaw gateway usage-cost --days N --json`.
   * @param {number} days - Number of days to include (default 30)
   * @returns {Promise<object>} - CostUsageSummary with daily breakdown and totals
   */
  async getUsageCost({ days, startDate, endDate } = {}) {
    // Prefer startDate/endDate when provided; fall back to days (default 30).
    // `openclaw gateway usage-cost` CLI only supports --days, so use the raw
    // RPC call when explicit dates are needed.
    let command;
    if (startDate && endDate) {
      const payload = JSON.stringify({ startDate, endDate });
      command = `openclaw gateway call usage.cost --json --params '${payload}'`;
    } else {
      const d = Math.max(1, Math.min(365, parseInt(days) || 30));
      command = `openclaw gateway call usage.cost --json --params '{"days":${d}}'`;
    }
    logger.command(command, { days, startDate, endDate });
    try {
      const { stdout } = await execAsync(command);
      return JSON.parse(stdout);
    } catch (err) {
      const stdout = err.stdout || "";
      if (stdout.trim()) {
        try { return JSON.parse(stdout); } catch {}
      }
      throw err;
    }
  }

  /**
   * List all active sessions via gateway RPC.
   * @returns {Promise<object[]>} - Array of session objects (key, inputTokens, outputTokens, ...)
   */
  async getSessionsList() {
    const command = `openclaw gateway call sessions.list --json`;
    logger.command(command);
    try {
      const { stdout } = await execAsync(command);
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
    } catch (err) {
      const stdout = err.stdout || "";
      if (stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout);
          return Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Get detailed usage (with USD cost) for a specific session key.
   * Wraps `sessions.usage` gateway RPC.
   * @param {string} sessionKey - e.g. "agent:ceo-agent:main"
   * @returns {Promise<object>} - Full usage object with totals, dailyBreakdown, modelUsage, etc.
   */
  async getSessionUsage(sessionKey, { startDate, endDate } = {}) {
    const params = { key: sessionKey };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    const payload = JSON.stringify(params);
    const command = `openclaw gateway call sessions.usage --json --params '${payload}'`;
    logger.command(command, { sessionKey, startDate, endDate });
    try {
      const { stdout } = await execAsync(command);
      return JSON.parse(stdout);
    } catch (err) {
      // openclaw exits non-zero on config warnings even when stdout is valid JSON.
      // Try to parse stdout before giving up.
      const stdout = err.stdout || "";
      if (stdout.trim()) {
        try {
          return JSON.parse(stdout);
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Get per-turn usage logs (per-message tokens + cost) for a session key.
   * Wraps the `sessions.usage.logs` gateway RPC — the per-turn capture source
   * for task cost tracking. Entries are oldest-first; `tokens`/`cost` are
   * present only on assistant turns. Not downsampled; gateway caps `limit` at
   * 1000 and returns the most-recent N when exceeded.
   * @param {string} sessionKey - e.g. "agent:content-agent-1:main"
   * @param {object} [opts]
   * @param {number} [opts.limit] - max messages (gateway caps at 1000; default 200)
   * @returns {Promise<object>} - `{ logs: [{ timestamp, role, content, tokens?, cost? }, ...] }`
   */
  async getSessionUsageLogs(sessionKey, { limit } = {}) {
    const params = { key: sessionKey };
    if (limit != null) {
      params.limit = Math.max(1, Math.min(1000, parseInt(limit) || 200));
    }
    const payload = JSON.stringify(params);
    const command = `openclaw gateway call sessions.usage.logs --json --params '${payload}'`;
    logger.command(command, { sessionKey, limit });
    try {
      const { stdout } = await execAsync(command);
      return JSON.parse(stdout);
    } catch (err) {
      // openclaw exits non-zero on config warnings even when stdout is valid JSON.
      const stdout = err.stdout || "";
      if (stdout.trim()) {
        try {
          return JSON.parse(stdout);
        } catch {}
      }
      throw err;
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
