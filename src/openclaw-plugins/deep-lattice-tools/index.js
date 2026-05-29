// Deep Lattice Tools plugin.
// Registers 4 tools that expose Deep Lattice file access to agents:
//   read_profile_file, read_knowledge_file, update_profile_file (MM),
//   create_briefing (CRO).
//
// No list/discovery or briefing-read tools — agent directives reference
// specific profile slugs and knowledge filenames by name, and CRO is
// write-only for briefings (founder consumes them in the tenant UI).
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
// Tool exposure: all 4 tools are added to the global tools.alsoAllow list so
// they are eligible. Per-agent `tools.allow` is the actual gate — an agent
// only sees a DL tool if it is listed in that agent's allowlist.

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
      "Read one of the tenant's 5 Profile files by slug. Returns the full markdown content. Slugs: company-founder, products, market-competitors, pricing, icp.",
    parameters: {
      type: "object",
      required: ["slug"],
      additionalProperties: false,
      properties: {
        slug: {
          type: "string",
          enum: ["company-founder", "products", "market-competitors", "pricing", "icp"],
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
        return okResult({ content: data?.content ?? "" });
      } catch (err) {
        logError("read_profile_file", err.message, { agentId, slug });
        return errorResult(err.message);
      }
    },
  }));

  // read_knowledge_file — any agent reads one of the 3 reserved structured
  // knowledge files (see orchestrator src/constants/deepLattice.js → KNOWLEDGE_SLUGS).
  api.registerTool((ctx) => ({
    name: "read_knowledge_file",
    description:
      "Read one of the tenant's Knowledge files by filename. Returns the full markdown content. Filenames: example-emails.md, example-blog-posts.md, example-linkedin-posts.md.",
    parameters: {
      type: "object",
      required: ["filename"],
      additionalProperties: false,
      properties: {
        filename: {
          type: "string",
          enum: ["example-emails.md", "example-blog-posts.md", "example-linkedin-posts.md"],
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
        return okResult({ content: data?.content ?? "" });
      } catch (err) {
        logError("read_knowledge_file", err.message, { agentId, filename });
        return errorResult(err.message);
      }
    },
  }));

  // update_profile_file — Memory Manager updates a profile slug's content.
  // Orchestrator's assertCanPerform rejects non-MM callers with 403.
  api.registerTool((ctx) => ({
    name: "update_profile_file",
    description:
      "Replace the full markdown content of one Profile slug. The supplied content replaces the existing file entirely.",
    parameters: {
      type: "object",
      required: ["slug", "content"],
      additionalProperties: false,
      properties: {
        slug: {
          type: "string",
          enum: ["company-founder", "products", "market-competitors", "pricing", "icp"],
        },
        content: {
          type: "string",
          description: "Full new markdown content for the slug.",
        },
      },
    },
    async execute(_toolCallId, { slug, content }) {
      const agentId = ctx.agentId;
      log("update_profile_file", "called", { agentId, slug, contentLength: content?.length ?? 0 });
      try {
        await callWrapper(
          "PUT",
          `/profile/${encodeURIComponent(slug)}/content`,
          { agentId, content }
        );
        log("update_profile_file", "success", { agentId, slug });
        return okResult({ ok: true });
      } catch (err) {
        logError("update_profile_file", err.message, { agentId, slug });
        return errorResult(err.message);
      }
    },
  }));

  // create_briefing — CRO creates a founder briefing.
  // Orchestrator's assertCanPerform rejects non-CRO callers with 403.
  // brief_for_date and display_time are server-stamped (today in tenant tz);
  // neither is an agent-facing parameter.
  api.registerTool((ctx) => ({
    name: "create_briefing",
    description:
      "Create a Founder Briefing. Kind is one of daily | weekly | deal_escalation | meeting_demo. summary is the one-line list-view preview; content is the full markdown body.",
    parameters: {
      type: "object",
      required: ["kind", "title", "summary", "content"],
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["daily", "weekly", "deal_escalation", "meeting_demo"],
        },
        title: {
          type: "string",
          description: "Headline shown in the list view.",
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
    async execute(_toolCallId, { kind, title, summary, content }) {
      const agentId = ctx.agentId;
      log("create_briefing", "called", { agentId, kind });
      try {
        const body = { agentId, kind, title, summary, content };
        const data = await callWrapper("POST", "/briefings", body);
        log("create_briefing", "success", { agentId, kind, briefingId: data?.id });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_briefing", err.message, { agentId, kind });
        return errorResult(err.message);
      }
    },
  }));
}
