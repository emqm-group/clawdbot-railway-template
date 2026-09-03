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
 * One route here is NOT Deep Lattice: /signup-preview forwards to the
 * orchestrator's /internal/signup-preview (own table, own bucket prefix, mounted
 * outside /internal/deep-lattice). It lives here because its tool ships in the
 * deep-lattice-tools plugin, which keeps one loopback base URL — the same reason
 * ./content.js spans /internal/buffer and /internal/blog. The cross-service hop
 * is explicit: that route passes its own basePath.
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

  // POST /api/deep-lattice/profile/:slug
  // → POST /internal/deep-lattice/profile/:slug
  // Body: { agent_id, content, tenantId }
  // create_profile_file — CRO authors a generated profile doc during onboarding.
  // Distinct create verb (vs the PUT update above); idempotent create-or-overwrite
  // so a task Retry re-authors safely. (onboarding-flow-design.md §4)
  router.post("/profile/:slug", (req, res) => {
    return forward(req, res, `/profile/${encodeURIComponent(req.params.slug)}`);
  });

  // ── Founder's Style (migration 010) ────────────────────────
  // One document, two sections stored as two blobs orchestrator-side. The GET
  // returns them composed into a single markdown doc (404 when nothing has been
  // written yet). The PUT writes the `published` section ONLY — `published` is a
  // fixed path segment, not a param: the founder's `intended` section is their
  // own words and has no agent-facing write path.

  // GET /api/deep-lattice/founder-style?agentId=
  // → GET /internal/deep-lattice/founder-style?tenantId=&agent_id=
  router.get("/founder-style", (req, res) => {
    return forward(req, res, "/founder-style");
  });

  // PUT /api/deep-lattice/founder-style/published/content
  // → PUT /internal/deep-lattice/founder-style/published/content
  // Body: { agent_id, content, tenantId }
  router.put("/founder-style/published/content", (req, res) => {
    return forward(req, res, "/founder-style/published/content");
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

  // GET /api/deep-lattice/daily-target-composite?agentId=
  // → GET /internal/deep-lattice/daily-target-composite?tenantId=&agent_id=
  // The collated daily-target composite (migration 012): every day's plan table
  // stacked into one file. READ ONLY — no POST route here or orchestrator-side;
  // the orchestrator maintains the file on every daily-targets write.
  router.get("/daily-target-composite", (req, res) => {
    return forward(req, res, "/daily-target-composite");
  });

  // publishing_schedule (migration 013) — the channel-wise weekly cadence, its
  // own file rather than prose inside the content strategy. Latest-wins and
  // written by BOTH sides: the agent POSTs a new version, the founder edits it
  // from the tenant UI. No title on the write — one document per tenant, so the
  // orchestrator fixes the title server-side.
  router.post("/publishing-schedule", (req, res) => {
    return forward(req, res, "/publishing-schedule");
  });
  router.get("/publishing-schedule", (req, res) => {
    return forward(req, res, "/publishing-schedule");
  });

  // ── Campaign files (migration 019) ─────────────────────────
  // A campaign's working strategy, one markdown file per function ("content"
  // in v1). Campaign-scoped, unlike every other agent document here, so the
  // campaign id is a path segment on both routes — the orchestrator resolves
  // the campaign within the tenant and 404s `campaign_not_found` when it does
  // not belong to it.
  //
  // The write takes the WHOLE FILE — header block and body. The orchestrator
  // stores it verbatim and composes no part of it, so the campaign's
  // definition in the header is agent-written, read back from
  // GET /campaigns/:campaignId. The database remains the source of truth; the
  // Memory Manager is fired a resync task to realign the file when a mirrored
  // field moves, which only works because the header is the agent's to write.
  //
  // Rewritten in place at a key stable per (campaign, function) — one live
  // document per pair, like the daily-target composite.
  //
  // The orchestrator's GET /campaigns/:campaignId/files (which functions a
  // campaign has a file for) is deliberately NOT proxied: with `content` the
  // only function, read_campaign_file returning null already answers it. Add
  // it alongside outbound/ads, so the list and the read agree on what exists.
  //
  // Campaign DISCOVERY is a different question and does have a route — see
  // GET /campaigns below. Everything past it takes an id from the task.

  // GET /api/deep-lattice/campaigns?agentId=
  // → GET /internal/deep-lattice/campaigns?tenantId=&agent_id=
  // Every ACTIVE campaign with its channel claims — what the cross-campaign
  // planner runs on. Active is the whole filter: no other status takes new
  // work, so returning one would invite volume that task creation refuses.
  // Registered before /campaigns/:campaignId to mirror the orchestrator's
  // ordering; the two do not actually collide (different segment counts).
  router.get("/campaigns", (req, res) => {
    return forward(req, res, "/campaigns");
  });

  // GET /api/deep-lattice/campaigns/:campaignId?agentId=
  // → GET /internal/deep-lattice/campaigns/:campaignId?tenantId=&agent_id=
  // The campaign's DEFINITION — what it is aimed at and what it says. Read
  // before proposing a campaign's angles and topics: a newly created campaign
  // has no file yet, so the definition is the only input that exists. Carries
  // no ceiling or headroom figures — volumes are computed, not proposed (D23).
  router.get("/campaigns/:campaignId", (req, res) => {
    return forward(req, res, `/campaigns/${encodeURIComponent(req.params.campaignId)}`);
  });

  // GET /api/deep-lattice/campaigns/:campaignId/files/:fn?agentId=
  // → GET /internal/deep-lattice/campaigns/:campaignId/files/:fn?tenantId=&agent_id=
  router.get("/campaigns/:campaignId/files/:fn", (req, res) => {
    return forward(
      req,
      res,
      `/campaigns/${encodeURIComponent(req.params.campaignId)}/files/${encodeURIComponent(req.params.fn)}`
    );
  });

  // POST /api/deep-lattice/campaigns/:campaignId/files/:fn
  // → POST /internal/deep-lattice/campaigns/:campaignId/files/:fn
  // Body: { agent_id, content, tenantId }
  router.post("/campaigns/:campaignId/files/:fn", (req, res) => {
    return forward(
      req,
      res,
      `/campaigns/${encodeURIComponent(req.params.campaignId)}/files/${encodeURIComponent(req.params.fn)}`
    );
  });

  // ── Pre-signup briefs (NOT Deep Lattice) ───────────────────
  // GET /api/deep-lattice/signup-preview?agentId=&kind=
  // → GET $ORCH/internal/signup-preview?tenantId=&agent_id=&kind=
  // The two documents the orchestrator generated from the company URL before
  // the founder signed up. Its own internal mount (own table + bucket prefix),
  // so this route carries an explicit basePath. READ ONLY — no write route
  // here or orchestrator-side; the briefs are a fixed record of what the
  // prospect was shown.
  router.get("/signup-preview", (req, res) => {
    return forward(req, res, "", { kind: req.query.kind }, { basePath: "/internal/signup-preview" });
  });

  return router;
}
