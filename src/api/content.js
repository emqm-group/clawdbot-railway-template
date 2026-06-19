/**
 * Content proxy router — /api/content/*
 *
 * Loopback-only endpoints called by the deep-lattice-tools plugin running
 * inside the openclaw gateway subprocess (same container). Covers the tenant's
 * published-content reads — social posts (Buffer) and blog posts — which are
 * separate orchestrator services/entities from Deep Lattice even though they
 * ride the same shard-secret transport (see ./internalProxy.js).
 *
 * READ-ONLY by construction: content WRITES go through the tool invoke path
 * (/api/tools/invoke → /internal/tools/:tenantId/invoke — the Buffer/blog
 * pathway), never here.
 *
 *   - social-posts → /internal/buffer/posts  (scoped by `channel`)
 *   - blog-posts   → /internal/blog/posts    (single channel, no filter)
 *
 * No JWT/Bearer auth on the loopback surface: only reachable from 127.0.0.1;
 * the requireLoopback guard (in internalProxy) enforces this.
 */

import express from "express";
import { createInternalProxy } from "./internalProxy.js";

export function createContentRouter() {
  const router = express.Router();
  // No defaultBasePath — each route names its own internal router (buffer/blog).
  const { requireLoopback, forward } = createInternalProxy("content");

  router.use(requireLoopback);

  // GET /api/content/social-posts?agentId=&channel=
  // → GET /internal/buffer/posts?tenantId=&agent_id=&channel=
  // Read-only: the tenant's drafted/published social posts, newest first, each
  // with its latest content. `channel` ∈ linkedin_page | linkedin_personal | x
  // scopes the read server-side (before the cap); the read_social_posts tool
  // always supplies it.
  router.get("/social-posts", (req, res) => {
    return forward(req, res, "/posts", { channel: req.query.channel }, { basePath: "/internal/buffer" });
  });

  // GET /api/content/blog-posts?agentId=
  // → GET /internal/blog/posts?tenantId=&agent_id=
  // Read-only: the tenant's drafted/published blog posts, newest first, each
  // with its latest content. Single channel — no `channel` filter (unlike
  // social-posts). Writes happen via the draft_blog_post invoke path.
  router.get("/blog-posts", (req, res) => {
    return forward(req, res, "/posts", undefined, { basePath: "/internal/blog" });
  });

  return router;
}
