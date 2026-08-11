# 🌾 GROK FARM

Farm akun Grok/xAI: **SIGNUP → INJECT (9Router) → SAVE** otomatis.

```text
START
└─ Loop akun 1 → N

SIGNUP (x.ai)
├─ Create tempmail
├─ Buka signup page
├─ Isi email → ambil OTP
├─ Isi nama + password
├─ Solve Turnstile (CapSolver)
└─ Complete signup → status: signed_up

INJECT (9Router Grok CLI)
├─ Bypass OAuth pakai cookie akun (session baru)
├─ Buka authUrl 9Router -> Continue -> Allow
└─ Device Authorized → status: injected

SAVE
├─ grok_accounts.json
├─ cookies/<email>.json
└─ Jeda 6-10s → next akun
```

> ⚠️ **Catatan penting:** Membuat banyak akun otomatis melanggar ToS xAI.
> Akun bisa kena ban wave, domain temp mail bisa ke-block, dan IP kamu bisa di-blacklist.
> Gunakan untuk eksperimen skala kecil. Jangan untuk dijual/disalahgunakan.

## Setup

```bash
cd grok-farm
npm install
npx playwright install chromium   # sekali saja

# isi config.json
#   capsolverApiKey    -> key dari https://capsolver.com (top-up ~$5)
#   useSolver          -> true untuk solve Turnstile otomatis
#   turnstileSolverUrl -> URL solver lokal (EzSolver) — alternatif GRATIS tanpa key
#   nineRouterPassword -> password dashboard 9Router (kalau dikunci)
```

### Solver Turnstile gratis (EzSolver) — tanpa API key & tanpa bayar

Bot bisa menyelesaikan Turnstile lewat solver lokal self-hosted
([`ismoiloffS/EzSolver`](https://github.com/ismoiloffS/EzSolver) — Python + Chrome asli, tanpa layanan berbayar):

```bash
# sudah ter-install di folder ezsolver/ (venv sendiri, nodriver 0.50.3)

# jalankan service (terminal terpisah — biarkan hidup selama bot jalan)
cd ezsolver
venv/Scripts/python service.py   # listen di http://127.0.0.1:8191
# kalau Chrome bukan di path default: set CHROME_PATH=<path chrome/brave.exe>
```

Lalu di `config.json`: `"useSolver": true` dan `"turnstileSolverUrl": "http://127.0.0.1:8191"`.
Prioritas solver: **lokal (turnstileSolverUrl) dulu** → fallback **CapSolver (capsolverApiKey)** kalau field lokal dikosongkan.
Kalau service lokal tidak jalan, bot tetap lanjut (log ⚠️) dan mencoba klik otomatis checkbox Turnstile seperti biasa.

## Pakai

```bash
# 3 akun headful (default config)
node grok_farm.js

# 1000 akun — CATATAN: x.ai memblokir browser headless (HTTP 403).
# Jalankan headful dulu (default). Untuk headless skala besar butuh anti-detect browser / proxy.
node grok_farm.js -n 1000

# uji coba tanpa bikin akun
node grok_farm.js --dry-run

# hanya signup, tanpa inject ke 9Router
node grok_farm.js --skip-inject
```

## Resume & state

- `grok_accounts.json` = state machine semua akun: `pending → signed_up → injected | failed`
- Akun berstatus `signed_up` / `injected` otomatis **dilewati** saat run ulang (`--force` untuk ulangi)
- `cookies/<email>.json` = Playwright `storageState` (session x.ai per akun, dipakai inject)

## Catatan teknis

- **Browser (penting!)**: x.ai memblokir browser headless (HTTP 403). Default `browserMode: "cdp"` memakai **browser asli via CDP** — fingerprint asli → lolos 403. Bot auto-launch browser dengan profil khusus (`.chrome-profile`, tidak menyentuh profil asli kamu) kalau port `cdpUrl` belum hidup. Path browser diatur lewat `bravePath` (default Chrome: `C:/Program Files/Google/Chrome/Application/chrome.exe`; bisa diganti ke Brave/Chromium lain). Ganti ke `"browserMode": "launch"` untuk memakai chromium bawaan Playwright.
- **Jalur inject**: **Grok CLI (Grok Build)** pakai DEVICE-CODE (`/api/oauth/grok-cli/device-code` → buka halaman authorize dengan cookie akun → klik Allow → `/poll`). Provider lama Grok Build OAuth (`xai`, start-proxy) bisa dipakai ulang dengan set `"injectProvider": "xai"`. Gagal → fallback drive UI dashboard. Paksa UI: `"injectMode": "ui"`.
- **Pacing**: jeda 6-10 detik (default) terlalu cepat untuk skala 1000 — naikkan `delayAntarAkunDetik` dan pakai proxy/IP berbeda per akun.
- **Solver OFF** = perilaku manual: bot **PAUSE** singkat (15 detik) saat captcha muncul — selesaikan di jendela browser yang terbuka lalu tekan **Enter**; kalau tidak dijawab, bot langsung lanjut (mode cepat, fail-fast).
- **Verifikasi Cloudflare otomatis** (`src/cloudflare.js`): bot otomatis mengklik checkbox interstitial **"Just a moment…"** saat halaman dimuat, plus checkbox widget Turnstile yang menahan tombol form/OTP/submit. Setelah form nama/password terisi, bot menunggu **5 detik** lalu klik **"Verify you are human"** otomatis. PAUSE manual hanya terjadi kalau challenge tidak bisa diklik otomatis dalam 15 detik.
- **Auto-Allow authorize**: di halaman OAuth/device-authorize x.ai, bot otomatis klik **Allow/Continue** (setelah membersihkan challenge Cloudflare kalau ada).
- **Logout antar sesi**: di awal setiap sesi akun, bot logout dari akun sesi sebelumnya (halaman x.ai) supaya akun berikutnya tidak nyasar ke sesi lama.
