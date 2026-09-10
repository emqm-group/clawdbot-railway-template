// Deep Lattice Tools plugin.
// Registers 25 tools that expose Deep Lattice file access to agents:
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
//   Campaigns (migration 019): list_active_campaigns (every running campaign
//     — the planner's entry point, and the only campaign discovery here),
//     create_campaign (a new campaign RECORD — the only tool here that brings
//     one into existence), update_campaign (its definition, channels and/or
//     status — the only agent-facing way to pause one), read_campaign (one
//     campaign record),
//     read_campaign_file, create_campaign_file (its per-function strategy
//     file). The only campaign-scoped documents here; the three that read or
//     write an existing campaign take a campaign_id supplied by the calling
//     agent's task. The record routes are NOT Deep Lattice orchestrator-side
//     (/internal/campaigns); the wrapper overrides the base path per route, so
//     these tools' own paths are unchanged — see src/api/deepLattice.js.
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
// Tool exposure: all 25 tools are added to the global tools.alsoAllow list so
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
    // `detail` carries the part of a refusal an agent can act on — which channel
    // types are not connected, which ceilings a claim breaches. Only the campaign
    // record routes send it today, and dropping it there would leave a retryable
    // refusal ("unknown_channels") indistinguishable from an unretryable one.
    // Appended only alongside a message we picked out of the body: the last-resort
    // branch stringifies the WHOLE body, which already carries detail, and adding
    // it again would print it twice.
    const message = data.error ?? data.message;
    const suffix =
      message != null && data.detail != null ? ` (${JSON.stringify(data.detail)})` : "";
    throw new Error(
      `Deep Lattice tool error [${res.status}]: ${message ?? JSON.stringify(data)}${suffix}`
    );
  }
  return data;
}

// The four fields a campaign's target segment is made of. Every path that writes
// a campaign — the pre-signup generation, the prospect chain, the migration and
// the founder's form — produces exactly these, so a campaign whose segment is
// shaped differently reads as a different kind of object downstream.
const SEGMENT_FIELDS = ["role", "company_type", "company_size", "geography"];

// A segment REPLACES the stored jsonb column outright rather than merging into
// it, so a key that is present but blank is not a no-op — it overwrites a real
// value with nothing. The orchestrator will not catch that: its validator asks
// only that ONE field be populated, which a three-blanks body satisfies. The
// schema asks for four non-empty strings; this is the check a model that ignored
// the schema still meets, and it is worth having twice because the failure is
// silent and the lost fields are not recoverable from our side.
//
// Returns the offending field names, so the agent is told which ones to fill.
function blankSegmentFields(segment) {
  if (segment == null || typeof segment !== "object" || Array.isArray(segment)) {
    return SEGMENT_FIELDS;
  }
  return SEGMENT_FIELDS.filter(
    (k) => typeof segment[k] !== "string" || segment[k].trim() === ""
  );
}

// Normalise an optional free-text/date field a model may have filled in loosely.
// A blank string means the same as omitting it, and is reported as `absent`.
// A NON-STRING is deliberately passed through untouched rather than dropped or
// nulled: the wrong type has to reach the orchestrator and be REFUSED, because
// quietly discarding it turns a malformed end_date into an open-ended campaign
// and reports success.
function optionalText(value) {
  if (value == null) return { absent: true };
  if (typeof value !== "string") return { absent: false, value };
  const trimmed = value.trim();
  return trimmed === "" ? { absent: true } : { absent: false, value: trimmed };
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
  // The write takes the WHOLE FILE — header block and body. The orchestrator
  // stores exactly what it is handed and composes no part of it, so the agent
  // writes the campaign's definition into the header itself, reading it back
  // from read_campaign rather than from memory.
  //
  // The database is still the source of truth; keeping the file's mirror of it
  // aligned is the Memory Manager's job, and the orchestrator fires it a
  // resync task whenever a mirrored field moves. That directive is only
  // followable because the header is agent-written — do not tell the model to
  // omit it.
  //
  // One live file per (campaign, function), rewritten in place, so a write
  // replaces the whole previous file rather than versioning it.
  //
  // A file generated BEFORE signup has no header — the campaign id and the
  // per-channel maximums do not exist yet, and those paths are bare model
  // calls with no agent to write one. MM adds it on the first campaign change
  // after signup, so the read tool has to treat a headerless file as normal.
  //
  // No tool for listing a campaign's FILES: with `content` the only function,
  // read_campaign_file returning null already answers which files exist. Add
  // one alongside outbound/ads, so it cannot name a function the read refuses.
  // Listing CAMPAIGNS is a different question — list_active_campaigns below.

  // list_active_campaigns — the cross-campaign planner's entry point, and the
  // only tool here that discovers campaigns rather than being handed one. The
  // planner allocates a day across everything currently running, so it needs
  // the whole set in one call; every other campaign tool takes an id its task
  // supplied.
  //
  // ACTIVE only, which is the orchestrator's entire filter — Draft, Scheduled,
  // Paused, Unfunded and Expired campaigns take no new work and task creation
  // refuses one, so allocating against them would only be rejected downstream.
  // An empty list is therefore a normal answer, not an error.
  api.registerTool((ctx) => ({
    name: "list_active_campaigns",
    description:
      "List every campaign that is currently ACTIVE, each with its id, definition (name, status, target segment, core pitch, offer, dates) and its channels. Use it to plan a day across all running campaigns. Carry each campaign's id into every task you create for it — that is the only way work gets attached to the right campaign. A channel entry has enabled true or false: plan ONLY on enabled ones, since work aimed at a disabled channel is refused when the task is created. A channel's max_daily_posts is a CEILING, not a quota — never plan more than it, and plan fewer when a campaign has nothing worth saying. Campaigns that are not active take no new work and are deliberately absent. Takes no arguments. Returns { campaigns: [...] } — an empty list when nothing is running, which is a normal state and not an error.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId) {
      const agentId = ctx.agentId;
      log("list_active_campaigns", "called", { agentId });
      try {
        const qs = new URLSearchParams({ agentId });
        const data = await callWrapper("GET", `/campaigns?${qs.toString()}`);
        const campaigns = data?.campaigns ?? [];
        log("list_active_campaigns", "success", { agentId, count: campaigns.length });
        return okResult({ campaigns });
      } catch (err) {
        logError("list_active_campaigns", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // read_campaign — the campaign RECORD, not its file. The two are different
  // reads and a Function Lead needs both: a newly created campaign has no file
  // yet, so the definition is the only input that exists when it is asked to
  // propose the angles and topics that will BECOME the file.
  //
  // No ceiling or headroom figures here by design — per-channel volumes are
  // computed from the channel defaults and current headroom, not proposed, so
  // an agent shown those numbers would be reasoning about a limit it has no
  // say over (campaigns-design.md D23).
  //
  // Unlike read_campaign_file this has NO not-found-is-empty case: a campaign
  // id that does not resolve is a wrong id, never "not created yet", so a 404
  // surfaces as an error.
  api.registerTool((ctx) => ({
    name: "read_campaign",
    description:
      "Read a campaign's definition — its id, name, status, start and end dates, target segment, core pitch, offer, and its channels. Read it before proposing or writing anything for a campaign: the segment, pitch and offer are HARD CONSTRAINTS on what you may produce, not suggestions. A channel entry has enabled true or false, and only the enabled ones take work. A campaign that has just been created has no strategy file yet, so this is the only input that exists — use read_campaign_file for the angles and topics once one has been written. This is also the source to copy the campaign header from when writing that file with create_campaign_file. campaign_id must be the one your task gave you — never guess it. Returns { campaign }.",
    parameters: {
      type: "object",
      required: ["campaign_id"],
      additionalProperties: false,
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign's id, exactly as supplied by your task.",
        },
      },
    },
    async execute(_toolCallId, args = {}) {
      const { campaign_id: campaignId } = args;
      const agentId = ctx.agentId;
      log("read_campaign", "called", { agentId, campaignId });
      try {
        const qs = new URLSearchParams({ agentId });
        const campaign = await callWrapper(
          "GET",
          `/campaigns/${encodeURIComponent(campaignId)}?${qs.toString()}`
        );
        log("read_campaign", "success", {
          agentId,
          campaignId,
          status: campaign?.status,
          channelCount: campaign?.channels?.length ?? 0,
        });
        return okResult({ campaign });
      } catch (err) {
        logError("read_campaign", err.message, { agentId, campaignId });
        return errorResult(err.message);
      }
    },
  }));

  // create_campaign — the campaign RECORD, not its file, and the only tool here
  // that brings a campaign into existence rather than being handed one. Every
  // campaign row before this came from the orchestrator itself or the founder's
  // form; an agent could read a campaign and write its strategy but had no way
  // to propose one (campaigns-design.md P9).
  //
  // VOLUMES ARE NOT A PARAMETER (D23). The agent names channel TYPES; each
  // per-channel daily maximum is computed orchestrator-side as the lesser of the
  // channel default and current headroom, by the same arithmetic the founder's
  // form runs. Handing the model that number to pick would have it reason about
  // an account ceiling it has no say over, and its figure would be refused one
  // call later — the same reason read_campaign carries no headroom figures.
  //
  // Creation and activation are ONE call, which is what makes the start date
  // decide the outcome: today or earlier lands Active, later lands Scheduled.
  //
  // A REFUSED ACTIVATION IS STILL A SUCCESS RESPONSE — the campaign was written
  // and only its start was declined (no connected channel, no headroom, no
  // credits, the active limit), so it sits Draft and takes no work. That is the
  // one outcome an agent will misread as "running", so the tool returns
  // `activation` alongside the campaign and the description names it. A WRITER
  // refusal is the opposite case and 422s — nothing was created, and callWrapper
  // surfaces it as an error.
  //
  // The segment keys mirror what every other creation path produces (the
  // pre-signup generation, the prospect chain, the migration): role,
  // company_type, company_size, geography. The column is a free JSONB map, but
  // the readers downstream expect those four, and a campaign whose segment is
  // shaped differently reads as a different kind of object.
  //
  // No proposal task fires and no Memory Manager resync is queued: the agent
  // calling this is the one that writes the strategy file next, so a proposal
  // task would aim at its own author and a resync would find no file.
  api.registerTool((ctx) => ({
    name: "create_campaign",
    description:
      "Create a new campaign. Use it only when your task tells you to propose or set up a campaign — never to 'organise' work that an existing campaign already covers; call list_active_campaigns first and reuse a campaign that fits. You supply the definition only: name, start and end dates, who it targets, the core pitch, the offer, and which channels it runs on. You do NOT set post volumes — the per-channel daily maximum is computed from the account's ceiling and what other campaigns already claim, and is returned to you. The campaign is created and started in the same call, so start_date decides what happens: today or earlier makes it Active and it starts taking work immediately, a later date makes it Scheduled. Returns { campaign, activation }. CHECK activation.ok — when it is false the campaign was still created but is sitting in Draft and takes NO work; activation.code says why (no connected channel, no headroom left, no credits, or the active-campaign limit), and that is something to report back, not to retry. Never call this twice for the same campaign: a failed activation does not mean it was not created. After a successful create, write its strategy with create_campaign_file, using the id from the returned campaign.",
    parameters: {
      type: "object",
      required: ["name", "start_date", "segment", "core_pitch", "channels"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description:
            "A short name identifying the campaign, e.g. 'Q4 enterprise push'. Shown to the founder.",
        },
        start_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "The day the campaign starts, YYYY-MM-DD. Today or earlier starts it immediately; a later date schedules it. Do not backdate to force an early start.",
        },
        end_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "The day the campaign ends, YYYY-MM-DD, for a time-limited campaign. Must not be before start_date. Omit it entirely for an open-ended campaign — there is no separate flag for that.",
        },
        segment: {
          type: "object",
          required: ["role", "company_type", "company_size", "geography"],
          additionalProperties: false,
          description:
            "Who the campaign targets. Fill every field; where you are not certain, write the best answer the tenant's profile supports rather than leaving it vague.",
          properties: {
            role: {
              type: "string",
              minLength: 1,
              description: "The job title or function being targeted, e.g. 'Head of Engineering'.",
            },
            company_type: {
              type: "string",
              minLength: 1,
              description: "The kind of company, e.g. 'B2B SaaS, Series A-C'.",
            },
            company_size: {
              type: "string",
              minLength: 1,
              description: "Headcount or revenue band, e.g. '50-200 employees'.",
            },
            geography: {
              type: "string",
              minLength: 1,
              description: "Where they are, e.g. 'UK and Ireland'.",
            },
          },
        },
        core_pitch: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "What this campaign argues to that segment — the single claim every piece of work for it must support. This becomes a HARD CONSTRAINT on everything written for the campaign, so state it precisely.",
        },
        offer: {
          type: "string",
          maxLength: 4000,
          description:
            "The concrete thing being offered, if there is one — a trial, a demo, a discount. Omit it when the campaign has no offer; do not invent one.",
        },
        channels: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          description:
            "Which channels the campaign runs on, by type. Only channels the tenant has actually connected can be claimed — naming one that is not connected refuses the whole creation and nothing is written.",
          items: {
            type: "string",
            enum: ["linkedin-personal", "linkedin-company", "x", "blog"],
          },
        },
      },
    },
    async execute(_toolCallId, args = {}) {
      const {
        name,
        start_date: startDate,
        end_date: endDate,
        segment,
        core_pitch: corePitch,
        offer,
        channels,
      } = args;
      const agentId = ctx.agentId;
      const blank = blankSegmentFields(segment);
      if (blank.length) {
        const message = `create_campaign needs every segment field filled in — missing or blank: ${blank.join(", ")}.`;
        logError("create_campaign", message, { agentId, name });
        return errorResult(message);
      }

      log("create_campaign", "called", {
        agentId,
        name,
        startDate,
        endDate,
        channels,
      });
      try {
        // Blank and absent are collapsed for the two optional fields. A model with
        // nothing to say for them often sends "" rather than omitting the key, and
        // the orchestrator treats the two differently: a MISSING end_date means
        // open-ended while "" is a malformed date and 400s, and a blank offer would
        // be stored as though the campaign had one. A wrong TYPE is forwarded, not
        // dropped, so it is refused rather than quietly making the campaign
        // open-ended — see optionalText.
        const end = optionalText(endDate);
        const off = optionalText(offer);
        const data = await callWrapper("POST", "/campaigns", {
          agentId,
          name,
          start_date: startDate,
          ...(end.absent ? {} : { end_date: end.value }),
          segment,
          core_pitch: corePitch,
          ...(off.absent ? {} : { offer: off.value }),
          channels,
        });
        const campaign = data?.campaign ?? null;
        const activation = data?.activation ?? null;
        log("create_campaign", "success", {
          agentId,
          campaignId: campaign?.id,
          status: campaign?.status,
          activated: activation?.ok ?? null,
          refusal: activation?.ok === false ? activation.code : null,
        });
        return okResult({ campaign, activation });
      } catch (err) {
        logError("create_campaign", err.message, { agentId, name });
        return errorResult(err.message);
      }
    },
  }));

  // update_campaign — the definition, the channel set and the STATUS in one
  // call, where the founder's own surface splits the same ground across a PATCH,
  // a channels PUT and three status POSTs. One tool rather than five, and the
  // three parts of a change arrive together, so the Memory Manager is asked to
  // resync once naming everything that moved.
  //
  // THE STATUS FIELD IS WHAT LETS AN AGENT PAUSE A CAMPAIGN. Nothing agent-facing
  // could move a status before: an agent could create a campaign and write its
  // file, but one that should stop waited for the founder or for the system's own
  // funding and date hooks.
  //
  // SEGMENT AND CHANNELS ARE REPLACED, NOT MERGED. `segment` overwrites the jsonb
  // column outright and `channels` soft-deletes every existing claim before
  // writing the new set, so a partial value silently destroys the rest. The
  // schema below asks for all four segment keys non-empty and a non-empty channel
  // list, and `execute` re-checks the segment before sending, because `required`
  // only proves a key is PRESENT — a body with three blank strings satisfies both
  // the schema's required list and the orchestrator's validator, and overwrites
  // three real values with nothing. Keep both halves: relaxing either turns a
  // one-field edit into a wipe.
  //
  // NULL CLEARS, ABSENT LEAVES ALONE, for the two nullable columns. `end_date`
  // null makes a time-limited campaign open-ended and `offer` null removes it;
  // omitting either key changes nothing. `start_date` has no such case — the
  // column is NOT NULL and a campaign always has one — so it is a plain string.
  //
  // VOLUMES ARE STILL NOT AN INPUT (D23), as at create: the agent names channel
  // TYPES and each daily maximum is recomputed from the channel default and the
  // headroom left once this campaign's own existing claims are set aside.
  //
  // `status` names a DESTINATION, not an action, because that is what an agent
  // knows about a campaign it is reasoning over. Only three are reachable —
  // Unfunded and Expired are system-driven. Asking for `active` on a campaign
  // whose start date is in the future lands it SCHEDULED, not Active, which is
  // why the tool tells the agent to read the returned status rather than assume.
  //
  // A REFUSED TRANSITION IS STILL A SUCCESS RESPONSE, exactly as a refused
  // activation is at create: the definition and channel edits before it are
  // already committed. The outcome rides back in `transition`.
  api.registerTool((ctx) => ({
    name: "update_campaign",
    description:
      "Change an existing campaign — any part of its definition, the channels it runs on, its status, or several at once. Use it when something the campaign says or targets has actually changed, and to STOP a campaign by setting status to paused. Send only the parts you are changing; anything you leave out is untouched. TWO EXCEPTIONS, and getting them wrong destroys data: `segment` and `channels` REPLACE what is stored rather than merging into it. To change one segment field, send all four with the others copied unchanged from read_campaign; to add or drop a channel, send the complete list the campaign should end up with. Read the campaign first with read_campaign so you are copying its real current values, not what you remember. To clear a field, send it as null: end_date null makes a campaign open-ended, offer null removes the offer. You do NOT set post volumes — each channel's daily maximum is recomputed from the account's ceiling and returned to you. Returns { campaign, transition }. Trust campaign.status over what you asked for: requesting active on a campaign that starts in the future makes it SCHEDULED, not active. When you asked for a status, CHECK transition.ok — false means every other edit was still saved but the status did not move, and transition.code says why; that is something to report back, not to retry. transition is null when you did not ask for a status change.",
    parameters: {
      type: "object",
      required: ["campaign_id"],
      additionalProperties: false,
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign's id, exactly as supplied by your task.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "A new name for the campaign. Omit to leave it unchanged.",
        },
        start_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "A new start date, YYYY-MM-DD. Cannot be cleared — a campaign always has one. Moving it does not by itself start or stop the campaign; use status for that.",
        },
        end_date: {
          type: ["string", "null"],
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "A new end date, YYYY-MM-DD, or null to make the campaign open-ended. Must not be before the start date — the stored one if you are not changing it in the same call.",
        },
        segment: {
          type: "object",
          required: ["role", "company_type", "company_size", "geography"],
          additionalProperties: false,
          description:
            "REPLACES the whole target segment. Send all four fields, copying the ones you are not changing from read_campaign — anything you leave out is lost, not kept.",
          properties: {
            role: {
              type: "string",
              minLength: 1,
              description: "The job title or function being targeted, e.g. 'Head of Engineering'.",
            },
            company_type: {
              type: "string",
              minLength: 1,
              description: "The kind of company, e.g. 'B2B SaaS, Series A-C'.",
            },
            company_size: {
              type: "string",
              minLength: 1,
              description: "Headcount or revenue band, e.g. '50-200 employees'.",
            },
            geography: {
              type: "string",
              minLength: 1,
              description: "Where they are, e.g. 'UK and Ireland'.",
            },
          },
        },
        core_pitch: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "A new core pitch — the single claim every piece of work for this campaign must support. Changing it changes what is already-approved work was written against, so change it only when the campaign's argument has genuinely moved.",
        },
        offer: {
          type: ["string", "null"],
          maxLength: 4000,
          description:
            "A new offer, or null to remove the campaign's offer entirely. Omit to leave it as it is.",
        },
        channels: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          description:
            "REPLACES the campaign's whole channel set with this list. Include every channel it should keep, not just the one you are adding — anything missing is removed and its daily volume released. Only channels the tenant has actually connected can be claimed.",
          items: {
            type: "string",
            enum: ["linkedin-personal", "linkedin-company", "x", "blog"],
          },
        },
        status: {
          type: "string",
          enum: ["active", "paused", "draft"],
          description:
            "Where the campaign should end up. 'paused' stops a running campaign taking new work. 'active' starts or resumes one — but a campaign whose start date is in the future becomes SCHEDULED instead. 'draft' unschedules a Scheduled campaign. Unfunded and Expired cannot be set: the system owns those.",
        },
      },
    },
    async execute(_toolCallId, args = {}) {
      const { campaign_id: campaignId, ...rest } = args;
      const agentId = ctx.agentId;

      // Present-vs-absent is the whole contract here, so the body is built by
      // testing for the KEY rather than for a truthy value: `end_date: null` and
      // no end_date at all mean opposite things (clear it / leave it), and a
      // falsy-value test would collapse them into one.
      const body = { agentId };
      const copy = (from, to = from) => {
        if (from in rest) body[to] = rest[from];
      };
      copy("name");
      copy("start_date");
      copy("segment");
      copy("core_pitch");
      copy("channels");
      copy("status");
      // A model with nothing to put here sometimes sends "" rather than null.
      // Both mean "remove it", and "" would 400 as a malformed date and store a
      // blank offer as though the campaign had one. A wrong TYPE is forwarded
      // untouched so the orchestrator refuses it — coercing it to null here would
      // CLEAR the field and report success, when nothing of the sort was asked
      // for. See optionalText.
      for (const key of ["end_date", "offer"]) {
        if (!(key in rest)) continue;
        const norm = optionalText(rest[key]);
        body[key] = norm.absent ? null : norm.value;
      }

      // Checked only when the body carries a segment: absent means "leave it", and
      // the stored one is not this tool's to police.
      if ("segment" in rest) {
        const blank = blankSegmentFields(rest.segment);
        if (blank.length) {
          const message = `update_campaign replaces the whole segment, so every field must be filled in — missing or blank: ${blank.join(", ")}. Copy the ones you are not changing from read_campaign.`;
          logError("update_campaign", message, { agentId, campaignId });
          return errorResult(message);
        }
      }

      const changed = Object.keys(body).filter((k) => k !== "agentId");
      // Caught here rather than at the orchestrator so the agent is told what it
      // actually did — sent an id and nothing else — instead of "nothing to
      // update", which reads as though the edit was rejected.
      if (changed.length === 0) {
        const message =
          "update_campaign needs at least one field to change besides campaign_id.";
        logError("update_campaign", message, { agentId, campaignId });
        return errorResult(message);
      }

      log("update_campaign", "called", { agentId, campaignId, changed });
      try {
        const data = await callWrapper(
          "PATCH",
          `/campaigns/${encodeURIComponent(campaignId)}`,
          body
        );
        const campaign = data?.campaign ?? null;
        const transition = data?.transition ?? null;
        log("update_campaign", "success", {
          agentId,
          campaignId,
          changed,
          status: campaign?.status,
          transitioned: transition?.ok ?? null,
          refusal: transition?.ok === false ? transition.code : null,
        });
        return okResult({ campaign, transition });
      } catch (err) {
        logError("update_campaign", err.message, { agentId, campaignId, changed });
        return errorResult(err.message);
      }
    },
  }));

  api.registerTool((ctx) => ({
    name: "read_campaign_file",
    description:
      "Read a campaign's working strategy file — the angles, topics and guidance for producing work for THAT campaign. It usually opens with a header block mirroring the campaign's definition, but a file generated before the founder signed up has no header at all; that is normal, not a damaged file. Read it before writing anything for a campaign, and take the definition from read_campaign whenever the header is missing or disagrees with it — the header is agent-written and the database is the source of truth. campaign_id must be the one your task gave you — never guess it, and never reuse one from another task. Returns { content }, where content is null if this campaign has no file for that function yet.",
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
      "Write a campaign's working strategy file — the angles, topics and guidance the writers for THAT campaign work from. Pass the COMPLETE file: it is stored exactly as given and replaces everything that was there, so read the current one first rather than assuming your last version is still present. Open it with a header block stating the campaign's definition — id, name, status, start and end dates, target segment, core pitch, offer, and each channel with its daily maximum AND whether it is enabled — then the strategy below it. Take those values from read_campaign, never from memory: the database is the source of truth and the header only mirrors it. Mark disabled channels as disabled rather than dropping them, and do not write strategy aimed at one: work for a disabled channel is refused when the task is created. Content must not be empty; there is no way to clear a campaign file from here. campaign_id must be the one your task gave you — never guess it.",
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
          description:
            "The complete markdown file: the campaign header block, then the strategy.",
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
