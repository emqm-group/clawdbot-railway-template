// King's Cross Tools plugin.
// Registers the six KC tools as a fixed, named set — not dynamically from a manifest.
// Each execute handler posts to the corresponding wrapper loopback endpoint,
// which injects tenantId + ORCHESTRATOR_SECRET and forwards to the orchestrator.
//
// Factory form (`api.registerTool((ctx) => ...)`): openclaw resolves tools
// per-agent and passes that agent's ctx.agentId, so the calling agent's ID is
// sourced from the runtime — agents never pass their own ID as a tool parameter.

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
const BASE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/tasks`;

function log(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[KC-TOOLS] [${tool}] ${msg}${metaStr}`);
}

function logError(tool, msg, meta) {
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  console.error(`[KC-TOOLS] [${tool}] ERROR: ${msg}${metaStr}`);
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
      `KC tool error [${res.status}]: ${data.error ?? data.message ?? JSON.stringify(data)}`
    );
  }
  return data;
}

function errorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

export default function register(api) {
  // kc_get_next_task — returns the top scheduled task for the calling agent.
  api.registerTool((ctx) => ({
    name: "kc_get_next_task",
    description:
      "Fetch the next scheduled task assigned to this agent. Returns one task (highest priority, then earliest created_at), or {\"task\":null} if no scheduled tasks remain. When a task is returned, the response also includes founder_timezone (IANA) and current_timestamp (ISO 8601, UTC) — use these as the wall-clock anchor when scheduling downstream work such as social posts. Call this when triggered by a tasks_available or task_assigned notification, and after completing or failing a task to continue your loop — KC does not re-notify after completed or failed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const agentId = ctx.agentId;
      log("kc_get_next_task", "called", { agentId });
      try {
        const data = await callWrapper("GET", `/agent/${encodeURIComponent(agentId)}`);
        if (!data.task) {
          log("kc_get_next_task", "no tasks in queue", { agentId });
          return { content: [{ type: "text", text: '{"task":null}' }] };
        }
        const t = data.task;
        const projected = {
          id: t.id,
          task_description: t.task_description,
        };
        if (t.directive_filename) {
          const skillName = t.directive_filename.replace(/\.md$/i, "");
          projected.skill_path = `/data/.openclaw/workspace-${agentId}/skills/${skillName}/SKILL.md`;
        }
        log("kc_get_next_task", "task found", { agentId, taskId: t.id, skill_path: projected.skill_path ?? null });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task: projected,
                founder_timezone: data.tenant_timezone ?? null,
                current_timestamp: data.current_timestamp ?? null,
              }),
            },
          ],
        };
      } catch (err) {
        logError("kc_get_next_task", err.message, { agentId });
        return errorResult(err.message);
      }
    },
  }));

  // kc_get_task — fetch a single task with its active artifacts.
  // Used on resumption after an approval_actioned notification to reconstruct full context.
  //
  // Factory form so ctx.agentId is available — the wrapper needs the calling
  // agent's id (query param) to look up the tenant via its in-memory mapping cache.
  api.registerTool((ctx) => ({
    name: "kc_get_task",
    description:
      "Fetch a single task by ID, including its active (non-deleted) artifacts. Use this after receiving an approval_actioned notification to load task state and artifacts before executing Phase 2.",
    parameters: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "UUID of the task to fetch.",
        },
      },
    },
    async execute(_toolCallId, { taskId }) {
      const agentId = ctx.agentId;
      log("kc_get_task", "called", { agentId, taskId });
      try {
        const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
        const data = await callWrapper("GET", `/${encodeURIComponent(taskId)}${qs}`);
        const t = data.task;
        if (!t) {
          logError("kc_get_task", "no task in response", { taskId });
          return errorResult(`no task returned for taskId=${taskId}`);
        }
        const projected = {
          id: t.id,
          task_description: t.task_description,
          user_notes: t.user_notes ?? null,
          agent_notes: t.agent_notes ?? null,
          artifacts: (t.artifacts ?? []).map((a) => ({
            id: a.id,
            external_id: a.external_id,
          })),
        };
        if (t.directive_filename && t.assigned_to_agent_id) {
          const skillName = t.directive_filename.replace(/\.md$/i, "");
          projected.skill_path = `/data/.openclaw/workspace-${t.assigned_to_agent_id}/skills/${skillName}/SKILL.md`;
        }
        log("kc_get_task", "success", {
          taskId,
          artifactCount: projected.artifacts.length,
          skill_path: projected.skill_path ?? null,
        });
        return { content: [{ type: "text", text: JSON.stringify({ task: projected }) }] };
      } catch (err) {
        logError("kc_get_task", err.message, { taskId });
        return errorResult(err.message);
      }
    },
  }));

  // kc_update_task — update execution_status and/or agent_notes on a task.
  // Only the assigned agent may call this. Ownership is validated server-side.
  //
  // Loop model (agent owns the loop, KC owns task selection):
  //   After completed/failed: call kc_get_next_task immediately — KC does NOT re-notify.
  //   After awaiting_approval: stop your loop. KC sends tasks_available if more scheduled
  //     tasks exist for you (so you can work while waiting), then approval_actioned when
  //     the user acts. Resume via the approval_actioned branch, not kc_get_next_task.
  //   After Phase 2 completes (approval_actioned → processing → completed): call
  //     kc_get_next_task to continue the loop — KC does not re-notify after completed.
  api.registerTool((ctx) => ({
    name: "kc_update_task",
    description:
      "Update your task's execution_status and/or agent_notes. You must be the assigned agent. " +
      "Provide at least one of execution_status or agent_notes.",
    parameters: {
      type: "object",
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "UUID of the task to update.",
        },
        execution_status: {
          type: "string",
          enum: [
            "processing",
            "awaiting_approval",
            "completed",
            "failed",
          ],
          description: "New execution status. Omit to update only agent_notes.",
        },
        agent_notes: {
          type: "string",
          description:
            "Snapshot notes for this transition. Required context for the reviewer when transitioning to awaiting_approval; completion/failure summary otherwise.",
        },
      },
    },
    async execute(_toolCallId, { taskId, execution_status, agent_notes }) {
      const agentId = ctx.agentId;
      log("kc_update_task", "called", { agentId, taskId, execution_status: execution_status ?? null, has_agent_notes: agent_notes !== undefined });
      try {
        const body = { agentId };
        if (execution_status !== undefined) body.execution_status = execution_status;
        if (agent_notes !== undefined) body.agent_notes = agent_notes;
        const data = await callWrapper("PATCH", `/${encodeURIComponent(taskId)}`, body);
        const t = data.task ?? {};
        const projected = { id: t.id };
        log("kc_update_task", "success", { agentId, taskId, execution_status: t.execution_status, approval_status: t.approval_status });
        return { content: [{ type: "text", text: JSON.stringify({ task: projected }) }] };
      } catch (err) {
        logError("kc_update_task", err.message, { agentId, taskId, execution_status: execution_status ?? null });
        return errorResult(err.message);
      }
    },
  }));

  // kc_report_status — respond to a kc:continue liveness ping.
  // KC sends `kc:continue` (via the liveness sweep) when a task appears stuck.
  // The agent answers with a single kc_report_status call on the task it
  // currently has bound: status="ok" if it is alive and progressing, or
  // status="error" with a message explaining why it cannot proceed.
  // Only the assigned agent may report; ownership is validated server-side.
  api.registerTool((ctx) => ({
    name: "kc_report_status",
    description:
      "Respond to a kc:continue liveness ping. Call this exactly once for the task you currently have bound. " +
      "status=\"ok\" means you are alive and still working — KC stops pinging and you continue normally. " +
      "status=\"error\" means you are stuck and cannot proceed — supply message explaining why; KC marks the task failed. " +
      "You must be the assigned agent.",
    parameters: {
      type: "object",
      required: ["taskId", "status"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "UUID of the task you currently have bound and are reporting on.",
        },
        status: {
          type: "string",
          enum: ["ok", "error"],
          description:
            "\"ok\" if you are alive and progressing; \"error\" if you are stuck and cannot proceed.",
        },
        message: {
          type: "string",
          description:
            "Explanation of why you are stuck. Expected when status=\"error\"; may be omitted when status=\"ok\".",
        },
      },
    },
    async execute(_toolCallId, { taskId, status, message }) {
      const agentId = ctx.agentId;
      log("kc_report_status", "called", { agentId, taskId, status, has_message: message !== undefined });
      try {
        const body = { agentId, status };
        if (message !== undefined) body.message = message;
        // Response carries nothing the agent acts on (counters reset / Outcome A
        // fire server-side); we just need a minimal ack. Errors (wrong taskId,
        // not owner) DO surface below so the agent can self-correct.
        const data = await callWrapper(
          "POST",
          `/${encodeURIComponent(taskId)}/liveness-response`,
          body
        );
        log("kc_report_status", "success", { agentId, taskId, status, stale: data.stale ?? false });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      } catch (err) {
        logError("kc_report_status", err.message, { agentId, taskId, status });
        return errorResult(err.message);
      }
    },
  }));

  // kc_create_task — create a new task (runtime delegation).
  // The calling agent (ctx.agentId) is recorded as created_by_agent_id.
  // The orchestrator resolves the owning agent from `taskName` (globally
  // unique) via the task_name → task_type → owning_agent chain.
  api.registerTool((ctx) => ({
    name: "kc_create_task",
    description:
      "Create a new task. Use this to delegate work at runtime. taskName identifies the specific operation (globally unique across all task types); the orchestrator resolves the owning agent and the directive/skill from taskName. priority defaults to end-of-queue if omitted. timeTrigger (optional) defers eligibility until a wall-clock time-of-day later today in the tenant's timezone.",
    parameters: {
      type: "object",
      required: ["taskName", "taskDescription"],
      additionalProperties: false,
      properties: {
        taskName: {
          type: "string",
          description:
            "Globally-unique name of the operation. The orchestrator uses this to resolve the owning agent, the task type, and the directive/skill that tells the assigned agent how to execute the task.",
        },
        taskDescription: {
          type: "string",
          description: "What the assigned agent should do.",
        },
        priority: {
          type: "integer",
          description:
            "Task priority. Lower value = higher priority. Omit to place at end of queue.",
        },
        timeTrigger: {
          type: "string",
          description:
            "Optional. Tenant-local time-of-day as HH:MM (zero-padded, hours 00-23, minutes 00-59). No date, no seconds, no timezone — the orchestrator stamps today's date in the tenant's timezone. Same-day, later-today only; earlier-today is rejected. The task is invisible to the assigned agent's queue until this moment passes; eligibility is enforced approximately, not in real time.",
          pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
        },
      },
    },
    async execute(_toolCallId, { taskName, taskDescription, priority, timeTrigger }) {
      const agentId = ctx.agentId;
      log("kc_create_task", "called", { agentId, taskName, priority: priority ?? null, timeTrigger: timeTrigger ?? null });
      try {
        const body = { agentId, taskName, taskDescription };
        if (priority !== undefined) body.priority = priority;
        if (timeTrigger !== undefined) body.timeTrigger = timeTrigger;
        const data = await callWrapper("POST", "", body);
        const projected = { id: data.task?.id };
        log("kc_create_task", "success", { agentId, taskName, taskId: projected.id });
        return { content: [{ type: "text", text: JSON.stringify({ task: projected }) }] };
      } catch (err) {
        logError("kc_create_task", err.message, { agentId, taskName, timeTrigger: timeTrigger ?? null });
        return errorResult(err.message);
      }
    },
  }));

  // kc_register_artifact — register an external artifact against a task before approval gate.
  // Must be called before transitioning to awaiting_approval so the artifact survives the async boundary.
  // NOTE: not currently exercised by any skill — kept registered for future use.
  api.registerTool((ctx) => ({
    name: "kc_register_artifact",
    description:
      "Store a reference to an external artifact (e.g. Gmail draft, Google Doc, CRM record) against your task. Call this before transitioning to awaiting_approval so the artifact ID is preserved across the async boundary. You must be the assigned agent.",
    parameters: {
      type: "object",
      required: ["taskId", "artifactType", "platform", "externalId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "UUID of the task this artifact belongs to.",
        },
        artifactType: {
          type: "string",
          description:
            "Type of artifact, e.g. email_draft, document, calendar_event, crm_contact, composio_result.",
        },
        platform: {
          type: "string",
          description:
            "Platform that owns the artifact, e.g. gmail, google_docs, salesforce, hubspot, composio.",
        },
        externalId: {
          type: "string",
          description: "ID of the artifact in the external system (e.g. Gmail draft ID).",
        },
        metadata: {
          type: "object",
          description:
            "Additional context: subject line, recipient, preview text, document title, etc. Used for approval-UI rendering only.",
        },
      },
    },
    async execute(_toolCallId, { taskId, artifactType, platform, externalId, metadata }) {
      const agentId = ctx.agentId;
      log("kc_register_artifact", "called", { agentId, taskId, artifactType, platform, externalId });
      try {
        const body = { agentId, artifactType, platform, externalId };
        if (metadata !== undefined) body.metadata = metadata;
        const data = await callWrapper(
          "POST",
          `/${encodeURIComponent(taskId)}/artifacts`,
          body
        );
        const a = data.artifact ?? {};
        const projected = { id: a.id, external_id: a.external_id };
        log("kc_register_artifact", "success", { agentId, taskId, artifactId: projected.id });
        return { content: [{ type: "text", text: JSON.stringify({ artifact: projected }) }] };
      } catch (err) {
        logError("kc_register_artifact", err.message, { agentId, taskId, artifactType, platform });
        return errorResult(err.message);
      }
    },
  }));

  // kc_delete_artifact — soft-delete a superseded artifact (e.g. after revising a draft post-modify).
  // The old row is soft-deleted; register the replacement with kc_register_artifact.
  // NOTE: not currently exercised by any skill — kept registered for future use.
  api.registerTool((ctx) => ({
    name: "kc_delete_artifact",
    description:
      "Soft-delete a superseded artifact after a modify action (e.g. the old Gmail draft that was replaced with a revised version). You must be the assigned agent. After deleting, register the replacement with kc_register_artifact.",
    parameters: {
      type: "object",
      required: ["taskId", "artifactId"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "UUID of the task this artifact belongs to.",
        },
        artifactId: {
          type: "string",
          description: "UUID of the artifact row to soft-delete.",
        },
      },
    },
    async execute(_toolCallId, { taskId, artifactId }) {
      const agentId = ctx.agentId;
      log("kc_delete_artifact", "called", { agentId, taskId, artifactId });
      try {
        await callWrapper(
          "DELETE",
          `/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
          { agentId }
        );
        log("kc_delete_artifact", "success", { agentId, taskId, artifactId });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      } catch (err) {
        logError("kc_delete_artifact", err.message, { agentId, taskId, artifactId });
        return errorResult(err.message);
      }
    },
  }));
}
