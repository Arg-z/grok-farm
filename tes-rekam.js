#!/usr/bin/env node
// tes-rekam.js — validasi MODE REKAM: buka simulasi widget Turnstile,
// panggil rekamTurnstile (SEBELUM-KLIK & SETELAH-KLIK), lalu tampilkan isi
// rekam-turnstile.log untuk memastikan dump berfungsi.
//
// Pakai: node tes-rekam.js
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { bukaBrowser, tutupBrowser } from "./src/browser.js";
import { rekamTurnstile } from "./src/rekam.js";

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

  // simulasi: SEBELUM klik — checkbox belum tercentang
  await rekamTurnstile(page, "SEBELUM-KLIK", log);

  // klik checkbox klasik (frame pertama)
  const frameKlasik = page.frames().find((f) => f.url().includes("klasik"));
  if (frameKlasik) {
    await frameKlasik.locator(".ctp-checkbox-label").click().catch(() => {});
    log("👆 Klik checkbox klasik.");
  }
  await sleep(1000);

  // simulasi: SETELAH klik — checkbox tercentang
  await rekamTurnstile(page, "SETELAH-KLIK", log);

  // tampilkan isi log
  const isi = readFileSync(join(__dirname, "rekam-turnstile.log"), "utf8");
  console.log("\n" + "=".repeat(30) + " ISI rekam-turnstile.log " + "=".repeat(30));
  console.log(isi.slice(-2500));
} finally {
  await tutupBrowser(browser, cdp);
}
process.exit(0);
