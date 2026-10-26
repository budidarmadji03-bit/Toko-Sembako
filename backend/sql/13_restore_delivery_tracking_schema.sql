-- Restore delivery tracking schema required by update_delivery_status.
-- Safe to run when migration 07 was already applied; existing rows are retained.
begin;

alter table public.penjualan
  add column if not exists tanggal_pengiriman timestamptz;

alter table public.penjualan
  drop constraint if exists penjualan_status_check;
alter table public.penjualan
  add constraint penjualan_status_check
  check (status in (
    'menunggu','diproses','dalam_pengiriman','selesai','gagal_dikirim','dibatalkan'
  ));

alter table public.penjualan
  drop constraint if exists penjualan_status_pemenuhan_check;
alter table public.penjualan
  add constraint penjualan_status_pemenuhan_check
  check (status_pemenuhan in (
    'menunggu','diproses','dalam_pengiriman','selesai','gagal_dikirim','dibatalkan'
  ));

create index if not exists penjualan_delivery_status_tanggal_idx
  on public.penjualan(status,tanggal desc)
  where recipient_name is not null;

commit;
notify pgrst,'reload schema';
