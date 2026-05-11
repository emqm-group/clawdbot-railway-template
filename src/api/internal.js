// Wrapper-side /internal/* router.
//
// Endpoints called by the orchestrator. Authenticated with the shard's
// ORCHESTRATOR_SECRET Bearer (per design doc API surface §
// "Internal — wrapper-side (orchestrator-callable, ORCHESTRATOR_SECRET Bearer)").
//
//   POST /internal/refresh-mappings  — push tenant-mapping deltas into the cache
//   POST /internal/cleanup-agents    — delete workspace + state dirs for removed tenants

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

import logger from "../agents/utils/logger.js";
import {
  applyDelta,
  cacheStats,
  loadFromOrchestrator,
} from "../agents/utils/tenantMappings.js";

function bearerEquals(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireOrchestratorSecret(req, res, next) {
  const expected = process.env.ORCHESTRATOR_SECRET?.trim();
  if (!expected) {
    return res.status(503).json({ error: "ORCHESTRATOR_SECRET not configured" });
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!bearerEquals(token, expected)) {
    logger.warn("[internal] unauthorized request", {
      path: req.originalUrl,
      remote: req.socket?.remoteAddress,
      hasHeader: Boolean(req.headers.authorization),
    });
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function createInternalRouter() {
  const router = express.Router();

  router.use(requireOrchestratorSecret);

  // POST /internal/refresh-mappings
  // Body (any combination):
  //   { added: [{tenantId, agentIds: [...]}, ...] }
  //   { removedAgentIds: [...] }
  //   { tenants: [{tenantId, agentIds: [...]}, ...] }   // full snapshot replacement
  router.post("/refresh-mappings", async (req, res) => {
    try {
      const result = applyDelta(req.body ?? {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      logger.error("[internal] refresh-mappings failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /internal/cache-stats — debug / health introspection only.
  router.get("/cache-stats", (_req, res) => res.json(cacheStats()));

  // POST /internal/reload-mappings — orchestrator-triggered re-fetch (e.g. when
  // the orchestrator wants to force a resync without computing a delta).
  router.post("/reload-mappings", async (_req, res) => {
    try {
      const count = await loadFromOrchestrator();
      return res.json({ ok: true, totalAgents: count });
    } catch (err) {
      logger.error("[internal] reload-mappings failed", { error: err.message });
      return res.status(502).json({ error: err.message });
    }
  });

  // POST /internal/cleanup-agents
  // Body: { agentIds: string[] }
  // Recursively deletes /data/workspace/<agentId>/ and
  // /data/.openclaw/agents/<agentId>/ for each id. Continues on per-agent
  // failures; never aborts the batch. Response: { ok: string[], failed: [...] }.
  router.post("/cleanup-agents", async (req, res) => {
    const agentIds = req.body?.agentIds;
    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return res.status(400).json({ error: "agentIds must be a non-empty array" });
    }

    const workspaceRoot =
      process.env.OPENCLAW_WORKSPACE_DIR?.trim() || "/data/workspace";
    const stateAgentsRoot = path.join(
      process.env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw",
      "agents"
    );
    const workspaceRootAbs = path.resolve(workspaceRoot);
    const stateAgentsRootAbs = path.resolve(stateAgentsRoot);

    const ok = [];
    const failed = [];

    for (const rawId of agentIds) {
      const agentId = typeof rawId === "string" ? rawId.trim() : "";
      if (!agentId) {
        failed.push({ agentId: String(rawId), error: "agentId must be a non-empty string" });
        continue;
      }
      // Defensive path-traversal guard. agentIds are operator-allocated so
      // this should never trip, but failing closed is cheap.
      if (agentId.includes("/") || agentId.includes("\\") || agentId === "." || agentId === "..") {
        failed.push({ agentId, error: "agentId contains illegal characters" });
        continue;
      }

      const targets = [
        path.join(workspaceRootAbs, agentId),
        path.join(stateAgentsRootAbs, agentId),
      ];

      // Belt-and-braces: the resolved targets must live under their respective roots.
      const targetsOk = targets.every((t, idx) => {
        const root = idx === 0 ? workspaceRootAbs : stateAgentsRootAbs;
        return t === root + path.sep + agentId || t.startsWith(root + path.sep);
      });
      if (!targetsOk) {
        failed.push({ agentId, error: "resolved path escapes cleanup root" });
        continue;
      }

      const errors = [];
      for (const target of targets) {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch (err) {
          errors.push(`${target}: ${err?.message ?? String(err)}`);
        }
      }
      if (errors.length === 0) {
        ok.push(agentId);
      } else {
        failed.push({ agentId, error: errors.join("; ") });
      }
    }

    logger.info("[internal] cleanup-agents complete", {
      requested: agentIds.length,
      ok: ok.length,
      failed: failed.length,
    });
    return res.json({ ok, failed });
  });

  return router;
}

export default createInternalRouter;
