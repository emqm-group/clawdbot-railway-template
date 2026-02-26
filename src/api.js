/**
 * API Routes - Completely isolated from gateway proxy
 * JWT-authenticated REST API for agent management
 * This file handles ONLY /api/* routes and never touches the gateway
 */
import agentRoutes from "./agents/routes/agentRoutes.js";
import { authMiddleware } from "./agents/middleware/auth.js";

export function setupApiRoutes(app, jwtSecret) {
  // --- Agent Management API Routes ---
  // These are COMPLETELY ISOLATED and do NOT pass through gateway proxy
  // Registered FIRST before any catch-all middleware
  console.log("API ROUTES REGISTERED");
  app.use("/api/agents", authMiddleware(jwtSecret), agentRoutes);

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
