import express from "express";
import * as agentController from "../controllers/agentController.js";

const router = express.Router();

/**
 * POST /api/agents
 * Create a new agent
 * Body: { agentId: string, name?: string, workspace?: string, model?: string }
 */
router.post("/", agentController.createAgent);

/**
 * GET /api/agents/:agentId
 * Get agent details
 */
router.get("/:agentId", agentController.getAgent);

/**
 * GET /api/agents
 * List all agents
 */
router.get("/", agentController.listAgents);

/**
 * PATCH /api/agents/:agentId/config
 * Update openclaw config for an agent
 * Body: { configUpdate: object }
 */
router.patch("/:agentId/config", agentController.updateAgentConfig);

/**
 * PATCH /api/agents/:agentId
 * Update agent metadata
 * Body: { name?: string, workspace?: string, model?: string, ... }
 */
router.patch("/:agentId", agentController.updateAgent);

/**
 * DELETE /api/agents/:agentId
 * Delete an agent
 */
router.delete("/:agentId", agentController.deleteAgent);

export default router;
