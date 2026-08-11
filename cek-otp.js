#!/usr/bin/env node
// cek-otp.js — utilitas temp mail: generate email + baca OTP dari inbox.
//
// Cara pakai:
//   node cek-otp.js generate            -> buat email baru (via worker /api/generate)
//   node cek-otp.js poll <email>        -> polling inbox 2,5 menit, tampilkan email + kode OTP
//   node cek-otp.js mail <id>           -> tampilkan isi email lengkap (raw JSON)
//
// Membaca tempmailBaseUrl & domain dari config.json.

import { readFileSync } from "fs";
import { generateEmail, fetchInbox, fetchMail, ekstrakKode } from "./src/tempmail.js";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const base = config.tempmailBaseUrl;
const [cmd, arg] = process.argv.slice(2);

if (cmd === "generate") {
  const email = await generateEmail(base, config.domain);
  console.log(email);
} else if (cmd === "poll") {
  const email = arg;
  if (!email) {
    console.error("Usage: node cek-otp.js poll <email>");
    process.exit(1);
  }
  console.log(`📭 Polling inbox: ${email} (${base})`);
  let ketemu = false;
  for (let i = 1; i <= 30; i++) {
    let mails = [];
    try {
      mails = await fetchInbox(base, email);
    } catch (e) {
      console.log(`⚠️  ${e.message}`);
    }
    if (mails.length) {
      console.log(`📬 ${mails.length} email masuk:`);
      for (const m of mails) {
        const full = await fetchMail(base, m.id).catch(() => null);
        const kode = ekstrakKode(full?.subject || m.subject, full?.text || full?.body || full || "");
        console.log(`   - ${m.from} | ${m.subject}`);
        console.log(`     KODE OTP: ${kode ?? "(tidak ditemukan di email)"}`);
      }
      ketemu = true;
      break;
    }
    console.log(`⏳ belum ada email... (${i}/30)`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!ketemu) console.log("⏰ Habis waktu — belum ada email masuk.");
} else if (cmd === "mail") {
  if (!arg) {
    console.error("Usage: node cek-otp.js mail <id>");
    process.exit(1);
  }
  const full = await fetchMail(base, arg);
  console.log(JSON.stringify(full, null, 2));
} else {
  console.log(`Cara pakai:
  node cek-otp.js generate
  node cek-otp.js poll <email>
  node cek-otp.js mail <id>
(base: ${base})`);
}
