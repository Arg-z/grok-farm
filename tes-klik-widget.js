#!/usr/bin/env node
// tes-klik-widget.js — validasi logika klik checkbox Turnstile yang DIPERBARUI
// terhadap SIMULASI frame widget (same-origin, dua struktur DOM):
//   1. struktur klasik: <label class=ctp-checkbox-label><input type=checkbox>...<span class=marker>
//   2. struktur BARU:   <div role=checkbox aria-checked=false> (tanpa input asli)
//
// Widget Turnstile asli tidak bisa diuji andal di lingkungan CDP (sitekey tes
// tidak merender konten frame; demo resmi Cloudflare 403 untuk bot). Simulasi
// ini menguji logika inti yang diubah: deteksi struktur-agnostik
// (cekWidgetSolved) & klik struktur-agnostik (klikVerifikasiCloudflare) pada
// SEMUA varian DOM — persis yang dipakai melawan widget x.ai asli.
//
// Pakai: node tes-klik-widget.js
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { bukaBrowser, tutupBrowser } from "./src/browser.js";
import { cekWidgetSolved, klikVerifikasiCloudflare } from "./src/cloudflare.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));
const url = "file://" + join(__dirname, "tes-widget-simulasi.html").replace(/\\/g, "/");

const { browser, cdp } = await bukaBrowser(config, log);
try {
  const page = await browser.newPage();
  log(`🌐 Buka ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  log(`\n=== Frame (${page.frames().length}) ===`);
  for (const f of page.frames()) log(`  → ${f === page.mainFrame() ? "MAIN" : (f.url() || "<kosong>").slice(0, 80)}`);

  // ===== 1) DETEKSI: cekWidgetSolved harus menemukan checkbox di dua frame =====
  log(`\n🧪 [1] DETEKSI — cekWidgetSolved (harus menemukan checkbox di frame):`);
  const stAwal = await cekWidgetSolved(page);
  log(`  → ${JSON.stringify(stAwal)}`);
  if (!stAwal.ada) {
    log(`\n❌ GAGAL: cekWidgetSolved tidak mendeteksi checkbox — logika deteksi rusak.`);
    process.exit(1);
  }
  log(`  ✅ Deteksi bekerja (ada=${stAwal.ada}, checked=${stAwal.checked}).`);

  // ===== 2) KLIK: klikVerifikasiCloudflare harus mencentang frame pertama =====
  log(`\n🧪 [2] KLIK — klikVerifikasiCloudflare (struktur klasik):`);
  const k1 = await klikVerifikasiCloudflare(page, log);
  log(`  → hasil: ${k1}`);
  await sleep(1500);
  const st1 = await cekWidgetSolved(page);
  log(`  → cekWidgetSolved setelah klik: ${JSON.stringify(st1)}`);

  if (k1 && st1.checked === true) {
    log(`  ✅ Klik klasik BERHASIL — checkbox tercentang.`);
  } else {
    log(`  ⚠️  Klik klasik belum tercentang (checked=${st1.checked}).`);
  }

  // ===== 3) frame kedua (role=checkbox) — cek state & klik ulang =====
  log(`\n🧪 [3] Frame 2 (role=checkbox, struktur baru) — klik lagi: `);
  const k2 = await klikVerifikasiCloudflare(page, log);
  log(`  → hasil: ${k2}`);
  await sleep(1500);
  const st2 = await cekWidgetSolved(page);
  log(`  → cekWidgetSolved: ${JSON.stringify(st2)}`);

  // Ringkasan
  const ok = st1.checked === true && st2.checked === true;
  log(`\n${ok ? "🎉 SUKSES" : "⚠️ BELUM SEMPURNA"}: deteksi & klik struktur-agnostik ` +
      `(klasik checked=${st1.checked}, baru checked=${st2.checked}).`);
} finally {
  await tutupBrowser(browser, cdp);
}
process.exit(0);
