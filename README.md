# Arjuna Sport Massage Banjarbaru: reservasi online

Halaman reservasi pasien dan panel admin/terapis. Data disimpan di Google Sheets lewat Google Apps Script.

| Alamat | Fungsi |
|---|---|
| `arjunasportmassagebjb.com` | Halaman reservasi untuk pasien |
| `arjunasportmassagebjb.com/admin` | Panel admin/terapis (masuk dengan PIN) |

## Susunan

- `index.html`, `admin/index.html`, `app.js`, `style.css`: tampilan (statis, di-host GitHub Pages).
- `config.js`: alamat web app Apps Script (`.../exec`).
- `apps-script/Code.gs`: server. Ditempel ke Apps Script yang terikat ke Google Sheet.
- `CNAME`: domain kustom GitHub Pages.

## Pasang server (sekali)

1. Buat Google Sheet baru, misalnya "Arjuna Reservasi". Menu **Extensions > Apps Script**.
2. Hapus isi `Code.gs` bawaan, tempel seluruh isi `apps-script/Code.gs`. (Opsional: Project Settings > centang "Show appsscript.json", tempel isi `apps-script/appsscript.json`.)
3. **Project Settings > Script properties > Add**: `ADMIN_PIN` = PIN untuk admin/terapis (6 sampai 12 angka, bisa diganti dari panel admin) dan `OWNER_PIN` = PIN rahasia pengembang/pemilik sistem (hanya bisa diubah di sini).
4. Pilih fungsi `setup` lalu **Run**, izinkan akses (Google akan meminta izin ke Sheet).
5. **Deploy > New deployment > Web app**: Execute as **Me**, Who has access **Anyone**. Salin URL yang berakhiran `/exec`.
6. Tempel URL itu ke `config.js` (`api:"..."`), commit, push.

Setiap perubahan `Code.gs` perlu **Deploy > Manage deployments > Edit > New version**.

## Cara kerja singkat

- Pasien hanya menerima daftar jam yang terisi tanpa data pribadi. Data booking hanya bisa dibuka dengan kode booking + 4 angka terakhir WhatsApp, atau lewat panel admin.
- Server mengunci jadwal (LockService) sehingga dua pasien tidak bisa memesan jam yang sama.
- Booking yang tidak dibayar sampai batas waktu dilepas otomatis.
- Panel admin menyimpan perubahan otomatis; indikator "Tersimpan" di kiri bawah.
- Bukti bayar dan gambar QRIS disimpan di lembar `Berkas`.

## Catatan

- Jangan ubah nama lembar (`Booking`, `Kas`, `Blokir`, `Pengaturan`, `Berkas`) dan jangan menyunting kolom `json` secara manual.
- Jam memakai zona waktu perangkat; server memakai Asia/Makassar (WITA).
- Cadangkan data dengan File > Make a copy pada Google Sheet secara berkala.

## PIN dan perawatan

- `ADMIN_PIN`: dipakai terapis/admin. Bisa diganti di panel admin (Pengaturan > Keamanan). Setelah diganti, sesi di perangkat lain otomatis keluar.
- `OWNER_PIN`: dipakai pengembang. Masuk lewat `/admin` seperti biasa, akan muncul tab **Pemilik** berisi: pemeriksaan kesehatan sistem, catatan error server (lembar `Log`), kirim email uji, buka kunci login, dan atur ulang PIN admin tanpa PIN lama.
- Notifikasi email booking baru dan bukti bayar diatur di Pengaturan > Usaha > Email notifikasi (isi email tanpa data kesehatan).
