-- Operational app support. Run after 05_auth_profiles.sql.
begin;

alter table public.barang
  add column if not exists foto_url text;
alter table public.penjualan
  add column if not exists recipient_name text,
  add column if not exists recipient_phone text,
  add column if not exists delivery_address text,
  add column if not exists delivery_note text;

create or replace view public.customer_catalog as
  select id,sku,nama,kategori,satuan,harga_jual,stok,aktif,created_at,updated_at,foto_url
  from public.barang
  where aktif=true;
grant select on public.customer_catalog to authenticated;

create or replace function public.adjust_stock(
  p_product_id uuid,
  p_delta numeric,
  p_note text
)
returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_product public.barang%rowtype;
  v_new_stock numeric(14,3);
begin
  if p_delta is null or p_delta=0 then
    raise exception 'Perubahan stok harus berbeda dari nol.';
  end if;
  if nullif(trim(p_note),'') is null then
    raise exception 'Alasan penyesuaian stok wajib diisi.';
  end if;
  select * into v_product
  from public.barang
  where id=p_product_id and aktif=true
  for update;
  if not found then raise exception 'Barang tidak ditemukan atau tidak aktif.'; end if;
  if v_product.stok+p_delta<0 then raise exception 'Stok tidak boleh menjadi negatif.'; end if;

  perform set_config('retailpro.stock_mutation','adjustment',true);
  update public.barang set stok=stok+p_delta
  where id=p_product_id
  returning stok into v_new_stock;
  insert into public.mutasi_persediaan(
    barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
  ) values(
    p_product_id,'penyesuaian',v_product.sku,greatest(p_delta,0),
    greatest(-p_delta,0),v_new_stock,trim(p_note)
  );
  return jsonb_build_object('product_id',p_product_id,'stok_setelah',v_new_stock);
end;
$$;

create or replace function public.update_delivery_status(
  p_sale_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sale public.penjualan%rowtype;
  v_item record;
  v_new_stock numeric(14,3);
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'Hanya Owner yang dapat mengubah status pesanan.';
  end if;
  select * into v_sale
  from public.penjualan
  where id=p_sale_id and status_pembayaran='belum_bayar'
  for update;
  if not found then raise exception 'Pesanan tidak ditemukan atau tidak dapat diubah.'; end if;

  if v_sale.status='menunggu' and p_status='diproses' then
    update public.penjualan
      set status='diproses',status_pemenuhan='diproses'
      where id=p_sale_id;
  elsif v_sale.status='menunggu' and p_status='dibatalkan' then
    perform set_config('retailpro.stock_mutation','delivery_reject',true);
    for v_item in
      select barang_id,jumlah from public.detail_penjualan
      where penjualan_id=p_sale_id order by barang_id
    loop
      update public.barang set stok=stok+v_item.jumlah
      where id=v_item.barang_id returning stok into v_new_stock;
      insert into public.mutasi_persediaan(
        barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
      ) values(
        v_item.barang_id,'pembatalan',v_sale.nomor_nota,v_item.jumlah,0,
        v_new_stock,'Pesanan pelanggan ditolak Owner'
      );
    end loop;
    update public.penjualan
      set status='dibatalkan',status_pemenuhan='dibatalkan',
          status_pembayaran='belum_bayar'
      where id=p_sale_id;
  elsif v_sale.status='diproses' and p_status='selesai' then
    update public.penjualan
      set status='selesai',status_pemenuhan='selesai',
          status_pembayaran='lunas',jumlah_dibayar=total
      where id=p_sale_id;
  else
    raise exception 'Perubahan status pesanan tidak valid.';
  end if;

  return jsonb_build_object('id',p_sale_id,'status',p_status);
end;
$$;

revoke all on function public.adjust_stock(uuid,numeric,text) from public,anon;
grant execute on function public.adjust_stock(uuid,numeric,text) to authenticated;
revoke all on function public.update_delivery_status(uuid,text) from public,anon;
grant execute on function public.update_delivery_status(uuid,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-photos','product-photos',true,4194304,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update
set public=true,file_size_limit=4194304,
    allowed_mime_types=array['image/jpeg','image/png','image/webp'];

drop policy if exists "Public can read product photos" on storage.objects;
create policy "Public can read product photos"
  on storage.objects for select to public
  using (bucket_id='product-photos');
drop policy if exists "Owner can upload product photos" on storage.objects;
create policy "Owner can upload product photos"
  on storage.objects for insert to authenticated
  with check (bucket_id='product-photos' and public.is_owner());
drop policy if exists "Owner can update product photos" on storage.objects;
create policy "Owner can update product photos"
  on storage.objects for update to authenticated
  using (bucket_id='product-photos' and public.is_owner())
  with check (bucket_id='product-photos' and public.is_owner());
drop policy if exists "Owner can delete product photos" on storage.objects;
create policy "Owner can delete product photos"
  on storage.objects for delete to authenticated
  using (bucket_id='product-photos' and public.is_owner());

commit;
notify pgrst, 'reload schema';
