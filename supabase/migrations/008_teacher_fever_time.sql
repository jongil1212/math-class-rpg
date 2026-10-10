-- 피버 타임을 수호자 요청(학급당 주 1회)과 교사 선언으로 구분한다.
-- 기존 001~007 적용 후 이 파일 전체를 실행한다.
begin;

alter table public.class_sessions
  add column if not exists fever_source text
    check (fever_source in ('guardian', 'teacher'));

-- 같은 수업에서 교사가 다시 선언해도 수호자의 주간 사용 기록을 보존한다.
create table if not exists public.fever_time_activations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  source text not null check (source in ('guardian', 'teacher')),
  started_at timestamptz not null default now(),
  unique (session_id, started_at)
);

create index if not exists fever_time_activations_week_idx
on public.fever_time_activations(owner_id, class_id, source, started_at);

alter table public.fever_time_activations enable row level security;
drop policy if exists owner_read on public.fever_time_activations;
create policy owner_read on public.fever_time_activations
for select to authenticated using (owner_id = auth.uid());

revoke all on table public.fever_time_activations from public, anon, authenticated;
grant select on table public.fever_time_activations to authenticated;

-- 이전 버전의 피버 타임은 수호자 요청으로 이어받는다. 재실행해도 중복되지 않는다.
update public.class_sessions
set fever_source = 'guardian'
where fever_started_at is not null and fever_source is null;

insert into public.fever_time_activations(owner_id, class_id, session_id, source, started_at)
select owner_id, class_id, id, fever_source, fever_started_at
from public.class_sessions
where fever_started_at is not null
on conflict (session_id, started_at) do nothing;

create or replace function public.start_fever_time(p_session_id uuid, p_source text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_session public.class_sessions;
  v_started timestamptz;
  v_week_start timestamptz;
begin
  if v_owner is null then raise exception '로그인이 필요합니다.'; end if;
  if p_source is null or p_source not in ('guardian', 'teacher') then
    raise exception '피버 타임 시작 구분이 올바르지 않습니다.';
  end if;

  -- 동시 클릭을 직렬화하고 수업 종료와 경합해 종료된 수업을 다시 켜지 않게 한다.
  select * into v_session
  from public.class_sessions
  where id = p_session_id and owner_id = v_owner and status = 'active'
  for update;

  if v_session.id is null then raise exception '진행 중인 수업이 아닙니다.'; end if;

  v_started := clock_timestamp();
  if v_session.fever_started_at is not null
     and v_session.fever_ended_at is null
     and v_started < v_session.fever_started_at + interval '10 minutes' then
    raise exception '이미 피버 타임이 진행 중입니다. 종료 후 다시 시작해 주세요.';
  end if;

  if p_source = 'guardian' then
    -- 화면에서 다른 시즌을 보고 있어도 실제 진행 중인 수업의 역할로 검증한다.
    if not exists (
      select 1
      from public.assignments as assignment
      join public.students as student on student.id = assignment.student_id
      where assignment.owner_id = v_owner
        and assignment.season_id = v_session.season_id
        and assignment.role = 'guardian'
        and student.owner_id = v_owner
        and student.class_id = v_session.class_id
        and student.active
    ) then
      raise exception '이 수업에 수호자가 없습니다. 교사 선언 피버를 사용해 주세요.';
    end if;

    -- 한국 시간 월요일 00:00부터 다음 월요일까지 학급당 수호자 요청 1회.
    v_week_start := date_trunc('week', v_started at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
    if exists (
      select 1 from public.fever_time_activations
      where owner_id = v_owner and class_id = v_session.class_id and source = 'guardian'
        and started_at >= v_week_start
        and started_at < v_week_start + interval '7 days'
    ) then
      raise exception '이번 주 수호자 요청 피버 타임을 이미 사용했습니다. 교사 선언은 별도로 사용할 수 있습니다.';
    end if;
  end if;

  insert into public.fever_time_activations(owner_id, class_id, session_id, source, started_at)
  values(v_owner, v_session.class_id, p_session_id, p_source, v_started);

  -- 두 경로 모두 기존 MP 계산에서 사용하는 동일한 10분 타이머를 시작한다.
  update public.class_sessions
  set fever_started_at = v_started, fever_ended_at = null, fever_source = p_source
  where id = p_session_id and owner_id = v_owner;

  return v_started;
end;
$$;

-- 기존 화면의 인자 1개 호출도 수호자 요청 규칙으로 동작한다.
create or replace function public.start_fever_time(p_session_id uuid)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  select public.start_fever_time(p_session_id, 'guardian');
$$;

revoke execute on function public.start_fever_time(uuid,text) from public, anon;
revoke execute on function public.start_fever_time(uuid) from public, anon;
grant execute on function public.start_fever_time(uuid,text) to authenticated;
grant execute on function public.start_fever_time(uuid) to authenticated;

commit;
