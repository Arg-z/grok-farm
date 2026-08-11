<div align="center">

# 🌾 GROK FARM

**Farm akun Grok/xAI otomatis: SIGNUP → INJECT 9Router → SAVE**
Bot headful berbasis browser asli (Chrome) + solver Turnstile lokal gratis (EzSolver).

</div>

## Alur

```text
START
└─ Loop akun 1 → N (tanpa jeda antar akun)

SIGNUP (accounts.x.ai)
├─ Generate email tempmail
├─ Buka signup → isi email → ambil OTP
├─ Isi nama + password
├─ Solve Turnstile (EzSolver lokal → inject token)
└─ Complete → status: signed_up

INJECT (9Router Grok CLI)
├─ Bypass OAuth dengan cookie akun
├─ Buka halaman authorize → klik Allow/Continue
└─ Device Authorized → status: injected

SAVE
├─ grok_accounts.json  (state machine)
├─ cookies/<email>.json (session Playwright)
└─ Akun berikutnya
```

> ⚠️ **Disclaimer:** Membuat banyak akun secara otomatis melanggar ToS xAI. Akun bisa kena ban wave, domain tempmail bisa ke-block, dan IP kamu bisa di-blacklist. Gunakan untuk eksperimen skala kecil.

## Quick Start (tinggal run)

```bash
# 1. Install dependency
npm install
npx playwright install chromium   # sekali saja

# 2. Salin config & isi (jangan commit config.json!)
cp config.example.json config.json

# 3. Jalankan — double-click run.bat ATAU:
node grok_farm.js          # pakai jumlahAkun di config
node grok_farm.js -n 100   # target 100 akun
.\run.bat 100              # Windows: cek service + jalankan otomatis
```

`run.bat` otomatis mengecek **9Router** (port 20128) dan **EzSolver** (port 8191); kalau EzSolver mati, ia dinyalakan sendiri.

## Solver Turnstile gratis (EzSolver)

Tanpa API key, tanpa layanan berbayar — solver lokal self-hosted
([`ismoiloffS/EzSolver`](https://github.com/ismoiloffS/EzSolver), Python + Chrome asli via nodriver).

```bash
cd ezsolver
venv/Scripts/python service.py    # listen di http://127.0.0.1:8191 (biarkan hidup)
# kalau Chrome bukan di path default: set CHROME_PATH=<path chrome.exe>
```

Config:

```jsonc
"useSolver": true,
"turnstileSolverUrl": "http://127.0.0.1:8191",  // solver lokal (gratis) — prioritas 1
"capsolverApiKey": ""                           // CapSolver (berbayar) — fallback
```

- **Widget Turnstile x.ai = mode managed/invisible** — checkbox "Verify you are human" tidak dirender, jadi bot **tidak** mengandalkan klik; token datang dari solver eksternal lalu di-inject ke `cf-turnstile-response`.
- Kalau solver lokal mati dan tidak ada `capsolverApiKey`, bot fallback ke klik otomatis + PAUSE singkat.

## CLI

| Perintah | Fungsi |
|---|---|
| `node grok_farm.js` | Jalankan sesuai `jumlahAkun` di config |
| `node grok_farm.js -n 500` | Target 500 akun (jumlah total; akun selesai dilewati) |
| `node grok_farm.js --force` | Ulangi akun yang sudah selesai |
| `node grok_farm.js --skip-inject` | Hanya signup, tanpa inject 9Router |
| `node grok_farm.js --dry-run` | Uji coba tanpa bikin akun |
| `node grok_farm.js --headless` | Tanpa jendela (jendela disembunyikan di luar layar) |

## Config penting (`config.json`)

| Key | Fungsi |
|---|---|
| `jumlahAkun` | Total target akun |
| `browserMode` | `"cdp"` (default, browser asli via CDP) atau `"launch"` (chromium Playwright) |
| `bravePath` | Path browser (default: Google Chrome) |
| `braveProfile` | Profil terpisah (`.chrome-profile` — tidak menyentuh profil asli) |
| `useSolver` / `turnstileSolverUrl` | Solver Turnstile lokal |
| `nineRouterBaseUrl` / `nineRouterPassword` | Dashboard 9Router untuk inject |
| `tempmailBaseUrl` / `domain` | Worker tempmail + domain email |
| `delayAntarAkunDetik` | Jeda antar akun (default `[0, 0]` = tanpa jeda) |

> ⛔ **`config.json` jangan pernah di-commit** — berisi password 9Router & data lokal. Sudah ada di `.gitignore`.

## State & data

- `grok_accounts.json` — state machine akun: `pending → signed_up → injected | failed`
- Akun `signed_up` / `injected` otomatis **dilewati** saat run ulang (pakai `--force` untuk mengulang)
- `cookies/<email>.json` — `storageState` Playwright (session x.ai per akun)

## Struktur

```text
grok_farm.js          # orchestrator (CLI + loop akun)
run.bat               # launcher Windows: cek service → jalankan bot
src/
├── browser.js        # buka/tutup browser (CDP auto-launch Chrome)
├── signup.js         # alur daftar akun x.ai (email → OTP → form → solver → submit)
├── solver.js         # klien Turnstile solver (EzSolver lokal / CapSolver)
├── cloudflare.js     # tangani interstitial & widget Cloudflare
├── rekam.js          # mode rekam struktur widget (diagnosa)
├── inject.js         # inject akun ke 9Router
├── tempmail.js       # generate email + polling OTP
├── save.js           # simpan state & cookies
└── state.js          # baca/tulis grok_accounts.json
temp-mail-worker/     # Cloudflare Worker tempmail (deploy sendiri)
```

## Catatan teknis

- **Browser headful wajib**: x.ai memblokir headless (HTTP 403). Bot auto-launch **Chrome asli** via CDP dengan profil terpisah (`.chrome-profile`) → fingerprint asli, lolos 403.
- **Kecepatan**: bot berjalan tanpa delay antar langkah; satu-satunya tunggu adalah **kode OTP** (polling 1.2 detik). Rata-rata jauh lebih cepat dari versi awal (hemat ±80–90 detik/akun).
- **Solver OFF** = perilaku manual: PAUSE singkat (5 detik) saat captcha — isi manual di browser lalu Enter; kalau tidak dijawab, bot lanjut (fail-fast).
- **Logout antar sesi**: tiap awal sesi akun, bot logout dari akun sebelumnya supaya tidak nyasar ke sesi lama.
