// cek-bulk.js — diagnosa singkat untuk fitur bulk inject
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ROOT } from "./src/state.js";

const accounts = JSON.parse(readFileSync(join(ROOT, "grok_accounts.json"), "utf8"));
const su = accounts.filter((a) => a.status === "signed_up");
const failed = accounts.filter((a) => a.status === "failed");
const injected = accounts.filter((a) => a.status === "injected");

console.log("Total:", accounts.length);
console.log("injected:", injected.length);
console.log("signed_up (belum inject):", su.length);
console.log("failed:", failed.length);

const dir = join(ROOT, "cookies");
const denganCookies = su.filter((a) => existsSync(join(dir, `${a.email}.json`)));
console.log("signed_up yg punya file cookies:", denganCookies.length);
console.log("signed_up tanpa file cookies:", su.length - denganCookies.length);

if (su[0]) {
  console.log("Contoh entry signed_up:", JSON.stringify({
    email: su[0].email,
    punyaStorageField: !!su[0].storage,
    keys: Object.keys(su[0]),
  }));
}
