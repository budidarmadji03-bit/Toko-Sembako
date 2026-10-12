-- Contoh data awal. Jalankan opsional setelah 01_schema.sql.
insert into public.barang(sku,nama,kategori,satuan,harga_beli,harga_jual,stok,stok_minimum)
values
('BRG-001','Beras Premium 5 kg','Beras & Serealia','pack',65000,72000,25,5),
('BRG-002','Minyak Goreng 1 L','Minyak & Bumbu','liter',15500,18000,40,10),
('BRG-003','Gula Pasir 1 kg','Gula & Tepung','kg',14500,17000,30,8),
('BRG-004','Mi Instan','Mi & Makanan Instan','pcs',2600,3500,100,20),
('BRG-005','Tepung Terigu 1 kg','Gula & Tepung','kg',10500,12500,18,5),
('BRG-006','Air Mineral 600 ml','Minuman','botol',2500,3500,48,12)
on conflict(sku) do nothing;

insert into public.pelanggan(nama,telepon,alamat)
select 'Pelanggan Grosir','081234567890','Pelanggan contoh'
where not exists(select 1 from public.pelanggan where nama='Pelanggan Grosir');
