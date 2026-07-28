-- 학년도별 학급 및 운영 기간 관리

alter table public.classes
  add column if not exists academic_year integer
    not null default extract(year from current_date)::integer
    check (academic_year between 2000 and 2100),
  add column if not exists archived_at timestamptz;

alter table public.seasons
  add column if not exists archived_at timestamptz;

alter table public.classes
  drop constraint if exists classes_owner_id_grade_class_number_key;

create unique index if not exists unique_class_per_academic_year
on public.classes(owner_id, academic_year, grade, class_number);

create index if not exists classes_owner_year_idx
on public.classes(owner_id, academic_year desc, archived_at);

create index if not exists seasons_class_archived_idx
on public.seasons(class_id, archived_at, start_date desc);

create or replace function public.create_academic_class_with_season(
  p_name text,
  p_academic_year integer,
  p_grade integer,
  p_class_number integer,
  p_season_name text,
  p_start_date date,
  p_end_date date default null,
  p_copy_students_from_class_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_class_id uuid;
begin
  if v_owner is null then raise exception '로그인이 필요합니다.'; end if;
  if p_academic_year not between 2000 and 2100 then raise exception '학년도가 올바르지 않습니다.'; end if;

  if p_copy_students_from_class_id is not null and not exists (
    select 1 from public.classes
    where id = p_copy_students_from_class_id and owner_id = v_owner
  ) then
    raise exception '복사할 학급을 찾을 수 없습니다.';
  end if;

  insert into public.classes(owner_id, name, academic_year, grade, class_number)
  values(v_owner, trim(p_name), p_academic_year, p_grade, p_class_number)
  returning id into v_class_id;

  insert into public.seasons(owner_id, class_id, name, start_date, end_date, is_active)
  values(v_owner, v_class_id, trim(p_season_name), p_start_date, p_end_date, true);

  if p_copy_students_from_class_id is not null then
    insert into public.students(owner_id, class_id, student_number, name, total_mp, active)
    select v_owner, v_class_id, student_number, name, 0, true
    from public.students
    where owner_id = v_owner
      and class_id = p_copy_students_from_class_id
      and active
    order by student_number;
  end if;

  return v_class_id;
end;
$$;

create or replace function public.update_class_metadata(
  p_class_id uuid,
  p_name text,
  p_academic_year integer,
  p_grade integer,
  p_class_number integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.classes
  set name = trim(p_name),
      academic_year = p_academic_year,
      grade = p_grade,
      class_number = p_class_number
  where id = p_class_id and owner_id = auth.uid();

  if not found then raise exception '학급을 찾을 수 없습니다.'; end if;
end;
$$;

create or replace function public.set_class_archived(
  p_class_id uuid,
  p_archived boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_archived and exists (
    select 1 from public.class_sessions
    where owner_id = auth.uid() and class_id = p_class_id and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 학급을 보관해 주세요.';
  end if;

  update public.classes
  set archived_at = case when p_archived then now() else null end
  where id = p_class_id and owner_id = auth.uid();

  if not found then raise exception '학급을 찾을 수 없습니다.'; end if;
end;
$$;

create or replace function public.delete_class_permanently(
  p_class_id uuid,
  p_confirm_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class public.classes;
  v_summary jsonb;
begin
  select * into v_class from public.classes
  where id = p_class_id and owner_id = auth.uid();

  if v_class.id is null then raise exception '학급을 찾을 수 없습니다.'; end if;
  if trim(p_confirm_name) <> v_class.name then raise exception '학급 이름이 일치하지 않습니다.'; end if;
  if exists (
    select 1 from public.class_sessions
    where owner_id = auth.uid() and class_id = p_class_id and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 학급을 삭제해 주세요.';
  end if;

  select jsonb_build_object(
    'students', (select count(*) from public.students where class_id = p_class_id),
    'seasons', (select count(*) from public.seasons where class_id = p_class_id),
    'transactions', (select count(*) from public.mp_transactions where class_id = p_class_id)
  ) into v_summary;

  delete from public.classes where id = p_class_id and owner_id = auth.uid();
  return v_summary;
end;
$$;

create or replace function public.update_season_metadata(
  p_season_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.seasons
  set name = trim(p_name), start_date = p_start_date, end_date = p_end_date
  where id = p_season_id and owner_id = auth.uid();

  if not found then raise exception '운영 기간을 찾을 수 없습니다.'; end if;
end;
$$;

create or replace function public.set_season_archived(
  p_season_id uuid,
  p_archived boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_next_id uuid;
begin
  select * into v_season from public.seasons
  where id = p_season_id and owner_id = auth.uid();

  if v_season.id is null then raise exception '운영 기간을 찾을 수 없습니다.'; end if;
  if p_archived and exists (
    select 1 from public.class_sessions
    where owner_id = auth.uid() and season_id = p_season_id and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 운영 기간을 보관해 주세요.';
  end if;

  update public.seasons
  set archived_at = case when p_archived then now() else null end,
      is_active = case when p_archived then false else is_active end
  where id = p_season_id and owner_id = auth.uid();

  if p_archived and v_season.is_active then
    select id into v_next_id
    from public.seasons
    where owner_id = auth.uid()
      and class_id = v_season.class_id
      and id <> p_season_id
      and archived_at is null
    order by start_date desc
    limit 1;

    if v_next_id is not null then
      update public.seasons set is_active = true where id = v_next_id;
    end if;
  end if;
end;
$$;

create or replace function public.delete_season_permanently(
  p_season_id uuid,
  p_confirm_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_summary jsonb;
  v_next_id uuid;
begin
  select * into v_season from public.seasons
  where id = p_season_id and owner_id = auth.uid();

  if v_season.id is null then raise exception '운영 기간을 찾을 수 없습니다.'; end if;
  if trim(p_confirm_name) <> v_season.name then raise exception '운영 기간 이름이 일치하지 않습니다.'; end if;
  if exists (
    select 1 from public.class_sessions
    where owner_id = auth.uid() and season_id = p_season_id and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 운영 기간을 삭제해 주세요.';
  end if;

  select jsonb_build_object(
    'sessions', (select count(*) from public.class_sessions where season_id = p_season_id),
    'assignments', (select count(*) from public.assignments where season_id = p_season_id),
    'transactions', (
      select count(*) from public.mp_transactions
      where session_id in (
        select id from public.class_sessions where season_id = p_season_id
      )
    )
  ) into v_summary;

  delete from public.mp_transactions
  where owner_id = auth.uid()
    and session_id in (
      select id from public.class_sessions
      where season_id = p_season_id and owner_id = auth.uid()
    );

  delete from public.seasons where id = p_season_id and owner_id = auth.uid();

  if v_season.is_active then
    select id into v_next_id
    from public.seasons
    where owner_id = auth.uid()
      and class_id = v_season.class_id
      and archived_at is null
    order by start_date desc
    limit 1;
    if v_next_id is not null then
      update public.seasons set is_active = true where id = v_next_id;
    end if;
  end if;

  return v_summary;
end;
$$;

revoke execute on function public.create_academic_class_with_season(text,integer,integer,integer,text,date,date,uuid) from public, anon;
revoke execute on function public.update_class_metadata(uuid,text,integer,integer,integer) from public, anon;
revoke execute on function public.set_class_archived(uuid,boolean) from public, anon;
revoke execute on function public.delete_class_permanently(uuid,text) from public, anon;
revoke execute on function public.update_season_metadata(uuid,text,date,date) from public, anon;
revoke execute on function public.set_season_archived(uuid,boolean) from public, anon;
revoke execute on function public.delete_season_permanently(uuid,text) from public, anon;

grant execute on function public.create_academic_class_with_season(text,integer,integer,integer,text,date,date,uuid) to authenticated;
grant execute on function public.update_class_metadata(uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.set_class_archived(uuid,boolean) to authenticated;
grant execute on function public.delete_class_permanently(uuid,text) to authenticated;
grant execute on function public.update_season_metadata(uuid,text,date,date) to authenticated;
grant execute on function public.set_season_archived(uuid,boolean) to authenticated;
grant execute on function public.delete_season_permanently(uuid,text) to authenticated;
