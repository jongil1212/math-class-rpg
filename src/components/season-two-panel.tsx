"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PRODUCTS, shopBalance, type Coupon, type SessionEffect, type ShopAccount } from "@/lib/season-two";
import type { AssignmentWithStudent, ClassSession, Season } from "@/types/app";
import type { SkillAction } from "@/lib/skills";

function message(error: unknown) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : "처리하지 못했습니다. 다시 시도해 주세요.";
}

export function SeasonTwoPanel({ season, assignments, session, revision, onChange }: {
  season: Season; assignments: AssignmentWithStudent[]; session: ClassSession | null;
  revision: number; onChange: () => Promise<void>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [accounts, setAccounts] = useState<ShopAccount[]>([]);
  const [effects, setEffects] = useState<SessionEffect[]>([]);
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const currentSession = session?.season_id === season.id ? session : null;
  const load = useCallback(async () => {
    const [c, a, e] = await Promise.all([
      supabase.from("shop_coupons").select("*").eq("class_id", season.class_id).order("created_at", { ascending: false }),
      supabase.from("shop_accounts").select("*").eq("class_id", season.class_id),
      currentSession ? supabase.from("session_effects").select("*").eq("session_id", currentSession.id).order("created_at") : Promise.resolve({ data: [], error: null }),
    ]);
    if (c.error || a.error || e.error) throw c.error || a.error || e.error;
    setCoupons((c.data ?? []) as Coupon[]);
    setAccounts((a.data ?? []) as ShopAccount[]);
    setEffects((e.data ?? []) as SessionEffect[]);
    setLoaded(true);
  }, [supabase, season.class_id, currentSession]);
  useEffect(() => {
    // Remote state is refreshed after classroom actions and on session changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((error) => { setLoaded(false); setNotice(message(error)); });
  }, [load, revision]);

  const selected = assignments.find((a) => a.student_id === studentId);
  const owned = coupons.filter((c) => c.student_id === studentId);
  const reserved = accounts.find((a) => a.student_id === studentId)?.reserved_mp ?? (selected?.role === "guardian" ? 30 : 40);
  const balance = selected ? shopBalance(selected.student.total_mp, reserved, owned) : 0;
  const names = new Map(assignments.map((a) => [a.student_id, a.student.name]));
  const usable = season.is_active && !season.archived_at;

  async function act(name: string, args: Record<string, unknown>, success: string) {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const { error } = await supabase.rpc(name, args);
      if (error) throw error;
      await onChange(); await load(); setNotice(success);
    } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }

  return <section className="board-card season-two-panel" aria-label="시즌 2 상점과 발표 효과">
    <div className="season-two-heading">
      <h2>시즌 2 · MP 상점</h2>
      <button className={`btn ${season.shop_open ? "btn-danger" : "btn-primary"}`} disabled={busy || !usable || !loaded}
        onClick={() => act("set_shop_open", { p_season_id: season.id, p_open: !season.shop_open }, season.shop_open ? "상점을 닫았습니다. 보유 사용권은 계속 사용할 수 있습니다." : "상점을 열었습니다.")}>
        {season.shop_open ? "상점 닫기" : "상점 열기"}
      </button>
    </div>
    <p className="quick-note">구매는 상점이 열렸을 때만 가능합니다. 누적 MP·칭호는 구매해도 유지됩니다. 일반 계열은 40MP, 수호자는 30MP를 제외한 잔액을 사용합니다. 첫 구매 시 기준이 고정되어 시즌이 바뀌어도 지출과 사용권이 승계됩니다.</p>
    <div className="field">
      <label htmlFor="shop-student">구매·사용권 관리 학생</label>
      <select id="shop-student" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
        <option value="">학생 선택</option>
        {assignments.map((a) => <option key={a.student_id} value={a.student_id}>{a.student.student_number}번 {a.student.name}</option>)}
      </select>
    </div>
    {selected && <>
      <div className="summary-box">누적 {selected.student.total_mp}MP · 성장 확보 {reserved}MP · <strong>구매 가능 {balance}MP</strong></div>
      <div className="shop-products">
        {PRODUCTS.map((product) => <button key={product.key} className="action-card" disabled={busy || !loaded || !usable || !season.shop_open || balance < product.cost}
          onClick={() => {
            if (window.confirm(`${selected.student.name} 학생이 ${product.name}을 ${product.cost}MP로 구매할까요?\n구매 가능 잔액에서 차감되며 누적 MP는 유지됩니다.`))
              void act("purchase_shop_coupon", { p_season_id: season.id, p_student_id: studentId, p_product_key: product.key }, "구매했습니다. 미사용 사용권에 추가되었습니다.");
          }}>
          <strong>{product.name} · {product.cost}MP</strong><span>{product.description}</span>
        </button>)}
      </div>
      <h3>보유 사용권·구매 기록</h3>
      <p className="quick-note">사용 요청은 교사가 승인할 때만 아래 버튼을 누릅니다. 보류할 경우 미사용 상태를 유지하세요. 조기 종료권은 반 전체에 적용되며 자동으로 수업을 종료하지 않습니다.</p>
      {owned.length === 0 && <p>구매 기록이 없습니다.</p>}
      <div className="coupon-list">
        {owned.map((c) => {
          const product = PRODUCTS.find((p) => p.key === c.product_key);
          return <div className="coupon-row" key={c.id}>
            <div><strong>{product?.name} · {c.cost}MP</strong><br /><small>{new Date(c.created_at).toLocaleDateString("ko-KR")} · {c.status === "unused" ? "미사용" : c.status === "used" ? "사용 완료" : "환불 완료"}</small></div>
            {c.status === "unused" && <div className="coupon-actions">
              <button className="btn btn-soft btn-small" disabled={busy || !usable || !currentSession}
                onClick={() => {
                  if (window.confirm(`${selected.student.name} 학생의 ${product?.name} 사용을 오늘 수업에서 승인할까요?${c.product_key === "early_finish" ? "\n반 전체가 10분 일찍 마치는 것으로 기록합니다." : ""}`))
                    void act("use_shop_coupon", { p_coupon_id: c.id, p_session_id: currentSession?.id }, "사용을 승인하고 기록했습니다.");
                }}>사용 승인</button>
              <button className="btn btn-ghost btn-small" disabled={busy || !usable} onClick={() => {
                if (window.confirm("이 미사용권을 환불할까요? 구매 가능 MP가 복구됩니다."))
                  void act("refund_shop_coupon", { p_coupon_id: c.id }, "환불했습니다.");
              }}>환불</button>
            </div>}
          </div>;
        })}
      </div>
    </>}
    {currentSession && <>
      <h3>이번 수업 보호·발표 효과</h3>
      <p className="quick-note">전화위복은 다음 활동의 최우선 발표권입니다. 발표권·듀오 캐스팅은 실제 진행 후 완료 처리하세요. 수호자의 가호는 공격을 막을 때 자동으로 소모됩니다. 새 수업을 시작하면 효과와 스킬 횟수가 새로 시작됩니다.</p>
      {effects.length === 0 && <p>적용된 효과가 없습니다.</p>}
      {effects.map((e) => <div className={`coupon-row ${e.consumed ? "effect-completed" : ""}`} key={e.id}>
        <div><strong>{e.kind === "shield" ? `${e.group_no}모둠 · 수호자의 가호` : names.get(e.student_id)}{e.target_student_id ? ` → ${names.get(e.target_student_id) ?? "학생"}` : ""}</strong><br /><small>{e.note} · {e.consumed ? "완료/소모" : "대기"}</small></div>
        {!e.consumed && e.kind !== "shield" && <button className="btn btn-soft btn-small" disabled={busy} onClick={() => act("complete_session_effect", { p_effect_id: e.id }, "발표 효과를 완료 처리했습니다.")}>진행 완료</button>}
      </div>)}
    </>}
    {notice && <p className="warning-box" role="status">{notice}</p>}
  </section>;
}

export function SeasonTwoSkillActions({ assignment, assignments, session, skills, usedKeys, busy, onChange }: {
  assignment: AssignmentWithStudent; assignments: AssignmentWithStudent[]; session: ClassSession | null;
  skills: SkillAction[]; usedKeys: Set<string>; busy: boolean; onChange: () => Promise<void>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [skillKey, setSkillKey] = useState("");
  const [targetId, setTargetId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const targets = assignments.filter((a) => a.student_id !== assignment.student_id && a.group_no !== null && (
    skillKey === "duo_casting" ? a.group_no === assignment.group_no : skillKey === "absorption_strike"
      ? a.group_no !== assignment.group_no && ["mentor", "senior_mentor", "math_saint"].includes(a.role) : true
  ));
  async function applySkill(key: string, target: string | null) {
    if (!session || pending) return;
    const label = skills.find((s) => s.key === key)?.label;
    if (!window.confirm(`${label}을 사용할까요? 수업당 1회입니다.${key === "absorption_strike" ? "\n완벽한 발표에 성공한 경우에만 사용합니다. 공격이 막혀도 사용 횟수는 소모됩니다." : ""}`)) return;
    setPending(true); setNotice("");
    try {
      const { data, error } = await supabase.rpc("use_season_two_skill", { p_student_id: assignment.student_id, p_session_id: session.id, p_skill_key: key, p_target_id: target });
      if (error) throw error;
      await onChange(); setSkillKey(""); setTargetId(""); setNotice(String(data));
    } catch (error) { setNotice(message(error)); } finally { setPending(false); }
  }
  return <>
    <div className="action-grid">
      {skills.map((skill) => <button className="action-card" key={skill.key} disabled={!session || busy || pending || usedKeys.has(skill.key)}
        onClick={() => {
          if (skill.key === "guardian_blessing") void applySkill(skill.key, null);
          else { setSkillKey(skill.key); setTargetId(""); }
        }}><strong>{skill.label}{usedKeys.has(skill.key) ? " · 사용 완료" : ""}</strong><span>{skill.description}</span></button>)}
    </div>
    {skillKey && <div className="form-stack skill-target">
      <label htmlFor="skill-target">{skills.find((s) => s.key === skillKey)?.label} 대상</label>
      <select id="skill-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
        <option value="">학생 선택</option>
        {targets.map((a) => <option key={a.student_id} value={a.student_id}>{a.group_no}모둠 · {a.student.name}</option>)}
      </select>
      {targets.length === 0 && <p className="quick-note">조건에 맞는 학생이 없습니다. 모둠 배치와 역할을 확인해 주세요.</p>}
      <button className="btn btn-primary" disabled={!targetId || busy || pending || usedKeys.has(skillKey)} onClick={() => applySkill(skillKey, targetId)}>스킬 적용</button>
    </div>}
    {notice && <p className="warning-box" role="status">{notice}</p>}
  </>;
}
