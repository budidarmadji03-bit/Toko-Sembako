-- RPC transaksi atomik: validasi stok, simpan nota/detail, kurangi stok, dan catat mutasi.
-- Frontend wajib memanggil fungsi ini, bukan mengubah stok sendiri setelah transaksi.
create or replace function public.create_sale(
  p_customer_id uuid,
  p_discount numeric,
  p_payment_method text,
  p_amount_paid numeric,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_sale_id uuid:=gen_random_uuid();
  v_invoice text;
  v_subtotal numeric(14,2):=0;
  v_discount numeric(14,2):=greatest(coalesce(p_discount,0),0);
  v_total numeric(14,2);
  v_paid numeric(14,2):=greatest(coalesce(p_amount_paid,0),0);
  v_change numeric(14,2);
  v_item jsonb;
  v_product public.barang%rowtype;
  v_qty numeric(14,3);
  v_unit_price numeric(14,2);
  v_cost numeric(14,2);
  v_line numeric(14,2);
  v_method text:=coalesce(p_payment_method,'cash');
begin
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Keranjang penjualan kosong.';
  end if;
  if v_discount<0 then raise exception 'Diskon tidak boleh negatif.'; end if;
  if v_method not in ('cash','transfer','qris','debit') then raise exception 'Metode pembayaran tidak valid.'; end if;

  -- Lock baris produk satu per satu agar dua kasir tidak menjual stok yang sama.
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty:=nullif(v_item->>'qty','')::numeric;
    if v_qty is null or v_qty<=0 then raise exception 'Jumlah barang harus lebih besar dari nol.'; end if;
    select * into v_product from public.barang where id=(v_item->>'product_id')::uuid and aktif=true for update;
    if not found then raise exception 'Barang tidak ditemukan atau tidak aktif.'; end if;
    if v_product.stok<v_qty then raise exception 'Stok % tidak cukup. Tersedia: % %.',v_product.nama,v_product.stok,v_product.satuan; end if;
    v_unit_price:=v_product.harga_jual;
    v_subtotal:=v_subtotal+round(v_qty*v_unit_price,2);
  end loop;

  if v_discount>v_subtotal then raise exception 'Diskon tidak boleh melebihi subtotal.'; end if;
  v_total:=v_subtotal-v_discount;
  if v_paid<v_total then raise exception 'Jumlah dibayar kurang dari total tagihan.'; end if;
  v_change:=v_paid-v_total;
  v_invoice:='INV-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||upper(substr(replace(v_sale_id::text,'-',''),1,6));

  insert into public.penjualan(id,nomor_nota,pelanggan_id,subtotal,diskon,total,metode_pembayaran,jumlah_dibayar,kembalian,status)
  values(v_sale_id,v_invoice,p_customer_id,v_subtotal,v_discount,v_total,v_method,v_paid,v_change,'selesai');

  perform set_config('retailpro.stock_mutation','sale',true);
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty:=(v_item->>'qty')::numeric;
    select * into v_product from public.barang where id=(v_item->>'product_id')::uuid and aktif=true for update;
    v_unit_price:=v_product.harga_jual;
    v_cost:=v_product.harga_beli;
    v_line:=round(v_qty*v_unit_price,2);
    insert into public.detail_penjualan(penjualan_id,barang_id,nama_barang,sku,jumlah,harga_satuan,harga_pokok_satuan,subtotal)
    values(v_sale_id,v_product.id,v_product.nama,v_product.sku,v_qty,v_unit_price,v_cost,v_line);
    update public.barang set stok=stok-v_qty where id=v_product.id;
    insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
    values(v_product.id,'penjualan',v_invoice,0,v_qty,v_product.stok-v_qty,'Penjualan kasir');
  end loop;
  return jsonb_build_object('id',v_sale_id,'nomor_nota',v_invoice,'subtotal',v_subtotal,'diskon',v_discount,'total',v_total,'jumlah_dibayar',v_paid,'kembalian',v_change);
end;
$$;

-- Pembatalan penjualan hanya mengembalikan stok sekali dan menandai nota dibatalkan.
create or replace function public.cancel_sale(p_sale_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_sale public.penjualan%rowtype; v_detail record; v_new_stock numeric(14,3);
begin
  select * into v_sale from public.penjualan where id=p_sale_id for update;
  if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
  if v_sale.status='dibatalkan' then raise exception 'Transaksi sudah dibatalkan.'; end if;
  perform set_config('retailpro.stock_mutation','cancel',true);
  for v_detail in select * from public.detail_penjualan where penjualan_id=p_sale_id loop
    update public.barang set stok=stok+v_detail.jumlah where id=v_detail.barang_id returning stok into v_new_stock;
    insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
    values(v_detail.barang_id,'pembatalan',v_sale.nomor_nota,v_detail.jumlah,0,v_new_stock,'Pembatalan transaksi penjualan');
  end loop;
  update public.penjualan set status='dibatalkan' where id=p_sale_id;
  return jsonb_build_object('id',p_sale_id,'status','dibatalkan','nomor_nota',v_sale.nomor_nota);
end; $$;

create or replace function public.record_stock_in(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_note text default null
)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_product public.barang%rowtype; v_new_stock numeric(14,3); v_new_cost numeric(14,2);
begin
  if p_qty is null or p_qty<=0 then raise exception 'Jumlah stok masuk harus lebih besar dari nol.'; end if;
  if p_unit_cost is null or p_unit_cost<0 then raise exception 'Harga beli tidak boleh negatif.'; end if;
  select * into v_product from public.barang where id=p_product_id and aktif=true for update;
  if not found then raise exception 'Barang tidak ditemukan atau tidak aktif.'; end if;
  -- Update harga beli terakhir; nilai stok di dashboard menggunakan qty x harga beli terakhir.
  v_new_cost:=round(p_unit_cost,2);
  perform set_config('retailpro.stock_mutation','stock_in',true);
  update public.barang set stok=stok+p_qty,harga_beli=v_new_cost where id=p_product_id returning stok into v_new_stock;
  insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
  values(p_product_id,'penyesuaian',null,p_qty,0,v_new_stock,coalesce(p_note,'Stok masuk'));
  insert into public.pembelian_stok(barang_id,jumlah,harga_satuan,total,catatan)
  values(p_product_id,p_qty,v_new_cost,round(p_qty*v_new_cost,2),nullif(trim(p_note),''));
  return jsonb_build_object('product_id',p_product_id,'qty_masuk',p_qty,'stok_setelah',v_new_stock);
end; $$;

grant execute on function public.record_stock_in(uuid,numeric,numeric,text) to anon,authenticated;
grant execute on function public.create_sale(uuid,numeric,text,numeric,jsonb) to anon,authenticated;
grant execute on function public.cancel_sale(uuid) to anon,authenticated;
