#!/usr/bin/env node
// rekam-langsung.js — REKAMAN LANGSUNG (live) struktur widget Turnstile.
//
// MODE REKAM bawaan bot (rekam-turnstile.log) hanya merekam saat bot sedang
// menunggu widget & ada cooldown ±8 detik — momen penting sering kelewat
// (checkbox muncul sebentar, class berubah saat solved, dll). Script ini
// merekam LANGSUNG & TERUS-MENERUS tiap ±1 detik dari detik pertama attach,
// sehingga seluruh transisi terekam:
//     "Checking your Browser…" → checkbox muncul → diklik → solved (token terisi)
//
// Cara pakai (sambung ke browser yang sedang menjalankan bot/diag):
//   node rekam-langsung.js                  # CDP default http://127.0.0.1:9223
//   node rekam-langsung.js 9223 120         # CDP custom + berhenti otomatis 120 detik
//
// Output: rekam-langsung.log (file BARU, terpisah dari rekam-turnstile.log bot).
// Hentikan dengan Ctrl+C — ringkasan ditulis di akhir.
import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { chromium } from "playwright";
import { jenisChallengeCloudflare, cekWidgetSolved } from "./src/cloudflare.js";
// Helper dump dipakai bersama dari rekam.js (jangan duplikasi — biar perbaikan
// dump 0x0/HTML mentah berlaku di kedua alat sekaligus).
import { dumpElemenFrame, barisElemen } from "./src/rekam.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_LOG = join(__dirname, "rekam-langsung.log");
const CDP_PORT = process.argv[2] || "9223";
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const MAX_DETIK = parseInt(process.argv[3] || "0", 10); // 0 = tanpa batas (Ctrl+C)
const INTERVAL_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// NOTE: dumpFrameLengkap & barisElemen sekarang diimpor dari src/rekam.js
// (dumpElemenFrame & barisElemen) — satu sumber kebenaran untuk dump widget.

// Kumpulkan status + dump semua frame (MAIN: container widget di top-level;
// iframe widget: semua elemen). Return objek yang bisa di-signature.
async function potretHalaman(page) {
  const url = page.url() || "";
  const jenis = await jenisChallengeCloudflare(page).catch(() => null);
  const st = await cekWidgetSolved(page).catch(() => ({ ada: false, checked: null, token: "" }));
  const token = st.token || "";

  const framesInfo = [];
  for (const f of page.frames()) {
    let fu = "<kosong>";
    try {
      fu = f.url() || "<kosong>";
    } catch {}
    const label = f === page.mainFrame() ? "MAIN" : fu.slice(0, 130);
    let els = [];
    if (f === page.mainFrame()) {
      // top-level: elemen widget turnstile yang terlihat di halaman utama
      els = await page
        .evaluate(() => {
          const hasil = [];
          document
            .querySelectorAll(
              '.cf-turnstile, .turnstile-wrapper, [data-sitekey], [data-turnstile], iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], textarea[name="cf-turnstile-response"]'
            )
            .forEach((el) => {
              const r = el.getBoundingClientRect();
              hasil.push({
                tag: el.tagName,
                cls: String(el.className || "").slice(0, 60),
                teks: (el.getAttribute("name") || "") === "cf-turnstile-response" ? "token:" + (el.value || "").slice(0, 20) : "",
                box: r.width > 0 ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
              });
            });
          return hasil;
        })
        .catch((e) => [{ error: e.message }]);
    } else if (/challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(fu)) {
      els = await dumpElemenFrame(f);
      // HTML mentah BODY frame (definitif — menangkap elemen 0x0/tersembunyi).
      const html = await f
        .evaluate(() => (document.body ? document.body.outerHTML : "(tidak ada BODY)"))
        .then((h) => h.replace(/\s+/g, " ").trim().slice(0, 1200))
        .catch(() => "(gagal ambil HTML)");
      els = els.concat({ __html: html });
    }
    framesInfo.push({ label, els });
  }
  return { url, jenis, st, token, framesInfo };
}

// Tulis dump LENGKAP ke log (tahan banting — jangan pernah crash pemanggil).
function tulisDump(p, elapsed) {
  const out = [];
  out.push("=".repeat(74));
  out.push(`REKAM LANGSUNG [t+${elapsed}s] — ${new Date().toISOString()}`);
  out.push(`URL: ${p.url}`);
  out.push(`[BOT] jenisChallengeCloudflare: ${p.jenis}`);
  out.push(`[BOT] cekWidgetSolved: ${JSON.stringify(p.st)}`);
  out.push(`[BOT] token: ${p.token ? p.token.slice(0, 40) + "..." : "(kosong)"}`);
  out.push("");
  for (const fi of p.framesInfo) {
    out.push(`[FRAME] ${fi.label}`);
    if (fi.els && fi.els.length)
      for (const e of fi.els) {
        // entri HTML mentah (dari potretHalaman) dirender sebagai baris khusus
        if (e && e.__html) out.push(`   [HTML BODY] ${e.__html}`);
        else out.push(barisElemen(e));
      }
    else out.push("   (tidak ada elemen terlihat)");
    out.push("");
  }
  try {
    appendFileSync(FILE_LOG, out.join("\n") + "\n");
  } catch (e) {
    log(`⚠️ Gagal menulis ${FILE_LOG}: ${e.message}`);
  }
}

// ============================ MAIN ============================
let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (e) {
  log(`❌ Tidak bisa connect CDP di ${CDP} — pastikan bot/diag sedang berjalan.`);
  log(`   Pesan: ${(e.message || "").split("\n")[0]}`);
  process.exit(1);
}

// Cari tab accounts.x.ai / challenges.cloudflare.com (tunggu sampai ada).
let page = null;
while (!page) {
  let contextGagal = false;
  try {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const u = p.url() || "";
        if (u.includes("accounts.x.ai") || u.includes("challenges.cloudflare.com")) {
          page = p;
          break;
        }
      }
      if (page) break;
    }
  } catch {
    contextGagal = true;
  }
  if (!page) {
    if (contextGagal) {
      log("⚠️ Browser terputus dari CDP — berhenti.");
      break;
    }
    log("⏳ Tab accounts.x.ai belum terbuka — polling tiap 2s... (Ctrl+C untuk berhenti)");
    await sleep(2000);
  }
}
if (!page) {
  browser.close().catch(() => {});
  process.exit(1);
}

log(`🎥 Rekaman langsung dimulai — target: ${(page.url() || "").slice(0, 110)}`);
log(`   Output: ${FILE_LOG}`);
if (MAX_DETIK > 0) log(`   Berhenti otomatis setelah ${MAX_DETIK} detik.`);
else log("   Hentikan dengan Ctrl+C.");

const t0 = Date.now();
let sigLalu = null;
let nDump = 0;
let nTick = 0;
let berhenti = false;
const onSig = () => {
  berhenti = true;
  log("\n⏹️  Menghentikan rekaman...");
};
process.on("SIGINT", onSig);
process.on("SIGTERM", onSig);

try {
  while (!berhenti) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (MAX_DETIK > 0 && elapsed >= MAX_DETIK) break;

    let p = null;
    try {
      p = await potretHalaman(page);
    } catch (e) {
      // halaman tertutup/navigasi — coba cari tab x.ai lagi
      log(`⚠️ Halaman hilang (${(e.message || "").split("\n")[0]}) — cari tab lagi...`);
      page = null;
      try {
        for (const ctx of browser.contexts()) {
          for (const pg of ctx.pages()) {
            const u = pg.url() || "";
            if (u.includes("accounts.x.ai") || u.includes("challenges.cloudflare.com")) {
              page = pg;
              break;
            }
          }
          if (page) break;
        }
      } catch {}
      if (!page) break;
      await sleep(INTERVAL_MS);
      continue;
    }

    // Signature perubahan: kalau sama dengan dump sebelumnya → cukup 1 baris tick.
    // Token di-truncate di signature supaya string tidak membengkak tiap detik.
    const sig = JSON.stringify({
      url: p.url.slice(0, 80),
      jenis: p.jenis,
      st: { ada: p.st.ada, checked: p.st.checked, token: p.token ? p.token.slice(0, 24) : "" },
      // HTML mentah ditruncate di signature — kalau HTML frame dinamis (nonce/ID
      // acak), perubahan kecil tidak memicu dump penuh tiap detik.
      frames: p.framesInfo.map((f) => [f.label, f.els.map((e) => (e && e.__html ? e.__html.slice(0, 200) : e))]),
    });
    if (sig !== sigLalu) {
      tulisDump(p, elapsed);
      nDump++;
      nTick = 0; // ukur "stabil" sejak perubahan TERAKHIR
      sigLalu = sig;
      log(`📸 t+${elapsed}s: ${p.jenis || "-"} token=${p.token ? "TERISI" : "kosong"} (dump #${nDump})`);
    } else {
      nTick++;
      try {
        appendFileSync(FILE_LOG, `-- t+${elapsed}s: tidak ada perubahan (token ${p.token ? "TERISI" : "kosong"})\n`);
      } catch {}
    }

    // kalau token terisi, tetap lanjut sebentar supaya state solved ikut terekam,
    // lalu berhenti otomatis (3 tick stabil berturut-turut setelah dump terakhir).
    if (p.token && nDump > 0 && sig === sigLalu && nTick >= 3) {
      log(`✅ Token terisi & stabil — rekaman selesai.`);
      break;
    }

    await sleep(INTERVAL_MS);
  }
} finally {
  const durasi = Math.round((Date.now() - t0) / 1000);
  log("=".repeat(50));
  log(`Selesai — ${durasi}s, ${nDump} dump lengkap, ${nTick} tick tanpa perubahan.`);
  log(`Log: ${FILE_LOG}`);
  browser.close().catch(() => {});
  process.exit(0);
}
