// Deep Lattice Tools plugin.
// Registers 14 tools that expose Deep Lattice file access to agents:
//   Profile/knowledge: read_profile_file, read_knowledge_file,
//     update_profile_file.
//   Templates (migration 019): read_template (global, read-only).
//   Briefings: create_briefing, read_briefings.
//   Agent documents (migration 018): create_analytics_report,
//     read_analytics_reports, create_plan, read_latest_plan,
//     create_daily_target, read_latest_daily_target, create_execution_plan,
//     read_latest_execution_plan.
//
// No profile/knowledge list/discovery tools — agent directives reference
// specific profile slugs and knowledge filenames by name. create_briefing
// writes a briefing; read_briefings reads them back, filtered by kind and/or
// date. Agent documents are agent-authored working docs: analytics reports are
// typed + filterable; plan / daily_target / execution_plan are latest-wins.
//
// NOTE: agent-level authorization has been removed orchestrator-side — there
// is no longer a per-agent gate (no assertCanPerform). Any agent that has the
// tool in its allowlist can call any DL operation. The (MM)/(CRO)/(Chief of
// Staff) conventions that previously governed these tools are no longer
// enforced anywhere.
//
// Each handler posts to the wrapper's /api/deep-lattice/* loopback router,
// which resolves tenantId from the calling agent's ID and forwards to the
// orchestrator's /internal/deep-lattice/* endpoints with the shared secret.
//
// Factory form (`api.registerTool((ctx) => ...)`): openclaw resolves tools
// per-agent and passes that agent's ctx.agentId. Agents never pass their own
// ID as a tool parameter — the wrapper sources it from ctx. The orchestrator
// no longer authorizes the caller; tool visibility (the allowlist) is the only
// remaining gate.
//
// Tool exposure: all 14 tools are added to the global tools.alsoAllow list so
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

async function callWrapper(method, path, body, { notFoundOk = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  // For latest-wins reads, "none exists yet" is a normal state, not an error.
  if (res.status === 404 && notFoundOk) {
    return null;
  }
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

  // read_template — read a GLOBAL admin-authored template by filename
  // (migration 019). Templates are not tenant-scoped — one shared set, read-only
  // for agents. Filenames are dynamic (admin-authored), so there is no enum;
  // agent directives reference templates by name, like profile slugs.
  api.registerTool((ctx) => ({
    name: "read_template",
    description:
      "Read a global template file by filename. Returns the full markdown content.",
    parameters: {
      type: "object",
      required: ["filename"],
      additionalProperties: false,
      properties: {
        filename: {
          type: "string",
          description: "The template filename to read (e.g. \"daily-brief.md\").",
        },
      },
    },
    async execute(_toolCallId, { filename }) {
      const agentId = ctx.agentId;
      log("read_template", "called", { agentId, filename });
      try {
        const qs = `?agentId=${encodeURIComponent(agentId)}`;
        const data = await callWrapper("GET", `/templates/${encodeURIComponent(filename)}${qs}`);
        log("read_template", "success", { agentId, filename, contentLength: data?.content?.length ?? 0 });
        return okResult({ content: data?.content ?? "" });
      } catch (err) {
        logError("read_template", err.message, { agentId, filename });
        return errorResult(err.message);
      }
    },
  }));

  // update_profile_file — updates a profile slug's content. (No longer
  // restricted to Memory Manager — agent-level authz removed orchestrator-side.)
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

  // create_briefing — creates a founder briefing. (No longer restricted to
  // Chief of Staff — agent-level authz removed orchestrator-side.)
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

  // read_briefings — reads back published briefings, optionally filtered by
  // kind and/or date. Both params are optional; the orchestrator defaults to
  // today's briefings when neither filter is supplied (an explicit kind is
  // honoured cross-day). (No longer restricted to CRO — agent-level authz
  // removed orchestrator-side.) Returns kind/title/summary/date plus the full
  // markdown content of each briefing (fetched from the bucket orchestrator-side).
  api.registerTool((ctx) => ({
    name: "read_briefings",
    description:
      "Read the Founder Briefings you have published, newest first. Optionally filter by kind (daily | weekly | deal_escalation | meeting_demo) and/or date (\"today\" or an ISO date \"YYYY-MM-DD\"). Both filters are optional; omit both to get today's briefings. Returns each briefing's kind, title, summary, date (the date string includes the published time), and full markdown content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["daily", "weekly", "deal_escalation", "meeting_demo"],
          description: "Filter to briefings of this kind.",
        },
        date: {
          type: "string",
          description: 'Filter to briefings for this date — "today" or an ISO date "YYYY-MM-DD".',
        },
      },
    },
    async execute(_toolCallId, args) {
      const agentId = ctx.agentId;
      const kind = args?.kind;
      const date = args?.date;
      log("read_briefings", "called", { agentId, kind, date });
      try {
        const qs = new URLSearchParams({ agentId });
        if (kind) qs.set("kind", kind);
        if (date) qs.set("date", date);
        const data = await callWrapper("GET", `/briefings?${qs.toString()}`);
        const items = (data?.items ?? []).map((b) => ({
          kind: b.kind,
          title: b.title,
          summary: b.summary,
          date: [b.brief_for_date, b.display_time].filter(Boolean).join(" "),
          content: b.content,
        }));
        log("read_briefings", "success", { agentId, kind, date, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_briefings", err.message, { agentId, kind, date });
        return errorResult(err.message);
      }
    },
  }));

  // ── Agent documents (migration 018) ────────────────────────
  // Four agent-authored doc categories in one orchestrator table. No authz —
  // any agent with the tool can write/read. analytics_report is typed and
  // filterable; plan / daily_target / execution_plan are latest-wins single
  // reads. Like create_briefing, the write date is server-stamped (today in
  // tenant tz) and is not an agent-facing parameter.

  // create_analytics_report — write a typed analytics report.
  api.registerTool((ctx) => ({
    name: "create_analytics_report",
    description:
      "Create an analytics report. type is one of comprehensive | outreach | social | traffic. title is the list-view headline; content is the full markdown body.",
    parameters: {
      type: "object",
      required: ["type", "title", "content"],
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["comprehensive", "outreach", "social", "traffic"],
        },
        title: { type: "string", description: "Headline shown in the list view." },
        content: { type: "string", description: "Full markdown body of the report." },
      },
    },
    async execute(_toolCallId, { type, title, content }) {
      const agentId = ctx.agentId;
      log("create_analytics_report", "called", { agentId, type });
      try {
        await callWrapper("POST", "/analytics-reports", { agentId, type, title, content });
        log("create_analytics_report", "success", { agentId, type });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_analytics_report", err.message, { agentId, type });
        return errorResult(err.message);
      }
    },
  }));

  // read_analytics_reports — read reports back, newest first, optionally
  // filtered by type and/or date.
  api.registerTool((ctx) => ({
    name: "read_analytics_reports",
    description:
      "Read analytics reports, newest first. Optionally filter by type (comprehensive | outreach | social | traffic) and/or date (\"today\" or an ISO date \"YYYY-MM-DD\"). Both filters are optional. Returns each report's type, title, and full markdown content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["comprehensive", "outreach", "social", "traffic"],
          description: "Filter to reports of this type.",
        },
        date: {
          type: "string",
          description: 'Filter to reports for this date — "today" or an ISO date "YYYY-MM-DD".',
        },
      },
    },
    async execute(_toolCallId, args) {
      const agentId = ctx.agentId;
      const type = args?.type;
      const date = args?.date;
      log("read_analytics_reports", "called", { agentId, type, date });
      try {
        const qs = new URLSearchParams({ agentId });
        if (type) qs.set("type", type);
        if (date) qs.set("date", date);
        const data = await callWrapper("GET", `/analytics-reports?${qs.toString()}`);
        const items = (data?.items ?? []).map((d) => ({
          type: d.subtype,
          title: d.title,
          content: d.content,
        }));
        log("read_analytics_reports", "success", { agentId, type, date, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_analytics_reports", err.message, { agentId, type, date });
        return errorResult(err.message);
      }
    },
  }));

  // Latest-wins doc categories: each gets a create + a read-latest tool. The
  // write/read shapes are identical across the three, so register them from a
  // table to avoid copy-paste drift.
  const LATEST_DOC_TOOLS = [
    {
      category: "plan",
      path: "plans",
      noun: "plan",
      createName: "create_plan",
      readName: "read_latest_plan",
    },
    {
      category: "daily_target",
      path: "daily-targets",
      noun: "daily target",
      createName: "create_daily_target",
      readName: "read_latest_daily_target",
    },
    {
      category: "execution_plan",
      path: "execution-plans",
      noun: "execution plan",
      createName: "create_execution_plan",
      readName: "read_latest_execution_plan",
    },
  ];

  for (const { path, noun, createName, readName } of LATEST_DOC_TOOLS) {
    api.registerTool((ctx) => ({
      name: createName,
      description: `Create a ${noun}. title is the list-view headline; content is the full markdown body. This writes a new version — reads return the most recent.`,
      parameters: {
        type: "object",
        required: ["title", "content"],
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Headline shown in the list view." },
          content: { type: "string", description: `Full markdown body of the ${noun}.` },
        },
      },
      async execute(_toolCallId, { title, content }) {
        const agentId = ctx.agentId;
        log(createName, "called", { agentId });
        try {
          await callWrapper("POST", `/${path}`, { agentId, title, content });
          log(createName, "success", { agentId });
          return okResult({ ok: true });
        } catch (err) {
          logError(createName, err.message, { agentId });
          return errorResult(err.message);
        }
      },
    }));

    api.registerTool((ctx) => ({
      name: readName,
      description: `Read the most recent ${noun}. Takes no arguments. Returns its title and full markdown content, or { item: null } if none exists yet.`,
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(_toolCallId) {
        const agentId = ctx.agentId;
        log(readName, "called", { agentId });
        try {
          const qs = new URLSearchParams({ agentId });
          const data = await callWrapper("GET", `/${path}/latest?${qs.toString()}`, undefined, {
            notFoundOk: true,
          });
          const item = data
            ? { title: data.title, content: data.content }
            : null;
          log(readName, "success", { agentId, found: Boolean(item) });
          return okResult({ item });
        } catch (err) {
          logError(readName, err.message, { agentId });
          return errorResult(err.message);
        }
      },
    }));
  }
}
