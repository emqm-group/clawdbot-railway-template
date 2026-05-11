// Tenant-mapping cache (shared-gateway model, Decision #8 / Wrapper Impl #1).
//
// Holds an in-memory Map<agentId, tenantId> for every active tenant on this
// shard. Populated at boot by GET /internal/shards/:shardId/tenant-mappings
// and kept in sync by POST /internal/refresh-mappings deltas from the
// orchestrator. Used by the outbound /internal/* callers to resolve which
// tenant owns the calling agent without trusting any client-supplied tenantId.

import logger from "./logger.js";

const cache = new Map();

// Single-flight load — any concurrent boot fetch + cache-miss re-fetch (or
// multiple concurrent misses) share one HTTP round-trip to the orchestrator.
let inflightLoad = null;

function readEnv() {
  return {
    shardId: process.env.SHARD_ID?.trim() || null,
    orchestratorUrl: process.env.ORCHESTRATOR_URL?.trim() || null,
    orchestratorSecret: process.env.ORCHESTRATOR_SECRET?.trim() || null,
  };
}

export function isConfigured() {
  const { shardId, orchestratorUrl, orchestratorSecret } = readEnv();
  return Boolean(shardId && orchestratorUrl && orchestratorSecret);
}

function normalizeSnapshot(data) {
  // Accept either [{tenantId, agentIds}] or { tenants: [...] } shapes.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tenants)) return data.tenants;
  return [];
}

function populateFromSnapshot(snapshot) {
  cache.clear();
  for (const entry of snapshot) {
    if (!entry?.tenantId || !Array.isArray(entry.agentIds)) continue;
    for (const agentId of entry.agentIds) {
      if (typeof agentId === "string" && agentId) {
        cache.set(agentId, entry.tenantId);
      }
    }
  }
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchSnapshot() {
  const { shardId, orchestratorUrl, orchestratorSecret } = readEnv();
  if (!shardId || !orchestratorUrl || !orchestratorSecret) {
    throw new Error(
      "tenant-mappings: SHARD_ID, ORCHESTRATOR_URL, and ORCHESTRATOR_SECRET must all be set"
    );
  }
  const url = `${orchestratorUrl}/internal/shards/${encodeURIComponent(shardId)}/tenant-mappings`;
  // Node's global fetch has no default timeout; without one, an
  // orchestrator that opens the TCP socket but stalls would block the
  // wrapper's boot await forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${orchestratorSecret}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`tenant-mappings: orchestrator request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `tenant-mappings: orchestrator returned ${res.status} ${text.slice(0, 200)}`
    );
  }
  const data = await res.json();
  return normalizeSnapshot(data);
}

export function loadFromOrchestrator() {
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      const snapshot = await fetchSnapshot();
      populateFromSnapshot(snapshot);
      logger.info("[tenant-mappings] cache loaded from orchestrator", {
        agentCount: cache.size,
        shardId: readEnv().shardId,
      });
      return cache.size;
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

export function getTenantIdSync(agentId) {
  return cache.get(agentId) ?? null;
}

// Async lookup. Cache miss triggers a single-flight re-fetch; concurrent
// misses for the same (or different) agentIds share one in-flight request.
// Returns null if the agentId is still unknown after the re-fetch — caller
// is responsible for returning the structured `unknown_agent` error.
export async function getTenantId(agentId) {
  const hit = cache.get(agentId);
  if (hit) return hit;

  if (!isConfigured()) {
    logger.warn("[tenant-mappings] cache miss but cache not configured", { agentId });
    return null;
  }

  try {
    await loadFromOrchestrator();
  } catch (err) {
    logger.error("[tenant-mappings] re-fetch failed", { error: err.message });
    return null;
  }
  return cache.get(agentId) ?? null;
}

// Apply a delta sent by the orchestrator on POST /internal/refresh-mappings.
// Body shapes (any combination):
//   { added: [{ tenantId, agentIds: [...] }, ...] }   — upsert agentId→tenantId
//   { removedAgentIds: [...] }                         — drop agentIds from cache
//   { tenants: [{ tenantId, agentIds: [...] }, ...] } — full snapshot replacement
export function applyDelta(delta) {
  let addCount = 0;
  let removeCount = 0;
  let replaced = false;

  if (Array.isArray(delta?.tenants)) {
    populateFromSnapshot(delta.tenants);
    replaced = true;
  }

  if (Array.isArray(delta?.added)) {
    for (const entry of delta.added) {
      if (!entry?.tenantId || !Array.isArray(entry.agentIds)) continue;
      for (const agentId of entry.agentIds) {
        if (typeof agentId === "string" && agentId) {
          cache.set(agentId, entry.tenantId);
          addCount++;
        }
      }
    }
  }

  if (Array.isArray(delta?.removedAgentIds)) {
    for (const agentId of delta.removedAgentIds) {
      if (cache.delete(agentId)) removeCount++;
    }
  }

  logger.info("[tenant-mappings] delta applied", {
    replaced,
    addCount,
    removeCount,
    total: cache.size,
  });
  return { replaced, addCount, removeCount, total: cache.size };
}

export function cacheStats() {
  return { totalAgents: cache.size, shardId: readEnv().shardId };
}

// Test-only — clears the cache between unit tests. Not exported via index.
export function _resetForTests() {
  cache.clear();
  inflightLoad = null;
}
