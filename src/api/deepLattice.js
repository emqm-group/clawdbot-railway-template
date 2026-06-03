/**
 * Deep Lattice proxy router — /api/deep-lattice/*
 *
 * Loopback-only endpoints called by the deep-lattice-tools plugin running
 * inside the openclaw gateway subprocess (same container). Each handler
 * resolves tenantId from the tenant-mapping cache via the caller's agentId,
 * authenticates outbound with ORCHESTRATOR_SECRET, and forwards to the
 * orchestrator's /internal/deep-lattice/* routes.
 *
 * Auth model on the orchestrator side: requireShardSecretFromAgentBody —
 * Bearer token in the Authorization header, agent_id in the request body
 * (POST/PUT/PATCH) or query string (GET). Tenant is resolved server-side
 * via findShardForAgent. The wrapper additionally passes tenantId so the
 * orchestrator can short-circuit the lookup when convenient.
 *
 * No profile/knowledge list/discovery endpoints — agents reach those files by
 * directive-supplied slug/filename. Briefings are written (POST) and read back
 * (GET /briefings, filtered by kind and/or date).
 *
 * NOTE: per-agent authorization has been removed orchestrator-side. The
 * orchestrator no longer gates which agent may call which operation; the shard
 * secret authenticates the wrapper, but any agent reaching these endpoints can
 * perform any DL op.
 *
 * No JWT/Bearer auth on the loopback surface: only reachable from 127.0.0.1
 * (same host); the requireLoopback guard enforces this via
 * req.socket.remoteAddress.
 */

import express from "express";
import logger from "../agents/utils/logger.js";
import { getTenantId } from "../agents/utils/tenantMappings.js";

function log(msg, meta) {
  logger.info(`[DL] ${msg}`, meta);
}

function logError(msg, meta) {
  logger.error(`[DL] ${msg}`, meta?.error ?? "", meta);
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
// POST/PUT/PATCH carry it in the body; GET carries it as a query param.
function extractAgentId(req) {
  if (req.body && typeof req.body.agentId === "string" && req.body.agentId) {
    return req.body.agentId;
  }
  if (typeof req.query.agentId === "string" && req.query.agentId) {
    return req.query.agentId;
  }
  return null;
}

export function createDeepLatticeRouter() {
  const router = express.Router();

  const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
  const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();

  {
    const url = process.env.ORCHESTRATOR_URL?.trim();
    const secret = process.env.ORCHESTRATOR_SECRET?.trim();
    log("deep-lattice router initialised", {
      ORCHESTRATOR_URL: url ? `${url.slice(0, 40)}${url.length > 40 ? "…" : ""}` : "(missing)",
      ORCHESTRATOR_SECRET: secret ? "(set)" : "(missing)",
    });
  }

  // Loopback-only guard — only the deep-lattice-tools plugin (running inside
  // the gateway on the same host) should call these endpoints.
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

  // Resolve tenantId from the calling agentId. Returns null on lookup failure;
  // the caller is expected to short-circuit with an HTTP response.
  async function resolveTenant(req, res) {
    const agentId = extractAgentId(req);
    if (!agentId) {
      logError("agentId missing from request", {
        method: req.method,
        path: req.originalUrl,
      });
      res.status(400).json({ error: "agentId is required (body or query)" });
      return null;
    }
    let tenantId;
    try {
      tenantId = await getTenantId(agentId);
    } catch (err) {
      logError("tenant lookup failed", { agentId, error: err.message });
      res.status(502).json({ code: "tenant_lookup_failed", message: err.message });
      return null;
    }
    if (!tenantId) {
      logError("unknown agentId after cache refetch", { agentId });
      res.status(404).json({ code: "unknown_agent", message: `Unknown agent: ${agentId}` });
      return null;
    }
    return { agentId, tenantId };
  }

  // Generic forward — for endpoints that map 1:1 to a single orchestrator
  // call. POST/PUT/PATCH bodies are extended with tenantId + agent_id; GET
  // queries become tenantId + agent_id, plus any caller-supplied extraQuery
  // pairs (null/empty values dropped).
  async function forward(req, res, orchestratorPath, extraQuery) {
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

    const resolved = await resolveTenant(req, res);
    if (!resolved) return;
    const { agentId, tenantId } = resolved;

    const method = req.method;
    const isBodyMethod = method === "POST" || method === "PATCH" || method === "PUT";

    let url = `${baseUrl}/internal/deep-lattice${orchestratorPath}`;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    };

    let body;
    let mergedBodyForLog = null;
    if (isBodyMethod) {
      const incoming = req.body ?? {};
      // Drop wrapper-only agentId casing variant; orchestrator expects agent_id.
      const { agentId: _wrapAgentId, ...rest } = incoming;
      mergedBodyForLog = { tenantId, agent_id: agentId, ...rest };
      body = JSON.stringify(mergedBodyForLog);
    } else {
      const qs = new URLSearchParams({ tenantId, agent_id: agentId });
      if (extraQuery) {
        for (const [k, v] of Object.entries(extraQuery)) {
          if (v != null && v !== "") qs.set(k, String(v));
        }
      }
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

  // GET /api/deep-lattice/profile/:slug
  // → GET /internal/deep-lattice/profile/:slug?tenantId=&agent_id=
  router.get("/profile/:slug", (req, res) => {
    return forward(req, res, `/profile/${encodeURIComponent(req.params.slug)}`);
  });

  // PUT /api/deep-lattice/profile/:slug/content
  // → PUT /internal/deep-lattice/profile/:slug/content
  // Body: { agent_id, content, tenantId }
  router.put("/profile/:slug/content", (req, res) => {
    return forward(req, res, `/profile/${encodeURIComponent(req.params.slug)}/content`);
  });

  // GET /api/deep-lattice/knowledge/:filename
  // → GET /internal/deep-lattice/knowledge/:filename?tenantId=&agent_id=
  router.get("/knowledge/:filename", (req, res) => {
    return forward(req, res, `/knowledge/${encodeURIComponent(req.params.filename)}`);
  });

  // GET /api/deep-lattice/templates/:filename
  // → GET /internal/deep-lattice/templates/:filename?tenantId=&agent_id=
  // Global (not tenant-scoped) admin-authored templates; read-only for agents.
  router.get("/templates/:filename", (req, res) => {
    return forward(req, res, `/templates/${encodeURIComponent(req.params.filename)}`);
  });

  // GET /api/deep-lattice/briefings?agentId=&kind=&date=
  // → GET /internal/deep-lattice/briefings?tenantId=&agent_id=&kind=&for_date=
  // Reads back briefings, optionally filtered by kind and/or date.
  // Agent-facing `date` maps to the orchestrator's `for_date` query param.
  router.get("/briefings", (req, res) => {
    return forward(req, res, "/briefings", {
      kind: req.query.kind,
      for_date: req.query.date ?? req.query.for_date,
    });
  });

  // POST /api/deep-lattice/briefings
  // → POST /internal/deep-lattice/briefings (creates a briefing)
  router.post("/briefings", (req, res) => {
    return forward(req, res, "/briefings");
  });

  // ── Agent documents (migration 018) ────────────────────────
  // analytics_report is typed + filterable; plan is subtyped + latest-wins per
  // subtype (migration 023); daily_target / execution_plan are untyped
  // latest-wins (POST writes a version, GET /latest reads the newest, 404 when
  // none exist yet).

  // POST /api/deep-lattice/analytics-reports → POST /internal/.../analytics-reports
  router.post("/analytics-reports", (req, res) => {
    return forward(req, res, "/analytics-reports");
  });

  // GET /api/deep-lattice/analytics-reports?agentId=&type=&duration=&date=
  // → GET /internal/deep-lattice/analytics-reports?tenantId=&agent_id=&type=&duration=&date=
  router.get("/analytics-reports", (req, res) => {
    return forward(req, res, "/analytics-reports", {
      type: req.query.type,
      duration: req.query.duration,
      date: req.query.date,
    });
  });

  // plan — subtyped + latest-wins per subtype (migration 023). POST carries
  // `subtype` in the body (flows through forward's ...rest); GET /plans/latest
  // requires ?subtype= (gtm|content-strategy|outbound-strategy), forwarded as
  // extraQuery. Orchestrator 404s when no plan exists for that subtype.
  router.post("/plans", (req, res) => {
    return forward(req, res, "/plans");
  });
  router.get("/plans/latest", (req, res) => {
    return forward(req, res, "/plans/latest", { subtype: req.query.subtype });
  });

  // daily_target | execution_plan — untyped latest-wins. POST writes a version;
  // GET /latest returns the newest (orchestrator 404s when none exist).
  for (const path of ["daily-targets", "execution-plans"]) {
    router.post(`/${path}`, (req, res) => {
      return forward(req, res, `/${path}`);
    });
    router.get(`/${path}/latest`, (req, res) => {
      return forward(req, res, `/${path}/latest`);
    });
  }

  return router;
}
