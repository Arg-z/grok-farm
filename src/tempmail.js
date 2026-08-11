// tempmail.js — klien API temp mail (Cloudflare Worker)
// Endpoint:
//   GET /api/inbox?address=<email>  -> array email {id, from, subject, ...}
//   GET /api/mail?id=<id>           -> isi email lengkap
//   GET /api/otp?address=<email>    -> { code, email } (fast path, worker versi baru)

// Generate email: pakai API worker (/api/generate) kalau tersedia,
// fallback ke pembuatan lokal dengan format yang sama (8 karakter a-z0-9).
export async function generateEmail(baseUrl, domain) {
  if (baseUrl) {
    // Coba /api/generate (worker versi baru), lalu /api/new (worker versi lama)
    for (const path of ["/api/generate", "/api/new"]) {
      try {
        const res = await fetch(`${baseUrl}${path}`);
        if (res.ok) {
          const d = await res.json();
          if (d && d.email) return d.email;
        }
      } catch {}
    }
  }
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s}@${domain}`;
}

export async function fetchInbox(baseUrl, address) {
  const res = await fetch(`${baseUrl}/api/inbox?address=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Temp mail inbox error: HTTP ${res.status}`);
  const data = await res.json();
  // Terima dua bentuk: array polos (worker baru) atau { mails: [...], cursor } (worker lama)
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.mails)) return data.mails;
  throw new Error(
    "KV tempmail belum aktif: email masuk diteruskan ke Gmail (jaultopsiregar8@gmail.com), bukan ke inbox API. Cek status KV di situs tempmail."
  );
}

// Worker lama butuh param `address` juga — coba dengan address dulu, fallback tanpa.
export async function fetchMail(baseUrl, id, address) {
  const q = `?id=${encodeURIComponent(id)}` + (address ? `&address=${encodeURIComponent(address)}` : "");
  const res = await fetch(`${baseUrl}/api/mail${q}`);
  if (!res.ok) throw new Error(`Temp mail mail error: HTTP ${res.status}`);
  return res.json();
}

// ── decode & bersihkan email mentah ────────────────────────────────
// Email dari worker pondok77 disimpan sebagai RAW MIME (header + body
// quoted-printable). Kita decode QP dulu, buang header/tag HTML, baru cari kode.
function decodeQuotedPrintable(s) {
  if (typeof s !== "string") return "";
  // soft line break: '=' di akhir baris dihapus
  s = s.replace(/=\r?\n/g, "");
  // '=XX' -> karakter ascii
  return s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function bersihkanEmail(raw) {
  let t = String(raw || "");
  // Decode quoted-printable hanya kalau ada ciri-cirinya (hindari merusak base64)
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(t) || /=\r?\n|=3D|=20|=2C|=\?us-ascii/i.test(t)) {
    t = decodeQuotedPrintable(t);
  }
  return t
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

// Cari kode verifikasi di email x.ai (atau layanan lain).
// Format kode x.ai sekarang BUKAN angka lagi — contoh: "confirmation code: TYO-HEO"
// (huruf/angka + strip). Tetap dukung angka 4-8 digit untuk layanan lain.
export function ekstrakKode(subject, body) {
  const raw = `${subject || ""}\n${typeof body === "string" ? body : JSON.stringify(body || {})}`;
  const text = bersihkanEmail(raw);

  // 1. Kode dekat kata kunci — dukung dua bentuk: XXX-XXX (x.ai) dan digit (layanan lain)
  const pola = [
    /(?:confirmation code|verification code|one[- ]?time code|security code|code|otp|kode|verifikasi|verify|passcode|pin)\D{0,30}?\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/i,
    /(?:confirmation code|verification code|one[- ]?time code|security code|code|otp|kode|verifikasi|verify|passcode|pin)\D{0,20}?\b(\d{4,8})\b/i,
  ];
  for (const re of pola) {
    const m = text.match(re);
    if (m) return m[1];
  }

  // 2. Kode XXX-XXX di mana pun (biasanya di subject: "confirmation code: TYO-HEO")
  const dash = text.match(/\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/);
  if (dash) return dash[1];

  // 3. Fallback angka: 6 digit utuh, lalu 4-8 digit mana pun
  const enam = text.match(/\b(\d{6})\b/);
  if (enam) return enam[1];
  const acak = text.match(/\b(\d{4,8})\b/);
  return acak ? acak[1] : null;
}

// Fast path: minta worker mengekstrak kode OTP langsung (/api/otp).
// Kalau worker masih versi lama atau gagal, return null -> polling manual tetap dipakai.
export async function fetchOtp(baseUrl, address) {
  try {
    const res = await fetch(`${baseUrl}/api/otp?address=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    // Worker lama mengembalikan HTML (bukan JSON) — cek Content-Type dulu supaya
    // tidak menunggu/parse HTML yang salah.
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
    const d = await res.json();
    if (d && d.code && d.email) return { code: String(d.code), emailId: d.email.id };
    return null;
  } catch {
    return null;
  }
}

// Polling inbox sampai kode verifikasi masuk. Lempar error kalau timeout.
// `seenIds` (Set) dipakai untuk lintas panggilan: kode yang sudah dipakai/ditolak
// tidak diambil ulang — panggilan berikutnya menunggu kode BARU dari email baru.
export async function pollKodeVerifikasi({ baseUrl, email, timeoutMs, onLog, matchSubject, seenIds }) {
  const tracked = seenIds || new Set();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Fast path: /api/otp (hanya saat tanpa filter subject, karena filter hanya
    // diketahui bot, bukan worker). Kalau kode lama (emailId sudah di seenIds),
    // lanjut ke polling penuh untuk menunggu kode baru.
    if (!matchSubject) {
      const hit = await fetchOtp(baseUrl, email);
      if (hit && !tracked.has(hit.emailId)) {
        tracked.add(hit.emailId);
        // /api/otp sudah membawa metadata email; kalau ambil isi lengkap gagal,
        // jangan kembalikan null — pakai metadata yang sudah ada biar pemanggil aman.
        const mail = (await fetchMail(baseUrl, hit.emailId, email).catch(() => null)) || hit.email;
        return { kode: hit.code, mail };
      }
    }

    let inbox;
    try {
      inbox = await fetchInbox(baseUrl, email);
    } catch (e) {
      onLog?.(`⚠️  Gagal polling inbox: ${e.message}`);
      await sleep(1200);
      continue;
    }

    for (const item of inbox) {
      if (tracked.has(item.id)) continue;
      if (matchSubject && !`${item.subject || ""}`.toLowerCase().includes(matchSubject.toLowerCase())) {
        continue;
      }
      const mail = await fetchMail(baseUrl, item.id, email).catch(() => null);
      if (!mail) continue;
      const kode = ekstrakKode(mail.subject || item.subject, mail.text || mail.body || mail);
      tracked.add(item.id);
      if (kode) return { kode, mail };
    }

    onLog?.(`📬 ${inbox.length} email di inbox, menunggu kode verifikasi...`);
    await sleep(1200);
  }
  throw new Error(`Timeout ${Math.round(timeoutMs / 1000)}s menunggu kode verifikasi di ${email}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
