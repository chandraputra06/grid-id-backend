# GRID.ID — Backend (v0.1)

Express + Supabase (PostgreSQL/PostGIS) + connector BMKG (cache-first).

## Prasyarat
- Node.js >= 18 (pakai `fetch` bawaan)
- Supabase project sudah dijalankan `schema.sql` (PostGIS enabled)

## Setup
```bash
cd grid-id-backend
cp .env.example .env         # isi SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY
npm install
npm run dev                  # jalan di http://localhost:4000
```

Cek sehat: `http://localhost:4000/api/health`

## Smoke test BMKG (tugas hari ini)
```bash
npm run smoke:bmkg
```
Menguji API BMKG Bali (Pemogan/Renon/Kuta) tanpa DB — konfirmasi: struktur field,
satuan `ws` (km/jam), timezone pada `valid_from`, dan limit 60 req/menit/IP.

## Struktur
```
src/
  index.js            # entry Express
  config/env.js       # baca & validasi .env
  config/supabase.js  # client Supabase (service_role)
  lib/bmkg.js         # fetch + normalisasi + ekstrak faktor + cache
  middleware/         # errorHandler (envelope { ok, error })
  routes/             # health, cuaca, assets, reports, prioritas
  utils/              # ApiError, asyncHandler
scripts/smoke-bmkg.js # uji konektivitas BMKG
```

## Endpoint
Lihat **API_CONTRACT.md** (dipakai bareng frontend).

## Keamanan
- `SUPABASE_SERVICE_ROLE_KEY` hanya di server (`.env`), JANGAN di frontend.
- RLS aktif di semua tabel; backend menembusnya lewat service_role.

## Roadmap endpoint (menyusul)
- `GET /api/assets/:id/score` — Risk Score Engine (severity 40% / cuaca 35% / kepadatan 25%)
- `POST /api/scan` — inference service (AI Screening) -> detections
- `GET /api/rekomendasi/:assetId` — SPK
- MAXIMO dummy: seed `maximo_conditions` (is_mock=true) sesuai field output MAXIMO
