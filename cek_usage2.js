// Cek semua endpoint 9Router yang mungkin ada data usage
const BASE = "http://127.0.0.1:20128";

async function run() {
  // login
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Nkri1945!" }),
  });
  const cookies = login.headers.getSetCookie?.() || [];
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
  const h = { Cookie: cookieStr };

  const endpoints = [
    "/api/providers",
    "/api/usage",
    "/api/stats",
    "/api/connections",
    "/api/keys",
    "/api/logs",
    "/api/analytics",
    "/api/metrics",
    "/api/billing",
    "/api/quota",
    "/api/dashboard",
    "/api/dashboard/usage",
    "/api/dashboard/stats",
    "/api/requests",
    "/api/tokens",
    "/api/cost",
  ];

  for (const ep of endpoints) {
    const r = await fetch(`${BASE}${ep}`, { headers: h });
    const b = await r.text();
    if (r.status !== 404 && r.status !== 401) {
      console.log(`\n=== ${ep} -> ${r.status} ===`);
      console.log(b.slice(0, 800));
    }
  }
}

run().catch(console.error);
