/**
 * API Routes - Completely isolated from gateway proxy
 * JWT-authenticated REST API for agent management
 * This file handles ONLY /api/* routes and never touches the gateway
 */
import agentRoutes from "./agents/routes/agentRoutes.js";
import fileRoutes from "./agents/routes/fileRoutes.js";
import { authMiddleware } from "./agents/middleware/auth.js";
import logger from "./agents/utils/logger.js";

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
