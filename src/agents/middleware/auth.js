// Inbound /api/* Bearer auth.
//
// Per the shared-gateway design (Decision #8 / Wrapper Impl #2), every inbound
// /api/* call from the orchestrator authenticates with a single per-shard
// Bearer: OPENCLAW_GATEWAY_TOKEN. The old per-tenant JWT model is gone — there
// is no JWT_SECRET, no signing, no expiry; just a constant-time compare against
// the value the orchestrator provisions onto the shard's Railway service.
//
// Loopback-only endpoints (`/api/tools/invoke`, `/api/tasks/*`) keep their
// existing IP guards and do NOT use this middleware.

import crypto from "node:crypto";

function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function authMiddleware(getExpectedToken) {
  // Accept either a string token or a getter to support late env-var binding.
  const resolve = typeof getExpectedToken === "function"
    ? getExpectedToken
    : () => getExpectedToken;

  return (req, res, next) => {
    const raw = resolve();
    const expected = typeof raw === "string" ? raw.trim() : "";
    if (!expected) {
      return res.status(503).json({ error: "OPENCLAW_GATEWAY_TOKEN not configured" });
    }
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const token = header.slice(7);
    if (!timingSafeStringEqual(token, expected)) {
      return res.status(401).json({ error: "Invalid token" });
    }
    next();
  };
}

export default authMiddleware;
