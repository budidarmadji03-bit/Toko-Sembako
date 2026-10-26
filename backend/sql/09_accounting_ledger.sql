-- Double-entry accounting ledger. Run after migrations 01 through 08.
-- Existing operational records are deliberately not backfilled: payment dates,
-- settlements, and opening balances cannot be reconstructed from their history.
begin;

create table if not exists public.accounting_settings (
  id boolean primary key default true check (id),
  cutover_date date not null default date '2026-10-26',
  activated_at timestamptz not null default now(),
  opening_entry_id uuid
);
insert into public.accounting_settings(id,cutover_date)
values(true,date '2026-10-26')
on conflict(id) do nothing;

create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  account_type text not null check (account_type in
    ('asset','liability','equity','revenue','contra_revenue','expense')),
  normal_balance text not null check (normal_balance in ('debit','credit')),
  is_cash_equivalent boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (not is_cash_equivalent or account_type='asset')
);

insert into public.chart_of_accounts(code,name,account_type,normal_balance,is_cash_equivalent)
values
  ('1010','Kas','asset','debit',true),
  ('1020','Bank','asset','debit',true),
  ('1030','Piutang usaha','asset','debit',false),
  ('1040','Persediaan barang dagang','asset','debit',false),
  ('2010','Utang pemasok','liability','credit',false),
  ('2020','Utang pengembalian pelanggan','liability','credit',false),
  ('2030','Utang beban operasional','liability','credit',false),
  ('3010','Modal pemilik','equity','credit',false),
  ('3020','Saldo laba awal','equity','credit',false),
  ('3030','Prive pemilik','equity','debit',false),
  ('4010','Penjualan','revenue','credit',false),
  ('4020','Diskon penjualan','contra_revenue','debit',false),
  ('4030','Keuntungan penyesuaian persediaan','revenue','credit',false),
  ('5010','Harga pokok penjualan','expense','debit',false),
  ('6010','Beban operasional','expense','debit',false),
  ('6020','Kerugian penyesuaian persediaan','expense','debit',false)
on conflict(code) do nothing;

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  description text not null check (length(trim(description)) between 1 and 500),
  entry_type text not null,
  source_type text not null,
  source_id uuid not null,
  cash_flow_activity text not null default 'operating'
    check (cash_flow_activity in ('operating','investing','financing','noncash')),
  posted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(source_type,source_id,entry_type)
);
create index if not exists journal_entries_date_idx
  on public.journal_entries(entry_date,id);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  account_id uuid not null references public.chart_of_accounts(id) on delete restrict,
  debit numeric(16,2) not null default 0 check (debit>=0),
  credit numeric(16,2) not null default 0 check (credit>=0),
  description text,
  check ((debit>0 and credit=0) or (credit>0 and debit=0))
);
create index if not exists journal_lines_entry_idx on public.journal_lines(journal_entry_id);
create index if not exists journal_lines_account_idx on public.journal_lines(account_id);

create table if not exists public.accounting_payments (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  kind text not null check (kind in
    ('customer_receipt','supplier_payment','expense_payment','customer_refund')),
  source_id uuid not null,
  amount numeric(16,2) not null check (amount>0),
  payment_method text not null check (payment_method in ('cash','transfer','qris','debit')),
  cash_account_id uuid not null references public.chart_of_accounts(id),
  payment_date date not null,
  journal_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists accounting_payments_source_idx
  on public.accounting_payments(kind,source_id,payment_date);

create table if not exists public.account_reconciliations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid,
  account_id uuid not null references public.chart_of_accounts(id) on delete restrict,
  statement_date date not null,
  statement_balance numeric(16,2) not null,
  note text not null check (length(trim(note)) between 1 and 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists account_reconciliations_date_idx
  on public.account_reconciliations(account_id,statement_date desc);
create unique index if not exists account_reconciliations_request_key_idx
  on public.account_reconciliations(request_key) where request_key is not null;

alter table public.accounting_settings
  drop constraint if exists accounting_settings_opening_entry_fk;
alter table public.accounting_settings
  add constraint accounting_settings_opening_entry_fk
  foreign key(opening_entry_id) references public.journal_entries(id) on delete restrict;

alter table public.pembelian_stok
  add column if not exists request_key uuid,
  add column if not exists paid_amount numeric(16,2)
    check (paid_amount>=0),
  add column if not exists payment_method text
    check (payment_method in ('cash','transfer','qris','debit'));
alter table public.beban_operasional
  add column if not exists request_key uuid,
  add column if not exists paid_amount numeric(16,2)
    check (paid_amount>=0),
  add column if not exists payment_method text
    check (payment_method in ('cash','transfer','qris','debit'));
alter table public.pembelian_stok
  alter column paid_amount drop not null,
  alter column paid_amount drop default,
  alter column payment_method drop not null,
  alter column payment_method drop default;
alter table public.beban_operasional
  alter column paid_amount drop not null,
  alter column paid_amount drop default,
  alter column payment_method drop not null,
  alter column payment_method drop default;
update public.pembelian_stok
set paid_amount=null,payment_method=null
where request_key is null and created_at<(
  select activated_at from public.accounting_settings where id=true
);
update public.beban_operasional
set paid_amount=null,payment_method=null
where request_key is null and created_at<(
  select activated_at from public.accounting_settings where id=true
);
alter table public.pembelian_stok
  drop constraint if exists pembelian_stok_accounting_settlement_check;
alter table public.pembelian_stok
  add constraint pembelian_stok_accounting_settlement_check
  check (
    (paid_amount is null)=(payment_method is null)
    and (paid_amount is null or paid_amount<=total)
  );
alter table public.beban_operasional
  drop constraint if exists beban_operasional_accounting_settlement_check;
alter table public.beban_operasional
  add constraint beban_operasional_accounting_settlement_check
  check (
    (paid_amount is null)=(payment_method is null)
    and (paid_amount is null or paid_amount<=nominal)
  );
create unique index if not exists pembelian_stok_request_key_idx
  on public.pembelian_stok(request_key) where request_key is not null;
create unique index if not exists beban_operasional_request_key_idx
  on public.beban_operasional(request_key) where request_key is not null;

alter table public.accounting_settings enable row level security;
alter table public.chart_of_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
alter table public.accounting_payments enable row level security;
alter table public.account_reconciliations enable row level security;

drop policy if exists "Owner reads accounting settings" on public.accounting_settings;
create policy "Owner reads accounting settings" on public.accounting_settings
  for select to authenticated using (public.is_owner());
drop policy if exists "Owner reads chart of accounts" on public.chart_of_accounts;
create policy "Owner reads chart of accounts" on public.chart_of_accounts
  for select to authenticated using (public.is_owner());
drop policy if exists "Owner reads journal entries" on public.journal_entries;
create policy "Owner reads journal entries" on public.journal_entries
  for select to authenticated using (public.is_owner());
drop policy if exists "Owner reads journal lines" on public.journal_lines;
create policy "Owner reads journal lines" on public.journal_lines
  for select to authenticated using (public.is_owner());
drop policy if exists "Owner reads accounting payments" on public.accounting_payments;
create policy "Owner reads accounting payments" on public.accounting_payments
  for select to authenticated using (public.is_owner());
drop policy if exists "Owner reads reconciliations" on public.account_reconciliations;
create policy "Owner reads reconciliations" on public.account_reconciliations
  for select to authenticated using (public.is_owner());

revoke all on public.accounting_settings,public.chart_of_accounts,public.journal_entries,
  public.journal_lines,public.accounting_payments,public.account_reconciliations
  from anon,authenticated;
grant select on public.accounting_settings,public.chart_of_accounts,public.journal_entries,
  public.journal_lines,public.accounting_payments,public.account_reconciliations
  to authenticated;
revoke insert,update,delete on public.pembelian_stok,public.beban_operasional from authenticated;
grant select on public.pembelian_stok,public.beban_operasional to authenticated;

create or replace function public.accounting_assert_owner()
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'Hanya Owner yang dapat mengakses fungsi akuntansi.';
  end if;
end;
$$;

create or replace function public.accounting_post_journal(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_entry_type text,
  p_cash_flow_activity text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_entry_id uuid;
  v_line jsonb;
  v_account public.chart_of_accounts%rowtype;
  v_debit numeric(16,2):=0;
  v_credit numeric(16,2):=0;
  v_line_debit numeric(16,2);
  v_line_credit numeric(16,2);
  v_cash_net numeric(16,2):=0;
  v_count integer:=0;
  v_cutover date;
begin
  perform public.accounting_assert_owner();
  if p_entry_date is null or p_description is null or p_source_type is null
     or p_source_id is null or p_entry_type is null
     or p_cash_flow_activity is null
     or p_cash_flow_activity not in ('operating','investing','financing','noncash')
     or p_lines is null or jsonb_typeof(p_lines)<>'array' then
    raise exception 'Data jurnal tidak lengkap.';
  end if;
  select cutover_date into v_cutover from public.accounting_settings where id=true;
  if p_entry_date<v_cutover then
    raise exception 'Tanggal jurnal tidak boleh sebelum tanggal mulai pembukuan (%).',v_cutover;
  end if;

  insert into public.journal_entries(
    entry_date,description,source_type,source_id,entry_type,cash_flow_activity,posted_by
  ) values (
    p_entry_date,trim(p_description),p_source_type,p_source_id,p_entry_type,
    p_cash_flow_activity,auth.uid()
  )
  on conflict(source_type,source_id,entry_type) do nothing
  returning id into v_entry_id;
  if v_entry_id is null then
    select id into v_entry_id from public.journal_entries
    where source_type=p_source_type and source_id=p_source_id and entry_type=p_entry_type;
    return v_entry_id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_account:=null;
    select * into v_account from public.chart_of_accounts
    where code=trim(v_line->>'account_code') and is_active;
    if not found then raise exception 'Akun jurnal tidak ditemukan atau tidak aktif: %.',v_line->>'account_code'; end if;
    v_line_debit:=coalesce(nullif(v_line->>'debit','')::numeric,0);
    v_line_credit:=coalesce(nullif(v_line->>'credit','')::numeric,0);
    if v_line_debit<0 or v_line_credit<0 or (v_line_debit>0 and v_line_credit>0) then
      raise exception 'Setiap baris jurnal harus memiliki debit atau kredit positif, tidak keduanya.';
    end if;
    if v_line_debit=0 and v_line_credit=0 then continue; end if;
    insert into public.journal_lines(journal_entry_id,account_id,debit,credit,description)
    values(v_entry_id,v_account.id,round(v_line_debit,2),round(v_line_credit,2),
      nullif(left(trim(coalesce(v_line->>'description','')),500),''));
    v_debit:=v_debit+round(v_line_debit,2);
    v_credit:=v_credit+round(v_line_credit,2);
    if v_account.is_cash_equivalent then
      v_cash_net:=v_cash_net+round(v_line_debit,2)-round(v_line_credit,2);
    end if;
    v_count:=v_count+1;
  end loop;
  if v_count<2 or v_debit=0 or abs(v_debit-v_credit)>0.005 then
    raise exception 'Jurnal harus memiliki minimal dua baris dan total debit harus sama dengan kredit.';
  end if;
  if p_source_type<>'opening' and p_cash_flow_activity='noncash' and v_cash_net<>0 then
    raise exception 'Jurnal nonkas tidak boleh mengubah saldo Kas/Bank.';
  end if;
  return v_entry_id;
end;
$$;

create or replace function public.accounting_validate_journal()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_entry_id uuid;
  v_count integer;
  v_debit numeric(16,2);
  v_credit numeric(16,2);
begin
  v_entry_id:=case when tg_table_name='journal_entries' then new.id else new.journal_entry_id end;
  select count(*),coalesce(sum(debit),0),coalesce(sum(credit),0)
    into v_count,v_debit,v_credit
  from public.journal_lines where journal_entry_id=v_entry_id;
  if v_count<2 or v_debit=0 or abs(v_debit-v_credit)>0.005 then
    raise exception 'Jurnal % tidak seimbang: debit %, kredit %.',v_entry_id,v_debit,v_credit;
  end if;
  return null;
end;
$$;
drop trigger if exists accounting_validate_entry on public.journal_entries;
create constraint trigger accounting_validate_entry
  after insert on public.journal_entries
  deferrable initially deferred for each row execute function public.accounting_validate_journal();
drop trigger if exists accounting_validate_lines on public.journal_lines;
create constraint trigger accounting_validate_lines
  after insert on public.journal_lines
  deferrable initially deferred for each row execute function public.accounting_validate_journal();

create or replace function public.accounting_reject_journal_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name='accounting_payments' and tg_op='UPDATE'
     and old.journal_entry_id is null and new.journal_entry_id is not null
     and (to_jsonb(old)-'journal_entry_id')=(to_jsonb(new)-'journal_entry_id') then
    return new;
  end if;
  raise exception 'Jurnal akuntansi bersifat immutable; gunakan jurnal koreksi.';
end;
$$;
drop trigger if exists journal_entries_immutable on public.journal_entries;
create trigger journal_entries_immutable before update or delete on public.journal_entries
  for each row execute function public.accounting_reject_journal_mutation();
drop trigger if exists journal_lines_immutable on public.journal_lines;
create trigger journal_lines_immutable before update or delete on public.journal_lines
  for each row execute function public.accounting_reject_journal_mutation();
drop trigger if exists accounting_payments_immutable on public.accounting_payments;
create trigger accounting_payments_immutable before update or delete on public.accounting_payments
  for each row execute function public.accounting_reject_journal_mutation();

create or replace function public.accounting_create_payment(
  p_request_key uuid,
  p_kind text,
  p_source_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_date date,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_payment_id uuid;
  v_cash_code text;
  v_offset_code text;
  v_cash_id uuid;
  v_entry_id uuid;
  v_existing public.accounting_payments%rowtype;
  v_activity text:='operating';
  v_debit_code text;
  v_credit_code text;
  v_source_type text;
begin
  perform public.accounting_assert_owner();
  if p_request_key is null or p_source_id is null or p_amount is null or p_amount<=0
     or p_payment_date is null or p_payment_method is null
     or p_payment_method not in ('cash','transfer','qris','debit')
     or p_kind is null or p_kind not in ('customer_receipt','supplier_payment','expense_payment','customer_refund') then
    raise exception 'Data pembayaran tidak valid.';
  end if;
  if p_payment_date<(select cutover_date from public.accounting_settings where id=true)
     or p_payment_date>(now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal pembayaran harus berada pada atau setelah tanggal cutover dan tidak boleh di masa depan.';
  end if;
  select * into v_existing from public.accounting_payments where request_key=p_request_key;
  if found then
    if v_existing.kind<>p_kind or v_existing.source_id<>p_source_id
       or v_existing.amount<>round(p_amount,2)
       or v_existing.payment_method<>p_payment_method
       or v_existing.payment_date<>p_payment_date then
      raise exception 'Kunci pembayaran sudah digunakan untuk transaksi berbeda.';
    end if;
    return v_existing.id;
  end if;

  v_cash_code:=case when p_payment_method='cash' then '1010' else '1020' end;
  v_offset_code:=case p_kind
    when 'customer_receipt' then '1030'
    when 'supplier_payment' then '2010'
    when 'expense_payment' then '2030'
    when 'customer_refund' then '2020'
  end;
  if p_kind in ('customer_receipt','customer_refund') then
    v_source_type:='sale';
  elsif p_kind='supplier_payment' then
    v_source_type:='purchase';
  else
    v_source_type:='expense';
  end if;
  select id into v_cash_id from public.chart_of_accounts where code=v_cash_code;
  insert into public.accounting_payments(
    request_key,kind,source_id,amount,payment_method,cash_account_id,payment_date,created_by
  ) values (
    p_request_key,p_kind,p_source_id,round(p_amount,2),p_payment_method,v_cash_id,p_payment_date,auth.uid()
  ) returning id into v_payment_id;

  if p_kind in ('customer_receipt','supplier_payment') then
    v_debit_code:=v_cash_code;
    v_credit_code:=v_offset_code;
  else
    v_debit_code:=v_offset_code;
    v_credit_code:=v_cash_code;
  end if;
  v_entry_id:=public.accounting_post_journal(
    p_payment_date,coalesce(nullif(trim(p_description),''),'Pembayaran '||p_kind),
    'payment',v_payment_id,p_kind,'operating',
    jsonb_build_array(
      jsonb_build_object('account_code',v_debit_code,'debit',round(p_amount,2),'credit',0),
      jsonb_build_object('account_code',v_credit_code,'debit',0,'credit',round(p_amount,2))
    )
  );
  update public.accounting_payments set journal_entry_id=v_entry_id where id=v_payment_id;
  return v_payment_id;
end;
$$;

create or replace function public.accounting_post_purchase()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_paid numeric(16,2);
  v_total numeric(16,2);
begin
  select * into v_settings from public.accounting_settings where id=true;
  if new.created_at<v_settings.activated_at then return new; end if;
  if new.paid_amount is null then raise exception 'Pembayaran pembelian baru wajib dicatat secara eksplisit.'; end if;
  v_total:=round(new.total,2);
  v_paid:=round(new.paid_amount,2);
  if v_total<=0 or v_paid<0 or v_paid>v_total then raise exception 'Nilai pembelian atau pembayaran tidak valid.'; end if;
  perform public.accounting_post_journal(
    (new.tanggal at time zone 'Asia/Jakarta')::date,
    'Pembelian stok: '||coalesce(new.catatan,new.id::text),
    'purchase',new.id,'purchase','operating',
    jsonb_build_array(
      jsonb_build_object('account_code','1040','debit',v_total,'credit',0),
      jsonb_build_object('account_code','2010','debit',0,'credit',v_total)
    )
  );
  if v_paid>0 then
    perform public.accounting_create_payment(
      new.id,'supplier_payment',new.id,v_paid,new.payment_method,
      (new.tanggal at time zone 'Asia/Jakarta')::date,'Pembayaran pembelian stok'
    );
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_purchase_posting on public.pembelian_stok;
create trigger accounting_purchase_posting after insert on public.pembelian_stok
  for each row execute function public.accounting_post_purchase();

create or replace function public.accounting_post_expense()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_paid numeric(16,2);
begin
  select * into v_settings from public.accounting_settings where id=true;
  if new.created_at<v_settings.activated_at then return new; end if;
  if new.paid_amount is null then raise exception 'Pembayaran beban baru wajib dicatat secara eksplisit.'; end if;
  v_paid:=round(new.paid_amount,2);
  if new.nominal<=0 or v_paid<0 or v_paid>new.nominal then raise exception 'Nilai beban atau pembayaran tidak valid.'; end if;
  perform public.accounting_post_journal(
    (new.tanggal at time zone 'Asia/Jakarta')::date,
    'Beban: '||new.kategori||' - '||new.keterangan,
    'expense',new.id,'expense','operating',
    jsonb_build_array(
      jsonb_build_object('account_code','6010','debit',round(new.nominal,2),'credit',0),
      jsonb_build_object('account_code','2030','debit',0,'credit',round(new.nominal,2))
    )
  );
  if v_paid>0 then
    perform public.accounting_create_payment(
      new.id,'expense_payment',new.id,v_paid,new.payment_method,
      (new.tanggal at time zone 'Asia/Jakarta')::date,'Pembayaran beban operasional'
    );
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_expense_posting on public.beban_operasional;
create trigger accounting_expense_posting after insert on public.beban_operasional
  for each row execute function public.accounting_post_expense();

create or replace function public.accounting_post_sale()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_cost numeric(16,2);
  v_paid numeric(16,2);
  v_outstanding numeric(16,2);
  v_existing uuid;
  v_lines jsonb;
  v_entry_date date;
begin
  select * into v_settings from public.accounting_settings where id=true;
  if new.created_at<v_settings.activated_at and not (
    tg_op='UPDATE' and old.status is distinct from 'selesai' and new.status='selesai'
  ) then return new; end if;
  v_entry_date:=case when new.created_at<v_settings.activated_at
    then (now() at time zone 'Asia/Jakarta')::date
    else (new.tanggal at time zone 'Asia/Jakarta')::date end;
  select id into v_existing from public.journal_entries
  where source_type='sale' and source_id=new.id and entry_type='sale';

  if new.status='dibatalkan' then
    if v_existing is null or exists (
      select 1 from public.journal_entries
      where source_type='sale' and source_id=new.id and entry_type='sale_reversal'
    ) then return new; end if;
    select coalesce(sum(amount),0) into v_paid from public.accounting_payments
      where kind='customer_receipt' and source_id=new.id;
    v_outstanding:=greatest(round(new.total,2)-v_paid,0);
    v_lines:=jsonb_build_array(
      jsonb_build_object('account_code','4010','debit',round(new.subtotal,2),'credit',0),
      jsonb_build_object('account_code','4020','debit',0,'credit',round(new.diskon,2)),
      jsonb_build_object('account_code',case when v_paid>0 then '2020' else '1030' end,
        'debit',0,'credit',case when v_paid>0 then v_paid else 0 end),
      jsonb_build_object('account_code','1030','debit',0,'credit',v_outstanding)
    );
    select coalesce(sum(round(d.jumlah*d.harga_pokok_satuan,2)),0)
      into v_cost from public.detail_penjualan d where d.penjualan_id=new.id;
    if v_cost>0 then
      v_lines:=v_lines||jsonb_build_array(
        jsonb_build_object('account_code','1040','debit',v_cost,'credit',0),
        jsonb_build_object('account_code','5010','debit',0,'credit',v_cost)
      );
    end if;
    perform public.accounting_post_journal(
      (now() at time zone 'Asia/Jakarta')::date,
      'Pembatalan penjualan: '||new.nomor_nota,
      'sale',new.id,'sale_reversal','operating',v_lines
    );
    return new;
  end if;

  if new.status<>'selesai' or v_existing is not null then return new; end if;
  if new.total<=0 or round(new.subtotal-new.diskon,2)<>round(new.total,2) then
    raise exception 'Penjualan tidak dapat dijurnal: total nota tidak valid.';
  end if;
  select coalesce(sum(round(d.jumlah*d.harga_pokok_satuan,2)),0)
    into v_cost from public.detail_penjualan d where d.penjualan_id=new.id;
  v_lines:=jsonb_build_array(
    jsonb_build_object('account_code','1030','debit',round(new.total,2),'credit',0),
    jsonb_build_object('account_code','4020','debit',round(new.diskon,2),'credit',0),
    jsonb_build_object('account_code','4010','debit',0,'credit',round(new.subtotal,2))
  );
  if v_cost>0 then
    v_lines:=v_lines||jsonb_build_array(
      jsonb_build_object('account_code','5010','debit',v_cost,'credit',0),
      jsonb_build_object('account_code','1040','debit',0,'credit',v_cost)
    );
  end if;
  perform public.accounting_post_journal(
    v_entry_date,
    'Penjualan: '||new.nomor_nota,
    'sale',new.id,'sale','operating',v_lines
  );
  if new.status_pembayaran='lunas' and new.jumlah_dibayar>new.kembalian then
    v_paid:=least(round(new.total,2),round(new.jumlah_dibayar-new.kembalian,2));
    if v_paid>0 and not exists(select 1 from public.accounting_payments
      where kind='customer_receipt' and source_id=new.id) then
      perform public.accounting_create_payment(
        new.id,'customer_receipt',new.id,v_paid,new.metode_pembayaran,
        v_entry_date,'Penerimaan penjualan '||new.nomor_nota
      );
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_sale_posting on public.penjualan;
create constraint trigger accounting_sale_posting
  after insert or update of status on public.penjualan
  deferrable initially deferred for each row execute function public.accounting_post_sale();

create or replace function public.accounting_guard_posted_sale()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.journal_entries
      where source_type='sale' and source_id=old.id and entry_type='sale') then
      raise exception 'Penjualan yang sudah dijurnal tidak dapat dihapus.';
    end if;
    return old;
  end if;
  if exists(select 1 from public.journal_entries
    where source_type='sale' and source_id=old.id and entry_type='sale') then
    if (old.tanggal is distinct from new.tanggal
        or old.subtotal is distinct from new.subtotal
        or old.diskon is distinct from new.diskon
        or old.total is distinct from new.total
        or old.metode_pembayaran is distinct from new.metode_pembayaran
        or old.kembalian is distinct from new.kembalian) then
      raise exception 'Nilai dan tanggal penjualan yang sudah dijurnal bersifat immutable.';
    end if;
    if (old.status is distinct from new.status or old.status_pemenuhan is distinct from new.status_pemenuhan)
       and current_setting('retailpro.accounting_sale_mutation',true) is distinct from 'status' then
      raise exception 'Status penjualan harus diubah melalui fungsi alur yang tervalidasi.';
    end if;
    if (old.status_pembayaran is distinct from new.status_pembayaran
        or old.jumlah_dibayar is distinct from new.jumlah_dibayar)
       and current_setting('retailpro.accounting_sale_mutation',true) is distinct from 'payment' then
      raise exception 'Pembayaran penjualan harus dicatat melalui fungsi pembayaran.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_posted_sale_guard on public.penjualan;
create trigger accounting_posted_sale_guard before update or delete on public.penjualan
  for each row execute function public.accounting_guard_posted_sale();

create or replace function public.accounting_guard_posted_sale_detail()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if tg_op='INSERT' then
    if exists(select 1 from public.journal_entries
      where source_type='sale' and source_id=new.penjualan_id and entry_type='sale') then
      raise exception 'Detail penjualan yang sudah dijurnal tidak dapat diubah.';
    end if;
    return new;
  elsif tg_op='DELETE' then
    if exists(select 1 from public.journal_entries
      where source_type='sale' and source_id=old.penjualan_id and entry_type='sale') then
      raise exception 'Detail penjualan yang sudah dijurnal tidak dapat diubah.';
    end if;
    return old;
  end if;
  if exists(select 1 from public.journal_entries
      where source_type='sale' and source_id=old.penjualan_id and entry_type='sale')
     or exists(select 1 from public.journal_entries
      where source_type='sale' and source_id=new.penjualan_id and entry_type='sale') then
    raise exception 'Detail penjualan yang sudah dijurnal tidak dapat diubah.';
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_posted_sale_detail_guard on public.detail_penjualan;
create trigger accounting_posted_sale_detail_guard before insert or update or delete on public.detail_penjualan
  for each row execute function public.accounting_guard_posted_sale_detail();

create or replace function public.accounting_post_stock_adjustment()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_product public.barang%rowtype;
  v_value numeric(16,2);
  v_lines jsonb;
begin
  if new.tipe<>'penyesuaian' then return new; end if;
  select * into v_settings from public.accounting_settings where id=true;
  if new.created_at<v_settings.activated_at then return new; end if;
  select * into v_product from public.barang where id=new.barang_id;
  if not found then raise exception 'Barang penyesuaian stok tidak ditemukan.'; end if;
  if new.qty_masuk>0 then
    v_value:=round(new.qty_masuk*v_product.harga_beli,2);
    v_lines:=jsonb_build_array(
      jsonb_build_object('account_code','1040','debit',v_value,'credit',0),
      jsonb_build_object('account_code','4030','debit',0,'credit',v_value)
    );
  else
    v_value:=round(new.qty_keluar*v_product.harga_beli,2);
    v_lines:=jsonb_build_array(
      jsonb_build_object('account_code','6020','debit',v_value,'credit',0),
      jsonb_build_object('account_code','1040','debit',0,'credit',v_value)
    );
  end if;
  if v_value<=0 then
    raise exception 'Penyesuaian stok tidak dapat dijurnal karena nilai biaya persediaan nol. Periksa biaya barang terlebih dahulu.';
  end if;
  perform public.accounting_post_journal(
    (new.tanggal at time zone 'Asia/Jakarta')::date,
    'Penyesuaian stok: '||coalesce(new.catatan,new.referensi,new.id::text),
    'stock_movement',new.id,'adjustment','operating',v_lines
  );
  return new;
end;
$$;
drop trigger if exists accounting_stock_adjustment on public.mutasi_persediaan;
create trigger accounting_stock_adjustment after insert on public.mutasi_persediaan
  for each row execute function public.accounting_post_stock_adjustment();

create or replace function public.accounting_guard_stock()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('retailpro.stock_mutation',true),'')='' then
    if tg_op='INSERT' and coalesce(new.stok,0)<>0 then
      raise exception 'Stok awal harus melalui saldo pembukaan atau transaksi stok masuk.';
    elsif tg_op='UPDATE' and new.stok is distinct from old.stok then
      raise exception 'Perubahan stok harus menggunakan RPC stok agar jurnal dan mutasi tercatat.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_stock_guard on public.barang;
create trigger accounting_stock_guard before insert or update of stok on public.barang
  for each row execute function public.accounting_guard_stock();

create or replace function public.accounting_guard_inventory_cost()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if new.harga_beli is distinct from old.harga_beli and old.stok>0
     and exists(select 1 from public.accounting_settings
       where id=true and opening_entry_id is not null)
     and current_setting('retailpro.stock_mutation',true) is distinct from 'stock_in' then
    raise exception 'Biaya rata-rata stok tidak dapat diubah langsung setelah saldo awal dicatat. Gunakan transaksi stok masuk atau jurnal koreksi.';
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_inventory_cost_guard on public.barang;
create trigger accounting_inventory_cost_guard before update of harga_beli on public.barang
  for each row execute function public.accounting_guard_inventory_cost();

create or replace function public.accounting_guard_operational_delete()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_activation timestamptz;
begin
  select activated_at into v_activation from public.accounting_settings where id=true;
  if old.created_at>=v_activation then
    raise exception 'Transaksi sudah memiliki jejak pembukuan dan tidak dapat dihapus. Buat jurnal koreksi.';
  end if;
  return old;
end;
$$;
drop trigger if exists accounting_expense_no_delete on public.beban_operasional;
create trigger accounting_expense_no_delete before delete on public.beban_operasional
  for each row execute function public.accounting_guard_operational_delete();
drop trigger if exists accounting_purchase_no_delete on public.pembelian_stok;
create trigger accounting_purchase_no_delete before delete on public.pembelian_stok
  for each row execute function public.accounting_guard_operational_delete();

create or replace function public.set_accounting_opening_balances(p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_total_debit numeric(16,2):=0;
  v_total_credit numeric(16,2):=0;
  v_line jsonb;
  v_account public.chart_of_accounts%rowtype;
  v_entry_id uuid;
  v_count integer:=0;
begin
  perform public.accounting_assert_owner();
  select * into v_settings from public.accounting_settings where id=true for update;
  if v_settings.opening_entry_id is not null then raise exception 'Saldo awal sudah pernah dicatat.'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'Baris saldo awal tidak valid.'; end if;
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    select * into v_account from public.chart_of_accounts
    where code=trim(v_line->>'account_code') and account_type in ('asset','liability','equity');
    if not found then raise exception 'Saldo awal hanya boleh memakai akun neraca yang valid.'; end if;
    if coalesce((v_line->>'debit')::numeric,0)<0 or coalesce((v_line->>'credit')::numeric,0)<0 then
      raise exception 'Saldo awal tidak boleh negatif.';
    end if;
    v_total_debit:=v_total_debit+round(coalesce((v_line->>'debit')::numeric,0),2);
    v_total_credit:=v_total_credit+round(coalesce((v_line->>'credit')::numeric,0),2);
    v_count:=v_count+1;
  end loop;
  if v_count<2 or v_total_debit<=0 or abs(v_total_debit-v_total_credit)>0.005 then
    raise exception 'Saldo awal harus memiliki sekurangnya dua nilai dan debit harus sama dengan kredit. Tidak ada akun penyeimbang otomatis.';
  end if;
  v_entry_id:=public.accounting_post_journal(
    v_settings.cutover_date,'Saldo awal terverifikasi','opening',
    '00000000-0000-0000-0000-000000000001'::uuid,
    'opening','noncash',p_lines
  );
  update public.accounting_settings set opening_entry_id=v_entry_id where id=true;
  return jsonb_build_object('entry_id',v_entry_id,'entry_date',v_settings.cutover_date);
end;
$$;

create or replace function public.record_operational_expense(
  p_date date,
  p_category text,
  p_description text,
  p_amount numeric,
  p_paid_amount numeric,
  p_payment_method text,
  p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_id uuid;
  v_date timestamptz;
begin
  perform public.accounting_assert_owner();
  if p_date is null or p_date<(select cutover_date from public.accounting_settings where id=true)
     or p_date>(now() at time zone 'Asia/Jakarta')::date
     or nullif(trim(p_category),'') is null or length(p_category)>100
     or nullif(trim(p_description),'') is null or length(p_description)>200
     or p_amount is null or p_amount<=0 or p_paid_amount is null
     or p_paid_amount<0 or p_paid_amount>p_amount
     or p_payment_method is null or p_payment_method not in ('cash','transfer','qris','debit')
     or p_request_key is null then
    raise exception 'Tanggal, uraian, nominal, pembayaran, atau metode beban tidak valid.';
  end if;
  select id into v_id from public.beban_operasional where request_key=p_request_key;
  if found then
    if exists(select 1 from public.beban_operasional where id=v_id
      and (round(nominal,2)<>round(p_amount,2) or kategori<>trim(p_category)
        or keterangan<>trim(p_description) or paid_amount<>round(p_paid_amount,2)
        or payment_method is distinct from p_payment_method
        or (tanggal at time zone 'Asia/Jakarta')::date<>p_date)) then
      raise exception 'Kunci permintaan sudah digunakan untuk beban yang berbeda.';
    end if;
    return v_id;
  end if;
  v_date:=p_date::timestamp at time zone 'Asia/Jakarta';
  insert into public.beban_operasional(tanggal,kategori,keterangan,nominal,paid_amount,payment_method,request_key)
  values(v_date,trim(p_category),trim(p_description),round(p_amount,2),round(p_paid_amount,2),p_payment_method,p_request_key)
  returning id into v_id;
  return v_id;
end;
$$;

drop function if exists public.record_stock_in(uuid,numeric,numeric,text);
drop function if exists public.record_stock_in(uuid,numeric,numeric,text,numeric,text);
create or replace function public.record_stock_in(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_note text default null,
  p_paid_amount numeric default 0,
  p_payment_method text default 'cash',
  p_request_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_product public.barang%rowtype;
  v_new_stock numeric(14,3);
  v_new_cost numeric(14,2);
  v_purchase_cost numeric(14,2);
  v_total numeric(16,2);
  v_existing public.pembelian_stok%rowtype;
begin
  if auth.uid() is null or not public.is_owner() then raise exception 'Hanya Owner yang dapat mencatat stok.'; end if;
  if p_qty is null or p_qty<=0 or p_unit_cost is null or p_unit_cost<=0 or p_request_key is null
     or p_payment_method is null or p_payment_method not in ('cash','transfer','qris','debit') then
    raise exception 'Jumlah, harga beli, atau metode pembayaran tidak valid.';
  end if;
  v_purchase_cost:=round(p_unit_cost,2);
  v_total:=round(p_qty*v_purchase_cost,2);
  if p_paid_amount is null or p_paid_amount<0 or p_paid_amount>v_total then
    raise exception 'Pembayaran pembelian harus antara Rp0 dan total pembelian.';
  end if;
  select * into v_existing from public.pembelian_stok where request_key=p_request_key;
  if found then
    if v_existing.barang_id<>p_product_id or v_existing.jumlah<>p_qty
       or v_existing.harga_satuan<>round(p_unit_cost,2)
       or v_existing.paid_amount<>round(p_paid_amount,2)
       or v_existing.payment_method is distinct from p_payment_method
       or v_existing.catatan is distinct from nullif(trim(p_note),'') then
      raise exception 'Kunci permintaan sudah digunakan untuk pembelian yang berbeda.';
    end if;
    return jsonb_build_object('product_id',p_product_id,'qty_masuk',v_existing.jumlah,
      'stok_setelah',null,'biaya_rata_rata',null,'total',v_existing.total,'duplicate',true);
  end if;
  select * into v_product from public.barang where id=p_product_id and aktif=true for update;
  if not found then raise exception 'Barang tidak ditemukan atau tidak aktif.'; end if;
  v_new_cost:=case when v_product.stok+p_qty=0 then v_purchase_cost else round(
    ((v_product.stok*v_product.harga_beli)+(p_qty*v_purchase_cost))/(v_product.stok+p_qty),2
  ) end;
  perform set_config('retailpro.stock_mutation','stock_in',true);
  update public.barang set stok=stok+p_qty,harga_beli=v_new_cost where id=p_product_id returning stok into v_new_stock;
  insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
  values(p_product_id,'pembelian',null,p_qty,0,v_new_stock,coalesce(p_note,'Stok masuk'));
  insert into public.pembelian_stok(barang_id,jumlah,harga_satuan,total,catatan,paid_amount,payment_method,request_key)
  values(p_product_id,p_qty,v_purchase_cost,v_total,nullif(trim(p_note),''),round(p_paid_amount,2),p_payment_method,p_request_key);
  return jsonb_build_object('product_id',p_product_id,'qty_masuk',p_qty,
    'stok_setelah',v_new_stock,'biaya_rata_rata',v_new_cost,'total',v_total);
end;
$$;

create or replace function public.record_customer_payment(
  p_sale_id uuid,p_amount numeric,p_payment_method text,p_payment_date date,p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_paid numeric(16,2);
  v_existing public.accounting_payments%rowtype;
begin
  perform public.accounting_assert_owner();
  select * into v_existing from public.accounting_payments where request_key=p_request_key;
  if found then
    if v_existing.kind<>'customer_receipt' or v_existing.source_id<>p_sale_id
       or v_existing.amount<>round(coalesce(p_amount,0),2)
       or v_existing.payment_method<>p_payment_method
       or v_existing.payment_date<>p_payment_date then
      raise exception 'Kunci permintaan sudah digunakan untuk pembayaran berbeda.';
    end if;
    select * into v_sale from public.penjualan where id=p_sale_id;
    select coalesce(sum(amount),0) into v_paid from public.accounting_payments
      where kind='customer_receipt' and source_id=p_sale_id;
    return jsonb_build_object('sale_id',p_sale_id,'paid_amount',v_paid,
      'outstanding',greatest(v_sale.total-v_paid,0),'duplicate',true);
  end if;
  select * into v_sale from public.penjualan where id=p_sale_id for update;
  if not found or v_sale.status<>'selesai' then raise exception 'Penjualan selesai tidak ditemukan.'; end if;
  if not exists(select 1 from public.journal_entries
    where source_type='sale' and source_id=p_sale_id and entry_type='sale') then
    raise exception 'Pembayaran transaksi historis tidak dapat dicatat karena jurnal penjualannya tidak tersedia.';
  end if;
  select coalesce(sum(amount),0) into v_paid from public.accounting_payments
    where kind='customer_receipt' and source_id=p_sale_id;
  if p_amount is null or p_amount<=0 or p_amount>round(v_sale.total-v_paid,2) then
    raise exception 'Pembayaran harus lebih besar dari nol dan tidak melebihi sisa piutang.';
  end if;
  perform public.accounting_create_payment(p_request_key,'customer_receipt',p_sale_id,
    p_amount,p_payment_method,p_payment_date,'Pembayaran piutang penjualan '||v_sale.nomor_nota);
  v_paid:=v_paid+round(p_amount,2);
  perform set_config('retailpro.accounting_sale_mutation','payment',true);
  update public.penjualan set jumlah_dibayar=least(v_sale.total,v_paid),status_pembayaran=
    case when v_paid>=v_sale.total then 'lunas' else 'sebagian' end
    where id=p_sale_id;
  return jsonb_build_object('sale_id',p_sale_id,'paid_amount',v_paid,
    'outstanding',greatest(v_sale.total-v_paid,0));
end;
$$;

create or replace function public.record_supplier_or_expense_payment(
  p_kind text,p_source_id uuid,p_amount numeric,p_payment_method text,p_payment_date date,p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_total numeric(16,2);
  v_paid numeric(16,2);
  v_table text;
  v_payment_id uuid;
  v_existing public.accounting_payments%rowtype;
begin
  perform public.accounting_assert_owner();
  if p_kind is null or p_kind not in ('supplier_payment','expense_payment') then raise exception 'Jenis pembayaran tidak valid.'; end if;
  select * into v_existing from public.accounting_payments where request_key=p_request_key;
  if found then
    if v_existing.kind<>p_kind or v_existing.source_id<>p_source_id
       or v_existing.amount<>round(coalesce(p_amount,0),2)
       or v_existing.payment_method<>p_payment_method
       or v_existing.payment_date<>p_payment_date then
      raise exception 'Kunci permintaan sudah digunakan untuk pembayaran berbeda.';
    end if;
    return jsonb_build_object('payment_id',v_existing.id,'duplicate',true);
  end if;
  if p_kind='supplier_payment' then
    select round(total,2),round(paid_amount,2) into v_total,v_paid
      from public.pembelian_stok where id=p_source_id for update;
  else
    select round(nominal,2),round(paid_amount,2) into v_total,v_paid
      from public.beban_operasional where id=p_source_id for update;
  end if;
  if v_total is null then raise exception 'Utang transaksi tidak ditemukan.'; end if;
  if v_paid is null or not exists(
    select 1 from public.journal_entries
    where source_type=case when p_kind='supplier_payment' then 'purchase' else 'expense' end
      and source_id=p_source_id
      and entry_type=case when p_kind='supplier_payment' then 'purchase' else 'expense' end
  ) then
    raise exception 'Pembayaran transaksi historis tidak dapat dicatat karena saldo utangnya tidak terverifikasi.';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>v_total-v_paid then
    raise exception 'Pembayaran harus lebih besar dari nol dan tidak melebihi sisa utang.';
  end if;
  v_payment_id:=public.accounting_create_payment(p_request_key,p_kind,p_source_id,
    p_amount,p_payment_method,p_payment_date,'Pembayaran utang '||p_source_id::text);
  if p_kind='supplier_payment' then
    update public.pembelian_stok set paid_amount=paid_amount+round(p_amount,2) where id=p_source_id;
  else
    update public.beban_operasional set paid_amount=paid_amount+round(p_amount,2) where id=p_source_id;
  end if;
  return jsonb_build_object('payment_id',v_payment_id,'paid_amount',v_paid+p_amount,
    'outstanding',v_total-v_paid-p_amount);
end;
$$;

create or replace function public.record_customer_refund(
  p_sale_id uuid,p_amount numeric,p_payment_method text,p_payment_date date,p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_sale public.penjualan%rowtype;
  v_refundable numeric(16,2);
  v_refunded numeric(16,2);
  v_existing public.accounting_payments%rowtype;
begin
  perform public.accounting_assert_owner();
  select * into v_existing from public.accounting_payments where request_key=p_request_key;
  if found then
    if v_existing.kind<>'customer_refund' or v_existing.source_id<>p_sale_id
       or v_existing.amount<>round(coalesce(p_amount,0),2)
       or v_existing.payment_method<>p_payment_method
       or v_existing.payment_date<>p_payment_date then
      raise exception 'Kunci permintaan sudah digunakan untuk refund berbeda.';
    end if;
    return v_existing.id;
  end if;
  select * into v_sale from public.penjualan where id=p_sale_id and status='dibatalkan' for update;
  if not found then raise exception 'Penjualan dibatalkan tidak ditemukan.'; end if;
  if not exists(select 1 from public.journal_entries
    where source_type='sale' and source_id=p_sale_id and entry_type='sale_reversal') then
    raise exception 'Refund tidak dapat dicatat karena jurnal pembatalan penjualan tidak tersedia.';
  end if;
  select coalesce(sum(amount),0) into v_refundable from public.accounting_payments
    where kind='customer_receipt' and source_id=p_sale_id;
  select coalesce(sum(amount),0) into v_refunded from public.accounting_payments
    where kind='customer_refund' and source_id=p_sale_id;
  if p_amount is null or p_amount<=0 or p_amount>v_refundable-v_refunded then
    raise exception 'Refund melebihi nilai pembayaran pelanggan yang belum dikembalikan.';
  end if;
  return public.accounting_create_payment(p_request_key,'customer_refund',p_sale_id,
    p_amount,p_payment_method,p_payment_date,'Pengembalian pembayaran '||v_sale.nomor_nota);
end;
$$;

create or replace function public.post_accounting_manual_journal(
  p_date date,p_description text,p_cash_flow_activity text,p_lines jsonb,p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  perform public.accounting_assert_owner();
  if p_date>(now() at time zone 'Asia/Jakarta')::date then raise exception 'Tanggal jurnal tidak boleh di masa depan.'; end if;
  return public.accounting_post_journal(p_date,p_description,'manual',p_request_key,
    'manual',p_cash_flow_activity,p_lines);
end;
$$;

create or replace function public.record_account_reconciliation(
  p_account_code text,p_statement_date date,p_statement_balance numeric,p_note text,p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_id uuid;
  v_account public.chart_of_accounts%rowtype;
  v_cutover date;
  v_existing public.account_reconciliations%rowtype;
begin
  perform public.accounting_assert_owner();
  select cutover_date into v_cutover from public.accounting_settings where id=true;
  select * into v_account from public.chart_of_accounts
    where code=p_account_code and is_cash_equivalent and is_active;
  if not found then raise exception 'Rekonsiliasi hanya tersedia untuk akun kas/bank aktif.'; end if;
  if p_statement_date<v_cutover or p_statement_date>(now() at time zone 'Asia/Jakarta')::date
     or p_statement_balance is null or p_statement_balance<0
     or nullif(trim(p_note),'') is null or p_request_key is null then
    raise exception 'Tanggal, saldo, atau catatan rekonsiliasi tidak valid.';
  end if;
  select * into v_existing from public.account_reconciliations where request_key=p_request_key;
  if found then
    if v_existing.account_id<>v_account.id or v_existing.statement_date<>p_statement_date
       or v_existing.statement_balance<>round(p_statement_balance,2)
       or v_existing.note<>trim(p_note) then
      raise exception 'Kunci rekonsiliasi sudah digunakan untuk data berbeda.';
    end if;
    return v_existing.id;
  end if;
  insert into public.account_reconciliations(request_key,account_id,statement_date,statement_balance,note,created_by)
  values(p_request_key,v_account.id,p_statement_date,round(p_statement_balance,2),trim(p_note),auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_delivery_status(
  p_sale_id uuid,p_status text
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
  if auth.uid() is null or not public.is_owner() then raise exception 'Hanya Owner yang dapat mengubah status pesanan.'; end if;
  if p_status not in ('diproses','dalam_pengiriman','selesai','gagal_dikirim','dibatalkan') then
    raise exception 'Status pengiriman tidak valid.';
  end if;
  select * into v_sale from public.penjualan
    where id=p_sale_id and recipient_name is not null for update;
  if not found then raise exception 'Pesanan antar tidak ditemukan.'; end if;
  perform set_config('retailpro.accounting_sale_mutation','status',true);
  if v_sale.status='menunggu' and p_status='diproses' then
    update public.penjualan set status='diproses',status_pemenuhan='diproses' where id=p_sale_id;
  elsif v_sale.status='diproses' and p_status='dalam_pengiriman' then
    update public.penjualan set status='dalam_pengiriman',status_pemenuhan='dalam_pengiriman',
      tanggal_pengiriman=coalesce(tanggal_pengiriman,now()) where id=p_sale_id;
  elsif v_sale.status='dalam_pengiriman' and p_status='selesai' then
    update public.penjualan set status='selesai',status_pemenuhan='selesai'
      where id=p_sale_id;
  elsif (v_sale.status='menunggu' and p_status='dibatalkan')
     or (v_sale.status='dalam_pengiriman' and p_status='gagal_dikirim') then
    perform set_config('retailpro.stock_mutation','delivery_release',true);
    for v_item in select barang_id,jumlah from public.detail_penjualan
      where penjualan_id=p_sale_id order by barang_id
    loop
      update public.barang set stok=stok+v_item.jumlah where id=v_item.barang_id returning stok into v_new_stock;
      insert into public.mutasi_persediaan(barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan)
      values(v_item.barang_id,'pembatalan',v_sale.nomor_nota,v_item.jumlah,0,v_new_stock,
        case when p_status='gagal_dikirim' then 'Pengiriman gagal; stok dikembalikan'
          else 'Pesanan ditolak Owner; stok dikembalikan' end);
    end loop;
    update public.penjualan set status=p_status,status_pemenuhan=p_status where id=p_sale_id;
  else
    raise exception 'Urutan perubahan status pesanan tidak valid.';
  end if;
  return jsonb_build_object('id',p_sale_id,'status',p_status);
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
  v_activation timestamptz;
begin
  if auth.uid() is null or not public.is_owner() then
    raise exception 'Hanya Owner yang dapat membatalkan transaksi.';
  end if;
  select * into v_sale from public.penjualan where id=p_sale_id for update;
  if not found then raise exception 'Transaksi tidak ditemukan.'; end if;
  if v_sale.recipient_name is not null then
    raise exception 'Pesanan antar hanya dapat dibatalkan melalui alur status pengiriman.';
  end if;
  if v_sale.status<>'selesai' or v_sale.status_pembayaran<>'lunas' then
    raise exception 'Hanya transaksi kasir yang selesai dan lunas yang dapat dibatalkan.';
  end if;
  select activated_at into v_activation from public.accounting_settings where id=true;
  if v_sale.created_at<v_activation then
    raise exception 'Transaksi sebelum cutover tidak dapat dibatalkan karena tidak memiliki jurnal yang dapat dibalik.';
  end if;

  perform set_config('retailpro.stock_mutation','cancel',true);
  for v_item in select * from public.detail_penjualan
    where penjualan_id=p_sale_id order by barang_id
  loop
    update public.barang set stok=stok+v_item.jumlah
      where id=v_item.barang_id returning stok into v_new_stock;
    insert into public.mutasi_persediaan(
      barang_id,tipe,referensi,qty_masuk,qty_keluar,stok_setelah,catatan
    ) values(
      v_item.barang_id,'pembatalan',v_sale.nomor_nota,v_item.jumlah,0,v_new_stock,
      'Pembatalan transaksi penjualan'
    );
  end loop;
  perform set_config('retailpro.accounting_sale_mutation','status',true);
  update public.penjualan set status='dibatalkan' where id=p_sale_id;
  return jsonb_build_object(
    'id',p_sale_id,'status','dibatalkan','nomor_nota',v_sale.nomor_nota
  );
end;
$$;

revoke all on function public.accounting_assert_owner() from public,anon,authenticated;
revoke all on function public.accounting_post_journal(date,text,text,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.accounting_create_payment(uuid,text,uuid,numeric,text,date,text) from public,anon,authenticated;
revoke all on function public.set_accounting_opening_balances(jsonb) from public,anon;
revoke all on function public.record_operational_expense(date,text,text,numeric,numeric,text,uuid) from public,anon;
revoke all on function public.record_customer_payment(uuid,numeric,text,date,uuid) from public,anon;
revoke all on function public.record_supplier_or_expense_payment(text,uuid,numeric,text,date,uuid) from public,anon;
revoke all on function public.record_customer_refund(uuid,numeric,text,date,uuid) from public,anon;
revoke all on function public.post_accounting_manual_journal(date,text,text,jsonb,uuid) from public,anon;
revoke all on function public.record_account_reconciliation(text,date,numeric,text,uuid) from public,anon;
revoke all on function public.record_stock_in(uuid,numeric,numeric,text,numeric,text,uuid) from public,anon;
revoke all on function public.update_delivery_status(uuid,text) from public,anon;
revoke all on function public.cancel_sale(uuid) from public,anon;
grant execute on function public.set_accounting_opening_balances(jsonb) to authenticated;
grant execute on function public.record_operational_expense(date,text,text,numeric,numeric,text,uuid) to authenticated;
grant execute on function public.record_customer_payment(uuid,numeric,text,date,uuid) to authenticated;
grant execute on function public.record_supplier_or_expense_payment(text,uuid,numeric,text,date,uuid) to authenticated;
grant execute on function public.record_customer_refund(uuid,numeric,text,date,uuid) to authenticated;
grant execute on function public.post_accounting_manual_journal(date,text,text,jsonb,uuid) to authenticated;
grant execute on function public.record_account_reconciliation(text,date,numeric,text,uuid) to authenticated;
grant execute on function public.record_stock_in(uuid,numeric,numeric,text,numeric,text,uuid) to authenticated;
grant execute on function public.update_delivery_status(uuid,text) to authenticated;
grant execute on function public.cancel_sale(uuid) to authenticated;

commit;
notify pgrst,'reload schema';
