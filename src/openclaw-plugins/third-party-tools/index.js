import fs from "fs";
import path from "path";

const MANIFEST_PATH = path.join(
  process.env.OPENCLAW_STATE_DIR || "/data/.openclaw",
  "tools-manifest.json"
);

const WRAPPER_PORT = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
const INVOKE_URL = `http://127.0.0.1:${WRAPPER_PORT}/api/tools/invoke`;

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return { tools: [] };
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { tools: [] };
  }
}

export default function (api) {
  const { tools } = readManifest();

  for (const entry of tools) {
    const { name, description, parameters } = entry;

    api.registerTool(
      (ctx) => ({
        name,
        description,
        parameters,
        async execute(_toolCallId, params) {
          const agentId = ctx.agentId;
          try {
            const res = await fetch(INVOKE_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: agentId, tool: name, params }),
            });

            const data = await res.json();

            if (!res.ok) {
              return {
                content: [{ type: "text", text: `Tool error [${data.code ?? res.status}]: ${data.message ?? JSON.stringify(data)}` }],
              };
            }

            return {
              content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Tool invocation failed: ${err.message}` }],
            };
          }
        },
      }),
      { optional: true }
    );
  }
}
