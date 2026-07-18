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
 * @returns {boolean} true if the manifest CONTENT changed on disk (a new or
 *   modified tool entry was written); false for a no-op (remove, or an
 *   idempotent re-add of already-identical entries). Callers use this to decide
 *   whether a full gateway respawn is actually required.
 */
export function applyToolsUpdate(action, tools) {
  if (action !== "add") return false;

  const manifest = readManifest();
  // Key by tool name; Map.set on an existing key updates the value in place
  // (keeps insertion order), so an identical re-add does not reorder the list.
  const byName = new Map((manifest.tools ?? []).map((t) => [t.name, t]));

  let changed = false;
  for (const tool of tools) {
    const entry = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
    const prev = byName.get(tool.name);
    // New tool, or an existing tool whose definition differs → real change.
    if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
      changed = true;
    }
    byName.set(tool.name, entry);
  }

  // Idempotent re-register of already-identical tools → skip the write so the
  // caller can keep the cheap in-process restart instead of a full respawn.
  if (!changed) return false;

  manifest.tools = Array.from(byName.values());
  writeManifest(manifest);
  logger.info("toolsManifest: manifest updated", {
    action,
    toolCount: tools.length,
  });
  return true;
}
