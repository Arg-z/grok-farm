// browser.js — buka/tutup browser untuk farm.
//
// Mode CDP (default): pakai Brave asli via CDP -> fingerprint asli -> x.ai tidak memblokir (403 hilang).
//   - Jika port CDP belum hidup, bot auto-launch Brave dengan profil khusus (tidak menyentuh profil asli kamu).
//   - Tiap akun memakai context terpisah (incognito) -> isolasi bersih.
//
// Mode TANPA JENDELA (config.headless=true) — DUA strategi:
//   A. "Hidden window" (default, DISARANKAN): launch Brave HEADFUL biasa tapi posisi
//      jendela DI LUAR LAYAR (--window-position=-32000,-32000). Fingerprint 100% asli
//      (headful) sehingga lolos 403 x.ai — TERBUKTI (tes: headful 200 vs headless 403),
//      tapi jendelanya tidak terlihat. Di port & profil khusus (9224 + .brave-profile-headless)
//      supaya tidak menempel ke Brave headful kamu yang sedang terbuka.
//   B. True headless (config.headlessMode="engine"): --headless=new. TIDAK DISARANKAN —
//      x.ai/Cloudflare tetap mendeteksinya (HTTP 403) meski pakai Brave asli.
//
// Mode launch: Playwright chromium biasa (headful/headless) — fallback saja.
import { spawn } from "child_process";
import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { chromium } from "playwright";
import { ROOT } from "./state.js";

const BRAVE_DEFAULT = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const CHROME_DEFAULT = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Nama browser untuk log — deteksi dari path executable (Chrome/Brave).
const namaBrowser = (path) => (/brave/i.test(path) ? "Brave" : /chrome/i.test(path) ? "Chrome" : "browser");

// Verifikasi koneksi CDP benar-benar responsif (CDP yang setengah mati bisa connect
// tapi hang). Beri batas waktu 8 detik supaya tidak menggantung selamanya.
const cekCdpSehat = async (browser) => {
  let timer;
  try {
    await Promise.race([
      browser.version(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("CDP tidak merespons")), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Auto-launch Brave lalu tunggu CDP hidup (maks 30 detik).
// `hiddenWindow` (default untuk headless) = jendela headful dipindah keluar layar.
async function launchBraveDanTungguCdp({ brave, profile, port, headless, onLog }) {
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble", // hindari dialog "restore pages" setelah crash
    "--window-size=1280,900",
  ];
  if (headless) {
    // Strategi A (default): jendela HEADFUL asli disembunyikan di luar layar.
    // Fingerprint tetap headful -> lolos 403 x.ai, tapi tidak terlihat di desktop.
    args.push("--window-position=-32000,-32000");
  }
  onLog(`🚀 Auto-launch ${namaBrowser(brave)} ${headless ? "(jendela disembunyikan di luar layar)" : ""}(profil: ${profile}) di port ${port}...`);
  spawn(brave, args, { detached: true, stdio: "ignore" }).unref();

  // Tunggu sampai 30 detik (auto-launch Brave pertama kali bisa lambat)
  const url = `http://127.0.0.1:${port}`;
  let browser = null;
  let lastErr = null;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    try {
      const b = await chromium.connectOverCDP(url);
      await cekCdpSehat(b);
      browser = b;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (browser) return browser;
  const alasan = (lastErr && lastErr.message || "").split("\n")[0];
  throw new Error(`CDP tidak bisa dihubungkan setelah auto-launch (${url}). ${alasan}`);
}

export async function bukaBrowser(config, onLog = () => {}) {
  if (config.browserMode === "cdp") {
    // ── TANPA-JENDELA CDP: port & profil khusus, jangan pernah menempel ke Brave visible ──
    if (config.headless) {
      // Jaga-jaga: kalau user tidak sengaja menyetel cdpHeadlessUrl sama dengan cdpUrl
      // (port headful), instance tanpa-jendela akan bentrok dengan profil Brave yang
      // terbuka (user-data-dir terkunci → instance kedua langsung exit → hang 30 detik).
      // Otomatis geser ke port+1 supaya tidak pernah menempel.
      let url = config.cdpHeadlessUrl || "http://127.0.0.1:9224";
      const baseUrl = config.cdpUrl || "http://127.0.0.1:9223";
      if (new URL(url).port === new URL(baseUrl).port) {
        const p = new URL(baseUrl).port;
        url = `http://127.0.0.1:${Number(p) + 1}`;
        onLog(`ℹ️  cdpHeadlessUrl sama dengan cdpUrl — otomatis geser ke ${url}.`);
      }
      try {
        const browser = await chromium.connectOverCDP(url);
        await cekCdpSehat(browser);
        onLog("🌐 Terhubung ke Brave (jendela tersembunyi) via CDP — bot jalan tanpa jendela.");
        return { browser, cdp: true };
      } catch {
        // belum ada instance -> launch baru
        const port = new URL(url).port || "9224";
        const brave = config.bravePath || config.chromePath || (existsSync(CHROME_DEFAULT) ? CHROME_DEFAULT : BRAVE_DEFAULT);
        const profileRaw = config.braveProfileHeadless || ".chrome-profile-headless";
        const profile = isAbsolute(profileRaw) ? profileRaw : join(ROOT, profileRaw);
        if (!existsSync(brave)) {
          throw new Error(`browserMode=cdp tanpa-jendela tapi browser tidak ditemukan di ${brave}. Atur bravePath di config.`);
        }
        const browser = await launchBraveDanTungguCdp({ brave, profile, port, headless: true, onLog });
        onLog("🌐 Terhubung ke Brave (auto-launch, jendela tersembunyi) via CDP — bot jalan tanpa jendela.");
        return { browser, cdp: true };
      }
    }

    // ── HEADFUL CDP (default) ──
    const url = config.cdpUrl || "http://127.0.0.1:9223";
    try {
      const browser = await chromium.connectOverCDP(url);
      await cekCdpSehat(browser);
      onLog("🌐 Terhubung ke browser asli via CDP (fingerprint asli, lolos 403 x.ai).");
      return { browser, cdp: true };
    } catch {
      // CDP mati/tidak sehat -> auto-launch Brave dengan profil khusus
      const port = new URL(url).port || "9223";
      const brave = config.bravePath || BRAVE_DEFAULT;
      const profileRaw = config.braveProfile || ".chrome-profile";
      const profile = isAbsolute(profileRaw) ? profileRaw : join(ROOT, profileRaw);
      if (!existsSync(brave)) {
        throw new Error(`browserMode=cdp tapi Brave tidak ditemukan di ${brave}. Atur bravePath di config.`);
      }
      const browser = await launchBraveDanTungguCdp({ brave, profile, port, headless: false, onLog });
      onLog("🌐 Terhubung ke Brave (auto-launch) via CDP.");
      return { browser, cdp: true };
    }
  }

  // mode launch: chromium bawaan Playwright
  const browser = await chromium.launch({ headless: !!config.headless });
  onLog(`🌐 Chromium diluncurkan (${config.headless ? "headless" : "headful"}).`);
  return { browser, cdp: false };
}

// Tutup browser. Untuk CDP: JANGAN tutup browser asli (Brave tetap hidup), hanya lepas context.
export async function tutupBrowser(browser, cdp) {
  if (!browser) return;
  try {
    if (!cdp) await browser.close();
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
