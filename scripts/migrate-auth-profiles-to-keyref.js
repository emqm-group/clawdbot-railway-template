#!/usr/bin/env node
/**
 * Rewrite every auth-profiles.json under the state dir so that each api_key
 * profile uses a `keyRef` SecretRef instead of a plaintext `key`. Backs up
 * each file before overwriting.
 *
 * Why this exists: shards onboarded before the env-ref security fix store the
 * LLM key as plaintext on disk. This script migrates them in place. Once an
 * entry has `keyRef`, openclaw strips the plaintext `key` on every subsequent
 * save (per src/agents/auth-profiles/persisted.ts) so the ref form is sticky.
 *
 * Idempotent: profiles that already have `keyRef` and no `key` are left alone;
 * profiles with both fields get the plaintext stripped.
 *
 * IMPORTANT: openclaw writes auth-profiles.json back when it updates
 * usageStats (i.e. on every agent call). Pause agent traffic for the ~30s it
 * takes to run this script and restart the gateway, otherwise an in-flight
 * write can clobber the edit before the gateway re-reads.
 *
 * Usage:
 *   node scripts/migrate-auth-profiles-to-keyref.js
 *
 * Env overrides:
 *   OPENCLAW_STATE_DIR   defaults to /data/.openclaw
 *
 * After running:
 *   POST /api/gateway/restart   (or Railway → Restart)
 *   then verify a file still shows only keyRef after one test call.
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

// openclaw provider id → env var that holds its API key on this shard.
// MUST match AUTH_CHOICE_RUNTIME_ENV in src/server.js — keep in sync when
// adding new providers.
const PROVIDER_TO_ENV = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";

const files = execSync(`find ${STATE_DIR} -path "*/auth-profiles.json"`, { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

if (!files.length) {
  console.log(`no auth-profiles.json files found under ${STATE_DIR}`);
  process.exit(0);
}

const stamp = Date.now();
let rewritten = 0, unchanged = 0;

for (const f of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`! parse failed ${f}: ${e.message}`);
    continue;
  }

  let changed = false;
  for (const [id, p] of Object.entries(data.profiles ?? {})) {
    if (p.type !== "api_key") continue;
    if (typeof p.key !== "string" && !p.keyRef) continue;

    const envName = PROVIDER_TO_ENV[p.provider];
    if (!envName) {
      console.error(`! skip "${id}" in ${f}: no PROVIDER_TO_ENV mapping for "${p.provider}"`);
      continue;
    }

    if (typeof p.key === "string") { delete p.key; changed = true; }
    if (!p.keyRef) {
      p.keyRef = { source: "env", provider: "default", id: envName };
      changed = true;
    }
  }

  if (changed) {
    fs.copyFileSync(f, `${f}.bak.${stamp}`);
    fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
    console.log(`✓ rewrote ${f}`);
    rewritten++;
  } else {
    console.log(`- unchanged ${f}`);
    unchanged++;
  }
}

console.log(`\ndone: ${rewritten} rewritten, ${unchanged} unchanged (${files.length} total)`);
if (rewritten > 0) {
  console.log(`backups: *.bak.${stamp} alongside each rewritten file`);
  console.log("→ restart the gateway immediately to load the new keyRef form:");
  console.log('  curl -X POST "http://localhost:8080/api/gateway/restart" \\');
  console.log('       -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN"');
}
