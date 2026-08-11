#!/usr/bin/env node
// signup_bulk.js — BULK SIGNUP PARALEL: bikin banyak akun xAI sekaligus.
// Setiap worker pakai context incognito TERPISAH (browser CDP yang sama), jadi
// beberapa signup jalan bersamaan tanpa saling ganggu. Setelah signup selesai,
// status akun dicatat di grok_accounts.json (signed_up) + cookies disimpan.
//
// Berbeda dengan grok_farm.js: script ini HANYA signup (TIDAK inject ke 9Router).
// Kombinasikan dengan inject_bulk.js untuk register Grok CLI massal.
//
// Cara pakai:
//   node signup_bulk.js -n 20 --workers 3     # 20 akun, 3 worker paralel (atau --n 20)
//   node signup_bulk.js --n 50 --workers 5    # 50 akun, 5 worker
//   node signup_bulk.js --dry-run             # uji coba tanpa bikin akun
//
// CATATAN: x.ai bisa rate-limit/blokir IP kalau terlalu banyak request paralel.
// Mulai dari --workers 2-3, naikkan bertahap. IP tanpa proxy = batasnya cepat.

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadAccounts, saveAccounts, ACCOUNTS_FILE } from "./src/state.js";
import { signupAkun } from "./src/signup.js";
import { simpanCookies } from "./src/save.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bacaConfig() {
  const path = join(ROOT, "config.json");
  if (!existsSync(path)) {
    console.error("config.json tidak ditemukan.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── parsing argumen CLI ─────────────────────────────────────────────
const args = process.argv.slice(2);
const nilai = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const ada = (flag) => args.includes(flag);

const config = bacaConfig();
// Terima -n DAN --n (konsisten dengan script lain)
const n = parseInt(nilai("--n", nilai("-n", config.jumlahAkun)), 10) || 1;
const workers = Math.min(Math.max(parseInt(nilai("--workers", "2"), 10) || 2, 1), 8);
const dryRun = ada("--dry-run");
const headless = ada("--headless") ? true : config.headless;

console.log("==============================================");
console.log("⚡ BULK SIGNUP PARALEL — bikin akun xAI massal");
console.log(`   Target : ${n} akun`);
console.log(`   Workers: ${workers} (paralel)`);
console.log(`   Mode   : ${headless ? "headless" : "headful"}${dryRun ? " + DRY-RUN (no-op)" : ""}`);
console.log("   ⚠️  Hanya SIGNUP, tanpa inject 9Router. Pakai inject_bulk.js untuk register.");
console.log("==============================================");

// Probe CDP SEKALI sebelum pool: kalau browser belum jalan, bukaBrowser akan
// auto-launch Brave. Kalau dibiarkan, N worker bisa spawn Brave bersamaan ke
// port yang sama (konflik). Buka-tutup sekali di sini biar cuma SATU launch.
import { bukaBrowser, tutupBrowser } from "./src/browser.js";

let accounts = loadAccounts();
let dibuat = 0;
let gagal = 0;
let mutex = Promise.resolve(); // serialkan penulisan state biar tidak race condition

// Worker pool: proses `total` task dengan `workers` slot paralel.
// Setiap task = 1 slot akun (dengan retry sampai maxRetries di dalamnya).
const pool = async (total, workerCount, fn) => {
  let next = 0;
  const kerja = async () => {
    while (next < total) {
      const i = next++;
      await fn(i);
    }
  };
  const ws = [];
  for (let k = 0; k < workerCount; k++) ws.push(kerja());
  await Promise.all(ws);
};

// ── probe CDP (await, bukan fire-and-forget) ───────────────────────
const probe = await bukaBrowser(config).catch(() => null);
if (probe) await tutupBrowser(probe.browser, probe.cdp);

await pool(n, workers, async (slot) => {
  console.log(`\n📦 [W${slot % workers}] Slot akun #${slot + 1} ------------------------------`);
  let hasil = null;
  let percobaan = 0;
  do {
    percobaan++;
    hasil = dryRun
      ? { email: `grok-dry${slot}-${percobaan}@${config.domain}`, password: "dry-run", nama: "Dry Run", status: "signed_up", storage: null }
      : await signupAkun({
          config: { ...config, headless },
          contextBaru: true, // tiap worker pakai context incognito terpisah
          noPause: true,    // mode paralel: jangan tunggu Enter (stdin dipakai banyak worker)
          onLog: (m) => console.log(`   [W${slot % workers}] ${m}`),
        });
    if (hasil.status === "signed_up") break;
    if (percobaan <= config.maxRetries) {
      console.log(`   [W${slot % workers}] ↻ Gagal (${hasil.error || hasil.status}) — retry ${percobaan}/${config.maxRetries}...`);
      await sleep(config.retryDelayMs || 0);
    }
  } while (percobaan <= config.maxRetries);

  // simpan ke state — SERIAL (mutex) biar tulis file tidak tabrakan antar worker.
  // Bungkus dalam try/catch: kalau tulis gagal, mutex TIDAK jadi rejected (kalau
  // rejected, semua worker berikutnya yang await mutex ikut throw → pool rusak).
  mutex = mutex.then(async () => {
    const entry = { email: hasil.email, createdAt: new Date().toISOString() };
    Object.assign(entry, {
      password: hasil.password,
      nama: hasil.nama,
      status: hasil.status,
      error: hasil.error || null,
      updatedAt: new Date().toISOString(),
    });
    accounts.push(entry);
    if (!dryRun) {
      try { saveAccounts(accounts); } catch (e) { console.log(`   ⚠️ Gagal simpan state: ${e.message}`); }
    }
  }).catch(() => {});
  await mutex;

  if (hasil.status === "signed_up") {
    dibuat++;
    if (!dryRun && hasil.storage) {
      try {
        const path = simpanCookies(config, hasil);
        console.log(`   [W${slot % workers}] 🍪 Cookies: ${path}`);
      } catch {}
    }
    console.log(`   [W${slot % workers}] ✅ Akun #${slot + 1} signed_up`);
  } else {
    gagal++;
    console.log(`   [W${slot % workers}] ❌ Akun #${slot + 1} gagal: ${hasil.error || "?"}`);
  }
});

console.log(`\n🎉 Selesai. ${dibuat} signed_up · ${gagal} gagal · dari ${n} akun (${workers} worker paralel).`);
console.log(`📄 State: ${ACCOUNTS_FILE}`);
console.log("👉 Lanjutkan ke register Grok CLI: node inject_bulk.js");
process.exit(0);
