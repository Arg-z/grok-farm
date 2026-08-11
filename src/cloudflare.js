// cloudflare.js — klik verifikasi Cloudflare otomatis di alur signup
//
// Dua bentuk challenge yang ditangani:
//   1. INTERSTITIAL (full-page): halaman belum termuat, menampilkan
//      "Just a moment..." / "Verify you are human" dengan iframe challenge
//      dari challenges.cloudflare.com. Harus DIBERSIHKAN dulu sebelum bot
//      bisa lanjut mengisi form — kalau tidak, bot cuma timeout menunggu input.
//   2. WIDGET Turnstile: checkbox kecil yang nempel di form signup x.ai.
//      Cukup diklik sekali, Turnstile menangani sisanya.
//
// MODE REKAM: setiap kali widget Turnstile terdeteksi tapi belum solved, struktur
// DOM-nya direkam ke rekam-turnstile.log (via rekam.js) — bahan diagnosa kalau
// bot tidak bisa klik otomatis checkbox "Verify you are human".
import { rekamTurnstile } from "./rekam.js";

const IFRAME_SELECTOR = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[id*="cf-chl"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  'iframe[title*="challenge" i]',
].join(", ");

const CHECKBOX_SELECTOR = [
  'input[type="checkbox"]',
  ".ctp-checkbox-label",
  '[role="checkbox"]',
  ".marker",
  '#challenge-stage input[type="checkbox"]',
  ".challenge-stage input[type=\"checkbox\"]",
  ".challenge-container input[type=\"checkbox\"]",
  ".main-wrapper input[type=\"checkbox\"]",
  '[id*="challenge"] input[type="checkbox"]',
].join(", ");

// Urutan elemen yang dicoba untuk widget Turnstile: LABEL dulu (elemen yang
// benar-benar merespons klik & men-trigger challenge), baru marker/role/input.
// DOM asli widget: <input type=checkbox> tersembunyi, <label class=ctp-checkbox-label>
// dan <div class=marker> yang terlihat. Klik di input yang tertutup label sering
// ditolak "element is covered" — klik label adalah cara yang benar.
const URUTAN_WIDGET = [
  ".ctp-checkbox-label",
  ".marker",
  '[role="checkbox"]',
  'input[type="checkbox"]',
  ".challenge-stage input[type=\"checkbox\"]",
  ".main-wrapper input[type=\"checkbox\"]",
];

const TEKS_INTERSTITIAL =
  /just a moment|verify you are human|checking your browser|ddos protection|attention required|enable javascript and cookies to continue/i;

// Deteksi jenis challenge yang sedang tampil (null = tidak ada challenge).
// URUTAN PENTING: jangan samakan iframe widget Turnstile dengan interstitial —
// iframe widget juga punya src challenges.cloudflare.com/turnstile/..., jadi
// interstitial hanya dideteksi lewat URL top-level, teks halaman, atau iframe
// dengan id cf-chl (khas halaman "Just a moment").
export async function jenisChallengeCloudflare(page) {
  try {
    const url = (page.url() || "").toLowerCase();
    if (/challenges\.cloudflare\.com/.test(url)) return "interstitial";

    // iframe challenge full-page khas interstitial (id cf-chl-widget-xxx) terlihat?
    const inter = page.locator('iframe[id*="cf-chl"]').first();
    if (await inter.isVisible({ timeout: 800 }).catch(() => false)) return "interstitial";

    // widget turnstile/hcaptcha/recaptcha terlihat?
    // PENTING: iframe Turnstile sering punya atribut src KOSONG di DOM (URL aslinya
    // cuma ada di objek frame) — jadi cek DOM selectors DAN frames. Kalau cuma
    // cek DOM, widget tidak terdeteksi & bot melewatinya.

    // SINYAL PALING ANDAL: elemen widget di DOM — textarea cf-turnstile-response,
    // wrapper .turnstile-wrapper, atau [data-sitekey]. Elemen ini ada BEGITU widget
    // di-render, JAUH sebelum iframe-nya ter-enumerasi di page.frames(). Tanpa ini,
    // sesi pertama (profil browser dingin, widget render lambat) sering terlewat →
    // bot tidak klik "verify you are human" padahal widget-nya ada.
    const adaElWidget = await page
      .locator(
        'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"], .turnstile-wrapper, [data-sitekey], [data-turnstile]'
      )
      .first()
      .count()
      .catch(() => 0);
    if (adaElWidget > 0) return "widget";

    const widget = page
      .locator('iframe[src*="turnstile"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')
      .first();
    if (await widget.isVisible({ timeout: 800 }).catch(() => false)) return "widget";
    const frameWidget = page
      .frames()
      .filter((f) => /turnstile|hcaptcha|recaptcha/i.test(f.url() || ""));
    if (frameWidget.length > 0) return "widget";

    // widget versi lain: iframe dari challenges.cloudflare.com yang BERISI checkbox
    // (URL frame kadang tidak memuat kata "turnstile" — cuma challenges.cloudflare.com).
    // Interstitial sudah ditangani di atas via URL top-level / id cf-chl, jadi
    // frame dengan checkbox di sini hampir pasti widget.
    for (const f of page.frames()) {
      if (!/challenges\.cloudflare\.com/i.test(f.url() || "")) continue;
      const adaCb = await f
        .locator('.ctp-checkbox-label, input[type="checkbox"]')
        .first()
        .count()
        .catch(() => 0);
      if (adaCb > 0) return "widget";
    }

    // teks interstitial dicek TERAKHIR (paling mahal & rawan false positive:
    // halaman marketing yang memuat kata "verify you are human" ikut ketangkap).
    const teks = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    if (TEKS_INTERSTITIAL.test(teks)) return "interstitial";
  } catch {}
  return null;
}

// Klik checkbox di sebuah locator (frame / frameLocator / page).
// Kalau checkbox sudah tercentang (challenge sudah solved), JANGAN diklik lagi
// — mengklik ulang justru bisa mem-bug Turnstile.
// `force` = klik paksa elemen tersembunyi (hanya untuk frame challenge yang sudah
// terverifikasi; untuk top-level jangan force biar tidak salah klik tombol lain).
async function cobaKlik(loc, onLog, force = false) {
  try {
    const jumlah = await loc.count().catch(() => 0);
    if (!jumlah) return false;
    // Coba SEMUA elemen yang cocok (bukan cuma yang pertama di DOM) — di widget
    // Turnstile ada beberapa elemen bertumpuk (input, label, marker); yang pertama
    // belum tentu yang merespons klik.
    for (let i = 0; i < jumlah; i++) {
      const el = loc.nth(i);
      const checked = await el.isChecked({ timeout: 800 }).catch(() => null);
      if (checked === true) return true; // sudah solved — anggap beres
      const terlihat = await el.isVisible({ timeout: 1000 }).catch(() => false);
      let ok = false;
      if (terlihat) {
        ok = await el.click({ timeout: 4000, noWaitAfter: true }).then(() => true).catch(() => false);
      } else if (force) {
        ok = await el.click({ timeout: 1500, force: true }).then(() => true).catch(() => false);
      }
      if (!ok && force) {
        // fallback terakhir: klik sintetis via evaluate — berjalan di frame elemen
        // itu sendiri. Berguna untuk elemen yang sepenuhnya tak terlihat/tertutup.
        ok = await el
          .evaluate((e) => {
            e.click();
            return true;
          })
          .then(() => true)
          .catch(() => false);
      }
      if (ok) {
        // VERIFIKASI hasil klik: cek status checkbox DI FRAME YANG SAMA (via
        // evaluate — document.querySelector menjangkau frame elemen itu).
        //   true  = checkbox tercentang → challenge solved
        //   false = checkbox ada tapi belum tercentang → tunggu sebentar, lalu
        //           anggap diklik (loop luar tanganiCloudflare akan cek lagi)
        //   null  = tidak ada checkbox di frame → challenge tombol/interstitial,
        //           klik sudah dikirim → beres
        const probe = () =>
          el
            .evaluate(() => {
              // Prioritas: checkbox khas challenge (ctp-checkbox / challenge-stage),
              // baru fallback input[type=checkbox] — supaya di top-level tidak
              // salah lirik checkbox lain (mis. "remember me") yang sudah tercentang.
              const cb =
                document.querySelector('.ctp-checkbox, #challenge-stage input[type="checkbox"], .challenge-stage input[type="checkbox"], .challenge-container input[type="checkbox"]') ||
                document.querySelector('input[type="checkbox"]');
              return cb ? cb.checked : null;
            })
            .catch(() => null);
        const tenggat = Date.now() + 2500;
        while (Date.now() < tenggat) {
          const p = await probe();
          if (p === true) {
            onLog("🧩 Checkbox Cloudflare diklik (tercentang).");
            return true;
          }
          if (p === null) {
            onLog("🧩 Checkbox Cloudflare diklik.");
            return true;
          }
          await sleep(300);
        }
        onLog("🧩 Checkbox Cloudflare diklik (menunggu tercentang).");
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Klik checkbox di dalam SATU frame widget (Frame / FrameLocator). Struktur-agnostik:
// coba label klasik → marker → role=checkbox → input → label apa pun, lalu fallback
// klik-berdasarkan-teks ("Verify you are human") + klik sintetis via evaluate.
// Verifikasi state berubah (cekStateCheckboxDiFrame) sebelum mengaku sukses.
//
// Return: true kalau ada klik yang terkirim ATAU widget sudah tercentang.
async function cobaKlikWidgetDiFrame(f, onLog) {
  const urutan = [
    ".ctp-checkbox-label",
    ".marker",
    '[role="checkbox"]',
    'input[type="checkbox"]',
    ".challenge-stage input[type=\"checkbox\"]",
    ".main-wrapper input[type=\"checkbox\"]",
    "label",
  ];
  for (const sel of urutan) {
    const loc = f.locator(sel);
    const jumlah = await loc.count().catch(() => 0);
    for (let i = 0; i < jumlah; i++) {
      const el = loc.nth(i);
      // sudah tercentang? (input asli / aria)
      const checkedInput = await el.isChecked({ timeout: 500 }).catch(() => null);
      const aria = await el.getAttribute("aria-checked").catch(() => null);
      if (checkedInput === true || aria === "true") return true;
      const terlihat = await el.isVisible({ timeout: 800 }).catch(() => false);
      if (!terlihat) continue;
      let ok = await el.click({ timeout: 4000, noWaitAfter: true }).then(() => true).catch(() => false);
      if (!ok) ok = await el.click({ timeout: 3000, force: true, noWaitAfter: true }).then(() => true).catch(() => false);
      if (!ok) {
        // fallback klik sintetis via evaluate (berjalan di dokumen frame itu sendiri)
        ok = await el.evaluate((e) => { (e.click && e.click()); return true; }).then(() => true).catch(() => false);
      }
      if (ok) {
        onLog(`🧩 Checkbox Cloudflare diklik via ${sel}.`);
        // verifikasi singkat: state berubah jadi tercentang?
        for (let v = 0; v < 4; v++) {
          const st = await cekStateCheckboxDiFrame(f);
          if (st.checked === true) return true;
          await sleep(400);
        }
        return true; // klik terkirim — loop luar (tanganiCloudflare) cek state lagi
      }
    }
  }
  // klik-berdasarkan-teks: label bisa tampil tanpa class khas — klik elemen teks
  // (atau parent-nya) sebagai pengganti.
  const teksLoc = f.getByText(/verify you are human|i'?m not a robot|i am human|saya bukan robot/i);
  const nTeks = await teksLoc.count().catch(() => 0);
  for (let i = 0; i < nTeks; i++) {
    const t = teksLoc.nth(i);
    if (!(await t.isVisible({ timeout: 800 }).catch(() => false))) continue;
    const parent = t.locator("xpath=..");
    const target = (await parent.count().catch(() => 0)) > 0 ? parent : t;
    const ok =
      (await target.click({ timeout: 4000, noWaitAfter: true }).then(() => true).catch(() => false)) ||
      (await t.click({ timeout: 3000, force: true, noWaitAfter: true }).then(() => true).catch(() => false));
    if (ok) {
      onLog("🧩 Checkbox Cloudflare diklik via teks 'Verify you are human'.");
      return true;
    }
  }
  return false;
}

// Klik checkbox verifikasi Cloudflare di frame manapun yang relevan.
export async function klikVerifikasiCloudflare(page, onLog) {
  // 1) frame yang sudah termuat (url frame mengandung challenge/turnstile).
  //    Termasuk iframe Turnstile yang src DOM-nya kosong tapi URL frame-nya asli.
  const frames = page.frames().filter((f) =>
    /challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(f.url() || "")
  );
  // 1a) widget Turnstile: klik LABEL dulu (elemen yang benar-benar men-trigger
  //     challenge), baru marker/role/input — untuk tiap frame.
  for (const f of frames) {
    if (await cobaKlikWidgetDiFrame(f, onLog)) return true;
  }
  // 2) fallback: frameLocator lewat selector iframe
  const fl = page.frameLocator(IFRAME_SELECTOR);
  if (await cobaKlikWidgetDiFrame(fl, onLog)) return true;
  if (await cobaKlik(fl.locator(CHECKBOX_SELECTOR), onLog, true)) return true;
  // 3) beberapa versi challenge pakai TOMBOL "Verify you are human" (bukan checkbox)
  //    — cuma di dalam frame challenge, tidak di top-level (hindari salah klik tombol lain).
  const TOMBOL_VERIFY =
    'button:has-text("verify you are human"), [role="button"]:has-text("verify you are human"), #challenge-stage button, .challenge-button, input[type="submit"][value*="verify" i]';
  for (const f of frames) {
    if (await cobaKlik(f.locator(TOMBOL_VERIFY), onLog, true)) return true;
  }
  if (await cobaKlik(fl.locator(TOMBOL_VERIFY), onLog, true)) return true;
  // 4) top-level: hanya checkbox yang TERLIHAT (tanpa force) — kadang challenge
  //    render checkbox langsung di halaman utama.
  if (await cobaKlik(page.locator(CHECKBOX_SELECTOR), onLog, false)) return true;
  // 5) top-level fallback: elemen klikabel berteks "verify you are human" yang
  //    TERLIHAT (button / role=button / role=checkbox). Tanpa force supaya tidak
  //    salah klik elemen tersembunyi / tombol lain di halaman.
  const topVerify = page.locator(
    'button:has-text("verify you are human"), [role="button"]:has-text("verify you are human"), [role="checkbox"]:has-text("verify you are human"), input[type="submit"][value*="verify" i]'
  );
  if (await cobaKlik(topVerify, onLog, false)) return true;
  return false;
}

// Periksa status checkbox di dalam SATU frame widget Turnstile/hcaptcha/recaptcha.
// `f` bisa berupa objek Frame ATAU FrameLocator (dua-duanya punya .locator/.getByText).
//
// Struktur Turnstile berubah-ubah antar versi (platform baru challenge-platform/h/b/
// turnstile/... — frame kadang menampilkan "Checking your Browser…" tanpa checkbox).
// Yang dianggap "checkbox" (struktur-agnostik):
//   - input[type=checkbox]                  (struktur klasik)
//   - [role=checkbox]                       (ARIA, tanpa input asli)
//   - .ctp-checkbox-label / .marker / .ctp-checkbox  (label/marker klasik)
//   - elemen berteks "verify you are human" / "i'm not a robot"
// "Checked" ditentukan dari: input:checked, aria-checked="true", ATAU class
// mengandung checked/selected/active pada elemen label.
//
// Return: { ada: boolean, checked: boolean|null }
async function cekStateCheckboxDiFrame(f) {
  // 1) input asli
  const input = f.locator('input[type="checkbox"]').first();
  if ((await input.count().catch(() => 0)) > 0) {
    const checked = await input.isChecked({ timeout: 600 }).catch(() => null);
    return { ada: true, checked };
  }
  // 2) role=checkbox (aria-checked)
  const role = f.locator('[role="checkbox"]').first();
  if ((await role.count().catch(() => 0)) > 0) {
    const aria = await role.getAttribute("aria-checked").catch(() => null);
    return { ada: true, checked: aria === "true" };
  }
  // 3) label/marker klasik — checked lewat class atau aria
  const label = f.locator(".ctp-checkbox-label, .marker, .ctp-checkbox, [class*='ctp-check' i]").first();
  if ((await label.count().catch(() => 0)) > 0) {
    const cls = (await label.getAttribute("class").catch(() => "")) || "";
    const aria = await label.getAttribute("aria-checked").catch(() => null);
    return { ada: true, checked: /checked|selected|active/i.test(cls) || aria === "true" };
  }
  // 4) teks khas checkbox — UI checkbox terlihat (state tidak diketahui)
  const nTeks = await f.getByText(/verify you are human|i'?m not a robot|i am human|saya bukan robot/i).count().catch(() => 0);
  if (nTeks > 0) return { ada: true, checked: null };
  return { ada: false, checked: null };
}

// Apakah frame ini widget Turnstile/hcaptcha/recaptcha yang TERPERCAYA (bukan
// interstitial full-page)? Interstitial juga memakai URL challenges.cloudflare.com
// — pembedanya: URL widget memuat kata turnstile/hcaptcha/recaptcha, ATAU frame
// berisi elemen .ctp-checkbox-label/.ctp-checkbox/.marker khas widget. Frame
// interstitial (challenge-stage) TIDAK dihitung sebagai widget form.
async function frameWidgetTerpercaya(f) {
  const url = f.url() || "";
  if (/turnstile|hcaptcha|recaptcha/i.test(url)) return true;
  if (!/^challenges\.cloudflare/i.test(url)) return false;
  // cuma challenges.cloudflare.com → wajib ada label khas widget
  return f
    .locator(".ctp-checkbox-label, .ctp-checkbox, .marker")
    .first()
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

// Cek status widget Turnstile/hcaptcha/recaptcha: ada checkbox-nya & sudah tercentang?
// Dipakai bersama oleh cloudflare.js (tanganiCloudflare) dan signup.js
// (perluIntervensiManual) supaya logika tidak dobel dan tidak bisa melenceng.
//
// Cek lewat OBJEK FRAME dulu (iframe Turnstile sering punya src KOSONG di DOM,
// jadi frameLocator tidak menembus — frame object punya URL aslinya), lalu
// fallback frameLocator. Deteksi struktur-agnostik via cekStateCheckboxDiFrame
// (input / role=checkbox / label-marker / teks verify) — bukan cuma input.
//
// Return: { ada: boolean, checked: boolean|null, token: string, loading?: boolean }
//   loading=true = frame widget ADA tapi masih "Checking your Browser…" (silent
//   challenge belum selesai, checkbox belum render). Widget DIANGGAP ADA (ada=true)
//   supaya pemanggil tidak menyimpulkan "tidak ada widget" → submit prematur.
export async function cekWidgetSolved(page) {
  // 0) SINYAL PALING ANDAL: token cf-turnstile-response terisi di halaman utama.
  //    Widget solved = token non-kosong (terlepas dari checkbox terlihat/tidak).
  const token = await page
    .locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')
    .first()
    .inputValue()
    .catch(() => "");
  if (token) return { ada: true, checked: null, token };

  // Cari frame widget dengan regex yang SAMA dengan klikVerifikasiCloudflare.
  // PENTING: URL iframe Turnstile TIDAK selalu memuat kata "turnstile" — kadang
  // murni challenges.cloudflare.com/cdn-cgi/challenge-platform/... Kalau regex
  // sempit, checkbox tidak pernah terdeteksi → bot mengira widget sudah beres
  // padahal belum → submit terkunci → sesi gagal (inkonsisten antar sesi).
  const framesW = page.frames().filter((f) =>
    /challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(f.url() || "")
  );

  // 1) checkbox / teks verify di dalam frame widget (struktur-agnostik).
  for (const f of framesW) {
    if (!(await frameWidgetTerpercaya(f))) continue;
    const st = await cekStateCheckboxDiFrame(f);
    if (st.ada) return { ada: true, checked: st.checked, token: "" };
  }

  // 2) frame widget ADA tapi belum ada checkbox → cek state LOADING "Checking
  //    your Browser…" (hasil rekaman nyata: widget bisa bertahan di state ini
  //    50+ detik sebelum checkbox muncul — atau tidak pernah, kalau browser
  //    terdeteksi sebagai bot). Ini BUKAN "tidak ada widget": bot harus terus
  //    menunggu & coba klik, bukan menyatakan selesai / submit prematur.
  //
  // PENTING: pakai textContent, BUKAN innerText — rekaman asli menunjukkan teks
  // "Checking your Browser…" ada di elemen TERSEMBUNYI (innerText kosong, teks
  // hanya muncul via textContent). Kalau pakai innerText, deteksi loading GAGAL.
  for (const f of framesW) {
    if (!(await frameWidgetTerpercaya(f))) continue;
    const loading = await f
      .evaluate(() => {
        const t = (document.body && document.body.textContent) || "";
        return /checking your browser|verificando|vérification|prüfe deinen browser/i.test(t);
      })
      .catch(() => false);
    if (loading) return { ada: true, checked: null, token: "", loading: true };
  }

  // 3) fallback frameLocator (iframe dengan src kosong di DOM tapi ada di DOM).
  const fl = page.frameLocator(IFRAME_SELECTOR);
  const st2 = await cekStateCheckboxDiFrame(fl);
  if (st2.ada) return { ada: true, checked: st2.checked, token: "" };
  return { ada: false, checked: null, token: "" };
}

// Klik checkbox Turnstile via KOORDINAT — tidak bergantung pada deteksi frame
// atau DOM di dalam iframe (sering gagal: frame cross-origin tidak ter-enumerasi
// di page.frames(), URL frame kosong, dll). Dua jalur:
//   A. Container widget yang TERLIHAT di halaman utama → klik posisi checkbox
//      (kiri-atas container).
//   B. (BARU) Cari elemen checkbox di DALAM frame Turnstile, konversi posisinya
//      ke koordinat halaman (bounding box iframe + posisi elemen), lalu klik
//      page.mouse — menembus keterbatasan locator.click() di frame cross-origin.
// Dipakai sebagai fallback terakhir di tanganiCloudflare & klikTurnstileLangsung.
//
// Return: true kalau klik koordinat terkirim (hasil solve dicek pemanggil).
export async function klikTurnstileByKoordinat(page, onLog = () => {}) {
  // --- Jalur A: container widget di top-level ---
  const SEL_WIDGET = [
    ".cf-turnstile",
    ".turnstile-wrapper",
    "[data-sitekey]",
    'iframe[src*="challenges.cloudflare"]',
    'iframe[id*="turnstile"]',
    'div[id*="turnstile"]',
  ].join(", ");
  const loc = page.locator(SEL_WIDGET).first();
  const count = await loc.count().catch(() => 0);
  if (count) {
    const box = await loc.boundingBox({ timeout: 1500 }).catch(() => null);
    // widget tersembunyi (mode invisible) tidak punya bounding box → jangan klik
    if (box && box.width >= 30 && box.height >= 10) {
      // Checkbox Turnstile berada di kiri-atas widget
      const x = box.x + Math.min(35, box.width * 0.2);
      const y = box.y + Math.min(30, box.height * 0.4);
      onLog(`🧩 Klik Turnstile via koordinat (${Math.round(x)}, ${Math.round(y)}).`);
      try {
        await page.mouse.click(x, y);
        return true;
      } catch {}
    }
  }

  // --- Jalur B: klik di DALAM frame Turnstile (struktur baru / cross-origin) ---
  for (const f of page.frames()) {
    if (!/challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(f.url() || "")) continue;
    const pos = await f
      .evaluate(() => {
        const els = document.querySelectorAll(
          ".ctp-checkbox-label, .ctp-checkbox, .marker, [role=checkbox], label, input[type=checkbox]"
        );
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            // posisi checkbox di kiri elemen; kalau elemen kecil (marker), klik tengahnya
            return { x: r.x + Math.min(25, r.width / 2), y: r.y + r.height / 2 };
          }
        }
        return null;
      })
      .catch(() => null);
    if (!pos) continue;
    const frameEl = await f.frameElement().catch(() => null);
    if (!frameEl) continue;
    const fb = await frameEl.boundingBox().catch(() => null);
    if (!fb) continue;
    const x = fb.x + pos.x;
    const y = fb.y + pos.y;
    onLog(`🧩 Klik checkbox di dalam frame Turnstile (${Math.round(x)}, ${Math.round(y)}).`);
    try {
      await page.mouse.click(x, y);
      return true;
    } catch {}
  }
  return false;
}

// Bersihkan challenge Cloudflare sampai beres. Return TRUE kalau selesai/tidak ada.
// - interstitial: loop klik + tunggu sampai teks/iframe challenge hilang.
// - widget turnstile: klik checkbox (kalau ada) sampai solved. Ground truth-nya
//   bukan tebak-tebakan DOM, tapi `cekFormSiap` (callback opsional dari pemanggil,
//   biasanya = tombol submit form aktif) — tombol aktif berarti Turnstile solved,
//   entah via checkbox maupun mode invisible/auto-solve.
export async function tanganiCloudflare(page, onLog = () => {}, { timeoutMs = 90000, cekFormSiap } = {}) {
  const deadline = Date.now() + timeoutMs;
  let pernahKlik = false;
  let waktuKlikWidgetTerakhir = 0;
  // cooldown MODE REKAM (±8s). Diinisialisasi Date.now() supaya sesi SEHAT
  // (widget langsung solved) tidak membayar dump pertama — rekam baru terjadi
  // kalau widget benar-benar menunggu >8 detik tanpa solved.
  let waktuRekamTerakhir = Date.now();
  let loadingLalu = false; // transisi state "Checking your Browser…" (log sekali saja)
  let pernahAdaCheckbox = false; // apakah checkbox widget PERNAH muncul?
  let sejakKosong = 0; // sejak kapan widget tanpa checkbox (untuk deteksi mode invisible)
  while (Date.now() < deadline) {
    const jenis = await jenisChallengeCloudflare(page);
    if (jenis === "interstitial") {
      if (await klikVerifikasiCloudflare(page, onLog)) pernahKlik = true;
      await sleep(300);
      continue;
    }
    if (jenis === null) {
      // Tidak ada challenge yang terdeteksi. FORM SUDAH SIAP (submit aktif) =
      // tidak ada yang menahan → selesai. Cek ini DI SINI (setelah konfirmasi
      // tidak ada widget), BUKAN di awal loop: kalau widget Turnstile ada tapi
      // belum solved, tombol submit yang aktif prematur di DOM JANGAN dianggap
      // selesai — itulah gejala asli "bot tidak mencentang verify you are human".
      if (cekFormSiap && (await cekFormSiap())) {
        onLog("✅ Form sudah siap (submit aktif) — challenge selesai.");
        return true;
      }
      if (pernahKlik) onLog("✅ Verifikasi Cloudflare selesai.");
      return true;
    }

    // widget turnstile: loop sampai checkbox tercentang / token terisi / form siap.
    // 1) cek solved dulu (token atau checkbox checked) — kalau ya, selesai.
    // 2) kalau ada checkbox belum tercentang → klik (cooldown ±8s, anti dobel-klik
    //    saat spinner; pengaman isChecked ada di klikVerifikasiCloudflare).
    // 3) kalau TIDAK ada checkbox → widget mungkin masih render checkbox-nya
    //    (Turnstile loading). JANGAN menyerah prematur — klik tetap dicoba tiap
    //    cooldown (klikVerifikasiCloudflare meng-enumerasi frame fresh tiap panggil,
    //    jadi begitu checkbox muncul, ikut ke-klik).
    const { ada, checked, token, loading } = await cekWidgetSolved(page);
    if (token || checked === true) {
      onLog(
        token
          ? "✅ Token Turnstile terisi — challenge selesai."
          : "✅ Checkbox Cloudflare tercentang — challenge selesai."
      );
      return true;
    }

    // Widget masih "Checking your Browser…" — log SEKALI saat masuk/keluar state
    // (hasil rekaman nyata: state ini bisa bertahan 50+ detik sebelum checkbox
    // muncul). Biar user tidak bingung kenapa bot diam tanpa centang apa-apa.
    if (loading && !loadingLalu) {
      onLog("⏳ Widget Turnstile masih 'Checking your Browser…' — menunggu checkbox muncul (bisa 30-60 detik)...");
    }
    loadingLalu = loading;

    // MODE REKAM: widget ada & belum solved — rekam struktur tiap ±8 detik
    // (anti-spam; walau frame tidak terdeteksi, container/URL frame tetap tercatat
    // sehingga diagnosa "kenapa checkbox tidak bisa diklik" bisa dianalisis).
    if (Date.now() - waktuRekamTerakhir > 8000) {
      waktuRekamTerakhir = Date.now();
      await rekamTurnstile(page, "WIDGET-BELUM-SOLVED-TUNGGU", onLog, {
        jenis,
        st: { ada, checked, token, loading },
        token,
      });
    }

    if (waktuKlikWidgetTerakhir === 0 || Date.now() - waktuKlikWidgetTerakhir > 3000) {
      if (await klikVerifikasiCloudflare(page, onLog)) {
        waktuKlikWidgetTerakhir = Date.now();
        pernahKlik = true;
      }
      // Backup: kalau widget frame tidak terdeteksi (ada=false) tapi container
      // widget TERLIHAT di halaman utama — klik via koordinat. Ini menutup kasus
      // frame Turnstile yang tidak ke-enumerasi oleh page.frames() (sering terjadi
      // sesi 2+, profil browser hangat) sehingga checkbox tidak pernah diklik.
      if (!ada && (await klikTurnstileByKoordinat(page, onLog))) {
        waktuKlikWidgetTerakhir = Date.now();
        pernahKlik = true;
        onLog("🧩 Klik koordinat terkirim — menunggu solve...");
      }
    }

    // PENTING: state LOADING (ada=true, loading=true) BUKAN checkbox — jangan
    // set pernahAdaCheckbox (maknanya "checkbox benar-benar pernah muncul");
    // kalau sampai ter-set, cabang "mode invisible" tidak akan pernah aktif
    // lagi di sesi itu. Timer sejakKosong juga tidak dijalankan saat loading.
    if (ada && !loading) {
      pernahAdaCheckbox = true; // checkbox pernah muncul — widget checkbox beneran
      sejakKosong = 0;
    } else if (!ada && !loading && sejakKosong === 0) {
      sejakKosong = Date.now();
    }

    // Checkbox TIDAK PERNAH muncul dalam waktu lama → dicurigai mode
    // invisible/managed (tanpa checkbox, Turnstile solve saat submit).
    //
    // PENTING (fix dari REKAMAN): widget Turnstile butuh 30+ detik dalam state
    // "Checking your Browser…" sebelum menampilkan checkbox (hasil rekaman nyata:
    // frame widget ada, token kosong, BODY kosong selama ±30 detik). Batas lama
    // 15 detik TERLALU CEPAT menyerah → bot menyatakan "mode invisible" persis
    // saat checkbox akan muncul → form disubmit tanpa centang (gejala yang
    // dilaporkan: "bot tidak mencentang verify you are human"). Jadi:
    //   - Ambang menyerah dinaikkan: 15s → 40s.
    //   - Selama frame widget MASIH ADA & token kosong → JANGAN nyatakan
    //     invisible: tunggu terus & coba klik (checkbox yang render belakangan
    //     akan ke-klik oleh loop klik tiap ±8s). Kalau sampai deadline tidak
    //     juga solved → return false biar pemanggil PAUSE manual.
    //   - "Mode invisible" hanya diyakini kalau frame widget SUDAH TIDAK ADA
    //     (widget tidak pernah dirender sama sekali) atau token terisi.
    //
    // PENTING juga: jangan salah kaprah "tidak ada checkbox di frame" = frame-nya
    // saja yang tidak ke-enumerasi oleh page.frames() (sering sesi 2+, profil
    // hangat) padahal widget checkbox-nya TERLIHAT di halaman. Kalau container
    // widget terlihat (punya bounding box), itu BUKAN mode invisible — teruskan
    // klik koordinat, jangan menyerah.
    if (!ada && !pernahAdaCheckbox && sejakKosong > 0 && Date.now() - sejakKosong > 40000) {
      // Kalau container widget TERLIHAT (klikTurnstileByKoordinat mengembalikan
      // true), itu BUKAN mode invisible — frame-nya saja yang tidak ke-enumerasi.
      // Tetap klik koordinat & loop lagi, jangan menyerah.
      if (await klikTurnstileByKoordinat(page, onLog)) {
        pernahKlik = true;
        waktuKlikWidgetTerakhir = 0; // reset cooldown biar bisa klik lagi
        onLog("🧩 Container widget terlihat tapi frame tidak terdeteksi — tetap klik koordinat...");
        await sleep(200);
        continue;
      }

      const tokenAda = await page
        .locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')
        .first()
        .inputValue()
        .catch(() => "");
      const adaFrameWidget = page
        .frames()
        .some((f) => /challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(f.url() || ""));
      // Frame widget MASIH ADA & token belum terisi = challenge masih berjalan
      // ("Checking your Browser…" / checkbox belum muncul) — BUKAN auto-solve.
      // Tunggu terus & coba klik sampai deadline (deadline yang membatasi, bukan
      // cabang ini). Jangan set pernahAdaCheckbox=true di sini — kalau nanti
      // frame-nya hilang & token tetap kosong, cabang ini bisa menilai ulang.
      if (adaFrameWidget && !tokenAda) {
        // Kalau tombol submit jadi AKTIF = Turnstile auto-solve selesai (token
        // terisi server-side saat widget selesai memproses) → LANJUT submit,
        // jangan sampai PAUSE manual yang tidak perlu di sesi auto-solve.
        if (cekFormSiap && (await cekFormSiap())) {
          onLog("ℹ️ Form sudah siap — widget invisible/auto-solve selesai, lanjut.");
          return true;
        }
        onLog("ℹ️ Widget Turnstile masih memproses (tanpa checkbox & token belum terisi) — terus menunggu & coba klik...");
        sejakKosong = 0; // reset timer — jangan menyerah prematur
        await sleep(300);
        continue;
      }
      // Frame widget SUDAH TIDAK ADA & token kosong → tidak ada challenge yang
      // tersisa (auto-solve saat submit / interstitial lewat). Lanjut.
      onLog("ℹ️ Widget tanpa checkbox (mode invisible/auto-solve) — lanjut.");
      return true;
    }
    await sleep(200);
  }
  onLog(
    pernahKlik
      ? loadingLalu
        ? "⚠️ Challenge Cloudflare masih berjalan (timeout) — widget tidak pernah keluar dari 'Checking your Browser…'. Kemungkinan besar browser terdeteksi sebagai bot (CDP/headless) — coba profil browser asli yang bersih."
        : "⚠️ Challenge Cloudflare masih berjalan (timeout) — selesaikan manual."
      : "ℹ️ Challenge Cloudflare tidak bisa diklik otomatis."
  );
  return false;
}

// TUNGGU challenge "verify you are human" MUNCUL, lalu klik & selesaikan otomatis.
//
// Bedanya dengan tanganiCloudflare: di sini kita MENUNGGU widget/challenge
// benar-benar render dulu (polling) — widget Turnstile sering muncul beberapa
// detik SETELAH form diisi/di-submit, jadi cek sekali saja sering ketinggalan.
//
// Return:
//   true  = challenge beres ATAU tidak ada challenge sama sekali (aman lanjut)
//   false = challenge muncul tapi belum selesai (butuh intervensi manual)
export async function tungguVerifyDanKlik(page, onLog = () => {}, { timeoutMs = 45000, cekFormSiap } = {}) {
  const deadline = Date.now() + timeoutMs;

  // Fase 1: polling sampai challenge muncul (atau timeout = tidak ada challenge)
  while (Date.now() < deadline) {
    // PENTING: cek widget Turnstile DULU — kalau widget ada tapi belum solved,
    // jangan return walaupun tombol submit sudah aktif (tombol bisa aktif di DOM
    // sebelum Turnstile benar-benar solved; validasi server-side terjadi saat submit).
    const { ada: widgetAda, checked, token, loading } = await cekWidgetSolved(page);
    if (widgetAda && !token && checked !== true) {
      onLog("🧩 Widget Turnstile terdeteksi tapi belum solved — lanjut klik.");
      // MODE REKAM: widget baru muncul — langsung rekam struktur pertama kali
      // (paling penting: menangkap checkbox sebelum user sempat klik manual;
      // kalau masih "Checking your Browser…", loading=true ikut terekam).
      // jenis dihitung ulang supaya akurat (bukan hardcode "widget" — bisa jadi
      // frame interstitial yang false-positive).
      const jenisSaatIni = (await jenisChallengeCloudflare(page).catch(() => null)) || "widget";
      await rekamTurnstile(page, "WIDGET-MUNCUL", onLog, {
        jenis: jenisSaatIni,
        st: { ada: widgetAda, checked, token, loading },
        token,
      });
      break;
    }
    // form sudah siap duluan = tidak ada yang menahan, langsung selesai
    if (cekFormSiap && (await cekFormSiap())) {
      onLog("ℹ️ Form sudah siap — tidak ada yang menahan, lanjut.");
      return true;
    }
    const jenis = await jenisChallengeCloudflare(page);
    if (jenis !== null) break;
    const adaTeks = await page
      .getByText(/verify you are human|i'?m not a robot|i am human/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    if (adaTeks) break;
    await sleep(200);
  }

  // Kalau setelah menunggu tetap tidak muncul — tidak ada yang menahan, lanjut.
  const jenisAkhir = await jenisChallengeCloudflare(page);
  const adaTeksAkhir = await page
    .getByText(/verify you are human|i'?m not a robot|i am human/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (jenisAkhir === null && !adaTeksAkhir && !(cekFormSiap && (await cekFormSiap()))) {
    onLog("ℹ️ Tidak ada challenge 'verify you are human' — lanjut.");
    return true;
  }

  onLog("🧩 Challenge 'verify you are human' muncul — bot klik otomatis...");
  const sisa = Math.max(5000, deadline - Date.now());
  const beres = await tanganiCloudflare(page, onLog, { timeoutMs: sisa, cekFormSiap });
  onLog(
    beres
      ? "✅ Challenge 'verify you are human' selesai — lanjut."
      : "⚠️ Challenge 'verify you are human' belum selesai otomatis."
  );
  return beres;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
