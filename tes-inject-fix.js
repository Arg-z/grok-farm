// tes-inject-fix.js — uji cepat fix jalur inject (device-code Grok CLI)
// Memakai akun sboh1ctv@pondok77.web.id dari backup-20260809-232751
// (satu-satunya akun signed_up yang dulu gagal inject terus).
// Verifikasi: bot harus FAIL FAST dengan pesan jelas (bukan polling 30 menit).
import { readFileSync } from "fs";
import { injectKe9Router } from "./src/inject.js";

const cfg = JSON.parse(readFileSync("./config.json", "utf8"));
const semua = JSON.parse(readFileSync("./backup-20260809-232751/grok_accounts.json", "utf8"));
const emailTes = process.argv[2] || "sboh1ctv@pondok77.web.id";
const acc = semua.find((a) => a.email === emailTes);
if (!acc) {
  console.error(`Akun ${emailTes} tidak ada di backup.`);
  process.exit(1);
}
let storage = null;
try {
  storage = JSON.parse(readFileSync(`./backup-20260809-232751/cookies/${acc.email}.json`, "utf8"));
} catch {}

const t0 = Date.now();
console.log(`== TEST inject fix: ${acc.email} (status backup: ${acc.status}) ==`);
const hasil = await injectKe9Router({
  config: cfg,
  akun: { ...acc, storage },
  onLog: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`),
});
console.log(`HASIL: ${JSON.stringify(hasil)}`);
console.log(`DURASI: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
