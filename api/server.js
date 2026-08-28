require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const PORT = process.env.PORT || 3005;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET belum diset di .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
}

function approverOnly(req, res, next) {
  if (!['hc_approver', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Hanya HC Approver/Admin yang bisa melakukan aksi ini' });
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya Admin yang bisa melakukan aksi ini' });
  }
  next();
}

const VALID_ROLES = ['admin', 'hc_approver', 'submitter'];

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

    const { rows } = await pool.query('SELECT * FROM approval_users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Email atau password salah' });
    if (user.is_active === false) return res.status(401).json({ error: 'Akun ini sudah dinonaktifkan' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Email atau password salah' });

    const token = jwt.sign(
      { id: user.id, email: user.email, nama: user.nama, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user.id, email: user.email, nama: user.nama, role: user.role } });
  } catch (e) {
    console.error('[LOGIN ERROR]', e);
    res.status(500).json({ error: 'Gagal login' });
  }
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// Ganti password akun sendiri (semua role, bukan cuma admin)
app.put('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Password lama dan password baru wajib diisi' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM approval_users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Password lama salah' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE approval_users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[CHANGE PASSWORD ERROR]', e);
    res.status(500).json({ error: 'Gagal mengubah password' });
  }
});

// ============================================================
// KELOLA USER (admin only)
// ============================================================
app.get('/api/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, nama, role, is_active, created_at
       FROM approval_users ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (e) {
    console.error('[USERS LIST ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat daftar user' });
  }
});

app.post('/api/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { email, password, nama, role } = req.body;
    if (!email || !password || !nama || !role) {
      return res.status(400).json({ error: 'Email, password, nama, dan role wajib diisi' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role tidak valid. Pilihan: ${VALID_ROLES.join(', ')}` });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO approval_users (email, password_hash, nama, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, nama, role, is_active, created_at`,
      [email.toLowerCase().trim(), hash, nama, role]
    );
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email ini sudah terdaftar' });
    console.error('[USER CREATE ERROR]', e);
    res.status(500).json({ error: 'Gagal membuat user' });
  }
});

app.put('/api/users/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { nama, role, password, is_active } = req.body;
    const targetId = parseInt(id, 10);
    const isSelf = targetId === req.user.id;

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role tidak valid. Pilihan: ${VALID_ROLES.join(', ')}` });
    }
    if (isSelf && role !== undefined && role !== 'admin') {
      return res.status(400).json({ error: 'Tidak bisa mengubah role akun sendiri menjadi non-admin' });
    }
    if (isSelf && is_active === false) {
      return res.status(400).json({ error: 'Tidak bisa menonaktifkan akun sendiri' });
    }
    if (password !== undefined && password.length > 0 && password.length < 6) {
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (nama !== undefined) { fields.push(`nama = $${i++}`); values.push(nama); }
    if (role !== undefined) { fields.push(`role = $${i++}`); values.push(role); }
    if (is_active !== undefined) { fields.push(`is_active = $${i++}`); values.push(is_active); }
    if (password !== undefined && password.length > 0) {
      const hash = await bcrypt.hash(password, 10);
      fields.push(`password_hash = $${i++}`);
      values.push(hash);
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Tidak ada perubahan yang dikirim' });

    values.push(targetId);
    const { rows } = await pool.query(
      `UPDATE approval_users SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, email, nama, role, is_active, created_at`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email ini sudah terdaftar' });
    console.error('[USER UPDATE ERROR]', e);
    res.status(500).json({ error: 'Gagal mengubah user' });
  }
});

// Nonaktifkan user (soft-delete). approval_users direferensi via FK oleh
// data approval lain, jadi hapus permanen tidak dipakai di sini.
app.delete('/api/users/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = parseInt(id, 10);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Tidak bisa menonaktifkan akun sendiri' });
    }

    const { rows } = await pool.query(
      `UPDATE approval_users SET is_active = false WHERE id = $1
       RETURNING id, email, nama, role, is_active, created_at`,
      [targetId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ success: true, user: rows[0] });
  } catch (e) {
    console.error('[USER DEACTIVATE ERROR]', e);
    res.status(500).json({ error: 'Gagal menonaktifkan user' });
  }
});

// ============================================================
// APPROVAL MODULES (landing page "Approval Center")
// ============================================================
app.get('/api/modules', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, module_key, module_name, description, url_slug FROM approval_modules WHERE is_active = true ORDER BY id'
    );
    res.json({ modules: rows });
  } catch (e) {
    console.error('[MODULES ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat daftar modul' });
  }
});

// ============================================================
// CAREER PATH APPROVAL — BATCH MANAGEMENT
// ============================================================

// List semua batch + ringkasan status (berbasis LINK, bukan jabatan)
app.get('/api/cp/batches', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, b.batch_name, b.source_file, b.status, b.created_at,
        COUNT(nx.id) FILTER (WHERE nx.status = 'pending')  AS pending_count,
        COUNT(nx.id) FILTER (WHERE nx.status = 'approved') AS approved_count,
        COUNT(nx.id) FILTER (WHERE nx.status = 'rejected') AS rejected_count,
        COUNT(nx.id) AS total_count
      FROM cp_import_batch b
      LEFT JOIN cp_draft_node_nexts nx ON nx.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    res.json({ batches: rows });
  } catch (e) {
    console.error('[BATCHES ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat daftar batch' });
  }
});

// Upload batch baru — terima 2 file CSV: nodes_file & nexts_file
app.post(
  '/api/cp/batches',
  authRequired,
  upload.fields([{ name: 'nodes_file', maxCount: 1 }, { name: 'nexts_file', maxCount: 1 }]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { batch_name } = req.body;
      const nodesFile = req.files?.nodes_file?.[0];
      const nextsFile = req.files?.nexts_file?.[0];
      if (!batch_name || !nodesFile || !nextsFile) {
        return res.status(400).json({ error: 'batch_name, nodes_file, dan nexts_file wajib diisi' });
      }

      const nodeRows = parse(nodesFile.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
      const nextRows = parse(nextsFile.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });

      if (nodeRows.length === 0) return res.status(400).json({ error: 'File nodes kosong atau format kolom salah' });

      await client.query('BEGIN');

      const batchRes = await client.query(
        `INSERT INTO cp_import_batch (batch_name, source_file, uploaded_by, status)
         VALUES ($1, $2, $3, 'in_review') RETURNING id`,
        [batch_name, nodesFile.originalname, req.user.id]
      );
      const batchId = batchRes.rows[0].id;

      for (const n of nodeRows) {
        if (!n.id_jabatan || !n.nama_jabatan) continue;
        await client.query(
          `INSERT INTO cp_draft_nodes
            (batch_id, id_jabatan, id_job_family, nama_job_family, id_sub_job_family, nama_sub_job_family,
             singkatan_jabatan, nama_jabatan, tingkat_jabatan, jenis_jabatan, masa, min_edu)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (batch_id, id_jabatan) DO NOTHING`,
          [
            batchId, n.id_jabatan, n.id_job_family || null, n.nama_job_family || null,
            n.id_sub_job_family || null, n.nama_sub_job_family || null, n.singkatan_jabatan || null,
            n.nama_jabatan, n.tingkat_jabatan ? parseInt(n.tingkat_jabatan) : null,
            n.jenis_jabatan || null, n.masa ? parseInt(n.masa) : null, n.min_edu || null,
          ]
        );
        await client.query(
          `INSERT INTO cp_job_approval (batch_id, id_jabatan, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (batch_id, id_jabatan) DO NOTHING`,
          [batchId, n.id_jabatan]
        );
      }

      for (const nx of nextRows) {
        if (!nx.from_job_id || !nx.to_job_id || !nx.action) continue;
        await client.query(
          `INSERT INTO cp_draft_node_nexts (batch_id, from_job_id, to_job_id, action, lintas_job_fam, target_job_fam)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            batchId, nx.from_job_id, nx.to_job_id, nx.action.toUpperCase(),
            ['true', 't', '1'].includes(String(nx.lintas_job_fam).toLowerCase()),
            nx.target_job_fam || null,
          ]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, batch_id: batchId, nodes_imported: nodeRows.length, nexts_imported: nextRows.length });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[UPLOAD BATCH ERROR]', e);
      res.status(500).json({ error: 'Gagal mengimpor batch: ' + e.message });
    } finally {
      client.release();
    }
  }
);

// Grid data — semua node dalam batch, dikelompokkan per job family, plus status approval
app.get('/api/cp/batches/:id/nodes', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT n.*, a.status AS approval_status, a.reviewed_at, a.notes
       FROM cp_draft_nodes n
       JOIN cp_job_approval a ON a.batch_id = n.batch_id AND a.id_jabatan = n.id_jabatan
       WHERE n.batch_id = $1
       ORDER BY n.nama_job_family, n.tingkat_jabatan, n.nama_jabatan`,
      [id]
    );
    res.json({ nodes: rows });
  } catch (e) {
    console.error('[BATCH NODES ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat data jabatan' });
  }
});

// Detail 1 jabatan — termasuk jalur keluar & masuk
app.get('/api/cp/batches/:id/nodes/:idJabatan', authRequired, async (req, res) => {
  try {
    const { id, idJabatan } = req.params;
    const nodeRes = await pool.query(
      `SELECT * FROM cp_draft_nodes WHERE batch_id = $1 AND id_jabatan = $2`,
      [id, idJabatan]
    );
    if (nodeRes.rows.length === 0) return res.status(404).json({ error: 'Jabatan tidak ditemukan di batch ini' });

    const outRes = await pool.query(
      `SELECT nx.*, dn.nama_jabatan AS to_nama_jabatan, dn.tingkat_jabatan AS to_grade
       FROM cp_draft_node_nexts nx
       LEFT JOIN cp_draft_nodes dn ON dn.batch_id = nx.batch_id AND dn.id_jabatan = nx.to_job_id
       WHERE nx.batch_id = $1 AND nx.from_job_id = $2`,
      [id, idJabatan]
    );
    const inRes = await pool.query(
      `SELECT nx.*, dn.nama_jabatan AS from_nama_jabatan, dn.tingkat_jabatan AS from_grade
       FROM cp_draft_node_nexts nx
       LEFT JOIN cp_draft_nodes dn ON dn.batch_id = nx.batch_id AND dn.id_jabatan = nx.from_job_id
       WHERE nx.batch_id = $1 AND nx.to_job_id = $2`,
      [id, idJabatan]
    );

    res.json({ node: nodeRes.rows[0], outgoing: outRes.rows, incoming: inRes.rows });
  } catch (e) {
    console.error('[NODE DETAIL ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat detail jabatan' });
  }
});

// Semua link (panah) dalam satu batch — dipakai untuk gambar arrow + tombol approve/reject per link
app.get('/api/cp/batches/:id/links', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM cp_draft_node_nexts WHERE batch_id = $1 ORDER BY id`,
      [id]
    );
    res.json({ links: rows });
  } catch (e) {
    console.error('[LINKS ERROR]', e);
    res.status(500).json({ error: 'Gagal memuat data jalur' });
  }
});

// Approve / reject satu LINK (panah) — granularitas baru
app.post('/api/cp/batches/:id/links/:linkId/:decision', authRequired, approverOnly, async (req, res) => {
  try {
    const { id, linkId, decision } = req.params;
    const notes = req.body?.notes;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Aksi tidak valid' });
    const status = decision === 'approve' ? 'approved' : 'rejected';

    const { rows } = await pool.query(
      `UPDATE cp_draft_node_nexts
       SET status = $1, reviewed_by = $2, reviewed_at = now(), notes = $3
       WHERE id = $4 AND batch_id = $5
       RETURNING *`,
      [status, req.user.id, notes || null, linkId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Link tidak ditemukan di batch ini' });
    res.json({ success: true, link: rows[0] });
  } catch (e) {
    console.error('[LINK APPROVE/REJECT ERROR]', e);
    res.status(500).json({ error: 'Gagal memproses keputusan' });
  }
});

// Approve / reject satu jabatan
app.post('/api/cp/batches/:id/nodes/:idJabatan/:decision', authRequired, approverOnly, async (req, res) => {
  try {
    const { id, idJabatan, decision } = req.params;
    const { notes } = req.body;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Aksi tidak valid' });
    const status = decision === 'approve' ? 'approved' : 'rejected';

    const { rows } = await pool.query(
      `UPDATE cp_job_approval
       SET status = $1, reviewed_by = $2, reviewed_at = now(), notes = $3
       WHERE batch_id = $4 AND id_jabatan = $5
       RETURNING *`,
      [status, req.user.id, notes || null, id, idJabatan]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Jabatan tidak ditemukan di batch ini' });
    res.json({ success: true, approval: rows[0] });
  } catch (e) {
    console.error('[APPROVE/REJECT ERROR]', e);
    res.status(500).json({ error: 'Gagal memproses keputusan' });
  }
});

// Export CSV V.2 (Final) — semua jabatan (master data), tapi jalur (nexts) hanya yang berstatus approved
app.get('/api/cp/batches/:id/export', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const nodesRes = await pool.query(
      `SELECT * FROM cp_draft_nodes WHERE batch_id = $1 ORDER BY nama_job_family, tingkat_jabatan`,
      [id]
    );
    const approvedLinksRes = await pool.query(
      `SELECT * FROM cp_draft_node_nexts WHERE batch_id = $1 AND status = 'approved' ORDER BY id`,
      [id]
    );
    if (approvedLinksRes.rows.length === 0) return res.status(400).json({ error: 'Belum ada jalur (panah) yang approved di batch ini' });

    const nodesCsv = stringify(nodesRes.rows, {
      header: true,
      columns: [
        'id_jabatan', 'id_job_family', 'nama_job_family', 'id_sub_job_family', 'nama_sub_job_family',
        'singkatan_jabatan', 'nama_jabatan', 'tingkat_jabatan', 'jenis_jabatan', 'masa', 'min_edu',
      ],
    });
    const nextsCsv = stringify(approvedLinksRes.rows, {
      header: true,
      columns: ['from_job_id', 'to_job_id', 'action', 'lintas_job_fam', 'target_job_fam'],
    });

    res.json({ nodes_csv: nodesCsv, nexts_csv: nextsCsv, approved_count: approvedLinksRes.rows.length });
  } catch (e) {
    console.error('[EXPORT ERROR]', e);
    res.status(500).json({ error: 'Gagal export CSV Final' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`[workshop-api] listening on port ${PORT}`));
