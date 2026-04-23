// King's Cross Tools plugin.
// Registers the six KC tools as a fixed, named set — not dynamically from a manifest.
// Each execute handler posts to the corresponding wrapper loopback endpoint,
// which injects tenantId + ORCHESTRATOR_SECRET and forwards to the orchestrator.

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

export default function register(api) {
  // kc_get_next_task — returns the top scheduled task for an agent (or empty).
  // agentId identifies whose queue to query; KC selects server-side.
  api.registerTool({
    name: "kc_get_next_task",
    description:
      "Fetch the next scheduled task assigned to this agent. Returns one task (highest priority, then earliest created_at), or an empty result if no scheduled tasks remain. Call this when triggered by a tasks_available or task_assigned notification, and after completing or failing a task to continue your loop — KC does not re-notify after completed or failed.",
    parameters: {
      type: "object",
      required: ["agentId"],
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Your own agent ID, as defined in IDENTITY.md.",
        },
      },
    },
    async execute(_toolCallId, { agentId }) {
      log("kc_get_next_task", "called", { agentId });
      try {
        const data = await callWrapper("GET", `/agent/${encodeURIComponent(agentId)}`);
        let text;
        if (!data.task) {
          text = "No scheduled tasks remaining. Your loop is complete — stop and wait for the next notification.";
          log("kc_get_next_task", "no tasks in queue", { agentId });
        } else {
          const { id, task_description, task_type_name, directive_filename } = data.task;
          log("kc_get_next_task", "task found", { agentId, taskId: id, task_type_name, directive_filename: directive_filename ?? null });
          const lines = [
            `Task ID: ${id}`,
            `Task type: ${task_type_name ?? "none"}`,
            `Description: ${task_description}`,
          ];
          if (directive_filename) {
            const workspace = `/data/.openclaw/workspace-${agentId}`;
            const skillName = directive_filename.replace(/\.md$/i, "");
            const skillPath = `${workspace}/skills/${skillName}/SKILL.md`;
            lines.push(`Skill file: ${skillPath} — this is a skill file that defines how to execute this task type. Read it and follow its instructions before proceeding.`);
            log("kc_get_next_task", "skill file attached", { agentId, taskId: id, skillPath });
          }
          text = lines.join("\n");
        }
        log("kc_get_next_task", "message sent to agent", { agentId, message: text });
        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        logError("kc_get_next_task", err.message, { agentId });
        return {
          content: [{ type: "text", text: `kc_get_next_task failed: ${err.message}` }],
        };
      }
    },
  });

  // kc_get_task — fetch a single task with its active artifacts.
  // Used on resumption after an approval_actioned notification to reconstruct full context.
  api.registerTool({
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
      log("kc_get_task", "called", { taskId });
      try {
        const data = await callWrapper("GET", `/${encodeURIComponent(taskId)}`);
        log("kc_get_task", "success", { taskId, execution_status: data.task?.execution_status, artifactCount: data.task?.artifacts?.length ?? 0 });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        logError("kc_get_task", err.message, { taskId });
        return {
          content: [{ type: "text", text: `kc_get_task failed: ${err.message}` }],
        };
      }
    },
  });

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
  api.registerTool({
    name: "kc_update_task",
    description:
      "Update your task's execution_status and/or agent_notes. You must be the assigned agent (agentId). " +
      "Valid status transitions: scheduled→processing, processing→awaiting_approval (only when approval_status=required or modify), processing→completed, processing→failed, received_approval→processing. " +
      "After completed or failed: call kc_get_next_task immediately to continue your loop — KC does not send another notification. " +
      "After awaiting_approval: stop your loop — KC will re-trigger you via tasks_available (for remaining scheduled tasks) or approval_actioned (when the user acts). " +
      "Provide at least one of execution_status or agent_notes.",
    parameters: {
      type: "object",
      required: ["agentId", "taskId"],
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Your own agent ID. Used for ownership validation.",
        },
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
    async execute(_toolCallId, { agentId, taskId, execution_status, agent_notes }) {
      log("kc_update_task", "called", { agentId, taskId, execution_status: execution_status ?? null, has_agent_notes: agent_notes !== undefined });
      try {
        const body = { agentId };
        if (execution_status !== undefined) body.execution_status = execution_status;
        if (agent_notes !== undefined) body.agent_notes = agent_notes;
        const data = await callWrapper("PATCH", `/${encodeURIComponent(taskId)}`, body);
        log("kc_update_task", "success", { agentId, taskId, execution_status: data.task?.execution_status, approval_status: data.task?.approval_status });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        logError("kc_update_task", err.message, { agentId, taskId, execution_status: execution_status ?? null });
        return {
          content: [{ type: "text", text: `kc_update_task failed: ${err.message}` }],
        };
      }
    },
  });

  // kc_create_task — create a new task assigned to another agent (runtime delegation).
  // agentId here is the creating agent (populates created_by_agent_id).
  api.registerTool({
    name: "kc_create_task",
    description:
      "Create a new task assigned to another agent. Use this to delegate work at runtime. agentId is your own agent ID (creator); assignedToAgentId is the target agent. priority defaults to end-of-queue if omitted.",
    parameters: {
      type: "object",
      required: ["agentId", "assignedToAgentId", "taskDescription"],
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Your own agent ID (creator). Recorded as created_by_agent_id.",
        },
        assignedToAgentId: {
          type: "string",
          description: "Agent ID of the agent this task is assigned to.",
        },
        taskDescription: {
          type: "string",
          description: "What the assigned agent should do.",
        },
        additionalInfo: {
          type: "string",
          description: "Optional additional context for the assigned agent.",
        },
        taskTypeId: {
          type: "string",
          description: "UUID of the task type. Drives approval logic when provided.",
        },
        priority: {
          type: "integer",
          description:
            "Task priority. Lower value = higher priority. Omit to place at end of queue.",
        },
      },
    },
    async execute(_toolCallId, { agentId, assignedToAgentId, taskDescription, additionalInfo, taskTypeId, priority }) {
      log("kc_create_task", "called", { agentId, assignedToAgentId, taskTypeId: taskTypeId ?? null, priority: priority ?? null });
      try {
        const body = { agentId, assignedToAgentId, taskDescription };
        if (additionalInfo !== undefined) body.additionalInfo = additionalInfo;
        if (taskTypeId !== undefined) body.taskTypeId = taskTypeId;
        if (priority !== undefined) body.priority = priority;
        const data = await callWrapper("POST", "", body);
        log("kc_create_task", "success", { agentId, assignedToAgentId, taskId: data.task?.id });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        logError("kc_create_task", err.message, { agentId, assignedToAgentId });
        return {
          content: [{ type: "text", text: `kc_create_task failed: ${err.message}` }],
        };
      }
    },
  });

  // kc_register_artifact — register an external artifact against a task before approval gate.
  // Must be called before transitioning to awaiting_approval so the artifact survives the async boundary.
  api.registerTool({
    name: "kc_register_artifact",
    description:
      "Store a reference to an external artifact (e.g. Gmail draft, Google Doc, CRM record) against your task. Call this before transitioning to awaiting_approval so the artifact ID is preserved across the async boundary. You must be the assigned agent.",
    parameters: {
      type: "object",
      required: ["agentId", "taskId", "artifactType", "platform", "externalId"],
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Your own agent ID. Used for ownership validation.",
        },
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
            "Additional context: subject line, recipient, preview text, document title, etc.",
        },
      },
    },
    async execute(_toolCallId, { agentId, taskId, artifactType, platform, externalId, metadata }) {
      log("kc_register_artifact", "called", { agentId, taskId, artifactType, platform, externalId });
      try {
        const body = { agentId, artifactType, platform, externalId };
        if (metadata !== undefined) body.metadata = metadata;
        const data = await callWrapper(
          "POST",
          `/${encodeURIComponent(taskId)}/artifacts`,
          body
        );
        log("kc_register_artifact", "success", { agentId, taskId, artifactId: data.artifact?.id });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        logError("kc_register_artifact", err.message, { agentId, taskId, artifactType, platform });
        return {
          content: [{ type: "text", text: `kc_register_artifact failed: ${err.message}` }],
        };
      }
    },
  });

  // kc_delete_artifact — soft-delete a superseded artifact (e.g. after revising a draft post-modify).
  // The old row is soft-deleted; register the replacement with kc_register_artifact.
  api.registerTool({
    name: "kc_delete_artifact",
    description:
      "Soft-delete a superseded artifact after a modify action (e.g. the old Gmail draft that was replaced with a revised version). You must be the assigned agent. After deleting, register the replacement with kc_register_artifact.",
    parameters: {
      type: "object",
      required: ["agentId", "taskId", "artifactId"],
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          description: "Your own agent ID. Used for ownership validation.",
        },
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
    async execute(_toolCallId, { agentId, taskId, artifactId }) {
      log("kc_delete_artifact", "called", { agentId, taskId, artifactId });
      try {
        const data = await callWrapper(
          "DELETE",
          `/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
          { agentId }
        );
        log("kc_delete_artifact", "success", { agentId, taskId, artifactId });
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        logError("kc_delete_artifact", err.message, { agentId, taskId, artifactId });
        return {
          content: [{ type: "text", text: `kc_delete_artifact failed: ${err.message}` }],
        };
      }
    },
  });
}
