import fs from "fs";
import path from "path";
import logger from "./logger.js";

const MANIFEST_PATH = path.join(
  process.env.OPENCLAW_STATE_DIR || "/data/.openclaw",
  "tools-manifest.json"
);

/**
 * Read the tools manifest from disk.
 * Returns { tools: [{ name, description, parameters }] }
 */
function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return { tools: [] };
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    logger.error("toolsManifest: failed to read manifest", { error: err.message });
    return { tools: [] };
  }
}

/**
 * Write the tools manifest atomically.
 */
function writeManifest(manifest) {
  const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, MANIFEST_PATH);
}

/**
 * Add tools to the manifest. Per-agent ownership lives in each agent's
 * `tools.allow` (patched separately by toolsController); the plugin uses
 * ctx.agentId at invocation time to identify the caller, so the manifest
 * does not track agents.
 *
 * Remove is a no-op: per-agent allow-list removal happens elsewhere, and an
 * orphaned manifest entry is harmless because no agent references it.
 *
 * @param {"add"|"remove"} action
 * @param {object[]} tools - array of { name, description, parameters }
 */
export function applyToolsUpdate(action, tools) {
  if (action !== "add") return;

  const manifest = readManifest();

  for (const tool of tools) {
    manifest.tools = manifest.tools.filter((t) => t.name !== tool.name);
    manifest.tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  writeManifest(manifest);
  logger.info("toolsManifest: manifest updated", {
    action,
    toolCount: tools.length,
  });
}
