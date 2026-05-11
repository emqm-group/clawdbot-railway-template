import express from "express";
import * as directivesController from "../controllers/directivesController.js";
import { authMiddleware } from "../middleware/auth.js";

/**
 * @param {string|Function} gatewayToken - OPENCLAW_GATEWAY_TOKEN, or a getter for late binding
 * @param {Function} restartGateway - from server.js
 */
export function createDirectivesRouter(gatewayToken, restartGateway) {
  const router = express.Router();

  router.use(authMiddleware(gatewayToken));

  router.get("/:agentId", (req, res) => directivesController.list(req, res));
  router.post("/:agentId", (req, res) => directivesController.create(req, res, restartGateway));
  router.get("/:agentId/:name", (req, res) => directivesController.get(req, res));
  router.put("/:agentId/:name", (req, res) => directivesController.update(req, res, restartGateway));
  router.delete("/:agentId/:name", (req, res) => directivesController.remove(req, res, restartGateway));

  return router;
}
