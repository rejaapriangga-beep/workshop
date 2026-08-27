// Jalankan: node create-admin.js "email@kai.id" "PasswordAman" "Nama Lengkap" "admin"
// Role yang valid: admin | hc_approver | submitter
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const [, , email, password, nama, role] = process.argv;

if (!email || !password) {
  console.error('Pemakaian: node create-admin.js <email> <password> [nama] [role]');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO approval_users (email, password_hash, nama, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2, nama = $3, role = $4
       RETURNING id, email, nama, role`,
      [email.toLowerCase().trim(), hash, nama || email, role || 'admin']
    );
    console.log('User berhasil dibuat/diupdate:', rows[0]);
    process.exit(0);
  } catch (e) {
    console.error('Gagal membuat user:', e.message);
    process.exit(1);
  }
})();
