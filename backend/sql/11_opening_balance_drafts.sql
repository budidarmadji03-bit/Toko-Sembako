-- Durable Owner-only opening-balance drafts and auditable posting metadata.
begin;

create table if not exists public.accounting_opening_drafts (
  id boolean primary key default true check (id),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  supporting_source text,
  reference_number text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  posted_entry_id uuid unique references public.journal_entries(id) on delete restrict,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz
);

alter table public.accounting_opening_drafts enable row level security;
drop policy if exists "Owner reads opening balance draft" on public.accounting_opening_drafts;
create policy "Owner reads opening balance draft" on public.accounting_opening_drafts
  for select to authenticated using (public.is_owner());
revoke all on public.accounting_opening_drafts from public, anon, authenticated;
grant select on public.accounting_opening_drafts to authenticated;

create or replace function public.save_accounting_opening_draft(
  p_lines jsonb,
  p_supporting_source text,
  p_reference_number text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_line jsonb;
  v_account public.chart_of_accounts%rowtype;
  v_seen text[] := '{}';
  v_debit numeric;
  v_credit numeric;
begin
  perform public.accounting_assert_owner();
  select * into v_settings from public.accounting_settings where id=true for update;
  if v_settings.opening_entry_id is not null then
    raise exception 'Saldo awal sudah diposting; draft tidak dapat diubah.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Baris draft saldo awal tidak valid.';
  end if;
  if length(coalesce(p_supporting_source,'')) > 500 or length(coalesce(p_reference_number,'')) > 150 then
    raise exception 'Keterangan sumber maksimal 500 karakter dan referensi maksimal 150 karakter.';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    select * into v_account from public.chart_of_accounts
    where code=trim(v_line->>'account_code') and is_active
      and account_type in ('asset','liability','equity');
    if not found then raise exception 'Draft memuat akun neraca yang tidak valid atau tidak aktif.'; end if;
    if v_account.code = any(v_seen) then raise exception 'Akun tidak boleh muncul lebih dari sekali dalam draft.'; end if;
    v_seen := array_append(v_seen,v_account.code);
    begin
      v_debit := nullif(v_line->>'debit','')::numeric;
      v_credit := nullif(v_line->>'credit','')::numeric;
    exception when invalid_text_representation then
      raise exception 'Nominal draft harus berupa angka.';
    end;
    if (v_line ? 'debit' and jsonb_typeof(v_line->'debit') not in ('string','number','null'))
      or (v_line ? 'credit' and jsonb_typeof(v_line->'credit') not in ('string','number','null')) then
      raise exception 'Format nominal draft tidak valid.';
    end if;
    if coalesce(v_debit,0)<0 or coalesce(v_credit,0)<0
      or (coalesce(v_debit,0)>0 and coalesce(v_credit,0)>0) then
      raise exception 'Saldo draft tidak boleh negatif atau sekaligus debit dan kredit.';
    end if;
  end loop;
  insert into public.accounting_opening_drafts(
    id,lines,supporting_source,reference_number,updated_by,updated_at
  ) values (
    true,p_lines,nullif(trim(p_supporting_source),''),nullif(trim(p_reference_number),''),
    auth.uid(),now()
  )
  on conflict(id) do update set
    lines=excluded.lines,
    supporting_source=excluded.supporting_source,
    reference_number=excluded.reference_number,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at;
  return jsonb_build_object('saved',true,'updated_at',now());
end;
$$;

create or replace function public.post_accounting_opening_balances(
  p_lines jsonb,
  p_supporting_source text,
  p_reference_number text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_settings public.accounting_settings%rowtype;
  v_line jsonb;
  v_account public.chart_of_accounts%rowtype;
  v_seen text[] := '{}';
  v_post_lines jsonb := '[]'::jsonb;
  v_debit numeric;
  v_credit numeric;
  v_total_debit numeric(16,2) := 0;
  v_total_credit numeric(16,2) := 0;
  v_required_count integer;
  v_entry_id uuid;
  v_post_result jsonb;
begin
  perform public.accounting_assert_owner();
  select * into v_settings from public.accounting_settings where id=true for update;
  if v_settings.opening_entry_id is not null then raise exception 'Saldo awal sudah pernah diposting.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'Baris saldo awal tidak valid.'; end if;
  if nullif(trim(p_supporting_source),'') is null then
    raise exception 'Sumber saldo atau keterangan pendukung wajib diisi.';
  end if;
  if length(p_supporting_source)>500 or length(coalesce(p_reference_number,''))>150 then
    raise exception 'Keterangan sumber maksimal 500 karakter dan referensi maksimal 150 karakter.';
  end if;
  select count(*) into v_required_count from public.chart_of_accounts
    where is_active and account_type in ('asset','liability','equity');
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    select * into v_account from public.chart_of_accounts
    where code=trim(v_line->>'account_code') and is_active
      and account_type in ('asset','liability','equity');
    if not found then raise exception 'Saldo awal hanya boleh memakai akun neraca yang valid dan aktif.'; end if;
    if v_account.code = any(v_seen) then raise exception 'Akun tidak boleh muncul lebih dari sekali dalam saldo awal.'; end if;
    v_seen := array_append(v_seen,v_account.code);
    begin
      v_debit := coalesce(nullif(v_line->>'debit','')::numeric,0);
      v_credit := coalesce(nullif(v_line->>'credit','')::numeric,0);
    exception when invalid_text_representation then
      raise exception 'Setiap akun harus memiliki nominal yang valid; isi 0 jika saldo memang tidak ada.';
    end;
    if not (v_line ? 'debit') or not (v_line ? 'credit')
      or jsonb_typeof(v_line->'debit') not in ('string','number')
      or jsonb_typeof(v_line->'credit') not in ('string','number') then
      raise exception 'Setiap akun neraca harus memiliki saldo debit atau kredit yang dinyatakan; isi 0 jika memang tidak ada.';
    end if;
    if v_debit<0 or v_credit<0 or (v_debit>0 and v_credit>0) then
      raise exception 'Saldo akun tidak boleh negatif atau sekaligus debit dan kredit.';
    end if;
    if v_debit>0 and v_account.normal_balance<>'debit' then
      raise exception using message = format('Akun %s bersaldo normal kredit; periksa posisi saldonya.',v_account.code);
    end if;
    if v_credit>0 and v_account.normal_balance<>'credit' then
      raise exception using message = format('Akun %s bersaldo normal debit; periksa posisi saldonya.',v_account.code);
    end if;
    v_total_debit := v_total_debit + round(v_debit,2);
    v_total_credit := v_total_credit + round(v_credit,2);
    if v_debit>0 or v_credit>0 then
      v_post_lines := v_post_lines || jsonb_build_array(jsonb_build_object(
        'account_code',v_account.code,'debit',round(v_debit,2),'credit',round(v_credit,2)
      ));
    end if;
  end loop;
  if cardinality(v_seen)<>v_required_count then
    raise exception 'Lengkapi semua akun neraca aktif. Untuk akun tanpa saldo, isi 0 secara eksplisit.';
  end if;
  if jsonb_array_length(v_post_lines)<2 or v_total_debit<=0
    or abs(v_total_debit-v_total_credit)>0.005 then
    raise exception 'Saldo awal belum seimbang. Debit %, kredit %. Tidak ada akun penyeimbang otomatis.',
      v_total_debit,v_total_credit;
  end if;

  insert into public.accounting_opening_drafts(
    id,lines,supporting_source,reference_number,updated_by,updated_at
  ) values (true,p_lines,trim(p_supporting_source),nullif(trim(p_reference_number),''),auth.uid(),now())
  on conflict(id) do update set
    lines=excluded.lines,
    supporting_source=excluded.supporting_source,
    reference_number=excluded.reference_number,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at;

  v_post_result := public.set_accounting_opening_balances(v_post_lines);
  v_entry_id := (v_post_result->>'entry_id')::uuid;
  update public.accounting_opening_drafts set
    posted_entry_id=v_entry_id,posted_by=auth.uid(),posted_at=now()
  where id=true;
  return jsonb_build_object(
    'entry_id',v_entry_id,'entry_date',v_settings.cutover_date,
    'total_debit',v_total_debit,'total_credit',v_total_credit,
    'reference_number',nullif(trim(p_reference_number),'')
  );
end;
$$;

revoke all on function public.set_accounting_opening_balances(jsonb) from public,anon,authenticated;
revoke all on function public.save_accounting_opening_draft(jsonb,text,text) from public,anon,authenticated;
revoke all on function public.post_accounting_opening_balances(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_accounting_opening_draft(jsonb,text,text) to authenticated;
grant execute on function public.post_accounting_opening_balances(jsonb,text,text) to authenticated;

commit;
