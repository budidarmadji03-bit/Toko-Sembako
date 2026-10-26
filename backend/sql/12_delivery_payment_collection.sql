-- Complete a delivery and record its outstanding customer receipt atomically.
-- Requires 07_delivery_tracking.sql, 09_accounting_ledger.sql, and 10_fix_accounting_journal_trigger.sql.
begin;

create or replace function public.complete_delivery_with_payment(
  p_sale_id uuid,
  p_payment_method text,
  p_payment_date date,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_existing public.accounting_payments%rowtype;
  v_paid numeric(16,2);
  v_outstanding numeric(16,2);
  v_payment jsonb;
begin
  perform public.accounting_assert_owner();
  if p_sale_id is null or p_request_key is null
     or p_payment_method is null
     or p_payment_method not in ('cash','transfer','qris')
     or p_payment_date is null
     or p_payment_date<(select cutover_date from public.accounting_settings where id=true)
     or p_payment_date>(now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal atau metode penerimaan pembayaran tidak valid.';
  end if;

  select * into v_sale
  from public.penjualan
  where id=p_sale_id and recipient_name is not null
  for update;
  if not found then
    raise exception 'Pesanan antar tidak ditemukan.';
  end if;

  select * into v_existing
  from public.accounting_payments
  where request_key=p_request_key;
  if found then
    if v_existing.kind<>'customer_receipt'
       or v_existing.source_id<>p_sale_id
       or v_existing.payment_method<>p_payment_method
       or v_existing.payment_date<>p_payment_date then
      raise exception 'Kunci permintaan sudah digunakan untuk pembayaran berbeda.';
    end if;
    return jsonb_build_object(
      'sale_id',p_sale_id,'status',v_sale.status,
      'payment_id',v_existing.id,'paid_amount',v_existing.amount,
      'collected_amount',v_existing.amount,
      'payment_method',v_existing.payment_method,'duplicate',true
    );
  end if;

  if v_sale.status='diproses' then
    perform public.update_delivery_status(p_sale_id,'dalam_pengiriman');
    perform public.update_delivery_status(p_sale_id,'selesai');
  elsif v_sale.status='dalam_pengiriman' then
    perform public.update_delivery_status(p_sale_id,'selesai');
  elsif v_sale.status<>'selesai' then
    raise exception 'Pesanan harus sedang diproses atau dalam pengiriman sebelum diselesaikan.';
  end if;

  set constraints accounting_sale_posting immediate;

  select * into v_sale from public.penjualan where id=p_sale_id for update;
  select coalesce(sum(amount),0) into v_paid
  from public.accounting_payments
  where kind='customer_receipt' and source_id=p_sale_id;
  v_outstanding:=greatest(round(v_sale.total-v_paid,2),0);

  if v_outstanding=0 then
    return jsonb_build_object(
      'sale_id',p_sale_id,'status','selesai','paid_amount',v_paid,
      'outstanding',0,'already_paid',true
    );
  end if;

  v_payment:=public.record_customer_payment(
    p_sale_id,v_outstanding,p_payment_method,p_payment_date,p_request_key
  );
  return v_payment||jsonb_build_object(
    'status','selesai','payment_method',p_payment_method,
    'collected_amount',v_outstanding
  );
end;
$$;

revoke all on function public.complete_delivery_with_payment(uuid,text,date,uuid) from public,anon;
grant execute on function public.complete_delivery_with_payment(uuid,text,date,uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
