// cek endpoint 9Router dengan auth
const BASE = "http://127.0.0.1:20128";

async function run() {
  // 1. login dulu, simpan cookie
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Nkri1945!" }),
  });
  const cookies = login.headers.getSetCookie?.() || [];
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
  console.log("Login:", login.status, "cookie:", cookieStr.slice(0, 50) + "...");
  const headers = { Cookie: cookieStr };

  // 2. providers
  const prov = await fetch(`${BASE}/api/providers`, { headers });
  console.log("\n=== /api/providers ===");
  console.log("Status:", prov.status);
  const provBody = await prov.text();
  console.log("Body:", provBody.slice(0, 500));

  // 3. device-code
  const dc = await fetch(`${BASE}/api/oauth/grok-cli/device-code`, { headers });
  console.log("\n=== /api/oauth/grok-cli/device-code ===");
  console.log("Status:", dc.status);
  const dcBody = await dc.text();
  console.log("Body:", dcBody.slice(0, 500));

  // 4. coba endpoints lain
  const endpoints = [
    "/api/connections",
    "/api/tokens",
    "/api/keys",
    "/api/oauth/grok-cli/connections",
    "/api/providers/grok-cli",
    "/api/providers/grok-cli/connections",
    "/api/settings",
  ];
  for (const ep of endpoints) {
    const r = await fetch(`${BASE}${ep}`, { headers });
    const b = await r.text();
    if (r.status !== 404) console.log(`\n${ep} -> ${r.status}: ${b.slice(0, 200)}`);
  }

  // 5. coba POST add token langsung
  const addTok = await fetch(`${BASE}/api/providers/grok-cli/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ token: "test" }),
  });
  console.log("\n=== POST /api/providers/grok-cli/add ===");
  console.log("Status:", addTok.status);
  console.log("Body:", (await addTok.text()).slice(0, 300));

  // 6. coba POST token ke /api/tokens
  const addTok2 = await fetch(`${BASE}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ token: "test", provider: "grok-cli" }),
  });
  console.log("\n=== POST /api/tokens ===");
  console.log("Status:", addTok2.status);
  console.log("Body:", (await addTok2.text()).slice(0, 300));
}

run().catch(console.error);
