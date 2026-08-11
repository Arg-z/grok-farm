#!/usr/bin/env node
// diag-turnstile-widget.js — diagnosa mengapa bot TIDAK menemukan/mencentang
// checkbox "Verify you are human" (Turnstile) di form nama/password x.ai.
//
// Alur: jalani signup sampai form nama/password muncul (widget Turnstile ada di
// situ), lalu DUMP struktur widget selengkapnya & coba beberapa strategi klik.
// TIDAK menyelesaikan signup (tidak ada akun dibuat).
import { readFileSync, existsSync } from "fs";
import { bukaBrowser, tutupBrowser } from "./src/browser.js";
import { generateEmail, pollKodeVerifikasi } from "./src/tempmail.js";
import { jenisChallengeCloudflare, cekWidgetSolved } from "./src/cloudflare.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

const config = existsSync("config.json")
  ? JSON.parse(readFileSync("config.json", "utf8"))
  : { browserMode: "cdp", cdpUrl: "http://127.0.0.1:9223" };

// Traversal rekursif yang menembus SHADOW ROOT (document.querySelectorAll biasa
// tidak menembus shadow DOM — kemungkinan penyebab widget tak terdeteksi).
const cariDalamShadow = () => {
  const hasil = [];
  const SELEKTOR = [
    "iframe",
    "[data-sitekey]",
    ".cf-turnstile",
    ".turnstile-wrapper",
    ".ctp-checkbox",
    ".ctp-checkbox-label",
    ".marker",
    "[data-turnstile]",
    "div[id*='turnstile' i]",
    "form",
  ];
  const walk = (root, depth) => {
    if (depth > 6) return;
    for (const sel of SELEKTOR) {
      let els = [];
      try { els = Array.from(root.querySelectorAll(sel)); } catch {}
      for (const el of els) {
        const r = el.getBoundingClientRect();
        hasil.push({
          sel,
          depth,
          tag: el.tagName,
          id: el.id,
          cls: (el.className && String(el.className)) || "",
          src: (el.src || "").slice(0, 90),
          sitekey: el.getAttribute && el.getAttribute("data-sitekey") || "",
          visible: r.width > 0 && r.height > 0,
          box: r.width > 0 ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
          inShadow: !!el.getRootNode && el.getRootNode().host != null,
        });
      }
    }
    if (root.shadowRoot) walk(root.shadowRoot, depth + 1);
    const kids = [];
    try { kids = Array.from(root.children || []); } catch {}
    for (const k of kids) walk(k, depth + 1);
  };
  walk(document, 0);
  return hasil;
};

async function main() {
  const email =
    process.argv[2] ||
    (await generateEmail(config.tempmailBaseUrl, config.domain).catch(
      () => `diag-${Date.now()}@${config.domain}`
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

    const btnEmail = page.locator("button").filter({ hasText: /sign up with email|continue with email/i }).first();
    if (await btnEmail.isVisible({ timeout: 8000 }).catch(() => false)) {
      await btnEmail.click();
      log("👆 Klik 'Sign up with email'");
      await sleep(1500);
    }

    const inputEmail = page.locator('input[type="email"], input[name="email"]').first();
    await inputEmail.waitFor({ timeout: 15000 });
    await inputEmail.fill(email);
    log(`✍️ Email: ${email}`);
    await sleep(500);

    const btn = page.locator("button").filter({ hasText: /continue|next|lanjut|sign up/i }).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click({ timeout: 8000, noWaitAfter: true }).catch(() => {});
      log("👆 Klik Continue setelah email");
    } else {
      await inputEmail.press("Enter");
    }
    await sleep(3000);

    log("⏳ Menunggu kode OTP di tempmail...");
    let kode = null;
    try {
      const r = await pollKodeVerifikasi({ baseUrl: config.tempmailBaseUrl, email, timeoutMs: 120000, onLog: (m) => log(`   ${m}`) });
      kode = r.kode;
    } catch (e) { log(`⚠️ ${e.message}`); }
    if (!kode) {
      log("❌ Tidak dapat kode OTP — tes berhenti sebelum form nama/password.");
      return;
    }
    log(`🔢 Kode OTP: ${kode}`);
    const kodeBersih = String(kode).replace(/-/g, "");
    const otpInput = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i]').first();
    await otpInput.waitFor({ timeout: 10000 });
    const jml = await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]').count().catch(() => 0);
    if (jml > 1 && kodeBersih.length === jml) {
      const semua = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]');
      for (let j = 0; j < kodeBersih.length; j++) await semua.nth(j).fill(kodeBersih[j]);
    } else {
      await otpInput.fill(kodeBersih);
    }
    await sleep(1500);
    const btnOtp = page.getByRole("button", { name: /confirm|continue|verify|next|submit/i }).first();
    if (await btnOtp.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btnOtp.click({ timeout: 8000, noWaitAfter: true }).catch(() => {});
      log("👆 Klik Confirm OTP");
    }

    for (let i = 0; i < 20; i++) {
      if (await page.locator('input[type="password"]').first().isVisible({ timeout: 1000 }).catch(() => false)) {
        log("✅ Form nama/password muncul.");
        break;
      }
      await sleep(1000);
    }
    await sleep(3000);

    // ============ ISI FORM DULU (persis alur bot — widget bisa baru render SETELAH ini) ============
    log("\n===== ISI FORM NAMA/PASSWORD (seperti bot) ====");
    const nama = "Diag Tes";
    const password = "DiagPass!2345";
    const isiField = async (loc, nilai) => {
      if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) return false;
      await loc.fill(nilai).catch(() => {});
      let isi = await loc.inputValue().catch(() => "");
      if (isi !== nilai) {
        await loc.fill("").catch(() => {});
        await loc.pressSequentially(nilai, { delay: 30 }).catch(() => {});
      }
      return true;
    };
    const inputDepan = page.locator('input[name="givenName"], input[autocomplete="given-name"], input[name*="first" i], input[placeholder*="first" i]').first();
    const inputBelakang = page.locator('input[name="familyName"], input[autocomplete="family-name"], input[name*="last" i], input[placeholder*="last" i]').first();
    const inputPass = page.locator('input[name="password"], input[type="password"]').first();
    await isiField(inputDepan, "Diag");
    await isiField(inputBelakang, "Tes");
    await isiField(inputPass, password);
    log(`✍️ Form diisi: Diag Tes / ${password.length} karakter.`);
    await sleep(3000);
    // cek tombol submit aktif/tidak setelah form diisi
    const btnSubmit = page.getByRole("button", { name: /complete sign up|create account|submit|daftar|complete/i }).last();
    log(`tombol submit visible=${await btnSubmit.isVisible({ timeout: 1500 }).catch(() => false)} disabled=${await btnSubmit.isDisabled({ timeout: 1500 }).catch(() => "?")}`);

    // ============ DUMP 1: kondisi dasar ============
    log("\n===== DUMP KONDISI HALAMAN =====");
    log(`URL: ${page.url().slice(0, 120)}`);
    log(`Semua frame (${page.frames().length}):`);
    for (const f of page.frames()) log(`   → [${f === page.mainFrame() ? "MAIN" : "iframe"}] ${(f.url() || "<kosong>").slice(0, 120)}`);
    const iframeDom = await page.evaluate(() => Array.from(document.querySelectorAll("iframe")).map((i) => ({ src: (i.src || "").slice(0, 100), id: i.id, cls: String(i.className || "") })));
    log(`iframe di DOM: ${JSON.stringify(iframeDom)}`);

    // ============ DUMP 2: tembus shadow DOM ============
    log("\n===== ELEMEN WIDGET (termasuk shadow DOM) =====");
    const w = await page.evaluate(cariDalamShadow).catch((e) => ({ error: e.message }));
    if (w.error) log(`error: ${w.error}`);
    else if (w.length === 0) log("TIDAK ADA elemen widget yang cocok (iframe/data-sitekey/cf-turnstile/dll).");
    else {
      for (const el of w) {
        log(`- ${el.sel} tag=${el.tag} id="${el.id}" cls="${el.cls}" src="${el.src}" sitekey="${el.sitekey}" visible=${el.visible} box=${JSON.stringify(el.box)} shadow=${el.inShadow}`);
      }
    }

    // ============ DUMP 3: POLLING sampai widget selesai render ============
    log("\n===== POLLING WIDGET (maks 30s) ====");
    let nTeks = 0;
    for (let it = 0; it < 10; it++) {
      const frames = page.frames().map((f) => (f === page.mainFrame() ? "MAIN" : (f.url() || "<kosong>").slice(0, 90)));
      const tf = page.frames().filter((f) => /challenges\.cloudflare/.test(f.url() || ""));
      let isiFrame = null;
      for (const f of tf) {
        isiFrame = await f
          .evaluate(() => {
            const semua = [];
            document.querySelectorAll("*").forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return;
              const tag = el.tagName;
              const txt = (el.innerText || "").trim().slice(0, 30);
              const cls = String(el.className || "").slice(0, 60);
              const role = el.getAttribute("role") || "";
              const aria = el.getAttribute("aria-checked") || "";
              const type = el.getAttribute("type") || "";
              if (/checkbox|marker|ctp|challenge|verify|robot|human|label|button/i.test(tag + cls + txt + role) || type === "checkbox" || role === "checkbox" || aria) {
                semua.push({ tag, type, role, aria, cls, txt, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
              }
            });
            const elHtml = document.querySelector(".ctp-checkbox, .ctp-checkbox-label, .marker, [role=checkbox], label");
            return { n: document.querySelectorAll("*").length, semua, html: elHtml ? elHtml.outerHTML.slice(0, 400) : null };
          })
          .catch(() => null);
        if (isiFrame) break;
      }
      const top = await page
        .evaluate(() => {
          const out = {};
          const ta = document.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]');
          out.tokenAda = !!ta && (ta.value || "").length > 0;
          out.adaTurnstile = document.querySelectorAll("[data-turnstile], .cf-turnstile, .turnstile-wrapper, [data-sitekey]").length;
          const ifs = [];
          document.querySelectorAll("iframe").forEach((i) => {
            const r = i.getBoundingClientRect();
            ifs.push({ src: (i.src || "").slice(0, 60), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
          });
          out.iframes = ifs;
          return out;
        })
        .catch(() => null);
      log(`-- iterasi ${it + 1} --`);
      log(`frames: ${JSON.stringify(frames)}`);
      log(`top DOM: token=${top && top.tokenAda} adaTurnstile=${top && top.adaTurnstile} iframes=${JSON.stringify(top && top.iframes)}`);
      if (isiFrame) {
        log(`frame turnstile: total-el=${isiFrame.n}`);
        if (isiFrame.semua.length) log(JSON.stringify(isiFrame.semua, null, 1));
        else if (isiFrame.n > 0) log(`(frame berisi ${isiFrame.n} elemen tapi tak ada checkbox/label/verify)`);
        if (isiFrame.html) log(`outerHTML: ${isiFrame.html}`);
      } else {
        log(`frame turnstile: (evaluate gagal / frame belum ada)`);
      }
      if (isiFrame && isiFrame.semua.length > 0) break;
      await sleep(3000);
    }

    // ============ DUMP 3x: ISI LENGKAP FRAME TURNSTILE ============
    log("\n===== ISI LENGKAP FRAME TURNSTILE =====");
    for (const f of page.frames().filter((ff) => /challenges\.cloudflare/.test(ff.url() || ""))) {
      const semua = await f
        .evaluate(() => {
          const out = [];
          document.querySelectorAll("*").forEach((el) => {
            const r = el.getBoundingClientRect();
            const tag = el.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META" || tag === "TITLE") return;
            const txt = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
            const cls = String(el.className || "").slice(0, 70);
            const role = el.getAttribute("role") || "";
            const aria = el.getAttribute("aria-checked") || "";
            const type = el.getAttribute("type") || "";
            out.push({
              tag,
              type,
              role,
              aria,
              cls,
              txt,
              box: r.width > 0 && r.height > 0 ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
              vis: r.width > 0 && r.height > 0,
            });
          });
          return out;
        })
        .catch((e) => [{ error: e.message }]);
      log(`frame: ${f.url().slice(0, 100)} — ${JSON.stringify(semua, null, 1)}`);
      const bodyHtml = await f.evaluate(() => document.body ? document.body.outerHTML.slice(0, 1500) : null).catch(() => null);
      if (bodyHtml) log(`\nBODY HTML (1500 char): ${bodyHtml}`);
    }

    // teks "Verify you are human" di top-level
    const teksWidget = page.getByText(/verify you are human|i'?m not a robot|i am human/i);
    nTeks = await teksWidget.count().catch(() => 0);
    log(`\nteks 'verify you are human' di top-level: ${nTeks}`);

    // ============ DUMP 4: status menurut bot ============
    const jenis = await jenisChallengeCloudflare(page);
    const sol = await cekWidgetSolved(page);
    log(`\njenisChallengeCloudflare = ${jenis}`);
    log(`cekWidgetSolved = ${JSON.stringify(sol)}`);
    const token = await page.locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]').first().inputValue().catch(() => "");
    log(`token cf-turnstile-response = ${token ? token.slice(0, 30) + "... (ADA)" : "kosong"}`);

    // ============ COBA KLIK 1: koordinat (logika bot sekarang) ============
    log("\n===== COBA KLIK =====");
    const { klikTurnstileByKoordinat } = await import("./src/cloudflare.js");
    const k1 = await klikTurnstileByKoordinat(page, log);
    log(`klikTurnstileByKoordinat = ${k1}`);
    await sleep(3000);
    const sol2 = await cekWidgetSolved(page);
    log(`setelah klik koordinat: ${JSON.stringify(sol2)}`);

    // ============ COBA KLIK 2: teks "Verify you are human" ============
    if (!sol2.token && sol2.checked !== true) {
      for (let i = 0; i < nTeks; i++) {
        const visible = await teksWidget.nth(i).isVisible({ timeout: 800 }).catch(() => false);
        if (visible) {
          log(`🧩 Klik teks widget #${i}...`);
          await teksWidget.nth(i).click({ timeout: 4000, noWaitAfter: true }).catch((e) => log(`   klik gagal: ${e.message.split("\n")[0]}`));
          await sleep(3000);
          break;
        }
      }
      const sol3 = await cekWidgetSolved(page);
      const token3 = await page.locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]').first().inputValue().catch(() => "");
      log(`setelah klik teks: ${JSON.stringify(sol3)} token=${token3 ? "ADA" : "kosong"}`);
    }

    log("\n===== SELESAI (TIDAK submit — tidak ada akun dibuat) =====");
  } finally {
    await tutupBrowser(browser, cdp);
  }
}

await main();
process.exit(0);
