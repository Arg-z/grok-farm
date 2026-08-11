// tes-turnstile.js — buktikan bot BISA klik widget Turnstile Cloudflare di
// halaman signup x.ai ASLI (tempat widget itu benar-benar muncul).
//
// Alur: buka signup -> klik "Sign up with email" -> isi email tempmail ->
// klik Continue -> ambil OTP dari tempmail -> konfirmasi -> form nama/password
// muncul (widget Turnstile ada di sini) -> jalankan logika klik ASLI bot
// (tungguVerifyDanKlik) -> verifikasi checkbox tercentang.
//
// Pakai: node tes-turnstile.js [email-opsional]
import { bukaBrowser, tutupBrowser } from "./src/browser.js";
import { tungguVerifyDanKlik, jenisChallengeCloudflare } from "./src/cloudflare.js";
import { generateEmail, pollKodeVerifikasi } from "./src/tempmail.js";
import { readFileSync, existsSync } from "fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

const config = existsSync("config.json")
  ? JSON.parse(readFileSync("config.json", "utf8"))
  : { browserMode: "cdp", cdpUrl: "http://127.0.0.1:9223" };

async function main() {
  const email =
    process.argv[2] ||
    (await generateEmail(config.tempmailBaseUrl, config.domain).catch(
      () => `tes-${Date.now()}@${config.domain}`
    ));

  const { browser, cdp } = await bukaBrowser(config, log);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    log(`🌐 Buka signup x.ai...`);
    await page.goto(config.signupUrl || "https://accounts.x.ai/sign-up?redirect=grok-com", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);

    // 1) klik "Sign up with email"
    const btnEmail = page
      .locator("button")
      .filter({ hasText: /sign up with email|continue with email/i })
      .first();
    if (await btnEmail.isVisible({ timeout: 8000 }).catch(() => false)) {
      await btnEmail.click();
      log("👆 Klik 'Sign up with email'");
      await sleep(1500);
    }

    // 2) isi email
    const inputEmail = page.locator('input[type="email"], input[name="email"]').first();
    await inputEmail.waitFor({ timeout: 15000 });
    await inputEmail.fill(email);
    log(`✍️ Email: ${email}`);
    await sleep(500);

    const btn = page
      .locator("button")
      .filter({ hasText: /continue|next|lanjut|sign up/i })
      .first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click({ timeout: 8000, noWaitAfter: true }).catch(() => {});
      log("👆 Klik Continue setelah email");
    } else {
      await inputEmail.press("Enter");
    }
    await sleep(3000);

    // 3) ambil OTP dari tempmail, lalu konfirmasi -> form nama/password
    log("⏳ Menunggu kode OTP di tempmail...");
    let kode = null;
    try {
      const r = await pollKodeVerifikasi({
        baseUrl: config.tempmailBaseUrl,
        email,
        timeoutMs: 120000,
        onLog: (m) => log(`   ${m}`),
      });
      kode = r.kode;
    } catch (e) {
      log(`⚠️ ${e.message}`);
    }
    if (!kode) {
      log("❌ Tidak dapat kode OTP — tes berhenti di sini.");
      return;
    }
    log(`🔢 Kode OTP: ${kode}`);

    const kodeBersih = String(kode).replace(/-/g, "");
    const otpInput = page
      .locator(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i]'
      )
      .first();
    await otpInput.waitFor({ timeout: 10000 });
    const jml = await page
      .locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]')
      .count()
      .catch(() => 0);
    if (jml > 1 && kodeBersih.length === jml) {
      const semua = page.locator(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]'
      );
      for (let j = 0; j < kodeBersih.length; j++) await semua.nth(j).fill(kodeBersih[j]);
      log(`✍️ OTP diisi ke ${jml} kotak.`);
    } else {
      await otpInput.fill(kodeBersih);
      log(`✍️ OTP diisi: ${kodeBersih}`);
    }
    await sleep(1500);
    const btnOtp = page.getByRole("button", { name: /confirm|continue|verify|next|submit/i }).first();
    if (await btnOtp.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btnOtp.click({ timeout: 8000, noWaitAfter: true }).catch(() => {});
      log("👆 Klik Confirm OTP");
    }

    // 4) tunggu form nama/password muncul
    for (let i = 0; i < 20; i++) {
      const ada = await page
        .locator('input[type="password"]')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (ada) {
        log("✅ Form nama/password muncul.");
        break;
      }
      await sleep(1000);
    }
    await sleep(3000);

    // 5) dump kondisi halaman (frame/iframe turnstile)
    log("\n--- DEBUG kondisi halaman ---");
    log(`URL: ${page.url().slice(0, 110)}`);
    log(`Teks: ${((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 300)}`);
    log(`Semua frame (${page.frames().length}):`);
    for (const f of page.frames()) log(`   → ${(f.url() || "<kosong>").slice(0, 110)}`);
    const semIframe = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map((i) => (i.src || "").slice(0, 110))
    );
    log(`iframe di DOM: ${JSON.stringify(semIframe)}`);

    const jenis = await jenisChallengeCloudflare(page);
    log(`🧪 jenisChallengeCloudflare = ${jenis}`);

    // 6) klik widget pakai logika asli bot
    log("\n🧩 Jalankan tungguVerifyDanKlik (logika klik asli bot)...");
    const beres = await tungguVerifyDanKlik(page, log, { timeoutMs: 60000 });

    // 7) verifikasi: checkbox di frame turnstile (via objek frame — iframe src
    //    di DOM kosong, jadi frameLocator tidak mempan) + token cf-turnstile-response
    const framesT = page
      .frames()
      .filter((f) => /challenges\.cloudflare\.com/.test(f.url() || ""));
    let checked = null;
    let adaCheckbox = false;
    for (const f of framesT) {
      const cb = f.locator('input[type="checkbox"]').first();
      if ((await cb.count().catch(() => 0)) > 0) {
        adaCheckbox = true;
        checked = await cb.isChecked().catch(() => null);
      }
    }
    const token = await page
      .locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')
      .first()
      .inputValue()
      .catch(() => "");

    log("\n=============================");
    log(`Hasil tungguVerifyDanKlik : ${beres}`);
    log(
      `Checkbox di widget          : ${
        adaCheckbox ? (checked === true ? "TERCENTANG ✅" : "belum tercentang") : "tidak ditemukan di frame"
      }`
    );
    log(`Token cf-turnstile-response: ${token ? token.slice(0, 40) + "... (ADA ✅)" : "kosong"}`);
    if (adaCheckbox && checked === true) {
      log("🎉 WIDGET DITAMPILKAN & BERHASIL DIKLIK (checkbox tercentang).");
    } else if (adaCheckbox) {
      log("⚠️ Checkbox muncul tapi belum tercentang — cek log di atas.");
    } else if (beres) {
      log("ℹ️ Widget ada tapi mode invisible (tanpa checkbox) — tidak perlu diklik, ini normal.");
    } else {
      log("⚠️ Bot belum berhasil — cek log di atas.");
    }
    log("=============================");
  } finally {
    await tutupBrowser(browser, cdp);
  }
}

await main();
process.exit(0);
