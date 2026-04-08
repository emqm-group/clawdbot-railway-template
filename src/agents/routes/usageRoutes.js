import express from "express";
import {
  getGatewayUsage,
  getAllAgentsUsage,
  getAgentUsage,
} from "../controllers/usageController.js";

const router = express.Router();

/**
 * GET /api/usage
 * Gateway-wide cost summary (daily breakdown + totals).
 * Query: ?days=30
 */
router.get("/", getGatewayUsage);

/**
 * GET /api/usage/agents
 * Per-agent cost summary sorted by totalCost descending.
 * Query: ?days=30
 */
router.get("/agents", getAllAgentsUsage);

/**
 * GET /api/usage/agents/:agentId
 * Cost summary for a specific agent across all its sessions.
 */
router.get("/agents/:agentId", getAgentUsage);

export default router;
