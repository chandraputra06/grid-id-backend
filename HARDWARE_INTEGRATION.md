# GRID.ID — Integrasi Hardware Monitoring & Business Portal

Alur data:

```
Perangkat GRID.ID ──► Firebase Realtime Database  (telemetri + metadata gambar)
                 └──► Firebase Storage           (file gambar RGB / matriks thermal)
                              │
                              ▼  bridge backend (firebase-admin, server-only)
                     Supabase Postgres (device_telemetry, device_frames, device_detections, device_alerts)
                              │      └─► layanan AI YOLO existing (lib/aiClient → /v1/detect)
                              ▼
            /api/hardware (Supervisor PLN)      /api/business (B2B, per organisasi)
```

Live video **tidak** lewat Firebase: dashboard memutar URL stream perangkat (MJPEG/HLS/pemutar web) yang diatur per perangkat.

## 1. Hasil audit integrasi existing

| Hal | Temuan |
|---|---|
| Firebase | **Belum ada** sama sekali (tidak ada SDK, config, maupun kode). |
| Database | Supabase Postgres (service_role di backend). Tabel `devices` & `device_readings` sudah ada. |
| Ingestion lama | `POST /api/devices/:id/readings` (JWT user) — dibiarkan, tidak dipakai jalur baru. |
| Penyimpanan gambar | Supabase Storage untuk foto laporan warga. Gambar hardware memakai **Firebase Storage**. |
| AI | `lib/aiClient.js` → layanan YOLO (`GRID_AI_URL`, `GRID_AI_API_KEY`). Dipakai ulang apa adanya. |
| Prioritas | `risk_scores` (Risk Score Engine existing) — dipakai sebagai "prioritas inspeksi", tidak dibuat skor baru. |
| Multi-tenant | Belum ada. Ditambahkan `organizations`, `organization_assets`, `profiles.organization_id/org_role`, role `b2b`. |

## 2. Kontrak data untuk tim hardware

### 2.1 Telemetri — `push()` ke `/telemetry/<device_id>`

`device_id` = `devices.device_code` di GRID.ID. Gunakan `push()` (kunci kronologis), jangan `set()` ke kunci tetap.

```json
{
  "device_id": "GARDU-001",
  "timestamp": "2026-10-22T09:30:00+08:00",
  "telemetry": {
    "thermal": { "max_temp_c": 68.4, "avg_temp_c": 41.2, "delta_temp_c": 37.9, "hotspot": { "x": 14, "y": 9 } },
    "environment": { "ambient_temp_c": 30.5, "humidity_pct": 72 },
    "sound": { "sound_level_db": 62.3, "dominant_freq_hz": 100, "audio_anomaly": false },
    "gas": { "raw_value": 410 },
    "distance": { "distance_cm": 320 },
    "device_status": { "rssi_dbm": -58, "alarm_state": false },
    "pan_tilt": { "pan_deg": 15, "tilt_deg": -5 },
    "gps": { "lat": -8.6905, "lng": 115.2629, "fix": true }
  }
}
```

- `pan_tilt` dan `gps` **opsional**. Field yang tidak dikirim tampil "—" (tidak dianggap 0).
- `timestamp` ISO-8601 dengan offset (atau epoch detik/ms). Jam > 5 menit di masa depan → ditandai tidak valid, dipakai waktu server.
- Nilai di luar rentang fisik sensor (mis. kelembapan 140%) dikosongkan dan ditandai "Data tidak valid".
- Hotspot mengikuti grid MLX90640: x 0–31, y 0–23.
- `gas.raw_value` diperlakukan sebagai nilai ADC mentah (belum ppm).

### 2.2 Gambar — upload ke Storage, lalu `push()` metadata ke `/frames/<device_id>`

1. Upload file ke `frames/<device_id>/<frame_id>.jpg` (RGB) atau `frames/<device_id>/<frame_id>.json` (thermal).
2. Push metadata:

```json
{
  "frame_id": "GARDU-001-20261022T013000Z",
  "device_id": "GARDU-001",
  "timestamp": "2026-10-22T09:30:00+08:00",
  "frame_type": "rgb",
  "image_path": "frames/GARDU-001/GARDU-001-20261022T013000Z.jpg",
  "capture_mode": "periodic",
  "upload_status": "uploaded"
}
```

- `frame_id` unik global (huruf/angka `._:-`, ≤128). Disarankan `<device_id>-<waktu UTC>`.
- `frame_type`: `rgb` | `thermal`. `capture_mode`: `periodic` | `manual` | `event`. `upload_status`: `pending` | `uploaded` | `failed`.
- Boleh push dulu `upload_status: "pending"`, lalu **update node yang sama** menjadi `uploaded`/`failed` (bridge mendengar `child_changed`).
- `image_path` wajib di folder perangkat sendiri; path lain ditolak.
- `inference_status` **tidak** dikirim perangkat — diisi backend (`pending → processing → done/failed/skipped`).
- Matriks thermal (JSON): `{ "width": 32, "height": 24, "data": [768 angka °C] }` (juga diterima `number[768]` atau `number[24][32]`). Dashboard hanya menggambar citra thermal dari file ini; tanpa file, yang tampil hanya angka suhu.

Hasil YOLO disimpan di `device_detections` dengan `frame_id` yang sama, jadi gambar, hasil AI, telemetri terdekat (±2 menit), dan citra thermal terdekat (±60 detik) selalu tertaut ke frame yang benar.

### 2.3 Konfigurasi dari dashboard — `/device_config/<device_id>` (dibaca firmware)

```json
{ "snapshot_interval_s": 10, "updated_at": "2026-10-22T01:30:00.000Z" }
```

Kontrol interval (5/10/30/60 dtk) hanya muncul bila perangkat ditandai `capabilities.snapshot_interval_control = true` (menu Konfigurasi di detail perangkat). Firmware perlu membaca/listen node ini supaya kontrolnya berfungsi.

### 2.4 Keamanan Firebase

- `firebase/database.rules.json` & `firebase/storage.rules`: perangkat hanya bisa menulis ke path miliknya (custom claim `device_id`); klien tidak bisa membaca apa pun. Deploy: `firebase deploy --only database,storage`.
- Kredensial perangkat: `npm run hw:provision -- --device GARDU-001` → akun Firebase Auth + claim `device_id`.
- Service account **hanya di backend** (`FIREBASE_SERVICE_ACCOUNT_JSON`). Frontend tidak memakai SDK Firebase sama sekali; gambar diakses lewat signed URL berumur pendek (default 15 menit) yang dibuat setelah cek hak akses.

## 3. Konfigurasi backend

Tambahkan ke `.env` (lihat `.env.example`):

```
FIREBASE_PROJECT_ID=grid-id-xxxx
FIREBASE_DATABASE_URL=https://grid-id-xxxx-default-rtdb.asia-southeast1.firebasedatabase.app
FIREBASE_STORAGE_BUCKET=grid-id-xxxx.firebasestorage.app
FIREBASE_SERVICE_ACCOUNT_JSON=<isi JSON service account, atau base64-nya>
HW_BRIDGE_ENABLED=true          # set false di instance lain bila backend >1 replika
GRID_AI_URL=...                 # existing
GRID_AI_API_KEY=...             # existing
```

Langkah:

1. `npm install` (menambah `firebase-admin`).
2. Jalankan `migrations/005_hardware_monitoring_b2b.sql` di Supabase SQL Editor.
3. Daftarkan perangkat: `POST /api/devices { "device_code": "GARDU-001", "type": "multisensor", "asset_id": "<uuid aset>", "name": "..." }`.
4. Restart backend → log `[hw-bridge] aktif`. Cek `GET /api/hardware/status`.
5. Isi ambang di **Hardware Monitoring → Aturan Peringatan**. Ambang suhu & gas sengaja **kosong (nonaktif)** sampai diisi sesuai SOP PLN.

## 4. Endpoint baru

Semua memakai envelope `{ ok, data }` dan JWT Supabase.

**`/api/hardware`** — admin, supervisor, hardware (seluruh perangkat)

| Method | Path | Keterangan |
|---|---|---|
| GET | `/status` | Status Firebase, bridge, RTDB, layanan AI |
| GET | `/overview?from&to&unit` | Kartu statistik, tren sensor per jam, perlu perhatian, inspeksi terbaru |
| GET | `/devices?q&unit&status&priority&from&to` | Tabel perangkat + telemetri terakhir, AI terakhir, prioritas, alert terbuka |
| GET | `/devices/:id` | Detail + telemetri/snapshot/thermal terbaru + ambang + status integrasi |
| GET | `/devices/:id/telemetry?from&to&limit` | Riwayat telemetri (≤5000) |
| GET | `/frames?device_id&asset_id&frame_type&from&to&before&limit` | Galeri (signed URL) |
| GET | `/frames/:frameId` | Frame + deteksi + telemetri terdekat + thermal terkait + alert |
| GET | `/frames/:frameId/thermal` | Matriks thermal (proxy dari Storage) |
| GET | `/inspections?from&to&device_id&asset_id&unit&defect&inference_status&with_detections` | Riwayat inspeksi |
| GET | `/alerts?from&to&status&category&priority&unit&device_id&asset_id` | Peringatan |
| PATCH | `/alerts/:id` `{status, note}` | Tindak lanjut — **admin/supervisor** |
| GET | `/report?from&to&unit` | Laporan (ringkasan, per kelas, harian, per aset) |
| GET/PATCH | `/settings` | Aturan peringatan global (PATCH: admin/supervisor) |
| PATCH | `/devices/:id/config` | Nama, URL stream, capabilities, override ambang — **admin/hardware** |
| PATCH | `/devices/:id/snapshot-interval` `{interval_s}` | Tulis ke `/device_config` — admin/supervisor/hardware |

**`/api/business`** — role `b2b`, **hanya baca**, otomatis dibatasi ke aset di `organization_assets`

`GET /organization`, `GET /overview`, `GET /assets`, `GET /assets/:id`, `GET /devices`, `GET /devices/:id`, `GET /devices/:id/telemetry`, `GET /frames`, `GET /frames/:frameId`, `GET /frames/:frameId/thermal`, `GET /inspections`, `GET /alerts`, `GET /report`, `POST /members` & `PATCH /members/:id` (khusus owner organisasi, anggota organisasinya sendiri).
Tidak ada endpoint B2B untuk mengubah status alert atau mengontrol perangkat. Perangkat/frame di luar scope → 404. URL stream hanya dikirim bila `organizations.permissions.view_stream` tidak `false`.

**`/api/organizations`** — admin: CRUD organisasi, `POST /:id/assets {asset_id}`, `DELETE /:id/assets/:assetId`, `POST /:id/members` (akun baru atau `user_id` existing), `DELETE /:id/members/:userId`.

Endpoint existing yang dipakai ulang: `/api/me`, `/api/devices` (registrasi), `lib/aiClient` (inferensi), `risk_scores` (prioritas).

## 5. Aturan peringatan

| Kategori | Pemicu | Default |
|---|---|---|
| `telemetry_late` | Tidak ada telemetri > N detik | 180 dtk |
| `offline` | Tidak ada telemetri > N detik (perangkat yang belum pernah kirim data = "Belum ada data", bukan offline) | 600 dtk |
| `temp_threshold` | `max_temp_c` > ambang pada N pembacaan berturut-turut | **nonaktif** |
| `gas_threshold` | `gas_raw` > ambang pada N pembacaan berturut-turut | **nonaktif** |
| `audio_anomaly` | flag `audio_anomaly` perangkat true N kali berturut-turut | N=2 |
| `alarm_perangkat` | `alarm_state` true | — |
| `ai_detection` | deteksi YOLO dengan confidence ≥ ambang; prioritas dari severity layanan AI | conf ≥ 0.5 |
| `upload_failed` | metadata frame `upload_status: failed` | — |

Satu alert terbuka per (perangkat, kategori[, kelas AI]); kejadian berulang menambah `occurrences`. `active` = kondisi masih berlangsung (diatur sistem); `status` = workflow manusia (`baru → ditinjau → selesai`). Pesan memakai kata "indikasi" dan tidak menyatakan komponen pasti rusak.

## 6. Pengujian

### Otomatis (tanpa jaringan)

```
npm test      # 23 test: validasi payload, aturan alert, idempotensi ingest, isolasi data B2B, rute
```

### Dengan data simulasi (berlabel SIMULASI di dashboard)

```
npm run hw:simulate -- --device GARDU-001 --direct                          # tanpa Firebase
npm run hw:simulate -- --device GARDU-001 --firebase --count 20 --interval 5 # lewat Firebase penuh
```

### Dengan hardware nyata

1. Provision perangkat (`hw:provision`), deploy rules, daftarkan `device_code` yang sama di GRID.ID dan kaitkan ke aset.
2. Firmware login Firebase Auth → `push` telemetri ke `/telemetry/GARDU-001` dengan format 2.1.
3. Di **Firebase Console → Realtime Database**, pastikan node muncul. Di dashboard: **Hardware Monitoring → Status integrasi data** menampilkan RTDB "Terhubung" dan event telemetri terakhir; perangkat berubah **Online** ≤ 10 detik (detail) / 30 detik (daftar).
4. Upload satu JPG ke `frames/GARDU-001/…` + push metadata 2.2 → snapshot muncul di detail perangkat; status AI berubah *Menunggu → Sedang diproses → AI selesai/gagal*. Bila `GRID_AI_URL` belum diset, statusnya **AI gagal** (bukan "aman").
5. Upload matriks thermal 32×24 (`frame_type: thermal`) → panel Citra thermal tampil.
6. Matikan perangkat → setelah 3 menit "Telemetri terlambat", setelah 10 menit "Offline" + alert.
7. Isi URL stream di **Konfigurasi**. Stream `http://` tidak bisa diputar dari dashboard `https://` (mixed content) — sajikan lewat HTTPS.
8. B2B: `node scripts/seed-b2b.js --asset <uuid>` → login `b2b@grid.id`, pastikan hanya aset tersebut yang terlihat dan `GET /api/business/devices/<id perangkat lain>` → 404.
