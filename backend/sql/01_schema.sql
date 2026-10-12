-- Toko Sembako schema: jalankan di Supabase SQL Editor sebelum 02_rpc.sql.
create extension if not exists pgcrypto;

create table if not exists public.barang (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  nama text not null,
  kategori text not null default 'Lainnya',
  satuan text not null default 'pcs',
  harga_beli numeric(14,2) not null default 0 check(harga_beli>=0),
  harga_jual numeric(14,2) not null default 0 check(harga_jual>=0),
  stok numeric(14,3) not null default 0 check(stok>=0),
  stok_minimum numeric(14,3) not null default 0 check(stok_minimum>=0),
  aktif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.pelanggan (
  id uuid primary key default gen_random_uuid(),
  nama text not null,
  telepon text,
  alamat text,
  created_at timestamptz not null default now()
);
create table if not exists public.penjualan (
  id uuid primary key default gen_random_uuid(),
  nomor_nota text not null unique,
  tanggal timestamptz not null default now(),
  pelanggan_id uuid references public.pelanggan(id) on delete set null,
  subtotal numeric(14,2) not null check(subtotal>=0),
  diskon numeric(14,2) not null default 0 check(diskon>=0),
  total numeric(14,2) not null check(total>=0),
  metode_pembayaran text not null default 'cash' check(metode_pembayaran in ('cash','transfer','qris','debit')),
  jumlah_dibayar numeric(14,2) not null default 0 check(jumlah_dibayar>=0),
  kembalian numeric(14,2) not null default 0 check(kembalian>=0),
  status text not null default 'selesai' check(status in ('selesai','dibatalkan')),
  catatan text,
  created_at timestamptz not null default now()
);
create table if not exists public.detail_penjualan (
  id uuid primary key default gen_random_uuid(),
  penjualan_id uuid not null references public.penjualan(id) on delete restrict,
  barang_id uuid not null references public.barang(id) on delete restrict,
  nama_barang text not null,
  sku text not null,
  jumlah numeric(14,3) not null check(jumlah>0),
  harga_satuan numeric(14,2) not null check(harga_satuan>=0),
  harga_pokok_satuan numeric(14,2) not null default 0 check(harga_pokok_satuan>=0),
  subtotal numeric(14,2) not null check(subtotal>=0),
  created_at timestamptz not null default now()
);
create table if not exists public.mutasi_persediaan (
  id uuid primary key default gen_random_uuid(),
  barang_id uuid not null references public.barang(id) on delete restrict,
  tanggal timestamptz not null default now(),
  tipe text not null check(tipe in ('saldo_awal','penjualan','penyesuaian','pembatalan')),
  referensi text,
  qty_masuk numeric(14,3) not null default 0 check(qty_masuk>=0),
  qty_keluar numeric(14,3) not null default 0 check(qty_keluar>=0),
  stok_setelah numeric(14,3) not null check(stok_setelah>=0),
  catatan text,
  created_at timestamptz not null default now()
);
create table if not exists public.pembelian_stok (
  id uuid primary key default gen_random_uuid(),
  barang_id uuid not null references public.barang(id) on delete restrict,
  tanggal timestamptz not null default now(),
  jumlah numeric(14,3) not null check(jumlah>0),
  harga_satuan numeric(14,2) not null check(harga_satuan>=0),
  total numeric(14,2) not null check(total>=0),
  catatan text,
  created_at timestamptz not null default now()
);
create table if not exists public.beban_operasional (
  id uuid primary key default gen_random_uuid(),
  tanggal timestamptz not null default now(),
  kategori text not null,
  keterangan text not null,
  nominal numeric(14,2) not null check(nominal>0),
  created_at timestamptz not null default now()
);
create index if not exists barang_nama_idx on public.barang(nama);
create index if not exists barang_kategori_idx on public.barang(kategori);
create index if not exists penjualan_tanggal_idx on public.penjualan(tanggal desc);
create index if not exists detail_penjualan_nota_idx on public.detail_penjualan(penjualan_id);
create index if not exists mutasi_barang_tanggal_idx on public.mutasi_persediaan(barang_id,tanggal desc);
create index if not exists pembelian_stok_tanggal_idx on public.pembelian_stok(tanggal desc);
create index if not exists beban_operasional_tanggal_idx on public.beban_operasional(tanggal desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists barang_updated_at on public.barang;
create trigger barang_updated_at before update on public.barang for each row execute function public.set_updated_at();

-- Catat mutasi saldo awal saat barang dibuat atau perubahan stok manual dilakukan.
create or replace function public.log_stock_change()
returns trigger language plpgsql as $$
declare delta numeric(14,3);
begin
  if tg_op='INSERT' then
    if new.stok>0 then
      insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
      values(new.id,'saldo_awal',new.sku,new.stok,0,new.stok,'Stok awal / barang baru');
    end if;
    return new;
  elsif tg_op='UPDATE' and new.stok is distinct from old.stok then
    -- RPC create_sale mencatat mutasi penjualan sendiri. Lewati log generik agar tidak ganda.
    if coalesce(current_setting('retailpro.stock_mutation', true),'') <> '' then return new; end if;
    delta:=new.stok-old.stok;
    insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
    values(new.id,'penyesuaian',new.sku,greatest(delta,0),greatest(-delta,0),new.stok,'Penyesuaian stok melalui master barang');
    return new;
  end if;
  return new;
end; $$;
drop trigger if exists barang_stock_log on public.barang;
create trigger barang_stock_log after insert or update of stok on public.barang for each row execute function public.log_stock_change();

alter table public.barang enable row level security;
alter table public.pelanggan enable row level security;
alter table public.penjualan enable row level security;
alter table public.detail_penjualan enable row level security;
alter table public.mutasi_persediaan enable row level security;
alter table public.pembelian_stok enable row level security;
alter table public.beban_operasional enable row level security;

-- POLICY DEMO: akses publik untuk pengembangan saja, tanpa login.
-- Sebelum produksi, ganti dengan kebijakan berbasis auth.uid() dan role pengguna.
do $$ declare t text; begin
  foreach t in array array['barang','pelanggan','penjualan','detail_penjualan','mutasi_persediaan','pembelian_stok','beban_operasional'] loop
    execute format('drop policy if exists "Demo full access %s" on public.%I',t,t);
    execute format('create policy "Demo full access %s" on public.%I for all to anon, authenticated using (true) with check (true)',t,t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated',t);
  end loop;
end $$;
grant usage on schema public to anon, authenticated;
