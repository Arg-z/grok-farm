// rekam.js — MODE REKAM struktur widget Turnstile
//
// Saat bot TIDAK bisa klik otomatis checkbox "Verify you are human" (atau PAUSE
// menunggu klik manual), modul ini memotret struktur DOM widget (semua frame,
// elemen + shadow DOM, kandidat checkbox, token, status menurut logika bot) ke
// rekam-turnstile.log.
//
// Hasilnya dipakai untuk mengunci selector di cloudflare.js supaya sesi
// berikutnya bot klik otomatis (tanpa perlu PAUSE manual lagi).
//
// PENTING (arsitektur): modul ini TIDAK mengimpor dari cloudflare.js (cloudflare.js
// mengimpor rekamTurnstile dari sini untuk merekam di semua titik tunggu widget).
// Status bot (jenisChallengeCloudflare/cekWidgetSolved) dikirim PEMANGGIL lewat
// parameter `status` — kalau tidak dikirim, hanya token yang dicek langsung.
//
// File output: rekam-turnstile.log di root proyek (bukan rahasia — hanya
// struktur DOM; tetap di-.gitignore biar tidak membanjiri repo).
//
// Tidak pernah melempar error — aman dipanggil di alur mana pun.

import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_LOG = join(__dirname, "..", "rekam-turnstile.log");

// Dump elemen di dalam SATU frame (termasuk shadow DOM).
// Kembalikan array { tag, type, role, aria, cls, teks, vis, box }.
//
// PENTING (fix dari rekaman nyata): elemen 0x0/tersembunyi TIDAK di-skip lagi.
// Rekaman lama cuma menangkap HTML/BODY pada widget yang sedang "Checking your
// Browser…" — kalau checkbox asli ternyata dirender 0x0/display:none, dump lama
// tidak akan pernah melihatnya (dan diagnosa jadi buta). Sekarang SEMUA elemen
// direkam dengan penanda vis=false untuk yang tak terlihat.
export async function dumpElemenFrame(f) {
  try {
    return await f
      .evaluate(() => {
        const hasil = [];
        // Tag yang tidak pernah jadi kandidat checkbox — buang biar dump tidak
        // kebanjiran elemen 0x0 (script/style/meta tersembunyi).
        const TAG_SAMPING = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "NOSCRIPT"]);
        const walk = (root) => {
          for (const el of root.querySelectorAll("*")) {
            if (TAG_SAMPING.has(el.tagName)) continue;
            const r = el.getBoundingClientRect();
            const vis = r.width > 0 && r.height > 0;
            hasil.push({
              tag: el.tagName,
              type: el.getAttribute("type") || "",
              role: el.getAttribute("role") || "",
              aria: el.getAttribute("aria-checked") || "",
              cls: String(el.className || "").slice(0, 60),
              teks: (el.innerText || el.textContent || "").trim().slice(0, 40),
              vis,
              box: vis ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
            });
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        return hasil.slice(0, 80);
      })
      .catch((e) => [{ error: e.message }]);
  } catch {
    return [{ error: "dump frame gagal" }];
  }
}

// Format elemen jadi satu baris teks; tandai kandidat checkbox dengan ★.
// Elemen 0x0/tersembunyi diberi penanda [0x0/tersembunyi] supaya kelihatan
// (input checkbox asli sering tersembunyi — kehadirannya justru info penting).
// Objek error (dump frame gagal) ditampilkan apa adanya — JANGAN jadi <undefined>.
export function barisElemen(e) {
  if (!e || e.error) return `   ⚠️ ${(e && e.error) || "dump gagal"}`;
  const kandidat =
    e.type === "checkbox" || e.role === "checkbox" || /ctp-check|checkbox|marker/i.test(e.cls);
  // Entri dari dump MAIN (rekam-langsung.js) tidak punya field `vis` — fallback
  // ke keberadaan box: ada box = terlihat. Kalau vis eksplisit false → 0x0.
  const terlihat = e.vis === undefined ? Array.isArray(e.box) : e.vis;
  const ukuran = terlihat ? (Array.isArray(e.box) ? ` box=${JSON.stringify(e.box)}` : "") : " [0x0/tersembunyi]";
  return `   ${kandidat ? "★" : "·"} <${e.tag}${e.type ? ` type=${e.type}` : ""}${e.role ? ` role=${e.role}` : ""}${e.aria ? ` aria-checked=${e.aria}` : ""}${e.cls ? ` class="${e.cls}"` : ""}${e.teks ? ` teks="${e.teks}"` : ""}${ukuran}>`;
}

// Rekam keadaan widget Turnstile saat ini ke rekam-turnstile.log.
// `tag` = label konteks (mis. "SEBELUM-KLIK" / "SETELAH-KLIK" / "WIDGET-MUNCUL").
// `status` (opsional) = { jenis, st, token } dari logika bot — dihitung pemanggil
// (cloudflare.js punya akses ke helper-nya). Kalau tidak dikirim, cek token saja.
// Tahan banting: apa pun yang terjadi (halaman navigasi, frame hilang, error),
// tetap tulis apa yang bisa ditulis & jangan pernah lempar error ke pemanggil.
export async function rekamTurnstile(page, tag, onLog = () => {}, status = null) {
  try {
    const out = [];
    out.push("=".repeat(74));
    out.push(`REKAM TURNSTILE [${tag}] — ${new Date().toISOString()}`);
    out.push(`URL: ${page.url()}`);
    out.push("");

    // Status menurut logika bot (biar tahu apa yang bot lihat vs yang user lihat)
    if (status) {
      const { jenis, st, token } = status;
      out.push(`[BOT] jenisChallengeCloudflare: ${jenis}`);
      out.push(`[BOT] cekWidgetSolved: ${JSON.stringify(st)}`);
      out.push(`[BOT] token cf-turnstile-response: ${token ? token.slice(0, 40) + "..." : "(kosong)"}`);
    } else {
      // fallback: token dicek langsung dari DOM (pemanggil tidak kirim status)
      const token = await page
        .locator('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]')
        .first()
        .inputValue()
        .catch(() => "");
      out.push(`[BOT] token cf-turnstile-response: ${token ? token.slice(0, 40) + "..." : "(kosong)"}`);
    }
    out.push("");

    // Dump SEMUA frame: MAIN (elemen widget di top-level) + tiap frame widget.
    // PENTING: tiap frame di-try/catch SENDIRI — satu frame crash/detach (sering
    // terjadi di SETELAH-KLIK setelah halaman navigasi) TIDAK boleh menghapus
    // rekaman frame lainnya.
    for (const f of page.frames()) {
      try {
        const label = f === page.mainFrame() ? "MAIN" : (f.url() || "<kosong>").slice(0, 130);
        out.push(`[FRAME] ${label}`);
        if (f !== page.mainFrame()) {
          const els = await dumpElemenFrame(f);
          for (const e of els) out.push(barisElemen(e));
          // HTML mentah BODY frame (maks ±1500 char, whitespace diringkas) —
          // merekam elemen tersembunyi/shadow/0x0 yang tidak tertangkap dump
          // elemen (rekaman DEFINITIF; mis. struktur checkbox klasik .ctp-checkbox).
          // Hanya untuk frame WIDGET — iframe lain (iklan/analitik/about:blank)
          // tidak perlu, biar log tidak berisik.
          if (/challenges\.cloudflare|turnstile|hcaptcha|recaptcha/i.test(f.url() || "")) {
            const html = await f
              .evaluate(() => (document.body ? document.body.outerHTML : "(tidak ada BODY)"))
              .then((h) => h.replace(/\s+/g, " ").trim().slice(0, 1500))
              .catch(() => "(gagal ambil HTML)");
            out.push(`   [HTML BODY] ${html}`);
          }
        } else {
          // top-level: elemen widget turnstile yang terlihat di halaman utama
          const top = await page
            .evaluate(() => {
              const hasil = [];
              document
                .querySelectorAll(
                  '.cf-turnstile, .turnstile-wrapper, [data-sitekey], iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], textarea[name="cf-turnstile-response"]'
                )
                .forEach((el) => {
                  const r = el.getBoundingClientRect();
                  hasil.push(
                    `   ${el.tagName}${el.getAttribute("class") ? "." + String(el.getAttribute("class")).trim().split(/\s+/).join(".") : ""}${el.getAttribute("data-sitekey") ? ` [data-sitekey=${el.getAttribute("data-sitekey").slice(0, 20)}...]` : ""} src=${(el.getAttribute("src") || "").slice(0, 60)} box=[${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}]`
                  );
                });
              return hasil.length ? hasil : ["   (tidak ada elemen widget di top-level)"];
            })
            .catch((err) => [`   ⚠️ gagal dump top-level: ${err && err.message ? err.message : String(err)}`]);
          out.push(...top);
        }
        out.push("");
      } catch (e) {
        out.push(`   ⚠️ frame gagal: ${e && e.message ? e.message : String(e)}`);
        out.push("");
      }
    }

    appendFileSync(FILE_LOG, out.join("\n") + "\n");
    onLog(`📸 Rekaman Turnstile (${tag}) → rekam-turnstile.log`);
  } catch (e) {
    onLog(`⚠️ Gagal merekam Turnstile (${tag}): ${e.message}`);
  }
}
