-- 수학 클래스 RPG 1차 개발용 Supabase 스키마
-- Supabase SQL Editor에서 전체 실행하세요.

create extension if not exists pgcrypto;

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  grade integer not null default 1 check (grade between 1 and 3),
  class_number integer not null check (class_number between 1 and 20),
  created_at timestamptz not null default now(),
  unique(owner_id, grade, class_number)
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_number integer not null check (student_number between 1 and 99),
  name text not null,
  total_mp integer not null default 0 check (total_mp >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(class_id, student_number)
);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists one_active_season_per_class
on public.seasons(class_id)
where is_active;

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  group_no integer check (group_no between 1 and 6),
  seat_index integer check (seat_index between 1 and 4),
  role text not null default 'beginner'
    check (role in ('beginner','disciple','mentor','senior_mentor','guardian')),
  role_started_mp integer not null default 0 check (role_started_mp >= 0),
  mentor_student_id uuid references public.students(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(season_id, student_id)
);

create unique index if not exists unique_seat_in_season
on public.assignments(season_id, group_no, seat_index)
where group_no is not null and seat_index is not null;

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  session_date date not null default current_date,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active','ended')),
  fever_started_at timestamptz,
  fever_ended_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists one_active_session_per_class
on public.class_sessions(class_id)
where status = 'active';

create table if not exists public.mp_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  session_id uuid references public.class_sessions(id) on delete set null,
  amount integer not null,
  base_amount integer not null,
  multiplier integer not null default 1 check (multiplier in (1,2,4,8)),
  reason text not null,
  skill_key text,
  group_no integer,
  reversal_of uuid references public.mp_transactions(id) on delete set null,
  is_reversed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists mp_transactions_student_idx
on public.mp_transactions(student_id, created_at desc);

create table if not exists public.skill_usages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  skill_key text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists skill_usage_session_idx
on public.skill_usages(session_id, student_id, skill_key);

create table if not exists public.promotion_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  from_role text not null,
  to_role text not null,
  threshold_mp integer not null,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assignments_set_updated_at on public.assignments;
create trigger assignments_set_updated_at
before update on public.assignments
for each row execute function public.set_updated_at();

-- 학생/시즌 생성 시 배치 레코드 자동 생성
create or replace function public.create_assignments_for_student()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.assignments(owner_id, season_id, student_id, role_started_mp)
  select new.owner_id, s.id, new.id, new.total_mp
  from public.seasons s
  where s.class_id = new.class_id
  on conflict (season_id, student_id) do nothing;
  return new;
end;
$$;

drop trigger if exists students_create_assignments on public.students;
create trigger students_create_assignments
after insert on public.students
for each row execute function public.create_assignments_for_student();

create or replace function public.create_assignments_for_season()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.assignments(owner_id, season_id, student_id, role_started_mp)
  select new.owner_id, new.id, st.id, st.total_mp
  from public.students st
  where st.class_id = new.class_id and st.active
  on conflict (season_id, student_id) do nothing;
  return new;
end;
$$;

drop trigger if exists seasons_create_assignments on public.seasons;
create trigger seasons_create_assignments
after insert on public.seasons
for each row execute function public.create_assignments_for_season();

-- RLS
alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.seasons enable row level security;
alter table public.assignments enable row level security;
alter table public.class_sessions enable row level security;
alter table public.mp_transactions enable row level security;
alter table public.skill_usages enable row level security;
alter table public.promotion_events enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['classes','students','seasons','assignments','class_sessions','mp_transactions','skill_usages','promotion_events']
  loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- 학급 + 첫 운영 기간 생성
create or replace function public.create_class_with_season(
  p_name text,
  p_grade integer,
  p_class_number integer,
  p_season_name text,
  p_start_date date,
  p_end_date date default null
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

  insert into public.classes(owner_id, name, grade, class_number)
  values(v_owner, p_name, p_grade, p_class_number)
  returning id into v_class_id;

  insert into public.seasons(owner_id, class_id, name, start_date, end_date, is_active)
  values(v_owner, v_class_id, p_season_name, p_start_date, p_end_date, true);

  return v_class_id;
end;
$$;

-- 학생 명단 일괄 등록: [{"student_number":1,"name":"김수학"}, ...]
create or replace function public.bulk_add_students(p_class_id uuid, p_students jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer := 0;
  item jsonb;
begin
  if not exists(select 1 from public.classes where id = p_class_id and owner_id = v_owner) then
    raise exception '학급 접근 권한이 없습니다.';
  end if;

  for item in select * from jsonb_array_elements(p_students)
  loop
    insert into public.students(owner_id, class_id, student_number, name)
    values(v_owner, p_class_id, (item->>'student_number')::integer, trim(item->>'name'))
    on conflict (class_id, student_number)
    do update set name = excluded.name, active = true;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 자리 배치 일괄 저장
-- p_plan: [{"student_id":"...","group_no":1,"seat_index":1}, ...]
create or replace function public.save_seating_plan(p_season_id uuid, p_plan jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  item jsonb;
  v_count integer := 0;
begin
  if not exists(select 1 from public.seasons where id = p_season_id and owner_id = v_owner) then
    raise exception '운영 기간 접근 권한이 없습니다.';
  end if;

  update public.assignments
  set group_no = null, seat_index = null
  where season_id = p_season_id and owner_id = v_owner;

  for item in select * from jsonb_array_elements(p_plan)
  loop
    update public.assignments
    set
      group_no = case when item->>'group_no' is null then null else (item->>'group_no')::integer end,
      seat_index = case when item->>'seat_index' is null then null else (item->>'seat_index')::integer end
    where season_id = p_season_id
      and student_id = (item->>'student_id')::uuid
      and owner_id = v_owner;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 역할/멘토 관계 변경
create or replace function public.update_assignment_role(
  p_assignment_id uuid,
  p_role text,
  p_mentor_student_id uuid default null,
  p_reset_role_progress boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_student_id uuid;
  v_total_mp integer;
begin
  if p_role not in ('beginner','disciple','mentor','senior_mentor','guardian') then
    raise exception '올바르지 않은 역할입니다.';
  end if;

  select a.student_id, s.total_mp
  into v_student_id, v_total_mp
  from public.assignments a
  join public.students s on s.id = a.student_id
  where a.id = p_assignment_id and a.owner_id = v_owner;

  if v_student_id is null then raise exception '배치 정보를 찾을 수 없습니다.'; end if;

  update public.assignments
  set role = p_role,
      mentor_student_id = case when p_role in ('beginner','disciple') then p_mentor_student_id else null end,
      role_started_mp = case when p_reset_role_progress then v_total_mp else role_started_mp end
  where id = p_assignment_id and owner_id = v_owner;
end;
$$;

-- 수업 시작/종료
create or replace function public.start_class_session(p_class_id uuid, p_season_id uuid)
returns public.class_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_session public.class_sessions;
begin
  select * into v_session
  from public.class_sessions
  where class_id = p_class_id and owner_id = v_owner and status = 'active'
  limit 1;

  if v_session.id is not null then return v_session; end if;

  insert into public.class_sessions(owner_id, class_id, season_id)
  values(v_owner, p_class_id, p_season_id)
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.end_class_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.class_sessions
  set status = 'ended', ended_at = now(),
      fever_ended_at = coalesce(fever_ended_at, case when fever_started_at is not null then now() end)
  where id = p_session_id and owner_id = auth.uid();
end;
$$;

-- 스킬 사용 기록
create or replace function public.record_skill_usage(
  p_student_id uuid,
  p_session_id uuid,
  p_skill_key text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_class_id uuid;
  v_usage_id uuid;
begin
  select class_id into v_class_id
  from public.students
  where id = p_student_id and owner_id = v_owner;

  if v_class_id is null then raise exception '학생을 찾을 수 없습니다.'; end if;

  if p_skill_key in ('beginner_luck','retry') and exists(
    select 1 from public.skill_usages
    where owner_id = v_owner and student_id = p_student_id
      and session_id = p_session_id and skill_key = p_skill_key
  ) then
    raise exception '이 스킬은 이번 수업에서 이미 사용했습니다.';
  end if;

  insert into public.skill_usages(owner_id, class_id, student_id, session_id, skill_key, note)
  values(v_owner, v_class_id, p_student_id, p_session_id, p_skill_key, p_note)
  returning id into v_usage_id;

  return v_usage_id;
end;
$$;

-- 피버 타임: 같은 학급에서 주 1회
create or replace function public.start_fever_time(p_session_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_class_id uuid;
  v_started timestamptz := now();
begin
  select class_id into v_class_id
  from public.class_sessions
  where id = p_session_id and owner_id = v_owner and status = 'active';

  if v_class_id is null then raise exception '진행 중인 수업이 아닙니다.'; end if;

  if exists(
    select 1 from public.class_sessions
    where owner_id = v_owner and class_id = v_class_id
      and fever_started_at >= date_trunc('week', now())
      and fever_started_at < date_trunc('week', now()) + interval '7 days'
  ) then
    raise exception '이번 주 피버 타임을 이미 사용했습니다.';
  end if;

  update public.class_sessions
  set fever_started_at = v_started, fever_ended_at = null
  where id = p_session_id and owner_id = v_owner;

  return v_started;
end;
$$;

create or replace function public.stop_fever_time(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.class_sessions
  set fever_ended_at = now()
  where id = p_session_id and owner_id = auth.uid();
end;
$$;

-- 개인 MP 지급. 피버 타임은 서버에서 자동 판정.
create or replace function public.award_mp(
  p_student_id uuid,
  p_session_id uuid,
  p_base_amount integer,
  p_reason text,
  p_skill_key text default null,
  p_extra_multiplier integer default 1,
  p_group_no integer default null
)
returns public.mp_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_class_id uuid;
  v_fever_multiplier integer := 1;
  v_final_amount integer;
  v_tx public.mp_transactions;
  v_session public.class_sessions;
begin
  if p_base_amount <= 0 or p_base_amount > 100 then raise exception '기본 MP가 올바르지 않습니다.'; end if;
  if p_extra_multiplier not in (1,2) then raise exception '추가 배율이 올바르지 않습니다.'; end if;

  select class_id into v_class_id
  from public.students
  where id = p_student_id and owner_id = v_owner and active;
  if v_class_id is null then raise exception '학생을 찾을 수 없습니다.'; end if;

  select * into v_session
  from public.class_sessions
  where id = p_session_id and owner_id = v_owner and class_id = v_class_id and status = 'active';
  if v_session.id is null then raise exception '진행 중인 수업을 찾을 수 없습니다.'; end if;

  if v_session.fever_started_at is not null
     and coalesce(v_session.fever_ended_at, now() + interval '1 second') > now()
     and now() < v_session.fever_started_at + interval '10 minutes' then
    v_fever_multiplier := 2;
  end if;

  if p_skill_key = 'beginner_luck' then
    perform public.record_skill_usage(p_student_id, p_session_id, p_skill_key, p_reason);
  elsif p_skill_key is not null then
    insert into public.skill_usages(owner_id, class_id, student_id, session_id, skill_key, note)
    values(v_owner, v_class_id, p_student_id, p_session_id, p_skill_key, p_reason);
  end if;

  v_final_amount := p_base_amount * p_extra_multiplier * v_fever_multiplier;

  insert into public.mp_transactions(
    owner_id, class_id, student_id, session_id,
    amount, base_amount, multiplier, reason, skill_key, group_no
  ) values(
    v_owner, v_class_id, p_student_id, p_session_id,
    v_final_amount, p_base_amount, p_extra_multiplier * v_fever_multiplier,
    p_reason, p_skill_key, p_group_no
  ) returning * into v_tx;

  update public.students
  set total_mp = total_mp + v_final_amount
  where id = p_student_id and owner_id = v_owner;

  return v_tx;
end;
$$;

-- 모둠 전원 MP 지급
create or replace function public.award_group_mp(
  p_season_id uuid,
  p_session_id uuid,
  p_group_no integer,
  p_base_amount integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_count integer := 0;
begin
  for rec in
    select student_id from public.assignments
    where owner_id = auth.uid() and season_id = p_season_id and group_no = p_group_no
  loop
    perform public.award_mp(rec.student_id, p_session_id, p_base_amount, p_reason, null, 1, p_group_no);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 잘못된 MP 지급 취소: 반대 거래를 남김
create or replace function public.reverse_mp_transaction(p_transaction_id uuid, p_reason text)
returns public.mp_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_original public.mp_transactions;
  v_reversal public.mp_transactions;
begin
  select * into v_original
  from public.mp_transactions
  where id = p_transaction_id and owner_id = v_owner and not is_reversed;

  if v_original.id is null then raise exception '취소할 기록을 찾을 수 없습니다.'; end if;

  insert into public.mp_transactions(
    owner_id, class_id, student_id, session_id,
    amount, base_amount, multiplier, reason, skill_key, group_no, reversal_of
  ) values(
    v_owner, v_original.class_id, v_original.student_id, v_original.session_id,
    -v_original.amount, -v_original.base_amount, v_original.multiplier,
    '취소: ' || coalesce(nullif(trim(p_reason),''), v_original.reason),
    v_original.skill_key, v_original.group_no, v_original.id
  ) returning * into v_reversal;

  update public.mp_transactions set is_reversed = true where id = v_original.id;
  update public.students
  set total_mp = greatest(0, total_mp - v_original.amount)
  where id = v_original.student_id and owner_id = v_owner;

  return v_reversal;
end;
$$;

-- 승급 처리
create or replace function public.promote_student(p_assignment_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_assignment public.assignments;
  v_total_mp integer;
  v_to_role text;
begin
  select * into v_assignment from public.assignments
  where id = p_assignment_id and owner_id = v_owner;
  if v_assignment.id is null then raise exception '배치 정보를 찾을 수 없습니다.'; end if;

  select total_mp into v_total_mp from public.students
  where id = v_assignment.student_id and owner_id = v_owner;

  if v_total_mp - v_assignment.role_started_mp < 20 then
    raise exception '현재 역할에서 20MP를 아직 획득하지 못했습니다.';
  end if;

  v_to_role := case v_assignment.role
    when 'beginner' then 'disciple'
    when 'mentor' then 'senior_mentor'
    else null
  end;

  if v_to_role is null then raise exception '승급할 수 없는 역할입니다.'; end if;

  update public.assignments set role = v_to_role where id = p_assignment_id;

  insert into public.promotion_events(
    owner_id, class_id, season_id, student_id,
    from_role, to_role, threshold_mp
  )
  select v_owner, s.class_id, v_assignment.season_id, v_assignment.student_id,
         v_assignment.role, v_to_role, v_total_mp
  from public.students s where s.id = v_assignment.student_id;

  return v_to_role;
end;
$$;

grant execute on function public.create_class_with_season(text,integer,integer,text,date,date) to authenticated;
grant execute on function public.bulk_add_students(uuid,jsonb) to authenticated;
grant execute on function public.save_seating_plan(uuid,jsonb) to authenticated;
grant execute on function public.update_assignment_role(uuid,text,uuid,boolean) to authenticated;
grant execute on function public.start_class_session(uuid,uuid) to authenticated;
grant execute on function public.end_class_session(uuid) to authenticated;
grant execute on function public.record_skill_usage(uuid,uuid,text,text) to authenticated;
grant execute on function public.start_fever_time(uuid) to authenticated;
grant execute on function public.stop_fever_time(uuid) to authenticated;
grant execute on function public.award_mp(uuid,uuid,integer,text,text,integer,integer) to authenticated;
grant execute on function public.award_group_mp(uuid,uuid,integer,integer,text) to authenticated;
grant execute on function public.reverse_mp_transaction(uuid,text) to authenticated;
grant execute on function public.promote_student(uuid) to authenticated;

-- 새 모둠 운영 기간 생성. 기존 배치를 복사할 수 있음.
create or replace function public.create_season(
  p_class_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date default null,
  p_copy_from_season_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_new_id uuid;
begin
  if not exists(select 1 from public.classes where id = p_class_id and owner_id = v_owner) then
    raise exception '학급 접근 권한이 없습니다.';
  end if;

  update public.seasons set is_active = false
  where class_id = p_class_id and owner_id = v_owner and is_active;

  insert into public.seasons(owner_id, class_id, name, start_date, end_date, is_active)
  values(v_owner, p_class_id, p_name, p_start_date, p_end_date, true)
  returning id into v_new_id;

  if p_copy_from_season_id is not null then
    update public.assignments target
    set group_no = source.group_no,
        seat_index = source.seat_index,
        role = source.role,
        role_started_mp = source.role_started_mp,
        mentor_student_id = source.mentor_student_id
    from public.assignments source
    where target.season_id = v_new_id
      and source.season_id = p_copy_from_season_id
      and target.student_id = source.student_id
      and target.owner_id = v_owner
      and source.owner_id = v_owner;
  end if;

  return v_new_id;
end;
$$;

grant execute on function public.create_season(uuid,text,date,date,uuid) to authenticated;

-- 공개/익명 호출 차단 후 로그인한 교사에게 필요한 RPC만 허용
revoke execute on all functions in schema public from public, anon;

grant execute on function public.create_class_with_season(text,integer,integer,text,date,date) to authenticated;
grant execute on function public.bulk_add_students(uuid,jsonb) to authenticated;
grant execute on function public.save_seating_plan(uuid,jsonb) to authenticated;
grant execute on function public.update_assignment_role(uuid,text,uuid,boolean) to authenticated;
grant execute on function public.start_class_session(uuid,uuid) to authenticated;
grant execute on function public.end_class_session(uuid) to authenticated;
grant execute on function public.record_skill_usage(uuid,uuid,text,text) to authenticated;
grant execute on function public.start_fever_time(uuid) to authenticated;
grant execute on function public.stop_fever_time(uuid) to authenticated;
grant execute on function public.award_mp(uuid,uuid,integer,text,text,integer,integer) to authenticated;
grant execute on function public.award_group_mp(uuid,uuid,integer,integer,text) to authenticated;
grant execute on function public.reverse_mp_transaction(uuid,text) to authenticated;
grant execute on function public.promote_student(uuid) to authenticated;
grant execute on function public.create_season(uuid,text,date,date,uuid) to authenticated;
