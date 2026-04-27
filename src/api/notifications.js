/**
 * Task notification handler — POST /api/notifications/tasks
 *
 * Receives KC push notifications from the orchestrator and triggers the target
 * agent via the internal openclaw gateway (/v1/chat/completions).
 *
 * Design rules (from design doc):
 *
 * Coalescing (tasks_available / task_assigned only):
 *   Per-agent in-memory set with a 30-second window. If a wake-up notification
 *   arrives for an agent already in the set, it is dropped. The agent always
 *   calls kc_get_next_task on activation, so extra wake-ups carry no info.
 *   approval_actioned is NEVER coalesced — dropping it leaves a task stuck in
 *   received_approval permanently.
 *
 * Gateway readiness guard:
 *   Calls ensureGatewayRunning() before triggering. If the gateway is not up,
 *   the notification is queued per-agent:
 *     - Wake-up slot (tasks_available / task_assigned): max 1 entry — collapses.
 *     - Approval queue (approval_actioned): unbounded list (soft cap 50 + warning).
 *   On the next successful ensureGatewayRunning() call, pending queues are
 *   drained: approval_actioned entries first (in order), then the wake-up slot.
 *
 * approval_actioned retry on UNAVAILABLE:
 *   If the gateway returns UNAVAILABLE / "session is still active", the agent is
 *   mid-turn. Retry up to 3 times with backoff: 30 s, 60 s, 120 s. If all
 *   retries are exhausted, log an error — manual operator recovery is needed.
 */

import express from "express";
import jwt from "jsonwebtoken";
import logger from "../agents/utils/logger.js";

const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = () => process.env.OPENCLAW_GATEWAY_TOKEN?.trim();

// ---------------------------------------------------------------------------
// Coalesce map: agentId → timer handle.
// Tracks agents that have a pending or in-flight wake-up trigger (30s window).
// ---------------------------------------------------------------------------
const COALESCE_WINDOW_MS = 30_000;
const coalesceMap = new Map(); // agentId → NodeJS.Timeout

function markCoalescing(agentId) {
  const existing = coalesceMap.get(agentId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    coalesceMap.delete(agentId);
    logger.info(`[KC-NOTIF] coalesce window expired`, { agentId });
  }, COALESCE_WINDOW_MS);
  coalesceMap.set(agentId, timer);
  logger.info(`[KC-NOTIF] coalesce window opened (${COALESCE_WINDOW_MS}ms)`, { agentId });
}

function isCoalescing(agentId) {
  return coalesceMap.has(agentId);
}

// ---------------------------------------------------------------------------
// Gateway readiness queue.
// Per-agent: { wakeup: event | null, approvals: event[] }
// ---------------------------------------------------------------------------
const pendingQueues = new Map(); // agentId → { wakeup, approvals }

function getOrCreateQueue(agentId) {
  if (!pendingQueues.has(agentId)) {
    pendingQueues.set(agentId, { wakeup: null, approvals: [] });
  }
  return pendingQueues.get(agentId);
}

function enqueue(event) {
  const q = getOrCreateQueue(event.agentId);

  if (event.event === "tasks_available" || event.event === "task_assigned") {
    const replaced = q.wakeup != null;
    // Collapse: wake-up slot holds at most one entry.
    q.wakeup = event;
    logger.info(`[KC-NOTIF] enqueued wake-up${replaced ? " (replaced existing)" : ""}`, {
      agentId: event.agentId,
      event: event.event,
      approvalsPending: q.approvals.length,
    });
  } else if (event.event === "approval_actioned") {
    if (q.approvals.length >= 50) {
      logger.warn(
        `[KC-NOTIF] approval queue soft limit (50) reached for agent ${event.agentId}; enqueueing anyway`
      );
    }
    q.approvals.push(event);
    logger.info(`[KC-NOTIF] enqueued approval_actioned`, {
      agentId: event.agentId,
      taskId: event.taskId,
      approvalsPending: q.approvals.length,
      wakeupPending: q.wakeup != null,
    });
  }
}

// ---------------------------------------------------------------------------
// Agent triggering via /v1/chat/completions (fire-and-forget internally;
// callers await the returned promise for retry logic).
// ---------------------------------------------------------------------------

function buildMessage(event) {
  if (event.event === "tasks_available" || event.event === "task_assigned") {
    return "You have a task scheduled. Invoke kc_get_next_task to fetch it and begin.";
  }
  if (event.event === "approval_actioned") {
    const { taskId } = event;
    return (
      `Approval actioned for task ${taskId}. ` +
      `Invoke kc_get_task with taskId=${taskId} to fetch current state and resume.`
    );
  }
  return null;
}

async function triggerAgent(agentId, message) {
  const gatewayToken = GATEWAY_TOKEN();
  const url = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`;
  // Canonical per https://docs.openclaw.ai/gateway/openai-http-api — slash, not colon.
  // The "openclaw:<id>" alias is legacy and not honoured by all gateway versions.
  const model = `openclaw/${agentId}`;
  // Pin to the agent's main session so task nudges land in the same transcript the
  // agent uses with its human/channels. Default behaviour of /v1/chat/completions is
  // stateless per request (new session each call) — overriding via x-openclaw-session-key.
  // Key format per https://docs.openclaw.ai/reference/session-management-compaction.
  const sessionKey = `agent:${agentId}:main`;

  const messagePreview = message.length > 120 ? `${message.slice(0, 120)}…` : message;
  logger.info(`[KC-NOTIF] triggerAgent → POST ${url}`, {
    agentId,
    model,
    sessionKey,
    tokenPresent: Boolean(gatewayToken),
    messagePreview,
  });

  const startedAt = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayToken}`,
      "x-openclaw-session-key": sessionKey,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
    }),
  });

  logger.info(`[KC-NOTIF] triggerAgent ← ${resp.status} in ${Date.now() - startedAt}ms`, {
    agentId,
    model,
    sessionKey,
    ok: resp.ok,
  });

  return resp;
}

// Check whether a gateway response signals UNAVAILABLE / "session is still active".
async function isUnavailable(resp) {
  if (resp.ok) return false;
  // Clone response text without consuming the original (already consumed by caller if needed).
  try {
    const text = await resp.clone().text();
    return (
      text.includes("UNAVAILABLE") ||
      text.includes("session is still active") ||
      resp.status === 503 ||
      resp.status === 409
    );
  } catch (err) {
    logger.warn(`[KC-NOTIF] isUnavailable: failed to read response body — treating as not-UNAVAILABLE`, {
      status: resp.status,
      error: err?.message ?? String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// approval_actioned delivery with retry on UNAVAILABLE.
// Retries: 30 s, 60 s, 120 s. After exhaustion, logs and gives up.
// ---------------------------------------------------------------------------
const APPROVAL_RETRY_DELAYS = [30_000, 60_000, 120_000];

function scheduleApprovalRetry(agentId, message, attempt = 0) {
  if (attempt >= APPROVAL_RETRY_DELAYS.length) {
    logger.error(
      `[KC-NOTIF] approval_actioned exhausted all retries for agent ${agentId} — manual recovery needed`
    );
    return;
  }

  const delay = APPROVAL_RETRY_DELAYS[attempt];
  logger.warn(
    `[KC-NOTIF] approval_actioned UNAVAILABLE for agent ${agentId}; retry ${attempt + 1}/${APPROVAL_RETRY_DELAYS.length} in ${delay / 1000}s`
  );

  setTimeout(async () => {
    logger.info(`[KC-NOTIF] approval_actioned retry firing`, {
      agentId,
      attempt: attempt + 1,
    });
    try {
      const resp = await triggerAgent(agentId, message);
      if (await isUnavailable(resp)) {
        scheduleApprovalRetry(agentId, message, attempt + 1);
      } else if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        logger.error(
          `[KC-NOTIF] approval_actioned delivery failed for agent ${agentId} [${resp.status}]: ${text}`
        );
      } else {
        logger.info(`[KC-NOTIF] approval_actioned delivered on retry`, {
          agentId,
          attempt: attempt + 1,
        });
      }
    } catch (err) {
      logger.error(
        `[KC-NOTIF] approval_actioned retry error for agent ${agentId}: ${err.message}`
      );
      scheduleApprovalRetry(agentId, message, attempt + 1);
    }
  }, delay);
}

async function dispatchApprovalActioned(agentId, message) {
  try {
    const resp = await triggerAgent(agentId, message);
    if (await isUnavailable(resp)) {
      scheduleApprovalRetry(agentId, message, 0);
    } else if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.error(
        `[KC-NOTIF] approval_actioned delivery failed for agent ${agentId} [${resp.status}]: ${text}`
      );
    } else {
      logger.info(`[KC-NOTIF] approval_actioned delivered`, { agentId });
    }
  } catch (err) {
    logger.error(
      `[KC-NOTIF] approval_actioned trigger error for agent ${agentId}: ${err.message}`
    );
    // On network error, start retry schedule.
    scheduleApprovalRetry(agentId, message, 0);
  }
}

// ---------------------------------------------------------------------------
// Wake-up dispatch (tasks_available / task_assigned).
// Marks coalesce window; errors are logged, not fatal.
// ---------------------------------------------------------------------------
async function dispatchWakeup(agentId, message) {
  markCoalescing(agentId);
  try {
    const resp = await triggerAgent(agentId, message);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.warn(
        `[KC-NOTIF] wake-up trigger failed for agent ${agentId} [${resp.status}]: ${text}`
      );
    } else {
      logger.info(`[KC-NOTIF] wake-up delivered`, { agentId });
    }
  } catch (err) {
    logger.warn(
      `[KC-NOTIF] wake-up trigger error for agent ${agentId}: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Drain all pending queues after the gateway becomes available.
// approval_actioned entries fire first (in order), then the wake-up slot.
// ---------------------------------------------------------------------------
async function drainAllQueues() {
  const agentCount = pendingQueues.size;
  logger.info(`[KC-NOTIF] draining pending queues`, { agents: agentCount });

  for (const [agentId, q] of pendingQueues.entries()) {
    // Snapshot + clear before dispatching to avoid double-dispatch if a new
    // notification arrives mid-drain.
    const approvals = q.approvals.splice(0);
    const wakeup = q.wakeup;
    q.wakeup = null;

    if (approvals.length === 0 && !wakeup) {
      pendingQueues.delete(agentId);
      continue;
    }

    logger.info(`[KC-NOTIF] draining agent ${agentId}`, {
      approvals: approvals.length,
      wakeup: wakeup != null,
    });

    // Approvals first.
    for (const ev of approvals) {
      const msg = buildMessage(ev);
      if (msg) await dispatchApprovalActioned(agentId, msg);
    }

    // Wake-up slot last.
    if (wakeup) {
      const msg = buildMessage(wakeup);
      if (msg) await dispatchWakeup(agentId, msg);
    }

    pendingQueues.delete(agentId);
  }

  logger.info(`[KC-NOTIF] drain complete`);
}

// ---------------------------------------------------------------------------
// Main notification dispatcher.
// ---------------------------------------------------------------------------
async function handleEvent(event, ensureGatewayRunning) {
  const { agentId } = event;
  logger.info(`[KC-NOTIF] handleEvent start`, {
    event: event.event,
    agentId,
    taskId: event.taskId ?? null,
  });

  const message = buildMessage(event);
  if (!message) {
    logger.warn(`[KC-NOTIF] unknown event type: ${event.event}`, { agentId });
    return;
  }

  // Gateway readiness guard.
  // ensureGatewayRunning() returns { ok: false } (no throw) when not configured,
  // and throws when the gateway fails to start. Both cases mean not ready.
  let gatewayReady = false;
  let gatewayErr = null;
  try {
    const result = await ensureGatewayRunning();
    gatewayReady = result?.ok === true;
    if (!gatewayReady) gatewayErr = result?.reason ?? "unknown";
  } catch (err) {
    gatewayReady = false;
    gatewayErr = err?.message ?? String(err);
  }
  logger.info(`[KC-NOTIF] gateway readiness check`, {
    agentId,
    gatewayReady,
    reason: gatewayErr,
  });

  if (!gatewayReady) {
    enqueue(event);
    logger.warn(
      `[KC-NOTIF] gateway not ready — queued ${event.event} for agent ${agentId}`,
      { reason: gatewayErr }
    );
    return;
  }

  // Gateway is up. Drain any backlog for all agents before processing the
  // current event so queued approvals are not overtaken by a fresh wake-up.
  if (pendingQueues.size > 0) {
    await drainAllQueues();
  }

  // Now process the current event.
  if (event.event === "approval_actioned") {
    // Never coalesced.
    logger.info(`[KC-NOTIF] dispatching approval_actioned`, { agentId, taskId: event.taskId });
    await dispatchApprovalActioned(agentId, message);
  } else {
    // tasks_available or task_assigned — apply coalescing.
    if (isCoalescing(agentId)) {
      logger.info(
        `[KC-NOTIF] coalescing ${event.event} for agent ${agentId} (already in-flight, within ${COALESCE_WINDOW_MS}ms window)`
      );
      return;
    }
    logger.info(`[KC-NOTIF] dispatching wake-up`, { agentId, event: event.event });
    await dispatchWakeup(agentId, message);
  }

  logger.info(`[KC-NOTIF] handleEvent end`, { agentId, event: event.event });
}

// ---------------------------------------------------------------------------
// Router factory.
// jwtSecret: same JWT_SECRET used by all /api/* routes — the orchestrator signs
// notifications with openclaw_jwt_secret which equals JWT_SECRET on this tenant.
// ensureGatewayRunning: from server.js — starts the gateway if not running.
// ---------------------------------------------------------------------------
export function createNotificationsRouter(jwtSecret, ensureGatewayRunning) {
  const router = express.Router();

  logger.info(`[KC-NOTIF] notifications router initialised`, {
    jwtSecretPresent: Boolean(jwtSecret),
  });

  // Auth: JWT signed by the orchestrator with openclaw_jwt_secret (= JWT_SECRET).
  function requireJwt(req, res, next) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      logger.warn(`[KC-NOTIF] JWT check failed: missing/invalid Authorization header`, {
        hasHeader: Boolean(header),
        remote: req.socket?.remoteAddress,
      });
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const token = header.slice(7);
    try {
      req.jwtPayload = jwt.verify(token, jwtSecret);
      next();
    } catch (err) {
      logger.warn(`[KC-NOTIF] JWT verify failed`, {
        error: err?.message ?? String(err),
        remote: req.socket?.remoteAddress,
      });
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  /**
   * POST /api/notifications/tasks
   *
   * Body shapes (pure wake-ups — agent fetches task state via kc_get_task):
   *   { event: "tasks_available",   agentId }
   *   { event: "task_assigned",     agentId, taskId }
   *   { event: "approval_actioned", agentId, taskId }
   *
   * Responds immediately (202) — agent triggering is async.
   */
  router.post("/tasks", (req, res, next) => {
    logger.info(`[KC-NOTIF] POST /api/notifications/tasks received`, {
      remote: req.socket?.remoteAddress,
      bodyKeys: Object.keys(req.body ?? {}),
      event: req.body?.event,
      agentId: req.body?.agentId,
      taskId: req.body?.taskId,
    });
    next();
  }, requireJwt, async (req, res) => {
    const { event, agentId, taskId } = req.body ?? {};

    if (!event || !agentId) {
      logger.warn(`[KC-NOTIF] validation failed: missing event or agentId`, { event, agentId });
      return res.status(400).json({ error: "event and agentId are required" });
    }

    const VALID_EVENTS = new Set(["tasks_available", "task_assigned", "approval_actioned"]);
    if (!VALID_EVENTS.has(event)) {
      logger.warn(`[KC-NOTIF] validation failed: unknown event type`, { event, agentId });
      return res.status(400).json({ error: `Unknown event type: ${event}` });
    }

    if (event === "approval_actioned" && !taskId) {
      logger.warn(`[KC-NOTIF] validation failed: approval_actioned missing taskId`, { agentId });
      return res.status(400).json({ error: "approval_actioned requires taskId" });
    }

    if (event === "task_assigned" && !taskId) {
      logger.warn(`[KC-NOTIF] validation failed: task_assigned missing taskId`, { agentId });
      return res.status(400).json({ error: "task_assigned requires taskId" });
    }

    // Respond immediately — agent triggering is async.
    res.status(202).json({ ok: true });
    logger.info(`[KC-NOTIF] accepted (202) — handing to handleEvent`, { event, agentId, taskId });

    // Process without blocking the response.
    const normalizedEvent = { event, agentId, taskId };
    handleEvent(normalizedEvent, ensureGatewayRunning).catch((err) => {
      logger.error(`[KC-NOTIF] unhandled error in handleEvent: ${err.message}`, err);
    });
  });

  return router;
}
