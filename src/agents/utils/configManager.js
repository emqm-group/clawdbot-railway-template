import fs from "fs";
import path from "path";
import os from "os";
import logger from "./logger.js";

/**
 * Reject any config that enables tools.elevated globally or on a per-agent entry.
 * Throws a structured { statusCode: 400, message } that propagates to HTTP callers.
 */
function assertNoElevatedTools(config) {
  if (config?.tools?.elevated?.enabled === true) {
    logger.warn("configManager: rejected write — global tools.elevated.enabled=true");
    throw {
      statusCode: 400,
      message:
        "Refused: tools.elevated.enabled=true is not permitted at the global level on a shared shard",
    };
  }
  if (Array.isArray(config?.agents?.list)) {
    for (const agent of config.agents.list) {
      if (agent?.tools?.elevated?.enabled === true) {
        logger.warn("configManager: rejected write — per-agent tools.elevated.enabled=true", {
          agentId: agent.id ?? "(unknown)",
        });
        throw {
          statusCode: 400,
          message: `Refused: tools.elevated.enabled=true is not permitted on agent ${agent.id ?? "(unknown)"}`,
        };
      }
    }
  }
}

/**
 * Simple async mutex — prevents concurrent read-modify-write races on the config file.
 * Only protects in-process concurrency; the openclaw gateway has its own atomic write
 * mechanism (temp file + rename) for cross-process safety.
 */
class Mutex {
  constructor() {
    this._queue = Promise.resolve();
  }
  acquire(fn) {
    const result = this._queue.then(fn);
    this._queue = result.catch(() => {});
    return result;
  }
}

/**
 * OpenClaw Config Manager
 * Handles reading and writing the /data/.openclaw/openclaw.json config file
 * All file operations are logged for transparency
 */
class ConfigManager {
  constructor() {
    // Prefer OPENCLAW_STATE_DIR env var (set to /data/.openclaw on Railway).
    // Fall back to ~/.openclaw for local development.
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
      || path.join(os.homedir(), ".openclaw");
    this.configPath = path.join(stateDir, "openclaw.json");
    this.configDir = path.dirname(this.configPath);
    this._mutex = new Mutex();
  }

  /**
   * Ensure the .openclaw directory exists
   */
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      logger.debug("Creating config directory", { path: this.configDir });
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Read the current OpenClaw config.
   * Returns default config only when the file does not exist yet.
   * Throws if the file exists but cannot be read or parsed — prevents
   * a bad read from silently triggering a write that overwrites real config.
   * @returns {object} - Current configuration
   */
  readConfig() {
    this.ensureConfigDir();

    if (!fs.existsSync(this.configPath)) {
      logger.debug("Config file not found, using default", { path: this.configPath });
      return this.getDefaultConfig();
    }

    logger.debug("Reading OpenClaw config", { path: this.configPath });
    const content = fs.readFileSync(this.configPath, "utf8");
    const config = JSON.parse(content);
    logger.debug("Config parsed successfully");
    return config;
  }

  /**
   * Write the OpenClaw config.
   *
   * Defence-in-depth (Wrapper Impl #4): refuses any config that enables
   * tools.elevated — either globally (`tools.elevated.enabled: true`) or on
   * any agent (`agents.list[i].tools.elevated.enabled: true`). tools.elevated
   * is openclaw's escape hatch that runs listed tools on the host with full
   * gateway privileges (see https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated.md);
   * on a shared shard this is a cross-tenant leak vector. Primary enforcement
   * lives on the orchestrator side (Decision #3 rule 3); this is the wrapper-side
   * backstop that runs on every write, regardless of which endpoint triggered it.
   *
   * @param {object} config - Configuration to write
   */
  writeConfig(config) {
    try {
      this.ensureConfigDir();
      assertNoElevatedTools(config);
      const content = JSON.stringify(config, null, 2);
      logger.debug("Writing OpenClaw config", { path: this.configPath });
      fs.writeFileSync(this.configPath, content, "utf8");
      logger.debug("OpenClaw config written successfully");
      return true;
    } catch (error) {
      // Re-throw structured errors (statusCode + message) unchanged so HTTP
      // controllers can propagate the correct status.
      if (error && typeof error === "object" && error.statusCode) throw error;
      logger.error("Failed to write config", error, { path: this.configPath });
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
   * Add or update an agent in the config.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID
   * @param {object} agentConfig - Agent configuration
   */
  updateAgentInConfig(agentId, agentConfig) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (!config.agents) {
        config.agents = { list: [], defaults: {} };
      }
      if (!Array.isArray(config.agents.list)) {
        config.agents.list = [];
      }

      const existingIndex = config.agents.list.findIndex((a) => a.id === agentId);
      const agentEntry = {
        id: agentId,
        workspace: agentConfig.workspace || `/data/.openclaw/workspace-${agentId}`,
        agentDir: agentConfig.agentDir || `/data/.openclaw/agents/${agentId}/agent`,
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
    });
  }

  /**
   * Remove an agent from the config.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID to remove
   */
  removeAgentFromConfig(agentId) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (config.agents && Array.isArray(config.agents.list)) {
        config.agents.list = config.agents.list.filter((a) => a.id !== agentId);
      }

      if (Array.isArray(config.bindings)) {
        config.bindings = config.bindings.filter((b) => b.agentId !== agentId);
      }

      this.writeConfig(config);
    });
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
   * Patch agent config (merge with existing).
   * Serialised via mutex — reads and writes inside a single locked operation
   * to prevent races with concurrent updateAgentInConfig calls.
   * @param {string} agentId - Agent ID
   * @param {object} configPatch - Partial config to merge
   */
  patchAgentConfig(agentId, configPatch) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();
      const existingConfig = config.agents?.list?.find((a) => a.id === agentId);

      if (!existingConfig) {
        throw {
          statusCode: 404,
          message: `Agent ${agentId} not found in config`,
        };
      }

      const mergedConfig = {
        ...existingConfig,
        ...configPatch,
        id: agentId,
      };

      const existingIndex = config.agents.list.findIndex((a) => a.id === agentId);
      config.agents.list[existingIndex] = mergedConfig;

      this.writeConfig(config);
      return mergedConfig;
    });
  }

  /**
   * Add or remove tool names from the global tools.alsoAllow list.
   * Plugin tools (registered via api.registerTool) must appear in the global
   * tools.alsoAllow to be injected into agent sessions.  tools.allow would
   * restrict built-in tools as well; alsoAllow is additive-only.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {"add"|"remove"} action
   * @param {string[]} toolNames
   */
  patchGlobalToolsAlsoAllow(action, toolNames) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();
      const currentAlsoAllow = config.tools?.alsoAllow ?? [];

      let newAlsoAllow;
      if (action === "add") {
        const toAdd = toolNames.filter((n) => !currentAlsoAllow.includes(n));
        if (toAdd.length === 0) return;
        newAlsoAllow = [...currentAlsoAllow, ...toAdd];
      } else {
        const toRemove = new Set(toolNames);
        newAlsoAllow = currentAlsoAllow.filter((n) => !toRemove.has(n));
        if (newAlsoAllow.length === currentAlsoAllow.length) return;
      }

      const updated = {
        ...config,
        tools: { ...(config.tools ?? {}), alsoAllow: newAlsoAllow },
      };
      this.writeConfig(updated);
      logger.info("ConfigManager: patched global tools.alsoAllow", { action, toolNames });
    });
  }

  /**
   * Write the third-party-tools plugin config block into openclaw.json.
   * This replaces the CLI-based `plugins install --link` + `plugins enable` approach
   * with a direct config write, which is idempotent and does not require openclaw
   * CLI commands to succeed at startup.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} pluginPath - Absolute path to the plugin directory
   */
  ensureThirdPartyToolsPlugin(pluginPath) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      const pluginsSection = config.plugins ?? {};

      // plugins.allow — security gate; must include the plugin ID
      const currentAllow = pluginsSection.allow ?? [];
      const allow = currentAllow.includes("third-party-tools")
        ? currentAllow
        : [...currentAllow, "third-party-tools"];

      // plugins.load.paths — discovery path for the plugin
      const currentPaths = pluginsSection.load?.paths ?? [];
      const paths = currentPaths.includes(pluginPath)
        ? currentPaths
        : [...currentPaths, pluginPath];

      // plugins.entries — per-plugin enabled flag
      const entries = {
        ...(pluginsSection.entries ?? {}),
        "third-party-tools": {
          ...(pluginsSection.entries?.["third-party-tools"] ?? {}),
          enabled: true,
        },
      };

      // plugins.installs — install record (idempotent: keep existing installedAt)
      const existingInstall = pluginsSection.installs?.["third-party-tools"] ?? {};
      const installs = {
        ...(pluginsSection.installs ?? {}),
        "third-party-tools": {
          source: "path",
          sourcePath: pluginPath,
          installPath: pluginPath,
          version: "1.0.0",
          installedAt: existingInstall.installedAt ?? new Date().toISOString(),
        },
      };

      const updated = {
        ...config,
        plugins: {
          ...pluginsSection,
          allow,
          load: { ...(pluginsSection.load ?? {}), paths },
          entries,
          installs,
        },
      };

      this.writeConfig(updated);
      logger.info("ConfigManager: ensured third-party-tools plugin config", { pluginPath });
    });
  }

  /**
   * Write the king-cross-tools plugin config block into openclaw.json.
   * Mirrors ensureThirdPartyToolsPlugin — idempotent direct config write.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} pluginPath - Absolute path to the plugin directory
   */
  ensureKingsCrossToolsPlugin(pluginPath) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      const pluginsSection = config.plugins ?? {};

      // plugins.allow — security gate; must include the plugin ID
      const currentAllow = pluginsSection.allow ?? [];
      const allow = currentAllow.includes("king-cross-tools")
        ? currentAllow
        : [...currentAllow, "king-cross-tools"];

      // plugins.load.paths — discovery path for the plugin
      const currentPaths = pluginsSection.load?.paths ?? [];
      const paths = currentPaths.includes(pluginPath)
        ? currentPaths
        : [...currentPaths, pluginPath];

      // plugins.entries — per-plugin enabled flag
      const entries = {
        ...(pluginsSection.entries ?? {}),
        "king-cross-tools": {
          ...(pluginsSection.entries?.["king-cross-tools"] ?? {}),
          enabled: true,
        },
      };

      // plugins.installs — install record (idempotent: keep existing installedAt)
      const existingInstall = pluginsSection.installs?.["king-cross-tools"] ?? {};
      const installs = {
        ...(pluginsSection.installs ?? {}),
        "king-cross-tools": {
          source: "path",
          sourcePath: pluginPath,
          installPath: pluginPath,
          version: "1.0.0",
          installedAt: existingInstall.installedAt ?? new Date().toISOString(),
        },
      };

      const updated = {
        ...config,
        plugins: {
          ...pluginsSection,
          allow,
          load: { ...(pluginsSection.load ?? {}), paths },
          entries,
          installs,
        },
      };

      this.writeConfig(updated);
      logger.info("ConfigManager: ensured king-cross-tools plugin config", { pluginPath });
    });
  }

  /**
   * Write the fs-tenant-guard plugin config block into openclaw.json.
   * Same shape as ensureThirdPartyToolsPlugin / ensureKingsCrossToolsPlugin.
   * This plugin registers only a before_tool_call hook — it does not register
   * any tools, so there is no tools.alsoAllow entry to maintain.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} pluginPath - Absolute path to the plugin directory
   */
  ensureFsTenantGuardPlugin(pluginPath) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      const pluginsSection = config.plugins ?? {};

      const currentAllow = pluginsSection.allow ?? [];
      const allow = currentAllow.includes("fs-tenant-guard")
        ? currentAllow
        : [...currentAllow, "fs-tenant-guard"];

      const currentPaths = pluginsSection.load?.paths ?? [];
      const paths = currentPaths.includes(pluginPath)
        ? currentPaths
        : [...currentPaths, pluginPath];

      const entries = {
        ...(pluginsSection.entries ?? {}),
        "fs-tenant-guard": {
          ...(pluginsSection.entries?.["fs-tenant-guard"] ?? {}),
          enabled: true,
        },
      };

      const existingInstall = pluginsSection.installs?.["fs-tenant-guard"] ?? {};
      const installs = {
        ...(pluginsSection.installs ?? {}),
        "fs-tenant-guard": {
          source: "path",
          sourcePath: pluginPath,
          installPath: pluginPath,
          version: "1.0.0",
          installedAt: existingInstall.installedAt ?? new Date().toISOString(),
        },
      };

      const updated = {
        ...config,
        plugins: {
          ...pluginsSection,
          allow,
          load: { ...(pluginsSection.load ?? {}), paths },
          entries,
          installs,
        },
      };

      this.writeConfig(updated);
      logger.info("ConfigManager: ensured fs-tenant-guard plugin config", { pluginPath });
    });
  }

  /**
   * Add the KC tool names to the global tools.alsoAllow list so agents can invoke them.
   * Idempotent — skips names already present.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   */
  ensureKingsCrossToolsAlsoAllow() {
    const KC_TOOLS = [
      "kc_get_next_task",
      "kc_get_task",
      "kc_update_task",
      "kc_create_task",
    ];
    return this.patchGlobalToolsAlsoAllow("add", KC_TOOLS);
  }

  /**
   * Add a binding to route messages to an agent.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID
   * @param {object} matchCriteria - Matching criteria (channel, accountId, peer, etc.)
   */
  addBinding(agentId, matchCriteria) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (!Array.isArray(config.bindings)) {
        config.bindings = [];
      }

      const binding = { agentId, match: matchCriteria };
      config.bindings.push(binding);
      this.writeConfig(config);
      return binding;
    });
  }
}

export default new ConfigManager();
