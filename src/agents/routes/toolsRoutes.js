import express from "express";
import * as toolsController from "../controllers/toolsController.js";

/**
 * @param {string} jwtSecret - unused here but kept for consistent signature
 * @param {string} orchestratorSecret - shared secret for inbound orchestrator calls
 * @param {Function} restartGateway - from server.js
 */
export function createToolsRouter(orchestratorSecret, restartGateway) {
  const router = express.Router();

  // Auth middleware for orchestrator-to-wrapper calls
  function requireOrchestratorSecret(req, res, next) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!orchestratorSecret || token !== orchestratorSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }

  // Loopback-only guard — /api/tools/invoke is called by the plugin inside the container.
  // Uses req.socket.remoteAddress (raw TCP) intentionally — req.ip respects X-Forwarded-For
  // and can be spoofed by an external caller.
  function requireLoopback(req, res, next) {
    const ip = req.socket?.remoteAddress || "";
    const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoopback) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  }

  // POST /api/tools/register — orchestrator pushes tool definitions
  router.post(
    "/register",
    requireOrchestratorSecret,
    (req, res) => toolsController.register(req, res, restartGateway)
  );

  // POST /api/tools/invoke — third-party-tools plugin calls this (loopback only)
  router.post("/invoke", requireLoopback, toolsController.invoke);

  return router;
}
