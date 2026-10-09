# GRID.ID — API Contract (v0.1)

**Base URL (dev):** `http://localhost:4000`

Semua respons JSON pakai **envelope** yang sama:

```jsonc
// sukses
{ "ok": true, "data": <payload>, "note": "opsional" }
// gagal
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

HTTP status mengikuti hasil (200/201 sukses; 400/404/500 error).
Frontend: **selalu cek `ok` dulu**; kalau `false`, tampilkan `error.message`.

---

## GET /api/health
Cek service & koneksi DB.
```jsonc
200 -> { "ok": true, "data": { "service": "grid-id-backend", "status": "up", "db": "ok|error", "time": "..." } }
```

## GET /api/cuaca?adm4={adm4}&horizon={jam}
Prakiraan cuaca BMKG (cache-first) untuk satu wilayah.
- `adm4` (wajib) — kode desa/kelurahan, mis. `51.71.01.2008`
- `horizon` (opsional, default `24`, rentang 3–72) — jendela jam untuk ringkasan faktor
```jsonc
200 -> {
  "ok": true,
  "data": {
    "adm4": "51.71.01.2008",
    "status": "fresh | stale | unavailable",
    "fetched_at": "2026-10-09T08:00:00Z",
    "factors": {
      "angin_max_kmh": 18.5,
      "hujan": true,
      "kelembapan_avg": 82,
      "suhu_avg": 29.3,
      "slot_dipakai": 8,
      "horizon_jam": 24
    },
    "forecast": [
      { "adm4": "...", "t": 29, "hu": 80, "ws": 12, "wd": "S",
        "weather_desc": "Hujan Ringan", "tcc": 90,
        "analysis_date": "...", "valid_from": "...", "valid_to": null, "status": "fresh" }
    ]
  }
}
400 -> adm4 kosong.
```
> Badge UI: tampilkan `status`. **`unavailable` ≠ aman** — tampilkan "data cuaca tidak tersedia".

## GET /api/assets
Daftar aset.
```jsonc
200 -> { "ok": true, "data": [
  { "id": "...", "asset_code": "GI-SRN-TR03", "name": "Trafo 03", "asset_type": "trafo",
    "lat": -8.67, "lng": 115.22, "adm4": "51.71.01.2008", "unit": "UID Bali",
    "criticality": "tinggi", "created_at": "..." }
] }
```

## GET /api/assets/{id}
Detail aset + kondisi MAXIMO (dummy) + skor risiko terakhir.
```jsonc
200 -> { "ok": true, "data": {
  "asset": { ... },
  "maximo": { "condition_score": 72, "condition_grade": "sedang", "is_mock": true, ... } | null,
  "risk_score": { "score": 76.5, "level": "kritis", "severity_component": 30,
                  "weather_component": 28, "density_component": 18, "computed_at": "..." } | null
} }
404 -> aset tidak ada.
```

## POST /api/reports
Buat laporan. **Foto diupload ke Supabase Storage lebih dulu**, lalu kirim URL-nya.
```jsonc
// body
{ "photo_url": "https://.../foto.jpg", "source": "warga",
  "asset_id": null, "reporter_name": "Budi", "reporter_contact": "08xx",
  "description": "Ada percikan di trafo", "lat": -8.67, "lng": 115.22 }
201 -> { "ok": true, "data": { "id": "...", "status": "baru", ... } }
400 -> photo_url kosong.
```

## GET /api/reports
100 laporan terbaru.
```jsonc
200 -> { "ok": true, "data": [ { ...report } ] }
```

## GET /api/prioritas  *(PLACEHOLDER)*
Aset terurut Risk Score (GRID vs MAXIMO). Terisi setelah Risk Score Engine aktif.
```jsonc
200 -> { "ok": true, "data": [
  { "score": 76.5, "level": "kritis",
    "assets": { "asset_code": "...", "name": "...", "unit": "..." },
    "maximo": { "condition_grade": "sedang", "condition_score": 72 } }
], "note": "Placeholder: terisi setelah Risk Score Engine aktif." }
```

---

## Nilai enum yang sah
| Field | Nilai |
|---|---|
| `defect` (detections) | `isolator_pecah` · `korosi` · `kabel_bermasalah` · `komponen_hilang` |
| `level` (risk) | `kritis` · `waspada` · `aman` |
| `condition_grade` (maximo) | `baik` · `sedang` · `buruk` |
| `status` (reports) | `baru` · `diproses` · `terverifikasi` · `ditolak` |
| `source` (reports) | `warga` · `petugas` · `cctv` |
| `status` (cuaca) | `fresh` · `stale` · `unavailable` |

## Catatan untuk Frontend (Dedik)
- Panggil **backend ini**, bukan Supabase langsung dari browser (RLS memblokir anon).
- Semua endpoint belum butuh auth untuk MVP.
- Endpoint menyusul: `/api/assets/:id/score`, `/api/scan`, `/api/rekomendasi/:assetId` — bentuk respons tetap pakai envelope `{ ok, data }`.
