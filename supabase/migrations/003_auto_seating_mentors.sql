-- 자리 배치에 따라 담당 수승님을 자동 동기화한다.
-- 4번 입문자/수제자 -> 1번 수승님, 3번 입문자/수제자 -> 2번 수승님

create or replace function public.sync_seating_mentors(
  p_season_id uuid,
  p_owner_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.assignments as mentee
  set mentor_student_id = (
    select mentor.student_id
    from public.assignments as mentor
    where mentor.owner_id = p_owner_id
      and mentor.season_id = p_season_id
      and mentor.group_no = mentee.group_no
      and mentor.seat_index =
        case mentee.seat_index when 3 then 2 when 4 then 1 end
      and mentor.role in ('mentor', 'senior_mentor')
    limit 1
  )
  where mentee.owner_id = p_owner_id
    and mentee.season_id = p_season_id
    and mentee.role in ('beginner', 'disciple');
$$;

revoke execute on function public.sync_seating_mentors(uuid,uuid)
from public, anon, authenticated;

-- 배치 저장 직후 전체 멘토-멘티 관계를 다시 계산한다.
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

  perform public.sync_seating_mentors(p_season_id, v_owner);
  return v_count;
end;
$$;

-- 역할을 바꾼 뒤에도 같은 운영 기간의 관계를 다시 계산한다.
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
  v_season_id uuid;
begin
  if p_role not in ('beginner','disciple','mentor','senior_mentor','guardian') then
    raise exception '올바르지 않은 역할입니다.';
  end if;

  select a.student_id, s.total_mp, a.season_id
  into v_student_id, v_total_mp, v_season_id
  from public.assignments a
  join public.students s on s.id = a.student_id
  where a.id = p_assignment_id and a.owner_id = v_owner;

  if v_student_id is null then raise exception '배치 정보를 찾을 수 없습니다.'; end if;

  update public.assignments
  set role = p_role,
      mentor_student_id = null,
      role_started_mp = case when p_reset_role_progress then v_total_mp else role_started_mp end
  where id = p_assignment_id and owner_id = v_owner;

  perform public.sync_seating_mentors(v_season_id, v_owner);
end;
$$;

grant execute on function public.save_seating_plan(uuid,jsonb) to authenticated;
grant execute on function public.update_assignment_role(uuid,text,uuid,boolean) to authenticated;
