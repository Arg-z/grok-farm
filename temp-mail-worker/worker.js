// temp-mail-worker/worker.js
// Self-hosted temp mail — Cloudflare Worker (Email Worker + HTTP) + Durable Object + KV.
//
// Binding yang diperlukan di Cloudflare:
// - KV namespace   -> binding: KV
// - Durable Object -> binding: MAILBOX, class: Mailbox   (ini yang bikin inbox instan)
// - Variable       -> DOMAIN = manurung.biz.id
//
// Kenapa versi lama lambat:
// - env.KV.get() di-cache per lokasi minimal 60 detik. Polling 5 detik tetap membaca
//   hasil lama sampai cache kedaluwarsa, walaupun email sudah tersimpan.
// - /api/inbox membaca isi tiap email satu per satu: 1 + N round trip.
// - Handler email melakukan 4 operasi KV berurutan.
//
// Sekarang:
// - Durable Object strongly consistent: email langsung terbaca setelah ditulis.
// - /api/inbox?wait=1 long-poll, request ditahan sampai ada email (push, bukan poll).
// - Metadata inbox disimpan dalam satu value -> 1 read, bukan N.
// - KV tetap jadi cadangan kalau binding MAILBOX belum dipasang.

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_DOMAIN = "manurung.biz.id";
const TTL = 7 * 24 * 60 * 60; // 7 hari
const ADDRESS_LENGTH = 10;
const MAX_EMAILS_PER_INBOX = 100;
const WAIT_TIMEOUT_MS = 25000; // lama request long-poll ditahan

// ============================================================
// DURABLE OBJECT — satu instance per alamat email
// ============================================================

export class Mailbox {
  constructor(state) {
    this.state = state;
    this.waiters = new Set();
  }

  async list() {
    return (await this.state.storage.get("list")) || [];
  }

  // Bangunkan semua long-poll yang sedang menunggu.
  notify(list) {
    for (const resolve of this.waiters) resolve(list);
    this.waiters.clear();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "";

    switch (url.pathname) {
      case "/put": {
        const rec = await request.json();
        const list = await this.list();

        const next = [
          { id: rec.id, from: rec.from, subject: rec.subject, date: rec.date },
          ...list.filter((m) => m.id !== rec.id),
        ];

        const kept = next.slice(0, MAX_EMAILS_PER_INBOX);
        const dropped = next.slice(MAX_EMAILS_PER_INBOX);

        await this.state.storage.put({ [`mail:${rec.id}`]: rec, list: kept });
        if (dropped.length) {
          await this.state.storage.delete(dropped.map((m) => `mail:${m.id}`));
        }

        // Buang seluruh mailbox setelah TTL, meniru expirationTtl KV.
        await this.state.storage.setAlarm(Date.now() + TTL * 1000);

        this.notify(kept);
        return json({ success: true });
      }

      case "/list":
        return json(await this.list());

      case "/wait": {
        const known = url.searchParams.get("cursor") || "";
        const list = await this.list();
        if (cursorOf(list) !== known) return json(list);

        return new Promise((resolve) => {
          const done = (value) => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve(json(value));
          };
          const timer = setTimeout(() => done(list), WAIT_TIMEOUT_MS);
          this.waiters.add(done);
        });
      }

      case "/get": {
        const rec = await this.state.storage.get(`mail:${id}`);
        if (!rec) return json({ error: "Email tidak ditemukan." }, 404);
        return json(rec);
      }

      case "/del": {
        const list = await this.list();
        const kept = list.filter((m) => m.id !== id);
        await this.state.storage.delete(`mail:${id}`);
        await this.state.storage.put("list", kept);
        this.notify(kept);
        return json({ success: true });
      }

      default:
        return json({ error: "Unknown action." }, 404);
    }
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// Berubah setiap kali inbox berubah, dipakai long-poll untuk deteksi perubahan.
function cursorOf(list) {
  return `${list.length}:${list[0] ? list[0].id : ""}`;
}

// ============================================================
// AKSES DURABLE OBJECT
// ============================================================

function mailbox(env, address) {
  if (!env.MAILBOX) return null;
  return env.MAILBOX.get(env.MAILBOX.idFromName(address));
}

function callMailbox(stub, path, init) {
  return stub.fetch(`https://mailbox.internal${path}`, init);
}

// ============================================================
// WORKER
// ============================================================

export default {
  // ==========================================================
  // EMAIL HANDLER — Cloudflare Email Routing -> Worker
  // ==========================================================

  async email(message, env) {
    const domain = normalizeAddress(env.DOMAIN || DEFAULT_DOMAIN);
    const to = normalizeAddress(message.to);
    const from = String(message.from || "").trim();

    console.log("EMAIL MASUK:", from, "->", to);

    if (!to || !to.endsWith("@" + domain)) {
      console.error("Alamat tujuan tidak sesuai domain:", to);
      return;
    }

    let raw = "";
    try {
      raw = await new Response(message.raw).text();
    } catch (error) {
      console.error("Gagal membaca message.raw:", error);
    }

    const parsed = parseEmail(raw);

    const rec = {
      id: crypto.randomUUID(),
      from,
      to,
      subject: parsed.subject || message.headers.get("subject") || "(Tanpa Subjek)",
      date: new Date().toISOString(),
      text: parsed.text || "(Tidak ada isi email)",
      html: parsed.html || "",
    };

    // 1. Durable Object dulu: begitu ini selesai, inbox sudah bisa membacanya
    //    dan long-poll yang sedang menunggu langsung terbangun.
    const stub = mailbox(env, to);

    if (stub) {
      try {
        await callMailbox(stub, "/put", {
          method: "POST",
          body: JSON.stringify(rec),
        });
        console.log("EMAIL MASUK KE MAILBOX:", rec.id, to);
      } catch (error) {
        console.error("GAGAL MENULIS KE MAILBOX:", error);
      }
    }

    // 2. Cadangan KV. Metadata ikut disimpan di dalam daftar inbox supaya
    //    /api/inbox cukup satu read, bukan satu read per email.
    if (!env.KV) {
      if (!stub) console.error("Tidak ada binding MAILBOX maupun KV.");
      return;
    }

    try {
      const inboxKey = `inbox:${to}`;
      let inbox = [];

      try {
        const existing = await env.KV.get(inboxKey, "json");
        if (Array.isArray(existing)) inbox = existing.map(toMeta);
      } catch (error) {
        console.error("Gagal membaca inbox lama:", error);
      }

      const next = [
        { id: rec.id, from: rec.from, subject: rec.subject, date: rec.date },
        ...inbox.filter((m) => m && m.id !== rec.id),
      ].slice(0, MAX_EMAILS_PER_INBOX);

      await Promise.all([
        env.KV.put(`mail:${rec.id}`, JSON.stringify(rec), { expirationTtl: TTL }),
        env.KV.put(inboxKey, JSON.stringify(next), { expirationTtl: TTL }),
      ]);

      console.log("EMAIL BERHASIL DISIMPAN:", rec.id, to);
    } catch (error) {
      console.error("GAGAL MENYIMPAN EMAIL:", error);
    }
  },

  // ==========================================================
  // HTTP
  // ==========================================================

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const domain = normalizeAddress(env.DOMAIN || DEFAULT_DOMAIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ========================================================
    // HEALTH CHECK
    // ========================================================

    if (path === "/api/health") {
      let kvOK = false;

      try {
        await env.KV.put("system:health", "ok", { expirationTtl: 60 });
        kvOK = (await env.KV.get("system:health")) === "ok";
      } catch (error) {
        console.error("KV HEALTH ERROR:", error);
      }

      return json({
        success: true,
        worker: "online",
        domain,
        kv: kvOK,
        mailbox: !!env.MAILBOX,
        mode: env.MAILBOX ? "durable-object" : "kv",
      });
    }

    // ========================================================
    // GENERATE EMAIL
    // ========================================================

    if (path === "/api/new") {
      try {
        const address = `${randomString(ADDRESS_LENGTH)}@${domain}`;

        // Pendaftaran alamat tidak perlu ditunggu klien: ruang acaknya 36^10,
        // jadi tabrakan praktis nol dan catch-all menerima alamat apa pun.
        const register = env.KV
          ? env.KV.put(
              `addr:${address}`,
              JSON.stringify({ address, createdAt: new Date().toISOString() }),
              { expirationTtl: TTL }
            ).catch((error) => console.error("REGISTER ERROR:", error))
          : null;

        if (register && ctx) ctx.waitUntil(register);

        console.log("EMAIL GENERATED:", address);

        return json({ success: true, address, email: address, domain });
      } catch (error) {
        console.error("GENERATE ERROR:", error);
        return json({ success: false, error: "Gagal membuat alamat email." }, 500);
      }
    }

    // ========================================================
    // CHECK ADDRESS
    // ========================================================

    if (path === "/api/check") {
      const address = normalizeAddress(url.searchParams.get("address"));

      if (!isValidAddress(address, domain)) {
        return json({ valid: false, address });
      }

      try {
        const exists = await env.KV.get(`addr:${address}`);
        return json({ valid: !!exists, address });
      } catch (error) {
        console.error("CHECK ERROR:", error);
        return json({ valid: false, address });
      }
    }

    // ========================================================
    // INBOX
    //
    // ?wait=1&cursor=... -> long-poll: request ditahan sampai ada
    // email baru, jadi email tampil seketika tanpa menunggu polling.
    // ========================================================

    if (path === "/api/inbox") {
      const address = normalizeAddress(url.searchParams.get("address"));

      if (!isValidAddress(address, domain)) {
        return json({ mails: [], cursor: "" });
      }

      const stub = mailbox(env, address);

      // --- Jalur cepat: Durable Object, strongly consistent ---
      if (stub) {
        try {
          const wait = url.searchParams.get("wait") === "1";
          const cursor = url.searchParams.get("cursor") || "";

          const response = await callMailbox(
            stub,
            wait
              ? `/wait?cursor=${encodeURIComponent(cursor)}`
              : "/list"
          );

          const mails = await response.json();
          return json({ mails, cursor: cursorOf(mails) });
        } catch (error) {
          console.error("MAILBOX INBOX ERROR:", error);
          // jatuh ke KV di bawah
        }
      }

      // --- Cadangan: KV (tertinggal sampai 60 detik karena cache KV) ---
      if (!env.KV) {
        return json({ error: "Tidak ada binding MAILBOX maupun KV." }, 500);
      }

      try {
        const entries = await env.KV.get(`inbox:${address}`, "json");

        if (!Array.isArray(entries) || entries.length === 0) {
          return json({ mails: [], cursor: "" });
        }

        // Format baru sudah menyimpan metadata di dalam daftar (1 read).
        // Format lama hanya berisi ID, jadi perlu dibaca — tapi paralel.
        const mails = (
          await Promise.all(
            entries.map(async (entry) => {
              if (entry && typeof entry === "object" && entry.id) return toMeta(entry);

              const id = String(entry || "");
              if (!id) return null;

              try {
                const rec = await env.KV.get(`mail:${id}`, "json");
                if (!rec || normalizeAddress(rec.to) !== address) return null;
                return toMeta(rec);
              } catch (error) {
                console.error("READ MAIL ERROR:", error);
                return null;
              }
            })
          )
        ).filter(Boolean);

        mails.sort((a, b) => new Date(b.date) - new Date(a.date));

        return json({ mails, cursor: cursorOf(mails) });
      } catch (error) {
        console.error("INBOX ERROR:", error);
        return json({ error: "Gagal membaca inbox.", detail: String(error) }, 500);
      }
    }

    // ========================================================
    // DELETE EMAIL — harus sebelum GET /api/mail
    // ========================================================

    if (path === "/api/mail" && request.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      const address = normalizeAddress(url.searchParams.get("address"));

      if (!id) return json({ error: "ID email kosong." }, 400);

      try {
        const stub = address && isValidAddress(address, domain) ? mailbox(env, address) : null;

        if (stub) {
          await callMailbox(stub, `/del?id=${encodeURIComponent(id)}`, { method: "POST" });
        }

        if (env.KV) {
          const rec = await env.KV.get(`mail:${id}`, "json");

          if (rec) {
            const inboxKey = `inbox:${rec.to}`;
            const entries = await env.KV.get(inboxKey, "json");

            const updates = [
              env.KV.delete(`mail:${id}`),
              env.KV.delete(`idx:${rec.to}:${id}`),
            ];

            if (Array.isArray(entries)) {
              const kept = entries.filter((entry) =>
                typeof entry === "object" && entry ? entry.id !== id : entry !== id
              );

              updates.push(
                env.KV.put(inboxKey, JSON.stringify(kept), { expirationTtl: TTL })
              );
            }

            await Promise.all(updates);
          }
        }

        return json({ success: true });
      } catch (error) {
        console.error("DELETE ERROR:", error);
        return json({ error: "Gagal menghapus email." }, 500);
      }
    }

    // ========================================================
    // READ EMAIL
    // ========================================================

    if (path === "/api/mail" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const address = normalizeAddress(url.searchParams.get("address"));

      if (!id) return json({ error: "ID email kosong." }, 400);

      try {
        const stub = address && isValidAddress(address, domain) ? mailbox(env, address) : null;

        if (stub) {
          const response = await callMailbox(stub, `/get?id=${encodeURIComponent(id)}`);
          if (response.ok) return json(await response.json());
        }

        const rec = env.KV ? await env.KV.get(`mail:${id}`, "json") : null;

        if (!rec) {
          return json({ error: "Email tidak ditemukan atau sudah expired." }, 404);
        }

        return json(rec);
      } catch (error) {
        console.error("READ EMAIL ERROR:", error);
        return json({ error: "Gagal membaca email." }, 500);
      }
    }

    // ========================================================
    // WEB UI
    // ========================================================

    return new Response(UI_HTML.replaceAll("__DOMAIN__", escapeHtml(domain)), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...corsHeaders(),
      },
    });
  },
};

// ============================================================
// HELPERS
// ============================================================

function toMeta(rec) {
  return { id: rec.id, from: rec.from, subject: rec.subject, date: rec.date };
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let result = "";
  for (let i = 0; i < length; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidAddress(address, domain) {
  if (!address) return false;

  const suffix = "@" + domain.toLowerCase();
  if (!address.endsWith(suffix)) return false;

  return /^[a-z0-9]{10}$/.test(address.slice(0, -suffix.length));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ============================================================
// EMAIL PARSER
// ============================================================

function parseEmail(raw) {
  if (!raw) return { subject: "", text: "", html: "" };

  const end = findHeaderEnd(raw);
  const headerText = end.index >= 0 ? raw.slice(0, end.index) : raw;
  const body = end.index >= 0 ? raw.slice(end.index + end.length) : "";
  const headers = parseHeaders(headerText);

  const collected = collectBody(
    body,
    headers["content-type"] || "",
    headers["content-transfer-encoding"] || ""
  );

  return {
    subject: decodeMimeHeader(headers.subject || ""),
    text: collected.text.trim() || htmlToText(collected.html),
    html: collected.html.trim(),
  };
}

// Rekursif, supaya multipart/alternative yang bersarang di dalam
// multipart/mixed (email dengan lampiran) isinya tetap terbaca.
function collectBody(body, contentType, transfer, depth = 0) {
  const type = String(contentType || "").toLowerCase();
  const boundary = getBoundary(contentType || "");

  if (boundary && depth < 5) {
    let text = "";
    let html = "";

    for (const part of splitMultipart(body, boundary)) {
      const end = findHeaderEnd(part);
      const partHeaders = end.index >= 0 ? parseHeaders(part.slice(0, end.index)) : {};
      const partBody = end.index >= 0 ? part.slice(end.index + end.length) : part;

      const inner = collectBody(
        partBody,
        partHeaders["content-type"] || "",
        partHeaders["content-transfer-encoding"] || "",
        depth + 1
      );

      text += inner.text;
      html += inner.html;
    }

    return { text, html };
  }

  // Lampiran biner tidak perlu ikut ditampilkan.
  if (/^(image|audio|video|application)\//.test(type)) {
    return { text: "", html: "" };
  }

  const decoded = decodeTransferEncoding(body, transfer);

  return type.includes("text/html")
    ? { text: "", html: decoded + "\n" }
    : { text: decoded + "\n", html: "" };
}

function findHeaderEnd(raw) {
  const crlf = raw.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };

  const lf = raw.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };

  return { index: -1, length: 0 };
}

function parseHeaders(text) {
  const lines = text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const headers = {};

  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;

    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return headers;
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;

  return (match[1] || match[2]).trim();
}

function splitMultipart(body, boundary) {
  const chunks = body.split("--" + boundary);
  const parts = [];

  for (let i = 1; i < chunks.length; i++) {
    let part = chunks[i];
    if (part.startsWith("--")) break;

    part = part.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (part.trim()) parts.push(part);
  }

  return parts;
}

function decodeTransferEncoding(body, encoding) {
  const type = String(encoding || "").toLowerCase();

  if (type.includes("base64")) {
    try {
      return decodeBase64(body);
    } catch {
      return body;
    }
  }

  if (type.includes("quoted-printable")) return decodeQuotedPrintable(body);

  return body;
}

function decodeBase64(input) {
  const clean = input
    .replace(/\s/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const binary = atob(clean);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new TextDecoder("utf-8").decode(bytes);
}

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeHeader(value) {
  if (!value) return "";

  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (match, charset, encoding, data) => {
      try {
        if (encoding.toLowerCase() === "b") {
          const binary = atob(data);
          const bytes = new Uint8Array(binary.length);

          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          return new TextDecoder(normalizeCharset(charset)).decode(bytes);
        }

        return decodeQuotedPrintable(data.replace(/_/g, " "));
      } catch {
        return data;
      }
    }
  );
}

function normalizeCharset(charset) {
  const value = String(charset || "").toLowerCase();

  if (value.includes("iso-8859")) return "iso-8859-1";
  return "utf-8";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// WEB UI
// ============================================================

const UI_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Temp Mail - __DOMAIN__</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, Arial, sans-serif;
  background: linear-gradient(135deg, #eef2ff, #f8fafc);
  color: #172033;
  min-height: 100vh;
}
.container { max-width: 900px; margin: 45px auto; padding: 20px; }
card {
  background: white;
  border-radius: 20px;
  padding: 28px;
  box-shadow: 0 15px 50px rgba(0,0,0,.10);
}
h1 { margin-top: 0; text-align: center; }
.subtitle { text-align: center; color: #667085; }
.address-box { display: flex; gap: 10px; margin-top: 25px; }
.address {
  flex: 1;
  background: #f2f4f7;
  border: 1px solid #d0d5dd;
  border-radius: 12px;
  padding: 15px;
  font-family: monospace;
  font-size: 16px;
  overflow-wrap: anywhere;
}
button { border: 0; border-radius: 10px; padding: 12px 18px; cursor: pointer; font-weight: 700; }
.primary { background: #111827; color: white; }
.secondary { background: #e5e7eb; color: #111827; }
.actions { display: flex; gap: 10px; margin-top: 15px; }
.status { margin-top: 18px; text-align: center; color: #667085; }
.live { color: #067647; }
.inbox { margin-top: 25px; border: 1px solid #eaecf0; border-radius: 12px; overflow: hidden; }
.mail { padding: 17px; border-bottom: 1px solid #eaecf0; cursor: pointer; }
.mail:last-child { border-bottom: 0; }
.mail:hover { background: #f9fafb; }
.mail.baru { background: #f0fdf4; }
.mail-subject { font-weight: 700; }
.mail-from { font-size: 13px; color: #667085; margin-top: 5px; }
.mail-date { font-size: 12px; color: #98a2b3; margin-top: 5px; }
.empty { padding: 40px; text-align: center; color: #667085; }
.modal {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.55);
  padding: 20px;
  z-index: 100;
}
.modal-content {
  background: white;
  max-width: 850px;
  max-height: 90vh;
  overflow: auto;
  margin: 30px auto;
  border-radius: 15px;
  padding: 25px;
}
.close { float: right; font-size: 24px; cursor: pointer; }
.email-info { padding-bottom: 15px; border-bottom: 1px solid #eaecf0; margin-bottom: 20px; }
.email-body { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
@media(max-width:600px) {
  .container { margin: 10px auto; }
  .card { padding: 18px; }
  .address-box, .actions { flex-direction: column; }
}
</style>
</head>
<body>
<div class="container">
<div class="card">
<h1>&#128236; Temp Mail</h1>
<div class="subtitle">Temporary email untuk <strong>__DOMAIN__</strong></div>

<div class="address-box">
<div id="address" class="address">Membuat alamat...</div>
<button class="secondary" onclick="copyAddress()">Copy</button>
</div>

<div class="actions">
<button class="primary" onclick="newAddress()">Generate Email Baru</button>
<button class="secondary" onclick="refresh()">Refresh</button>
</div>

<div id="status" class="status">Menyiapkan inbox...</div>

<div class="inbox">
<div id="inbox"><div class="empty">&#128235; Belum ada email masuk</div></div>
</div>
</div>
</div>

<div id="modal" class="modal" onclick="closeModal(event)">
<div class="modal-content" onclick="event.stopPropagation()">
<span class="close" onclick="hideModal()">&times;</span>
<div id="email"></div>
</div>
</div>

<script>
var currentAddress = "";
var cursor = "";
var pumping = false;
var seen = {};
var firstRender = true;

function $(id) { return document.getElementById(id); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function setStatus(text, live) {
  var el = $(id);
  el.textContent = text;
  el.className = live ? "status live" : "status";
}

function showEmpty() {
  $("inbox").innerHTML = '<div class="empty">&#128235; Belum ada email masuk</div>';
}

// ==========================================================
// GENERATE
// ==========================================================

async function newAddress() {
  try {
    setStatus("Membuat alamat email...");

    var response = await fetch("/api/new");
    var data = await response.json();

    if (!response.ok || !data.success || !data.email) {
      throw new Error(data.error || "Gagal membuat email.");
    }

    currentAddress = data.email;
    cursor = "";
    seen = {};
    firstRender = true;

    $("address").textContent = currentAddress;
    localStorage.setItem("temp_mail_address", currentAddress);
    showEmpty();

    setStatus("Inbox aktif. Menunggu email...", true);
    pump();
  } catch (error) {
    console.error(error);
    setStatus("Gagal membuat alamat email.");
  }
}

// ==========================================================
// RENDER
// ==========================================================

function render(mails) {
  var inbox = $("inbox");

  if (!Array.isArray(mails) || mails.length === 0) {
    showEmpty();
    setStatus("Inbox aktif, belum ada email", true);
    return;
  }

  inbox.innerHTML = "";

  mails.forEach(function (mail) {
    var item = document.createElement("div");
    item.className = !firstRender && !seen[mail.id] ? "mail baru" : "mail";
    seen[mail.id] = true;

    var subject = document.createElement("div");
    subject.className = "mail-subject";
    subject.textContent = mail.subject || "(Tanpa Subjek)";

    var from = document.createElement("div");
    from.className = "mail-from";
    from.textContent = "Dari: " + (mail.from || "(Tidak diketahui)");

    var date = document.createElement("div");
    date.className = "mail-date";
    try {
      date.textContent = new Date(mail.date).toLocaleString("id-ID");
    } catch (error) {
      date.textContent = mail.date || "";
    }

    item.appendChild(subject);
    item.appendChild(from);
    item.appendChild(date);
    item.onclick = function () { openMail(mail.id); };

    inbox.appendChild(item);
  });

  firstRender = false;
  setStatus(mails.length + " email masuk", true);
}

// ==========================================================
// LONG POLL
//
// Request ditahan server sampai ada email baru, jadi email
// langsung tampil. Kalau server menjawab cepat (mode KV,
// tanpa Durable Object), otomatis turun ke polling 3 detik.
// ==========================================================

async function pump() {
  if (pumping) return;
  pumping = true;

  while (currentAddress) {
    var address = currentAddress;
    var started = Date.now();

    try {
      var response = await fetch(
        "/api/inbox?wait=1&address=" + encodeURIComponent(address) +
        "&cursor=" + encodeURIComponent(cursor)
      );

      var data = await response.json();

      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      if (address !== currentAddress) continue;

      var changed = (data.cursor || "") !== cursor;
      cursor = data.cursor || "";
      render(data.mails || []);

      // Server tidak menahan request -> jangan membanjiri.
      if (!changed && Date.now() - started < 1000) await sleep(3000);
    } catch (error) {
      console.error("INBOX:", error);
      setStatus("Koneksi inbox terputus, mencoba lagi...");
      await sleep(3000);
    }
  }

  pumping = false;
}

async function refresh() {
  if (!currentAddress) return;

  try {
    var response = await fetch("/api/inbox?address=" + encodeURIComponent(currentAddress));
    var data = await response.json();

    if (!response.ok) throw new Error(data.error || "Gagal membaca inbox.");

    cursor = data.cursor || "";
    render(data.mails || []);
  } catch (error) {
    console.error(error);
    setStatus("Gagal mengambil inbox.");
  }
}

// ==========================================================
// OPEN EMAIL
// ==========================================================

async function openMail(id) {
  try {
    var response = await fetch(
      "/api/mail?id=" + encodeURIComponent(id) +
      "&address=" + encodeURIComponent(currentAddress)
    );

    var mail = await response.json();

    if (!response.ok || mail.error) {
      throw new Error(mail.error || "Email tidak ditemukan.");
    }

    var date = "";
    try {
      date = new Date(mail.date).toLocaleString("id-ID");
    } catch (error) {
      date = mail.date || "";
    }

    $("email").innerHTML =
      '<div class="email-info">' +
      '<h2>' + escapeHtml(mail.subject || "(Tanpa Subjek)") + '</h2>' +
      '<div><strong>Dari:</strong> ' + escapeHtml(mail.from || "") + '</div>' +
      '<div><strong>Ke:</strong> ' + escapeHtml(mail.to || "") + '</div>' +
      '<div><strong>Waktu:</strong> ' + escapeHtml(date) + '</div>' +
      '</div>' +
      '<div class="email-body">' +
      escapeHtml(mail.text || "(Tidak ada isi email)") +
      '</div>';

    $("modal").style.display = "block";
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

// ==========================================================
// MODAL
// ==========================================================

function hideModal() { $("modal").style.display = "none"; }

function closeModal(event) {
  if (event.target.id === "modal") hideModal();
}

// ==========================================================
// COPY
// ==========================================================

async function copyAddress() {
  if (!currentAddress) return;

  try {
    await navigator.clipboard.writeText(currentAddress);
    setStatus("Alamat berhasil disalin.");
  } catch (error) {
    alert(currentAddress);
  }
}

// ==========================================================
// ESCAPE
// ==========================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==========================================================
// START
// ==========================================================

async function start() {
  var saved = localStorage.getItem("temp_mail_address");

  if (saved) {
    currentAddress = saved;
    $("address").textContent = currentAddress;
    setStatus("Inbox aktif. Menunggu email...", true);
    pump();
  } else {
    await newAddress();
  }
}

start();
</script>
</body>
</html>`;
