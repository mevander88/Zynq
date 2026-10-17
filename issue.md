# Audit Style, Flow, dan UI/UX Zynq

## Tujuan dan cakupan

Dokumen ini menjadi panduan perbaikan pengalaman pengguna aplikasi desktop Zynq untuk junior programmer atau AI coding. Fokusnya adalah tampilan, alur dari menghubungkan LIVE sampai menjalankan aturan, kejelasan status, dan aksesibilitas. Tidak ada perubahan fitur yang diminta dalam dokumen ini.

Audit dilakukan dari kode React, CSS, dan alur status Rust saat ini. Tampilan pada aplikasi terpasang, pembaca layar, kontras warna, serta berbagai skala layar **belum diuji langsung**. Temuan yang bergantung pada tampilan nyata perlu dikonfirmasi saat implementasi. Spesifikasi arsitektur `issue.md` sebelumnya masih tersedia di riwayat Git.

## Ringkasan audit

Gaya visual “control desk” sudah memiliki arah yang jelas: warna, tipografi, dan penekanan emergency stop cukup konsisten. Hasil review kode tidak menunjukkan pola visual generik seperti glassmorphism, gradien neon, atau kartu identik berulang. Penilaian visual akhir masih memerlukan pemeriksaan aplikasi berjalan.

Masalah utama ada pada kesinambungan alur: pengguna dapat kehilangan perubahan aturan yang belum disimpan, dan tombol emergency stop UI dapat terkunci saat aplikasi sedang sibuk. Setelah itu, prioritasnya adalah membuat pemilihan gift dan konfigurasi lebih mudah dipahami serta memperbaiki aksesibilitas editor aturan.

| Prioritas | Area | Temuan dan dampak | Arah perbaikan |
| --- | --- | --- | --- |
| P0 | Editor aturan | Setiap pembaruan status dari backend mengganti draft aturan di UI. Perubahan yang belum disimpan bisa hilang saat log atau status koneksi berubah. | Pisahkan data tersimpan dari draft yang sedang diedit. Pertahankan draft sampai pengguna menyimpan, membatalkan, atau memilih memuat ulang. |
| P0 | Kontrol keselamatan | Tombol emergency stop UI ikut dinonaktifkan ketika operasi lain berjalan. Pada saat itu pengguna mungkin tidak bisa menghentikan automation melalui UI. | Pastikan emergency stop selalu dapat dipakai ketika automation perlu dihentikan; tampilkan respons yang jelas setelah ditekan. |
| P1 | Pemilihan gift | Aturan baru bergantung pada katalog gift dari koneksi. Jika katalog gagal dimuat atau kosong, dropdown tidak menawarkan langkah pemulihan. | Tampilkan status memuat/gagal/kosong, tindakan coba lagi, dan jalur yang aman untuk melanjutkan konfigurasi. |
| P1 | Penyimpanan | Perubahan username tidak dihitung sebagai perubahan konfigurasi, sehingga tombol simpan dapat tetap nonaktif. | Samakan indikator “belum disimpan” dengan seluruh data yang benar-benar disimpan, termasuk username. |
| P1 | Konfigurasi rusak | Saat file konfigurasi gagal dibaca, aplikasi memakai konfigurasi default tanpa pemberitahuan yang terlihat oleh pengguna. Pengguna dapat mengira aturannya hilang. | Tampilkan alasan kegagalan dan pilihan pemulihan yang jelas; jangan menyajikan keadaan default seolah konfigurasi lama berhasil dimuat. |
| P1 | Editor aturan | Editor berbentuk modal, tetapi belum tampak pengelolaan fokus, tombol Escape, dan penandaan dialog untuk teknologi bantu. Navigasi keyboard dapat berpindah ke konten di belakang modal. | Perlakukan editor sebagai dialog yang utuh: fokus masuk saat dibuka, tetap berada di dalamnya, dan kembali ke pemicu saat ditutup. |
| P1 | Keterbacaan | Sejumlah label tabel, log, dan teks pendukung memakai ukuran sangat kecil. Pengguna dapat kesulitan membaca saat jendela kecil atau skala Windows meningkat. | Naikkan ukuran teks penting, periksa kontras, dan pastikan hierarki informasi tetap jelas pada ukuran minimum jendela. |
| P2 | Umpan balik | Pesan error umum berada di satu area; pengguna harus menebak tindakan mana yang gagal. | Tampilkan pesan dekat tindakan terkait, jelaskan apa yang terjadi, dan berikan langkah pemulihan singkat. |
| P2 | Simulasi | Pilihan gift uji menyimpan pilihan awal sendiri dan dapat tidak sesuai setelah daftar aturan berubah. | Selaraskan pilihan gift uji dengan aturan aktif; jelaskan keadaan ketika belum ada aturan yang bisa diuji. |
| P2 | Konsistensi bahasa | Editor selalu berjudul “Rute gift baru”, termasuk saat mengedit. Beberapa teks masih menyebut “Gift ID” setelah alur utama memakai nama jenis gift. | Sesuaikan judul dan istilah dengan konteks tindakan yang sedang dilakukan. |

## Alur pengguna yang dituju

1. Pengguna memilih mode simulasi atau memasukkan username TikTok, lalu menghubungkan sesi.
2. Aplikasi menunjukkan status koneksi dan status katalog gift secara terpisah.
3. Pengguna memilih jenis gift, menentukan keybind, lalu menyimpan aturan. Draft tetap aman bila status LIVE berubah.
4. Pengguna memilih jendela target dan mendapat petunjuk bahwa target harus berada di foreground.
5. Tombol Start menjelaskan prasyarat yang belum terpenuhi. Saat aktif, Stop dan emergency stop mudah dijangkau.
6. Log dan pesan status memberi tahu apakah gift diterima, dilewati, atau gagal serta apa yang dapat dilakukan pengguna.

## Arahan visual dan interaksi

- Pertahankan identitas visual control desk dan penekanan warna untuk status penting. Hindari dekorasi tambahan yang mengalahkan informasi operasional.
- Gunakan istilah Indonesia yang konsisten untuk koneksi, aturan, gift, simulasi, dan automation. Tampilkan identitas teknis seperti ID hanya bila membantu diagnosis.
- Pastikan status tidak bergantung pada warna saja; sertakan teks yang dapat dibaca.
- Uji keyboard navigation dari awal sampai akhir, termasuk dialog, form, daftar target, tombol Stop, dan emergency stop.
- Periksa UI pada ukuran jendela minimum, skala Windows yang lebih besar, serta teks yang diperbesar. Jangan menyembunyikan kontrol keselamatan.
- Periksa warna dan kontras secara nyata sebelum mengklaim kepatuhan aksesibilitas.

## Urutan implementasi yang disarankan

1. **Amankan alur inti:** perbaiki draft yang tertimpa dan ketersediaan emergency stop.
2. **Rapikan konfigurasi:** selaraskan indikator simpan, tangani konfigurasi gagal dimuat, dan jelaskan keadaan katalog gift.
3. **Perbaiki editor:** lengkapi navigasi keyboard, fokus modal, validasi, serta teks sesuai konteks.
4. **Poles tampilan:** perbaiki ukuran teks, kontras, responsivitas, dan pesan error setelah alur inti stabil.

## Kriteria selesai

- [ ] Mengubah aturan lalu menerima event atau status baru tidak menghapus draft tanpa pilihan pengguna.
- [ ] Emergency stop UI tetap dapat ditekan saat koneksi, penyimpanan, atau tindakan lain sedang berjalan.
- [ ] Pengguna paham kapan daftar gift sedang dimuat, gagal dimuat, kosong, atau siap dipilih.
- [ ] Perubahan username dan aturan sama-sama terlihat sebagai perubahan yang belum disimpan.
- [ ] Kegagalan membaca konfigurasi ditampilkan dengan tindakan pemulihan yang jelas.
- [ ] Editor dapat dibuka, digunakan, dan ditutup sepenuhnya dengan keyboard; fokus kembali ke tempat semula.
- [ ] Alur simulasi dan LIVE memiliki pesan status yang jelas saat berhasil maupun gagal.
- [ ] Pemeriksaan manual pada ukuran jendela minimum dan skala tampilan Windows membuktikan teks penting terbaca serta kontrol utama tetap dapat diakses.

## Batas audit

Temuan di atas berasal dari pembacaan kode, sehingga dampak visual dan perilaku pada aplikasi terpasang masih perlu diverifikasi. Audit ini tidak menilai akurasi event TikTok, kompatibilitas game, maupun keberhasilan pengiriman input keyboard pada target tertentu.
