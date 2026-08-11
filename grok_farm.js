#!/usr/bin/env node
// grok_farm.js — farm akun Grok/xAI: SIGNUP -> INJECT (9Router) -> SAVE
//
// Cara pakai:
//   node grok_farm.js -n 1000 --headless
//   node grok_farm.js --dry-run                  (tanpa buat akun sungguhan)
//   node grok_farm.js --skip-inject              (hanya signup)
//   node grok_farm.js --force                    (ulangi akun yang sudah selesai)
//
// Status akun (state machine di grok_accounts.json):
//   pending -> signed_up -> injected | failed
// Resume otomatis: akun dengan status signed_up/injected dilewati.

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadAccounts, saveAccounts, STATUS_SELESAI, ACCOUNTS_FILE } from "./src/state.js";
import { signupAkun } from "./src/signup.js";
import { injectKe9Router } from "./src/inject.js";
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
// Terima -n DAN --n (konsisten dengan signup_bulk.js / inject_bulk.js)
const n = parseInt(nilai("--n", nilai("-n", config.jumlahAkun)), 10) || 1;
const headless = ada("--headless") ? true : config.headless;
const force = ada("--force");
const skipInject = ada("--skip-inject");
const dryRun = ada("--dry-run");

console.log("==============================================");
console.log("🌾 GROK FARM — signup -> inject 9Router -> save");
console.log(`   Target : ${n} akun`);
console.log(`   Mode   : ${headless ? "headless" : "headful"}` +
  `${dryRun ? " + DRY-RUN (no-op)" : ""}${force ? " + force" : ""}${skipInject ? " + skip-inject" : ""}`);
console.log(`   Domain : ${config.domain}  |  Solver: ${config.useSolver && (config.capsolverApiKey || config.turnstileSolverUrl) ? "ON" : "OFF"}`);
console.log("==============================================");

if (config.useSolver && !config.capsolverApiKey && !config.turnstileSolverUrl) {
  console.warn("⚠️  useSolver=true tapi capsolverApiKey & turnstileSolverUrl kosong — fallback manual.");
}
// Preflight solver lokal (EzSolver): kalau turnstileSolverUrl di-set tapi service-nya
// tidak hidup, peringatkan SEJAK AWAL — jangan sampai bot jalan diam-diam tanpa solve.
if (config.useSolver && config.turnstileSolverUrl) {
  const sehat = await fetch(`${config.turnstileSolverUrl.replace(/\/+$/, "")}/health`, {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!sehat) {
    console.warn(`⚠️  Solver lokal (turnstileSolverUrl=${config.turnstileSolverUrl}) tidak merespons — pastikan service EzSolver berjalan (python service.py). Bot tetap lanjut dengan klik otomatis + PAUSE manual.`);
  }
}
if (headless && !config.useSolver) {
  console.warn("⚠️  Headless + useSolver=false: captcha tidak bisa dilihat manual — bot akan PAUSE singkat (15 detik) lalu lanjut. Pakai headful dulu untuk tes.");
}

let accounts = loadAccounts();
const selesai = accounts.filter((a) => STATUS_SELESAI.has(a.status)).length;
if (!force && selesai > 0) {
  console.log(`♻️  Resume: ${selesai} akun sudah selesai, akan dilewati (pakai --force untuk ulangi).`);
}

let dibuat = selesai;
let slot = dibuat + 1;

while (dibuat < n) {
  console.log(`\n📦 Slot akun #${slot} -------------------------------`);

  // ── SIGNUP (retry per slot sampai maxRetries) ─────────────────────
  let hasil = null;
  let percobaan = 0;
  do {
    percobaan++;
    hasil = dryRun
      ? { email: `grok-dry${slot}-${percobaan}@${config.domain}`, password: "dry-run", nama: "Dry Run", status: "signed_up", storage: null }
      : await signupAkun({ config: { ...config, headless }, onLog: (m) => console.log("   " + m) });

    const entry = { email: hasil.email, createdAt: new Date().toISOString() };
    Object.assign(entry, {
      password: hasil.password,
      nama: hasil.nama,
      status: hasil.status,
      error: hasil.error || null,
      updatedAt: new Date().toISOString(),
    });
    accounts.push(entry);
    if (!dryRun) saveAccounts(accounts);

    if (hasil.status === "signed_up") break;
    if (percobaan <= config.maxRetries) {
      // Tanpa jeda: langsung retry (delayRetryMs di config, default 0).
      console.log(`   ↻ Gagal (${hasil.error || hasil.status}) — retry ${percobaan}/${config.maxRetries}...`);
      await sleep(config.retryDelayMs || 0);
    }
  } while (percobaan <= config.maxRetries);

  if (hasil.status !== "signed_up") {
    console.log(`   ✗ Slot gagal setelah ${percobaan} percobaan.`);
    slot++;
    await sleep(config.retryDelayMs || 0);
    continue;
  }

  // ── SAVE (cookies) ─────────────────────────────────────────────────
  if (!dryRun && hasil.storage) {
    const path = simpanCookies(config, hasil);
    console.log(`   🍪 Cookies tersimpan: ${path}`);
  }

  // ── INJECT ke 9Router ──────────────────────────────────────────────
  if (skipInject || dryRun) {
    console.log(`   ➜ Inject dilewati (${skipInject ? "--skip-inject" : "dry-run"}). Status: signed_up`);
  } else {
    // Inject di-RETRY (max 3x) sebelum menyerah. Sebelumnya inject gagal sekali
    // langsung lanjut akun berikutnya — bikin kelihatan "belum inject udah mulai
    // sesi baru" & akun signed_up numpuk. Retry memberi kesempatan jalur lain
    // (context login -> cookie) atau transient error sembuh.
    let inj = null;
    for (let coba = 1; coba <= 3; coba++) {
      try {
        inj = await injectKe9Router({
          config: { ...config, headless },
          akun: { ...hasil, storage: hasil.storage },
          onLog: (m) => console.log("   " + m),
        });
      } catch (e) {
        // Jaga-jaga: injectKe9Router seharusnya selalu return objek (tidak throw),
        // tapi kalau ada error tak terduga (CDP mati, dll) — tangkap & catat biar
        // akun TIDAK pernah tersisa signed_up tanpa error (yang bikin sulit debug).
        inj = { status: "failed", error: e.message || String(e) };
        console.log(`   ❌ Inject error tak terduga: ${inj.error}`);
      }
      if (inj.status === "injected") break;
      // Kegagalan DETERMINISTIK tidak usah di-retry (retry cuma buang waktu):
      // 9Router mati / device login ditolak. Langsung tandai gagal.
      const deterministik = /unreachable|device login ditolak|access_denied|expired_token/i.test(inj.error || "");
      if (deterministik || coba >= 3) break;
      // Tanpa jeda: langsung retry (delayRetryMs di config, default 0).
      console.log(`   ↻ Inject gagal (${inj.error || "?"}) — retry ${coba}/3...`);
      await sleep(config.retryDelayMs || 0);
    }
    const entryFinal = accounts.find((a) => a.email === hasil.email);
    Object.assign(entryFinal, {
      // Signup sukses itu permanen: inject gagal -> tetap signed_up (bukan failed)
      status: inj.status === "injected" ? "injected" : "signed_up",
      error: inj.error || null,
      injectedAt: inj.status === "injected" ? new Date().toISOString() : undefined,
      updatedAt: new Date().toISOString(),
    });
    saveAccounts(accounts);
  }

  const statusFinal = (accounts.find((a) => a.email === hasil.email) || {}).status || "signed_up";
  if (STATUS_SELESAI.has(statusFinal)) dibuat++;
  slot++;

  // ── jeda antar akun (default: TANPA jeda; atur delayAntarAkunDetik di config) ──
  if (dibuat < n) {
    const [min, max] = config.delayAntarAkunDetik || [0, 0];
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    if (delay > 0) {
      console.log(`⏸️  Jeda ${delay}s sebelum akun berikutnya (Ctrl+C untuk stop)...`);
      await sleep(delay * 1000);
    }
  }
}

console.log(`\n🎉 Selesai. ${dibuat}/${n} akun berhasil.`);
console.log(`📄 State: ${ACCOUNTS_FILE}`);
console.log("👉 Akun 'signed_up' tinggal inject manual, akun 'injected' siap dipakai 9Router.");

// Tutup tegas: koneksi CDP yang terbuka bisa menahan proses Node keluar
process.exit(0);
