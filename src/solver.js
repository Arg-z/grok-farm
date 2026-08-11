// solver.js — klien Turnstile solver (CapSolver)
// Dipakai alur signup untuk menyelesaikan Cloudflare Turnstile di accounts.x.ai.
//
// API key: env CAPSOLVER_KEY, atau config.json -> "capsolverApiKey".
// Daftar & ambil key di https://capsolver.com (top-up ~$5 cukup untuk ribuan solve).

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ENDPOINT = "https://api.capsolver.com";

function bacaApiKey() {
  if (process.env.CAPSOLVER_KEY && process.env.CAPSOLVER_KEY.trim()) {
    return process.env.CAPSOLVER_KEY.trim();
  }
  try {
    const cfgPath = join(__dirname, "..", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (cfg.capsolverApiKey && String(cfg.capsolverApiKey).trim()) {
        return String(cfg.capsolverApiKey).trim();
      }
    }
  } catch {}
  return "";
}

// URL solver lokal self-hosted (mis. ismoiloffS/EzSolver — gratis, tanpa API key):
//   POST {base}/solve  body {sitekey, siteurl, timeout} -> 200 {token, elapsed} | 500 {error}
// Diisi di config.json -> "turnstileSolverUrl". Kosong = mati (fallback CapSolver).
function bacaSolverUrl() {
  try {
    const cfgPath = join(__dirname, "..", "config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (cfg.turnstileSolverUrl && String(cfg.turnstileSolverUrl).trim()) {
        return String(cfg.turnstileSolverUrl).trim();
      }
    }
  } catch {}
  return "";
}

const fetchJson = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CapSolver HTTP ${res.status}: ${await res.text()}`);
  return res.json();
};

// Selesaikan 1 tugas Turnstile -> token.
// Prioritas: 1) solver lokal (turnstileSolverUrl, gratis)  2) CapSolver (capsolverApiKey).
export async function solveTurnstile({ sitekey, pageUrl }) {
  const solverUrl = bacaSolverUrl();
  if (solverUrl) {
    return solveTurnstileLokal(solverUrl, { sitekey, pageUrl });
  }
  const clientKey = bacaApiKey();
  if (!clientKey) {
    throw new Error("Tidak ada solver aktif. Isi config.json -> turnstileSolverUrl (solver lokal) atau capsolverApiKey (CapSolver), atau env CAPSOLVER_KEY.");
  }

  const create = await fetchJson(`${API_ENDPOINT}/createTask`, {
    clientKey,
    task: {
      type: "AntiTurnstileTaskProxyLess",
      websiteKey: sitekey,
      websiteURL: pageUrl,
    },
  });
  if (!create.taskId) throw new Error(`createTask gagal: ${JSON.stringify(create)}`);

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const res = await fetchJson(`${API_ENDPOINT}/getTaskResult`, {
      clientKey,
      taskId: create.taskId,
    });
    if (res.status === "ready") {
      const token = res.solution && res.solution.token;
      if (!token) throw new Error(`Token kosong: ${JSON.stringify(res)}`);
      return token;
    }
    if (res.status === "failed" || res.errorId) {
      throw new Error(`Solve gagal: ${JSON.stringify(res)}`);
    }
  }
  throw new Error("Timeout menunggu token Turnstile (120 detik).");
}

// Solve Turnstile via solver lokal self-hosted (EzSolver / sejenis).
async function solveTurnstileLokal(baseUrl, { sitekey, pageUrl }) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sitekey, siteurl: pageUrl, timeout: 60 }),
    signal: AbortSignal.timeout(70000),
  });
  if (!res.ok) {
    throw new Error(`Solver lokal HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const token = data.token || (data.solution && data.solution.token) || data.value;
  if (!token) {
    throw new Error(`Solver lokal tidak mengembalikan token: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return token;
}

// Ambil sitekey dari widget Turnstile di halaman.
//
// PENTING (fix dari rekaman nyata di rekam-turnstile.log / diag-live.log): di
// x.ai TIDAK ada elemen [data-sitekey] di DOM utama — iframe Turnstile punya
// src KOSONG di DOM (URL aslinya cuma ada di objek frame), dan sitekey hanya
// muncul di URL frame: .../turnstile/f/av0/rch/9gixb/0x4AAAAAAAhr9JGVDZbrZOo0/light/...
// Jadi urutan: [data-sitekey] DOM utama → [data-sitekey] di frame → regex dari
// URL frame widget → regex dari src iframe di DOM.
export async function ambilSitekey(page) {
  // 1) [data-sitekey] di DOM utama (widget standar)
  const diDom = await page.evaluate(() => {
    const el = document.querySelector("[data-sitekey]");
    return el ? el.getAttribute("data-sitekey") : null;
  });
  if (diDom) return diDom;

  // 2) [data-sitekey] di dalam frame (kadang widget dirender di dalam iframe)
  for (const f of page.frames()) {
    const key = await f
      .evaluate(() => {
        const el = document.querySelector("[data-sitekey]");
        return el ? el.getAttribute("data-sitekey") : null;
      })
      .catch(() => null);
    if (key) return key;
  }

  // 3) regex dari URL frame widget (kasus x.ai: sitekey cuma ada di sini)
  //    Format sitekey Turnstile: 0x4AAAAAAAhr9JGVDZbrZOo0 (0x + 20+ base64url)
  for (const f of page.frames()) {
    const url = f.url() || "";
    if (!/turnstile|hcaptcha|recaptcha|challenges\.cloudflare/i.test(url)) continue;
    const m = url.match(/0x[0-9A-Za-z_-]{20,}/);
    if (m) return m[0];
  }

  // 4) regex dari src iframe di DOM (beberapa situs isi src iframe beneran)
  const dariSrc = await page.evaluate(() => {
    for (const i of document.querySelectorAll("iframe[src*='turnstile'], iframe[src*='hcaptcha'], iframe[src*='recaptcha'], iframe[src*='challenges.cloudflare']")) {
      const m = (i.src || "").match(/0x[0-9A-Za-z_-]{20,}/);
      if (m) return m[0];
    }
    return null;
  });
  if (dariSrc) return dariSrc;

  throw new Error("Sitekey Turnstile tidak ditemukan di halaman (cek [data-sitekey] & URL frame widget).");
}

// Inject token hasil solver ke input tersembunyi cf-turnstile-response.
//
// Kalau textarea/input-nya belum ada di DOM (widget managed/invisible bisa
// menunda render elemen respons-nya), BIKIN elemennya dulu — banyak situs
// membaca elemen ini saat submit, jadi kehadirannya wajib. Isi lewat evaluate
// + dispatch event input/change (React/JS form kadang hanya membaca nilai
// setelah event; fill() biasa bisa gagal di elemen tersembunyi 0x0).
export async function injectToken(page, token) {
  const SEL = 'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]';
  let locator = page.locator(SEL).first();
  let jumlah = await locator.count().catch(() => 0);
  if (jumlah === 0) {
    const dibuat = await page
      .evaluate(() => {
        if (document.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')) {
          return true; // sudah ada (race) — tidak perlu bikin
        }
        const ta = document.createElement("textarea");
        ta.name = "cf-turnstile-response";
        ta.id = "cf-turnstile-response";
        ta.style.display = "none";
        (document.body || document.documentElement).appendChild(ta);
        return true;
      })
      .catch(() => false);
    if (!dibuat) return false;
    locator = page.locator(SEL).first();
  }

  const ok = await locator
    .evaluate((el, t) => {
      el.value = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, token)
    .catch(() => false);
  if (!ok) return false;

  const terisi = await locator.inputValue().catch(() => "");
  return !!terisi;
}

// Gabungan: ambil sitekey -> solve -> inject.
export async function solveTurnstileDiHalaman(page, pageUrl) {
  const sitekey = await ambilSitekey(page);
  const token = await solveTurnstile({ sitekey, pageUrl });
  const injected = await injectToken(page, token);
  return { token, sitekey, injected };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
