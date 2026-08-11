#!/usr/bin/env node
// diag-page.js — buka halaman signup x.ai lalu dump semua input/button yang terlihat.
// Dipakai untuk mengetahui selector yang BENAR-BENAR ada di halaman (bot tidak keisi = selector tidak cocok).
import { readFileSync } from "fs";
import { bukaBrowser, tutupBrowser } from "./src/browser.js";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const { browser, cdp } = await bukaBrowser(config);
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.signupUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000));

  const dump = await page.evaluate(() => {
    const info = {
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, 600),
    };
    const inputs = [];
    document.querySelectorAll("input").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        inputs.push({
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
          autocomplete: el.autocomplete,
          maxlength: el.maxLength,
          inputmode: el.inputMode,
          aria: el.getAttribute("aria-label") || "",
          visible: r.width > 0 && r.height > 0,
        });
      }
    });
    const buttons = [];
    document.querySelectorAll("button, a[role=button], [type=submit]").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        buttons.push((el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 60));
      }
    });
    return { info, inputs, buttons };
  });

  const dumpState = async (label) => {
    const d = await page.evaluate(() => {
      const info = { url: location.href, title: document.title };
      const inputs = [];
      document.querySelectorAll("input").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          inputs.push({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, autocomplete: el.autocomplete, maxlength: el.maxLength, inputmode: el.inputMode, aria: el.getAttribute("aria-label") || "" });
        }
      });
      const buttons = [];
      document.querySelectorAll("button, [role=button], [type=submit]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) buttons.push((el.innerText || el.value || "").trim().slice(0, 60));
      });
      return { info, inputs, buttons };
    });
    console.log(`\n=== ${label} ===`);
    console.log("URL:", d.info.url);
    console.log("TITLE:", d.info.title);
    console.log("INPUT:", JSON.stringify(d.inputs, null, 2));
    console.log("BUTTON:", JSON.stringify(d.buttons, null, 2));
  };

  await dumpState("AWAL");

  // Langkah 1: klik "Sign up with email"
  const btnEmail = page.locator("button").filter({ hasText: /sign up with email|continue with email/i }).first();
  if (await btnEmail.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btnEmail.click();
    await new Promise((r) => setTimeout(r, 3000));
  }
  await dumpState("SETELAH KLIK SIGNUP-EMAIL");

  // Langkah 2: isi email dummy + klik continue
  const inputEmail = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
  if (await inputEmail.isVisible({ timeout: 8000 }).catch(() => false)) {
    await inputEmail.fill("diag-test@pondok77.web.id");
    const btn = page.locator("button").filter({ hasText: /continue|next|lanjut/i }).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
    else await inputEmail.press("Enter");
    await new Promise((r) => setTimeout(r, 5000));
  }
  await dumpState("SETELAH ISI EMAIL + CONTINUE");

  // Langkah 3: form KODE OTP muncul — tunggu kode dari temp mail (x.ai kirim ke email dummy)
  // Lalu isi kode + klik Confirm email, baru form nama/password muncul.
  const { generateEmail, pollKodeVerifikasi } = await import("./src/tempmail.js");
  const emailDummy = "diag-" + Math.random().toString(36).slice(2, 8) + "@" + config.domain;
  const inputEmail2 = page.locator('input[name="email"], input[type="email"]').first();
  if (await inputEmail2.isVisible({ timeout: 8000 }).catch(() => false)) {
    await inputEmail2.fill(emailDummy);
    const btn = page.locator("button").filter({ hasText: /sign up|continue|next|lanjut/i }).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
    else await inputEmail2.press("Enter");
  }
  await dumpState("SETELAH ISI EMAIL DUMMY");

  // polling OTP (max 90 detik)
  console.log("\n⏳ Menunggu OTP dari x.ai ke " + emailDummy + " ...");
  let kode = null;
  try {
    const r = await pollKodeVerifikasi({ baseUrl: config.tempmailBaseUrl, email: emailDummy, timeoutMs: 90000, onLog: (m) => console.log(m) });
    kode = r.kode;
    console.log("KODE OTP:", kode);
  } catch (e) {
    console.log("Tidak dapat OTP:", e.message);
  }

  const inputKode = page.locator('input[name="code"], input[autocomplete="one-time-code"]').first();
  if (kode && (await inputKode.isVisible({ timeout: 5000 }).catch(() => false))) {
    await inputKode.fill(String(kode).replace(/-/g, ""));
    const btnC = page.locator("button").filter({ hasText: /confirm|continue|next|verify/i }).first();
    if (await btnC.isVisible({ timeout: 3000 }).catch(() => false)) await btnC.click();
    else await inputKode.press("Enter");
    await new Promise((r) => setTimeout(r, 5000));
  }
  await dumpState("SETELAH CONFIRM EMAIL (form nama/password)");
} finally {
  await tutupBrowser(browser, cdp);
  process.exit(0);
}
