import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("reset handler stops gateway before deleting config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('app.post("/setup/api/reset"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 900);
  // Reset must stop the gateway before deleting config. The handler was
  // refactored to use the stopGatewayIntentionally() helper (src/server.js),
  // which sends SIGTERM by default — assert on that instead of the old literal.
  assert.match(window, /stopGatewayIntentionally\(\)/);
});
