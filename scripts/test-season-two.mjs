// Isolated PostgreSQL regression tests. Never connects to the real Supabase project.
// node scripts/test-season-two.mjs <directory containing @electric-sql/pglite>
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const packageDir = process.argv[2];
const { PGlite } = await import(packageDir ? pathToFileURL(join(packageDir, "dist/index.js")).href : "@electric-sql/pglite");
const { pgcrypto } = await import(packageDir ? pathToFileURL(join(packageDir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto");
const db = new PGlite({ extensions: { pgcrypto } });
const owner = randomUUID(), other = randomUUID();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const scalar = async (sql, args = []) => Object.values((await q(sql, args))[0])[0];
let passed = 0;
const ok = (label) => { passed++; console.log(`PASS ${label}`); };
const reject = (fn, text) => assert.rejects(fn, text);
const admin = () => db.exec("reset role");
async function login(id = owner) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
}
const mp = (id) => scalar("select total_mp from public.students where id=$1", [id]);
const skill = (id, session, key, target = null) => scalar("select public.use_season_two_skill($1,$2,$3,$4)", [id, session, key, target]);
const buy = (season, id, product) => scalar("select public.purchase_shop_coupon($1,$2,$3)", [season, id, product]);
const award = (id, session, base = 1, key = null) => q("select * from public.award_personal_mp($1,$2,$3,'test',$4,1)", [id, session, base, key]);

try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;`);
  await q("insert into auth.users values($1),($2)", [owner, other]);
  const directory = resolve("supabase/migrations");
  for (const file of (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(join(directory, file), "utf8"));
  }
  await db.exec(await readFile(join(directory, "009_season_two.sql"), "utf8"));
  // Supabase grants these original tables separately; new tables are select-only.
  await db.exec("grant select,insert,update,delete on public.classes,public.students,public.seasons,public.assignments,public.class_sessions,public.mp_transactions,public.skill_usages,public.promotion_events to authenticated");
  ok("001–009 migration syntax and idempotent 009");
  const classId = await scalar("insert into public.classes(owner_id,name,grade,class_number,academic_year) values($1,'Test',1,1,2026) returning id", [owner]);
  const season1 = await scalar("insert into public.seasons(owner_id,class_id,name,start_date,is_active) values($1,$2,'Season1',current_date,true) returning id", [owner,classId]);
  const students = [];
  for (let i = 1; i <= 8; i++) students.push(await scalar("insert into public.students(owner_id,class_id,student_number,name,total_mp) values($1,$2,$3,$4,$5) returning id", [owner,classId,i,`Student${i}`,i === 1 ? 35 : 70]));
  const roles = ["disciple","senior_mentor","guardian","disciple","senior_mentor","mentor","disciple","guardian"];
  for (let i=0; i<8; i++) await q("update public.assignments set role=$1,group_no=$2,seat_index=$3 where season_id=$4 and student_id=$5", [roles[i], i<4?1:2, i%4+1, season1,students[i]]);
  await login();
  const season2 = await scalar("select public.create_season_v2($1,'Season2',current_date,null,$2,2)", [classId,season1]);
  assert.equal(await mp(students[0]),35);
  assert.equal(await scalar("select rules_version from public.seasons where id=$1", [season1]),1);
  assert.equal(await scalar("select role from public.assignments where season_id=$1 and student_id=$2", [season2,students[0]]),"disciple");
  const assignment = (id) => scalar("select id from public.assignments where season_id=$1 and student_id=$2", [season2,id]);
  await reject(async () => scalar("select promote_student($1)",[await assignment(students[0])]), /40MP/);
  const session = await scalar("select id from public.start_class_session($1,$2)", [classId,season2]);
  await award(students[0],session,5);
  assert.equal(await mp(students[0]),40);
  assert.equal(await scalar("select promote_student($1)",[await assignment(students[0])]),"senior_disciple");
  assert.equal(await scalar("select promote_student($1)",[await assignment(students[4])]),"math_saint");
  ok("MP carry, 35+5=40 promotion, both new titles; Season1 unchanged");

  await skill(students[0],session,"duo_casting",students[3]);
  await reject(() => skill(students[0],session,"duo_casting",students[3]),/이미 사용/);
  await reject(() => skill(students[2],session,"presentation_steal",students[4]),/사용 가능한/);
  await reject(() => skill(students[0],session,"presentation_steal",students[4]),/사용 가능한/);
  ok("duo casting same-group participation and per-session limit; role authorization");

  await skill(students[7],session,"guardian_blessing");
  const before = await mp(students[4]);
  assert.match(await skill(students[0],session,"absorption_strike",students[4]),/막았습니다/);
  assert.equal(await mp(students[4]),before);
  assert.equal(await scalar("select count(*)::int from session_effects where kind='fortune'"),0);
  await reject(() => skill(students[0],session,"absorption_strike",students[4]),/이미 사용/);
  ok("shield consumes one attack, no MP loss/no fortune; blocked attack consumes usage");

  await scalar("select public.end_class_session($1)",[session]);
  const session2 = await scalar("select id from public.start_class_session($1,$2)",[classId,season2]);
  await scalar("select start_fever_time($1,'teacher')",[session2]);
  const casterBefore = await mp(students[0]);
  await skill(students[0],session2,"absorption_strike",students[4]);
  assert.equal(await mp(students[0]),casterBefore+1);
  assert.equal(await mp(students[4]),before-1);
  assert.equal(await scalar("select count(*)::int from session_effects where kind='fortune' and not consumed"),1);
  const effect = await scalar("select id from session_effects where kind='fortune' and not consumed");
  await scalar("select complete_session_effect($1)",[effect]);
  await reject(() => scalar("select complete_session_effect($1)",[effect]),/없습니다/);
  const attackTx = await scalar("select id from mp_transactions where student_id=$1 and skill_key='absorption_strike' and amount=1",[students[0]]);
  await reject(() => scalar("select reverse_mp_transaction($1,'test')",[attackTx]),/취소할 수/);
  ok("exact 1MP atomic transfer during fever; fortune flag/consume; prevent one-sided reversal");
  await scalar("select stop_fever_time($1)",[session2]);

  await skill(students[4],session2,"presentation_steal",students[1]);
  await reject(() => skill(students[4],session2,"presentation_steal",students[1]),/이미 사용/);
  await reject(() => award(students[0],session2,1,"mentor_prophecy"),/맞지 않는/);
  await award(students[0],session2,2,"eagle_eye_disciple");
  await reject(() => award(students[0],session2,2,"eagle_eye_disciple"),/이미 사용/);
  await award(students[4],session2,1,"eagle_eye_mentor");
  await award(students[4],session2,2,"mentor_prophecy");
  await scalar("select record_skill_usage($1,$2,'retry','test')",[students[0],session2]);
  await reject(() => scalar("select record_skill_usage($1,$2,'retry','test')",[students[0],session2]),/이미 사용/);
  ok("inherited skills, retry/steal/old active once per class, server-side skill validation");

  const saintBeforeGrace = await mp(students[4]);
  await award(students[7],session2,1,"never_give_up");
  assert.equal(await mp(students[4]),saintBeforeGrace+1);
  const mentorBeforeGrace = await mp(students[1]);
  await award(students[2],session2);
  assert.equal(await mp(students[1]),mentorBeforeGrace+1);
  await admin();
  await q("update assignments set group_no=null,seat_index=null where season_id=$1 and student_id=$2",[season2,students[5]]);
  await q("update assignments set role='senior_disciple',seat_index=2 where season_id=$1 and student_id=$2",[season2,students[6]]);
  await q("select sync_seating_mentors($1,$2)",[season2,owner]);
  await login();
  const saintBeforeThree = await mp(students[4]);
  await award(students[6],session2);
  assert.equal(await mp(students[4]),saintBeforeThree+1);
  assert.equal(await scalar("select mentor_student_id from assignments where season_id=$1 and student_id=$2",[season2,students[6]]),students[4]);
  const saintBeforeRelief = await mp(students[4]);
  const menteeBeforeRelief = await mp(students[6]);
  await scalar("select use_relief_pitcher($1,$2,$3)",[students[4],students[6],session2]);
  assert.equal(await mp(students[4]),saintBeforeRelief+2); // direct +1, passive +1
  assert.equal(await mp(students[6]),menteeBeforeRelief+1);
  await reject(() => scalar("select use_relief_pitcher($1,$2,$3)",[students[4],students[6],session2]),/이미 사용/);
  assert.equal(await mp(students[6]),menteeBeforeRelief+1);
  ok("guardian/senior disciple MP triggers saint grace; 3-person seat2 pairing; atomic relief/inherited once limit");

  await reject(() => buy(season2,students[4],"snack_draw"),/닫혀/);
  await scalar("select set_shop_open($1,true)",[season2]);
  await reject(() => buy(season2,students[0],"early_finish"),/부족/);
  await buy(season2,students[0],"presentation_priority");
  await reject(() => buy(season2,students[0],"presentation_priority"),/부족/);
  const cookie = await buy(season2,students[4],"snack_draw");
  const totalBeforeBuy = await mp(students[4]);
  const hint = await buy(season2,students[4],"teacher_hint");
  assert.equal(await mp(students[4]),totalBeforeBuy);
  const guardian = await buy(season2,students[7],"early_finish");
  assert.equal(await scalar("select reserved_mp from shop_accounts where student_id=$1",[students[7]]),30);
  const guardianTotal = await mp(students[7]);
  await scalar("select set_shop_open($1,false)",[season2]);
  await scalar("select use_shop_coupon($1,$2)",[guardian,session2]);
  assert.equal(await mp(students[7]),guardianTotal);
  await reject(() => scalar("select use_shop_coupon($1,$2)",[guardian,session2]),/미사용/);
  await reject(() => scalar("select refund_shop_coupon($1)",[guardian]),/미사용/);
  await scalar("select refund_shop_coupon($1)",[cookie]);
  await reject(() => scalar("select refund_shop_coupon($1)",[cookie]),/미사용/);
  assert.equal(await scalar("select sum(cost)::int from shop_coupons where student_id=$1 and status<>'refunded'",[students[4]]),4);
  ok("shop open/close, correct prices and reserves, purchase keeps cumulative MP, closed shop redemption/refund, single use");

  await scalar("select set_shop_open($1,true)",[season2]);
  const fever = await buy(season2,students[4],"fever_request");
  await scalar("select start_fever_time($1,'teacher')",[session2]);
  await reject(() => scalar("select use_shop_coupon($1,$2)",[fever,session2]),/진행 중/);
  assert.equal(await scalar("select status from shop_coupons where id=$1",[fever]),"unused");
  await scalar("select stop_fever_time($1)",[session2]);
  await scalar("select use_shop_coupon($1,$2)",[fever,session2]);
  assert.equal(await scalar("select fever_source from class_sessions where id=$1",[session2]),"teacher");
  assert.equal(await scalar("select count(*)::int from fever_time_activations where source='guardian'"),0);
  ok("coupon fever atomic approval, failed approval preserves coupon, no guardian quota");

  await login(other);
  await reject(() => buy(season2,students[4],"snack_draw"),/접근 권한/);
  await reject(() => scalar("select use_shop_coupon($1,$2)",[hint,session2]),/진행 중/);
  assert.equal((await q("select * from shop_coupons")).length,0);
  await reject(() => scalar("select award_mp_v1($1,$2,1,'test',null,1,null)",[students[4],session2]),/permission denied/);
  await reject(() => q("update shop_coupons set status='refunded'"),/permission denied/);
  ok("owner isolation/RLS, internal RPC and direct shop writes denied");
  await login();
  await scalar("select end_class_session($1)",[session2]);
  const session3 = await scalar("select id from start_class_session($1,$2)",[classId,season2]);
  await reject(() => skill(students[0],session3,"duo_casting",students[4]),/같은 모둠/);
  await reject(() => skill(students[0],session3,"absorption_strike",students[1]),/다른 모둠/);
  await admin();
  await q("update students set total_mp=0 where id=$1",[students[4]]);
  await login();
  await reject(() => skill(students[0],session3,"absorption_strike",students[4]),/0이라/);
  assert.equal(await scalar("select count(*)::int from skill_usages where student_id=$1 and session_id=$2 and skill_key='absorption_strike'",[students[0],session3]),0);
  await award(students[4],session3);
  await skill(students[0],session3,"absorption_strike",students[4]);
  assert.equal(await mp(students[4]),0);
  await reject(() => scalar("select create_season_v2($1,'Bad',current_date,null,$2,2)",[classId,season2]),/수업 종료/);
  await scalar("select end_class_session($1)",[session3]);
  ok("invalid targets/zero-MP attack rollback, usage reset in new session, no season transition during class");
  await scalar("select bulk_update_assignment_roles($1,$2::uuid[],'mentor')",[season2,[await assignment(students[7])]]);
  assert.equal(await scalar("select reserved_mp from shop_accounts where student_id=$1",[students[7]]),30);
  const season3 = await scalar("select create_season_v2($1,'Next',current_date,null,$2,2)",[classId,season2]);
  assert.equal(await scalar("select sum(cost)::int from shop_coupons where student_id=$1 and status<>'refunded'",[students[7]]),20);
  await reject(() => buy(season2,students[4],"snack_draw"),/닫혀/);
  await reject(() => scalar("select start_class_session($1,$2)",[classId,season2]),/현재 운영/);
  await reject(() => scalar("select reset_class_mp($1)",[classId]),/상점 구매/);
  assert.equal(await scalar("select role from assignments where season_id=$1 and student_id=$2",[season3,students[0]]),"senior_disciple");
  ok("next-season rank/spending carry, fixed first-purchase reserve, no old-season purchase/destructive wallet reset");
  console.log(`\n${passed} regression groups passed.`);
} finally { await db.close(); }
