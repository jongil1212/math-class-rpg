-- 좌석 기반 패시브 스킬: 수승의 은혜
-- 같은 모둠의 1번-4번, 2번-3번을 각각 멘토-멘티 쌍으로 본다.
-- 3·4번 입문자/수제자에게 개인 MP가 지급되면 짝 수승님에게 기본 1MP를 자동 지급한다.

create or replace function public.award_personal_mp(
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
  v_session public.class_sessions;
  v_tx public.mp_transactions;
  v_mentor_student_id uuid;
  v_mentee_name text;
  v_group_no integer;
begin
  select * into v_session
  from public.class_sessions
  where id = p_session_id
    and owner_id = v_owner
    and status = 'active';

  if v_session.id is null then
    raise exception '진행 중인 수업을 찾을 수 없습니다.';
  end if;

  v_tx := public.award_mp(
    p_student_id,
    p_session_id,
    p_base_amount,
    p_reason,
    p_skill_key,
    p_extra_multiplier,
    p_group_no
  );

  select mentor.student_id, student.name, mentee.group_no
  into v_mentor_student_id, v_mentee_name, v_group_no
  from public.assignments mentee
  join public.assignments mentor
    on mentor.owner_id = mentee.owner_id
   and mentor.season_id = mentee.season_id
   and mentor.group_no = mentee.group_no
   and mentor.seat_index = case mentee.seat_index when 3 then 2 when 4 then 1 end
   and mentor.role in ('mentor', 'senior_mentor')
  join public.students student
    on student.id = mentee.student_id
   and student.owner_id = mentee.owner_id
   and student.active
  where mentee.owner_id = v_owner
    and mentee.season_id = v_session.season_id
    and mentee.student_id = p_student_id
    and mentee.seat_index in (3, 4)
    and mentee.role in ('beginner', 'disciple');

  if v_mentor_student_id is not null then
    perform public.award_mp(
      v_mentor_student_id,
      p_session_id,
      1,
      '수승의 은혜 · ' || v_mentee_name || ' 개인 MP 획득',
      'mentor_grace',
      1,
      v_group_no
    );
  end if;

  return v_tx;
end;
$$;

revoke execute on function public.award_personal_mp(uuid,uuid,integer,text,text,integer,integer)
from public, anon;

grant execute on function public.award_personal_mp(uuid,uuid,integer,text,text,integer,integer)
to authenticated;
