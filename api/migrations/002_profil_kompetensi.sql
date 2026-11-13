-- Modul "Buku Profil Kompetensi Jabatan": upload profil kompetensi dari Excel,
-- lalu export PDF per jabatan / sub job family / job family sebagai lampiran SK Direksi.
--
-- Jalankan manual di server (sekali saja):
--   sudo -u postgres psql -d approval_db -f api/migrations/002_profil_kompetensi.sql

CREATE TABLE IF NOT EXISTS kp_batch (
  id              serial PRIMARY KEY,
  batch_name      text NOT NULL,
  source_file     text,
  status          text NOT NULL DEFAULT 'uploading',  -- uploading | ready
  pengaturan      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- kop lampiran SK, penandatangan, dll.
  uploaded_by     text,                                -- email pengunggah
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kp_jabatan (
  id              serial PRIMARY KEY,
  batch_id        integer NOT NULL REFERENCES kp_batch(id) ON DELETE CASCADE,
  sort_order      integer NOT NULL DEFAULT 0,
  kode_jabatan    text NOT NULL,
  nama_jabatan    text NOT NULL,
  job_family      text,
  sub_job_family  text,
  unit_kerja      text,
  tingkat_jabatan text,
  jenis_jabatan   text,
  tujuan_jabatan  text,
  UNIQUE (batch_id, kode_jabatan)
);
CREATE INDEX IF NOT EXISTS kp_jabatan_batch_idx ON kp_jabatan (batch_id, job_family, sub_job_family);

CREATE TABLE IF NOT EXISTS kp_kompetensi (
  id              serial PRIMARY KEY,
  jabatan_id      integer NOT NULL REFERENCES kp_jabatan(id) ON DELETE CASCADE,
  sort_order      integer NOT NULL DEFAULT 0,
  kelompok        text,      -- mis. Kompetensi Inti / Manajerial / Teknis
  kode            text,
  nama            text NOT NULL,
  definisi        text,
  level           text,      -- level kompetensi yang dipersyaratkan
  indikator       text       -- indikator perilaku (opsional, boleh multi-baris)
);
CREATE INDEX IF NOT EXISTS kp_kompetensi_jabatan_idx ON kp_kompetensi (jabatan_id, sort_order);

INSERT INTO approval_modules (module_key, module_name, description, url_slug)
VALUES ('profil_kompetensi', 'Buku Profil Kompetensi Jabatan',
        'Upload profil kompetensi jabatan (Excel) dan export PDF per jabatan, job family, dan sub job family untuk lampiran SK Direksi.',
        'profil-kompetensi.html')
ON CONFLICT (module_key) DO NOTHING;
