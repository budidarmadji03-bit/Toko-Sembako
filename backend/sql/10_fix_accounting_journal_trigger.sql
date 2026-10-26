-- Fix deferred journal validation for journal_entries and journal_lines.
-- The previous trigger used CASE with fields that do not exist on both row types.
-- No existing transaction or journal data is modified by this migration.
begin;

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
  if tg_table_name='journal_entries' then
    v_entry_id:=new.id;
  elsif tg_table_name='journal_lines' then
    v_entry_id:=new.journal_entry_id;
  else
    raise exception 'Trigger jurnal dipasang pada tabel yang tidak didukung: %.',tg_table_name;
  end if;

  select count(*),coalesce(sum(debit),0),coalesce(sum(credit),0)
    into v_count,v_debit,v_credit
  from public.journal_lines
  where journal_entry_id=v_entry_id;

  if v_count<2 or v_debit=0 or abs(v_debit-v_credit)>0.005 then
    raise exception 'Jurnal % tidak seimbang: debit %, kredit %.',v_entry_id,v_debit,v_credit;
  end if;
  return null;
end;
$$;

commit;
notify pgrst, 'reload schema';
