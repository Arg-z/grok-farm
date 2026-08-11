#!/usr/bin/env node
// dump-widget.js — diagnosa status widget Turnstile/Cloudflare di halaman x.ai
// yang sedang terbuka di browser bot (CDP port 9223).
//
// Dipakai saat bot gagal klik "verify you are human": jalankan selagi bot
// berjalan / browser terbuka, lalu lihat:
//   - URL & frame yang ada (apakah iframe widget terdeteksi?)
//   - apakah checkbox ada & tercentang
//   - apakah token cf-turnstile-response terisi
//   - jenis challenge yang dideteksi jenisChallengeCloudflare
//
// Pakai: node dump-widget.js
import { chromium } from "playwright";

const CDP = "http://127.0.0.1:9223";

let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (e) {
  console.log("❌ Tidak bisa connect CDP di " + CDP + " — pastikan bot sedang berjalan.");
  console.log("   Pesan: " + (e.message || "").split("\n")[0]);
  process.exit(1);
}

try {
  const contexts = browser.contexts();
  let found = false;
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url() || "";
      if (url.includes("accounts.x.ai") || url.includes("challenges.cloudflare.com")) {
        found = true;
        console.log("\n==============================================");
        console.log("URL:", url.slice(0, 160));
        console.log("TITLE:", await page.title().catch(() => ""));
        console.log("----------------------------------------------");

        // jenis challenge menurut bot
        const { jenisChallengeCloudflare, cekWidgetSolved } = await import("./src/cloudflare.js");
        const jenis = await jenisChallengeCloudflare(page);
        console.log("jenisChallengeCloudflare:", jenis);

        // semua frame + URL-nya
        console.log(`\nSemua frame (${page.frames().length}):`);
        for (const f of page.frames()) {
          const u = f.url() || "<kosong>";
          let cb = "n/a";
          if (/turnstile|challenges\.cloudflare|hcaptcha|recaptcha/i.test(u)) {
            const inp = f.locator('input[type="checkbox"]').first();
            const n = await inp.count().catch(() => 0);
            if (n > 0) cb = String(await inp.isChecked().catch(() => "?"));
            else cb = "no-checkbox";
          }
          console.log(`  → ${u.slice(0, 130)}  [checkbox: ${cb}]`);
        }

        // elemen widget di DOM top-level
        const dom = await page
          .evaluate(() => {
            const out = { iframes: [], sitekeys: [], response: null };
            document.querySelectorAll("iframe").forEach((i) => {
              out.iframes.push((i.src || "<src-kosong>").slice(0, 120));
            });
            document.querySelectorAll("[data-sitekey]").forEach((el) => {
              out.sitekeys.push(el.getAttribute("data-sitekey"));
            });
            const resp = document.querySelector(
              'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
            );
            if (resp) out.response = (resp.value || "").slice(0, 30);
            return out;
          })
          .catch(() => ({}));
        console.log("\niframe di DOM:", JSON.stringify(dom.iframes));
        console.log("data-sitekey  :", JSON.stringify(dom.sitekeys));
        console.log("token response:", dom.response ? dom.response + "… (ADA)" : "kosong");

        // status solved menurut bot
        const sol = await cekWidgetSolved(page);
        console.log("cekWidgetSolved:", JSON.stringify(sol));

        // teks halaman (500 char)
        const teks = ((await page.locator("body").innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .slice(0, 500);
        console.log("\nTEKS HALAMAN:", teks);
        console.log("----------------------------------------------");
      }
    }
  }
  if (!found) {
    console.log("⚠️ Tidak ada tab accounts.x.ai / challenges.cloudflare.com. Tab yang ada:");
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        console.log("-", (page.url() || "").slice(0, 110));
      }
    }
  }
} finally {
  await browser.close().catch(() => {});
  process.exit(0);
}
