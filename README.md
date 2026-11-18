# Vortex Sniffer

**Vortex Sniffer** (`v2.3.0`) adalah ekstensi browser Chromium (Manifest V3) yang berjalan **100% mandiri di dalam browser** tanpa server lokal maupun database eksternal untuk mendeteksi, mengekstrak, menggabungkan (*muxing*), dan mengunduh video maupun audio dari media sosial dan web umum.

---

## Fitur Utama

- **100% Pure Chrome Extension:** Tidak memerlukan backend lokal, `.bat`, atau database SQLite. Seluruh ekstraksi stream, pengunduhan segmen HLS, dan defragmentasi fMP4 berjalan langsung di browser via `extension/muxer.js`.
- **Mode Default `OFF` per Domain (Ringan di Chrome):** Setiap domain baru otomatis `OFF` agar ikon hover tidak muncul, observer DOM tidak berjalan, dan sniffer jaringan tetap idle. Klik **`ON`** pada popup untuk mengaktifkan situs tertentu tanpa reload halaman.
- **Toolbar Terpadu & Pengaturan Lengkap:**
  - Baris kontrol sejajar: toggle **`ON/OFF`**, **`Scan`** (pindai ulang paksa), **`Clear`** (bersihkan daftar & cache tab), dan **`Settings`**.
  - **In-Popup Settings:** Atur subfolder download (`Downloads/<subfolder>/`, default `Vortex`), pemisahan folder `Video/` dan `Audio/` otomatis, prompt `Save As`, kualitas default tombol hover, koneksi paralel HLS (`1-16`), serta limit riwayat video per tab (`5-50`).
- **Standard MP4 Defragmenter & Audio Trimming:** Mengubah stream `fMP4` terfragmentasi menjadi MP4 standar (`[ftyp][moov][mdat]`) yang lancar di-seek, sekaligus memangkas durasi audio berlebih agar akhir video tidak *freeze*.
- **Ekstraktor Multi-Platform:**
  - **Instagram, Facebook & Threads:** Membaca React Fiber & manifest DASH, membersihkan parameter `bytestart`/`byteend`, mendekode metadata `efg=`, dan mengelompokkan varian resolusi tanpa duplikat kartu/kualitas.
  - **YouTube & Google Drive (Read-Only):** Membaca metadata player & sesi browser aktif.
  - **Web Umum:** Pendeteksi stream `.m3u8` (HLS dengan dekripsi AES-128), `.mp4`, dan perekam buffer `MediaSource` (`blob:`) *on-demand* (aktif hanya saat diminta agar hemat RAM).
- **Visual Preview & Timestamp Filename:** Menampilkan thumbnail/preview video, tombol **Lihat** untuk menyorot video di tab, dan penamaan file otomatis bertimestamp (`[Platform] @author - Judul_YYYYMMDD_HHMMSS.mp4`).

---

## Cara Memasang (Chrome / Edge / Brave)

1. Clone atau unduh repositori ini.
2. Buka halaman manajemen ekstensi browser:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Aktifkan **Developer mode** (Mode pengembang).
4. Klik **Load unpacked** dan pilih folder `extension/` di dalam repositori ini.
5. Pin ikon **Vortex Sniffer** di toolbar browser.

---

## Struktur Proyek

```text
Vortex/
├── extension/
│   ├── manifest.json    # Konfigurasi Manifest V3 (v2.3.0)
│   ├── background.js    # Network sniffer whitelist-gated & browser download router
│   ├── mse-hook.js      # Ekstraktor React Fiber / Player API & perekam MSE on-demand
│   ├── muxer.js         # Defragmenter fMP4 -> MP4 standar, audio trimmer & HLS downloader
│   ├── content.js       # Floating hover button, smart filename & unified media cards
│   ├── popup.html       # UI Popup dengan toolbar sejajar, visual preview & Settings
│   └── popup.js         # Logika popup, Scan/Clear, toggle domain & konfigurasi Settings
├── .gitignore
└── README.md
```
