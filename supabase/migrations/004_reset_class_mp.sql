-- 선택한 학급의 활성 학생 MP를 0으로 초기화한다.
-- 기존 내역은 삭제하지 않고 학생별 음수 거래를 추가해 기록을 보존한다.

create or replace function public.reset_class_mp(p_class_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer := 0;
  rec record;
begin
  if not exists (
    select 1 from public.classes
    where id = p_class_id and owner_id = v_owner
  ) then
    raise exception '학급 접근 권한이 없습니다.';
  end if;

  if exists (
    select 1 from public.class_sessions
    where class_id = p_class_id
      and owner_id = v_owner
      and status = 'active'
  ) then
    raise exception '진행 중인 수업을 종료한 뒤 MP를 초기화해 주세요.';
  end if;

  for rec in
    select id, total_mp
    from public.students
    where class_id = p_class_id
      and owner_id = v_owner
      and active
      and total_mp <> 0
    for update
  loop
    insert into public.mp_transactions(
      owner_id, class_id, student_id, session_id,
      amount, base_amount, multiplier, reason, skill_key, group_no
    ) values (
      v_owner, p_class_id, rec.id, null,
      -rec.total_mp, -rec.total_mp, 1,
      '학급 MP 전체 초기화', 'mp_reset', null
    );

    update public.students
    set total_mp = 0
    where id = rec.id and owner_id = v_owner;

    v_count := v_count + 1;
  end loop;

  update public.assignments
  set role_started_mp = 0
  where owner_id = v_owner
    and student_id in (
      select id from public.students
      where class_id = p_class_id and owner_id = v_owner and active
    );

  return v_count;
end;
$$;

revoke execute on function public.reset_class_mp(uuid) from public, anon;
grant execute on function public.reset_class_mp(uuid) to authenticated;
