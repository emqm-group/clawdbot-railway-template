// Content Tools plugin.
// Registers the tenant's published-content tools as static, hand-written tools
// with fixed schemas and explicit metadata projection:
//   read_social_posts — Buffer-backed social posts (read-only, /internal/buffer/posts).
//   read_blog_posts   — blog posts (read-only, /internal/blog/posts).
//   draft_blog_post   — blog WRITE (internal; via the tool invoke path).
//
// These are a separate service from Deep Lattice — DL is the tenant's profile/
// knowledge/briefing filesystem; social and blog posts are published-content
// artifacts living in their own orchestrator stores. They get their own plugin
// rather than riding in deep-lattice-tools.
//
// Why draft_blog_post is defined here (not pushed like Buffer): Buffer is an
// OAuth integration — its tool definitions are pushed into openclaw.json per
// tenant only after the OAuth connect path runs (manifest → third-party-tools).
// Blog has NO OAuth and is fully internal, so its tool is baked into openclaw.json
// statically at auto-setup instead of waiting on a connect event. The Buffer
// social WRITES (post_to_*/draft_*) are still manifest-driven and are NOT here.
//
// The reads post to the wrapper's /api/content/* loopback router (resolves
// tenantId and forwards to /internal/buffer/* and /internal/blog/*). The blog
// WRITE posts to /api/tools/invoke, which forwards to the orchestrator's
// /internal/tools/:tenantId/invoke — the orchestrator resolves the agent's
// active task and the agent_tools gate server-side and runs executeBlogInvocation.
//
// Factory form (`api.registerTool((ctx) => ...)`): openclaw resolves tools
// per-agent and passes that agent's ctx.agentId. Agents never pass their own ID
// as a tool parameter — the wrapper sources it from ctx. Per-agent `tools.allow`
// is the actual gate — an agent only sees a content tool if it is listed in that
// agent's allowlist.

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
// Content read router (social + blog post reads).
const BASE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/content`;
// Generic tool-invoke path — the blog WRITE rides this (orchestrator resolves
// the agent's processing task + agent_tools gate, then executeBlogInvocation).
const INVOKE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/tools/invoke`;

function log(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[CONTENT-TOOLS] [${tool}] ${msg}${metaStr}`);
}

function logError(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[CONTENT-TOOLS] [${tool}] ERROR: ${msg}${metaStr}`);
}

async function callContent(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Content tool error [${res.status}]: ${data.error ?? data.message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

// Invoke an internal command via the generic tool-invoke path. Used by the blog
// WRITE — the orchestrator resolves the agent's processing task server-side, so
// only { agent_id, tool, params } is sent.
async function callInvoke(agentId, tool, params) {
  const res = await fetch(INVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, tool, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Content tool error [${data.code ?? res.status}]: ${data.message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

export default function register(api) {
  // read_social_posts — read back the tenant's drafted/published social posts,
  // newest first, each with its latest content (fetched from the bucket
  // orchestrator-side). Read-only: writes happen via the draft/post invoke path,
  // not here. Routes to the orchestrator's /internal/buffer/posts endpoint.
  api.registerTool((ctx) => ({
    name: "read_social_posts",
    description:
      "Read the tenant's social media post contents for one channel, newest first. channel is required — one of linkedin_page (company page), linkedin_personal (personal profile), or x. Returns a list of post content strings.",
    parameters: {
      type: "object",
      required: ["channel"],
      additionalProperties: false,
      properties: {
        channel: {
          type: "string",
          enum: ["linkedin_page", "linkedin_personal", "x"],
          description:
            "The channel to read: linkedin_page (company page), linkedin_personal (personal profile), or x.",
        },
      },
    },
    async execute(_toolCallId, { channel }) {
      const agentId = ctx.agentId;
      log("read_social_posts", "called", { agentId, channel });
      try {
        const qs = new URLSearchParams({ agentId, channel });
        const data = await callContent("GET", `/social-posts?${qs.toString()}`);
        // Agent only needs the post bodies — it already knows the channel it
        // asked for. Drop all metadata; return just the content strings, and
        // skip any post whose content failed to load (orchestrator returns "").
        const items = (data?.items ?? []).map((p) => p.content).filter(Boolean);
        log("read_social_posts", "success", { agentId, channel, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_social_posts", err.message, { agentId, channel });
        return errorResult(err.message);
      }
    },
  }));

  // read_blog_posts — read back the tenant's drafted/published blog posts,
  // newest first, each with its latest content (fetched from the bucket
  // orchestrator-side). Read-only: writes happen via the draft_blog_post tool
  // (the internal invoke path), not here. Single channel — no `channel` param
  // (unlike read_social_posts). Routes to the orchestrator's /internal/blog/posts.
  api.registerTool((ctx) => ({
    name: "read_blog_posts",
    description:
      "Read the tenant's blog post contents, newest first. Takes no arguments. Returns a list of post content strings.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId) {
      const agentId = ctx.agentId;
      log("read_blog_posts", "called", { agentId });
      try {
        const qs = new URLSearchParams({ agentId });
        const data = await callContent("GET", `/blog-posts?${qs.toString()}`);
        // Drop all metadata (post_ref/title/status/created_at); return just the
        // content strings, skipping any post whose content failed to load
        // (orchestrator returns ""). Same projection as read_social_posts.
        const items = (data?.items ?? []).map((p) => p.content).filter(Boolean);
        log("read_blog_posts", "success", { agentId, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_blog_posts", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // draft_blog_post — WRITE a blog post. Fully internal (no OAuth, no third-party
  // publish): on a supervised task the orchestrator saves a draft for founder
  // approval; on an autonomous task it finalises the post into the founder's
  // Content Published list. The path is chosen from the task's approval mode
  // server-side. Routes through /api/tools/invoke → /internal/tools/:tenantId/
  // invoke → executeBlogInvocation; the orchestrator resolves the agent's active
  // task and the agent_tools gate. The agent supplies only text + an optional
  // short title; everything else (task, versioning, publish state) is server-side.
  api.registerTool((ctx) => ({
    name: "draft_blog_post",
    description:
      "Draft a blog post for the founder. Provide the full post body as `text` and an optional short `title` (a human label for the founder's list view; not published). On a supervised task this saves a draft for approval; on an autonomous task it finalises the post into the founder's Content Published list. There is no external publish — the founder copies the content out themselves.",
    parameters: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "Full markdown body of the blog post." },
        title: {
          type: "string",
          description: "Optional short human label for the founder's list view (not published).",
        },
      },
    },
    async execute(_toolCallId, { text, title }) {
      const agentId = ctx.agentId;
      log("draft_blog_post", "called", {
        agentId,
        hasTitle: typeof title === "string" && title.trim() !== "",
      });
      try {
        const params = { text };
        if (typeof title === "string" && title.trim()) params.title = title;
        const data = await callInvoke(agentId, "draft_blog_post", params);
        // The invoke route returns executeBlogInvocation's `result`
        // ({ post_ref, status, artifact_id? }). Drop the internal metadata
        // (post_ref is always null; artifact_id is an internal UUID) — the agent
        // only needs the publish state.
        const status = data?.status ?? "draft";
        log("draft_blog_post", "success", { agentId, status });
        return okResult({ ok: true, status });
      } catch (err) {
        logError("draft_blog_post", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));
}
