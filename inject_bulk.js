#!/usr/bin/env node
// inject_bulk.js — BULK INJECT akun yang SUDAH ADA (status signed_up) ke 9Router
// (provider Grok CLI / Grok Build). TIDAK bikin akun baru — cuma register akun
// yang sudah tersimpan di grok_accounts.json + cookies/<email>.json.
//
// Cara pakai:
//   node inject_bulk.js                  # inject SEMUA akun signed_up
//   node inject_bulk.js --n 10           # inject 10 akun signed_up pertama
//   node inject_bulk.js --email x@y.z    # inject satu akun tertentu
//   node inject_bulk.js --limit 5        # alias --n
//   node inject_bulk.js --list            # tampilkan target, TANPA inject (aman)
//   node inject_bulk.js --delete x@y.z    # hapus SATU akun (state + file cookies)
//   node inject_bulk.js --delete-all      # hapus SEMUA akun signed_up (ada konfirmasi)
//
// Status setelah selesai:
//   injected  -> akun ter-register di 9Router
//   signed_up -> inject gagal (error tercatat di kolom error) — cek log

import { readFileSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadAccounts, saveAccounts, ACCOUNTS_FILE } from "./src/state.js";
import { injectKe9Router } from "./src/inject.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Baca satu baris input dari terminal (untuk konfirmasi --delete-all).
const bacaEnter = () =>
  new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(String(d));
    });
  });

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
const nLimit = parseInt(nilai("--n", nilai("--limit", "0")), 10) || 0;
const emailTertentu = nilai("--email", "");
const listOnly = args.includes("--list");
const deleteEmail = nilai("--delete", "");
const deleteAll = args.includes("--delete-all");

const config = bacaConfig();

// ── HAPUS akun (state + file cookies) ───────────────────────────────
if (deleteAll || deleteEmail) {
  let accountsDel = loadAccounts();
  let hapus = [];
  if (deleteAll) {
    hapus = accountsDel.filter((a) => a.status === "signed_up");
    console.log(`🗑️  Akan menghapus ${hapus.length} akun signed_up + file cookies-nya.`);
    console.log("   Ketik 'ya' lalu Enter untuk konfirmasi, atau apa pun untuk batal:");
    const jawab = await bacaEnter();
    if (jawab.trim().toLowerCase() !== "ya") {
      console.log("🚫 Dibatalkan.");
      process.exit(0);
    }
  } else {
    hapus = accountsDel.filter((a) => a.email === deleteEmail);
    if (!hapus.length) {
      console.log(`❌ Akun '${deleteEmail}' tidak ditemukan di state.`);
      process.exit(1);
    }
  }
  for (const a of hapus) {
    accountsDel = accountsDel.filter((x) => x.email !== a.email);
    const cookiesPath = join(ROOT, config.cookiesDir || "cookies", `${a.email}.json`);
    if (existsSync(cookiesPath)) {
      try {
        unlinkSync(cookiesPath);
        console.log(`   🍪 File cookies dihapus: ${a.email}.json`);
      } catch {}
    }
    console.log(`   ✅ ${a.email} dihapus dari state.`);
  }
  saveAccounts(accountsDel);
  console.log(`\n🗑️  Selesai. ${hapus.length} akun dihapus.`);
  process.exit(0);
}

// ── kumpulkan target: akun signed_up (belum inject) ─────────────────
let accounts = loadAccounts();
let target = accounts.filter((a) => a.status === "signed_up");

if (emailTertentu) {
  target = target.filter((a) => a.email === emailTertentu);
  if (!target.length) {
    console.log(`❌ Akun '${emailTertentu}' tidak ditemukan / statusnya bukan signed_up.`);
    process.exit(1);
  }
}
if (nLimit > 0) target = target.slice(0, nLimit);

const jmlFailed = accounts.filter((a) => a.status === "failed").length;

console.log("==============================================");
console.log("🔗 BULK INJECT — register akun ke 9Router Grok CLI");
console.log(`   Target : ${target.length} akun signed_up`);
console.log(`   9Router: ${config.nineRouterBaseUrl || "http://127.0.0.1:20128"}`);
console.log("==============================================");
if (jmlFailed > 0) {
  console.log(`ℹ️  ${jmlFailed} akun failed tidak di-inject — signup-nya yang gagal (bukan inject).`);
}

if (!target.length) {
  console.log("ℹ️ Tidak ada akun signed_up yang perlu di-inject. Semua sudah injected / failed.");
  process.exit(0);
}

if (listOnly) {
  console.log("📋 Daftar target (mode --list, tidak di-inject):");
  for (const a of target) console.log(`   - ${a.email}  (${a.nama || "?"})`);
  process.exit(0);
}

let berhasil = 0;
let gagal = 0;

for (const akun of target) {
  console.log(`\n📦 Inject ${akun.email} ------------------------------`);

  // Load storage (cookies + localStorage) dari file cookies/<email>.json.
  // Kalau file tidak ada, inject tetap dicoba (context login / login ulang).
  let storage = null;
  const cookiesPath = join(ROOT, config.cookiesDir || "cookies", `${akun.email}.json`);
  if (existsSync(cookiesPath)) {
    try {
      storage = JSON.parse(readFileSync(cookiesPath, "utf8"));
    } catch {
      console.log("   ⚠️ File cookies rusak — inject tanpa storage.");
    }
  }

  // Inject dengan retry (max 3x), tanpa jeda antar percobaan (retryDelayMs di config).
  let inj = null;
  for (let coba = 1; coba <= 3; coba++) {
    try {
      inj = await injectKe9Router({
        config,
        akun: { ...akun, storage },
        onLog: (m) => console.log("   " + m),
      });
    } catch (e) {
      inj = { status: "failed", error: e.message || String(e) };
      console.log(`   ❌ Inject error tak terduga: ${inj.error}`);
    }
    if (inj.status === "injected") break;
    const deterministik = /unreachable|device login ditolak|access_denied|expired_token/i.test(inj.error || "");
    if (deterministik || coba >= 3) break;
    console.log(`   ↻ Inject gagal (${inj.error || "?"}) — retry ${coba}/3...`);
    await sleep(config.retryDelayMs || 0);
  }

  const entry = accounts.find((a) => a.email === akun.email);
  if (!entry) {
    console.log("   ⚠️ Akun hilang dari state — dilewati.");
    continue;
  }
  Object.assign(entry, {
    // Signup itu permanen: inject gagal -> tetap signed_up (bukan failed)
    status: inj.status === "injected" ? "injected" : "signed_up",
    error: inj.error || null,
    injectedAt: inj.status === "injected" ? new Date().toISOString() : entry.injectedAt,
    updatedAt: new Date().toISOString(),
  });
  saveAccounts(accounts);

  if (inj.status === "injected") {
    berhasil++;
    console.log(`   ✅ ${akun.email} → injected`);
  } else {
    gagal++;
    console.log(`   ❌ ${akun.email} → inject gagal: ${inj.error || "?"}`);
  }
}

console.log(`\n🎉 Selesai. ${berhasil} injected · ${gagal} gagal · dari ${target.length} akun.`);
console.log(`📄 State: ${ACCOUNTS_FILE}`);
if (gagal > 0) {
  console.log(`🔍 Cek baris DIAGNOSTIK / error di output untuk detail tiap kegagalan.`);
  console.log(`   Jalankan ulang: node inject_bulk.js${emailTertentu ? ` --email ${emailTertentu}` : ""}`);
}
process.exit(0);
