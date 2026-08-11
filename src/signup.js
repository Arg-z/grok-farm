// signup.js — SIGNUP phase: daftar akun xAI otomatis
// Alur: create tempmail -> buka signup -> isi email -> ambil OTP -> isi nama+password
//       -> solve Turnstile (jika useSolver) -> complete -> status: signed_up
import { pollKodeVerifikasi, generateEmail } from "./tempmail.js";
import { solveTurnstileDiHalaman } from "./solver.js";
import { tanganiCloudflare, tungguVerifyDanKlik, cekWidgetSolved, klikTurnstileByKoordinat, klikVerifikasiCloudflare } from "./cloudflare.js";
import { bukaBrowser, tutupBrowser } from "./browser.js";
import { rekamTurnstile } from "./rekam.js";

export async function signupAkun({ config, onLog = () => {}, contextBaru = false, noPause = false }) {
  if (noPause) noPauseGlobal = true; // mode bulk: semua PAUSE di sesi ini auto-lanjut
  const email = await generateEmail(config.tempmailBaseUrl, config.domain);
  const password = buatPassword(config.passwordPanjang);
  const nama = `${pilih(config.namaDepan)} ${pilih(config.namaBelakang)}`;
  onLog(`🎯 Email: ${email}`);
  onLog(`👤 Nama: ${nama}`);

  let browser;
  let cdp = false;
  let context = null;
  try {
    const b = await bukaBrowser(config, onLog);
    browser = b.browser;
    cdp = b.cdp;

    // MODE PARALEL (bulk): pakai context incognito BARU per worker — terisolasi,
    // tidak saling ganggu antar worker, tidak perlu logout (context baru bersih).
    // MODE SEKUENSIAL (default): pakai halaman/context yang SUDAH ADA (biar bot
    // bekerja di halaman yang sama dengan yang dilihat user).
    let page;
    if (contextBaru) {
      context = await browser.newContext();
      page = await context.newPage();
      onLog("🌐 Context baru dibuat (mode paralel — worker terisolasi).");
    } else {
      const contexts = browser.contexts();
      context = contexts[0] || (await browser.newContext());
      page = null;
      for (const p of context.pages()) {
        if (p.url().includes("accounts.x.ai")) { page = p; break; }
      }
      if (!page) page = await context.newPage();
      onLog("🌐 Memakai halaman yang sudah terbuka (hindari halaman ganda).");

      // Sesi BARU: logout akun sesi sebelumnya kalau masih login (browser CDP tetap
      // hidup antar akun, jadi halaman bisa masih login sebagai akun lama).
      await logoutDariXai(page, onLog);
    }

    await bukaSignupDenganRetry(page, config.signupUrl, onLog);
    tutupCookieBanner(page, onLog).catch(() => {});

    // ── 1. isi email ────────────────────────────────────────────────
    await isiEmail(page, email, onLog);

    // Challenge Cloudflare bisa muncul SETELAH submit email (widget turnstile
    // render belakangan di form OTP) — TUNGGU sampai "verify you are human"
    // muncul, klik otomatis, baru lanjut. 20s supaya widget yang render lambat
    // (sesi pertama, profil browser dingin) tetap ketangkap.
    await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });

    // ── 2. OTP: x.ai langsung minta kode setelah email (form code muncul),
    //    jadi ambil kode dari tempmail lalu isi; retry kalau ditolak ──
    const seenOtpIds = new Set();
    let otpBeres = false;
    for (let coba = 1; coba <= 3 && !otpBeres; coba++) {
      onLog(`⏳ Menunggu kode verifikasi di tempmail (coba ${coba}/3)...`);
      const { kode } = await pollKodeVerifikasi({
        baseUrl: config.tempmailBaseUrl,
        email,
        timeoutMs: coba === 1 ? config.pollTimeoutMs : 60000,
        onLog,
        seenIds: seenOtpIds,
      });
      onLog(`🔢 Kode OTP: ${kode}`);
      await isiOtp(page, kode, onLog);
      if (!(await adaErrorOtp(page))) {
        otpBeres = true;
      } else {
        onLog(`⚠️  Kode ditolak x.ai — coba kode baru...`);
      }
    }
    if (!otpBeres) {
      onLog("🧍 PAUSE — masukkan kode OTP terakhir secara manual di jendela browser, lalu Enter di terminal.");
      await tungguEnter(PAUSE_TIMEOUT_S);
    }

    // ── 3. form NAMA + PASSWORD muncul setelah email terkonfirmasi ──
    // TUNGGU challenge yang mungkin menahan transisi ke form nama/password
    // (widget render belakangan), klik otomatis, baru lanjut isi form.
    await tungguVerifyDanKlik(page, onLog, { timeoutMs: 5000 });

    let formTerisi = await isiNamaPassword(page, nama, password, onLog);
    if (!formTerisi) {
      // Beri kesempatan terakhir: user isi manual, lalu Enter.
      onLog("🧍 PAUSE — form belum terisi otomatis. Isi manual (First name / Last name / Password)");
      onLog("   di jendela browser, lalu tekan Enter di terminal ini.");
      await tungguEnter(PAUSE_TIMEOUT_S);
      formTerisi = await isiNamaPassword(page, nama, password, onLog, true);
    }
    if (!formTerisi) {
      // Jangan lapor signed_up palsu — lebih baik gagal & retry.
      throw new Error("Form nama/password tidak bisa diisi otomatis/manual — periksa halaman x.ai.");
    }

    // ── 3b+4. solve Turnstile: SOLVER DULU (Eksternal: EzSolver lokal/CapSolver),
    //    baru fallback klik otomatis. ──
    // Mengapa solver DULU: widget Turnstile x.ai = mode MANAGED/INVISIBLE —
    // checkbox "Verify you are human" TIDAK PERNAH dirender (rekaman nyata:
    // frame cuma menampilkan "Checking your Browser…" dengan BODY kosong).
    // Jadi klik otomatis TIDAK AKAN PERNAH bisa menyelesaikannya; token hanya
    // bisa datang dari solver eksternal (yang memakai Chrome asli) atau auto-fill
    // ±40 detik kalau browser lolos integrity check. Mengerjakan solver duluan
    // (±15-20 detik) jauh lebih cepat & andal daripada menunggu/klik 60 detik.
    //
    // Sebelumnya urutan TERBALIK (klik dulu 60s → solver), dan ambilSitekey
    // gagal karena sitekey cuma ada di URL frame — dua-duanya bikin "bot tidak
    // bisa auto solve". Sekarang solver dijalankan DULU + ambilSitekey sudah
    // diperbaiki (fallback regex dari URL frame).
    const cekSubmitSiap = () =>
      page
        .getByRole("button", { name: /complete sign up|create account|submit|daftar|complete/i })
        .last()
        .isEnabled({ timeout: 1500 })
        .catch(() => false);
    if (config.useSolver) {
      // cek dulu: mungkin sudah solved (auto-fill / sesi sebelumnya)
      if (await cekTokenTurnstile(page)) {
        onLog("ℹ️ Turnstile sudah solved (token terisi) — skip solver.");
      } else {
        try {
          const hasil = await solveTurnstileDiHalaman(page, page.url());
          onLog(hasil.injected
            ? "🧩 Turnstile diselesaikan via solver."
            : "🧩 Turnstile solved, tapi input response tidak ditemukan (mungkin invisible).");
        } catch (e) {
          onLog(`⚠️  Solver Turnstile gagal (${e.message}) — fallback klik otomatis...`);
        }
      }
      // Pastikan token benar-benar terisi sebelum submit (solver bisa sukses tapi
      // inject gagal, atau auto-fill belum selesai). Kalau kosong, satu fallback
      // klik + tunggu auto-fill ±60s — jangan langsung submit tanpa token.
      if (!(await cekTokenTurnstile(page))) {
        await klikTurnstileLangsung(page, onLog);
      }
      if (await cekTokenTurnstile(page)) {
        onLog("✅ Token Turnstile terisi — siap submit.");
      } else {
        onLog("⚠️  Token Turnstile belum terisi — tetap lanjut submit (mungkin auto-solve saat submit / invisible).");
      }
    } else {
      // Safety net sama seperti dulu (step 3b): klik checkbox langsung + tunggu
      // auto-fill ±60s, SEBELUM tungguVerifyDanKlik — supaya perilaku jalur tanpa
      // solver tidak berubah dari versi sebelumnya (yang terbukti 5/5 sukses).
      await klikTurnstileLangsung(page, onLog);

      // TUNGGU widget "Verify you are human" MUNCUL (render beberapa detik
      // TUNGGU widget "Verify you are human" MUNCUL (render beberapa detik
      // setelah form terisi), klik otomatis, tunggu sampai selesai — baru lanjut.
      // cekFormSiap = tombol submit aktif → challenge benar-benar beres, bukan
      // sekadar asumsi dari DOM (yang inkonsisten antar sesi).
      const diklik = await tungguVerifyDanKlik(page, onLog, { timeoutMs: 45000, cekFormSiap: cekSubmitSiap });

      // PAUSE HANYA kalau masih ada yang menahan form:
      //  - klik captcha GAGAL tapi widget captcha masih terlihat (butuh manual), ATAU
      //  - tombol submit masih nonaktif (captcha belum selesai diproses).
      const btnSubmit = page
        .getByRole("button", { name: /complete sign up|create account|submit|daftar|complete/i })
        .last();
      const masihNonaktif = await btnSubmit.isDisabled({ timeout: 2500 }).catch(() => false);
      const butuhManusia = !diklik && (await perluIntervensiManual(page));
      if (masihNonaktif || butuhManusia) {
        // Coba selesaikan verifikasi Cloudflare otomatis dulu sebelum PAUSE.
        const cfBeres = await tungguVerifyDanKlik(page, onLog, { timeoutMs: 15000, cekFormSiap: cekSubmitSiap });
        const masihNonaktif2 = cfBeres
          ? await btnSubmit.isDisabled({ timeout: 2000 }).catch(() => false)
          : true;
        if (cfBeres && !masihNonaktif2) {
          onLog("🚀 Verifikasi Cloudflare selesai — langsung submit.");
        } else {
          onLog("🧍 PAUSE — ada captcha/verifikasi yang menahan form di jendela browser.");
          onLog(`   Email : ${email}`);
          onLog(`   Nama  : ${nama}`);
          onLog(`   Pass  : ${password}`);
          onLog("   Selesaikan di browser, lalu tekan Enter di terminal ini.");
          // MODE REKAM (hanya mode interaktif — di mode bulk/noPause tidak
          // berguna karena tidak ada klik manual): simpan struktur widget
          // SEBELUM user klik manual — buat diagnosa selector (dipakai
          // memperbaiki klik otomatis di sesi berikutnya).
          if (!noPauseGlobal) {
            await rekamTurnstile(page, "SEBELUM-KLIK", onLog);
            await tungguEnter(PAUSE_TIMEOUT_S);
            // MODE REKAM: simpan juga SETELAH klik manual — melihat apa yang
            // berubah (class/aria/checked/token) supaya tanda "sudah solved"
            // bisa dikenali.
            await rekamTurnstile(page, "SETELAH-KLIK", onLog);
          } else {
            await tungguEnter(PAUSE_TIMEOUT_S);
          }
        }
      } else {
        onLog("🚀 Form siap — langsung submit.");
      }
    }

    // ── 4b. jaring pengaman: pastikan field terisi sebelum submit ──
    await pastikanFormTerisi(page, nama, password, onLog);

    // ── 5. submit utama (nama + password) ──
    await klikSubmit(page, onLog);

    // ── 5b. kalau captcha muncul SETELAH submit — tunggu, klik otomatis, PAUSE kalau masih ada ──
    if (!config.useSolver && (await perluIntervensiManual(page))) {
      const cfBeres = await tungguVerifyDanKlik(page, onLog, { timeoutMs: 15000 });
      if (!cfBeres || (await perluIntervensiManual(page))) {
        onLog("🧍 PAUSE — captcha muncul setelah submit. Selesaikan di browser, lalu tekan Enter.");
        if (!noPauseGlobal) {
          await rekamTurnstile(page, "SEBELUM-KLIK", onLog);
          await tungguEnter(PAUSE_TIMEOUT_S);
          await rekamTurnstile(page, "SETELAH-KLIK", onLog);
        } else {
          await tungguEnter(PAUSE_TIMEOUT_S);
        }
      }
    }

    // ── 6. tunggu masuk ke akun -> status signed_up ──
    await tungguMasuk(page, onLog);

    const storage = await context.storageState();
    onLog("✅ Akun terdaftar (signed_up).");
    return { email, password, nama, status: "signed_up", storage, cookiesDir: null };
  } catch (e) {
    onLog(`❌ Signup gagal: ${e.message}`);
    return { email, password, nama, status: "failed", error: e.message };
  } finally {
    if (contextBaru && context) {
      // context incognito dibuka per worker — tutup biar tidak menumpuk di browser
      try { await context.close(); } catch {}
    }
    await tutupBrowser(browser, cdp);
  }
}

// ── langkah-langkah (toleran terhadap variasi UI x.ai) ─────────────

async function bukaSignupDenganRetry(page, url, onLog) {
  // Tanda halaman signup siap: tombol "Sign up with email" atau input email muncul.
  const siapSignup = () =>
    page
      .locator("button")
      .filter({ hasText: /sign up with email|continue with email|create your account|create account/i })
      .first()
      .isVisible({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);

  for (let coba = 1; coba <= 3; coba++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(150);

    // Loop: cek diblokir -> klik/bersihkan Cloudflare -> cek UI signup muncul.
    // Challenge "Verify you are human" sering muncul SETELAH goto selesai (iframe
    // render belakangan) — jadi jangan cuma cek sekali, tapi ulangi sampai UI beneran ada.
    const tenggat = Date.now() + 120000; // maks ±2 menit per percobaan
    let diblokir = false;
    while (Date.now() < tenggat) {
      const teks = await page.locator("body").innerText().catch(() => "");
      if (teks.includes("blocked") || teks.includes("security service")) {
        diblokir = true;
        break;
      }

      // klik challenge Cloudflare kalau ada (interstitial / widget turnstile)
      await tanganiCloudflare(page, onLog, { timeoutMs: 5000 });

      if (await siapSignup()) {
        onLog("🌐 Halaman sign-up terbuka (UI terdeteksi).");
        return;
      }
      await sleep(200);
    }

    if (diblokir) {
      onLog(`⚠️  Diblokir security service (coba ${coba}/3) — muat ulang...`);
    } else {
      onLog(`⚠️  UI signup belum muncul setelah ±2 menit (coba ${coba}/3) — muat ulang...`);
    }
    await sleep(800); // backoff sebelum reload — jangan hammering kalau diblokir
  }
  throw new Error("xAI memblokir akses (403 security service) atau UI signup tidak muncul. Mode headless sering diblokir — jalankan TANPA --headless (headful), atau siapkan browser anti-detect.");
}

const tutupCookieBanner = async (page, onLog) => {
  const cookieBtn = page.locator("button").filter({ hasText: /accept|agree|setujui|terima/i }).first();
  if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cookieBtn.click();
    onLog("🍪 Banner cookie ditutup.");
    await sleep(150);
  }
};

// Logout akun sesi SEBELUMNYA dari halaman x.ai. Browser CDP (Brave) tetap hidup
// antar akun, jadi kalau akun sebelumnya masih login, sesi baru harus logout dulu
// biar tidak nyasar ke akun lama. Jalur: buka halaman logout x.ai + klik tombol.
async function logoutDariXai(page, onLog) {
  try {
    const url = page.url() || "";
    const sudahLogin = /grok\.com|accounts\.x\.ai/.test(url) && !/sign[-_]?up|sign[-_]?in/.test(url);
    const adaTombolLogout = await page
      .locator("button")
      .filter({ hasText: /log out|sign out|keluar/i })
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (!sudahLogin && !adaTombolLogout) {
      onLog("🚪 Tidak ada sesi lama — langsung signup.");
      return;
    }
    onLog("🚪 Logout akun sesi sebelumnya...");
    // Jalur 1: buka halaman logout resmi x.ai
    await page.goto("https://accounts.x.ai/sign-out?redirect=grok-com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {});
    await sleep(150);
    // Halaman logout bisa juga dilewati challenge Cloudflare — klik otomatis kalau ada
    await tanganiCloudflare(page, onLog, { timeoutMs: 4000 });
    // Jalur 2: kalau ada tombol logout/confirm, klik
    const btn = page
      .locator("button")
      .filter({ hasText: /log out|sign out|keluar|logout/i })
      .first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
      await sleep(150);
    }
    onLog("🚪 Logout selesai — siap untuk sesi baru.");
  } catch (e) {
    onLog(`⚠️  Logout gagal (${e.message}) — lanjut signup.`);
  }
}

async function isiEmail(page, email, onLog) {
  const lanjutEmail = page
    .locator("button")
    .filter({ hasText: /sign up with email|continue with email|log in with email|sign in with email/i })
    .first();
  if (await lanjutEmail.isVisible({ timeout: 5000 }).catch(() => false)) {
    await lanjutEmail.click();
    onLog("👆 Klik 'Sign up with email'.");
    await sleep(200);
  }

  const inputEmail = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
  await inputEmail.waitFor({ timeout: 20000 });
  await inputEmail.fill(email);
  onLog("✍️ Email diisi.");
  await sleep(120);

  const btn = page.locator("button").filter({ hasText: /continue|next|lanjut|sign up/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Turnstile/Cloudflare widget sering muncul di form email dan membuat tombol
    // Continue nonaktif — klik widget dulu, baru klik Continue.
    await tanganiCloudflare(page, onLog, { timeoutMs: 5000 });
    await btn.click({ timeout: 10000, noWaitAfter: true }).catch(() => {});
    onLog("👆 Lanjut setelah email.");
  } else {
    await inputEmail.press("Enter");
    onLog("⏎ Enter ditekan.");
  }
  await sleep(200);
}

async function isiOtp(page, kode, onLog) {
  // Kode x.ai bisa angka (483920) ATAU alfanumerik (TYO-HEO)
  const kodeBersih = String(kode || "").replace(/-/g, "");

  // Strategi selector berlapis — coba satu per satu sampai ketemu yang terlihat
  const selectorSet = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
    'input[name*="code" i], input[placeholder*="code" i], input[aria-label*="code" i]',
  ];

  let target = null;
  for (const sel of selectorSet) {
    const loc = page.locator(sel).first();
    // tunggu maks ~10 detik per selector
    for (let i = 0; i < 4; i++) {
      if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) { target = loc; break; }
      await sleep(200);
    }
    if (target) break;
  }

  if (target) {
    const jumlah = await page.locator(selectorSet.join(",")).count().catch(() => 0);
    if (jumlah > 1 && kodeBersih.length === jumlah) {
      // beberapa kotak (mis. 6 kotak): isi per karakter
      const semua = page.locator(selectorSet.join(","));
      for (let j = 0; j < kodeBersih.length; j++) await semua.nth(j).fill(kodeBersih[j]);
      onLog(`✍️ Kode OTP diisi ke ${jumlah} kotak.`);
    } else {
      // satu input: isi versi tanpa strip (maxlength=6, kode TYO-HEO -> TYOHEO)
      await target.fill(kodeBersih);
      let isi = (await target.inputValue().catch(() => "")).trim();
      if (isi !== kodeBersih) {
        // React kadang tidak menangkap fill() — kosongkan & ketik per karakter
        await target.fill("");
        await target.pressSequentially(kodeBersih, { delay: 50 });
        isi = (await target.inputValue().catch(() => "")).trim();
      }
      onLog(`✍️ Kode OTP diisi (${isi}).`);
    }

    // Setelah kode diisi, x.ai OTOMATIS memproses — tombol "Confirm email" sering
    // NONAKTIF secara DOM walau kode diterima (halaman pindah sendiri). Jadi tanda
    // sukses yang ANDAL: halaman pindah ke form nama/password ATAU tombol jadi aktif.
    // Polling maks ±20 detik — JANGAN PAUSE hanya karena tombol terlihat nonaktif.
    const btnOtp = page.getByRole("button", { name: /continue|verify|next|submit|confirm/i }).first();
    const tenggat = Date.now() + 20000;
    while (Date.now() < tenggat) {
      // tanda 1: halaman sudah pindah ke form nama/password (kode diterima)
      if (await formNamaPasswordMuncul(page, 1000)) {
        onLog("✔️ Kode OTP diterima — halaman pindah ke form nama/password.");
        await sleep(200);
        return;
      }
      // tanda 2: tombol confirm jadi aktif — klik
      const enabled = await btnOtp.isEnabled({ timeout: 800 }).catch(() => false);
      if (enabled) {
        try { await btnOtp.click({ timeout: 8000, noWaitAfter: true }); } catch {}
        await sleep(200);
        return;
      }
      await sleep(200);
    }

    // 20 detik belum pindah & tombol nonaktif — coba klik Cloudflare (mungkin
    // challenge menahan), lalu cek SEKALI LAGI apakah halaman sudah pindah.
    // (15s: fase OTP — user mengizinkan tunggu di sini; 8s terlalu ketat.)
    await tanganiCloudflare(page, onLog, { timeoutMs: 15000 });
    if (await formNamaPasswordMuncul(page, 10000)) {
      onLog("✔️ Kode OTP diterima — halaman pindah ke form nama/password.");
      await sleep(200);
      return;
    }

    onLog("🧍 PAUSE — tombol Confirm email masih nonaktif / kode belum diterima.");
    onLog("   Kalau halaman SUDAH pindah ke form nama/password, langsung tekan Enter.");
    onLog(`   Kode OTP: ${kodeBersih}`);
    onLog("   Teks halaman saat ini: " + ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 200).replace(/\n+/g, " · "));
    await tungguEnter(PAUSE_TIMEOUT_S);
    return;
  }

  onLog("ℹ️ Input OTP tidak muncul — kode dicatat, bisa diisi manual.");
  onLog(`   Kode: ${kodeBersih}`);
}

// Deteksi form nama/password (givenName/familyName/password) sudah tampil di halaman.
// timeoutMs bisa diperkecil oleh pemanggil yang cuma mau cek cepat (mis. polling form).
async function formNamaPasswordMuncul(page, timeoutMs = 4000) {
  return await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

// Isi satu field lalu VERIFIKASI nilai menempel. React kadang tidak menangkap fill()
// langsung — kalau begitu, kosongkan & ketik per karakter (pressSequentially).
async function isiFieldTerverifikasi(loc, nilai, onLog) {
  if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await loc.fill(nilai).catch(() => {});
  let isi = await loc.inputValue().catch(() => "");
  if (isi !== nilai) {
    await loc.fill("").catch(() => {});
    await loc.pressSequentially(String(nilai), { delay: 40 }).catch(() => {});
    isi = await loc.inputValue().catch(() => "");
  }
  if (isi !== nilai) onLog(`⚠️  Field ${(await loc.getAttribute("name").catch(() => "?")) || "?"} gagal diisi (nilai: '${isi}').`);
  return isi === nilai;
}

// Isi form nama/password. Return TRUE kalau semua field berhasil terisi.
// `skipPause` = jangan PAUSE kalau form belum muncul (dipakai panggilan ulang/jaring pengaman).
async function isiNamaPassword(page, nama, password, onLog, skipPause = false) {
  const [depan, belakang] = nama.split(" ");

  // Form nama/password muncul SETELAH email terkonfirmasi — tapi bisa delay beberapa
  // detik. Tunggu maks ±5 detik (deadline, cek cepat tiap ~250ms); kalau belum muncul,
  // langsung lanjut ke fallback manual — jangan menunggu lama-lama.
  let formMuncul = false;
  const tenggat = Date.now() + 5000;
  while (Date.now() < tenggat) {
    if (await formNamaPasswordMuncul(page, 1000)) { formMuncul = true; break; }
    await sleep(100);
  }
  if (!formMuncul) {
    if (skipPause) {
      onLog("ℹ️ Form nama/password tidak tampil (skip pause).");
      return false;
    }
    onLog("🧍 PAUSE — form nama/password belum muncul setelah ±5 detik.");
    onLog("   Kalau halaman sudah menampilkan form (First name / Last name / Password),");
    onLog("   isi manual lalu tekan Enter di terminal ini untuk lanjut.");
    await tungguEnter(PAUSE_TIMEOUT_S);
    if (!(await formNamaPasswordMuncul(page))) {
      onLog("ℹ️ Form tetap tidak muncul — dump struktur halaman:");
      await dumpInputs(page, onLog);
      return false;
    }
  }

  // Selector PERSIS sesuai form x.ai (hasil dump):
  //   First name -> input[name="givenName"]  |  Last name -> input[name="familyName"]  |  Password -> input[type="password"]
  const inputDepan = page.locator('input[name="givenName"], input[autocomplete="given-name"], input[name*="first" i], input[placeholder*="first" i], input[placeholder*="nama depan" i]').first();
  const inputBelakang = page.locator('input[name="familyName"], input[autocomplete="family-name"], input[name*="last" i], input[placeholder*="last" i], input[placeholder*="nama belakang" i]').first();
  const inputPass = page.locator('input[name="password"], input[type="password"]').first();

  // Isi dengan RETRY: kalau ada field yang belum terisi (form telat render / nilai tidak
  // menempel), ulangi sampai semua benar-benar terisi (maks 5x ±2 detik).
  let terisi = false;
  for (let coba = 1; coba <= 5 && !terisi; coba++) {
    const a = await isiFieldTerverifikasi(inputDepan, depan, onLog);
    const b = await isiFieldTerverifikasi(inputBelakang, belakang, onLog);
    const c = await isiFieldTerverifikasi(inputPass, password, onLog);
    if (a && b && c) {
      terisi = true;
      onLog(`✍️ Form terisi: ${nama} / password ${password.length} karakter.`);
      break;
    }
    if (coba < 5) {
      onLog(`↻ Field belum lengkap (depan ${a ? "✓" : "✗"}, belakang ${b ? "✓" : "✗"}, password ${c ? "✓" : "✗"}) — coba lagi...`);
      await sleep(200);
    }
  }

  if (!terisi) {
    // Fallback: field nama generic (satu field nama / nama depan+belakang)
    const generic = page.locator('input[name*="name" i], input[placeholder*="name" i], input[placeholder*="nama" i], input[autocomplete="name"], input[name="fullname"]');
    const jml = await generic.count().catch(() => 0);
    const terlihat = [];
    for (let j = 0; j < jml; j++) {
      if (await generic.nth(j).isVisible().catch(() => false)) terlihat.push(generic.nth(j));
    }
    if (terlihat.length === 1) {
      await terlihat[0].fill(nama).catch(() => {});
      onLog("✍️ Nama diisi (satu field fallback).");
      terisi = true;
    } else if (terlihat.length >= 2) {
      await terlihat[0].fill(depan).catch(() => {});
      await terlihat[1].fill(belakang).catch(() => {});
      onLog("✍️ Nama depan + belakang diisi (fallback).");
      terisi = true;
    } else {
      onLog("ℹ️ Field tidak semua terisi — isi manual kalau perlu. Data akun:");
      onLog(`   Nama : ${nama}`);
      onLog(`   Pass : ${password}`);
      await dumpInputs(page, onLog);
    }
  }

  return terisi;
}

// Dump semua input + tombol yang terlihat di halaman (buat debug selector).
async function dumpInputs(page, onLog) {
  try {
    const d = await page.evaluate(() => {
      const inputs = [];
      document.querySelectorAll("input").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          inputs.push({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, autocomplete: el.autocomplete, aria: el.getAttribute("aria-label") || "" });
        }
      });
      const buttons = [];
      document.querySelectorAll("button, [role=button]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) buttons.push((el.innerText || "").trim().slice(0, 50));
      });
      return { inputs, buttons };
    });
    onLog("   INPUT: " + JSON.stringify(d.inputs));
    onLog("   BUTTON: " + JSON.stringify(d.buttons));
  } catch {}
}

// Klik tombol submit TOLERAN: tombol bisa jadi disabled/aria-busy sesaat saat halaman
// sedang memproses (submit berjalan) — itu TIDAK boleh dianggap error. Kalau tombol
// busy, tunggu navigasi; kalau halaman pindah, anggap sukses.
async function klikSubmit(page, onLog) {
  const btn = page
    .getByRole("button", { name: /continue|next|create|daftar|sign up|submit|complete/i })
    .last();
  if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
    // coba klik (jangan menunggu actionability lama — tombol busy saat submit itu normal)
    try {
      await btn.click({ timeout: 8000, noWaitAfter: true });
    } catch {}
    // tunggu sebentar: kalau halaman navigasi / tombol busy, itu tandanya submit berjalan
    for (let i = 0; i < 8; i++) {
      const u = page.url();
      if (!/sign[-_]?up|register/.test(u) || !u.includes("accounts.x.ai/sign-up")) {
        onLog("👆 Form dikirim — halaman pindah ke: " + u.slice(0, 60));
        return;
      }
      await sleep(200);
    }
    onLog("👆 Form terakhir dikirim (klik submit).");
  }
}

// Deteksi error OTP dari x.ai: teks "...code is invalid/incorrect/expired..." DAN
// field OTP masih tampil. Regex SPESIFIK (butuh kata 'code/kode' dekat kata error)
// supaya tidak false positive pada pesan lain seperti "Something went wrong".
async function adaErrorOtp(page) {
  const teks = await page.locator("body").innerText().catch(() => "");
  const adaError = /(?:code|kode)\D{0,40}?(?:invalid|incorrect|expired|wrong|not valid|salah|tidak valid|kadaluarsa)|(?:invalid|incorrect|expired|wrong|not valid)\D{0,40}?(?:code|kode)/i.test(teks);
  if (adaError) {
    const otpVisible = await page
      .locator('input[inputmode="numeric"], input[maxlength="1"], input[name*="code" i], input[autocomplete="one-time-code"]')
      .first()
      .isVisible()
      .catch(() => false);
    return otpVisible;
  }
  return false;
}

// Menunggu tanda sudah masuk: URL bukan /sign-up atau ada elemen akun.
async function tungguMasuk(page, onLog) {
  for (let i = 0; i < 12; i++) {
    const url = page.url();
    const masuk = !/sign[-_]?up|register/i.test(url) && !url.includes("accounts.x.ai/sign-up");
    const adaAkun = await page
      .locator("button")
      .filter({ hasText: /log out|sign out|keluar/i })
      .count()
      .catch(() => 0);
    if (masuk && (adaAkun > 0 || i > 8)) {
      onLog(`🔓 Terdeteksi sudah masuk: ${url}`);
      return;
    }
    await sleep(150);
  }
  // Jangan langsung gagal — beberapa UI redirect ke grok.com tanpa tombol keluar terlihat
  onLog("⚠️ Tidak ada indikator login jelas — dianggap selesai (cek manual jika ragu).");
}

// Apakah ada yang menahan form dan butuh campur tangan manusia?
// - Turnstile/captcha terlihat DI HALAMAN DAN checkbox-nya BELUM tercentang (belum solved), ATAU
// - tombol submit utama masih nonaktif (biasanya = menunggu captcha selesai)
// Widget Turnstile yang SUDAH solved (checkbox tercentang) TIDAK dihitung sebagai
// intervensi — iframe-nya masih terlihat, tapi challenge-nya sudah beres.
async function perluIntervensiManual(page) {
  try {
    // Deteksi widget: cek DOM (src tidak kosong) ATAU frame (URL asli ada di frame
    // walaupun atribut src di DOM kosong — khas iframe Turnstile).
    const butuhKlik = await page
      .evaluate(() => {
        const els = document.querySelectorAll(
          'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, [data-sitekey], [class*="captcha"]'
        );
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })
      .catch(() => false);
    const adaFrameWidget = page
      .frames()
      .some((f) => /turnstile|hcaptcha|recaptcha|challenges\.cloudflare/i.test(f.url() || ""));
    if (butuhKlik || adaFrameWidget) {
      // Cek checkbox di dalam widget (helper sama dengan cloudflare.js): kalau ADA
      // checkbox yang belum tercentang → butuh intervensi. Kalau sudah tercentang,
      // ATAU frame tidak punya checkbox (widget invisible/auto-solve) → jangan flag.
      const { ada, checked, token } = await cekWidgetSolved(page);
      if (token) return false; // token terisi = sudah solved, jangan PAUSE
      if (ada && checked !== true) return true; // ada widget belum solved — butuh manusia
      // semua widget sudah solved / invisible → jatuh ke cek tombol submit di bawah
    }

    const btn = page
      .getByRole("button", { name: /complete sign up|create account|submit|daftar|complete/i })
      .last();
    return await btn.isDisabled({ timeout: 1500 }).catch(() => false);
  } catch {
    return false;
  }
}

// Jaring pengaman sebelum submit: kalau ada field nama/password yang masih kosong,
// isi ulang. Kalau form belum muncul sama sekali, lewati (akan ditangani retry lain).
async function pastikanFormTerisi(page, nama, password, onLog) {
  if (!(await formNamaPasswordMuncul(page))) return;
  const cek = await page
    .evaluate(() => {
      const o = {};
      document.querySelectorAll("input").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && el.value) o[el.name || el.type] = el.value;
      });
      return o;
    })
    .catch(() => ({}));
  const [depan, belakang] = nama.split(" ");
  const adaDepan = cek.givenName || cek.firstName || Object.values(cek).includes(depan);
  const adaBelakang = cek.familyName || cek.lastName || Object.values(cek).includes(belakang);
  const adaPass = cek.password || Object.values(cek).includes(password);
  if (adaDepan && adaBelakang && adaPass) return;
  onLog("⚠️  Field ada yang kosong sebelum submit — isi ulang...");
  await isiNamaPassword(page, nama, password, onLog, true); // skipPause: jangan PAUSE ganda
}

// ── KLIK LANGSUNG Turnstile checkbox ──────────────────────────────
// Safety net: bypass deteksi rumit — klik checkbox di frame
// challenges.cloudflare.com via helper bersama cloudflare.js
// (klikVerifikasiCloudflare: label/marker/role=checkbox/input/teks + JS fallback)
// + fallback koordinat (klikTurnstileByKoordinat), sampai token terisi.
// Dipanggil SETELAH form nama/password terisi, sebelum submit.
async function klikTurnstileLangsung(page, onLog) {
  // Cek dulu: sudah solved? (token terisi)
  if (await cekTokenTurnstile(page)) {
    onLog("ℹ️ Turnstile sudah solved (token terisi) — skip klik.");
    return true;
  }

  onLog("🔍 Mencari Turnstile checkbox secara langsung...");
  // maks 60 detik menunggu widget render + solve. Bukti dari rekaman nyata
  // (rekam-turnstile.log): widget bisa bertahan 50+ detik di state "Checking
  // your Browser…" sebelum checkbox muncul — batas 20s/40s dulu membuat bot
  // menyerah persis sebelum checkbox render (gejala "bot tidak mencentang
  // verify you are human"). Kalau checkbox tidak pernah muncul sampai deadline,
  // phase berikutnya (tungguVerifyDanKlik) tetap memberi jendela tambahan.
  const deadline = Date.now() + 20000;
  let pernahKlik = false;
  let rekamTerakhir = -10000; // cooldown dump struktur (tiap ±6s selama belum solved)

  while (Date.now() < deadline) {
    // Cek token lagi (mungkin solved selama loop)
    if (await cekTokenTurnstile(page)) {
      onLog("✅ Turnstile solved (token terisi) — lanjut.");
      return true;
    }
    // status via helper bersama (struktur-agnostik: input / role / label / teks)
    const st = await cekWidgetSolved(page);
    if (st.token || st.checked === true) {
      onLog("✅ Turnstile sudah solved — lanjut.");
      return true;
    }

    // MODE REKAM: selama widget BELUM solved, dump struktur ke rekam-turnstile.log
    // tiap ±6 detik (tanpa menunggu PAUSE). Kalau user klik manual sebelum bot
    // PAUSE, dump ini tetap menangkap struktur checkbox asli yang tampil —
    // bahan diagnosa untuk memperbaiki klik otomatis.
    if (Date.now() - rekamTerakhir > 6000) {
      rekamTerakhir = Date.now();
      await rekamTurnstile(page, "WIDGET-BELUM-SOLVED-LANGSUNG", onLog, { jenis: "widget", st, token: st.token });
    }

    // klik checkbox di frame (label/marker/role/input/teks, dengan verifikasi state)
    const diklik = await klikVerifikasiCloudflare(page, onLog);
    if (diklik) pernahKlik = true;

    // Fallback: klik via KOORDINAT — frame tidak ke-enumerasi / klik locator gagal.
    // klikTurnstileByKoordinat sendiri aman dipanggil berulang: kalau tidak ada
    // widget yang terlihat ia return false.
    if (!(await cekTokenTurnstile(page)) && (await klikTurnstileByKoordinat(page, onLog))) {
      pernahKlik = true;
      onLog("🧩 Turnstile diklik via koordinat — menunggu solve...");
      const tenggat = Date.now() + 6000;
      while (Date.now() < tenggat) {
        if (await cekTokenTurnstile(page)) {
          onLog("✅ Turnstile solved — token terisi.");
          return true;
        }
        await sleep(150);
      }
    }

    await sleep(200);
  }

  if (pernahKlik) {
    onLog("⚠️  Turnstile diklik tapi belum solved setelah 20 detik — lanjut, mungkin invisible/auto-solve.");
    return false;
  }
  onLog("ℹ️  Turnstile checkbox tidak ditemukan — mungkin mode invisible atau sudah solved.");
  return false;
}

// Cek apakah token Turnstile (cf-turnstile-response) sudah terisi di halaman.
// Token terisi = widget solved — ground truth yang lebih andal dari checkbox DOM.
async function cekTokenTurnstile(page) {
  const t = await page
    .locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')
    .first()
    .inputValue()
    .catch(() => "");
  return !!t;
}

// ── helper kecil ───────────────────────────────────────────────────

// Password acak yang JAMIN memenuhi syarat: minimal 1 huruf besar, 1 huruf kecil,
// 1 angka, dan 1 simbol. Panjang default 14.
export function buatPassword(len = 14) {
  if (len < 6) len = 6;
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digit = "23456789";
  const simbol = "!@#$%&*+?=";
  const semua = lower + upper + digit + simbol;
  const pilih = (s) => s[Math.floor(Math.random() * s.length)];
  // jamin satu dari tiap kategori
  let p = pilih(lower) + pilih(upper) + pilih(digit) + pilih(simbol);
  while (p.length < len) p += pilih(semua);
  // acak urutan (shuffle)
  return p
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

const pilih = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PAUSE manual: tunggu user menekan Enter (untuk captcha yang tidak bisa diselesaikan bot).
// Mode CEPAT: timeout PAUSE diringkas ke 15 detik — kalau tidak dijawab, bot langsung lanjut.
const PAUSE_TIMEOUT_S = 5;
// Kalau `noPause` (mode bulk paralel), jangan tunggu stdin — langsung lanjut setelah
// timeout singkat. Di mode paralel, banyak worker berbagi satu stdin: satu Enter
// akan melepas SEMUA worker yang menunggu — semantik PAUSE jadi rusak.
const tungguEnter = (timeoutSec) =>
  new Promise((resolve) => {
    if (noPauseGlobal) {
      const t = setTimeout(resolve, Math.min(5000, timeoutSec * 1000));
      return;
    }
    process.stdin.resume();
    const t = setTimeout(() => {
      process.stdin.pause();
      resolve();
    }, timeoutSec * 1000);
    process.stdin.once("data", () => {
      clearTimeout(t);
      process.stdin.pause();
      resolve();
    });
  });
let noPauseGlobal = false;
