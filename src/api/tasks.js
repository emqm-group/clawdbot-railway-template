/**
 * Task proxy router — /api/tasks/*
 *
 * Loopback-only endpoints called by the king-cross-tools plugin running inside
 * the openclaw gateway subprocess (same container). Each handler injects
 * tenantId (from TENANT_ID env) and ORCHESTRATOR_SECRET, then forwards the
 * request to the orchestrator's /internal/tasks/* routes.
 *
 * No JWT auth: these endpoints are only reachable from 127.0.0.1 (same host).
 * The requireLoopback guard enforces this at the TCP level using req.socket.remoteAddress.
 */

import express from "express";

function log(msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[KC-TASKS] ${msg}${metaStr}`);
}

function logError(msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[KC-TASKS] ERROR: ${msg}${metaStr}`);
}

export function createTasksRouter() {
  const router = express.Router();

  const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
  const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();
  const TENANT_ID = () => process.env.TENANT_ID?.trim();

  // Log config presence on first use via module-level check
  {
    const url = process.env.ORCHESTRATOR_URL?.trim();
    const secret = process.env.ORCHESTRATOR_SECRET?.trim();
    const tenantId = process.env.TENANT_ID?.trim();
    log("tasks router initialised", {
      ORCHESTRATOR_URL: url ? `${url.slice(0, 40)}${url.length > 40 ? "…" : ""}` : "(missing)",
      ORCHESTRATOR_SECRET: secret ? "(set)" : "(missing)",
      TENANT_ID: tenantId || "(missing)",
    });
  }

  // Loopback-only guard — only the king-cross-tools plugin (running inside the
  // gateway on the same host) should call these endpoints.
  // Uses req.socket.remoteAddress (raw TCP) intentionally — req.ip respects
  // X-Forwarded-For and can be spoofed by an external caller.
  function requireLoopback(req, res, next) {
    const ip = req.socket?.remoteAddress || "";
    const isLoopback =
      ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoopback) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  }

  router.use(requireLoopback);

  function missingConfig(res) {
    return res
      .status(503)
      .json({ error: "Orchestrator not configured (ORCHESTRATOR_URL or ORCHESTRATOR_SECRET missing)" });
  }

  // Forward a request to the orchestrator's /internal/tasks/* path.
  // For GET/DELETE: tenantId goes as a query param.
  // For POST/PATCH with a body: tenantId is merged into the JSON body.
  async function forward(req, res, orchestratorPath, overrideBody) {
    const baseUrl = ORCHESTRATOR_URL();
    const secret = ORCHESTRATOR_SECRET();
    if (!baseUrl || !secret) return missingConfig(res);

    const tenantId = TENANT_ID();
    const method = req.method;
    const isBodyMethod = method === "POST" || method === "PATCH" || method === "PUT";

    let url = `${baseUrl}/internal/tasks${orchestratorPath}`;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    };

    let body;
    if (isBodyMethod) {
      // Merge tenantId into the forwarded body. overrideBody lets callers inject
      // extra fields (e.g. agentId for DELETE-with-body which HTTP technically allows).
      const incoming = typeof overrideBody === "object" ? overrideBody : (req.body ?? {});
      body = JSON.stringify({ tenantId, ...incoming });
    } else {
      // GET / DELETE — pass tenantId as query param
      const qs = new URLSearchParams({ tenantId: tenantId ?? "" });
      url = `${url}?${qs.toString()}`;
    }

    log(`${method} ${url}`);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      logError("fetch failed", { method, url, error: err.message, cause: err.cause?.message ?? null });
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
    log(`${method} ${url} → ${resp.status}`);

    // Mirror status and body back to the plugin.
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json().catch(() => ({}));
      return res.status(resp.status).json(data);
    }
    const text = await resp.text().catch(() => "");
    return res.status(resp.status).type("text/plain").send(text);
  }

  // GET /api/tasks/agent/:agentId
  // → GET /internal/tasks/agent/:agentId?tenantId=...
  // Returns: one task (top scheduled by priority ASC, created_at ASC) or empty.
  router.get("/agent/:agentId", (req, res) => {
    return forward(req, res, `/agent/${encodeURIComponent(req.params.agentId)}`);
  });

  // GET /api/tasks/:taskId
  // → GET /internal/tasks/:taskId?tenantId=...
  // Returns: task + active artifacts (for resumption after approval_actioned).
  router.get("/:taskId", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}`);
  });

  // PATCH /api/tasks/:taskId
  // → PATCH /internal/tasks/:taskId  (body: { tenantId, agentId, execution_status?, agent_notes? })
  // Agent updates execution_status and/or agent_notes. KC validates ownership.
  router.patch("/:taskId", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}`);
  });

  // POST /api/tasks
  // → POST /internal/tasks  (body: { tenantId, agentId, assignedToAgentId, taskDescription, ... })
  // Agent creates a task for another agent (runtime delegation).
  router.post("/", (req, res) => {
    return forward(req, res, "");
  });

  // POST /api/tasks/:taskId/artifacts
  // → POST /internal/tasks/:taskId/artifacts  (body: { tenantId, agentId, artifactType, ... })
  // Agent registers an external artifact before transitioning to awaiting_approval.
  router.post("/:taskId/artifacts", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}/artifacts`);
  });

  // DELETE /api/tasks/:taskId/artifacts/:artifactId
  // → DELETE /internal/tasks/:taskId/artifacts/:artifactId?tenantId=...
  // Agent soft-deletes a superseded artifact after a modify action.
  // agentId is included in the request body by the plugin for the orchestrator's
  // ownership check; we pass it as a query param since HTTP DELETE typically has no body.
  router.delete("/:taskId/artifacts/:artifactId", async (req, res) => {
    const artifactPath = `/${encodeURIComponent(req.params.taskId)}/artifacts/${encodeURIComponent(req.params.artifactId)}`;
    const baseUrl = ORCHESTRATOR_URL();
    const secret = ORCHESTRATOR_SECRET();
    if (!baseUrl || !secret) return missingConfig(res);

    const tenantId = TENANT_ID();
    const agentId = req.body?.agentId;

    // Pass tenantId + agentId as query params since DELETE has no body.
    const qs = new URLSearchParams({ tenantId: tenantId ?? "" });
    if (agentId) qs.set("agentId", agentId);
    const url = `${baseUrl}/internal/tasks${artifactPath}?${qs.toString()}`;

    log(`DELETE ${url}`);
    let resp;
    try {
      resp = await fetch(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
      });
    } catch (err) {
      logError("fetch failed", { method: "DELETE", url, error: err.message, cause: err.cause?.message ?? null });
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
    log(`DELETE ${url} → ${resp.status}`);

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json().catch(() => ({}));
      return res.status(resp.status).json(data);
    }
    const text = await resp.text().catch(() => "");
    return res.status(resp.status).type("text/plain").send(text);
  });

  return router;
}
