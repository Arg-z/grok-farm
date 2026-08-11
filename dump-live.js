#!/usr/bin/env node
// dump-live.js — sambung ke Brave yang sedang di-launch bot (CDP port 9223),
// lalu dump struktur form nama/password yang sedang tampil di halaman x.ai.
// Dipakai saat bot berhenti di form First name/Last name/Password.
import { chromium } from "playwright";

const CDP = "http://127.0.0.1:9223";

let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (e) {
  console.log("❌ Tidak bisa connect CDP di " + CDP + " — pastikan bot sedang berjalan.");
  console.log("   Pesan: " + e.message.split("\n")[0]);
  process.exit(1);
}

try {
  const contexts = browser.contexts();
  let found = false;
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (url.includes("accounts.x.ai")) {
        found = true;
        console.log("=== Halaman ditemukan ===");
        console.log("URL:", url);
        console.log("TITLE:", await page.title().catch(() => ""));
        console.log("TEXT (500):", ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 500));
        const d = await page.evaluate(() => {
          const inputs = [];
          document.querySelectorAll("input").forEach((el) => {
            const r = el.getBoundingClientRect();
            inputs.push({
              visible: r.width > 0 && r.height > 0,
              type: el.type,
              name: el.name,
              id: el.id,
              placeholder: el.placeholder,
              autocomplete: el.autocomplete,
              maxlength: el.maxLength,
              inputmode: el.inputMode,
              aria: el.getAttribute("aria-label") || "",
            });
          });
          const buttons = [];
          document.querySelectorAll("button, [role=button]").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) buttons.push((el.innerText || "").trim().slice(0, 50));
          });
          return { inputs, buttons };
        });
        console.log("=== INPUT ===");
        console.log(JSON.stringify(d.inputs.filter((i) => i.visible), null, 2));
        console.log("=== BUTTON ===");
        console.log(JSON.stringify(d.buttons, null, 2));
      }
    }
  }
  if (!found) {
    // dump semua tab biar kelihatan bot ada di mana
    console.log("⚠️ Tab accounts.x.ai tidak ditemukan. Tab yang ada:");
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        console.log("-", page.url().slice(0, 100));
      }
    }
  }
} finally {
  await browser.close().catch(() => {});
  process.exit(0);
}
