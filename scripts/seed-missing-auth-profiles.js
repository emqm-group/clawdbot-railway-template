#!/usr/bin/env node
/**
 * Seed `<agentDir>/auth-profiles.json` for tenant agents that don't have one.
 *
 * For each agent in openclaw.json whose agentDir is missing the auth file,
 * copies the main agent's auth-profile structure (preserving keyRef entries
 * exactly, resetting usageStats to empty). Creates the agentDir if needed.
 *
 * Safety:
 *   - Refuses to run if main's auth-profiles.json has any plaintext `key`
 *     (i.e. not yet migrated). Run migrate-auth-profiles-to-keyref.js first.
 *   - Refuses to run if main has no auth-profiles.json (re-onboard the shard).
 *   - Skips agents that already have an auth-profiles.json (idempotent).
 *
 * Usage:
 *   node scripts/seed-missing-auth-profiles.js
 *
 * Env overrides:
 *   OPENCLAW_STATE_DIR   defaults to /data/.openclaw
 *
 * After running:
 *   POST /api/gateway/restart   (or Railway → Restart)
 */
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");
const MAIN_AUTH = path.join(STATE_DIR, "agents", "main", "agent", "auth-profiles.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`! config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(MAIN_AUTH)) {
  console.error(`! main auth-profiles missing: ${MAIN_AUTH}`);
  console.error("  re-onboard the shard before seeding tenants.");
  process.exit(1);
}

const mainAuth = JSON.parse(fs.readFileSync(MAIN_AUTH, "utf8"));
for (const [id, p] of Object.entries(mainAuth.profiles ?? {})) {
  if (p.type === "api_key" && typeof p.key === "string") {
    console.error(`! refusing: main profile "${id}" still has plaintext "key"`);
    console.error("  run migrate-auth-profiles-to-keyref.js first.");
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const agents = config.agents?.list ?? [];

let created = 0, skipped = 0;
for (const a of agents) {
  if (!a.id || a.id === "main" || !a.agentDir) continue;
  const target = path.join(a.agentDir, "auth-profiles.json");
  if (fs.existsSync(target)) { console.log(`- exists ${target}`); skipped++; continue; }

  fs.mkdirSync(a.agentDir, { recursive: true });
  // Same profiles as main; reset usageStats so per-agent counters start fresh.
  const payload = {
    version: mainAuth.version,
    profiles: mainAuth.profiles,
    usageStats: {},
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✓ seeded ${target}`);
  created++;
}

console.log(`\ndone: ${created} seeded, ${skipped} already present`);
if (created > 0) {
  console.log("→ restart the gateway so the new files are loaded:");
  console.log('  curl -X POST "http://localhost:8080/api/gateway/restart" \\');
  console.log('       -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN"');
}
