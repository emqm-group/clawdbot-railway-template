// Deep Lattice Tools plugin.
// Registers 23 tools that expose Deep Lattice file access to agents:
//   Profile/knowledge: read_profile_file, read_knowledge_file,
//     update_profile_file, create_profile_file.
//   Templates (migration 019): read_template (global, read-only).
//   Founder's Style (migration 010): read_founder_style (both sections
//     composed), update_published_style (published section only).
//   Briefings: create_briefing, read_briefings.
//   Agent documents (migration 018): create_analytics_report,
//     read_analytics_reports, create_plan, read_latest_plan,
//     create_daily_target, read_latest_daily_target, create_execution_plan,
//     read_latest_execution_plan.
//   Daily-target composite (migration 012): read_daily_target_composite
//     (read-only — orchestrator-maintained).
//   Publishing schedule (migration 013): create_publishing_schedule,
//     read_publishing_schedule (also founder-editable).
//   Campaign files (migration 019): read_campaign_file, create_campaign_file
//     — the only campaign-scoped documents here; both take a campaign_id.
//   Pre-signup briefs (migration 011): read_signup_preview (read-only). The one
//     tool here that is NOT a Deep Lattice layer — see its registration below.
//
// No profile/knowledge list/discovery tools — agent directives reference
// specific profile slugs and knowledge filenames by name. create_briefing
// writes a briefing; read_briefings reads them back, filtered by kind and/or
// date. Agent documents are agent-authored working docs: analytics reports are
// typed + filterable; plan is subtyped (gtm | content-strategy |
// outbound-strategy) and latest-wins per subtype; daily_target / execution_plan
// are untyped latest-wins. The daily-target composite is the one document no
// agent writes — the orchestrator rebuilds it from each daily_target write, so
// it has a read tool and no create tool.
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
// Tool exposure: all 23 tools are added to the global tools.alsoAllow list so
// they are eligible. Per-agent `tools.allow` is the actual gate — an agent
// only sees a DL tool if it is listed in that agent's allowlist.

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
const BASE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/deep-lattice`;

// Campaign functions the campaign-file tools expose — the enum on both tools
// and the prose in their descriptions are generated from this one list, so
// shipping outbound or ads is adding a string here and nothing else.
//
// Deliberately NARROWER than the orchestrator, which already accepts
// "outbound" and "ads": a campaign has no file for a function that does not
// run yet, so offering them would only let a model author a document nothing
// reads. The DEFAULT is the first entry.
const CAMPAIGN_FUNCTIONS = ["content"];
const DEFAULT_CAMPAIGN_FUNCTION = CAMPAIGN_FUNCTIONS[0];

// The `function` parameter, identical on the read and the write.
const campaignFunctionParam = {
  type: "string",
  enum: CAMPAIGN_FUNCTIONS,
  description:
    CAMPAIGN_FUNCTIONS.length === 1
      ? `Which function's file. Only '${DEFAULT_CAMPAIGN_FUNCTION}' exists today, so omit it.`
      : `Which function's file: ${CAMPAIGN_FUNCTIONS.join(", ")}. Defaults to '${DEFAULT_CAMPAIGN_FUNCTION}'.`,
};

function log(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[DL-TOOLS] [${tool}] ${msg}${metaStr}`);
}

function logError(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[DL-TOOLS] [${tool}] ERROR: ${msg}${metaStr}`);
}

// `notFoundOk` maps a 404 to null for reads where "none exists yet" is a normal
// state. `notFoundCode` narrows that to one orchestrator error code — without it
// the wrapper's own 404s (unknown_agent) and a missing orchestrator route are
// indistinguishable from an empty document, and the agent silently proceeds as
// if the tenant had written nothing.
async function callWrapper(method, path, body, { notFoundOk = false, notFoundCode } = {}) {
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
  if (res.status === 404 && notFoundOk && (!notFoundCode || data.code === notFoundCode)) {
    return null;
  }
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

  // create_profile_file — authors one profile slug (create-or-overwrite). The CRO
  // calls this once per generated slug during onboarding to write the profile docs
  // from the profile task's JSON request (onboarding-flow-design.md §4). Distinct
  // create verb from update_profile_file (keeps the agent-facing language
  // unambiguous); idempotent so a single-task Retry re-authors already-written docs.
  api.registerTool((ctx) => ({
    name: "create_profile_file",
    description:
      "Create (or overwrite) the full markdown content of one Profile slug. Idempotent create-or-overwrite — safe to re-call. Used by the CRO to author the generated profile docs during onboarding.",
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
          description: "Full markdown content for the slug.",
        },
      },
    },
    async execute(_toolCallId, { slug, content }) {
      const agentId = ctx.agentId;
      log("create_profile_file", "called", { agentId, slug, contentLength: content?.length ?? 0 });
      try {
        await callWrapper(
          "POST",
          `/profile/${encodeURIComponent(slug)}`,
          { agentId, content }
        );
        log("create_profile_file", "success", { agentId, slug });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_profile_file", err.message, { agentId, slug });
        return errorResult(err.message);
      }
    },
  }));

  // ── Founder's Style (migration 010) ────────────────────────
  // One document with two sections orchestrator-side: `intended` (the founder's
  // own words, founder-written) and `published` (inferred from their published
  // posts, agent-written). The read returns both composed into one markdown doc;
  // the write targets the `published` section only — there is no agent-facing
  // path to `intended`, by tool name and by route.

  // read_founder_style — the voice read before drafting. 404 orchestrator-side
  // means "nothing captured yet", which is a normal state, not an error.
  api.registerTool((ctx) => ({
    name: "read_founder_style",
    description:
      "Read the tenant's Founder's Style document — how the founder writes. Returns both sections composed into one markdown document under the headings \"Founder's Intended Style\" (the founder's own words) and \"Founder's Published Style\" (inferred from their published posts). Read this before drafting so the output sounds like the founder. This is a read-only view for drafting — never pass this output back to update_published_style, which takes the published section's body alone. Takes no arguments. Returns { content }, where content is null if no founder style has been captured yet.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId) {
      const agentId = ctx.agentId;
      log("read_founder_style", "called", { agentId });
      try {
        const qs = new URLSearchParams({ agentId });
        // Only the orchestrator's own "nothing written yet" 404 counts as empty.
        // Any other 404 (unknown agent, route missing) must surface as an error —
        // silently drafting in a generic voice is worse than a visible failure.
        const data = await callWrapper("GET", `/founder-style?${qs.toString()}`, undefined, {
          notFoundOk: true,
          notFoundCode: "founder_style_not_found",
        });
        const content = data?.content ?? null;
        log("read_founder_style", "success", { agentId, contentLength: content?.length ?? 0 });
        return okResult({ content });
      } catch (err) {
        logError("read_founder_style", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // update_published_style — writes the `published` section only. Latest wins;
  // the founder's `intended` section is never read or touched by this call.
  api.registerTool((ctx) => ({
    name: "update_published_style",
    description:
      "Replace the Published Style section of the tenant's Founder's Style document — your inference of how the founder actually writes, drawn from reviewing their published posts. Pass the body of that section ONLY: no \"Founder's Published Style\" heading, and never the intended-style section. The supplied content replaces the published section entirely (latest wins) and is stored separately from the founder's intended style, which is their own and cannot be changed from here — so do not echo back what read_founder_style returned.",
    parameters: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: {
          type: "string",
          description: "Full new markdown content for the published style section.",
        },
      },
    },
    async execute(_toolCallId, { content }) {
      const agentId = ctx.agentId;
      log("update_published_style", "called", { agentId, contentLength: content?.length ?? 0 });
      try {
        await callWrapper("PUT", "/founder-style/published/content", { agentId, content });
        log("update_published_style", "success", { agentId });
        return okResult({ ok: true });
      } catch (err) {
        logError("update_published_style", err.message, { agentId });
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
      "Create an analytics report. type is one of comprehensive | outreach | social | traffic. duration is the reporting window: daily | weekly. title is the list-view headline; content is the full markdown body.",
    parameters: {
      type: "object",
      required: ["type", "duration", "title", "content"],
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["comprehensive", "outreach", "social", "traffic"],
        },
        duration: {
          type: "string",
          enum: ["daily", "weekly"],
          description: "Reporting window the report covers.",
        },
        title: { type: "string", description: "Headline shown in the list view." },
        content: { type: "string", description: "Full markdown body of the report." },
      },
    },
    async execute(_toolCallId, { type, duration, title, content }) {
      const agentId = ctx.agentId;
      log("create_analytics_report", "called", { agentId, type, duration });
      try {
        await callWrapper("POST", "/analytics-reports", { agentId, type, duration, title, content });
        log("create_analytics_report", "success", { agentId, type, duration });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_analytics_report", err.message, { agentId, type, duration });
        return errorResult(err.message);
      }
    },
  }));

  // read_analytics_reports — read reports back, newest first, optionally
  // filtered by type and/or date.
  api.registerTool((ctx) => ({
    name: "read_analytics_reports",
    description:
      "Read analytics reports, newest first. Optionally filter by type (comprehensive | outreach | social | traffic), duration (daily | weekly), and/or date (\"today\" or an ISO date \"YYYY-MM-DD\"). All filters are optional. Returns each report's type, duration, title, and full markdown content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["comprehensive", "outreach", "social", "traffic"],
          description: "Filter to reports of this type.",
        },
        duration: {
          type: "string",
          enum: ["daily", "weekly"],
          description: "Filter to reports covering this reporting window.",
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
      const duration = args?.duration;
      const date = args?.date;
      log("read_analytics_reports", "called", { agentId, type, duration, date });
      try {
        const qs = new URLSearchParams({ agentId });
        if (type) qs.set("type", type);
        if (duration) qs.set("duration", duration);
        if (date) qs.set("date", date);
        const data = await callWrapper("GET", `/analytics-reports?${qs.toString()}`);
        const items = (data?.items ?? []).map((d) => ({
          type: d.subtype,
          duration: d.duration,
          title: d.title,
          content: d.content,
        }));
        log("read_analytics_reports", "success", { agentId, type, duration, date, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_analytics_reports", err.message, { agentId, type, duration, date });
        return errorResult(err.message);
      }
    },
  }));

  // plan — subtyped + latest-wins per subtype (migration 023). Unlike the
  // untyped latest-wins docs below, both create and read take a required
  // `subtype` (gtm | content-strategy | outbound-strategy); each subtype is an
  // independent latest-wins document, so a read must name which one.
  const PLAN_SUBTYPES = ["gtm", "content-strategy", "outbound-strategy"];

  api.registerTool((ctx) => ({
    name: "create_plan",
    description:
      "Create a plan. subtype is one of gtm | content-strategy | outbound-strategy — each is an independent latest-wins document. title is the list-view headline; content is the full markdown body. This writes a new version of that subtype — reads return the most recent for the subtype.",
    parameters: {
      type: "object",
      required: ["subtype", "title", "content"],
      additionalProperties: false,
      properties: {
        subtype: { type: "string", enum: PLAN_SUBTYPES },
        title: { type: "string", description: "Headline shown in the list view." },
        content: { type: "string", description: "Full markdown body of the plan." },
      },
    },
    async execute(_toolCallId, { subtype, title, content }) {
      const agentId = ctx.agentId;
      log("create_plan", "called", { agentId, subtype });
      try {
        await callWrapper("POST", "/plans", { agentId, subtype, title, content });
        log("create_plan", "success", { agentId, subtype });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_plan", err.message, { agentId, subtype });
        return errorResult(err.message);
      }
    },
  }));

  api.registerTool((ctx) => ({
    name: "read_latest_plan",
    description:
      "Read the most recent plan for a subtype (gtm | content-strategy | outbound-strategy). Returns its title and full markdown content, or { item: null } if none exists yet for that subtype.",
    parameters: {
      type: "object",
      required: ["subtype"],
      additionalProperties: false,
      properties: {
        subtype: { type: "string", enum: PLAN_SUBTYPES },
      },
    },
    async execute(_toolCallId, { subtype }) {
      const agentId = ctx.agentId;
      log("read_latest_plan", "called", { agentId, subtype });
      try {
        const qs = new URLSearchParams({ agentId, subtype });
        const data = await callWrapper("GET", `/plans/latest?${qs.toString()}`, undefined, {
          notFoundOk: true,
        });
        const item = data ? { title: data.title, content: data.content } : null;
        log("read_latest_plan", "success", { agentId, subtype, found: Boolean(item) });
        return okResult({ item });
      } catch (err) {
        logError("read_latest_plan", err.message, { agentId, subtype });
        return errorResult(err.message);
      }
    },
  }));

  // Untyped latest-wins doc categories: each gets a create + a read-latest tool.
  // The write/read shapes are identical across the two, so register them from a
  // table to avoid copy-paste drift. (plan is handled above — it carries a
  // subtype and so does not fit this uniform shape.)
  const LATEST_DOC_TOOLS = [
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

  // read_daily_target_composite — the collated daily-target composite
  // (migration 012): every day's plan table stacked into ONE file, newest day
  // first, with a Date column prepended. READ ONLY by design — the orchestrator
  // rebuilds the file on every create_daily_target write, so there is
  // deliberately no matching create_* tool. Its 404 code is the same
  // `document_not_found` the latest-wins reads use; gating on it keeps the
  // wrapper's own 404s (unknown_agent) from reading as "no history yet".
  api.registerTool((ctx) => ({
    name: "read_daily_target_composite",
    description:
      "Read the collated history of daily targets — every day's plan table stacked into one markdown file, newest day first, with a Date column prepended to each row. Read this before choosing today's plan so you can see what you already covered on previous days. Takes no arguments. Returns { content }, where content is null if no daily target has been written yet. Read-only: this file is maintained automatically from each daily target you create, so never try to write it.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId) {
      const agentId = ctx.agentId;
      log("read_daily_target_composite", "called", { agentId });
      try {
        const qs = new URLSearchParams({ agentId });
        const data = await callWrapper("GET", `/daily-target-composite?${qs.toString()}`, undefined, {
          notFoundOk: true,
          notFoundCode: "document_not_found",
        });
        const content = data?.content ?? null;
        log("read_daily_target_composite", "success", {
          agentId,
          contentLength: content?.length ?? 0,
        });
        return okResult({ content });
      } catch (err) {
        logError("read_daily_target_composite", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // ── Publishing schedule (migration 013) ────────────────────
  // The channel-wise weekly cadence, its own file rather than prose inside the
  // content strategy, so the founder can view and edit it directly. One live
  // document per tenant, latest-wins, and the only doc written by BOTH an agent
  // and the founder — every write appends a new version, so neither clobbers
  // the other. Like the other create_* tools the write date is server-stamped
  // (today in tenant tz) and is not an agent-facing parameter; the title is
  // fixed server-side too, there being exactly one such document per tenant.

  api.registerTool((ctx) => ({
    name: "create_publishing_schedule",
    description:
      "Write the tenant's publishing schedule — the channel-wise weekly publishing frequency (how many posts per week on each channel). The supplied content replaces the whole schedule, so pass the complete document, not a change to it. Content must not be empty — there is no way to clear the schedule from here. The founder can also edit this file, so read it before rewriting rather than assuming your last version is still current.",
    parameters: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: {
          type: "string",
          minLength: 1,
          description: "Full markdown body of the publishing schedule.",
        },
      },
    },
    async execute(_toolCallId, { content }) {
      const agentId = ctx.agentId;
      log("create_publishing_schedule", "called", { agentId, contentLength: content?.length ?? 0 });
      try {
        await callWrapper("POST", "/publishing-schedule", { agentId, content });
        log("create_publishing_schedule", "success", { agentId });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_publishing_schedule", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  api.registerTool((ctx) => ({
    name: "read_publishing_schedule",
    description:
      "Read the tenant's current publishing schedule — the channel-wise weekly publishing frequency. Read it before planning what to publish, and before rewriting it: the founder edits this file too, so the latest version may not be yours. Takes no arguments. Returns { content }, where content is null if no schedule has been written yet.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId) {
      const agentId = ctx.agentId;
      log("read_publishing_schedule", "called", { agentId });
      try {
        const qs = new URLSearchParams({ agentId });
        const data = await callWrapper("GET", `/publishing-schedule?${qs.toString()}`, undefined, {
          notFoundOk: true,
          notFoundCode: "document_not_found",
        });
        const content = data?.content ?? null;
        log("read_publishing_schedule", "success", {
          agentId,
          contentLength: content?.length ?? 0,
        });
        return okResult({ content });
      } catch (err) {
        logError("read_publishing_schedule", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // ── Campaign files (migration 019) ─────────────────────────
  // A campaign's working strategy — one markdown file per FUNCTION per
  // campaign, holding the angles and topics a writer works from. `content` is
  // the only function in v1; `outbound` and `ads` follow when those ship —
  // add the string to CAMPAIGN_FUNCTIONS at the top of this file and both
  // tools pick it up. The orchestrator already accepts all three.
  //
  // These are the only CAMPAIGN-scoped documents in this plugin — everything
  // else here is account-scoped — so both tools require a campaign_id. The
  // agent is always GIVEN that id by its task or directive and never infers
  // it: with two campaigns open, guessing attaches work to the wrong one, and
  // with one open today it would silently become wrong tomorrow.
  //
  // The write takes the BODY ONLY. The orchestrator composes the campaign's
  // header block — name, dates, segment, pitch, offer, channels and their
  // daily maximums — from the campaign record on every write, so an agent
  // cannot write a stale or invented campaign definition into the file the
  // other agents then read. One live file per (campaign, function), rewritten
  // in place, so a write replaces the previous body rather than versioning it.
  //
  // No list tool: the function is named by the directive, the same way profile
  // slugs and knowledge filenames are.

  api.registerTool((ctx) => ({
    name: "read_campaign_file",
    description:
      "Read a campaign's working strategy file — the angles, topics and guidance for producing work for THAT campaign, plus a header block with the campaign's definition (name, dates, target segment, core pitch, offer, and the channels with their daily maximums). Read it before writing anything for a campaign. campaign_id must be the one your task gave you — never guess it, and never reuse one from another task. Returns { content }, where content is null if this campaign has no file for that function yet.",
    parameters: {
      type: "object",
      required: ["campaign_id"],
      additionalProperties: false,
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign's id, exactly as supplied by your task.",
        },
        function: campaignFunctionParam,
      },
    },
    async execute(_toolCallId, args = {}) {
      const { campaign_id: campaignId, function: fn = DEFAULT_CAMPAIGN_FUNCTION } = args;
      const agentId = ctx.agentId;
      log("read_campaign_file", "called", { agentId, campaignId, fn });
      try {
        const qs = new URLSearchParams({ agentId });
        // `document_not_found` is "this campaign has no such file yet" → null.
        // `campaign_not_found` (a bad id, or one from another tenant) must
        // surface as an error instead — a wrong id reading as an empty file is
        // how an agent ends up authoring a campaign's strategy from nothing.
        const data = await callWrapper(
          "GET",
          `/campaigns/${encodeURIComponent(campaignId)}/files/${encodeURIComponent(fn)}?${qs.toString()}`,
          undefined,
          { notFoundOk: true, notFoundCode: "document_not_found" }
        );
        const content = data?.content ?? null;
        log("read_campaign_file", "success", {
          agentId,
          campaignId,
          fn,
          contentLength: content?.length ?? 0,
        });
        return okResult({ content });
      } catch (err) {
        logError("read_campaign_file", err.message, { agentId, campaignId, fn });
        return errorResult(err.message);
      }
    },
  }));

  api.registerTool((ctx) => ({
    name: "create_campaign_file",
    description:
      "Write a campaign's working strategy file — the angles, topics and guidance the writers for THAT campaign work from. Pass the complete document body: it replaces the whole file, so read the current one first rather than assuming your last version is still there. Do NOT include the campaign's name, dates, segment, pitch, offer or channel volumes — that header is added automatically from the campaign record, and anything you write about it is ignored. Content must not be empty; there is no way to clear a campaign file from here. campaign_id must be the one your task gave you — never guess it.",
    parameters: {
      type: "object",
      required: ["campaign_id", "content"],
      additionalProperties: false,
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign's id, exactly as supplied by your task.",
        },
        content: {
          type: "string",
          minLength: 1,
          description: "Full markdown body of the strategy, without a campaign header block.",
        },
        function: campaignFunctionParam,
      },
    },
    async execute(_toolCallId, args = {}) {
      const { campaign_id: campaignId, content, function: fn = DEFAULT_CAMPAIGN_FUNCTION } = args;
      const agentId = ctx.agentId;
      log("create_campaign_file", "called", {
        agentId,
        campaignId,
        fn,
        contentLength: content?.length ?? 0,
      });
      try {
        await callWrapper(
          "POST",
          `/campaigns/${encodeURIComponent(campaignId)}/files/${encodeURIComponent(fn)}`,
          { agentId, content }
        );
        log("create_campaign_file", "success", { agentId, campaignId, fn });
        return okResult({ ok: true });
      } catch (err) {
        logError("create_campaign_file", err.message, { agentId, campaignId, fn });
        return errorResult(err.message);
      }
    },
  }));

  // ── Pre-signup briefs (NOT a Deep Lattice layer) ───────────
  // read_signup_preview — the two documents the ORCHESTRATOR wrote itself, by
  // direct LLM call from the company URL, before the founder had an account:
  //   brief_profile   — the company as read from its website
  //   brief_strategy  — written FROM the profile above
  // They live in their own orchestrator table under their own bucket prefix,
  // mounted outside /internal/deep-lattice; the tool ships here so the plugin
  // keeps one loopback base URL, and /api/deep-lattice/signup-preview carries
  // the cross-service hop. READ ONLY — the briefs are a fixed record of what
  // the prospect was shown, so there is no write route and no create_* tool.
  api.registerTool((ctx) => ({
    name: "read_signup_preview",
    description:
      "Read the tenant's pre-signup briefs — the Brief Profile (the company as read from its website) and the Brief Strategy (written from that profile), both generated automatically from the company URL before the founder signed up. Use them as a starting point for your own work, not as a source of truth. Omit kind to get both, profile first; pass kind to get one. Returns { items: [{ kind, content }] } — an empty list if no brief was ever generated for this tenant. Read-only: these documents cannot be edited or replaced.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["brief_profile", "brief_strategy"],
          description: "Limit to one brief. Omit for both.",
        },
      },
    },
    async execute(_toolCallId, args) {
      const agentId = ctx.agentId;
      const kind = args?.kind;
      log("read_signup_preview", "called", { agentId, kind });
      try {
        const qs = new URLSearchParams({ agentId });
        if (kind) qs.set("kind", kind);
        // `preview_not_found` is "nothing readable yet" (never generated, or no
        // kind is ready) → empty list. Any other 404 (unknown_agent, route
        // missing) must surface rather than read as "never previewed".
        const data = await callWrapper("GET", `/signup-preview?${qs.toString()}`, undefined, {
          notFoundOk: true,
          notFoundCode: "preview_not_found",
        });
        const items = (data?.items ?? []).map((p) => ({ kind: p.kind, content: p.content }));
        log("read_signup_preview", "success", { agentId, kind, count: items.length });
        return okResult({ items });
      } catch (err) {
        logError("read_signup_preview", err.message, { agentId, kind });
        return errorResult(err.message);
      }
    },
  }));
}
