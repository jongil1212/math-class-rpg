-- 수승의 은혜 확장
-- 4인 모둠: 4번 -> 1번, 3번 -> 2번
-- 3인 모둠: 2번/3번 -> 1번
-- 수호자는 3번/4번 자리에 있을 때만 패시브 대상이 된다.

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
      and mentor.seat_index = case
        when (
          select count(*)
          from public.assignments as member
          where member.owner_id = p_owner_id
            and member.season_id = p_season_id
            and member.group_no = mentee.group_no
            and member.seat_index is not null
        ) = 3 and mentee.seat_index in (2, 3) then 1
        when mentee.seat_index = 3 then 2
        when mentee.seat_index = 4 then 1
        else null
      end
      and mentor.role in ('mentor', 'senior_mentor')
    limit 1
  )
  where mentee.owner_id = p_owner_id
    and mentee.season_id = p_season_id
    and mentee.role in ('beginner', 'disciple');
$$;

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
  v_mentee_role text;
  v_group_no integer;
  v_seat_index integer;
  v_group_member_count integer;
  v_mentor_seat_index integer;
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

  select
    student.name,
    mentee.role,
    mentee.group_no,
    mentee.seat_index,
    (
      select count(*)
      from public.assignments as member
      where member.owner_id = v_owner
        and member.season_id = v_session.season_id
        and member.group_no = mentee.group_no
        and member.seat_index is not null
    )
  into
    v_mentee_name,
    v_mentee_role,
    v_group_no,
    v_seat_index,
    v_group_member_count
  from public.assignments as mentee
  join public.students as student
    on student.id = mentee.student_id
   and student.owner_id = mentee.owner_id
   and student.active
  where mentee.owner_id = v_owner
    and mentee.season_id = v_session.season_id
    and mentee.student_id = p_student_id;

  if v_mentee_role in ('beginner', 'disciple') then
    if v_group_member_count = 3 and v_seat_index in (2, 3) then
      v_mentor_seat_index := 1;
    elsif v_seat_index = 3 then
      v_mentor_seat_index := 2;
    elsif v_seat_index = 4 then
      v_mentor_seat_index := 1;
    end if;
  elsif v_mentee_role = 'guardian' and v_seat_index in (3, 4) then
    if v_group_member_count = 3 and v_seat_index = 3 then
      v_mentor_seat_index := 1;
    elsif v_seat_index = 3 then
      v_mentor_seat_index := 2;
    else
      v_mentor_seat_index := 1;
    end if;
  end if;

  if v_mentor_seat_index is not null then
    select mentor.student_id
    into v_mentor_student_id
    from public.assignments as mentor
    where mentor.owner_id = v_owner
      and mentor.season_id = v_session.season_id
      and mentor.group_no = v_group_no
      and mentor.seat_index = v_mentor_seat_index
      and mentor.role in ('mentor', 'senior_mentor');
  end if;

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

revoke execute on function public.sync_seating_mentors(uuid,uuid)
from public, anon, authenticated;

revoke execute on function public.award_personal_mp(uuid,uuid,integer,text,text,integer,integer)
from public, anon;

grant execute on function public.award_personal_mp(uuid,uuid,integer,text,text,integer,integer)
to authenticated;
