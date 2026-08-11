// inject.js — INJECT phase: hubungkan akun xAI ke 9Router (provider Grok CLI / Grok Build)
//
// Dua jalur API + satu jalur UI:
//  A. API xai (lama) — Grok Build OAuth via start-proxy:
//     GET  /api/oauth/xai/authorize?redirect_uri=... -> { state, codeVerifier, authUrl }
//     GET  /api/oauth/xai/start-proxy ... -> popup OAuth dengan cookie akun -> manual-code
//  B. UI (fallback) — drive dashboard /dashboard/providers/grok-cli dengan Playwright.
//  C. API grok-cli (BARU, default) — Grok CLI / Grok Build DEVICE CODE:
//     GET  /api/oauth/grok-cli/device-code
//          -> { device_code, user_code, verification_uri_complete, codeVerifier, interval }
//     buka verification_uri_complete di browser dengan cookie akun -> klik Allow
//     POST /api/oauth/grok-cli/poll { deviceCode, codeVerifier } -> { success }
//
// Yang dimaksud "bypass" di flow: halaman OAuth/device x.ai dibuka dengan cookie/session akun
// yang BARU SAJA dibuat, jadi tidak perlu login manual — tinggal Continue -> Allow.
import { bukaBrowser, tutupBrowser } from "./browser.js";
import { tungguVerifyDanKlik } from "./cloudflare.js";
import { pollKodeVerifikasi } from "./tempmail.js";

export async function injectKe9Router({ config, akun, onLog = () => {} }) {
  const base = config.nineRouterBaseUrl || "http://127.0.0.1:20128";
  const mode = config.injectMode === "ui" ? "ui" : "api";
  // Provider target 9Router: "grok-cli" = Grok CLI (Grok Build, device-code) — DEFAULT.
  // "xai" = Grok Build OAuth lama (start-proxy). Atur lewat config.json -> injectProvider.
  const provider = config.injectProvider === "xai" ? "xai" : "grok-cli";

  // 0. Pastikan 9Router hidup
  try {
    const res = await fetch(`${base}/api/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    onLog(`🌐 9Router terhubung (${base}).`);
  } catch {
    onLog(`❌ 9Router tidak bisa diakses di ${base}. Jalankan 9Router dulu.`);
    return { status: "failed", error: `9Router unreachable: ${base}` };
  }

  if (mode === "api") {
    try {
      if (provider === "grok-cli") return await jalurGrokCli({ base, config, akun, onLog });
      return await jalurApi({ base, config, akun, onLog });
    } catch (e) {
      onLog(`⚠️  Jalur API gagal (${e.message}) — fallback ke jalur UI.`);
    }
  }
  try {
    return await jalurUi({ base, config, akun, onLog });
  } catch (e) {
    onLog(`❌ Inject gagal: ${e.message}`);
    return { status: "failed", error: e.message };
  }
}

// Login dashboard 9Router -> headers auth (dipakai semua jalur API).
async function login9Router(config, base, onLog) {
  let cookie = "";
  if (config.nineRouterPassword) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: config.nineRouterPassword }),
    });
    if (!res.ok) throw new Error(`Login 9Router gagal (HTTP ${res.status}). Cek nineRouterPassword di config.`);
    // undici tidak mengekspos set-cookie lewat headers.get() — pakai getSetCookie()
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    cookie = list.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("Login 9Router OK tapi tidak ada session cookie.");
    onLog("🔑 Login 9Router (password dari config).");
  } else if (config.nineRouterApiKey) {
    cookie = `x-api-key=${config.nineRouterApiKey}`;
    onLog("🔑 Login 9Router (API key dari config).");
  } else {
    onLog("ℹ️ Tidak ada nineRouterPassword/nineRouterApiKey di config — coba tanpa auth (dashboard mungkin tidak terkunci).");
  }
  return cookie ? { Cookie: cookie } : {};
}

// ── Jalur A: API 9Router langsung (xai lama) ────────────────────────

async function jalurApi({ base, config, akun, onLog }) {
  const h = await login9Router(config, base, onLog);

  // Flow persis dashboard 9Router v0.5.50:
  //   1) authorize dulu -> dapat state + codeVerifier
  //   2) start-proxy dengan state/code_verifier/redirect_uri -> { success, serverSide }
  //   3) buka authUrl dengan cookie akun -> klik Allow -> redirect ke 127.0.0.1:56121/callback
  //   4) serverSide=true -> poll-status; selain itu / manual-code fallback
  //   5) stop-proxy SELALU dijalankan (try/finally) biar port callback tidak bocor
  try {
    const APP_PORT = config.appPort || 56121;
    // redirect_uri xAI harus persis ini (IP, bukan localhost) — kalau beda, x.ai menolak.
    const callbackUrl = `http://127.0.0.1:${APP_PORT}/callback`;

    // 1. authorize
    const r2 = await get(base, `/api/oauth/xai/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`, h);
    if (!r2.authUrl) throw new Error(`authorize gagal: ${JSON.stringify(r2)}`);
    onLog(`🔐 Auth URL didapat (state=${r2.state?.slice(0, 8)}...).`);

    // 2. start-proxy (HARUS setelah authorize: pakai state + codeVerifier yang sama)
    const qs = new URLSearchParams({
      app_port: String(APP_PORT),
      state: r2.state,
      redirect_uri: callbackUrl,
    });
    if (r2.codeVerifier) qs.set("code_verifier", r2.codeVerifier);
    const r1 = await get(base, `/api/oauth/xai/start-proxy?${qs}`, h);
    if (!r1.success) {
      const alasan = r1.reason || r1.error || JSON.stringify(r1);
      if (/port_busy/i.test(alasan)) {
        throw new Error(`Port ${APP_PORT} dipakai proses lain — tutup proses itu lalu coba lagi. (${alasan})`);
      }
      throw new Error(`start-proxy gagal: ${alasan}`);
    }
    const serverSide = r1.serverSide === true;
    onLog(`🚀 Callback server aktif di ${callbackUrl} (serverSide=${serverSide}).`);

    // 3. buka authUrl dengan cookie akun -> Continue -> Allow
    const code = await selesaikanOAuthPopup({ config, akun, authUrl: r2.authUrl, onLog, serverSide });
    if (code) onLog(`🔑 Authorization code diterima: ${String(code).slice(0, 16)}...`);

    // 4. verifikasi koneksi terdaftar
    let ok = await cekKoneksiTerdaftar(base, akun, h);
    if (!ok && serverSide) {
      // Mode serverSide: 9Router yang menukar code via listener 56121 — cukup poll status.
      onLog("↻ Mode serverSide — poll status 9Router...");
      ok = await pollStatus(base, r2.state, h, onLog);
      if (!ok) ok = await cekKoneksiTerdaftar(base, akun, h);
    }
    if (!ok && code) {
      onLog("↻ Koneksi belum terlihat — kirim manual-code sebagai fallback.");
      try {
        await post(base, "/api/oauth/xai/manual-code", { code, state: r2.state, redirectUri: callbackUrl }, h);
        await sleep(700);
      } catch (e) {
        onLog(`⚠️  manual-code gagal (${e.message}) — menunggu callback proxy.`);
        await sleep(600);
      }
      ok = await cekKoneksiTerdaftar(base, akun, h);
    }

    if (!ok) throw new Error("Koneksi belum muncul di /api/providers setelah exchange.");
    onLog("✅ Device Authorized — koneksi grok-cli terdaftar di 9Router.");
    return { status: "injected" };
  } finally {
    // bersihkan proxy callback — SELALU dijalankan (sukses/gagal) biar port 56121 tidak nempel
    fetch(`${base}/api/oauth/xai/stop-proxy`, { headers: h }).catch(() => {});
  }
}

// Buka context + page untuk inject. PREFER context yang SUDAH ADA (persistent
// CDP) — akun baru saja signup di situ, jadi masih login; tidak perlu inject
// cookie. Context baru (incognito) sering gagal di sesi 2+ (halaman minta login
// ulang / tidak ada clearance Cloudflare dari profile). Fallback ke newContext +
// storage hanya kalau tidak ada context yang sedang login.
//
// PENTING (sesi 2+): JANGAN pakai halaman yang SUDAH ADA (halaman[0]). Halaman
// lama dari sesi sebelumnya bisa masih login sebagai AKUN LAMA (logout hanya
// dijalankan di satu halaman, bukan semua halaman di context) atau macet di
// halaman device-authorize sesi lalu. Buka halaman BARU di context yang sama:
// cookie session di-share antar halaman satu context, jadi halaman baru otomatis
// login sebagai akun yang baru saja signup — tanpa state lama yang mengganggu.
async function bukaContextInject(browser, akun, onLog) {
  // 1) context yang sedang login: buka halaman BARU di context itu
  //    Prioritas: context yang punya halaman accounts.x.ai (context signup) —
  //    kalau tidak ada, context mana pun dengan halaman x.ai/grok.com.
  const listContext = browser.contexts();
  const pilih = (ctx) =>
    ctx.pages().some((p) => /accounts\.x\.ai/i.test(p.url() || "")) ? 2 :
    ctx.pages().some((p) => /x\.ai|grok\.com/i.test(p.url() || "")) ? 1 : 0;
  const target = listContext
    .map((ctx, i) => ({ ctx, i, skor: pilih(ctx) }))
    .sort((a, b) => b.skor - a.skor || a.i - b.i)[0];
  if (target && target.skor > 0) {
    const page = await target.ctx.newPage();
    onLog(`🌐 Context login ditemukan (skor=${target.skor}) — buka halaman baru di context itu (cookie shared, tanpa state lama).`);
    return { context: target.ctx, page, fromExisting: true };
  }
  // 2) fallback: context baru + restore storage (cookies DAN localStorage)
  const context = await browser.newContext();
  if (akun.storage?.cookies?.length) {
    await context.addCookies(akun.storage.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.httpOnly ? { httpOnly: true } : {}),
      ...(c.secure ? { secure: true } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    })));
    // x.ai menyimpan session token di localStorage (bukan hanya cookie) — tanpa
    // ini context baru tidak dianggap login & halaman minta login ulang.
    if (akun.storage?.origins?.length) {
      await context.addInitScript((storage) => {
        const originData = (storage.origins || []).find((o) => location.origin === o.origin);
        if (originData) {
          for (const [k, v] of Object.entries(originData.localStorage || {})) {
            try { localStorage.setItem(k, v); } catch {}
          }
        }
      }, akun.storage);
    }
    onLog("🍪 Cookie + localStorage akun di-restore ke context baru (fallback).");
  } else {
    onLog("⚠️ Tidak ada storage akun tersimpan — halaman mungkin minta login manual.");
  }
  return { context, page: await context.newPage(), fromExisting: false };
}

// Buka halaman OAuth x.ai dengan session akun (cookie dari signup), lalu Continue -> Allow.
// `serverSide` = 9Router yang menukar code-nya sendiri -> kode dari URL tidak wajib.
async function selesaikanOAuthPopup({ config, akun, authUrl, onLog, serverSide = false }) {
  const { browser, cdp } = await bukaBrowser(config, onLog);
  try {
    const { context, page, fromExisting } = await bukaContextInject(browser, akun, onLog);
    let kode = null;

    // tangkap redirect ke callback 127.0.0.1:56121 (code di URL)
    page.on("framenavigated", (f) => {
      const u = f.url();
      if (u.includes("/callback") || u.startsWith("http://127.0.0.1:56121")) {
        const m = u.match(/[?&]code=([^&]+)/);
        if (m) kode = decodeURIComponent(m[1]);
      }
    });

    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    onLog("🌐 Halaman OAuth x.ai terbuka.");

    // login ulang kalau halaman minta (cookie kadang belum cukup)
    await loginUlangJikaPerlu(page, akun, config, onLog);

    // Challenge Cloudflare bisa menahan tombol Allow — TUNGGU muncul, klik otomatis.
    await tungguVerifyDanKlik(page, onLog, { timeoutMs: 15000 });

    // Pastikan halaman consent BENERAN muncul sebelum klik (sama seperti jalur
    // device-code): tunggu tombol Allow/Deny atau halaman sukses sampai terlihat.
    for (let i = 0; i < 8; i++) {
      if ((await adaTombolKonsen(page)) || TEKS_SUKSES.test(await page.locator("body").innerText({ timeout: 800 }).catch(() => ""))) break;
      await tungguVerifyDanKlik(page, onLog, { timeoutMs: 10000 });
      await sleep(600);
    }

    // x.ai kadang minta verifikasi identitas sebelum tombol Allow efektif — isi kode dulu
    await tanganiVerifyIdentitas(page, akun, config, onLog);

    // tombol Continue / Allow
    await klikAllow(page, onLog);
    await sleep(700);

    // Form "Verify your identity" bisa muncul SETELAH klik Allow — isi kode lalu
    // Allow lagi (sama seperti jalur device-code).
    if (!TEKS_SUKSES.test((await page.locator("body").innerText({ timeout: 800 }).catch(() => "")) || "")) {
      const tVerify = await tanganiVerifyIdentitas(page, akun, config, onLog);
      if (tVerify) {
        await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });
        await sleep(400);
        await klikAllow(page, onLog);
        await sleep(700);
      }
    }

    // tunggu code (callback proxy) atau redirect sukses
    const maxTunggu = serverSide ? 8 : 15;
    for (let i = 0; i < maxTunggu && !kode; i++) {
      await sleep(600);
      if (!kode) {
        const u = page.url();
        const m = u.match(/[?&]code=([^&]+)/);
        if (m) kode = decodeURIComponent(m[1]);
      }
    }
    // serverSide: kode ditangani 9Router, tidak wajib ada di URL browser
    if (!kode && !serverSide) {
      throw new Error("Tidak mendapat authorization code dari callback (mungkin butuh klik manual).");
    }
    return kode;
  } finally {
    await tutupBrowser(browser, cdp);
  }
}

// Deteksi halaman LOGIN x.ai (bukan consent): input email/password TERLIHAT, atau
// teks pemilih metode login ("Log into your account" / "Login with email").
// Dipakai bersama oleh klikAllow & selesaikanDeviceLoginInternal supaya tombol
// login TIDAK pernah diklik sebagai tombol consent (akar bug polling hang).
async function deteksiHalamanLogin(page) {
  try {
    const adaInput = await page
      .locator('input[type="email"], input[name="email"], input[type="password"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (adaInput) return true;
    const teks = (await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")) || "";
    return /log into your account|log in to your account|login with email|log in with email/i.test(teks);
  } catch {
    return false;
  }
}

// Tunggu URL halaman device x.ai "settle" setelah goto: redirect ke /consent
// (sesi valid) atau /sign-in (sesi tidak valid) sering terjadi SETELAH
// domcontentloaded. Tanpa ini bot bisa mengira halaman masih memuat, lalu klik
// tombol di halaman LOGIN seolah-olah consent — device code tak pernah di-approve.
// Return: "consent" | "signin" | null (URL belum jelas dalam batas waktu).
async function tungguSettleDevice(page, timeoutMs = 10000) {
  const tenggat = Date.now() + timeoutMs;
  while (Date.now() < tenggat) {
    const u = page.url();
    if (/\/consent/.test(u)) return "consent";
    if (/sign[-_]?in/.test(u)) return "signin";
    await sleep(400);
  }
  return null;
}

// Login ulang kalau halaman authorize/consent minta login (cookie akun kadang
// kedaluwarsa antara signup & inject). Alur x.ai: email -> password -> OTP.
// OTP di-poll dari tempmail (sama seperti signup) supaya inject tidak macet di
// tengah dan akun tidak "tidak authorized lalu sign out".
//
// Dua bentuk halaman login x.ai:
//  1) Form langsung (ada input email) — isi email.
//  2) Halaman pemilih metode login: teks "Log into your account" + tombol
//     "Login with email" (input email muncul SETELAH tombol itu diklik).
//     Deteksi teks ini PENTING — tanpa itu bot mengira sudah sampai consent,
//     klik "Continue" (yang sebenarnya tombol Login with email), dan device
//     code tidak pernah di-approve → polling hang (gejala yang terjadi).
async function loginUlangJikaPerlu(page, akun, config, onLog) {
  const inputEmail = page.locator('input[type="email"], input[name="email"]').first();
  if (!(await inputEmail.isVisible({ timeout: 4000 }).catch(() => false))) {
    // Halaman login versi pemilih metode? Cek teks + tombol "Login with email".
    const teks = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) || "";
    const tombolEmail = page
      .locator("button")
      .filter({ hasText: /login with email|log in with email|continue with email|sign in with email|lanjut dengan email/i })
      .first();
    if (!/log into your account|log in to your account|login with email|log in with email/i.test(teks)) return;
    if (!(await tombolEmail.isVisible({ timeout: 3000 }).catch(() => false))) return;
    onLog("👆 Halaman login pemilih metode — klik 'Login with email'.");
    await tombolEmail.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
    await sleep(700);
    if (!(await inputEmail.isVisible({ timeout: 6000 }).catch(() => false))) return;
  }

  onLog("ℹ️ Halaman minta login — mengisi email akun.");
  await inputEmail.fill(akun.email);
  const btn = page.locator("button").filter({ hasText: /continue|next|lanjut|log in|sign in/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
  await sleep(600);

  const inputPass = page.locator('input[type="password"]').first();
  if (await inputPass.isVisible({ timeout: 4000 }).catch(() => false)) {
    await inputPass.fill(akun.password || "");
    onLog("ℹ️ Password diisi (dari data akun).");
    const btn2 = page.locator("button").filter({ hasText: /continue|next|log in|sign in/i }).first();
    if (await btn2.isVisible({ timeout: 3000 }).catch(() => false)) await btn2.click();
    await sleep(700);
  }

  // Jika x.ai minta kode OTP setelah password — isi via helper bersama
  // (isiOtpVerifikasi). DETEKSI DIPERKUAT: form OTP bisa muncul TELAT (>5s)
  // setelah password dikirim — sebelumnya cek sekali 5s + selector sempit bikin
  // form tidak terdeteksi → login ulang dianggap selesai padahal belum →
  // authorize gagal diam-diam (akun tidak terautentikasi di 9Router).
  await isiOtpVerifikasi(page, akun, config, onLog, "login ulang");
}

// ── isi OTP / verifikasi identitas (dipakai login ulang & consent verify) ──
// Form OTP x.ai: satu input (maxlength=6) ATAU beberapa kotak (maxlength=1).
// Kode di-poll dari tempmail; retry sampai 2x; seenIds supaya tidak memakai
// kode basi (email konfirmasi SIGNUP lama masih ada di inbox).
// Return TRUE kalau kode terisi & form OTP hilang (verifikasi beres).
async function isiOtpVerifikasi(page, akun, config, onLog, konteks = "verifikasi") {
  // Selector LENGKAP (sama dengan signup.js — termasuk placeholder/aria-label)
  const selOtp =
    'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i], input[placeholder*="code" i], input[aria-label*="code" i]';
  // 1. TUNGGU form OTP muncul — bisa telat render (maks 10 detik). PENTING:
  //    JANGAN break berdasarkan URL — di halaman consent (/oauth2/device/consent)
  //    form "Verify your identity" justru render TELAT; break URL bikin loop putus
  //    di iterasi pertama dan OTP terlewat (bug yang mau diperbaiki). Cukup tunggu.
  let adaOtp = false;
  const tenggat = Date.now() + 10000;
  while (Date.now() < tenggat && !adaOtp) {
    adaOtp = await page.locator(selOtp).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (!adaOtp) await sleep(600);
  }
  if (!adaOtp) {
    onLog("ℹ️ Form OTP tidak muncul — lanjut (mungkin tidak butuh kode).");
    return false;
  }
  if (!config?.tempmailBaseUrl) {
    onLog("⚠️  tempmailBaseUrl kosong — tidak bisa polling OTP.");
    return false;
  }

  const seenOtpIds = new Set();
  let otpBeres = false;
  // Polling di perketat: 60s × 2 (dari 90s × 3). Untuk akun segar kode tiba dalam
  // ±30s; kalau inbox mati, makin cepat ketahuan & inject gagal tegas (bukan hang).
  for (let coba = 1; coba <= 2 && !otpBeres; coba++) {
    try {
      const { kode } = await pollKodeVerifikasi({
        baseUrl: config.tempmailBaseUrl,
        email: akun.email,
        timeoutMs: 60000,
        onLog,
        seenIds: seenOtpIds,
      });
      onLog(`🔢 Kode OTP (${konteks}, coba ${coba}/2): ${kode}`);
      const kodeBersih = String(kode || "").replace(/-/g, "");
      const otpInputs = page.locator(selOtp);
      const jml = await otpInputs.count().catch(() => 0);
      if (jml > 1 && kodeBersih.length === jml) {
        for (let j = 0; j < kodeBersih.length; j++) await otpInputs.nth(j).fill(kodeBersih[j]);
      } else {
        // satu input: isi versi tanpa strip (TYO-HEO -> TYOHEO), verifikasi nilai menempel
        const target = otpInputs.first();
        await target.fill(kodeBersih);
        let isi = (await target.inputValue().catch(() => "")).trim();
        if (isi !== kodeBersih) {
          await target.fill("");
          await target.pressSequentially(kodeBersih, { delay: 50 });
          isi = (await target.inputValue().catch(() => "")).trim();
        }
        onLog(`✍️ Kode OTP diisi (${isi}).`);
      }
      await sleep(700);
      // setelah OTP, x.ai sering minta konfirmasi — klik tombol verify/continue
      const btnOtp = page.getByRole("button", { name: /verify|confirm|continue|next|submit/i }).first();
      if (await btnOtp.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btnOtp.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
      }
      await sleep(700);
      // tanda sukses: form OTP hilang (halaman lanjut). Kalau masih ada + ada
      // pesan kode salah, poll kode BARU di percobaan berikutnya.
      const otpMasihAda = await page.locator(selOtp).first().isVisible({ timeout: 2000 }).catch(() => false);
      if (!otpMasihAda) {
        otpBeres = true;
        onLog("✔️ Verifikasi identitas selesai (form OTP hilang).");
      } else {
        const teks = await page.locator("body").innerText({ timeout: 800 }).catch(() => "");
        if (coba < 2) {
          onLog(
            /invalid|incorrect|expired|wrong|salah|tidak valid/i.test(teks)
              ? `⚠️  Kode OTP ditolak — ambil kode baru (${coba + 1}/2)...`
              : `↻ OTP belum diproses — coba kode baru (${coba + 1}/2)...`
          );
        }
      }
    } catch (e) {
      onLog(`⚠️  Gagal ambil OTP (${konteks}): ${e.message}`);
    }
  }
  return otpBeres;
}

// Deteksi halaman consent x.ai yang meminta verifikasi identitas ("Verify your
// identity") SEBELUM tombol Allow efektif, lalu isi kode OTP dari tempmail.
//
// PENTING (fix): teks "Verify your identity · Confirm your identity so the app
// can recognise you" di halaman consent adalah DESKRIPSI izin STATIS — selalu
// ada walaupun form OTP tidak muncul. Sebelumnya regex cocok dengan teks ini dan
// bot polling tempmail 90s×3 percuma (inbox mati → hang). Sekarang polling hanya
// dilakukan kalau form input OTP BENAR-BENAR terlihat (atau tombol verifikasi
// diklik & form muncul setelahnya).
// Return TRUE kalau kode berhasil diisi.
async function tanganiVerifyIdentitas(page, akun, config, onLog) {
  const selOtp =
    'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i], input[placeholder*="code" i], input[aria-label*="code" i]';

  // 1. Klik tombol "Verify your identity" kalau ada (beberapa UI menampilkan
  //    form OTP hanya setelah tombol ini diklik).
  const btnVerify = page
    .locator("button, [role=button]")
    .filter({ hasText: /verify your identity|verify it'?s you|confirm your identity|verify identity/i })
    .first();
  if (await btnVerify.isVisible({ timeout: 1500 }).catch(() => false)) {
    onLog("🛡️  Tombol 'Verify your identity' terlihat — klik untuk memunculkan form kode.");
    await btnVerify.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
    await sleep(600);
  }

  // 2. Form OTP beneran muncul? Tunggu maks ±12 detik (render bisa telat, terutama
  //    sesi pertama / profil browser dingin — 8 detik terlalu pendek dan bikin
  //    gate OTP terlewat → inject gagal palsu untuk akun segar).
  let adaOtp = false;
  const tenggat = Date.now() + 12000;
  while (Date.now() < tenggat && !adaOtp) {
    adaOtp = await page.locator(selOtp).first().isVisible({ timeout: 1500 }).catch(() => false);
    if (!adaOtp) await sleep(400);
  }
  if (!adaOtp) {
    onLog("ℹ️ Form kode verifikasi identitas tidak muncul — lewati (bukan gate aktif).");
    return false;
  }
  onLog("🛡️  Form verifikasi identitas ('Verify your identity') muncul — isi kode dari tempmail.");
  return await isiOtpVerifikasi(page, akun, config, onLog, "verify identity");
}

// Selector tombol Allow/Continue/Authorize (x.ai & dashboard 9Router beragam).
// Dipakai bersama oleh cekTombolKonsen & klikAllow supaya tidak dobel/selisih.
const SEL_ALLOW = [
  'button:has-text("allow")',
  'button:has-text("authorize")',
  'button:has-text("continue")',
  'button:has-text("izinkan")',
  'button:has-text("setujui")',
  'button:has-text("beri akses")',
  'input[type="submit"][value*="allow" i]',
  'input[type="submit"][value*="authorize" i]',
  'input[type="submit"][value*="continue" i]',
  '[role="button"]:has-text("allow")',
  '[role="button"]:has-text("authorize")',
  '[role="button"]:has-text("continue")',
  'a[href*="authorize"]',
].join(", ");

// Regex frasa sukses yang SPESIFIK (hindari kata generik yang bisa muncul di
// halaman lain dan bikin klikAllow "menyerah" sebelum tombol Allow sempat muncul).
const TEKS_SUKSES = /device authorized|authorized successfully|signed in successfully|berhasil terhubung|berhasil disambungkan/i;

// Apakah ada tombol Allow/Deny/Authorize yang TERLIHAT di halaman?
// Iterasi SEMUA elemen yang cocok (JANGAN .first() — elemen tersembunyi yang
// match lebih dulu di DOM bikin .first() false-negative terus).
async function adaTombolKonsen(page) {
  const loc = page.locator(SEL_ALLOW);
  const jumlah = await loc.count().catch(() => 0);
  for (let j = 0; j < jumlah; j++) {
    if (await loc.nth(j).isVisible({ timeout: 500 }).catch(() => false)) return true;
  }
  return false;
}

// Klik tombol Allow/Continue/Authorize di halaman consent OAuth x.ai
// (device-code / popup authorize). Return TRUE kalau tombol berhasil diklik
// ATAU halaman sudah menampilkan "Device Authorized".
//
// Robust terhadap masalah umum yang bikin inject "dilewati":
//  - Iterasi SEMUA elemen yang cocok, klik yang pertama TERLIHAT — JANGAN .first()
//    (elemen tersembunyi yang match lebih dulu di DOM bikin .first() gagal terus,
//    sehingga tombol Allow asli tidak pernah diklik).
//  - Jangan pernah klik tombol Deny/Decline/Tolak (termasuk negasi Inggris
//    "Don't allow" / "Do not allow").
//  - Fallback force-click kalau tombol tertutup elemen lain.
async function klikAllow(page, onLog) {
  // PENGAMAN UTAMA: JANGAN pernah klik apa pun di halaman LOGIN (input
  // email/password atau pemilih metode). Klik di sana TIDAK meng-approve device
  // code — hanya bikin diklik=true palsu → polling hang 30 menit. Kalau halaman
  // ternyata login, return false (pemanggil yang login ulang).
  if (await deteksiHalamanLogin(page)) {
    onLog("ℹ️ Halaman masih login (bukan consent) — tombol Allow TIDAK diklik.");
    return false;
  }
  // Maks 5 iterasi cek cepat (tanpa jeda panjang) — tombol Allow biasanya sudah
  // ada sejak halaman consent terdeteksi; nunggu lebih lama jarang menolong.
  for (let i = 0; i < 5; i++) {
    // Coba klik semua tombol yang cocok — pilih yang pertama TERLIHAT.
    const loc = page.locator(SEL_ALLOW);
    const jumlah = await loc.count().catch(() => 0);
    for (let j = 0; j < jumlah; j++) {
      const el = loc.nth(j);
      if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
      const teksEl = ((await el.innerText().catch(() => "")) || "").trim().toLowerCase();
      // tolak tombol penolakan (Deny/Decline/Tolak + negasi Inggris) — jangan pernah diklik
      if (
        /deny|decline|reject|tolak|jangan|don'?t allow|do not allow|not allow/i.test(teksEl) &&
        !/allow|authorize|continue/i.test(teksEl)
      ) {
        continue;
      }
      // PENTING: kalau halaman ternyata FORM LOGIN (ada input email/password),
      // tombol "Continue"/"Next" di situ adalah tombol LOGIN, bukan consent.
      // Klik itu tidak akan meng-approve device code → authorize gagal diam-diam.
      // Tombol yang aman diklik: allow/authorize/izinkan/setujui/beri akses.
      const formLogin = await page
        .locator('input[type="email"], input[name="email"], input[type="password"]')
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false);
      if (formLogin && /continue|next|lanjut|log in|sign in/i.test(teksEl) && !/allow|authorize|izinkan|setujui/i.test(teksEl)) {
        continue; // ini tombol login, bukan consent — SKIP
      }

      // Tombol disabled (menunggu Turnstile / verifikasi identitas selesai) TIDAK
      // boleh di-force-click — klik tidak mempan dan hanya bikin diklik=true palsu.
      const enabled = await el.isEnabled({ timeout: 400 }).catch(() => true);
      let ok = false;
      if (enabled) {
        ok = await el.click({ timeout: 4000, noWaitAfter: true }).then(() => true).catch(() => false);
        if (!ok) {
          // tombol tertutup elemen lain / posisi aneh — coba force click
          ok = await el.click({ timeout: 3000, force: true, noWaitAfter: true }).then(() => true).catch(() => false);
        }
      }
      if (ok) {
        // verifikasi singkat: halaman berpindah / tombol hilang / teks sukses muncul?
        // Kalau tidak (klik mungkin tidak mempan), jangan langsung menyerah — lanjut
        // iterasi berikutnya supaya sempat coba lagi / cek halaman sukses di bawah.
        const teks = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
        if (TEKS_SUKSES.test(teks) || !(await adaTombolKonsen(page))) {
          onLog("👆 Klik Allow/Continue di halaman authorize.");
          return true;
        }
        onLog("👆 Klik Allow/Continue dikirim (menunggu konfirmasi halaman)...");
        await sleep(600);
      }
    }

    // Tidak ada tombol Allow terlihat: cek apakah halaman sudah berubah jadi
    // "Device Authorized" (auto-approve / sudah diklik sebelumnya).
    const teks = await page.locator("body").innerText({ timeout: 800 }).catch(() => "");
    if (TEKS_SUKSES.test(teks) && !(await adaTombolKonsen(page))) {
      onLog("✅ Halaman device authorized terdeteksi.");
      return true;
    }

    // Tombol belum muncul — halaman masih memuat / ada challenge Cloudflare.
    await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });
    await sleep(300);
  }
  const teksAkhir = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) || "";
  onLog("ℹ️ Tombol Allow tidak ketemu — mungkin sudah auto-approve.");
  onLog(`🔍 DIAGNOSTIK Allow: URL=${page.url()} | teks=${teksAkhir.slice(0, 300).replace(/\n+/g, " · ")}`);
  return false;
}

async function cekKoneksiTerdaftar(base, akun, h) {
  const lokal = (akun.email || "").split("@")[0].toLowerCase();
  const nama = (akun.nama || "").toLowerCase();
  for (let i = 0; i < 8; i++) {
    try {
      const r = await get(base, "/api/providers", h);
      const list = r.connections || r.providers || (Array.isArray(r) ? r : []);
      const blob = JSON.stringify(r).toLowerCase();
      // cocokkan local-part email di mana pun di respons ATAU displayName == nama akun
      if (blob.includes(lokal)) return true;
      if (nama && list.some((c) => (c.displayName || "").toLowerCase() === nama)) return true;
    } catch {}
    await sleep(700);
  }
  return false;
}

// Poll status OAuth serverSide (9Router yang menukar code-nya sendiri).
async function pollStatus(base, state, h, onLog = () => {}) {
  for (let i = 0; i < 25; i++) {
    try {
      const r = await get(base, `/api/oauth/xai/poll-status?state=${encodeURIComponent(state)}`, h);
      if (r.success || r.connected || r.connectionId) return true;
    } catch {}
    if (i % 5 === 4) onLog(`   poll-status masih menunggu (${i + 1}/25)...`);
    await sleep(700);
  }
  return false;
}

// ── Jalur C: Grok CLI / Grok Build (device-code flow) ───────────────
// Provider "grok-cli" (alias "grok-build") memakai device-code, BUKAN start-proxy:
//   GET  /api/oauth/grok-cli/device-code
//        -> { device_code, user_code, verification_uri_complete, codeVerifier, interval }
//   buka verification_uri_complete di browser dengan cookie akun -> klik Allow
//   POST /api/oauth/grok-cli/poll { deviceCode, codeVerifier } -> { success }
async function jalurGrokCli({ base, config, akun, onLog }) {
  const h = await login9Router(config, base, onLog);

  // 1. minta device code dari 9Router
  const dc = await get(base, "/api/oauth/grok-cli/device-code", h);
  if (!dc.device_code || !dc.codeVerifier) {
    throw new Error(`device-code gagal: ${JSON.stringify(dc)}`);
  }
  onLog(`📟 Device code: ${dc.user_code} — authorize di: ${dc.verification_uri_complete}`);

  // 2. buka halaman device-authorize dengan cookie akun -> Continue/Allow
  const { diklik, error: authorizeError } = await selesaikanDeviceLogin({ config, akun, url: dc.verification_uri_complete, onLog });
  if (!diklik) {
    // Tombol Allow tidak otomatis diklik — kasih tahu user biar bisa authorize manual
    // selagi poll masih berjalan di bawah (device code berlaku sampai expires_in).
    onLog("ℹ️ Tombol Allow tidak otomatis diklik di browser.");
    if (authorizeError) onLog(`   Alasan: ${authorizeError.message}`);
    onLog(`   Buka manual kalau perlu: ${dc.verification_uri_complete}`);
  }

  // 3. poll sampai user meng-approve (9Router yang menukar device code -> token)
  // Log penanda: kalau baris "⏳ Memulai polling" tidak muncul, berarti error terjadi
  // SEBELUM polling (device-code / buka browser) — bukan di halaman authorize.
  onLog("⏳ Memulai polling device-code (tunggu authorize di browser)...");
  const intervalMs = Math.min(3000, (dc.interval || 5) * 1000);
  const maxPoll = Math.min(120, Math.ceil((dc.expires_in || 1800) / (dc.interval || 5)));
  // Kalau tombol Allow TIDAK otomatis diklik (diklik=false), jangan polling sampai
  // 30 menit (expires_in) — itu bikin proses kelihatan HANG & user Ctrl+C → akun
  // tercatat signed_up tanpa error. Poll sebentar (maks ±60 detik, dihitung dari
  // interval asli supaya konsisten) untuk kasih kesempatan user authorize manual,
  // lalu GAGAL TEGAS dengan pesan jelas (loop luar grok_farm.js retry inject).
  const maxPollAktif = diklik ? maxPoll : Math.max(1, Math.min(maxPoll, Math.floor(60000 / intervalMs)));
  for (let i = 0; i < maxPollAktif; i++) {
    const p = await post(base, "/api/oauth/grok-cli/poll", {
      deviceCode: dc.device_code,
      codeVerifier: dc.codeVerifier,
    }, h);
    if (p.success) {
      onLog("✅ Device Authorized — koneksi Grok CLI (Grok Build) terdaftar di 9Router.");
      // verifikasi koneksi benar-benar muncul di /api/providers
      const ok = await cekKoneksiTerdaftar(base, akun, h);
      if (!ok) throw new Error("Poll sukses tapi koneksi belum muncul di /api/providers.");
      return { status: "injected" };
    }
    if (p.error === "expired_token" || p.error === "access_denied") {
      throw new Error(`Device login ditolak: ${p.errorDescription || p.error}`);
    }
    if (i % 6 === 0) onLog(`⏳ Menunggu authorize di browser (${Math.round((i * intervalMs) / 1000)}s)...`);
    await sleep(intervalMs);
  }
  if (!diklik) {
    const alasan = authorizeError
      ? ` (${authorizeError.message})`
      : " (mungkin minta login ulang)";
    throw new Error(
      "Tombol Allow tidak otomatis diklik & authorize manual tidak terdeteksi dalam ±60s" +
      alasan + ". Buka manual kalau mau: " + dc.verification_uri_complete
    );
  }
  throw new Error(`Timeout menunggu device authorize (${dc.expires_in || 1800}s).`);
}

// Buka halaman device-authorize x.ai (verification_uri_complete) dengan session akun
// (cookie dari signup) lalu klik Continue/Allow — sama "bypass"-nya seperti popup OAuth.
async function selesaikanDeviceLogin({ config, akun, url, onLog }) {
  const { browser, cdp } = await bukaBrowser(config, onLog);
  let diklik = false;
  let error = null;
  try {
    try {
      await selesaikanDeviceLoginInternal({ browser, config, akun, url, onLog, setDiklik: (v) => { diklik = v; } });
    } catch (e) {
      // PENTING: JANGAN lempar error ke atas — kalau authorize gagal (mis. halaman
      // lambat/Cloudflare), device code masih VALID dan loop polling di jalurGrokCli
      // HARUS tetap jalan supaya user bisa authorize manual & ada error tegas di akhir.
      // Error dicatat & diteruskan ke pemanggil biar pesan gagal akhirnya jelas.
      error = e;
      onLog(`⚠️  Authorize gagal di browser (${e.message}) — polling tetap jalan untuk authorize manual.`);
    }
  } finally {
    await tutupBrowser(browser, cdp);
  }
  return { diklik, error };
}

async function selesaikanDeviceLoginInternal({ browser, config, akun, url, onLog, setDiklik }) {
  {
    const { context, page } = await bukaContextInject(browser, akun, onLog);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    onLog("🌐 Halaman device-authorize x.ai terbuka.");

    // KUNCI PERBAIKAN: x.ai me-redirect /oauth2/device -> /sign-in KALAU session
    // akun tidak valid (redirect bisa terjadi SETELAH domcontentloaded). Tunggu
    // URL settle dulu: /consent = sesi valid, /sign-in = sesi invalid. Kalau
    // tidak, bot bisa mengira halaman masih memuat lalu klik tombol di halaman
    // LOGIN seolah-olah consent — device code tak pernah di-approve (gejala
    // polling hang 30 menit di log inject-final/diag).
    let mode = await tungguSettleDevice(page, 10000);
    if (mode === "signin") {
      onLog("ℹ️ Device page redirect ke sign-in — session akun tidak valid, login ulang dulu.");
      await loginUlangJikaPerlu(page, akun, config, onLog);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      onLog("🌐 Halaman device-authorize dibuka ulang setelah login.");
      mode = await tungguSettleDevice(page, 8000);
      if (mode === "signin") {
        throw new Error(
          "Login ulang akun tidak selesai — halaman masih minta login (kode verifikasi tempmail " +
          "kemungkinan tidak tiba / inbox sudah mati). Cek manual: " + url
        );
      }
    }

    // login ulang kalau halaman minta (cookie kadang belum cukup)
    await loginUlangJikaPerlu(page, akun, config, onLog);

    // Jaring pengaman sesi: kalau halaman authorize menampilkan sesi AKUN LAMA
    // (sisa sesi sebelumnya yang masih login — halaman lama tidak di-logout),
    // device code ini malah akan authorize akun yang salah. Deteksi: cari pola
    // EMAIL di teks halaman — kalau ada email yang BUKAN akun ini → logout &
    // login ulang. Kalau tidak ada email di halaman, anggap sesi benar (hindari
    // false positive yang bikin logout sia-sia).
    const teksHalaman = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) || "";
    const emailTarget = (akun.email || "").toLowerCase();
    const emailDiHalaman = teksHalaman.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
    const sesiSalah = emailDiHalaman.length > 0 &&
      !emailDiHalaman.some((e) => e.toLowerCase() === emailTarget);
    if (sesiSalah) {
      onLog("ℹ️ Sesi akun lama terdeteksi di halaman authorize — logout lalu authorize sebagai akun ini.");
      await page.goto("https://accounts.x.ai/sign-out?redirect=grok-com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {});
      await sleep(500);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      onLog("🌐 Halaman device-authorize dibuka ulang (sesi bersih).");
      await loginUlangJikaPerlu(page, akun, config, onLog);
    }

    // TUNGGU halaman settle: tombol consent ATAU form login — jangan langsung
    // klik. Kalau session akun tidak valid (cookie di context baru tidak cukup),
    // halaman device x.ai menampilkan form LOGIN, bukan halaman consent. Kalau
    // bot langsung klik "Continue" di form login itu, authorize tidak pernah jadi
    // (device code tak di-approve) dan polling hang — persis gejala yang terjadi.
    const halamanLogin = () => deteksiHalamanLogin(page);
    for (let i = 0; i < 6; i++) {
      const adaConsent = await adaTombolKonsen(page);
      const login = await halamanLogin();
      if (adaConsent || login) break;
      await tungguVerifyDanKlik(page, onLog, { timeoutMs: 4000 });
      await sleep(400);
    }
    // Kalau yang muncul halaman LOGIN (form atau pemilih metode) — login ulang
    // dulu (email+pass+OTP), lalu buka URL device lagi supaya halaman consent
    // benar-benar muncul. Tanpa ini, klik "Continue" kena tombol Login with
    // email → device code tidak pernah di-approve → polling hang.
    const masihLogin = await halamanLogin();
    if (masihLogin && !(await adaTombolKonsen(page))) {
      onLog("ℹ️ Halaman authorize ternyata halaman login — login ulang akun dulu.");
      await loginUlangJikaPerlu(page, akun, config, onLog);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      onLog("🌐 Halaman device-authorize dibuka ulang setelah login.");
      await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });
      for (let i = 0; i < 4; i++) {
        if (await adaTombolKonsen(page)) break;
        await sleep(400);
      }
      // FAIL FAST: login ulang tidak menyelesaikan apa-apa (kemungkinan besar
      // kode OTP ke tempmail sudah tidak bisa tiba — inbox mati/expired). Jangan
      // lanjut klik & polling 30 menit — lempar error tegas biar inject gagal
      // cepat dan loop luar (grok_farm.js) tidak retry sia-sia.
      if ((await halamanLogin()) && !(await adaTombolKonsen(page))) {
        throw new Error(
          "Login ulang akun tidak selesai — halaman masih minta login (OTP ke tempmail " +
          "kemungkinan tidak tiba / inbox sudah mati). " + url
        );
      }
    }

    // tombol Continue / Allow — kalau berhasil diklik, authorize biasanya langsung jadi
    // PAKAI return value klikAllow langsung (bukan closure) — Internal adalah fungsi
    // top-level, `diklik` dari wrapper TIDAK terlihat di sini (ReferenceError).
    let klik = await klikAllow(page, onLog);
    await sleep(700); // beri waktu halaman memproses klik

    // x.ai kadang minta verifikasi identitas (OTP) sebelum Allow efektif —
    // halaman consent menampilkan "Verify your identity". Isi kode, lalu Allow lagi.
    if (!TEKS_SUKSES.test((await page.locator("body").innerText({ timeout: 800 }).catch(() => "")) || "")) {
      const tVerify = await tanganiVerifyIdentitas(page, akun, config, onLog);
      if (tVerify) {
        await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });
        await sleep(400);
        klik = await klikAllow(page, onLog);
        await sleep(700);
      }
    }

    // PENGAMAN UTAMA: kalau klik "Allow/Continue" malah membawa ke halaman LOGIN
    // (URL /sign-in atau teks "Log into your account"), itu artinya session cookie
    // akun TIDAK valid di halaman device — x.ai redirect karena tidak login.
    // Device code tidak akan pernah di-approve kalau kita biarkan. Login ulang
    // penuh (pilih metode email → email → password → OTP), buka ulang URL device,
    // lalu klik Allow SEKALI LAGI.
    const urlSetelahKlik = page.url();
    const teksSetelahKlik = (await page.locator("body").innerText({ timeout: 1200 }).catch(() => "")) || "";
    const loginSetelahKlik = await page
      .locator('input[type="email"], input[name="email"], input[type="password"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    const terjebakLogin = loginSetelahKlik ||
      /sign[-_]?in|log into your account|log in to your account|login with email|log in with email/i.test(
        urlSetelahKlik + " " + teksSetelahKlik
      );
    if (terjebakLogin && !TEKS_SUKSES.test(teksSetelahKlik)) {
      onLog(`⚠️  Klik membawa ke halaman login (URL=${urlSetelahKlik.slice(0, 80)}) — session akun tidak valid.`);
      onLog("   Login ulang akun, lalu coba authorize lagi...");
      await loginUlangJikaPerlu(page, akun, config, onLog);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      onLog("🌐 Halaman device-authorize dibuka ulang setelah login ulang.");
      await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });
      for (let i = 0; i < 4; i++) {
        if (await adaTombolKonsen(page)) break;
        await sleep(400);
      }
      // FAIL FAST kalau login ulang tetap tidak membawa ke consent (inbox tempmail
      // mati → OTP tidak tiba → authorize mustahil). Jangan polling 30 menit.
      if ((await halamanLogin()) && !(await adaTombolKonsen(page))) {
        throw new Error(
          "Login ulang akun tidak selesai — halaman masih minta login (OTP ke tempmail " +
          "kemungkinan tidak tiba / inbox sudah mati). " + url
        );
      }
      klik = await klikAllow(page, onLog);
      await sleep(700);
    }

    // Klik authorize kadang tidak mempan kalau tombol masih disabled (menunggu
    // verifikasi identitas / Turnstile selesai). Kalau URL MASIH /consent setelah
    // klik, coba lagi sampai 3x: tunggu challenge, klik ulang, cek URL.
    // CATATAN: verifikasi identitas (OTP) TIDAK diulang di sini — sudah ditangani
    // sekali di atas (pre-loop). Kalau OTP gagal, coba ulang cuma buang waktu
    // (polling tempmail 60s×2 per percobaan).
    for (let coba = 0; coba < 3; coba++) {
      const u = page.url();
      if (!/\/consent/.test(u) || TEKS_SUKSES.test((await page.locator("body").innerText({ timeout: 800 }).catch(() => "")) || "")) break;
      onLog(`↻ URL masih /consent (percobaan ${coba + 1}/3) — cek challenge & klik ulang...`);
      await tungguVerifyDanKlik(page, onLog, { timeoutMs: 8000 });
      await sleep(500);
      klik = await klikAllow(page, onLog);
      await sleep(600);
      // Kalau klik tidak mengubah apa-apa (URL masih /consent & tanpa teks sukses)
      // di percobaan kedua, jangan teruskan — set diklik=false supaya polling di
      // jalurGrokCli cepat gagal dengan pesan jelas (bukan hang).
      if (coba >= 1 && /\/consent/.test(page.url()) && !TEKS_SUKSES.test((await page.locator("body").innerText({ timeout: 800 }).catch(() => "")) || "")) {
        klik = false;
        break;
      }
    }

    setDiklik(klik);
    // DIAGNOSTIK SELALU: log URL + isi halaman SETELAH klik, sukses maupun gagal.
    const urlFinal = page.url();
    const teksFinal = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) || "";
    const loginFinal = await page
      .locator('input[type="email"], input[name="email"], input[type="password"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    onLog(`🔍 DIAGNOSTIK authorize: URL=${urlFinal}`);
    onLog(`🔍 DIAGNOSTIK authorize: mintaLogin=${loginFinal}`);
    onLog(`🔍 DIAGNOSTIK authorize: teks=${teksFinal.slice(0, 300).replace(/\n+/g, " · ")}`);
    // Dump tombol yang terlihat di halaman consent (biar kelihatan tombol mana
    // yang masih menghalangi / disabled).
    const dumpBtn = await page
      .evaluate(() => {
        const out = [];
        document.querySelectorAll("button, [role=button], input[type=submit]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            out.push({
              teks: (el.innerText || el.value || "").trim().slice(0, 40),
              disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
            });
          }
        });
        return out;
      })
      .catch(() => []);
    onLog(`🔍 BUTTON di halaman: ${JSON.stringify(dumpBtn.slice(0, 8))}`);

    // FAIL FAST tegas: URL masih /consent, tombol Allow tidak bisa diklik, dan
    // tidak ada tanda sukses. Paling sering karena gate "Verify your identity"
    // (OTP) tidak bisa diisi — kode tidak tiba di tempmail (inbox mati/expired).
    // Lempar error biar authorizeError diteruskan ke polling (diklik=false →
    // poll ±60s utk authorize manual, lalu gagal jelas) DAN pattern di
    // grok_farm.js bisa skip retry yang sia-sia.
    if (!klik && /\/consent/.test(page.url()) && !TEKS_SUKSES.test(teksFinal)) {
      throw new Error(
        "Halaman consent tidak selesai — form OTP verifikasi identitas tidak bisa diisi " +
        "(kode tidak tiba di tempmail / inbox mati)."
      );
    }
  }
}

// ── Jalur B: drive UI dashboard 9Router ─────────────────────────────

async function jalurUi({ base, config, akun, onLog }) {
  const { browser, cdp } = await bukaBrowser(config, onLog);
  try {
    const context = await browser.newContext();
    if (akun.storage?.cookies?.length) {
      await context.addCookies(akun.storage.cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
        ...(c.httpOnly ? { httpOnly: true } : {}),
        ...(c.secure ? { secure: true } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      })));
    }
    const page = await context.newPage();

    // login dashboard
    await page.goto(`${base}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(600);
    const inputPass = page.locator('input[type="password"]').first();
    if (await inputPass.isVisible({ timeout: 4000 }).catch(() => false)) {
      if (!config.nineRouterPassword) throw new Error("Dashboard 9Router terkunci tapi nineRouterPassword kosong.");
      await inputPass.fill(config.nineRouterPassword);
      const btn = page.locator("button").filter({ hasText: /login|log in|masuk|unlock/i }).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
      await sleep(700);
      onLog("🔑 Login dashboard 9Router.");
    }

    // buka halaman provider sesuai config (grok-cli default, xai opsional)
    const providerId = config.injectProvider === "xai" ? "xai" : "grok-cli";
    await page.goto(`${base}/dashboard/providers/${providerId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(700);
    onLog(`📄 Halaman /dashboard/providers/${providerId} terbuka.`);

    // klik Add
    const btnAdd = page.getByRole("button", { name: /add|tambah/i }).first();
    if (await btnAdd.isVisible({ timeout: 6000 }).catch(() => false)) {
      await btnAdd.click();
      onLog("👆 Klik Add.");
      await sleep(500);
    } else {
      onLog("ℹ️ Tombol Add tidak ketemu — cek apakah provider grok-cli ada di halaman.");
    }

    // popup OAuth (target=_blank) ATAU tab baru di context yang sama — tangkap keduanya
    let popup = null;
    const p = new Promise((resolve) => {
      context.on("page", (pg) => { popup = popup || pg; resolve(); });
      page.once("popup", (pp) => { popup = popup || pp; resolve(); });
      setTimeout(resolve, 10000);
    });
    await page.locator("a[target=_blank], button").filter({ hasText: /oauth|authorize|connect/i }).first().click({ timeout: 5000 }).catch(() => {});
    await p;
    popup = popup || null;

    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      onLog("🪟 Popup OAuth x.ai terbuka.");
      await loginUlangJikaPerlu(popup, akun, config, onLog);
      await tungguVerifyDanKlik(popup, onLog, { timeoutMs: 12000 });
      await tanganiVerifyIdentitas(popup, akun, config, onLog);
      await klikAllow(popup, onLog);
      // tunggu popup menutup / sukses
      for (let i = 0; i < 12; i++) {
        if (popup.isClosed()) break;
        await sleep(600);
      }
    } else {
      onLog("ℹ️ Popup tidak terdeteksi otomatis — periksa tab baru di browser.");
    }

    await sleep(500);
    const teks = await page.locator("body").innerText().catch(() => "");
    if (/device authorized|success|berhasil/i.test(teks)) {
      onLog("✅ Device Authorized terdeteksi di dashboard.");
      return { status: "injected" };
    }
    // fallback: cek via API
    const ok = await cekKoneksiTerdaftar(base, akun, {});
    if (ok) return { status: "injected" };
    throw new Error("Tidak terdeteksi device authorized setelah Add.");
  } finally {
    await tutupBrowser(browser, cdp);
  }
}

// ── helper HTTP ─────────────────────────────────────────────────────

const get = async (base, path, headers) => {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
};

const post = async (base, path, body, headers) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
