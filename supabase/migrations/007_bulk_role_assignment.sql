-- 현재 운영 기간의 여러 학생 역할을 한 번에 변경한다.

create or replace function public.bulk_update_assignment_roles(
  p_season_id uuid,
  p_assignment_ids uuid[],
  p_role text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_class_id uuid;
  v_requested_count integer;
  v_found_count integer;
  v_updated_count integer;
begin
  if p_role not in ('beginner','disciple','mentor','senior_mentor','guardian') then
    raise exception '올바르지 않은 역할입니다.';
  end if;

  v_requested_count := coalesce(array_length(p_assignment_ids, 1), 0);
  if v_requested_count = 0 then raise exception '선택한 학생이 없습니다.'; end if;

  select class_id into v_class_id
  from public.seasons
  where id = p_season_id and owner_id = v_owner and archived_at is null;

  if v_class_id is null then raise exception '운영 기간을 찾을 수 없습니다.'; end if;

  if exists (
    select 1 from public.class_sessions
    where owner_id = v_owner and class_id = v_class_id and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 역할을 변경해 주세요.';
  end if;

  select count(*) into v_found_count
  from public.assignments
  where owner_id = v_owner
    and season_id = p_season_id
    and id = any(p_assignment_ids);

  if v_found_count <> v_requested_count then
    raise exception '선택한 학생 정보가 현재 운영 기간과 일치하지 않습니다.';
  end if;

  update public.assignments as assignment
  set role = p_role,
      mentor_student_id = null,
      role_started_mp = case
        when assignment.role <> p_role then student.total_mp
        else assignment.role_started_mp
      end
  from public.students as student
  where assignment.student_id = student.id
    and assignment.owner_id = v_owner
    and student.owner_id = v_owner
    and assignment.season_id = p_season_id
    and assignment.id = any(p_assignment_ids);

  get diagnostics v_updated_count = row_count;
  perform public.sync_seating_mentors(p_season_id, v_owner);
  return v_updated_count;
end;
$$;

revoke execute on function public.bulk_update_assignment_roles(uuid,uuid[],text)
from public, anon;

grant execute on function public.bulk_update_assignment_roles(uuid,uuid[],text)
to authenticated;
