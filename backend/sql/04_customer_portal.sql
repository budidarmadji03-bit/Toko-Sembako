-- Customer auth and portal migration. Run after 01_schema.sql and 02_rpc.sql.
alter table public.profiles
  add column if not exists pelanggan_id uuid references public.pelanggan(id) on delete set null,
  add column if not exists display_name text,
  add column if not exists telepon text,
  add column if not exists alamat text;

alter table public.penjualan
  add column if not exists status_pembayaran text not null default 'lunas',
  add column if not exists status_pemenuhan text not null default 'selesai',
  add column if not exists customer_request_id uuid,
  add column if not exists recipient_name text,
  add column if not exists recipient_phone text,
  add column if not exists delivery_address text,
  add column if not exists delivery_note text;
alter table public.penjualan
  drop constraint if exists penjualan_status_check;
alter table public.penjualan
  add constraint penjualan_status_check
  check(status in ('menunggu','diproses','selesai','dibatalkan'));
alter table public.penjualan
  drop constraint if exists penjualan_status_pembayaran_check;
alter table public.penjualan
  add constraint penjualan_status_pembayaran_check
  check(status_pembayaran in ('belum_bayar','sebagian','lunas','dikembalikan'));
alter table public.penjualan
  drop constraint if exists penjualan_status_pemenuhan_check;
alter table public.penjualan
  add constraint penjualan_status_pemenuhan_check
  check(status_pemenuhan in ('menunggu','diproses','selesai','dibatalkan'));
update public.penjualan
set status_pembayaran='lunas',status_pemenuhan='selesai'
where status in ('selesai','dibatalkan');
update public.profiles p
set display_name=nullif(trim(u.raw_user_meta_data->>'full_name'),'')
from auth.users u
where p.id=u.id and p.display_name is null;

alter table public.mutasi_persediaan
  drop constraint if exists mutasi_persediaan_tipe_check;
alter table public.mutasi_persediaan
  add constraint mutasi_persediaan_tipe_check
  check(tipe in ('saldo_awal','pembelian','reservasi_pesanan','penjualan','penyesuaian','pembatalan'));

create index if not exists penjualan_pelanggan_tanggal_idx
  on public.penjualan(pelanggan_id,tanggal desc);
create unique index if not exists penjualan_customer_request_unique
  on public.penjualan(pelanggan_id,customer_request_id)
  where customer_request_id is not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.profiles(id,role,display_name)
  values(new.id,'customer',nullif(trim(new.raw_user_meta_data->>'full_name'),''));
  return new;
end;
$$;

drop policy if exists "Read own profile or owner" on public.profiles;
create policy "Read own profile or owner" on public.profiles
  for select to authenticated using (id=auth.uid() or public.is_owner());
drop policy if exists "Customer update own profile fields" on public.profiles;
create policy "Customer update own profile fields" on public.profiles
  for update to authenticated
  using (id=auth.uid() and role='customer')
  with check (id=auth.uid() and role='customer');

drop policy if exists "Customer reads own orders" on public.penjualan;
create policy "Customer reads own orders" on public.penjualan
  for select to authenticated
  using (
    pelanggan_id=(select p.pelanggan_id from public.profiles p where p.id=auth.uid() and p.role='customer')
  );
drop policy if exists "Customer reads own order lines" on public.detail_penjualan;
create or replace view public.customer_order_items
with (security_barrier=true)
as
  select d.penjualan_id,d.nama_barang,d.sku,d.jumlah,d.harga_satuan,d.subtotal
  from public.detail_penjualan d
  join public.penjualan s on s.id=d.penjualan_id
  join public.profiles p on p.pelanggan_id=s.pelanggan_id
  where p.id=auth.uid() and p.role='customer';

revoke all on public.profiles from anon,authenticated;
grant select on public.profiles to authenticated;
grant update(display_name,telepon,alamat) on public.profiles to authenticated;
grant select on public.penjualan,public.detail_penjualan to authenticated;
revoke all on public.customer_order_items from public,anon,authenticated;
grant select on public.customer_order_items to authenticated;

drop function if exists public.customer_checkout(jsonb,text);
drop function if exists public.customer_checkout(jsonb,text,uuid);
create or replace function public.customer_checkout(
  p_items jsonb,
  p_payment_method text,
  p_request_id uuid,
  p_recipient_name text,
  p_recipient_phone text,
  p_delivery_address text,
  p_delivery_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_profile public.profiles%rowtype;
  v_existing public.penjualan%rowtype;
  v_sale_id uuid:=gen_random_uuid();
  v_invoice text;
  v_subtotal numeric(14,2):=0;
  v_item jsonb;
  v_product public.barang%rowtype;
  v_qty numeric(14,3);
  v_line numeric(14,2);
  v_method text:=coalesce(p_payment_method,'cash');
  v_customer_name text;
begin
  if auth.uid() is null then raise exception 'Silakan login sebagai pelanggan.'; end if;
  if nullif(trim(p_recipient_name),'') is null
     or nullif(trim(p_recipient_phone),'') is null
     or nullif(trim(p_delivery_address),'') is null then
    raise exception 'Nama penerima, nomor telepon, dan alamat pengantaran wajib diisi.';
  end if;
  select * into v_profile from public.profiles where id=auth.uid() and role='customer' for update;
  if not found then raise exception 'Akun tidak memiliki akses pelanggan.'; end if;
  if p_request_id is null then raise exception 'ID permintaan checkout wajib diisi.'; end if;
  if v_profile.pelanggan_id is not null then
    select * into v_existing from public.penjualan
    where pelanggan_id=v_profile.pelanggan_id and customer_request_id=p_request_id;
    if found then
      return jsonb_build_object(
        'id',v_existing.id,'nomor_nota',v_existing.nomor_nota,'total',v_existing.total,
        'status',v_existing.status,'status_pembayaran',v_existing.status_pembayaran
      );
    end if;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Keranjang belanja kosong.';
  end if;
  if v_method not in ('cash','transfer','qris','debit') then raise exception 'Metode pembayaran tidak tersedia.'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) as items(item)
    group by item->>'product_id'
    having count(*)>1
  ) then
    raise exception 'Produk yang sama hanya boleh muncul satu kali di keranjang.';
  end if;

  v_customer_name:=coalesce(nullif(trim(v_profile.display_name),''),'Pelanggan');
  if v_profile.pelanggan_id is null then
    insert into public.pelanggan(nama,telepon,alamat)
    values(v_customer_name,v_profile.telepon,v_profile.alamat)
    returning id into v_profile.pelanggan_id;
    update public.profiles set pelanggan_id=v_profile.pelanggan_id where id=auth.uid();
  end if;

  for v_item in
    select items.item
    from jsonb_array_elements(p_items) as items(item)
    order by (items.item->>'product_id')
  loop
    v_qty:=nullif(v_item->>'qty','')::numeric;
    if v_qty is null or v_qty<=0 then raise exception 'Jumlah produk harus lebih besar dari nol.'; end if;
    select * into v_product
      from public.barang
      where id=(v_item->>'product_id')::uuid and aktif=true
      for update;
    if not found then raise exception 'Produk tidak ditemukan atau tidak aktif.'; end if;
    if v_product.stok<v_qty then
      raise exception 'Stok % tidak mencukupi. Tersedia: % %.',v_product.nama,v_product.stok,v_product.satuan;
    end if;
    v_subtotal:=v_subtotal+round(v_qty*v_product.harga_jual,2);
  end loop;
  if v_subtotal<=0 then raise exception 'Total pesanan harus lebih besar dari nol.'; end if;

  v_invoice:='ORD-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||upper(substr(replace(v_sale_id::text,'-',''),1,6));
  insert into public.penjualan(
    id,nomor_nota,pelanggan_id,subtotal,diskon,total,metode_pembayaran,
    jumlah_dibayar,kembalian,status,status_pembayaran,status_pemenuhan,catatan,customer_request_id,
    recipient_name,recipient_phone,delivery_address,delivery_note
  ) values (
    v_sale_id,v_invoice,v_profile.pelanggan_id,v_subtotal,0,v_subtotal,v_method,
    0,0,'menunggu','belum_bayar','menunggu','Pesanan pelanggan; menunggu konfirmasi Owner.',p_request_id,
    trim(p_recipient_name),trim(p_recipient_phone),trim(p_delivery_address),nullif(trim(p_delivery_note),'')
  );

  perform set_config('retailpro.stock_mutation','customer_order',true);
  for v_item in
    select items.item
    from jsonb_array_elements(p_items) as items(item)
    order by (items.item->>'product_id')
  loop
    v_qty:=(v_item->>'qty')::numeric;
    select * into v_product
      from public.barang
      where id=(v_item->>'product_id')::uuid and aktif=true
      for update;
    v_line:=round(v_qty*v_product.harga_jual,2);
    insert into public.detail_penjualan(
      penjualan_id,barang_id,nama_barang,sku,jumlah,harga_satuan,harga_pokok_satuan,subtotal
    ) values (
      v_sale_id,v_product.id,v_product.nama,v_product.sku,v_qty,
      v_product.harga_jual,v_product.harga_beli,v_line
    );
    update public.barang set stok=stok-v_qty where id=v_product.id;
    insert into public.mutasi_persediaan(
      barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
    ) values (
      v_product.id,'reservasi_pesanan',v_invoice,0,v_qty,v_product.stok-v_qty,'Reservasi pesanan pelanggan'
    );
  end loop;
  return jsonb_build_object(
    'id',v_sale_id,'nomor_nota',v_invoice,'total',v_subtotal,
    'status','menunggu','status_pembayaran','belum_bayar'
  );
end;
$$;

create or replace function public.cancel_customer_order(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sale public.penjualan%rowtype;
  v_line record;
  v_new_stock numeric(14,3);
begin
  if auth.uid() is null then raise exception 'Silakan login sebagai pelanggan.'; end if;
  select s.* into v_sale
  from public.penjualan s
  join public.profiles p on p.pelanggan_id=s.pelanggan_id
  where s.id=p_sale_id and p.id=auth.uid() and p.role='customer'
  for update of s;
  if not found then raise exception 'Pesanan tidak ditemukan.'; end if;
  if v_sale.status<>'menunggu' or v_sale.status_pembayaran<>'belum_bayar' then
    raise exception 'Pesanan hanya dapat dibatalkan sebelum diproses atau dibayar.';
  end if;

  perform set_config('retailpro.stock_mutation','customer_cancel',true);
  for v_line in select * from public.detail_penjualan where penjualan_id=p_sale_id loop
    update public.barang
    set stok=stok+v_line.jumlah
    where id=v_line.barang_id
    returning stok into v_new_stock;
    insert into public.mutasi_persediaan(
      barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
    ) values (
      v_line.barang_id,'pembatalan',v_sale.nomor_nota,v_line.jumlah,0,v_new_stock,'Pembatalan pesanan pelanggan'
    );
  end loop;
  update public.penjualan
  set status='dibatalkan',status_pemenuhan='dibatalkan'
  where id=p_sale_id;
  return jsonb_build_object('id',p_sale_id,'status','dibatalkan');
end;
$$;

revoke all on function public.customer_checkout(jsonb,text,uuid,text,text,text,text) from public,anon;
revoke all on function public.cancel_customer_order(uuid) from public,anon;
grant execute on function public.customer_checkout(jsonb,text,uuid,text,text,text,text) to authenticated;
grant execute on function public.cancel_customer_order(uuid) to authenticated;
