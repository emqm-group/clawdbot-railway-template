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
 * Add or remove tools from the manifest.
 * @param {"add"|"remove"} action
 * @param {object[]} tools - array of { name, description, parameters }
 */
export function applyToolsUpdate(action, tools) {
  const manifest = readManifest();

  if (action === "add") {
    for (const tool of tools) {
      // Remove existing entry for same name before re-adding
      manifest.tools = manifest.tools.filter((t) => t.name !== tool.name);
      manifest.tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    }
  } else if (action === "remove") {
    const names = new Set(tools.map((t) => t.name));
    manifest.tools = manifest.tools.filter((t) => !names.has(t.name));
  }

  writeManifest(manifest);
  logger.info("toolsManifest: manifest updated", {
    action,
    toolCount: tools.length,
  });
}

/**
 * Read all tool entries from the manifest.
 */
export function getAllTools() {
  return readManifest().tools;
}
