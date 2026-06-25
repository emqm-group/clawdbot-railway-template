import express from "express";
import {
  getGatewayUsage,
  getAllAgentsUsage,
  getAgentUsage,
  getAgentTaskTurns,
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

/**
 * GET /api/usage/agents/:agentId/turns
 * Per-turn token + cost for the agent's task session (`agent:<agentId>:main`).
 * The per-task cost-tracking capture source (design doc §9, workstream B).
 * Query: ?since=<epochMs>&until=<epochMs>&limit=<n> (all optional)
 */
router.get("/agents/:agentId/turns", getAgentTaskTurns);

export default router;
