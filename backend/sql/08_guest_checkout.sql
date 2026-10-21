-- Public guest checkout for the customer storefront.
-- Review this migration before applying it. Run after 04_customer_portal.sql
-- and 06_app_operations.sql. This does not disable RLS or grant table writes.
begin;

-- The base security migration revokes schema access from anon. Grant only
-- schema lookup here; table access remains restricted to the catalog view/RPC.
grant usage on schema public to anon;
grant select on public.customer_catalog to anon;

create table if not exists public.guest_order_access (
  id uuid primary key default gen_random_uuid(),
  penjualan_id uuid not null unique references public.penjualan(id) on delete cascade,
  request_id uuid not null unique,
  tracking_token uuid not null unique,
  created_at timestamptz not null default now()
);
alter table public.guest_order_access enable row level security;
revoke all on public.guest_order_access from public,anon,authenticated;

create table if not exists public.guest_checkout_limits (
  phone_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check(request_count between 1 and 6)
);
create index if not exists guest_checkout_limits_window_idx
  on public.guest_checkout_limits(window_started_at);
alter table public.guest_checkout_limits enable row level security;
revoke all on public.guest_checkout_limits from public,anon,authenticated;

create or replace function public.guest_checkout(
  p_items jsonb,
  p_payment_method text,
  p_request_id uuid,
  p_tracking_token uuid,
  p_recipient_name text,
  p_recipient_phone text,
  p_delivery_address text,
  p_delivery_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_existing record;
  v_sale_id uuid:=gen_random_uuid();
  v_invoice text;
  v_subtotal numeric(14,2):=0;
  v_item jsonb;
  v_product public.barang%rowtype;
  v_qty numeric(14,3);
  v_line numeric(14,2);
  v_method text:=coalesce(p_payment_method,'cash');
  v_request_count integer;
  v_phone_key text;
begin
  if auth.uid() is not null then
    raise exception 'Gunakan checkout pelanggan setelah login.';
  end if;
  if p_request_id is null or p_tracking_token is null then
    raise exception 'ID permintaan dan kode pelacakan wajib tersedia.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select a.penjualan_id,s.nomor_nota,s.total,s.status,s.status_pembayaran
    into v_existing
    from public.guest_order_access a
    join public.penjualan s on s.id=a.penjualan_id
    where a.request_id=p_request_id and a.tracking_token=p_tracking_token;
  if found then
    return jsonb_build_object(
      'id',v_existing.penjualan_id,'nomor_nota',v_existing.nomor_nota,
      'total',v_existing.total,'status',v_existing.status,
      'status_pembayaran',v_existing.status_pembayaran
    );
  end if;
  if exists(select 1 from public.guest_order_access where request_id=p_request_id) then
    raise exception 'ID permintaan sudah dipakai dengan kode pelacakan berbeda.';
  end if;

  if nullif(trim(p_recipient_name),'') is null
     or length(trim(p_recipient_name))>120
     or nullif(trim(p_recipient_phone),'') is null
     or length(trim(p_recipient_phone))>40
     or nullif(trim(p_delivery_address),'') is null
     or length(trim(p_delivery_address))>400
     or length(coalesce(p_delivery_note,''))>300 then
    raise exception 'Nama, telepon, atau alamat pengantaran tidak valid.';
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array'
     or jsonb_array_length(p_items)=0 or jsonb_array_length(p_items)>20 then
    raise exception 'Keranjang harus berisi 1 sampai 20 produk.';
  end if;
  if v_method not in ('cash','transfer','qris','debit') then
    raise exception 'Metode pembayaran tidak tersedia.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as items(item)
    group by item->>'product_id'
    having count(*)>1
  ) then
    raise exception 'Produk yang sama hanya boleh muncul satu kali di keranjang.';
  end if;

  v_phone_key:=md5(regexp_replace(trim(p_recipient_phone),'[^0-9+]','','g'));
  delete from public.guest_checkout_limits
    where window_started_at<now()-interval '24 hours';
  insert into public.guest_checkout_limits(phone_key,window_started_at,request_count)
  values(v_phone_key,now(),1)
  on conflict(phone_key) do update
    set window_started_at=case
          when now()-guest_checkout_limits.window_started_at>=interval '15 minutes' then now()
          else guest_checkout_limits.window_started_at
        end,
        request_count=case
          when now()-guest_checkout_limits.window_started_at>=interval '15 minutes' then 1
          else guest_checkout_limits.request_count+1
        end
  returning request_count into v_request_count;
  if v_request_count>5 then
    raise exception 'Batas pesanan sementara tercapai untuk nomor ini. Coba lagi setelah 15 menit.';
  end if;

  for v_item in
    select items.item from jsonb_array_elements(p_items) as items(item)
    order by (items.item->>'product_id')
  loop
    if coalesce(v_item->>'product_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Produk pada keranjang tidak valid.';
    end if;
    v_qty:=nullif(v_item->>'qty','')::numeric;
    if v_qty is null or v_qty<=0 or v_qty>1000 then
      raise exception 'Jumlah produk harus lebih besar dari nol dan tidak lebih dari 1000.';
    end if;
    select * into v_product from public.barang
      where id=(v_item->>'product_id')::uuid and aktif=true for update;
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
    jumlah_dibayar,kembalian,status,status_pembayaran,status_pemenuhan,
    catatan,customer_request_id,recipient_name,recipient_phone,
    delivery_address,delivery_note
  ) values (
    v_sale_id,v_invoice,null,v_subtotal,0,v_subtotal,v_method,0,0,
    'menunggu','belum_bayar','menunggu',
    'Pesanan tamu; menunggu konfirmasi Owner.',p_request_id,
    trim(p_recipient_name),trim(p_recipient_phone),
    trim(p_delivery_address),nullif(trim(p_delivery_note),'')
  );

  insert into public.guest_order_access(penjualan_id,request_id,tracking_token)
  values(v_sale_id,p_request_id,p_tracking_token);

  perform set_config('retailpro.stock_mutation','customer_order',true);
  for v_item in
    select items.item from jsonb_array_elements(p_items) as items(item)
    order by (items.item->>'product_id')
  loop
    v_qty:=(v_item->>'qty')::numeric;
    select * into v_product from public.barang
      where id=(v_item->>'product_id')::uuid and aktif=true for update;
    v_line:=round(v_qty*v_product.harga_jual,2);
    insert into public.detail_penjualan(
      penjualan_id,barang_id,nama_barang,sku,jumlah,
      harga_satuan,harga_pokok_satuan,subtotal
    ) values(
      v_sale_id,v_product.id,v_product.nama,v_product.sku,v_qty,
      v_product.harga_jual,v_product.harga_beli,v_line
    );
    update public.barang set stok=stok-v_qty where id=v_product.id;
    insert into public.mutasi_persediaan(
      barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
    ) values(
      v_product.id,'reservasi_pesanan',v_invoice,0,v_qty,
      v_product.stok-v_qty,'Reservasi checkout tamu'
    );
  end loop;

  return jsonb_build_object(
    'id',v_sale_id,'nomor_nota',v_invoice,'total',v_subtotal,
    'status','menunggu','status_pembayaran','belum_bayar'
  );
end;
$$;

create or replace function public.guest_order_status(p_tracking_token uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_items jsonb;
begin
  if auth.uid() is not null then
    raise exception 'Gunakan riwayat pesanan setelah login.';
  end if;
  if p_tracking_token is null then raise exception 'Kode pelacakan wajib diisi.'; end if;
  select s.* into v_sale
    from public.guest_order_access a
    join public.penjualan s on s.id=a.penjualan_id
    where a.tracking_token=p_tracking_token;
  if not found then raise exception 'Pesanan tidak ditemukan. Periksa kode pelacakan.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'name',d.nama_barang,'sku',d.sku,'quantity',d.jumlah,
    'price',d.harga_satuan,'subtotal',d.subtotal
  ) order by d.created_at),'[]'::jsonb)
    into v_items from public.detail_penjualan d where d.penjualan_id=v_sale.id;
  return jsonb_build_object(
    'nomor_nota',v_sale.nomor_nota,'tanggal',v_sale.tanggal,
    'recipient_name',v_sale.recipient_name,'status',v_sale.status,
    'status_pembayaran',v_sale.status_pembayaran,'total',v_sale.total,
    'items',v_items
  );
end;
$$;

revoke all on function public.guest_checkout(jsonb,text,uuid,uuid,text,text,text,text) from public,authenticated;
grant execute on function public.guest_checkout(jsonb,text,uuid,uuid,text,text,text,text) to anon;
revoke all on function public.guest_order_status(uuid) from public,authenticated;
grant execute on function public.guest_order_status(uuid) to anon;

commit;
notify pgrst,'reload schema';
