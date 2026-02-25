import http from "http";
import jwt from "jsonwebtoken";

const JWT_SECRET = "abcd1234";
const PORT = 3001;

/**
 * Simple API Routing Test
 * Tests that /api/ routes are NOT redirected to gateway proxy
 * Can run without OpenClaw installed
 */

// Generate a valid JWT token
function generateToken() {
  return jwt.sign({ sub: "test-user" }, JWT_SECRET, { expiresIn: "1h" });
}

function makeRequest(method, path, token = null, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };

    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          parsed: (() => {
            try {
              return JSON.parse(data);
            } catch {
              return data;
            }
          })(),
        });
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function runTests() {
  console.log("🧪 API Routing Tests\n");

  const token = generateToken();
  console.log(`✓ Generated JWT token: ${token.substring(0, 30)}...\n`);

  try {
    // Test 1: GET /api/agents without token (should fail with 401)
    console.log("Test 1: GET /api/agents without token");
    const test1 = await makeRequest("GET", "/api/agents");
    console.log(`  Status: ${test1.status}`);
    console.log(
      `  Response: ${test1.parsed.error || test1.body.substring(0, 100)}`,
    );
    const test1Pass = test1.status === 401;
    console.log(`  ${test1Pass ? "✅ PASS" : "❌ FAIL"} (expected 401)\n`);

    // Test 2: GET /api/agents with valid token (should succeed with 200)
    console.log("Test 2: GET /api/agents with valid token");
    const test2 = await makeRequest("GET", "/api/agents", token);
    console.log(`  Status: ${test2.status}`);
    console.log(
      `  Response: ${JSON.stringify(test2.parsed).substring(0, 150)}...`,
    );
    const test2Pass = test2.status === 200 && test2.parsed.agents !== undefined;
    console.log(
      `  ${test2Pass ? "✅ PASS" : "❌ FAIL"} (expected 200 with agents array)\n`,
    );

    // Test 3: POST /api/agents with valid token
    console.log("Test 3: POST /api/agents with valid token");
    const test3 = await makeRequest("POST", "/api/agents", token, {
      agentId: "test-agent",
      name: "Test Agent",
    });
    console.log(`  Status: ${test3.status}`);
    console.log(
      `  Response: ${JSON.stringify(test3.parsed).substring(0, 150)}...`,
    );
    // Will fail if OpenClaw not installed, but should be 500/400 not proxied
    const test3Pass =
      test3.status !== 502 && test3.status !== 504 && test3.status !== 301;
    console.log(
      `  ${test3Pass ? "✅ PASS" : "❌ FAIL"} (should NOT be 502/504 proxy error)\n`,
    );

    // Test 4: GET /api/nonexistent with token (should return 404)
    console.log("Test 4: GET /api/nonexistent with token");
    const test4 = await makeRequest("GET", "/api/nonexistent", token);
    console.log(`  Status: ${test4.status}`);
    console.log(`  Response: ${test4.parsed.error}`);
    const test4Pass = test4.status === 404 && test4.parsed.error;
    console.log(`  ${test4Pass ? "✅ PASS" : "❌ FAIL"} (expected 404)\n`);

    // Summary
    const results = [test1Pass, test2Pass, test3Pass, test4Pass];
    const passed = results.filter((r) => r).length;
    console.log(`\n📊 Results: ${passed}/${results.length} tests passed`);

    if (passed === results.length) {
      console.log("✅ All tests passed! API routing is working correctly.");
      process.exit(0);
    } else {
      console.log("❌ Some tests failed.");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Test error:", error.message);
    console.error(
      "   Make sure the server is running on port 3001: npm start (or PORT=3001 npm start)",
    );
    process.exit(1);
  }
}

// Wait a moment for server to be ready
setTimeout(() => {
  runTests();
}, 1000);
