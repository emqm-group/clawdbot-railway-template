import express from "express";
import * as toolsController from "../controllers/toolsController.js";
import { authMiddleware } from "../middleware/auth.js";

/**
 * @param {string|Function} gatewayToken - OPENCLAW_GATEWAY_TOKEN, or a getter for late binding
 * @param {Function} restartGateway - from server.js
 */
export function createToolsRouter(gatewayToken, restartGateway) {
  const router = express.Router();

  // Loopback-only guard — /api/tools/invoke is called by the third-party-tools
  // plugin running inside the gateway subprocess. Uses req.socket.remoteAddress
  // (raw TCP) intentionally — req.ip respects X-Forwarded-For and can be
  // spoofed by an external caller.
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
    authMiddleware(gatewayToken),
    (req, res) => toolsController.register(req, res, restartGateway)
  );

  // POST /api/tools/invoke — third-party-tools plugin calls this (loopback only)
  router.post("/invoke", requireLoopback, toolsController.invoke);

  return router;
}
