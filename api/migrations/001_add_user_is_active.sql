-- Fitur "Kelola User": tambah kolom is_active untuk soft-delete.
-- approval_users direferensi via FK oleh cp_draft_node_nexts, cp_import_batch,
-- dan cp_job_approval (reviewed_by/uploaded_by), jadi hard-delete user yang
-- sudah punya riwayat approval akan gagal. Nonaktifkan (is_active = false)
-- dipakai sebagai pengganti hapus permanen.
--
-- Jalankan manual di server (sekali saja):
--   sudo -u postgres psql -d approval_db -f api/migrations/001_add_user_is_active.sql

ALTER TABLE approval_users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
