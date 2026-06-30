/**
 * Utility proxy router — /api/utility/*
 *
 * Loopback-only endpoint called by the utility-tools plugin running inside the
 * openclaw gateway subprocess (same container). Forwards the "simple utility
 * functions" group to the orchestrator's /internal/utility/invoke — pure,
 * stateless, side-effect-free compute (no OAuth, no approval, no task binding),
 * gated server-side by the shard secret only (requireShardSecretFromAgentBody).
 *
 * Same shard-secret transport as the Content and Deep Lattice proxies (see
 * ./internalProxy.js): the forward resolves tenantId from the calling agentId,
 * injects tenantId + agent_id + ORCHESTRATOR_SECRET Bearer, and proxies the body
 * { tool, params } through. Unlike the tool-invoke path it does NOT hit
 * /internal/tools/:tenantId/invoke — utility tools have no processing-task
 * invariant and no agent_tools authz gate.
 *
 * No JWT/Bearer auth on the loopback surface: only reachable from 127.0.0.1;
 * the requireLoopback guard (in internalProxy) enforces this.
 */

import express from "express";
import { createInternalProxy } from "./internalProxy.js";

export function createUtilityRouter() {
  const router = express.Router();
  const { requireLoopback, forward } = createInternalProxy("utility");

  router.use(requireLoopback);

  // POST /api/utility/invoke  body: { agentId, tool, params }
  // → POST /internal/utility/invoke  body: { tenantId, agent_id, tool, params }
  router.post("/invoke", (req, res) => {
    return forward(req, res, "/invoke", undefined, { basePath: "/internal/utility" });
  });

  return router;
}
