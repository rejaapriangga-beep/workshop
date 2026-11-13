// Modul Buku Profil Kompetensi Jabatan — API routes (/api/kp/...)
const express = require('express');
const archiver = require('archiver');
const { docJabatan, renderPdf, renderKelompok, DEFAULT_SETTINGS } = require('./pdf');

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

module.exports = function kompetensiRoutes({ pool, authRequired, approverOnly }) {
  const router = express.Router();

  // Download file PDF/ZIP dibuka langsung oleh browser (tanpa header Authorization),
  // jadi token boleh dikirim lewat query ?token=
  function authHeaderOrQuery(req, res, next) {
    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = 'Bearer ' + req.query.token;
    }
    return authRequired(req, res, next);
  }

  const clean = (v, max = 20000) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s.slice(0, max);
  };

  const safeName = (s) =>
    String(s || '-').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || '-';

  async function getBatch(id) {
    const { rows } = await pool.query('SELECT * FROM kp_batch WHERE id = $1', [id]);
    return rows[0];
  }

  // Ambil jabatan + kompetensinya. filter: { jobFamily, subJobFamily, kodeJabatan }
  async function loadJabatan(batchId, filter = {}) {
    const cond = ['j.batch_id = $1'];
    const params = [batchId];
    const add = (sql, val) => { params.push(val); cond.push(sql.replace('?', '$' + params.length)); };
    if (filter.jobFamily !== undefined) add("COALESCE(j.job_family,'') = ?", filter.jobFamily);
    if (filter.subJobFamily !== undefined) add("COALESCE(j.sub_job_family,'') = ?", filter.subJobFamily);
    if (filter.kodeJabatan !== undefined) add('j.kode_jabatan = ?', filter.kodeJabatan);

    const { rows: jab } = await pool.query(
      `SELECT j.* FROM kp_jabatan j WHERE ${cond.join(' AND ')} ORDER BY j.sort_order, j.id`,
      params
    );
    if (jab.length === 0) return [];
    const { rows: komp } = await pool.query(
      `SELECT * FROM kp_kompetensi WHERE jabatan_id = ANY($1::int[]) ORDER BY jabatan_id, sort_order, id`,
      [jab.map((j) => j.id)]
    );
    const byJab = new Map(jab.map((j) => [j.id, Object.assign(j, { kompetensi: [] })]));
    for (const k of komp) byJab.get(k.jabatan_id).kompetensi.push(k);
    return jab;
  }

  // Kelompokkan jabatan → [{ jobFamily, subs: [{ subJobFamily, jabatan: [] }] }] (urutan sesuai Excel)
  function groupTree(jabatan) {
    const fams = [];
    const fIdx = new Map();
    for (const j of jabatan) {
      const f = j.job_family || '';
      if (!fIdx.has(f)) { fIdx.set(f, fams.length); fams.push({ jobFamily: f, subs: [], sIdx: new Map() }); }
      const fam = fams[fIdx.get(f)];
      const s = j.sub_job_family || '';
      if (!fam.sIdx.has(s)) { fam.sIdx.set(s, fam.subs.length); fam.subs.push({ subJobFamily: s, jabatan: [] }); }
      fam.subs[fam.sIdx.get(s)].jabatan.push(j);
    }
    return fams.map(({ jobFamily, subs }) => ({ jobFamily, subs }));
  }

  const flat = (fam) => fam.subs.flatMap((s) => s.jabatan);

  function sendPdf(res, buffer, filename, inline) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(buffer);
  }

  // ------------------------------------------------------------
  // BATCH
  // ------------------------------------------------------------
  router.get('/batches', authRequired, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT b.id, b.batch_name, b.source_file, b.status, b.uploaded_by, b.created_at,
          (SELECT COUNT(*) FROM kp_jabatan j WHERE j.batch_id = b.id) AS jabatan_count,
          (SELECT COUNT(DISTINCT COALESCE(j.job_family,'')) FROM kp_jabatan j WHERE j.batch_id = b.id) AS job_family_count
        FROM kp_batch b ORDER BY b.created_at DESC`);
      res.json({ batches: rows });
    } catch (e) {
      console.error('[KP BATCHES ERROR]', e);
      res.status(500).json({ error: 'Gagal memuat daftar batch' });
    }
  });

  // Mulai upload: buat batch kosong (status uploading). Data jabatan dikirim bertahap (chunk).
  router.post('/batches', authRequired, async (req, res) => {
    try {
      const batchName = clean(req.body.batch_name, 200);
      if (!batchName) return res.status(400).json({ error: 'Nama batch wajib diisi' });
      // Pengaturan kop/ttd disalin dari batch terakhir agar tidak perlu diisi ulang
      const last = await pool.query(`SELECT pengaturan FROM kp_batch WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1`);
      const { rows } = await pool.query(
        `INSERT INTO kp_batch (batch_name, source_file, status, uploaded_by, pengaturan)
         VALUES ($1, $2, 'uploading', $3, $4) RETURNING id`,
        [batchName, clean(req.body.source_file, 300), req.user.email, last.rows[0]?.pengaturan || {}]
      );
      res.json({ batch_id: rows[0].id });
    } catch (e) {
      console.error('[KP CREATE BATCH ERROR]', e);
      res.status(500).json({ error: 'Gagal membuat batch' });
    }
  });

  // Kirim sebagian jabatan (maks 500 per request)
  router.post('/batches/:id/jabatan', authRequired, async (req, res) => {
    const client = await pool.connect();
    try {
      const batch = await getBatch(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      if (batch.status !== 'uploading') return res.status(400).json({ error: 'Batch sudah final, tidak bisa ditambah' });
      const list = Array.isArray(req.body.jabatan) ? req.body.jabatan : [];
      if (list.length === 0 || list.length > 500) return res.status(400).json({ error: 'Kirim 1–500 jabatan per request' });

      const jabRows = [];
      const kompRows = [];
      for (const j of list) {
        const kode = clean(j.kode_jabatan, 200);
        const nama = clean(j.nama_jabatan, 500);
        if (!kode || !nama) continue;
        jabRows.push({
          sort_order: Number.isFinite(+j.sort_order) ? +j.sort_order : 0,
          kode_jabatan: kode, nama_jabatan: nama,
          job_family: clean(j.job_family, 300), sub_job_family: clean(j.sub_job_family, 300),
          unit_kerja: clean(j.unit_kerja, 500), tingkat_jabatan: clean(j.tingkat_jabatan, 100),
          jenis_jabatan: clean(j.jenis_jabatan, 200), tujuan_jabatan: clean(j.tujuan_jabatan),
        });
        (Array.isArray(j.kompetensi) ? j.kompetensi : []).forEach((k, i) => {
          const namaK = clean(k.nama, 500);
          if (!namaK) return;
          kompRows.push({
            kode_jabatan: kode, sort_order: i, kelompok: clean(k.kelompok, 300), kode: clean(k.kode, 100),
            nama: namaK, definisi: clean(k.definisi), level: clean(k.level, 100), indikator: clean(k.indikator),
          });
        });
      }

      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO kp_jabatan (batch_id, sort_order, kode_jabatan, nama_jabatan, job_family, sub_job_family,
                                 unit_kerja, tingkat_jabatan, jenis_jabatan, tujuan_jabatan)
         SELECT $1, r.sort_order, r.kode_jabatan, r.nama_jabatan, r.job_family, r.sub_job_family,
                r.unit_kerja, r.tingkat_jabatan, r.jenis_jabatan, r.tujuan_jabatan
         FROM jsonb_to_recordset($2::jsonb) AS r(sort_order int, kode_jabatan text, nama_jabatan text, job_family text,
              sub_job_family text, unit_kerja text, tingkat_jabatan text, jenis_jabatan text, tujuan_jabatan text)
         ON CONFLICT (batch_id, kode_jabatan) DO NOTHING
         RETURNING id, kode_jabatan`,
        [batch.id, JSON.stringify(jabRows)]
      );
      const idByKode = new Map(ins.rows.map((r) => [r.kode_jabatan, r.id]));
      const kompWithId = kompRows
        .filter((k) => idByKode.has(k.kode_jabatan))
        .map(({ kode_jabatan, ...k }) => ({ jabatan_id: idByKode.get(kode_jabatan), ...k }));
      if (kompWithId.length) {
        await client.query(
          `INSERT INTO kp_kompetensi (jabatan_id, sort_order, kelompok, kode, nama, definisi, level, indikator)
           SELECT r.jabatan_id, r.sort_order, r.kelompok, r.kode, r.nama, r.definisi, r.level, r.indikator
           FROM jsonb_to_recordset($1::jsonb) AS r(jabatan_id int, sort_order int, kelompok text, kode text,
                nama text, definisi text, level text, indikator text)`,
          [JSON.stringify(kompWithId)]
        );
      }
      await client.query('COMMIT');
      res.json({
        success: true,
        jabatan_inserted: ins.rows.length,
        jabatan_duplikat: jabRows.length - ins.rows.length,
        kompetensi_inserted: kompWithId.length,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[KP UPLOAD CHUNK ERROR]', e);
      res.status(500).json({ error: 'Gagal menyimpan data jabatan: ' + e.message });
    } finally {
      client.release();
    }
  });

  router.post('/batches/:id/finalize', authRequired, async (req, res) => {
    try {
      const { rowCount } = await pool.query(`UPDATE kp_batch SET status = 'ready' WHERE id = $1`, [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      res.json({ success: true });
    } catch (e) {
      console.error('[KP FINALIZE ERROR]', e);
      res.status(500).json({ error: 'Gagal memfinalkan batch' });
    }
  });

  // Hapus batch: approver/admin, atau pengunggah sendiri saat upload gagal (status uploading)
  router.delete('/batches/:id', authRequired, async (req, res) => {
    try {
      const batch = await getBatch(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      const isApprover = ['hc_approver', 'admin'].includes(req.user.role);
      const ownFailedUpload = batch.status === 'uploading' && batch.uploaded_by === req.user.email;
      if (!isApprover && !ownFailedUpload) {
        return res.status(403).json({ error: 'Hanya HC Approver/Admin yang bisa menghapus batch' });
      }
      await pool.query('DELETE FROM kp_batch WHERE id = $1', [batch.id]);
      res.json({ success: true });
    } catch (e) {
      console.error('[KP DELETE ERROR]', e);
      res.status(500).json({ error: 'Gagal menghapus batch' });
    }
  });

  // Pengaturan kop lampiran SK & tanda tangan
  router.get('/batches/:id/settings', authRequired, async (req, res) => {
    const batch = await getBatch(req.params.id).catch(() => null);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
    res.json({ settings: { ...DEFAULT_SETTINGS, ...batch.pengaturan } });
  });

  router.put('/batches/:id/settings', authRequired, approverOnly, async (req, res) => {
    try {
      const s = {};
      for (const k of SETTING_KEYS) {
        const v = req.body[k];
        s[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? Boolean(v) : String(v ?? '').slice(0, 1000);
      }
      const { rowCount } = await pool.query('UPDATE kp_batch SET pengaturan = $2 WHERE id = $1', [req.params.id, s]);
      if (!rowCount) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      res.json({ success: true, settings: s });
    } catch (e) {
      console.error('[KP SETTINGS ERROR]', e);
      res.status(500).json({ error: 'Gagal menyimpan pengaturan' });
    }
  });

  // Struktur job family → sub job family → jabatan (tanpa detail kompetensi)
  router.get('/batches/:id/tree', authRequired, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT j.kode_jabatan, j.nama_jabatan, j.job_family, j.sub_job_family, j.tingkat_jabatan,
                (SELECT COUNT(*) FROM kp_kompetensi k WHERE k.jabatan_id = j.id)::int AS kompetensi_count
         FROM kp_jabatan j WHERE j.batch_id = $1 ORDER BY j.sort_order, j.id`,
        [req.params.id]
      );
      res.json({ tree: groupTree(rows) });
    } catch (e) {
      console.error('[KP TREE ERROR]', e);
      res.status(500).json({ error: 'Gagal memuat struktur jabatan' });
    }
  });

  // ------------------------------------------------------------
  // EXPORT PDF
  // ------------------------------------------------------------
  // PDF satu jabatan
  router.get('/batches/:id/pdf/jabatan/:kode', authHeaderOrQuery, async (req, res) => {
    try {
      const batch = await getBatch(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      const [j] = await loadJabatan(batch.id, { kodeJabatan: req.params.kode });
      if (!j) return res.status(404).json({ error: 'Jabatan tidak ditemukan' });
      const buf = await renderPdf(docJabatan(j, batch.pengaturan));
      sendPdf(res, buf, `${safeName(j.kode_jabatan)} - ${safeName(j.nama_jabatan)}.pdf`, req.query.inline === '1');
    } catch (e) {
      console.error('[KP PDF JABATAN ERROR]', e);
      res.status(500).json({ error: 'Gagal membuat PDF' });
    }
  });

  // PDF buku satu job family (opsional: satu sub job family) — ?job_family=...&sub_job_family=...
  router.get('/batches/:id/pdf/kelompok', authHeaderOrQuery, async (req, res) => {
    try {
      const batch = await getBatch(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      const jobFamily = String(req.query.job_family ?? '');
      const hasSub = req.query.sub_job_family !== undefined;
      const subJobFamily = hasSub ? String(req.query.sub_job_family) : undefined;
      const jabatan = await loadJabatan(batch.id, { jobFamily, subJobFamily });
      if (jabatan.length === 0) return res.status(404).json({ error: 'Tidak ada jabatan pada kelompok ini' });
      const buf = await renderKelompok(
        { jobFamily: jobFamily || '(Tanpa Job Family)', subJobFamily: hasSub ? subJobFamily || '(Tanpa Sub Job Family)' : null, jabatan },
        batch.pengaturan
      );
      const name = hasSub ? `${safeName(jobFamily)} - ${safeName(subJobFamily)}.pdf` : `${safeName(jobFamily)}.pdf`;
      sendPdf(res, buf, name, req.query.inline === '1');
    } catch (e) {
      console.error('[KP PDF KELOMPOK ERROR]', e);
      res.status(500).json({ error: 'Gagal membuat PDF' });
    }
  });

  // ZIP massal — ?mode=jabatan | sub_job_family | job_family  (opsional &job_family=... untuk satu job family)
  router.get('/batches/:id/zip', authHeaderOrQuery, async (req, res) => {
    let archive;
    try {
      const batch = await getBatch(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
      const mode = ['jabatan', 'sub_job_family', 'job_family'].includes(req.query.mode) ? req.query.mode : 'jabatan';
      const filter = req.query.job_family !== undefined ? { jobFamily: String(req.query.job_family) } : {};
      const jabatan = await loadJabatan(batch.id, filter);
      if (jabatan.length === 0) return res.status(404).json({ error: 'Tidak ada jabatan untuk diexport' });
      const tree = groupTree(jabatan);
      const s = batch.pengaturan;

      // Daftar pekerjaan: [nama file di dalam zip, fungsi yang menghasilkan Promise<Buffer> PDF]
      const jobs = [];
      tree.forEach((fam, fi) => {
        const famDir = `${String(fi + 1).padStart(2, '0')}. ${safeName(fam.jobFamily || 'Tanpa Job Family')}`;
        if (mode === 'job_family') {
          jobs.push([`${famDir}.pdf`, () => renderKelompok({ jobFamily: fam.jobFamily || '(Tanpa Job Family)', subJobFamily: null, jabatan: flat(fam) }, s)]);
          return;
        }
        fam.subs.forEach((sub, si) => {
          const subName = `${String(si + 1).padStart(2, '0')}. ${safeName(sub.subJobFamily || 'Tanpa Sub Job Family')}`;
          if (mode === 'sub_job_family') {
            jobs.push([`${famDir}/${subName}.pdf`, () => renderKelompok({
              jobFamily: fam.jobFamily || '(Tanpa Job Family)',
              subJobFamily: sub.subJobFamily || '(Tanpa Sub Job Family)',
              jabatan: sub.jabatan,
            }, s)]);
            return;
          }
          sub.jabatan.forEach((j) => {
            jobs.push([`${famDir}/${subName}/${safeName(j.kode_jabatan)} - ${safeName(j.nama_jabatan)}.pdf`, () => renderPdf(docJabatan(j, s))]);
          });
        });
      });

      const zipName = `${safeName(batch.batch_name)} - PDF per ${mode.replace(/_/g, ' ')}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);

      archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('warning', (w) => console.warn('[KP ZIP WARN]', w));
      archive.on('error', (err) => { console.error('[KP ZIP ERROR]', err); res.destroy(err); });
      let aborted = false;
      req.on('close', () => { if (!res.writableFinished) { aborted = true; archive.abort(); } });
      archive.pipe(res);

      // Satu per satu agar memori server tetap rendah walau ribuan jabatan
      for (const [name, build] of jobs) {
        if (aborted) return;
        const buf = await build();
        await new Promise((resolve) => {
          archive.once('entry', resolve);
          archive.append(buf, { name });
        });
      }
      await archive.finalize();
    } catch (e) {
      console.error('[KP ZIP ERROR]', e);
      if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat ZIP' });
      else res.destroy(e);
    }
  });

  return router;
};
