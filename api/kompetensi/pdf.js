// Penyusun dokumen PDF Profil Kompetensi Jabatan (pdfmake, server-side).
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const PdfPrinter = require('pdfmake');
const vfs = require('pdfmake/build/vfs_fonts.js');

const font = (name) => Buffer.from(vfs[name], 'base64');
const printer = new PdfPrinter({
  Roboto: {
    normal: font('Roboto-Regular.ttf'),
    bold: font('Roboto-Medium.ttf'),
    italics: font('Roboto-Italic.ttf'),
    bolditalics: font('Roboto-MediumItalic.ttf'),
  },
});

const NAVY = '#0F2A4A';
const SHADE = '#E8ECF4';
const LINE = '#9AA3B8';

const DEFAULT_SETTINGS = {
  judul: 'PROFIL KOMPETENSI JABATAN',
  nama_perusahaan: '',
  lampiran_label: 'LAMPIRAN',
  nomor_sk: '',
  tanggal_sk: '',
  perihal: '',
  tampilkan_kop: true,
  tampilkan_ttd: false,
  tempat_ttd: '',
  tanggal_ttd: '',
  jabatan_ttd: '',
  nama_ttd: '',
};

function withDefaults(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

const txt = (v) => (v === null || v === undefined ? '' : String(v));

// Kop "Lampiran Keputusan Direksi" di kanan atas
function kopLampiran(s) {
  if (!s.tampilkan_kop) return null;
  const rows = [];
  const first = [s.lampiran_label, s.nama_perusahaan ? `KEPUTUSAN DIREKSI ${s.nama_perusahaan}` : 'KEPUTUSAN DIREKSI']
    .filter(Boolean).join('\n');
  rows.push([{ text: first, colSpan: 3, bold: true }, {}, {}]);
  if (s.nomor_sk) rows.push(['NOMOR', ':', s.nomor_sk]);
  if (s.tanggal_sk) rows.push(['TANGGAL', ':', s.tanggal_sk]);
  if (s.perihal) rows.push(['TENTANG', ':', s.perihal]);
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 230,
        table: { widths: [52, 6, '*'], body: rows },
        layout: 'noBorders',
        fontSize: 8,
      },
    ],
    margin: [0, 0, 0, 14],
  };
}

function tandaTangan(s) {
  if (!s.tampilkan_ttd) return null;
  const lines = [];
  if (s.tempat_ttd) lines.push({ columns: [{ text: 'Ditetapkan di', width: 70 }, { text: `: ${s.tempat_ttd}` }] });
  if (s.tanggal_ttd) lines.push({ columns: [{ text: 'Pada tanggal', width: 70 }, { text: `: ${s.tanggal_ttd}` }] });
  if (s.jabatan_ttd) lines.push({ text: s.jabatan_ttd, bold: true, margin: [0, 8, 0, 0] });
  lines.push({ text: s.nama_ttd || ' ', bold: true, decoration: s.nama_ttd ? 'underline' : undefined, margin: [0, 50, 0, 0] });
  return {
    unbreakable: true,
    margin: [0, 24, 0, 0],
    columns: [{ width: '*', text: '' }, { width: 220, stack: lines, fontSize: 9 }],
  };
}

function identitas(j) {
  const rows = [
    ['Nama Jabatan', j.nama_jabatan],
    ['Kode Jabatan', j.kode_jabatan],
    ['Job Family', j.job_family],
    ['Sub Job Family', j.sub_job_family],
    ['Unit Kerja', j.unit_kerja],
    ['Tingkat Jabatan', j.tingkat_jabatan],
    ['Jenis Jabatan', j.jenis_jabatan],
  ].filter(([, v]) => txt(v).trim() !== '');
  const body = rows.map(([k, v]) => [
    { text: k, bold: true },
    ':',
    { text: txt(v), bold: k === 'Nama Jabatan' },
  ]);
  const out = [{ table: { widths: [95, 6, '*'], body }, layout: 'noBorders', fontSize: 9.5, margin: [0, 0, 0, 8] }];
  if (txt(j.tujuan_jabatan).trim()) {
    out.push({ text: 'Tujuan Jabatan', bold: true, fontSize: 9.5, margin: [0, 2, 0, 2] });
    out.push({ text: txt(j.tujuan_jabatan), fontSize: 9, alignment: 'justify', margin: [0, 0, 0, 8] });
  }
  return out;
}

function indikatorBlock(indikator) {
  const items = txt(indikator)
    .split(/\r?\n|;\s*(?=\S)/)
    .map((x) => x.replace(/^\s*([-•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return {
    stack: [
      { text: 'Indikator Perilaku:', italics: true, bold: true, fontSize: 8, margin: [0, 4, 0, 1] },
      items.length === 1 ? { text: items[0], fontSize: 8 } : { ul: items, fontSize: 8 },
    ],
  };
}

function tabelKompetensi(kompetensi) {
  if (!kompetensi || kompetensi.length === 0) {
    return { text: 'Belum ada data kompetensi untuk jabatan ini.', italics: true, color: '#666', fontSize: 9 };
  }
  const head = ['No', 'Kompetensi', 'Definisi', 'Level'].map((t) => ({
    text: t, bold: true, color: '#fff', fillColor: NAVY, alignment: 'center', fontSize: 9,
  }));
  const body = [head];

  // Kelompokkan sesuai urutan kemunculan
  const groups = [];
  const idx = new Map();
  for (const k of kompetensi) {
    const g = txt(k.kelompok).trim();
    if (!idx.has(g)) { idx.set(g, groups.length); groups.push({ name: g, items: [] }); }
    groups[idx.get(g)].items.push(k);
  }
  const hasGroups = groups.some((g) => g.name);

  groups.forEach((g, gi) => {
    if (hasGroups) {
      const label = (g.name || 'Lainnya').toUpperCase();
      body.push([
        { text: `${String.fromCharCode(65 + (gi % 26))}. ${label}`, colSpan: 4, bold: true, fillColor: SHADE, fontSize: 9 },
        {}, {}, {},
      ]);
    }
    g.items.forEach((k, i) => {
      const def = [];
      if (txt(k.definisi).trim()) def.push({ text: txt(k.definisi) });
      const ind = indikatorBlock(k.indikator);
      if (ind) def.push(ind);
      body.push([
        { text: String(i + 1), alignment: 'center' },
        { stack: [{ text: txt(k.nama), bold: true }, k.kode ? { text: txt(k.kode), fontSize: 7.5, color: '#555' } : ''] },
        def.length ? { stack: def } : '-',
        { text: txt(k.level) || '-', alignment: 'center', bold: true },
      ]);
    });
  });

  return {
    table: { headerRows: 1, dontBreakRows: true, widths: [20, 110, '*', 42], body },
    layout: {
      hLineWidth: () => 0.5, vLineWidth: () => 0.5,
      hLineColor: () => LINE, vLineColor: () => LINE,
      paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3,
    },
    fontSize: 8.5,
  };
}

// Isi satu jabatan (dipakai di PDF tunggal maupun buku kelompok)
function kontenJabatan(j, s, { pageBreak = false, tocItem = false } = {}) {
  const out = [];
  const kop = kopLampiran(s);
  const title = {
    text: s.judul || DEFAULT_SETTINGS.judul,
    style: 'title',
    margin: [0, 0, 0, 2],
  };
  const subtitle = {
    text: txt(j.nama_jabatan).toUpperCase(),
    style: 'subtitle',
    margin: [0, 0, 0, 12],
  };
  if (tocItem) {
    subtitle.tocItem = true;
    subtitle.tocMargin = [24, 0, 0, 0];
    subtitle.tocStyle = { fontSize: 8.5 };
  }
  const first = kop || title;
  if (pageBreak) first.pageBreak = 'before';
  if (kop) out.push(kop);
  out.push(title, subtitle, ...identitas(j));
  out.push({ text: 'Kompetensi yang Dipersyaratkan', bold: true, fontSize: 10, margin: [0, 4, 0, 4] });
  out.push(tabelKompetensi(j.kompetensi));
  return out;
}

function baseDoc(s, footerLabel, content) {
  return {
    pageSize: 'A4',
    pageMargins: [50, 45, 50, 50],
    info: { title: footerLabel, author: s.nama_perusahaan || '', subject: s.judul },
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.15 },
    styles: {
      title: { fontSize: 13, bold: true, alignment: 'center', color: NAVY },
      subtitle: { fontSize: 11, bold: true, alignment: 'center' },
      h1: { fontSize: 12, bold: true, color: NAVY },
    },
    footer: (page, pages) => ({
      margin: [50, 15, 50, 0],
      columns: [
        { text: footerLabel, fontSize: 7, color: '#777' },
        { text: `Halaman ${page} dari ${pages}`, alignment: 'right', fontSize: 7, color: '#777' },
      ],
    }),
    content,
  };
}

function docJabatan(j, settings) {
  const s = withDefaults(settings);
  const content = kontenJabatan(j, s);
  const ttd = tandaTangan(s);
  if (ttd) content.push(ttd);
  return baseDoc(s, `${s.judul} — ${j.kode_jabatan} ${j.nama_jabatan}`, content);
}

// Buku kelompok: sampul + daftar isi + semua jabatan (dikelompokkan per sub job family)
function docKelompok({ jobFamily, subJobFamily, jabatan }, settings) {
  const s = withDefaults(settings);
  const label = subJobFamily ? `${jobFamily} — ${subJobFamily}` : jobFamily;
  const subs = [];
  const subIdx = new Map();
  for (const j of jabatan) {
    const k = txt(j.sub_job_family).trim() || '(Tanpa Sub Job Family)';
    if (!subIdx.has(k)) { subIdx.set(k, subs.length); subs.push({ name: k, items: [] }); }
    subs[subIdx.get(k)].items.push(j);
  }

  const content = [];
  const kop = kopLampiran(s);
  if (kop) content.push(kop);
  content.push(
    { text: s.judul, style: 'title', fontSize: 18, margin: [0, 150, 0, 16] },
    { text: 'JOB FAMILY', alignment: 'center', fontSize: 10, color: '#555' },
    { text: txt(jobFamily).toUpperCase(), alignment: 'center', fontSize: 15, bold: true, margin: [0, 2, 0, 12] },
  );
  if (subJobFamily) {
    content.push(
      { text: 'SUB JOB FAMILY', alignment: 'center', fontSize: 10, color: '#555' },
      { text: txt(subJobFamily).toUpperCase(), alignment: 'center', fontSize: 13, bold: true, margin: [0, 2, 0, 12] },
    );
  }
  content.push({ text: `Jumlah jabatan: ${jabatan.length}`, alignment: 'center', fontSize: 10, margin: [0, 8, 0, 0] });
  if (s.nama_perusahaan) content.push({ text: s.nama_perusahaan, alignment: 'center', bold: true, fontSize: 11, margin: [0, 120, 0, 0] });

  content.push({
    toc: { title: { text: 'DAFTAR ISI', style: 'title', margin: [0, 0, 0, 12] }, numberStyle: { fontSize: 8.5 } },
    pageBreak: 'before',
  });

  const showSubHeading = !subJobFamily;
  subs.forEach((sub) => {
    if (showSubHeading) {
      content.push({
        text: `Sub Job Family: ${sub.name}`,
        style: 'h1',
        tocItem: true,
        tocStyle: { bold: true, fontSize: 9 },
        tocMargin: [0, 6, 0, 0],
        pageBreak: 'before',
        margin: [0, 280, 0, 0],
        alignment: 'center',
      });
      content.push({ text: `${sub.items.length} jabatan`, alignment: 'center', color: '#555' });
    }
    sub.items.forEach((j, i) => {
      content.push(...kontenJabatan(j, s, { pageBreak: true, tocItem: true }));
    });
  });

  const ttd = tandaTangan(s);
  if (ttd) content.push(ttd);
  return baseDoc(s, `${s.judul} — ${label}`, content);
}

// Render docDefinition → Buffer
function renderPdf(docDefinition) {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// Buku kelompok bisa ratusan–ribuan halaman dan memakan memori besar saat layout.
// Dirender di worker thread terpisah supaya memorinya dilepas setelah selesai dan
// proses API utama tidak ikut crash bila kehabisan memori.
function renderKelompok(args, settings) {
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new Worker(__filename, {
      workerData: { kpRenderKelompok: true, args, settings },
      resourceLimits: { maxOldGenerationSizeMb: 4096 },
    });
    w.once('message', (msg) => {
      done = true;
      if (msg.error) reject(new Error(msg.error)); else resolve(Buffer.from(msg.pdf));
    });
    w.once('error', (e) => { done = true; reject(e); });
    w.once('exit', (code) => { if (!done) reject(new Error('Proses render PDF berhenti (kode ' + code + ')')); });
  });
}

if (!isMainThread && workerData && workerData.kpRenderKelompok) {
  renderPdf(docKelompok(workerData.args, workerData.settings))
    .then((buf) => parentPort.postMessage({ pdf: buf }))
    .catch((e) => parentPort.postMessage({ error: e.message }));
}

module.exports = { docJabatan, docKelompok, renderPdf, renderKelompok, DEFAULT_SETTINGS };
