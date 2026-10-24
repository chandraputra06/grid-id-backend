-- =====================================================================
-- GRID.ID — Migrasi 005: Hardware Monitoring + GRID.ID Business Portal
-- Jalankan di Supabase SQL Editor (sekali). Idempoten (aman diulang).
--
-- Alur data:  Hardware -> Firebase (RTDB + Storage) -> Backend bridge
--             -> tabel di bawah -> API -> Dashboard Supervisor & Business Portal
--
-- Prinsip:
--  * Gambar TIDAK disimpan di database. Hanya metadata + path Firebase Storage.
--  * Semua tabel RLS aktif tanpa policy => anon/authenticated tidak bisa baca
--    langsung; akses hanya lewat backend (service_role) yang menerapkan scope.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) devices — kolom tambahan (tabel existing)
-- ---------------------------------------------------------------------
alter table public.devices add column if not exists name               text;
alter table public.devices add column if not exists stream_url         text;
alter table public.devices add column if not exists stream_type        text;
alter table public.devices add column if not exists capabilities       jsonb not null default '{}'::jsonb;
alter table public.devices add column if not exists alert_config       jsonb not null default '{}'::jsonb;
alter table public.devices add column if not exists snapshot_interval_s integer;
alter table public.devices add column if not exists last_telemetry_at  timestamptz;
alter table public.devices add column if not exists last_frame_at      timestamptz;
alter table public.devices add column if not exists latest_telemetry_id uuid;
alter table public.devices add column if not exists fb_cursor_telemetry text;
alter table public.devices add column if not exists fb_cursor_frames    text;

do $$ begin
  alter table public.devices add constraint devices_stream_type_check
    check (stream_type is null or stream_type in ('mjpeg', 'hls', 'iframe'));
exception when duplicate_object then null; end $$;

-- Izinkan tipe 'multisensor' (unit GRID.ID berisi thermal+kamera+sensor).
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'devices_type_check') then
    alter table public.devices drop constraint devices_type_check;
  end if;
  alter table public.devices add constraint devices_type_check
    check (type is null or type in ('camera', 'thermal', 'sensor', 'multisensor'));
end $$;

create unique index if not exists devices_device_code_key on public.devices (device_code);

-- ---------------------------------------------------------------------
-- 2) device_telemetry — satu baris per paket telemetri dari Firebase
-- ---------------------------------------------------------------------
create table if not exists public.device_telemetry (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references public.devices(id) on delete cascade,
  device_code       text not null,
  captured_at       timestamptz not null,           -- waktu dari perangkat (atau received_at bila tidak valid)
  received_at       timestamptz not null default now(),
  timestamp_valid   boolean not null default true,
  source            text not null default 'firebase' check (source in ('firebase', 'simulasi')),
  firebase_key      text unique,                    -- idempotensi: "<device_code>/<pushId>"

  max_temp_c        numeric,
  avg_temp_c        numeric,
  delta_temp_c      numeric,
  hotspot_x         integer,
  hotspot_y         integer,
  ambient_temp_c    numeric,
  humidity_pct      numeric,
  sound_level_db    numeric,
  dominant_freq_hz  numeric,
  audio_anomaly     boolean,
  gas_raw           numeric,
  distance_cm       numeric,
  rssi_dbm          numeric,
  alarm_state       boolean,
  pan_deg           numeric,
  tilt_deg          numeric,
  gps_lat           double precision,
  gps_lng           double precision,

  valid             boolean not null default true,
  validation_errors jsonb not null default '[]'::jsonb,
  raw               jsonb
);
create index if not exists device_telemetry_device_time_idx on public.device_telemetry (device_id, captured_at desc);

-- ---------------------------------------------------------------------
-- 3) device_frames — metadata gambar (RGB snapshot / thermal matrix)
--    File fisik ada di Firebase Storage (image_path).
-- ---------------------------------------------------------------------
create table if not exists public.device_frames (
  id                uuid primary key default gen_random_uuid(),
  frame_id          text not null unique,
  device_id         uuid not null references public.devices(id) on delete cascade,
  device_code       text not null,
  captured_at       timestamptz not null,
  received_at       timestamptz not null default now(),
  frame_type        text not null check (frame_type in ('rgb', 'thermal')),
  image_path        text,
  capture_mode      text check (capture_mode in ('periodic', 'manual', 'event')),
  upload_status     text not null default 'pending' check (upload_status in ('pending', 'uploaded', 'failed')),
  inference_status  text not null default 'pending'
                    check (inference_status in ('pending', 'processing', 'done', 'failed', 'skipped', 'not_applicable')),
  inference_at      timestamptz,
  inference_error   text,
  model_version     text,
  inference_ms      integer,
  width             integer,
  height            integer,
  source            text not null default 'firebase' check (source in ('firebase', 'simulasi')),
  validation_errors jsonb not null default '[]'::jsonb,
  raw               jsonb
);
create index if not exists device_frames_device_time_idx on public.device_frames (device_id, captured_at desc);
create index if not exists device_frames_inference_idx on public.device_frames (inference_status, captured_at desc);

-- ---------------------------------------------------------------------
-- 4) device_detections — hasil YOLO per frame (bentuk sama dgn tabel detections)
--    Dipisah dari `detections` (yang terikat ke reports warga) agar snapshot
--    berkala tidak membanjiri antrean verifikasi laporan.
-- ---------------------------------------------------------------------
create table if not exists public.device_detections (
  id             uuid primary key default gen_random_uuid(),
  frame_id       text not null references public.device_frames(frame_id) on delete cascade,
  device_id      uuid not null references public.devices(id) on delete cascade,
  defect         text,
  category       text,
  confidence     numeric,
  severity       numeric,
  bbox           jsonb,            -- {x,y,w,h} YOLO ternormalisasi 0-1 (titik tengah)
  model_version  text,
  inference_ms   integer,
  verified       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists device_detections_frame_idx on public.device_detections (frame_id);
create index if not exists device_detections_device_idx on public.device_detections (device_id, created_at desc);

-- ---------------------------------------------------------------------
-- 5) device_alerts — peringatan + workflow tindak lanjut
--    active   = kondisi pemicu masih berlangsung (diatur sistem)
--    status   = workflow manusia (baru -> ditinjau -> selesai)
-- ---------------------------------------------------------------------
create table if not exists public.device_alerts (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references public.devices(id) on delete cascade,
  asset_id        uuid,
  category        text not null check (category in (
                    'offline', 'telemetry_late', 'temp_threshold', 'audio_anomaly',
                    'gas_threshold', 'alarm_perangkat', 'ai_detection', 'upload_failed')),
  dedup_key       text not null,
  priority        text not null default 'sedang' check (priority in ('tinggi', 'sedang', 'rendah')),
  status          text not null default 'baru' check (status in ('baru', 'ditinjau', 'selesai')),
  active          boolean not null default true,
  message         text,
  trigger_value   numeric,
  trigger_unit    text,
  threshold       numeric,
  frame_id        text,
  telemetry_id    uuid,
  occurrences     integer not null default 1,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  cleared_at      timestamptz,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  resolved_by     uuid,
  resolved_at     timestamptz,
  note            text,
  source          text not null default 'firebase' check (source in ('firebase', 'simulasi'))
);
create index if not exists device_alerts_device_idx on public.device_alerts (device_id, last_seen_at desc);
create index if not exists device_alerts_open_idx on public.device_alerts (dedup_key, device_id) where status <> 'selesai';

-- ---------------------------------------------------------------------
-- 6) hw_settings — konfigurasi aturan peringatan global (1 baris)
--    Ambang suhu & gas DEFAULT NULL (nonaktif) — wajib diisi pihak berwenang.
-- ---------------------------------------------------------------------
create table if not exists public.hw_settings (
  id          integer primary key default 1 check (id = 1),
  config      jsonb not null default '{}'::jsonb,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
insert into public.hw_settings (id, config) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 7) Multi-tenant B2B
-- ---------------------------------------------------------------------
create table if not exists public.organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  code         text unique,
  type         text,                         -- mis. kawasan_industri, gedung, utilitas
  status       text not null default 'aktif' check (status in ('aktif', 'nonaktif')),
  permissions  jsonb not null default '{"view_stream": true}'::jsonb,
  contact      text,
  created_at   timestamptz not null default now()
);

-- Aset yang aksesnya diberikan ke organisasi (sumber kebenaran scope B2B).
create table if not exists public.organization_assets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  asset_id        uuid not null references public.assets(id) on delete cascade,
  granted_by      uuid,
  granted_at      timestamptz not null default now(),
  primary key (organization_id, asset_id)
);

alter table public.profiles add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.profiles add column if not exists org_role text;
do $$ begin
  alter table public.profiles add constraint profiles_org_role_check
    check (org_role is null or org_role in ('owner', 'viewer'));
exception when duplicate_object then null; end $$;

-- Tambah role 'b2b' bila profiles.role memakai CHECK constraint.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles drop constraint profiles_role_check;
    alter table public.profiles add constraint profiles_role_check
      check (role in ('admin', 'petugas', 'warga', 'supervisor', 'hardware', 'b2b'));
  end if;
end $$;
-- Catatan: bila role memakai ENUM type (bukan CHECK), jalankan manual:
--   alter type <nama_enum_role> add value if not exists 'b2b';

-- ---------------------------------------------------------------------
-- 8) RLS: aktif, tanpa policy (deny-all untuk anon/authenticated).
-- ---------------------------------------------------------------------
alter table public.device_telemetry    enable row level security;
alter table public.device_frames       enable row level security;
alter table public.device_detections   enable row level security;
alter table public.device_alerts       enable row level security;
alter table public.hw_settings         enable row level security;
alter table public.organizations       enable row level security;
alter table public.organization_assets enable row level security;
