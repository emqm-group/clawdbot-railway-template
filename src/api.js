/**
 * API Routes - Completely isolated from gateway proxy
 * JWT-authenticated REST API for agent management
 * This file handles ONLY /api/* routes and never touches the gateway
 */
import agentRoutes from "./agents/routes/agentRoutes.js";
import fileRoutes from "./agents/routes/fileRoutes.js";
import usageRoutes from "./agents/routes/usageRoutes.js";
import { createToolsRouter } from "./agents/routes/toolsRoutes.js";
import { authMiddleware } from "./agents/middleware/auth.js";
import logger from "./agents/utils/logger.js";
import openclawService from "./agents/utils/openclawService.js";

export function setupApiRoutes(app, jwtSecret, restartGateway) {
  // --- Agent Management API Routes ---
  // These are COMPLETELY ISOLATED and do NOT pass through gateway proxy
  // Registered FIRST before any catch-all middleware

  app.use("/api", (req, res, next) => {
    logger.info("API LAYER HIT", {
      methos: req.method,
      url: req.originalUrl,
    });
    next();
  });

  app.use("/api/agents", authMiddleware(jwtSecret), agentRoutes);
  app.use("/api/files", authMiddleware(jwtSecret), fileRoutes);
  app.use("/api/usage", authMiddleware(jwtSecret), usageRoutes);
  app.use("/api/tools", createToolsRouter(process.env.ORCHESTRATOR_SECRET?.trim(), restartGateway));

  /**
   * POST /api/devices/approve
   * Approve a device pairing request.
   * Body: { requestId: string }
   */
  app.post("/api/devices/approve", authMiddleware(jwtSecret), async (req, res) => {
    const requestId = String(req.body?.requestId || "").trim();
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
      return res.status(400).json({ error: "Invalid requestId" });
    }
    try {
      const result = await openclawService.approveDevice(requestId);
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  /**
   * POST /api/system/heartbeat
   * Enable or disable the system-wide heartbeat across all agents.
   * Runtime toggle — does not modify openclaw.json.
   * Body: { action: "enable" | "disable" }
   */
  app.post("/api/system/heartbeat", authMiddleware(jwtSecret), async (req, res) => {
    const action = String(req.body?.action || "").trim();
    if (action !== "enable" && action !== "disable") {
      return res.status(400).json({ error: 'action must be "enable" or "disable"' });
    }
    try {
      const result = await openclawService.setHeartbeat(action);
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  /**
   * POST /api/gateway/restart
   * Restart the openclaw gateway. Required after gateway.bind or gateway.port changes.
   */
  app.post("/api/gateway/restart", authMiddleware(jwtSecret), async (_req, res) => {
    try {
      logger.info("POST /api/gateway/restart");
      await restartGateway();
      return res.json({ success: true });
    } catch (error) {
      logger.error("Gateway restart endpoint failed", error);
      return res.status(500).json({ error: error.message || "Failed to restart gateway" });
    }
  });

  // Catch-all 404 for unmapped /api/* routes
  // This prevents /api/* from ever reaching the gateway proxy
  app.use("/api/", (req, res) => {
    res.status(404).json({
      error: "API endpoint not found",
      path: req.path,
      method: req.method,
    });
  });
}

export default setupApiRoutes;
