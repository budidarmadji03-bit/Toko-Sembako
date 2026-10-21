-- Delivery status lifecycle. Review before running; requires migrations 01 through 06.
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
  on public.penjualan(status, tanggal desc)
  where recipient_name is not null;

create or replace function public.update_delivery_status(
  p_sale_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_item record;
  v_new_stock numeric(14,3);
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'Hanya Owner yang dapat mengubah status pesanan.';
  end if;
  if p_status is null or p_status not in (
    'diproses','dalam_pengiriman','selesai','gagal_dikirim','dibatalkan'
  ) then
    raise exception 'Status pengiriman tidak valid.';
  end if;

  select * into v_sale
  from public.penjualan
  where id=p_sale_id
    and recipient_name is not null
    and status_pembayaran='belum_bayar'
  for update;
  if not found then
    raise exception 'Pesanan pengantaran tidak ditemukan atau sudah selesai.';
  end if;

  if v_sale.status='menunggu' and p_status='diproses' then
    update public.penjualan
    set status='diproses',status_pemenuhan='diproses'
    where id=p_sale_id;
  elsif v_sale.status='diproses' and p_status='dalam_pengiriman' then
    update public.penjualan
    set status='dalam_pengiriman',
        status_pemenuhan='dalam_pengiriman',
        tanggal_pengiriman=coalesce(tanggal_pengiriman,now())
    where id=p_sale_id;
  elsif v_sale.status='dalam_pengiriman' and p_status='selesai' then
    update public.penjualan
    set status='selesai',status_pemenuhan='selesai',
        status_pembayaran='lunas',jumlah_dibayar=total
    where id=p_sale_id;
  elsif (v_sale.status='menunggu' and p_status='dibatalkan')
     or (v_sale.status='dalam_pengiriman' and p_status='gagal_dikirim') then
    perform set_config('retailpro.stock_mutation','delivery_release',true);
    for v_item in
      select barang_id,jumlah
      from public.detail_penjualan
      where penjualan_id=p_sale_id
      order by barang_id
    loop
      update public.barang
      set stok=stok+v_item.jumlah
      where id=v_item.barang_id
      returning stok into v_new_stock;

      insert into public.mutasi_persediaan(
        barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
      ) values (
        v_item.barang_id,'pembatalan',v_sale.nomor_nota,
        v_item.jumlah,0,v_new_stock,
        case when p_status='gagal_dikirim'
          then 'Pengiriman gagal; stok pesanan dikembalikan'
          else 'Pesanan ditolak Owner; stok pesanan dikembalikan'
        end
      );
    end loop;
    update public.penjualan
    set status=p_status,status_pemenuhan=p_status
    where id=p_sale_id;
  else
    raise exception 'Urutan perubahan status pesanan tidak valid.';
  end if;

  return jsonb_build_object(
    'id',p_sale_id,
    'status',p_status,
    'tanggal_pengiriman',case
      when p_status='dalam_pengiriman' then coalesce(v_sale.tanggal_pengiriman,now())
      else v_sale.tanggal_pengiriman
    end
  );
end;
$$;

create or replace function public.cancel_sale(p_sale_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_item record;
  v_new_stock numeric(14,3);
begin
  select * into v_sale
  from public.penjualan
  where id=p_sale_id
  for update;
  if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
  if v_sale.recipient_name is not null then
    raise exception 'Pesanan antar hanya dapat dibatalkan melalui alur status pengiriman.';
  end if;
  if v_sale.status<>'selesai' or v_sale.status_pembayaran<>'lunas' then
    raise exception 'Hanya transaksi kasir yang selesai dan lunas yang dapat dibatalkan.';
  end if;

  perform set_config('retailpro.stock_mutation','cancel',true);
  for v_item in
    select * from public.detail_penjualan
    where penjualan_id=p_sale_id
    order by barang_id
  loop
    update public.barang
    set stok=stok+v_item.jumlah
    where id=v_item.barang_id
    returning stok into v_new_stock;

    insert into public.mutasi_persediaan(
      barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
    ) values(
      v_item.barang_id,'pembatalan',v_sale.nomor_nota,
      v_item.jumlah,0,v_new_stock,'Pembatalan transaksi penjualan'
    );
  end loop;
  update public.penjualan
  set status='dibatalkan'
  where id=p_sale_id;

  return jsonb_build_object(
    'id',p_sale_id,'status','dibatalkan','nomor_nota',v_sale.nomor_nota
  );
end;
$$;

revoke all on function public.update_delivery_status(uuid,text) from public,anon;
grant execute on function public.update_delivery_status(uuid,text) to authenticated;
revoke all on function public.cancel_sale(uuid) from public,anon;
grant execute on function public.cancel_sale(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
