-- 시즌 2: 기존 MP/기록을 보존한다. 001~008 적용 후 전체 실행.
begin;

alter table public.seasons add column if not exists rules_version integer not null default 1 check (rules_version in (1,2));
alter table public.seasons add column if not exists shop_open boolean not null default false;
alter table public.assignments drop constraint if exists assignments_role_check;
alter table public.assignments add constraint assignments_role_check
  check (role in ('beginner','disciple','senior_disciple','mentor','senior_mentor','math_saint','guardian'));

create table if not exists public.shop_accounts (
  student_id uuid primary key references public.students(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  reserved_mp integer not null check (reserved_mp in (30,40)),
  created_at timestamptz not null default now()
);
create table if not exists public.shop_coupons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  -- 기간을 삭제해도 지출/사용권은 사라지지 않는다. MP와 마찬가지로 학급 내 승계.
  season_id uuid references public.seasons(id) on delete set null,
  product_key text not null check (product_key in ('presentation_priority','fever_request','teacher_hint','snack_draw','early_finish')),
  cost integer not null check (cost > 0),
  status text not null default 'unused' check (status in ('unused','used','refunded')),
  used_session_id uuid references public.class_sessions(id) on delete set null,
  used_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shop_coupons_student_idx on public.shop_coupons(student_id, created_at desc);
create table if not exists public.session_effects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  target_student_id uuid references public.students(id) on delete set null,
  group_no integer,
  kind text not null check (kind in ('shield','fortune','duo','steal')),
  consumed boolean not null default false,
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists session_effects_session_idx on public.session_effects(session_id);
create table if not exists public.season_two_skill_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  target_student_id uuid references public.students(id) on delete set null,
  skill_key text not null,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['shop_accounts','shop_coupons','session_effects','season_two_skill_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists owner_read on public.%I',t);
    execute format('create policy owner_read on public.%I for select to authenticated using (owner_id = auth.uid())',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;

-- 이전 규칙은 시즌 1 호환용으로 보관. 내부 함수에는 클라이언트 실행 권한을 주지 않는다.
do $$ declare item text; sig text; begin
  foreach item in array array[
    'create_season|uuid,text,date,date,uuid', 'promote_student|uuid',
    'award_mp|uuid,uuid,integer,text,text,integer,integer',
    'record_skill_usage|uuid,uuid,text,text', 'reverse_mp_transaction|uuid,text', 'reset_class_mp|uuid'
  ] loop
    sig := split_part(item,'|',2);
    if to_regprocedure('public.'||split_part(item,'|',1)||'_v1('||sig||')') is null then
      execute format('alter function public.%I(%s) rename to %I',split_part(item,'|',1),sig,split_part(item,'|',1)||'_v1');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated',split_part(item,'|',1)||'_v1',sig);
  end loop;
end $$;

create or replace function public.s2_session(p_session_id uuid)
returns public.class_sessions language plpgsql security definer set search_path = public as $$
declare v public.class_sessions; begin
  select * into v from public.class_sessions where id=p_session_id and owner_id=auth.uid() and status='active';
  if v.id is null then raise exception '진행 중인 수업이 아닙니다.'; end if;
  -- 학급 단위 잠금으로 스킬/구매 동시 요청도 순서대로 처리.
  perform 1 from public.classes where id=v.class_id and owner_id=auth.uid() and archived_at is null for update;
  if not found then raise exception '사용 가능한 학급이 아닙니다.'; end if;
  select * into v from public.class_sessions where id=p_session_id and status='active' for update;
  if v.id is null then raise exception '수업이 종료되었습니다.'; end if;
  if not exists(select 1 from public.seasons where id=v.season_id and owner_id=auth.uid()
    and rules_version=2 and is_active and archived_at is null) then
    raise exception '현재 시즌 2 수업에서만 사용할 수 있습니다.';
  end if;
  return v;
end $$;

create or replace function public.create_season_v2(
  p_class_id uuid,p_name text,p_start_date date,p_end_date date default null,
  p_copy_from_season_id uuid default null,p_rules_version integer default 2
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; begin
  if p_rules_version is null or p_rules_version not in (1,2) then raise exception '운영 규칙을 확인해 주세요.'; end if;
  perform 1 from public.classes where id=p_class_id and owner_id=auth.uid() and archived_at is null for update;
  if not found then raise exception '학급 접근 권한이 없습니다.'; end if;
  if exists(select 1 from public.class_sessions where class_id=p_class_id and status='active') then
    raise exception '수업 종료 후 새 운영 기간을 만들어 주세요.';
  end if;
  if p_name is null or trim(p_name)='' or p_start_date is null or p_end_date<p_start_date then
    raise exception '운영 기간 이름과 날짜를 확인해 주세요.';
  end if;
  if p_copy_from_season_id is not null and not exists(select 1 from public.seasons
    where id=p_copy_from_season_id and class_id=p_class_id and owner_id=auth.uid() and archived_at is null) then
    raise exception '복사할 운영 기간을 찾을 수 없습니다.';
  end if;
  if p_rules_version=1 and exists(select 1 from public.assignments where season_id=p_copy_from_season_id
    and role in ('senior_disciple','math_saint')) then raise exception '시즌 2 칭호는 시즌 1로 복사할 수 없습니다.'; end if;
  v_id := public.create_season_v1(p_class_id,p_name,p_start_date,p_end_date,p_copy_from_season_id);
  update public.seasons set rules_version=p_rules_version where id=v_id;
  perform public.sync_seating_mentors(v_id,auth.uid());
  return v_id;
end $$;
create or replace function public.create_season(p_class_id uuid,p_name text,p_start_date date,
  p_end_date date default null,p_copy_from_season_id uuid default null)
returns uuid language sql security definer set search_path=public as $$
  select public.create_season_v2(p_class_id,p_name,p_start_date,p_end_date,p_copy_from_season_id,1);
$$;

create or replace function public.start_class_session(p_class_id uuid,p_season_id uuid)
returns public.class_sessions language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; begin
  perform 1 from public.classes where id=p_class_id and owner_id=auth.uid() and archived_at is null for update;
  if not found or not exists(select 1 from public.seasons where id=p_season_id and class_id=p_class_id
    and owner_id=auth.uid() and is_active and archived_at is null) then
    raise exception '현재 운영 기간을 선택한 뒤 수업을 시작해 주세요.';
  end if;
  select * into v from public.class_sessions where class_id=p_class_id and owner_id=auth.uid() and status='active';
  if v.id is not null then return v; end if;
  insert into public.class_sessions(owner_id,class_id,season_id) values(auth.uid(),p_class_id,p_season_id) returning * into v;
  return v;
end $$;

create or replace function public.promote_student(p_assignment_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare a public.assignments; s public.seasons; v_total integer; v_to text; v_threshold integer; begin
  select * into a from public.assignments where id=p_assignment_id and owner_id=auth.uid() for update;
  if a.id is null then raise exception '배치 정보를 찾을 수 없습니다.'; end if;
  select * into s from public.seasons where id=a.season_id and owner_id=auth.uid();
  if not s.is_active or s.archived_at is not null then raise exception '현재 운영 기간에서만 승급할 수 있습니다.'; end if;
  if s.rules_version=1 then return public.promote_student_v1(p_assignment_id); end if;
  select total_mp into v_total from public.students where id=a.student_id and owner_id=auth.uid() and active for update;
  v_to := case a.role when 'beginner' then 'disciple' when 'disciple' then 'senior_disciple'
    when 'mentor' then 'senior_mentor' when 'senior_mentor' then 'math_saint' end;
  v_threshold := case when a.role in ('disciple','senior_mentor') then 40 else 20 end;
  if v_to is null then raise exception '승급할 수 없는 역할입니다.'; end if;
  if v_total is null or v_total<v_threshold then raise exception '누적 %MP가 필요합니다.',v_threshold; end if;
  update public.assignments set role=v_to where id=a.id;
  insert into public.promotion_events(owner_id,class_id,season_id,student_id,from_role,to_role,threshold_mp)
    values(auth.uid(),s.class_id,s.id,a.student_id,a.role,v_to,v_threshold);
  perform public.sync_seating_mentors(s.id,auth.uid());
  return v_to;
end $$;

create or replace function public.sync_seating_mentors(p_season_id uuid,p_owner_id uuid)
returns void language sql security definer set search_path=public as $$
  update public.assignments m set mentor_student_id=(
    select t.student_id from public.assignments t join public.students st on st.id=t.student_id and st.active
    where t.owner_id=p_owner_id and t.season_id=p_season_id and t.group_no=m.group_no
    and t.role in ('mentor','senior_mentor','math_saint') and t.seat_index=case
      when (select count(*) from public.assignments g join public.students gs on gs.id=g.student_id and gs.active
        where g.season_id=p_season_id and g.group_no=m.group_no and g.seat_index is not null)=3
        and m.seat_index in (2,3) then 1
      when m.seat_index=3 then 2 when m.seat_index=4 then 1 end limit 1
  ) where m.owner_id=p_owner_id and m.season_id=p_season_id and m.role in ('beginner','disciple','senior_disciple');
$$;

create or replace function public.bulk_update_assignment_roles(p_season_id uuid,p_assignment_ids uuid[],p_role text)
returns integer language plpgsql security definer set search_path=public as $$
declare s public.seasons; n integer; begin
  select * into s from public.seasons where id=p_season_id and owner_id=auth.uid() and archived_at is null and is_active;
  if s.id is null then raise exception '현재 운영 기간을 선택해 주세요.'; end if;
  perform 1 from public.classes where id=s.class_id and owner_id=auth.uid() for update;
  if p_role is null or p_role not in ('beginner','disciple','senior_disciple','mentor','senior_mentor','math_saint','guardian')
    or (s.rules_version=1 and p_role in ('senior_disciple','math_saint')) then raise exception '이 기간에서 사용할 수 없는 역할입니다.'; end if;
  if exists(select 1 from public.class_sessions where class_id=s.class_id and status='active') then
    raise exception '진행 중인 수업을 종료한 뒤 역할을 변경해 주세요.';
  end if;
  n := coalesce(array_length(p_assignment_ids,1),0);
  if n=0 or n<>(select count(*) from public.assignments where season_id=s.id and owner_id=auth.uid() and id=any(p_assignment_ids)) then
    raise exception '선택한 학생 정보를 확인해 주세요.';
  end if;
  update public.assignments a set role=p_role,mentor_student_id=null,
    role_started_mp=case when s.rules_version=1 and a.role<>p_role then st.total_mp else a.role_started_mp end
    from public.students st where st.id=a.student_id and st.owner_id=auth.uid() and a.id=any(p_assignment_ids);
  perform public.sync_seating_mentors(s.id,auth.uid());
  return n;
end $$;
create or replace function public.update_assignment_role(p_assignment_id uuid,p_role text,
  p_mentor_student_id uuid default null,p_reset_role_progress boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare v_season uuid; begin
  select season_id into v_season from public.assignments where id=p_assignment_id and owner_id=auth.uid();
  perform public.bulk_update_assignment_roles(v_season,array[p_assignment_id],p_role);
end $$;

-- 시즌 2에서는 기존 액티브도 스킬별 수업당 1회. 같은 수업의 요청을 잠금으로 직렬화.
create or replace function public.record_skill_usage(p_student_id uuid,p_session_id uuid,p_skill_key text,p_note text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; a public.assignments; v_version integer; begin
  select * into v from public.class_sessions where id=p_session_id and owner_id=auth.uid() and status='active' for update;
  if v.id is null then raise exception '진행 중인 수업이 아닙니다.'; end if;
  select rules_version into v_version from public.seasons where id=v.season_id;
  select * into a from public.assignments where student_id=p_student_id and season_id=v.season_id and owner_id=auth.uid();
  if a.id is null then raise exception '이 수업의 학생이 아닙니다.'; end if;
  if p_skill_key is null or p_skill_key not in ('beginner_luck','retry') then
    raise exception '이 스킬은 전용 스킬 버튼에서 사용해 주세요.';
  end if;
  if (p_skill_key='beginner_luck' and a.role<>'beginner') or
     (p_skill_key='retry' and a.role not in ('disciple','senior_disciple')) then raise exception '역할에 맞지 않는 스킬입니다.'; end if;
  return public.record_skill_usage_v1(p_student_id,p_session_id,p_skill_key,p_note);
end $$;

create or replace function public.award_mp(p_student_id uuid,p_session_id uuid,p_base_amount integer,p_reason text,
  p_skill_key text default null,p_extra_multiplier integer default 1,p_group_no integer default null)
returns public.mp_transactions language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; a public.assignments; v_version integer; begin
  select * into v from public.class_sessions where id=p_session_id and owner_id=auth.uid() and status='active' for update;
  if v.id is null then raise exception '진행 중인 수업이 아닙니다.'; end if;
  select rules_version into v_version from public.seasons where id=v.season_id and is_active and archived_at is null;
  if v_version is null then raise exception '현재 운영 기간의 수업이 아닙니다.'; end if;
  select * into a from public.assignments where student_id=p_student_id and season_id=v.season_id and owner_id=auth.uid();
  if a.id is null then raise exception '이 수업의 학생이 아닙니다.'; end if;
  if p_skill_key is not null and not (
    (p_skill_key='beginner_luck' and a.role='beginner' and p_extra_multiplier=2) or
    (p_skill_key='eagle_eye_disciple' and a.role in ('disciple','senior_disciple') and p_base_amount=2) or
    (p_skill_key='relief_pitcher_helped' and a.role in ('beginner','disciple','senior_disciple') and p_base_amount=1) or
    (p_skill_key in ('mentor_grace','relief_pitcher','eagle_eye_mentor') and a.role in ('mentor','senior_mentor','math_saint') and p_base_amount=1
      and (p_skill_key<>'eagle_eye_mentor' or a.role<>'mentor')) or
    (p_skill_key='mentor_prophecy' and a.role in ('senior_mentor','math_saint') and p_base_amount=2) or
    (p_skill_key='never_give_up' and a.role='guardian' and p_base_amount=1)
  ) then raise exception '역할/점수에 맞지 않는 스킬입니다.'; end if;
  if p_extra_multiplier=2 and p_skill_key is distinct from 'beginner_luck' then raise exception '초심자의 행운만 추가 배율을 사용할 수 있습니다.'; end if;
  if v_version=2 and p_skill_key in ('eagle_eye_disciple','relief_pitcher','eagle_eye_mentor','mentor_prophecy','never_give_up')
    and exists(select 1 from public.skill_usages where student_id=p_student_id and session_id=v.id and skill_key=p_skill_key) then
    raise exception '이 스킬은 이번 수업에서 이미 사용했습니다.';
  end if;
  return public.award_mp_v1(p_student_id,p_session_id,p_base_amount,p_reason,p_skill_key,p_extra_multiplier,a.group_no);
end $$;

create or replace function public.award_personal_mp(p_student_id uuid,p_session_id uuid,p_base_amount integer,p_reason text,
  p_skill_key text default null,p_extra_multiplier integer default 1,p_group_no integer default null)
returns public.mp_transactions language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; a public.assignments; v_tx public.mp_transactions; v_seat integer; v_mentor uuid; v_count integer; v_name text; begin
  v_tx := public.award_mp(p_student_id,p_session_id,p_base_amount,p_reason,p_skill_key,p_extra_multiplier,p_group_no);
  select * into v from public.class_sessions where id=p_session_id and owner_id=auth.uid();
  select * into a from public.assignments where student_id=p_student_id and season_id=v.season_id and owner_id=auth.uid();
  select count(*) into v_count from public.assignments g join public.students st on st.id=g.student_id and st.active
    where g.season_id=v.season_id and g.group_no=a.group_no and g.seat_index is not null;
  if a.role in ('beginner','disciple','senior_disciple') or (a.role='guardian' and a.seat_index in (3,4)) then
    v_seat := case when v_count=3 and a.seat_index in (2,3) then 1
      when a.seat_index=3 then 2 when a.seat_index=4 then 1 end;
  end if;
  select g.student_id into v_mentor from public.assignments g join public.students st on st.id=g.student_id and st.active
    where g.season_id=v.season_id and g.owner_id=auth.uid() and g.group_no=a.group_no
    and g.seat_index=v_seat and g.role in ('mentor','senior_mentor','math_saint');
  if v_mentor is not null then
    select name into v_name from public.students where id=p_student_id;
    perform public.award_mp(v_mentor,p_session_id,1,'수승의 은혜 · '||v_name||' 개인 MP 획득','mentor_grace',1,a.group_no);
  end if;
  return v_tx;
end $$;

create or replace function public.use_relief_pitcher(p_student_id uuid,p_target_id uuid,p_session_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; begin
  select * into v from public.class_sessions where id=p_session_id and owner_id=auth.uid() and status='active' for update;
  if v.id is null or not exists(select 1 from public.assignments where season_id=v.season_id
    and student_id=p_target_id and mentor_student_id=p_student_id and owner_id=auth.uid()
    and role in ('beginner','disciple','senior_disciple')) then raise exception '짝 멘티를 선택해 주세요.'; end if;
  perform public.award_mp(p_student_id,p_session_id,1,'구원투수','relief_pitcher',1,null);
  perform public.award_personal_mp(p_target_id,p_session_id,1,'구원투수 도움받음','relief_pitcher_helped',1,null);
end $$;

create or replace function public.use_season_two_skill(p_student_id uuid,p_session_id uuid,p_skill_key text,p_target_id uuid default null)
returns text language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; a public.assignments; t public.assignments; v_shield uuid; begin
  v := public.s2_session(p_session_id);
  select * into a from public.assignments where season_id=v.season_id and student_id=p_student_id and owner_id=auth.uid();
  if a.id is null or a.group_no is null then raise exception '먼저 학생을 모둠에 배치해 주세요.'; end if;
  if p_skill_key is null or not ((p_skill_key in ('duo_casting','absorption_strike') and a.role='senior_disciple')
    or (p_skill_key='presentation_steal' and a.role='math_saint')
    or (p_skill_key='guardian_blessing' and a.role='guardian')) then raise exception '사용 가능한 스킬이 아닙니다.'; end if;
  if exists(select 1 from public.skill_usages where student_id=p_student_id and session_id=v.id and skill_key=p_skill_key) then
    raise exception '이 스킬은 이번 수업에서 이미 사용했습니다.';
  end if;
  if p_skill_key='guardian_blessing' then
    if exists(select 1 from public.session_effects where session_id=v.id and kind='shield' and group_no=a.group_no and not consumed) then
      raise exception '이 모둠은 이미 가호로 보호받고 있습니다.';
    end if;
    insert into public.session_effects(owner_id,session_id,student_id,group_no,kind,note)
      values(auth.uid(),v.id,p_student_id,a.group_no,'shield','다음 공격 1회 방어');
  else
    select g.* into t from public.assignments g join public.students st on st.id=g.student_id and st.active
      where g.season_id=v.season_id and g.student_id=p_target_id and g.owner_id=auth.uid();
    if t.id is null or t.student_id=a.student_id or t.group_no is null then raise exception '배치된 다른 학생을 선택해 주세요.'; end if;
    if p_skill_key='duo_casting' then
      if t.group_no<>a.group_no then raise exception '같은 모둠 학생을 선택해 주세요.'; end if;
      insert into public.session_effects(owner_id,session_id,student_id,target_student_id,group_no,kind,note)
        values(auth.uid(),v.id,p_student_id,p_target_id,a.group_no,'duo','추가 발표자 참여 확인 필요');
    else
      if p_skill_key='absorption_strike' and (t.group_no=a.group_no or t.role not in ('mentor','senior_mentor','math_saint')) then
        raise exception '다른 모둠 수승님을 선택해 주세요.';
      end if;
      -- 공격 대상이 확정된 뒤 1회 보호를 소모. 막힌 공격도 시도 횟수에 포함.
      select id into v_shield from public.session_effects where session_id=v.id and kind='shield'
        and group_no=t.group_no and not consumed order by created_at limit 1 for update;
      if v_shield is not null then
        update public.session_effects set consumed=true where id=v_shield;
      elsif p_skill_key='absorption_strike' then
        perform 1 from public.students where id in (p_student_id,p_target_id) order by id for update;
        if (select total_mp from public.students where id=p_target_id)<1 then raise exception '대상의 MP가 0이라 강탈할 수 없습니다.'; end if;
        -- 전송은 정확히 1MP. 피버/수승의 은혜를 중복 발동하지 않음.
        update public.students set total_mp=total_mp-1 where id=p_target_id;
        update public.students set total_mp=total_mp+1 where id=p_student_id;
        insert into public.mp_transactions(owner_id,class_id,student_id,session_id,amount,base_amount,multiplier,reason,skill_key,group_no)
        values(auth.uid(),v.class_id,p_target_id,v.id,-1,-1,1,'흡수의 일격 · MP 강탈당함',p_skill_key,t.group_no),
              (auth.uid(),v.class_id,p_student_id,v.id,1,1,1,'흡수의 일격 · MP 획득',p_skill_key,a.group_no);
        if t.role='math_saint' then
          if not exists(select 1 from public.session_effects where session_id=v.id and student_id=p_target_id and kind='fortune' and not consumed) then
            insert into public.session_effects(owner_id,session_id,student_id,group_no,kind,note)
              values(auth.uid(),v.id,p_target_id,t.group_no,'fortune','전화위복 · 다음 활동 발표 최우선권');
          end if;
        end if;
      else
        insert into public.session_effects(owner_id,session_id,student_id,target_student_id,group_no,kind,note)
          values(auth.uid(),v.id,p_student_id,p_target_id,a.group_no,'steal','대상의 발표 기회를 가져옴');
      end if;
    end if;
  end if;
  insert into public.skill_usages(owner_id,class_id,student_id,session_id,skill_key,note)
    values(auth.uid(),v.class_id,p_student_id,v.id,p_skill_key,case when v_shield is not null then '수호자의 가호에 막힘' else '시즌 2 스킬 사용' end);
  insert into public.season_two_skill_events(owner_id,session_id,student_id,target_student_id,skill_key,blocked)
    values(auth.uid(),v.id,p_student_id,p_target_id,p_skill_key,v_shield is not null);
  return case when v_shield is not null then '수호자의 가호가 공격을 막았습니다. 공격·가호 각각 1회 소모되었습니다.' else '스킬을 적용했습니다.' end;
end $$;

create or replace function public.complete_session_effect(p_effect_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare e public.session_effects; begin
  select * into e from public.session_effects where id=p_effect_id and owner_id=auth.uid();
  if e.id is null or e.kind='shield' or e.consumed then raise exception '완료할 발표 효과가 없습니다.'; end if;
  perform public.s2_session(e.session_id);
  update public.session_effects set consumed=true where id=e.id;
end $$;

create or replace function public.set_shop_open(p_season_id uuid,p_open boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.seasons set shop_open=p_open where id=p_season_id and owner_id=auth.uid()
    and rules_version=2 and is_active and archived_at is null;
  if not found then raise exception '현재 시즌 2에서만 상점을 운영할 수 있습니다.'; end if;
end $$;

create or replace function public.purchase_shop_coupon(p_season_id uuid,p_student_id uuid,p_product_key text)
returns uuid language plpgsql security definer set search_path=public as $$
declare s public.seasons; a public.assignments; st public.students; v_cost integer; v_reserved integer; v_spent integer; v_id uuid; begin
  select * into s from public.seasons where id=p_season_id and owner_id=auth.uid();
  if s.id is null then raise exception '운영 기간 접근 권한이 없습니다.'; end if;
  perform 1 from public.classes where id=s.class_id and owner_id=auth.uid() and archived_at is null for update;
  if not found then raise exception '사용 가능한 학급이 아닙니다.'; end if;
  select * into s from public.seasons where id=p_season_id for update;
  if s.rules_version<>2 or not s.is_active or s.archived_at is not null or not s.shop_open then raise exception '상점이 닫혀 있습니다.'; end if;
  select * into st from public.students where id=p_student_id and owner_id=auth.uid() and class_id=s.class_id and active for update;
  select * into a from public.assignments where season_id=s.id and student_id=p_student_id and owner_id=auth.uid();
  if st.id is null or a.id is null then raise exception '이 학급의 학생이 아닙니다.'; end if;
  v_cost := case p_product_key when 'presentation_priority' then 2 when 'fever_request' then 4
    when 'teacher_hint' then 4 when 'snack_draw' then 5 when 'early_finish' then 20 end;
  if v_cost is null then raise exception '등록된 상품이 아닙니다.'; end if;
  insert into public.shop_accounts(student_id,owner_id,class_id,reserved_mp)
    values(st.id,auth.uid(),s.class_id,case when a.role='guardian' then 30 else 40 end) on conflict do nothing;
  select reserved_mp into v_reserved from public.shop_accounts where student_id=st.id;
  select coalesce(sum(cost),0) into v_spent from public.shop_coupons where student_id=st.id and status<>'refunded';
  if st.total_mp-v_reserved-v_spent<v_cost then raise exception '구매 가능 MP가 부족합니다.'; end if;
  insert into public.shop_coupons(owner_id,class_id,student_id,season_id,product_key,cost)
    values(auth.uid(),s.class_id,st.id,s.id,p_product_key,v_cost) returning id into v_id;
  return v_id;
end $$;

create or replace function public.use_shop_coupon(p_coupon_id uuid,p_session_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v public.class_sessions; c public.shop_coupons; begin
  v := public.s2_session(p_session_id);
  select * into c from public.shop_coupons where id=p_coupon_id and owner_id=auth.uid() and class_id=v.class_id for update;
  if c.id is null or c.status<>'unused' then raise exception '미사용 사용권이 아닙니다.'; end if;
  if not exists(select 1 from public.students where id=c.student_id and active) then raise exception '활성 학생의 사용권이 아닙니다.'; end if;
  if c.product_key='fever_request' then perform public.start_fever_time(v.id,'teacher'); end if;
  update public.shop_coupons set status='used',used_at=now(),used_session_id=v.id where id=c.id;
end $$;
create or replace function public.refund_shop_coupon(p_coupon_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare c public.shop_coupons; begin
  select * into c from public.shop_coupons where id=p_coupon_id and owner_id=auth.uid();
  if c.id is null then raise exception '사용권을 찾을 수 없습니다.'; end if;
  perform 1 from public.classes where id=c.class_id and owner_id=auth.uid() for update;
  select * into c from public.shop_coupons where id=p_coupon_id for update;
  if c.status<>'unused' then raise exception '미사용 사용권만 환불할 수 있습니다.'; end if;
  update public.shop_coupons set status='refunded',refunded_at=now() where id=c.id;
end $$;

-- 공격 전송의 한쪽만 취소하지 못하도록 보호. 지급 취소/상점 구매는 전화위복을 발동하지 않는다.
create or replace function public.reverse_mp_transaction(p_transaction_id uuid,p_reason text)
returns public.mp_transactions language plpgsql security definer set search_path=public as $$
declare t public.mp_transactions; begin
  select * into t from public.mp_transactions where id=p_transaction_id and owner_id=auth.uid() for update;
  if t.id is null or t.amount<=0 or t.is_reversed or t.skill_key='absorption_strike' then raise exception '취소할 수 없는 거래입니다.'; end if;
  return public.reverse_mp_transaction_v1(p_transaction_id,p_reason);
end $$;
create or replace function public.reset_class_mp(p_class_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.classes where id=p_class_id and owner_id=auth.uid() for update;
  if not found then raise exception '학급 접근 권한이 없습니다.'; end if;
  if exists(select 1 from public.shop_coupons where class_id=p_class_id and status<>'refunded') then
    raise exception '상점 구매 기록이 있는 학급은 MP 전체 초기화가 제한됩니다. 테스트 미사용권을 먼저 환불해 주세요.';
  end if;
  return public.reset_class_mp_v1(p_class_id);
end $$;

-- 새 내부 함수를 익명/교사가 직접 호출할 수 없게 하고 필요한 RPC만 허용.
do $$ declare item text; begin
  foreach item in array array[
    's2_session(uuid)','create_season_v2(uuid,text,date,date,uuid,integer)',
    'create_season(uuid,text,date,date,uuid)','promote_student(uuid)',
    'update_assignment_role(uuid,text,uuid,boolean)','bulk_update_assignment_roles(uuid,uuid[],text)',
    'record_skill_usage(uuid,uuid,text,text)','award_mp(uuid,uuid,integer,text,text,integer,integer)',
    'award_personal_mp(uuid,uuid,integer,text,text,integer,integer)',
    'use_relief_pitcher(uuid,uuid,uuid)','use_season_two_skill(uuid,uuid,text,uuid)',
    'complete_session_effect(uuid)','set_shop_open(uuid,boolean)',
    'purchase_shop_coupon(uuid,uuid,text)','use_shop_coupon(uuid,uuid)','refund_shop_coupon(uuid)',
    'reverse_mp_transaction(uuid,text)','reset_class_mp(uuid)'
  ] loop
    execute 'revoke all on function public.'||item||' from public, anon';
    if item='s2_session(uuid)' then execute 'revoke all on function public.'||item||' from authenticated';
    else execute 'grant execute on function public.'||item||' to authenticated'; end if;
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
