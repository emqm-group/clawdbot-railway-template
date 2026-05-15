#!/usr/bin/env node
/**
 * Audit auth-profiles.json files across every agent on this shard.
 *
 * For each agent listed in openclaw.json reports:
 *   - whether its agentDir exists on disk
 *   - whether its auth-profiles.json exists
 *   - whether each api_key profile inside is in plaintext (`key`) or ref form (`keyRef`)
 *
 * Read-only — safe to run any time. Use this first to diagnose; then run
 * `seed-missing-auth-profiles.js` or `migrate-auth-profiles-to-keyref.js`
 * to fix anything it reports.
 *
 * Usage (on a shard's Railway shell):
 *   node scripts/audit-auth-profiles.js
 *
 * Env overrides:
 *   OPENCLAW_STATE_DIR   defaults to /data/.openclaw
 */
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

function inspect(filePath) {
  if (!fs.existsSync(filePath)) return { present: false };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { present: true, parseError: e.message };
  }
  const out = {};
  for (const [id, p] of Object.entries(data.profiles ?? {})) {
    if (p.type !== "api_key") { out[id] = `type=${p.type}`; continue; }
    const hasKey = typeof p.key === "string";
    const hasRef = !!p.keyRef;
    out[id] =
      hasKey && hasRef ? "PLAINTEXT+keyRef (cleanup needed)"
      : hasKey ? "PLAINTEXT (migrate to keyRef)"
      : hasRef ? "keyRef (clean)"
      : "EMPTY";
  }
  return { present: true, profiles: out };
}

function classifyAgent(agentDir) {
  if (!fs.existsSync(agentDir)) return { status: "MISSING_DIR" };
  const authPath = path.join(agentDir, "auth-profiles.json");
  const info = inspect(authPath);
  if (!info.present) return { status: "MISSING_AUTH_FILE", authPath };
  if (info.parseError) return { status: `PARSE_ERROR: ${info.parseError}`, authPath };
  const states = Object.values(info.profiles);
  if (states.some((s) => s.startsWith("PLAINTEXT"))) {
    return { status: "HAS_PLAINTEXT", authPath, profiles: info.profiles };
  }
  return { status: "OK", authPath, profiles: info.profiles };
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`! config not found: ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const agents = config.agents?.list ?? [];

console.log(`state dir : ${STATE_DIR}`);
console.log(`config    : ${CONFIG_PATH}`);
console.log("");

// Main agent's path is fixed regardless of openclaw.json contents.
const mainDir = path.join(STATE_DIR, "agents", "main", "agent");
console.log(`main: ${classifyAgent(mainDir).status}`);
const mainInfo = inspect(path.join(mainDir, "auth-profiles.json"));
if (mainInfo.profiles) {
  for (const [id, s] of Object.entries(mainInfo.profiles)) console.log(`  ${id}: ${s}`);
}
console.log("");

console.log("tenant agents:");
const issues = [];
for (const a of agents) {
  if (!a.id || a.id === "main" || !a.agentDir) continue;
  const r = classifyAgent(a.agentDir);
  console.log(`  ${a.id}: ${r.status}`);
  if (r.profiles) {
    for (const [id, s] of Object.entries(r.profiles)) console.log(`    ${id}: ${s}`);
  }
  if (r.status !== "OK") issues.push({ agentId: a.id, ...r });
}

console.log("");
console.log(`summary: ${agents.filter((a) => a.id !== "main").length} tenant agents, ${issues.length} need attention`);
if (issues.length) {
  const missing = issues.filter((i) => i.status === "MISSING_DIR" || i.status === "MISSING_AUTH_FILE");
  const plaintext = issues.filter((i) => i.status === "HAS_PLAINTEXT");
  if (missing.length) console.log(`  → run seed-missing-auth-profiles.js to fix ${missing.length} missing`);
  if (plaintext.length) console.log(`  → run migrate-auth-profiles-to-keyref.js to fix ${plaintext.length} plaintext`);
  process.exit(2);
}
