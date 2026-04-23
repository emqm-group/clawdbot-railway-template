import express from "express";
import * as directivesController from "../controllers/directivesController.js";

/**
 * @param {string} orchestratorSecret - shared secret for inbound orchestrator calls
 * @param {Function} restartGateway - from server.js
 */
export function createDirectivesRouter(orchestratorSecret, restartGateway) {
  const router = express.Router();

  function requireOrchestratorSecret(req, res, next) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!orchestratorSecret || token !== orchestratorSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }

  router.use(requireOrchestratorSecret);

  router.get("/:agentId", (req, res) => directivesController.list(req, res));
  router.post("/:agentId", (req, res) => directivesController.create(req, res, restartGateway));
  router.get("/:agentId/:name", (req, res) => directivesController.get(req, res));
  router.put("/:agentId/:name", (req, res) => directivesController.update(req, res, restartGateway));
  router.delete("/:agentId/:name", (req, res) => directivesController.remove(req, res, restartGateway));

  return router;
}
