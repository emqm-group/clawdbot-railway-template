// fs-tenant-guard — cross-tenant filesystem isolation on shared openclaw shards.
//
// On a shared shard, the openclaw process hosts agents owned by multiple
// tenants on one /data volume. openclaw's built-in fs tools (group:fs at
// v2026.3.8 — read/write/edit/apply_patch) have no built-in tenant boundary;
// without this guard, agent A could read another agent's workspace files.
//
// This plugin subscribes to the gateway's before_tool_call hook (signature
// verified at openclaw v2026.3.8 — src/plugins/types.ts:833-836). For every
// group:fs invocation it:
//   - Extracts the target path(s) from the params.
//   - Resolves to an absolute path (symlinks resolved when the target exists).
//   - Asserts the resolved path is inside the calling agent's workspace dir.
//   - Returns { block: true, blockReason } on mismatch — openclaw aborts the
//     tool execution before any I/O and surfaces a structured error to the agent.
//
// Workspace path convention. The wrapper places each agent's workspace at
// ${OPENCLAW_STATE_DIR}/workspace-<agentId>/ (default
// /data/.openclaw/workspace-<agentId>/). This matches the path written by
// configManager.updateAgentInConfig and referenced by agentController,
// openclawService, directivesController, and king-cross-tools (skill_path).
// The guard must agree with whatever the wrapper actually puts in
// agents.list[].workspace, because openclaw uses that as the agent's cwd.
//
// Fail-closed: when ctx.agentId is undefined (the un-wrapped fallback path
// through pi-tool-definition-adapter.ts), the call MUST be blocked. An
// un-attributed fs call would break the tenant boundary, so pass-through is
// not an option.
//
// Path-traversal robustness:
//   - file:// URIs are stripped to their pathname.
//   - The "@" prefix used by some openclaw deployments is stripped.
//   - Relative paths are resolved against the agent's workspace.
//   - realpathSync resolves symlinks when the target exists, so attempts to
//     escape via a malicious symlink inside the workspace get caught.
//   - For paths that don't yet exist (e.g. write/edit/apply_patch creating a
//     new file), we fall back to a logical path.resolve and check that.

import fs from "node:fs";
import path from "node:path";

const STATE_DIR_DEFAULT = "/data/.openclaw";
const FS_TOOLS = new Set(["read", "write", "edit", "apply_patch"]);

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || STATE_DIR_DEFAULT;
}

function agentWorkspaceDir(agentId) {
  // Wrapper convention: ${STATE_DIR}/workspace-<agentId>/.
  return path.resolve(path.join(stateDir(), `workspace-${agentId}`));
}

function isInside(absolutePath, agentDir) {
  if (absolutePath === agentDir) return true;
  return absolutePath.startsWith(agentDir + path.sep);
}

function normalisePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return null;
  let candidate = rawPath;
  if (candidate.startsWith("file://")) candidate = candidate.slice("file://".length);
  if (candidate.startsWith("@")) candidate = candidate.slice(1);
  return candidate;
}

function resolveAbsolute(rawPath, agentDir) {
  const candidate = normalisePath(rawPath);
  if (candidate === null) return null;
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(agentDir, candidate);

  try {
    // realpathSync resolves symlinks. If the target doesn't exist, fall back
    // to the logical path (write/edit/apply_patch may be creating it).
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

// Apply_patch's `input` is a patch text in the *** Begin Patch / *** End Patch
// format. File paths appear after Add/Update/Delete File and Move to markers.
function extractApplyPatchPaths(input) {
  if (typeof input !== "string") return [];
  const paths = [];
  const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  let m;
  while ((m = re.exec(input)) !== null) {
    const p = m[1].trim();
    if (p) paths.push(p);
  }
  return paths;
}

function extractPaths(toolName, params) {
  if (!params || typeof params !== "object") return [];
  if (toolName === "apply_patch") {
    return extractApplyPatchPaths(params.input);
  }
  // read/write/edit accept either "path" or "file_path" per openclaw's
  // CLAUDE_PARAM_GROUPS (src/agents/pi-tools.params.ts at v2026.3.8).
  const value = params.path ?? params.file_path;
  return typeof value === "string" && value ? [value] : [];
}

export default function register(api) {
  api.on("before_tool_call", (event, ctx) => {
    const toolName = event?.toolName;
    if (!toolName || !FS_TOOLS.has(toolName)) return;

    const agentId = ctx?.agentId;
    if (!agentId) {
      console.error(
        `[fs-tenant-guard] BLOCK tool=${toolName} reason="missing agent context" (un-wrapped fallback path)`
      );
      return { block: true, blockReason: "missing agent context" };
    }

    const agentDir = agentWorkspaceDir(agentId);

    const candidatePaths = extractPaths(toolName, event.params);
    if (candidatePaths.length === 0) {
      console.error(
        `[fs-tenant-guard] BLOCK tool=${toolName} agent=${agentId} reason="no path extracted from params"`
      );
      return { block: true, blockReason: "no path in tool params" };
    }

    for (const rawPath of candidatePaths) {
      const resolved = resolveAbsolute(rawPath, agentDir);
      if (!resolved) {
        console.error(
          `[fs-tenant-guard] BLOCK tool=${toolName} agent=${agentId} reason="unresolvable path" raw=${JSON.stringify(rawPath)}`
        );
        return {
          block: true,
          blockReason: `path could not be resolved: ${rawPath}`,
        };
      }
      if (!isInside(resolved, agentDir)) {
        console.error(
          `[fs-tenant-guard] BLOCK tool=${toolName} agent=${agentId} reason="out-of-workspace" raw=${JSON.stringify(rawPath)} resolved=${resolved} expected_prefix=${agentDir}/`
        );
        return {
          block: true,
          blockReason: `path is outside agent workspace: ${rawPath}`,
        };
      }
    }

    return undefined;
  });
}
