// Arjuna Sport Massage - server (Apps Script). Dibuat otomatis, jangan diedit manual.
/* ===== Arjuna Sport Massage: logika server (dipakai Apps Script & uji lokal) ===== */
var VERSION = 1;
var LOCK_SET = { MENUNGGU: 1, DIKONFIRMASI: 1, DP: 1, LUNAS: 1, SELESAI: 1, TIDAK_DATANG: 1 };
var COLLS = { bookings: 1, kas: 1, blokir: 1 };

function pad(n) { return (n < 10 ? '0' : '') + n; }
function pd(s) { var p = String(s).split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function toHM(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
function tsOf(date, hm) { var d = pd(date), m = toMin(hm); d.setHours(Math.floor(m / 60), m % 60, 0, 0); return d.getTime(); }
function dayDiff(a, b) { return Math.round((pd(b) - pd(a)) / 864e5); }
function ov(a, b, gap) { return a[0] < b[1] + gap && b[0] < a[1] + gap; }
function normWa(w) { var d = String(w || '').replace(/\D/g, ''); if (d.indexOf('0') === 0) d = '62' + d.slice(1); else if (d.indexOf('8') === 0) d = '62' + d; return d; }
function uid() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
function cap(s, n) { return String(s == null ? '' : s).slice(0, n); }

function blocksFor(st, date) {
  var ex = (st.pengecualian || []).filter(function (e) { return e.tgl === date; })[0];
  var raw = ex ? (ex.tipe === 'libur' ? [] : ex.blok) : ((st.jam || {})[pd(date).getDay()] || []);
  return raw.map(function (b) { return [toMin(b[0]), toMin(b[1])]; }).filter(function (b) { return b[1] > b[0]; });
}
function occ(b) { var s = toMin(b.jam), buf = b.lokasi === 'rumah' ? (+b.buffer || 0) : 0; return [s - buf, s + (+b.durasi) + buf]; }

/* status slot untuk pasien (sama dengan logika di tampilan) */
function slotStatus(st, blokir, idx, date, t, dur, lok, now) {
  var buf = lok === 'rumah' ? (+(st.hv || {}).buffer || 0) : 0;
  if (tsOf(date, toHM(t)) < now + (+st.minLeadJam || 0) * 36e5) return 'lewat';
  if (dayDiff(ymd(new Date(now)), date) >= (+st.maxHari || 30)) return 'lewat';
  if (!blocksFor(st, date).some(function (x) { return t >= x[0] && t + dur <= x[1]; })) return 'pendek';
  var me = [t - buf, t + dur + buf], gap = +st.jeda || 0, i;
  for (i = 0; i < blokir.length; i++) { var m = blokir[i]; if (m.tgl === date && ov(me, [toMin(m.dari), toMin(m.sampai)], 0)) return 'blok'; }
  var n = 0, hit = null;
  for (i = 0; i < idx.length; i++) {
    var b = idx[i]; if (b.tgl !== date || !LOCK_SET[b.status]) continue; n++;
    if (!hit && ov(me, occ(b), gap)) hit = b;
  }
  if (hit) return hit.status === 'MENUNGGU' ? 'ditahan' : 'terisi';
  if (n >= (+st.maxSesi || 99)) return 'penuh';
  return 'ok';
}

/* ---------- respons umum ---------- */
function ok(x) { x = x || {}; x.ok = true; return x; }
function fail(code, msg) { return { ok: false, err: code, msg: msg || code }; }

/* ---------- kedaluwarsa otomatis ---------- */
function expire(env, db) {
  var now = env.now(), changed = 0;
  var idx = db.index();
  idx.forEach(function (b) {
    if (b.status === 'MENUNGGU' && now > b.holdUntil) {
      var rec = db.get('bookings', b.id); if (!rec) return;
      rec.status = 'KEDALUWARSA';
      (rec.riwayat = rec.riwayat || []).push({ t: b.holdUntil, x: 'Waktu tahan habis, jadwal dilepas otomatis' });
      db.put('bookings', rec); changed++;
    }
  });
  return changed;
}
function needsExpire(env, idx) { var now = env.now(); return idx.some(function (b) { return b.status === 'MENUNGGU' && now > b.holdUntil; }); }

/* ---------- publik ---------- */
function pub(env, db) {
  var st = db.getSettings();
  if (!st) return ok({ ready: false });
  var idx = db.index();
  if (needsExpire(env, idx)) { env.withLock(function () { expire(env, db); }); idx = db.index(); }
  var y = ymd(new Date(env.now() - 864e5));
  var slots = idx.filter(function (b) { return b.tgl >= y; }).map(function (b) {
    return { id: b.id, tgl: b.tgl, jam: b.jam, durasi: b.durasi, lokasi: b.lokasi, buffer: b.buffer, status: b.status, holdUntil: b.holdUntil };
  });
  var blokir = db.all('blokir').filter(function (m) { return m.tgl >= y; });
  var pubSt = JSON.parse(JSON.stringify(st)); delete pubSt.pin;
  return ok({ ready: true, settings: pubSt, slots: slots, blokir: blokir, now: env.now() });
}

function makeKode(tgl, used) {
  var c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', k, d = pd(tgl);
  do { k = 'SM-' + pad(d.getDate()) + pad(d.getMonth() + 1) + '-'; for (var i = 0; i < 3; i++) k += c[Math.floor(Math.random() * c.length)]; } while (used[k]);
  return k;
}
function dpOf(st, total) { return Math.ceil(total * (+st.dpPersen || 0) / 100 / 1000) * 1000; }

function book(env, db, q) {
  var inp = q.b || {}, st = db.getSettings();
  if (!st) return fail('belum_dibuka', 'Reservasi belum dibuka.');
  var L = (st.layanan || []).filter(function (l) { return l.id === inp.layanan; })[0];
  if (!L) return fail('data', 'Layanan tidak ditemukan.');
  var lok = inp.lokasi === 'rumah' ? 'rumah' : 'studio';
  if (lok === 'rumah' && !(st.hv && st.hv.aktif)) return fail('data', 'Home visit tidak tersedia.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.tgl || '') || !/^\d{2}:\d{2}$/.test(inp.jam || '')) return fail('data', 'Tanggal atau jam tidak valid.');
  var p = inp.pasien || {}, nama = cap(p.nama, 80).trim(), wa = normWa(p.wa);
  if (nama.length < 3) return fail('data', 'Nama terlalu pendek.');
  if (wa.length < 10 || wa.length > 15 || wa.indexOf('62') !== 0) return fail('data', 'Nomor WhatsApp tidak valid.');
  if (lok === 'rumah' && cap(p.alamat, 300).trim().length < 8) return fail('data', 'Alamat home visit belum lengkap.');
  var metode = ['qris', 'transfer', 'tunai'].indexOf(inp.metode) >= 0 ? inp.metode : '';
  if (!metode) return fail('data', 'Cara bayar belum dipilih.');
  var asesmen = inp.asesmen || {}, event = inp.event || {};
  if (JSON.stringify(asesmen).length > 9000 || JSON.stringify(event).length > 2000) return fail('data', 'Data terlalu panjang.');

  return env.withLock(function () {
    var now = env.now();
    expire(env, db);
    var idx = db.index(), blokir = db.all('blokir');
    var active = idx.filter(function (b) { return b.wa === wa && b.status === 'MENUNGGU'; }).length;
    if (active >= 3) return fail('limit', 'Masih ada 3 booking yang menunggu pembayaran. Selesaikan atau tunggu sampai jadwalnya dilepas.');
    var s = slotStatus(st, blokir, idx, inp.tgl, toMin(inp.jam), +L.durasi, lok, now);
    if (s !== 'ok') return fail('slot', 'Jam itu baru saja terisi. Pilih jam lain.');
    var used = {}; idx.forEach(function (b) { used[b.kode] = 1; });
    var hv = lok === 'rumah' ? (+st.hv.biaya || 0) : 0, total = (+L.harga) + hv, start = tsOf(inp.tgl, inp.jam);
    var skema = metode === 'tunai' ? 'TUNAI' : (st.dpAktif && inp.skema === 'DP' ? 'DP' : 'LUNAS');
    var hold = metode === 'tunai' ? (+st.holdTunaiMenit || 180) : (+st.holdMenit || 60);
    var b = {
      id: uid(), kode: makeKode(inp.tgl, used), dibuat: now, tgl: inp.tgl, jam: inp.jam,
      layanan: L.id, layananNama: L.nama, durasi: +L.durasi, harga: +L.harga, lokasi: lok, biayaHv: hv,
      buffer: lok === 'rumah' ? (+st.hv.buffer || 0) : 0, total: total,
      pasien: { nama: nama, wa: wa, lahir: cap(p.lahir, 10), jk: cap(p.jk, 2), alamat: cap(p.alamat, 300).trim(), maps: lok === 'rumah' ? cap(p.maps, 400).trim() : '', patokan: cap(p.patokan, 160).trim() },
      asesmen: asesmen, event: event,
      bayar: { metode: metode, skema: skema, dp: skema === 'DP' ? dpOf(st, total) : 0, dibayar: 0, sisa: total, metodeTerima: metode },
      status: 'MENUNGGU',
      holdUntil: Math.max(Math.min(now + hold * 6e4, start - (+st.batasHoldMenit || 60) * 6e4), now + 15 * 6e4),
      terapis: ((st.terapis || [])[0] || {}).id || 't1', catatan: '', bukti: null, riwayat: [], src: 'online'
    };
    if (skema === 'LUNAS' && st.dpAktif) b.riwayat.push({ t: now, x: 'Pasien memilih bayar lunas di awal' });
    b.riwayat.push({ t: now, x: 'Booking dibuat lewat halaman pasien' });
    db.put('bookings', b);
    return ok({ booking: b });
  });
}

function findMine(db, kode, wa4) {
  kode = String(kode || '').trim().toUpperCase(); wa4 = String(wa4 || '').replace(/\D/g, '');
  if (wa4.length !== 4) return null;
  var hit = db.index().filter(function (b) { return b.kode === kode && String(b.wa).slice(-4) === wa4; })[0];
  return hit ? db.get('bookings', hit.id) : null;
}
function mine(env, db, q) {
  var pre = findMine(db, q.kode, q.wa4);
  if (!pre) return fail('tidak_cocok', 'Kode booking atau nomor tidak cocok.');
  if (pre.status === 'MENUNGGU' && env.now() > pre.holdUntil) { env.withLock(function () { expire(env, db); }); pre = db.get('bookings', pre.id); }
  return ok({ booking: pre });
}
function bukti(env, db, q) {
  var data = String(q.data || '');
  if (data.indexOf('data:image/') !== 0 || data.length > 450000) return fail('data', 'Gambar tidak valid atau terlalu besar.');
  return env.withLock(function () {
    var b = findMine(db, q.kode, q.wa4);
    if (!b) return fail('tidak_cocok', 'Kode booking atau nomor tidak cocok.');
    db.blobPut('bukti:' + b.id, data);
    b.bukti = 'blob:' + b.id;
    (b.riwayat = b.riwayat || []).push({ t: env.now(), x: 'Pasien mengunggah bukti bayar' });
    db.put('bookings', b);
    return ok({ booking: b });
  });
}

/* ---------- admin ---------- */
function login(env, q) {
  var fails = +(env.cacheGet('fails') || 0);
  if (fails >= 10) return fail('terkunci', 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.');
  var pin = env.pin();
  if (!pin) return fail('pin_belum', 'PIN admin belum diatur di Apps Script (Script properties: ADMIN_PIN).');
  if (String(q.pin || '') !== String(pin)) { env.cachePut('fails', String(fails + 1), 600); return fail('pin', 'PIN salah.'); }
  var tok = uid() + uid() + uid();
  env.cachePut('tok:' + tok, '1', 21600);
  return ok({ token: tok });
}
function authed(env, q) { return !!(q.t && env.cacheGet('tok:' + q.t)); }

function admLoad(env, db) {
  env.withLock(function () { expire(env, db); });
  return ok({ settings: db.getSettings(), bookings: db.all('bookings'), kas: db.all('kas'), blokir: db.all('blokir'), now: env.now() });
}
function admOps(env, db, q) {
  var ops = q.ops || [];
  if (ops.length > 200) return fail('data', 'Terlalu banyak perubahan sekaligus.');
  return env.withLock(function () {
    ops.forEach(function (o) {
      if (o.c === 'settings') { if (o.v && typeof o.v === 'object') { delete o.v.pin; db.putSettings(o.v); } return; }
      if (!COLLS[o.c] || !o.id) return;
      if (o.v === null) { db.del(o.c, o.id); return; }
      if (o.c === 'bookings') { /* jangan hapus bukti bayar yang baru diunggah pasien */
        var cur = db.get('bookings', o.id);
        if (cur && cur.bukti && !o.v.bukti) { o.v.bukti = cur.bukti; }
        if (cur && cur.status === 'KEDALUWARSA' && o.v.status === 'MENUNGGU' && !(o.v.holdUntil > env.now())) { /* aktifkan ulang hanya jika hold diperbarui */ }
      }
      o.v.id = o.id; db.put(o.c, o.v);
    });
    return ok({});
  });
}
function admBlobPut(env, db, q) {
  var key = String(q.key || ''), data = String(q.data || '');
  if (key !== 'qris') return fail('data', 'Kunci tidak dikenal.');
  if (data.indexOf('data:image/') !== 0 || data.length > 450000) return fail('data', 'Gambar tidak valid atau terlalu besar.');
  return env.withLock(function () { db.blobPut(key, data); return ok({}); });
}

/* ---------- router ---------- */
function handle(env, db, q) {
  try {
    switch (q.a) {
      case 'ping': return ok({ v: VERSION, now: env.now() });
      case 'pub': return pub(env, db);
      case 'book': return book(env, db, q);
      case 'mine': return mine(env, db, q);
      case 'bukti': return bukti(env, db, q);
      case 'qris': { var d = db.blobGet('qris'); return d ? ok({ data: d }) : fail('kosong', 'QRIS belum diunggah.'); }
      case 'login': return login(env, q);
    }
    if (!authed(env, q)) return fail('auth', 'Sesi habis. Masuk lagi dengan PIN.');
    switch (q.a) {
      case 'load': return admLoad(env, db);
      case 'ops': return admOps(env, db, q);
      case 'blobput': return admBlobPut(env, db, q);
      case 'blobget': { var key = String(q.key || ''); if (key !== 'qris' && key.indexOf('bukti:') !== 0) return fail('data', 'Kunci tidak dikenal.'); var x = db.blobGet(key); return x ? ok({ data: x }) : fail('kosong', 'Tidak ada berkas.'); }
      case 'logout': env.cachePut('tok:' + q.t, '', 1); return ok({});
    }
    return fail('aksi', 'Aksi tidak dikenal.');
  } catch (e) { return fail('server', String(e && e.message || e)); }
}
/* ===== Adaptor Apps Script: Google Sheets sebagai database ===== */
var SHEETS = { bookings: 'Booking', kas: 'Kas', blokir: 'Blokir', settings: 'Pengaturan', blob: 'Berkas' };
var CHUNK = 45000;

function sh_(name, head, textCols) {
  var ss = SpreadsheetApp.getActive(), s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    (textCols || []).forEach(function (c) { s.getRange(1, c, s.getMaxRows(), 1).setNumberFormat('@'); });
    s.getRange(1, 1, 1, head.length).setValues([head]); s.setFrozenRows(1);
  }
  return s;
}
function bookS_() { return sh_(SHEETS.bookings, ['id', 'tgl', 'jam', 'durasi', 'lokasi', 'buffer', 'status', 'holdUntil', 'wa', 'kode', 'nama', 'total', 'json'], [1, 2, 3, 9, 10, 11, 13]); }
function simpleS_(c) { return sh_(SHEETS[c], ['id', 'json'], [1, 2]); }
function blobS_() { return sh_(SHEETS.blob, ['key', 'part', 'data'], [1, 3]); }
function setS_() { return sh_(SHEETS.settings, ['key', 'json'], [1, 2]); }

function rows_(s) { var n = s.getLastRow(); return n < 2 ? [] : s.getRange(2, 1, n - 1, s.getLastColumn()).getValues(); }
function findRow_(s, id) {
  var n = s.getLastRow(); if (n < 2) return 0;
  var ids = s.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}
function bookRow_(b) {
  return [b.id, b.tgl, b.jam, b.durasi, b.lokasi, b.buffer || 0, b.status, b.holdUntil || 0, b.pasien.wa, b.kode, b.pasien.nama, b.total, JSON.stringify(b)];
}

var gasDb = {
  getSettings: function () { var r = rows_(setS_()); for (var i = 0; i < r.length; i++) if (r[i][0] === 'main') return JSON.parse(r[i][1]); return null; },
  putSettings: function (v) {
    var s = setS_(), row = findRow_(s, 'main'), val = JSON.stringify(v);
    if (val.length > 49000) throw new Error('Pengaturan terlalu besar');
    if (row) s.getRange(row, 2).setValue(val); else s.appendRow(['main', val]);
  },
  index: function () {
    return rows_(bookS_()).map(function (r) {
      return { id: String(r[0]), tgl: r[1] instanceof Date ? Utilities.formatDate(r[1], 'Asia/Makassar', 'yyyy-MM-dd') : String(r[1]), jam: r[2] instanceof Date ? Utilities.formatDate(r[2], 'Asia/Makassar', 'HH:mm') : String(r[2]), durasi: +r[3], lokasi: r[4], buffer: +r[5], status: r[6], holdUntil: +r[7], wa: String(r[8]), kode: r[9] };
    });
  },
  get: function (c, id) {
    var s = c === 'bookings' ? bookS_() : simpleS_(c), row = findRow_(s, id); if (!row) return null;
    return JSON.parse(s.getRange(row, s.getLastColumn()).getValue());
  },
  all: function (c) {
    var s = c === 'bookings' ? bookS_() : simpleS_(c);
    return rows_(s).map(function (r) { return JSON.parse(r[r.length - 1]); });
  },
  put: function (c, v) {
    var s = c === 'bookings' ? bookS_() : simpleS_(c), row = findRow_(s, v.id);
    var data = c === 'bookings' ? bookRow_(v) : [v.id, JSON.stringify(v)];
    if (data[data.length - 1].length > 49000) throw new Error('Data terlalu besar');
    if (row) s.getRange(row, 1, 1, data.length).setValues([data]); else s.appendRow(data);
  },
  del: function (c, id) { var s = c === 'bookings' ? bookS_() : simpleS_(c), row = findRow_(s, id); if (row) s.deleteRow(row); },
  blobPut: function (key, data) {
    var s = blobS_(), n = s.getLastRow();
    if (n >= 2) { var ks = s.getRange(2, 1, n - 1, 1).getValues(); for (var i = ks.length - 1; i >= 0; i--) if (ks[i][0] === key) s.deleteRow(i + 2); }
    var out = []; for (var p = 0, k = 0; p < data.length; p += CHUNK, k++) out.push([key, k, data.slice(p, p + CHUNK)]);
    s.getRange(s.getLastRow() + 1, 1, out.length, 3).setValues(out);
  },
  blobGet: function (key) {
    var r = rows_(blobS_()).filter(function (x) { return x[0] === key; }).sort(function (a, b) { return a[1] - b[1]; });
    return r.length ? r.map(function (x) { return x[2]; }).join('') : null;
  }
};

var gasEnv = {
  now: function () { return Date.now(); },
  withLock: function (fn) { var l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { SpreadsheetApp.flush(); l.releaseLock(); } },
  cacheGet: function (k) { return CacheService.getScriptCache().get(k); },
  cachePut: function (k, v, sec) { CacheService.getScriptCache().put(k, v, Math.min(sec, 21600)); },
  pin: function () { return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN'); }
};

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  var q; try { q = JSON.parse(e.postData.contents); } catch (x) { return out_(fail('data', 'Permintaan tidak valid')); }
  return out_(handle(gasEnv, gasDb, q));
}
function doGet(e) { return out_(handle(gasEnv, gasDb, { a: 'ping' })); }

/* Jalankan sekali dari editor untuk menyiapkan lembar & izin */
function setup() {
  bookS_(); simpleS_('kas'); simpleS_('blokir'); setS_(); blobS_();
  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PIN')) Logger.log('PENTING: isi Script property ADMIN_PIN (Project Settings > Script properties).');
  Logger.log('Siap.');
}
