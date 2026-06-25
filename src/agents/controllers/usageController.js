import openclawService from "../utils/openclawService.js";
import logger from "../utils/logger.js";

/**
 * Extract agentId from a session key of the form "agent:<agentId>:<scope>"
 */
function extractAgentId(key) {
  const match = key?.match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

/**
 * Validate and return a YYYY-MM-DD date string, or null if invalid/absent.
 */
function parseDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/**
 * Sum cost/token fields across an array of totals objects.
 */
function aggregateTotals(totalsArray) {
  const zero = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    totalCost: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0,
    missingCostEntries: 0,
  };
  return totalsArray.reduce((acc, t) => {
    if (!t) return acc;
    for (const k of Object.keys(zero)) {
      acc[k] = (acc[k] || 0) + (t[k] || 0);
    }
    return acc;
  }, { ...zero });
}

/**
 * Merge per-session dailyBreakdown arrays by date, summing tokens + cost.
 */
function mergeDailyBreakdowns(breakdowns) {
  const byDate = {};
  for (const day of breakdowns.flat()) {
    if (!day?.date) continue;
    if (!byDate[day.date]) {
      byDate[day.date] = { date: day.date, tokens: 0, cost: 0 };
    }
    byDate[day.date].tokens += day.tokens || 0;
    byDate[day.date].cost += day.cost || 0;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * GET /api/usage
 * Gateway-wide cost summary. Wraps usage.cost RPC.
 * Query: ?days=30
 */
export async function getGatewayUsage(req, res) {
  const startDate = parseDate(req.query.startDate);
  const endDate = parseDate(req.query.endDate);
  const days = parseInt(req.query.days) || 30;
  try {
    const data = await openclawService.getUsageCost({ days, startDate, endDate });
    return res.json(data);
  } catch (error) {
    logger.error("getGatewayUsage failed", error);
    return res.status(500).json({ error: error.message || "Failed to get usage cost" });
  }
}

/**
 * GET /api/usage/agents
 * Per-agent cost summary across all agents.
 * Calls sessions.list → groups by agentId → calls sessions.usage per key → aggregates.
 * Query: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (optional, defaults to gateway's last 30 days)
 */
export async function getAllAgentsUsage(req, res) {
  const startDate = parseDate(req.query.startDate);
  const endDate = parseDate(req.query.endDate);
  try {
    const sessions = await openclawService.getSessionsList();

    // Group session keys by agentId
    const byAgent = {};
    for (const s of sessions) {
      const agentId = s.agentId || extractAgentId(s.key);
      if (!agentId || !s.key) continue;
      if (!byAgent[agentId]) byAgent[agentId] = [];
      byAgent[agentId].push(s.key);
    }

    // Fetch usage for all agents in parallel
    const agents = await Promise.all(
      Object.entries(byAgent).map(async ([agentId, keys]) => {
        const usageResults = await Promise.all(
          keys.map((key) =>
            openclawService.getSessionUsage(key, { startDate, endDate }).catch((err) => {
              logger.warn("getSessionUsage failed", { key, error: err.message });
              return null;
            })
          )
        );

        const valid = usageResults.filter(Boolean);
        const allSessionDetails = valid.flatMap((u) => u.sessions ?? []);
        const allDailyBreakdowns = allSessionDetails.map((s) => s.usage?.dailyBreakdown ?? []);
        const totalsArray = valid.map((u) => u.totals).filter(Boolean);

        return {
          agentId,
          sessionCount: keys.length,
          totals: aggregateTotals(totalsArray),
          dailyBreakdown: mergeDailyBreakdowns(allDailyBreakdowns),
        };
      })
    );

    // Sort by totalCost descending so highest-cost agents appear first
    agents.sort((a, b) => (b.totals.totalCost || 0) - (a.totals.totalCost || 0));

    return res.json({ agents, generatedAt: Date.now() });
  } catch (error) {
    logger.error("getAllAgentsUsage failed", error);
    return res.status(500).json({ error: error.message || "Failed to get agent usage" });
  }
}

/**
 * Parse an epoch-milliseconds query param, or null if absent/invalid.
 * Log timestamps from `sessions.usage.logs` are epoch ms.
 */
function parseEpochMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /api/usage/agents/:agentId/turns
 * Per-turn token + cost for an agent's task session (`agent:<agentId>:main`),
 * the capture source for per-task cost tracking. Wraps `sessions.usage.logs`,
 * keeps only assistant turns (the rows that carry tokens/cost), and optionally
 * slices to a task window with epoch-ms bounds.
 * Query: ?since=<epochMs>&until=<epochMs>&limit=<n>  (all optional)
 * Returns: { key, since, until, count, totals: { tokens, cost }, turns: [...] }
 */
export async function getAgentTaskTurns(req, res) {
  const { agentId } = req.params;
  if (!agentId || !/^[A-Za-z0-9_-]+$/.test(agentId)) {
    return res.status(400).json({ error: "Invalid agentId" });
  }
  const since = parseEpochMs(req.query.since);
  const until = parseEpochMs(req.query.until);
  const limit = req.query.limit != null ? parseInt(req.query.limit) || 1000 : 1000;

  // KC task turns always run in the agent's pinned main session (see design doc §7).
  const key = `agent:${agentId}:main`;

  try {
    const data = await openclawService.getSessionUsageLogs(key, { limit });
    const logs = Array.isArray(data) ? data : data?.logs ?? [];

    const turns = logs
      // Only assistant turns carry token/cost usage.
      .filter((e) => e && e.role === "assistant" && e.tokens != null)
      // Slice to the task window when bounds are supplied (epoch ms).
      .filter((e) => (since == null || e.timestamp >= since) && (until == null || e.timestamp <= until))
      .map((e) => ({ timestamp: e.timestamp, tokens: e.tokens || 0, cost: e.cost || 0 }));

    const totals = turns.reduce(
      (acc, t) => ({ tokens: acc.tokens + t.tokens, cost: acc.cost + t.cost }),
      { tokens: 0, cost: 0 }
    );

    return res.json({ key, since, until, count: turns.length, totals, turns });
  } catch (error) {
    logger.error("getAgentTaskTurns failed", error, { agentId, since, until });
    return res.status(500).json({ error: error.message || "Failed to get agent task turns" });
  }
}

/**
 * GET /api/usage/agents/:agentId
 * Cost summary for a specific agent across all its sessions.
 * Query: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (optional, defaults to gateway's last 30 days)
 */
export async function getAgentUsage(req, res) {
  const { agentId } = req.params;
  const startDate = parseDate(req.query.startDate);
  const endDate = parseDate(req.query.endDate);
  if (!agentId || !/^[A-Za-z0-9_-]+$/.test(agentId)) {
    return res.status(400).json({ error: "Invalid agentId" });
  }

  try {
    const sessions = await openclawService.getSessionsList();
    const agentSessions = sessions.filter(
      (s) => s.agentId === agentId || extractAgentId(s.key) === agentId
    );

    if (agentSessions.length === 0) {
      return res.json({
        agentId,
        sessionCount: 0,
        totals: aggregateTotals([]),
        dailyBreakdown: [],
        sessions: [],
      });
    }

    const usageResults = await Promise.all(
      agentSessions.map((s) =>
        openclawService.getSessionUsage(s.key, { startDate, endDate }).catch((err) => {
          logger.warn("getSessionUsage failed", { key: s.key, error: err.message });
          return null;
        })
      )
    );

    const valid = usageResults.filter(Boolean);
    const allSessionDetails = valid.flatMap((u) => u.sessions ?? []);
    const allDailyBreakdowns = allSessionDetails.map((s) => s.usage?.dailyBreakdown ?? []);
    const totalsArray = valid.map((u) => u.totals).filter(Boolean);

    return res.json({
      agentId,
      sessionCount: agentSessions.length,
      totals: aggregateTotals(totalsArray),
      dailyBreakdown: mergeDailyBreakdowns(allDailyBreakdowns),
      sessions: allSessionDetails,
    });
  } catch (error) {
    logger.error("getAgentUsage failed", error, { agentId });
    return res.status(500).json({ error: error.message || "Failed to get agent usage" });
  }
}
