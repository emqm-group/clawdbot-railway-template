/**
 * Task proxy router — /api/tasks/*
 *
 * Loopback-only endpoints called by the king-cross-tools plugin running inside
 * the openclaw gateway subprocess (same container). Each handler resolves
 * tenantId from the tenant-mapping cache via the caller's agentId
 * (Wrapper Impl #3 — Decision #8), authenticates outbound with
 * ORCHESTRATOR_SECRET, and forwards to the orchestrator's /internal/tasks/*
 * routes. The agentId travels in the request body for POST/PATCH and as a
 * query parameter for GET/DELETE.
 *
 * No JWT/Bearer auth: only reachable from 127.0.0.1 (same host); the
 * requireLoopback guard enforces this via req.socket.remoteAddress.
 */

import express from "express";
import logger from "../agents/utils/logger.js";
import { getTenantId } from "../agents/utils/tenantMappings.js";

function log(msg, meta) {
  logger.info(`[KC-TASKS] ${msg}`, meta);
}

function logError(msg, meta) {
  logger.error(`[KC-TASKS] ${msg}`, meta?.error ?? "", meta);
}

function previewBody(obj) {
  if (!obj || typeof obj !== "object") return null;
  try {
    const s = JSON.stringify(obj);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return "[unserializable]";
  }
}

// Resolve the calling agent's id from whichever field carries it on this call.
// POST/PATCH carry it in the body; GET/DELETE carry it as a query param.
function extractAgentId(req) {
  if (req.body && typeof req.body.agentId === "string" && req.body.agentId) {
    return req.body.agentId;
  }
  if (typeof req.query.agentId === "string" && req.query.agentId) {
    return req.query.agentId;
  }
  // GET /api/tasks/agent/:agentId — agentId is in the URL path.
  if (typeof req.params.agentId === "string" && req.params.agentId) {
    return req.params.agentId;
  }
  return null;
}

export function createTasksRouter() {
  const router = express.Router();

  const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
  const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();

  {
    const url = process.env.ORCHESTRATOR_URL?.trim();
    const secret = process.env.ORCHESTRATOR_SECRET?.trim();
    log("tasks router initialised", {
      ORCHESTRATOR_URL: url ? `${url.slice(0, 40)}${url.length > 40 ? "…" : ""}` : "(missing)",
      ORCHESTRATOR_SECRET: secret ? "(set)" : "(missing)",
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
      logError("loopback guard rejected request", {
        method: req.method,
        path: req.originalUrl,
        remote: ip,
      });
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
  // For GET/DELETE: tenantId + agentId go as query params.
  // For POST/PATCH/PUT with a body: tenantId is merged into the JSON body
  //   (agentId already arrives in the body from the plugin).
  async function forward(req, res, orchestratorPath, overrideBody) {
    const baseUrl = ORCHESTRATOR_URL();
    const secret = ORCHESTRATOR_SECRET();
    if (!baseUrl || !secret) {
      logError("missing config on forward", {
        orchestratorUrlPresent: Boolean(baseUrl),
        orchestratorSecretPresent: Boolean(secret),
        path: orchestratorPath,
      });
      return missingConfig(res);
    }

    const agentId = extractAgentId(req);
    if (!agentId) {
      logError("forward: agentId missing from request", {
        method: req.method,
        path: req.originalUrl,
      });
      return res.status(400).json({ error: "agentId is required (body or query)" });
    }

    let tenantId;
    try {
      tenantId = await getTenantId(agentId);
    } catch (err) {
      logError("forward: tenant lookup failed", { agentId, error: err.message });
      return res.status(502).json({ code: "tenant_lookup_failed", message: err.message });
    }
    if (!tenantId) {
      logError("forward: unknown agentId after cache refetch", { agentId });
      return res.status(404).json({ code: "unknown_agent", message: `Unknown agent: ${agentId}` });
    }

    const method = req.method;
    const isBodyMethod = method === "POST" || method === "PATCH" || method === "PUT";

    let url = `${baseUrl}/internal/tasks${orchestratorPath}`;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    };

    let body;
    let mergedBodyForLog = null;
    if (isBodyMethod) {
      const incoming = typeof overrideBody === "object" ? overrideBody : (req.body ?? {});
      mergedBodyForLog = { tenantId, agentId, ...incoming };
      body = JSON.stringify(mergedBodyForLog);
    } else {
      const qs = new URLSearchParams({ tenantId, agentId });
      url = `${url}?${qs.toString()}`;
    }

    log(`forward → ${method} ${url}`, {
      tenantId,
      agentId,
      bodyPreview: previewBody(mergedBodyForLog),
    });
    const startedAt = Date.now();
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      logError("forward fetch failed", {
        method,
        url,
        error: err.message,
        cause: err.cause?.message ?? null,
      });
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
    log(`forward ← ${method} ${url} → ${resp.status} in ${Date.now() - startedAt}ms`);

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        logError("forward non-2xx response", {
          method,
          url,
          status: resp.status,
          bodyPreview: previewBody(data),
        });
      }
      return res.status(resp.status).json(data);
    }
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      logError("forward non-2xx response (text)", {
        method,
        url,
        status: resp.status,
        bodyPreview: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      });
    }
    return res.status(resp.status).type("text/plain").send(text);
  }

  // GET /api/tasks/agent/:agentId
  // → GET /internal/tasks/agent/:agentId?tenantId=...&agentId=...
  router.get("/agent/:agentId", (req, res) => {
    return forward(req, res, `/agent/${encodeURIComponent(req.params.agentId)}`);
  });

  // GET /api/tasks/:taskId
  // → GET /internal/tasks/:taskId?tenantId=...&agentId=...
  // Caller (king-cross-tools plugin) MUST pass agentId as a query parameter so
  // the wrapper can resolve tenantId from the cache.
  router.get("/:taskId", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}`);
  });

  // PATCH /api/tasks/:taskId
  router.patch("/:taskId", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}`);
  });

  // POST /api/tasks
  router.post("/", (req, res) => {
    return forward(req, res, "");
  });

  // POST /api/tasks/:taskId/liveness-response
  // → POST /internal/tasks/:taskId/liveness-response
  // kc_report_status — agent's reply to a kc:continue ping. Body carries
  // { agentId, status, message } from the plugin; tenantId is merged by forward.
  router.post("/:taskId/liveness-response", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}/liveness-response`);
  });

  // POST /api/tasks/:taskId/artifacts
  router.post("/:taskId/artifacts", (req, res) => {
    return forward(req, res, `/${encodeURIComponent(req.params.taskId)}/artifacts`);
  });

  // DELETE /api/tasks/:taskId/artifacts/:artifactId
  // The plugin sends agentId in the request body for the orchestrator's
  // ownership check; we read it from body (or query) and pass both tenantId
  // and agentId as query params since DELETE typically has no forwarded body.
  router.delete("/:taskId/artifacts/:artifactId", async (req, res) => {
    const artifactPath = `/${encodeURIComponent(req.params.taskId)}/artifacts/${encodeURIComponent(req.params.artifactId)}`;
    const baseUrl = ORCHESTRATOR_URL();
    const secret = ORCHESTRATOR_SECRET();
    if (!baseUrl || !secret) {
      logError("missing config on DELETE artifact", {
        orchestratorUrlPresent: Boolean(baseUrl),
        orchestratorSecretPresent: Boolean(secret),
      });
      return missingConfig(res);
    }

    const agentId = extractAgentId(req);
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required (body or query)" });
    }

    let tenantId;
    try {
      tenantId = await getTenantId(agentId);
    } catch (err) {
      return res.status(502).json({ code: "tenant_lookup_failed", message: err.message });
    }
    if (!tenantId) {
      return res.status(404).json({ code: "unknown_agent", message: `Unknown agent: ${agentId}` });
    }

    const qs = new URLSearchParams({ tenantId, agentId });
    const url = `${baseUrl}/internal/tasks${artifactPath}?${qs.toString()}`;

    log(`DELETE artifact → ${url}`, {
      tenantId,
      agentId,
      taskId: req.params.taskId,
      artifactId: req.params.artifactId,
    });
    const startedAt = Date.now();
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
      logError("DELETE artifact fetch failed", {
        url,
        error: err.message,
        cause: err.cause?.message ?? null,
      });
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
    log(`DELETE artifact ← ${url} → ${resp.status} in ${Date.now() - startedAt}ms`);

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        logError("DELETE artifact non-2xx", {
          url,
          status: resp.status,
          bodyPreview: previewBody(data),
        });
      }
      return res.status(resp.status).json(data);
    }
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      logError("DELETE artifact non-2xx (text)", {
        url,
        status: resp.status,
        bodyPreview: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      });
    }
    return res.status(resp.status).type("text/plain").send(text);
  });

  return router;
}
