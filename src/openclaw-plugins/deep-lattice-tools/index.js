// Deep Lattice Tools plugin.
// Registers 7 tools that expose Deep Lattice file access to agents:
//   read_profile_file, read_knowledge_file, list_knowledge_files,
//   update_profile_file (MM), create_briefing, list_briefings, read_briefing (CRO).
//
// Each handler posts to the wrapper's /api/deep-lattice/* loopback router,
// which resolves tenantId from the calling agent's ID and forwards to the
// orchestrator's /internal/deep-lattice/* endpoints with the shared secret.
//
// Factory form (`api.registerTool((ctx) => ...)`): openclaw resolves tools
// per-agent and passes that agent's ctx.agentId. Agents never pass their own
// ID as a tool parameter — the wrapper sources it from ctx and the orchestrator
// enforces who is allowed to call which tool via assertCanPerform.
//
// v1 tool exposure: all 7 tools are added to the global tools.alsoAllow list,
// so every agent sees them. Per-agent allowlists can be layered later.

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
const BASE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/deep-lattice`;

function log(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[DL-TOOLS] [${tool}] ${msg}${metaStr}`);
}

function logError(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[DL-TOOLS] [${tool}] ERROR: ${msg}${metaStr}`);
}

async function callWrapper(method, path, body) {
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
      `Deep Lattice tool error [${res.status}]: ${data.error ?? data.message ?? JSON.stringify(data)}`
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
  // read_profile_file — any agent reads one of the 5 fixed profile slugs.
  api.registerTool((ctx) => ({
    name: "read_profile_file",
    description:
      "Read one of the tenant's 5 Profile files by slug. Returns row metadata + full markdown content in one call. Slugs: company-founder, products, market-competitors, pricing, icp.",
    parameters: {
      type: "object",
      required: ["slug"],
      additionalProperties: false,
      properties: {
        slug: {
          type: "string",
          enum: ["company-founder", "products", "market-competitors", "pricing", "icp"],
          description: "One of the 5 fixed Profile slugs.",
        },
      },
    },
    async execute(_toolCallId, { slug }) {
      const agentId = ctx.agentId;
      log("read_profile_file", "called", { agentId, slug });
      try {
        const qs = `?agentId=${encodeURIComponent(agentId)}`;
        const data = await callWrapper("GET", `/profile/${encodeURIComponent(slug)}${qs}`);
        log("read_profile_file", "success", { agentId, slug, contentLength: data?.content?.length ?? 0 });
        return okResult(data);
      } catch (err) {
        logError("read_profile_file", err.message, { agentId, slug });
        return errorResult(err.message);
      }
    },
  }));

  // read_knowledge_file — any agent reads a specific knowledge file by filename.
  // Filename must match what the founder uploaded (lowercase per validator).
  api.registerTool((ctx) => ({
    name: "read_knowledge_file",
    description:
      "Read one of the tenant's Knowledge files by filename. Returns row metadata + full markdown content. Filename includes the .md extension (e.g. 'differentiators.md') and is normalised to lowercase server-side.",
    parameters: {
      type: "object",
      required: ["filename"],
      additionalProperties: false,
      properties: {
        filename: {
          type: "string",
          description: "Filename with .md extension as stored by the founder.",
        },
      },
    },
    async execute(_toolCallId, { filename }) {
      const agentId = ctx.agentId;
      log("read_knowledge_file", "called", { agentId, filename });
      try {
        const qs = `?agentId=${encodeURIComponent(agentId)}`;
        const data = await callWrapper("GET", `/knowledge/${encodeURIComponent(filename)}${qs}`);
        log("read_knowledge_file", "success", { agentId, filename, contentLength: data?.content?.length ?? 0 });
        return okResult(data);
      } catch (err) {
        logError("read_knowledge_file", err.message, { agentId, filename });
        return errorResult(err.message);
      }
    },
  }));

  // list_knowledge_files — enumerate the tenant's live knowledge files.
  // Used when a directive needs to discover what is available rather than
  // referencing a specific filename.
  api.registerTool((ctx) => ({
    name: "list_knowledge_files",
    description:
      "List all of the tenant's live Knowledge files. Returns { items: [{ filename, title }, ...] }. Most directives reference specific filenames directly; use this only when discovery is needed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const agentId = ctx.agentId;
      log("list_knowledge_files", "called", { agentId });
      try {
        const qs = `?agentId=${encodeURIComponent(agentId)}`;
        const data = await callWrapper("GET", `/knowledge${qs}`);
        log("list_knowledge_files", "success", { agentId, count: data?.items?.length ?? 0 });
        return okResult(data);
      } catch (err) {
        logError("list_knowledge_files", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // update_profile_file — Memory Manager updates a profile slug's content.
  // Orchestrator's assertCanPerform rejects non-MM callers with 403.
  api.registerTool((ctx) => ({
    name: "update_profile_file",
    description:
      "Replace the full markdown content of one Profile slug. Memory Manager only — other agents receive 403. The supplied content replaces the existing file entirely.",
    parameters: {
      type: "object",
      required: ["slug", "content"],
      additionalProperties: false,
      properties: {
        slug: {
          type: "string",
          enum: ["company-founder", "products", "market-competitors", "pricing", "icp"],
          description: "One of the 5 fixed Profile slugs.",
        },
        content: {
          type: "string",
          description: "Full new markdown content for the slug. Replaces existing content.",
        },
      },
    },
    async execute(_toolCallId, { slug, content }) {
      const agentId = ctx.agentId;
      log("update_profile_file", "called", { agentId, slug, contentLength: content?.length ?? 0 });
      try {
        const data = await callWrapper(
          "PUT",
          `/profile/${encodeURIComponent(slug)}/content`,
          { agentId, content }
        );
        log("update_profile_file", "success", { agentId, slug });
        return okResult(data);
      } catch (err) {
        logError("update_profile_file", err.message, { agentId, slug });
        return errorResult(err.message);
      }
    },
  }));

  // create_briefing — CRO creates a founder briefing.
  // Orchestrator's assertCanPerform rejects non-CRO callers with 403.
  // brief_for_date is optional — the orchestrator defaults to "today" in the
  // tenant's timezone when omitted, and resolves the literal "today" the same
  // way. display_time is NOT a tool input: the orchestrator computes it from
  // the briefing's created_at in tenant tz (per Deep Lattice v1 §8.2).
  api.registerTool((ctx) => ({
    name: "create_briefing",
    description:
      "Create a Founder Briefing. CRO only — other agents receive 403. Kind is one of daily | weekly | deal_escalation | meeting_demo. brief_for_date is optional; pass an ISO date YYYY-MM-DD (tenant-local) or the literal 'today', or omit to default to today in the tenant's timezone. display_time is computed server-side from the briefing's creation time in the tenant timezone — do NOT pass it. summary is the one-line list-view preview; content is the full markdown body.",
    parameters: {
      type: "object",
      required: ["kind", "title", "summary", "content"],
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["daily", "weekly", "deal_escalation", "meeting_demo"],
        },
        title: { type: "string" },
        brief_for_date: {
          type: "string",
          description:
            "Optional. ISO date 'YYYY-MM-DD' in tenant-local terms, or the literal 'today'. Omit to default to today in the tenant's timezone.",
        },
        summary: {
          type: "string",
          description: "One-line preview shown in the list view.",
        },
        content: {
          type: "string",
          description: "Full markdown body of the briefing.",
        },
      },
    },
    async execute(_toolCallId, { kind, title, brief_for_date, summary, content }) {
      const agentId = ctx.agentId;
      log("create_briefing", "called", { agentId, kind, brief_for_date: brief_for_date || null });
      try {
        const body = { agentId, kind, title, summary, content };
        // Drop falsy brief_for_date (undefined OR empty string) so the
        // orchestrator's "today in tenant tz" default kicks in. The validator
        // rejects "" with 400 — an empty string from the LLM is almost
        // certainly intent-to-default rather than intent-to-fail.
        if (brief_for_date) body.brief_for_date = brief_for_date;
        const data = await callWrapper("POST", "/briefings", body);
        log("create_briefing", "success", { agentId, kind, briefingId: data?.id });
        return okResult(data);
      } catch (err) {
        logError("create_briefing", err.message, { agentId, kind });
        return errorResult(err.message);
      }
    },
  }));

  // list_briefings — CRO lists briefings.
  // Pagination is handled inside the wrapper router (auto-paginates across
  // orchestrator pages up to a hard cap). The tool surface exposes only
  // filter inputs — cursor is intentionally hidden from the LLM.
  // for_date accepts an ISO date or the literal 'today' (orchestrator resolves
  // 'today' against tenants.timezone).
  api.registerTool((ctx) => ({
    name: "list_briefings",
    description:
      "List Founder Briefings. CRO only — other agents receive 403. Pagination is handled by the wrapper; results may be capped at a hard limit, in which case truncated=true is set. for_date accepts an ISO date YYYY-MM-DD or the literal 'today' (resolved server-side via the tenant's timezone). Filter by kind to narrow further.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        for_date: {
          type: "string",
          description: "Either an ISO date 'YYYY-MM-DD' or the literal 'today'. Optional.",
        },
        kind: {
          type: "string",
          enum: ["daily", "weekly", "deal_escalation", "meeting_demo"],
          description: "Optional. Restrict to one briefing kind.",
        },
      },
    },
    async execute(_toolCallId, { for_date, kind } = {}) {
      const agentId = ctx.agentId;
      log("list_briefings", "called", { agentId, for_date: for_date ?? null, kind: kind ?? null });
      try {
        const params = new URLSearchParams({ agentId });
        if (for_date) params.set("for_date", for_date);
        if (kind) params.set("kind", kind);
        const data = await callWrapper("GET", `/briefings?${params.toString()}`);
        log("list_briefings", "success", {
          agentId,
          count: data?.items?.length ?? 0,
          truncated: Boolean(data?.truncated),
        });
        return okResult(data);
      } catch (err) {
        logError("list_briefings", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // read_briefing — CRO reads one briefing's row + content.
  api.registerTool((ctx) => ({
    name: "read_briefing",
    description:
      "Read a single Founder Briefing by UUID. CRO only — other agents receive 403. Returns row metadata + full markdown content. Discover briefing IDs via list_briefings.",
    parameters: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "UUID of the briefing row.",
        },
      },
    },
    async execute(_toolCallId, { id }) {
      const agentId = ctx.agentId;
      log("read_briefing", "called", { agentId, briefingId: id });
      try {
        const qs = `?agentId=${encodeURIComponent(agentId)}`;
        const data = await callWrapper("GET", `/briefings/${encodeURIComponent(id)}${qs}`);
        log("read_briefing", "success", { agentId, briefingId: id, contentLength: data?.content?.length ?? 0 });
        return okResult(data);
      } catch (err) {
        logError("read_briefing", err.message, { agentId, briefingId: id });
        return errorResult(err.message);
      }
    },
  }));
}
