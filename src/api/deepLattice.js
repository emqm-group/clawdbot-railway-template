/**
 * Deep Lattice proxy router — /api/deep-lattice/*
 *
 * Loopback-only endpoints called by the deep-lattice-tools plugin running
 * inside the openclaw gateway subprocess (same container). Resolves tenantId
 * from the calling agentId and forwards to the orchestrator's
 * /internal/deep-lattice/* routes. The shared transport (loopback guard +
 * tenant-resolving forward) lives in ./internalProxy.js; this file is just the
 * Deep Lattice route table.
 *
 * No profile/knowledge list/discovery endpoints — agents reach those files by
 * directive-supplied slug/filename. Briefings are written (POST) and read back
 * (GET /briefings, filtered by kind and/or date).
 *
 * Buffer (social posts) and Blog reads used to live here too; they are separate
 * services and now have their own router — see ./content.js (/api/content).
 *
 * NOTE: per-agent authorization has been removed orchestrator-side. The
 * orchestrator no longer gates which agent may call which operation; the shard
 * secret authenticates the wrapper, but any agent reaching these endpoints can
 * perform any DL op.
 */

import express from "express";
import { createInternalProxy } from "./internalProxy.js";

export function createDeepLatticeRouter() {
  const router = express.Router();
  const { requireLoopback, forward } = createInternalProxy("DL", {
    defaultBasePath: "/internal/deep-lattice",
  });

  router.use(requireLoopback);

  // GET /api/deep-lattice/profile/:slug
  // → GET /internal/deep-lattice/profile/:slug?tenantId=&agent_id=
  router.get("/profile/:slug", (req, res) => {
    return forward(req, res, `/profile/${encodeURIComponent(req.params.slug)}`);
  });

  // PUT /api/deep-lattice/profile/:slug/content
  // → PUT /internal/deep-lattice/profile/:slug/content
  // Body: { agent_id, content, tenantId }
  router.put("/profile/:slug/content", (req, res) => {
    return forward(req, res, `/profile/${encodeURIComponent(req.params.slug)}/content`);
  });

  // GET /api/deep-lattice/knowledge/:filename
  // → GET /internal/deep-lattice/knowledge/:filename?tenantId=&agent_id=
  router.get("/knowledge/:filename", (req, res) => {
    return forward(req, res, `/knowledge/${encodeURIComponent(req.params.filename)}`);
  });

  // GET /api/deep-lattice/templates/:filename
  // → GET /internal/deep-lattice/templates/:filename?tenantId=&agent_id=
  // Global (not tenant-scoped) admin-authored templates; read-only for agents.
  router.get("/templates/:filename", (req, res) => {
    return forward(req, res, `/templates/${encodeURIComponent(req.params.filename)}`);
  });

  // GET /api/deep-lattice/briefings?agentId=&kind=&date=
  // → GET /internal/deep-lattice/briefings?tenantId=&agent_id=&kind=&for_date=
  // Reads back briefings, optionally filtered by kind and/or date.
  // Agent-facing `date` maps to the orchestrator's `for_date` query param.
  router.get("/briefings", (req, res) => {
    return forward(req, res, "/briefings", {
      kind: req.query.kind,
      for_date: req.query.date ?? req.query.for_date,
    });
  });

  // POST /api/deep-lattice/briefings
  // → POST /internal/deep-lattice/briefings (creates a briefing)
  router.post("/briefings", (req, res) => {
    return forward(req, res, "/briefings");
  });

  // ── Agent documents (migration 018) ────────────────────────
  // analytics_report is typed + filterable; plan is subtyped + latest-wins per
  // subtype (migration 023); daily_target / execution_plan are untyped
  // latest-wins (POST writes a version, GET /latest reads the newest, 404 when
  // none exist yet).

  // POST /api/deep-lattice/analytics-reports → POST /internal/.../analytics-reports
  router.post("/analytics-reports", (req, res) => {
    return forward(req, res, "/analytics-reports");
  });

  // GET /api/deep-lattice/analytics-reports?agentId=&type=&duration=&date=
  // → GET /internal/deep-lattice/analytics-reports?tenantId=&agent_id=&type=&duration=&date=
  router.get("/analytics-reports", (req, res) => {
    return forward(req, res, "/analytics-reports", {
      type: req.query.type,
      duration: req.query.duration,
      date: req.query.date,
    });
  });

  // plan — subtyped + latest-wins per subtype (migration 023). POST carries
  // `subtype` in the body (flows through forward's ...rest); GET /plans/latest
  // requires ?subtype= (gtm|content-strategy|outbound-strategy), forwarded as
  // extraQuery. Orchestrator 404s when no plan exists for that subtype.
  router.post("/plans", (req, res) => {
    return forward(req, res, "/plans");
  });
  router.get("/plans/latest", (req, res) => {
    return forward(req, res, "/plans/latest", { subtype: req.query.subtype });
  });

  // daily_target | execution_plan — untyped latest-wins. POST writes a version;
  // GET /latest returns the newest (orchestrator 404s when none exist).
  for (const path of ["daily-targets", "execution-plans"]) {
    router.post(`/${path}`, (req, res) => {
      return forward(req, res, `/${path}`);
    });
    router.get(`/${path}/latest`, (req, res) => {
      return forward(req, res, `/${path}/latest`);
    });
  }

  return router;
}
