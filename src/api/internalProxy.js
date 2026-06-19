/**
 * Shared internal-proxy infrastructure for loopback-only /api/* routers that
 * forward agent tool calls to the orchestrator's /internal/* endpoints.
 *
 * The Deep Lattice router (/api/deep-lattice) and the Content router
 * (/api/content — buffer + blog) are the same shape: a loopback IP guard, then
 * a `forward` that resolves tenantId from the calling agentId (tenant-mapping
 * cache), injects tenantId + agent_id + ORCHESTRATOR_SECRET, and proxies to the
 * matching /internal/* route. This module is that shared shape; each router
 * supplies its own log tag, default basePath, and route table. Deep Lattice and
 * Content are separate services/entities orchestrator-side — they only share
 * this transport.
 *
 * Auth model on the orchestrator side: requireShardSecretFromAgentBody — Bearer
 * token in the Authorization header, agent_id in the request body (POST/PUT/
 * PATCH) or query string (GET). Tenant is resolved server-side via
 * findShardForAgent; the wrapper additionally passes tenantId so the
 * orchestrator can short-circuit the lookup.
 *
 * No JWT/Bearer auth on the loopback surface: only reachable from 127.0.0.1
 * (the plugin runs inside the gateway subprocess on the same host); the
 * requireLoopback guard enforces this via req.socket.remoteAddress.
 */

import logger from "../agents/utils/logger.js";
import { getTenantId } from "../agents/utils/tenantMappings.js";

const ORCHESTRATOR_URL = () => process.env.ORCHESTRATOR_URL?.trim();
const ORCHESTRATOR_SECRET = () => process.env.ORCHESTRATOR_SECRET?.trim();

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

/**
 * Build the shared { requireLoopback, forward } pair for an internal-proxy
 * router.
 *
 * @param {string} tag - namespaces log lines (e.g. "DL", "content").
 * @param {object} [opts]
 * @param {string} [opts.defaultBasePath] - default orchestrator base path used
 *   when a route does not pass its own (e.g. "/internal/deep-lattice"). Routes
 *   that span multiple internal routers (Content → buffer + blog) pass an
 *   explicit basePath per route instead.
 */
export function createInternalProxy(tag, { defaultBasePath } = {}) {
  function log(msg, meta) {
    logger.info(`[${tag}] ${msg}`, meta);
  }
  function logError(msg, meta) {
    logger.error(`[${tag}] ${msg}`, meta?.error ?? "", meta);
  }

  {
    const url = ORCHESTRATOR_URL();
    const secret = ORCHESTRATOR_SECRET();
    log("internal proxy initialised", {
      ORCHESTRATOR_URL: url ? `${url.slice(0, 40)}${url.length > 40 ? "…" : ""}` : "(missing)",
      ORCHESTRATOR_SECRET: secret ? "(set)" : "(missing)",
    });
  }

  // Loopback-only guard — only the tool plugins (running inside the gateway on
  // the same host) should call these endpoints. Uses req.socket.remoteAddress
  // (raw TCP) intentionally — req.ip respects X-Forwarded-For and can be spoofed
  // by an external caller.
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

  // Generic forward — for endpoints that map 1:1 to a single orchestrator call.
  // POST/PUT/PATCH bodies are extended with tenantId + agent_id; GET queries
  // become tenantId + agent_id, plus any caller-supplied extraQuery pairs
  // (null/empty values dropped). basePath defaults to defaultBasePath; pass
  // another (e.g. "/internal/buffer") for sibling internal routers that share
  // the same shard-secret auth model.
  async function forward(req, res, orchestratorPath, extraQuery, { basePath = defaultBasePath } = {}) {
    // Fail loudly rather than build `${baseUrl}undefined${path}` — a router
    // created without a defaultBasePath (e.g. Content) must pass basePath on
    // every route; a missed one is a wiring bug, not a runtime 404 to chase.
    if (!basePath) {
      logError("forward called without a basePath (no per-route basePath and no defaultBasePath)", {
        method: req.method,
        path: orchestratorPath,
      });
      return res.status(500).json({ error: "internal misconfiguration: missing basePath" });
    }

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

    let url = `${baseUrl}${basePath}${orchestratorPath}`;

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

  return { requireLoopback, forward };
}
