"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SeatingBoard from "@/components/seating-board";
import { createClient } from "@/lib/supabase/browser";
import { SKILLS_BY_ROLE, type SkillAction } from "@/lib/skills";
import {
  ROLE_LABELS,
  ROLE_ORDER,
  type Assignment,
  type AssignmentWithStudent,
  type Classroom,
  type ClassSession,
  type MpTransaction,
  type Role,
  type Season,
  type SeatPosition,
  type Student,
} from "@/types/app";

type Toast = { message: string; kind: "success" | "error" } | null;
type ModalName = "class" | "classManage" | "students" | "season" | "seasonManage" | "student" | null;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function currentAcademicYear() {
  return new Date().getFullYear();
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

function roleProgress(assignment: AssignmentWithStudent) {
  return assignment.student.total_mp - assignment.role_started_mp;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseStudentLines(raw: string) {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s*[,\t ]\s*(.+)$/);
      if (!match) return null;
      return { student_number: Number(match[1]), name: match[2].trim() };
    })
    .filter((row): row is { student_number: number; name: string } => Boolean(row));

  const unique = new Map<number, string>();
  rows.forEach((row) => unique.set(row.student_number, row.name));
  return [...unique.entries()]
    .map(([student_number, name]) => ({ student_number, name }))
    .sort((a, b) => a.student_number - b.student_number);
}

export default function DashboardClient({ email }: { email: string }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [classes, setClasses] = useState<Classroom[]>([]);
  const [academicYear, setAcademicYear] = useState<number | null>(null);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [assignments, setAssignments] = useState<AssignmentWithStudent[]>([]);
  const [draftAssignments, setDraftAssignments] = useState<AssignmentWithStudent[]>([]);
  const [session, setSession] = useState<ClassSession | null>(null);
  const [transactions, setTransactions] = useState<MpTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [roleEditMode, setRoleEditMode] = useState(false);
  const [selectedRoleStudentIds, setSelectedRoleStudentIds] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<ModalName>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<AssignmentWithStudent | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [now, setNow] = useState(() => Date.now());

  const selectedClass = classes.find((item) => item.id === selectedClassId) ?? null;
  const selectedSeason = seasons.find((item) => item.id === selectedSeasonId) ?? null;
  const activeClasses = classes.filter((item) => !item.archived_at);
  const academicYears = [...new Set(activeClasses.map((item) => item.academic_year))].sort((a, b) => b - a);
  const visibleAcademicYear =
    academicYear ?? selectedClass?.academic_year ?? academicYears[0] ?? currentAcademicYear();
  const visibleClasses = activeClasses.filter((item) => item.academic_year === visibleAcademicYear);
  const visibleSeasons = seasons.filter((item) => !item.archived_at);
  const visibleAssignments = editMode ? draftAssignments : assignments;
  const selectedRoleAssignments = useMemo(
    () => assignments.filter((item) => selectedRoleStudentIds.has(item.student_id)),
    [assignments, selectedRoleStudentIds],
  );
  const hasSeatingChanges = useMemo(() => {
    if (!editMode) return false;
    if (assignments.length !== draftAssignments.length) return true;
    const savedPositions = new Map(
      assignments.map((item) => [
        item.student_id,
        `${item.group_no ?? "unassigned"}:${item.seat_index ?? "unassigned"}`,
      ]),
    );
    return draftAssignments.some(
      (item) =>
        savedPositions.get(item.student_id) !==
        `${item.group_no ?? "unassigned"}:${item.seat_index ?? "unassigned"}`,
    );
  }, [assignments, draftAssignments, editMode]);

  const activeFever = useMemo(() => {
    if (!session?.fever_started_at || session.fever_ended_at) return null;
    const started = new Date(session.fever_started_at).getTime();
    const ends = started + 10 * 60 * 1000;
    if (now >= ends) return null;
    return { started, ends, remaining: ends - now };
  }, [session, now]);

  const feverText = activeFever
    ? `${String(Math.floor(activeFever.remaining / 60000)).padStart(2, "0")}:${String(
        Math.floor((activeFever.remaining % 60000) / 1000),
      ).padStart(2, "0")}`
    : null;

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const loadClasses = useCallback(async () => {
    const { data, error } = await supabase
      .from("classes")
      .select("*")
      .order("academic_year", { ascending: false })
      .order("grade")
      .order("class_number");
    if (error) throw error;
    const list = (data ?? []) as Classroom[];
    setClasses(list);
    const selectable = list.filter((item) => !item.archived_at);
    setSelectedClassId((current) => {
      if (current && selectable.some((item) => item.id === current)) return current;
      const saved = window.localStorage.getItem("math-rpg-class-id");
      return (saved && selectable.some((item) => item.id === saved) ? saved : selectable[0]?.id) ?? "";
    });
  }, [supabase]);

  const loadClassData = useCallback(
    async (classId: string) => {
      if (!classId) {
        setSeasons([]);
        setStudents([]);
        setAssignments([]);
        setSession(null);
        setTransactions([]);
        return;
      }

      setLoading(true);
      try {
        const [seasonResult, studentResult, sessionResult, txResult] = await Promise.all([
          supabase.from("seasons").select("*").eq("class_id", classId).order("start_date", { ascending: false }),
          supabase.from("students").select("*").eq("class_id", classId).eq("active", true).order("student_number"),
          supabase.from("class_sessions").select("*").eq("class_id", classId).eq("status", "active").maybeSingle(),
          supabase.from("mp_transactions").select("*").eq("class_id", classId).order("created_at", { ascending: false }).limit(30),
        ]);

        if (seasonResult.error) throw seasonResult.error;
        if (studentResult.error) throw studentResult.error;
        if (sessionResult.error) throw sessionResult.error;
        if (txResult.error) throw txResult.error;

        const seasonList = (seasonResult.data ?? []) as Season[];
        const studentList = (studentResult.data ?? []) as Student[];
        setSeasons(seasonList);
        setStudents(studentList);
        setSession((sessionResult.data as ClassSession | null) ?? null);
        setTransactions((txResult.data ?? []) as MpTransaction[]);

        const selectableSeasons = seasonList.filter((item) => !item.archived_at);
        setSelectedSeasonId((current) => {
          if (current && selectableSeasons.some((item) => item.id === current)) return current;
          return selectableSeasons.find((item) => item.is_active)?.id ?? selectableSeasons[0]?.id ?? "";
        });
      } finally {
        setLoading(false);
      }
    },
    [supabase],
  );

  const loadAssignments = useCallback(
    async (seasonId: string, studentList: Student[] = students) => {
      if (!seasonId) {
        setAssignments([]);
        setDraftAssignments([]);
        return;
      }
      const { data, error } = await supabase.from("assignments").select("*").eq("season_id", seasonId);
      if (error) throw error;
      const studentMap = new Map(studentList.map((student) => [student.id, student]));
      const joined = ((data ?? []) as Assignment[])
        .map((assignment) => {
          const student = studentMap.get(assignment.student_id);
          return student ? ({ ...assignment, student } satisfies AssignmentWithStudent) : null;
        })
        .filter((item): item is AssignmentWithStudent => Boolean(item))
        .sort((a, b) => a.student.student_number - b.student.student_number);
      setAssignments(joined);
      setDraftAssignments(joined.map((item) => ({ ...item, student: { ...item.student } })));
    },
    [students, supabase],
  );

  async function refreshAll() {
    if (!selectedClassId) return;
    const { data: freshStudents, error: studentError } = await supabase
      .from("students")
      .select("*")
      .eq("class_id", selectedClassId)
      .eq("active", true)
      .order("student_number");
    if (studentError) throw studentError;
    const studentList = (freshStudents ?? []) as Student[];
    setStudents(studentList);

    if (selectedSeasonId) await loadAssignments(selectedSeasonId, studentList);

    const [sessionResult, txResult, seasonResult] = await Promise.all([
      supabase.from("class_sessions").select("*").eq("class_id", selectedClassId).eq("status", "active").maybeSingle(),
      supabase.from("mp_transactions").select("*").eq("class_id", selectedClassId).order("created_at", { ascending: false }).limit(30),
      supabase.from("seasons").select("*").eq("class_id", selectedClassId).order("start_date", { ascending: false }),
    ]);
    if (sessionResult.error) throw sessionResult.error;
    if (txResult.error) throw txResult.error;
    if (seasonResult.error) throw seasonResult.error;
    setSession((sessionResult.data as ClassSession | null) ?? null);
    setTransactions((txResult.data ?? []) as MpTransaction[]);
    setSeasons((seasonResult.data ?? []) as Season[]);
  }

  useEffect(() => {
    // Initial remote data is loaded when the client dashboard mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadClasses().catch((error) => notify(error.message, "error"));
  }, [loadClasses, notify]);

  useEffect(() => {
    if (!selectedClassId) {
      // No class means there is no class-specific loading work to wait for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    window.localStorage.setItem("math-rpg-class-id", selectedClassId);
    loadClassData(selectedClassId).catch((error) => notify(error.message, "error"));
  }, [selectedClassId, loadClassData, notify]);

  useEffect(() => {
    if (!selectedSeasonId) return;
    // Assignment data is synchronized whenever the selected season changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAssignments(selectedSeasonId).catch((error) => notify(error.message, "error"));
  }, [selectedSeasonId, loadAssignments, notify]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  function handlePlanChange(studentId: string, target: SeatPosition, swapStudentId?: string) {
    setDraftAssignments((current) => {
      const dragged = current.find((item) => item.student_id === studentId);
      if (!dragged) return current;
      const origin = { groupNo: dragged.group_no, seatIndex: dragged.seat_index };

      return current.map((item) => {
        if (item.student_id === studentId) {
          return { ...item, group_no: target.groupNo, seat_index: target.seatIndex };
        }
        if (swapStudentId && item.student_id === swapStudentId) {
          return { ...item, group_no: origin.groupNo, seat_index: origin.seatIndex };
        }
        return item;
      });
    });
  }

  async function saveSeatingPlan() {
    if (!selectedSeasonId) return;
    setBusy(true);
    try {
      const plan = draftAssignments.map((item) => ({
        student_id: item.student_id,
        group_no: item.group_no,
        seat_index: item.seat_index,
      }));
      const { error } = await supabase.rpc("save_seating_plan", {
        p_season_id: selectedSeasonId,
        p_plan: plan,
      });
      if (error) throw error;
      setEditMode(false);
      await refreshAll();
      notify("모둠 배치를 저장했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "배치 저장에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  function cancelSeatingPlan() {
    setDraftAssignments(assignments.map((item) => ({ ...item, student: { ...item.student } })));
    setEditMode(false);
  }

  async function startSession() {
    if (!selectedClassId || !selectedSeasonId) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("start_class_session", {
        p_class_id: selectedClassId,
        p_season_id: selectedSeasonId,
      });
      if (error) throw error;
      await refreshAll();
      notify("오늘 수업을 시작했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "수업을 시작하지 못했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function endSession() {
    if (!session || !window.confirm("오늘 수업을 종료할까요?")) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("end_class_session", { p_session_id: session.id });
      if (error) throw error;
      await refreshAll();
      notify("수업을 종료했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "수업을 종료하지 못했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function startFever() {
    if (!session) return;
    if (!assignments.some((item) => item.role === "guardian")) {
      notify("현재 배치에 수호자가 없습니다.", "error");
      return;
    }
    if (!window.confirm("피버 타임을 시작할까요? 10분 동안 모든 MP가 2배로 계산됩니다.")) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("start_fever_time", { p_session_id: session.id });
      if (error) throw error;
      await refreshAll();
      notify("피버 타임을 시작했습니다!");
    } catch (error) {
      notify(error instanceof Error ? error.message : "피버 타임을 시작하지 못했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function stopFever() {
    if (!session) return;
    const { error } = await supabase.rpc("stop_fever_time", { p_session_id: session.id });
    if (error) notify(error.message, "error");
    else {
      await refreshAll();
      notify("피버 타임을 종료했습니다.");
    }
  }

  async function awardStudent(
    assignment: AssignmentWithStudent,
    baseAmount: number,
    reason: string,
    skillKey: string | null = null,
    extraMultiplier: 1 | 2 = 1,
  ) {
    if (!session) {
      notify("먼저 오늘 수업을 시작해 주세요.", "error");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("award_personal_mp", {
        p_student_id: assignment.student_id,
        p_session_id: session.id,
        p_base_amount: baseAmount,
        p_reason: reason,
        p_skill_key: skillKey,
        p_extra_multiplier: extraMultiplier,
        p_group_no: assignment.group_no,
      });
      if (error) throw error;
      await refreshAll();
      const feverSuffix = activeFever ? " · 피버 타임 적용" : "";
      notify(`${assignment.student.name} 학생에게 MP를 지급했습니다${feverSuffix}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "MP 지급에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function awardGroup(groupNo: number, amount: number) {
    if (!session || !selectedSeasonId) {
      notify("먼저 오늘 수업을 시작해 주세요.", "error");
      return;
    }
    const memberCount = assignments.filter((item) => item.group_no === groupNo).length;
    if (memberCount === 0) {
      notify("해당 모둠에 배치된 학생이 없습니다.", "error");
      return;
    }
    if (!window.confirm(`${groupNo}모둠 ${memberCount}명에게 기본 +${amount}MP를 지급할까요?`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("award_group_mp", {
        p_season_id: selectedSeasonId,
        p_session_id: session.id,
        p_group_no: groupNo,
        p_base_amount: amount,
        p_reason: `모둠 활동 점수 ${amount}점`,
      });
      if (error) throw error;
      await refreshAll();
      notify(`${groupNo}모둠 전원에게 MP를 지급했습니다.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "모둠 MP 지급에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function recordUsage(assignment: AssignmentWithStudent, skill: SkillAction) {
    if (!session) {
      notify("먼저 오늘 수업을 시작해 주세요.", "error");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("record_skill_usage", {
        p_student_id: assignment.student_id,
        p_session_id: session.id,
        p_skill_key: skill.key,
        p_note: skill.label,
      });
      if (error) throw error;
      notify(`${skill.label} 사용을 기록했습니다.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "스킬 기록에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSkill(assignment: AssignmentWithStudent, skill: SkillAction) {
    if (skill.passive) return;

    if (skill.usageOnly) {
      await recordUsage(assignment, skill);
      return;
    }

    if (skill.key === "beginner_luck") {
      const raw = window.prompt("발표 성공의 기본 MP를 입력하세요.", "1");
      if (!raw) return;
      const base = Number(raw);
      if (!Number.isInteger(base) || base <= 0) {
        notify("올바른 기본 MP를 입력해 주세요.", "error");
        return;
      }
      await awardStudent(assignment, base, "발표 성공 · 초심자의 행운", skill.key, 2);
      return;
    }

    if (skill.pairedAward) {
      const disciples = assignments.filter(
        (item) => item.mentor_student_id === assignment.student_id && ["beginner", "disciple"].includes(item.role),
      );
      if (disciples.length === 0) {
        notify("이 수승님에게 연결된 입문자·수제자가 없습니다.", "error");
        return;
      }
      const target =
        disciples.length === 1
          ? disciples[0]
          : disciples.find((item) =>
              window.confirm(`${item.student.name} 학생에게 구원투수 MP를 함께 지급할까요?`),
            );
      if (!target) return;
      await awardStudent(assignment, 1, "구원투수", skill.key, 1);
      await awardStudent(target, 1, "구원투수 도움받음", "relief_pitcher_helped", 1);
      return;
    }

    await awardStudent(assignment, skill.baseAmount ?? 1, skill.label, skill.key, 1);
  }

  async function reverseTransaction(tx: MpTransaction) {
    if (tx.is_reversed || tx.amount <= 0) return;
    const reason = window.prompt("취소 사유를 입력하세요.", "입력 오류") ?? "";
    setBusy(true);
    try {
      const { error } = await supabase.rpc("reverse_mp_transaction", {
        p_transaction_id: tx.id,
        p_reason: reason,
      });
      if (error) throw error;
      await refreshAll();
      notify("MP 지급 기록을 취소했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "취소 처리에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function resetClassMp() {
    if (!selectedClassId || !selectedClass) return;
    const studentsWithMp = students.filter((student) => student.total_mp !== 0);
    if (studentsWithMp.length === 0) {
      notify("초기화할 MP가 없습니다.", "error");
      return;
    }

    const totalMp = studentsWithMp.reduce((sum, student) => sum + student.total_mp, 0);
    const confirmation = window.prompt(
      `${selectedClass.name} 학생 ${studentsWithMp.length}명의 MP 합계 ${totalMp}점을 모두 0으로 초기화합니다.\n기존 기록은 보존됩니다.\n\n계속하려면 '초기화'를 입력하세요.`,
      "",
    );
    if (confirmation?.trim() !== "초기화") return;

    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("reset_class_mp", {
        p_class_id: selectedClassId,
      });
      if (error) throw error;
      await refreshAll();
      notify(`${Number(data) || studentsWithMp.length}명의 MP를 초기화했습니다.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "MP 초기화에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function promote(assignment: AssignmentWithStudent) {
    if (!window.confirm(`${assignment.student.name} 학생을 ${assignment.role === "beginner" ? "수제자" : "상급 수승님"}로 승급할까요?`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("promote_student", { p_assignment_id: assignment.id });
      if (error) throw error;
      await refreshAll();
      setSelectedAssignment(null);
      setModal(null);
      notify("승급 처리를 완료했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "승급 처리에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createClass(payload: {
    name: string;
    academicYear: number;
    grade: number;
    classNumber: number;
    seasonName: string;
    startDate: string;
    endDate: string;
    copyStudentsFromClassId: string | null;
  }) {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("create_academic_class_with_season", {
        p_name: payload.name,
        p_academic_year: payload.academicYear,
        p_grade: payload.grade,
        p_class_number: payload.classNumber,
        p_season_name: payload.seasonName,
        p_start_date: payload.startDate,
        p_end_date: payload.endDate || null,
        p_copy_students_from_class_id: payload.copyStudentsFromClassId,
      });
      if (error) throw error;
      setModal(null);
      await loadClasses();
      if (typeof data === "string") {
        setAcademicYear(payload.academicYear);
        setSelectedClassId(data);
      }
      notify("학급을 생성했습니다.");
    } catch (error) {
      notify(errorMessage(error, "학급 생성에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function addStudents(raw: string) {
    if (!selectedClassId) return;
    const parsed = parseStudentLines(raw);
    if (parsed.length === 0) {
      notify("'번호, 이름' 형식으로 학생을 입력해 주세요.", "error");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("bulk_add_students", {
        p_class_id: selectedClassId,
        p_students: parsed,
      });
      if (error) throw error;
      setModal(null);
      await refreshAll();
      notify(`${parsed.length}명의 명단을 반영했습니다.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "학생 등록에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createSeason(payload: { name: string; startDate: string; endDate: string; copy: boolean }) {
    if (!selectedClassId) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("create_season", {
        p_class_id: selectedClassId,
        p_name: payload.name,
        p_start_date: payload.startDate,
        p_end_date: payload.endDate || null,
        p_copy_from_season_id: payload.copy ? selectedSeasonId || null : null,
      });
      if (error) throw error;
      setModal(null);
      await loadClassData(selectedClassId);
      if (typeof data === "string") setSelectedSeasonId(data);
      notify("새 운영 기간을 생성했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "운영 기간 생성에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateClassMetadata(
    classroom: Classroom,
    payload: { name: string; academicYear: number; grade: number; classNumber: number },
  ) {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("update_class_metadata", {
        p_class_id: classroom.id,
        p_name: payload.name,
        p_academic_year: payload.academicYear,
        p_grade: payload.grade,
        p_class_number: payload.classNumber,
      });
      if (error) throw error;
      await loadClasses();
      setAcademicYear(payload.academicYear);
      notify("학급 정보를 수정했습니다.");
    } catch (error) {
      notify(errorMessage(error, "학급 수정에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function setClassArchived(classroom: Classroom, archived: boolean) {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("set_class_archived", {
        p_class_id: classroom.id,
        p_archived: archived,
      });
      if (error) throw error;
      await loadClasses();
      setAcademicYear(null);
      notify(archived ? "학급을 보관했습니다." : "학급을 복구했습니다.");
    } catch (error) {
      notify(errorMessage(error, "학급 보관 상태 변경에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteClassPermanently(classroom: Classroom) {
    const confirmation = window.prompt(
      `${classroom.academic_year}학년도 ${classroom.name}의 학생·시즌·수업·MP 기록을 모두 영구 삭제합니다.\n복구할 수 없습니다.\n\n계속하려면 학급 이름 '${classroom.name}'을 입력하세요.`,
      "",
    );
    if (confirmation !== classroom.name) return;

    setBusy(true);
    try {
      const { error } = await supabase.rpc("delete_class_permanently", {
        p_class_id: classroom.id,
        p_confirm_name: confirmation,
      });
      if (error) throw error;
      await loadClasses();
      setAcademicYear(null);
      notify("학급을 영구 삭제했습니다.");
    } catch (error) {
      notify(errorMessage(error, "학급 삭제에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateSeasonMetadata(
    seasonItem: Season,
    payload: { name: string; startDate: string; endDate: string },
  ) {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("update_season_metadata", {
        p_season_id: seasonItem.id,
        p_name: payload.name,
        p_start_date: payload.startDate,
        p_end_date: payload.endDate || null,
      });
      if (error) throw error;
      await loadClassData(seasonItem.class_id);
      notify("운영 기간 정보를 수정했습니다.");
    } catch (error) {
      notify(errorMessage(error, "운영 기간 수정에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function setSeasonArchived(seasonItem: Season, archived: boolean) {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("set_season_archived", {
        p_season_id: seasonItem.id,
        p_archived: archived,
      });
      if (error) throw error;
      if (archived && selectedSeasonId === seasonItem.id) setSelectedSeasonId("");
      await loadClassData(seasonItem.class_id);
      notify(archived ? "운영 기간을 보관했습니다." : "운영 기간을 복구했습니다.");
    } catch (error) {
      notify(errorMessage(error, "운영 기간 보관 상태 변경에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSeasonPermanently(seasonItem: Season) {
    const confirmation = window.prompt(
      `${seasonItem.name}의 배치·수업·MP 기록을 영구 삭제합니다.\n복구할 수 없습니다.\n\n계속하려면 운영 기간 이름 '${seasonItem.name}'을 입력하세요.`,
      "",
    );
    if (confirmation !== seasonItem.name) return;

    setBusy(true);
    try {
      const { error } = await supabase.rpc("delete_season_permanently", {
        p_season_id: seasonItem.id,
        p_confirm_name: confirmation,
      });
      if (error) throw error;
      if (selectedSeasonId === seasonItem.id) setSelectedSeasonId("");
      await loadClassData(seasonItem.class_id);
      notify("운영 기간을 영구 삭제했습니다.");
    } catch (error) {
      notify(errorMessage(error, "운영 기간 삭제에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(assignment: AssignmentWithStudent, role: Role, mentorStudentId: string | null) {
    const branchChanged = role !== assignment.role;

    setBusy(true);
    try {
      const { error } = await supabase.rpc("update_assignment_role", {
        p_assignment_id: assignment.id,
        p_role: role,
        p_mentor_student_id: ["beginner", "disciple"].includes(role) ? mentorStudentId : null,
        p_reset_role_progress: branchChanged,
      });
      if (error) throw error;
      await refreshAll();
      setModal(null);
      setSelectedAssignment(null);
      notify("역할과 멘토 관계를 저장했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "역할 저장에 실패했습니다.", "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleRoleStudent(studentId: string) {
    setSelectedRoleStudentIds((current) => {
      const next = new Set(current);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  function addRoleStudents(predicate: (assignment: AssignmentWithStudent) => boolean) {
    setSelectedRoleStudentIds((current) => {
      const next = new Set(current);
      assignments.filter(predicate).forEach((item) => next.add(item.student_id));
      return next;
    });
  }

  function exitRoleEditMode() {
    setRoleEditMode(false);
    setSelectedRoleStudentIds(new Set());
  }

  async function applyBulkRole(role: Role) {
    if (!selectedSeasonId || selectedRoleAssignments.length === 0) return;

    const roleLabel = ROLE_LABELS[role];
    const confirmation = window.confirm(
      `선택한 학생 ${selectedRoleAssignments.length}명의 역할을 '${roleLabel}'(으)로 변경할까요?\n역할이 실제로 바뀌는 학생은 승급 진행도가 새로 시작됩니다.`,
    );
    if (!confirmation) return;

    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("bulk_update_assignment_roles", {
        p_season_id: selectedSeasonId,
        p_assignment_ids: selectedRoleAssignments.map((item) => item.id),
        p_role: role,
      });
      if (error) throw error;
      await refreshAll();
      setSelectedRoleStudentIds(new Set());
      notify(`${data ?? selectedRoleAssignments.length}명의 역할을 ${roleLabel}(으)로 변경했습니다.`);
    } catch (error) {
      notify(errorMessage(error, "역할 일괄 변경에 실패했습니다."), "error");
    } finally {
      setBusy(false);
    }
  }

  const studentNameById = useMemo(() => new Map(students.map((student) => [student.id, student.name])), [students]);

  if (loading && classes.length === 0) {
    return <div className="loading-screen">수학 클래스 RPG를 불러오는 중입니다...</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-title">
          <div className="brand-mark" style={{ width: 42, height: 42, margin: 0, borderRadius: 12, fontSize: 21 }}>
            ✦
          </div>
          <div>
            <strong>수학 클래스 RPG</strong>
            <div className="header-sub">교사용 1차 관리 웹앱 · {email}</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost btn-small" type="button" onClick={logout} style={{ color: "white", borderColor: "#65799e" }}>
            로그아웃
          </button>
        </div>
      </header>

      <main className="app-main">
        {activeClasses.length === 0 ? (
          <section className="empty-panel">
            <h1>{classes.length === 0 ? "첫 학급을 만들어 볼까요?" : "사용 중인 학급이 없습니다."}</h1>
            <p>{classes.length === 0 ? "학급과 첫 모둠 운영 기간을 생성한 뒤 학생 명단을 등록합니다." : "새 학급을 만들거나 보관된 학급을 복구해 주세요."}</p>
            <button className="btn btn-primary" type="button" onClick={() => setModal("class")}>
              학급 만들기
            </button>
            {classes.length > 0 && (
              <button className="btn btn-ghost" style={{ marginLeft: 8 }} type="button" onClick={() => setModal("classManage")}>
                보관 학급 관리
              </button>
            )}
          </section>
        ) : (
          <>
            <section className="toolbar">
              <div className="toolbar-group">
                <select
                  aria-label="학년도"
                  value={visibleAcademicYear}
                  onChange={(event) => {
                    const nextYear = Number(event.target.value);
                    setAcademicYear(nextYear);
                    setSelectedClassId(activeClasses.find((item) => item.academic_year === nextYear)?.id ?? "");
                  }}
                  disabled={editMode || roleEditMode}
                >
                  {academicYears.map((year) => <option key={year} value={year}>{year}학년도</option>)}
                </select>
                <select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)} disabled={editMode || roleEditMode}>
                  {visibleClasses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <select value={selectedSeasonId} onChange={(event) => setSelectedSeasonId(event.target.value)} disabled={editMode || roleEditMode}>
                  {visibleSeasons.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}{item.is_active ? " · 현재" : ""}
                    </option>
                  ))}
                </select>
                <span className={`status-pill ${session ? "active" : ""}`}>{session ? "수업 진행 중" : "수업 대기"}</span>
                {feverText && <span className="status-pill fever">🔥 피버 {feverText}</span>}
              </div>

              <div className="toolbar-group">
                {!session ? (
                  <button className="btn btn-success" type="button" onClick={startSession} disabled={busy || editMode || roleEditMode || !selectedSeason}>
                    오늘 수업 시작
                  </button>
                ) : (
                  <button className="btn btn-danger" type="button" onClick={endSession} disabled={busy || editMode}>
                    수업 종료
                  </button>
                )}
                {session && !activeFever && (
                  <button className="btn btn-gold" type="button" onClick={startFever} disabled={busy || editMode}>
                    피버 타임
                  </button>
                )}
                {activeFever && (
                  <button className="btn btn-ghost" type="button" onClick={stopFever} disabled={busy}>
                    피버 종료
                  </button>
                )}
                {!editMode ? (
                  <button
                    className="btn btn-soft"
                    type="button"
                    onClick={() => {
                      setDraftAssignments(assignments.map((item) => ({ ...item, student: { ...item.student } })));
                      setEditMode(true);
                    }}
                    disabled={Boolean(session) || roleEditMode}
                    title={session ? "수업을 종료한 뒤 배치를 수정해 주세요." : ""}
                  >
                    배치 수정
                  </button>
                ) : (
                  <>
                    <button className="btn btn-ghost" type="button" onClick={cancelSeatingPlan} disabled={busy}>
                      변경 취소
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={saveSeatingPlan}
                      disabled={busy || !hasSeatingChanges}
                    >
                      배치 저장
                    </button>
                  </>
                )}
                {!roleEditMode ? (
                  <button
                    className="btn btn-soft"
                    type="button"
                    onClick={() => {
                      setSelectedRoleStudentIds(new Set());
                      setRoleEditMode(true);
                    }}
                    disabled={busy || editMode || Boolean(session) || !selectedSeason}
                    title={session ? "수업을 종료한 뒤 역할을 변경해 주세요." : ""}
                  >
                    역할 일괄 설정
                  </button>
                ) : (
                  <button className="btn btn-ghost" type="button" onClick={exitRoleEditMode} disabled={busy}>
                    역할 설정 종료
                  </button>
                )}
                <button className="btn btn-ghost" type="button" onClick={() => setModal("students")} disabled={editMode || roleEditMode}>
                  학생 명단
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={resetClassMp}
                  disabled={busy || editMode || roleEditMode || Boolean(session) || !students.some((student) => student.total_mp !== 0)}
                  title={session ? "수업을 종료한 뒤 MP를 초기화해 주세요." : "현재 학급 학생들의 MP를 모두 0으로 초기화"}
                >
                  MP 전체 초기화
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setModal("season")} disabled={editMode || roleEditMode || Boolean(session)}>
                  새 운영 기간
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setModal("seasonManage")} disabled={editMode || roleEditMode || Boolean(session)}>
                  운영 기간 관리
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setModal("class")} disabled={editMode || roleEditMode}>
                  새 학년도·학급
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setModal("classManage")} disabled={editMode || roleEditMode || Boolean(session)}>
                  학급 관리
                </button>
              </div>
            </section>

            {roleEditMode && selectedSeason && (
              <section className="bulk-role-panel" aria-label="역할 일괄 설정">
                <div className="bulk-role-heading">
                  <div>
                    <strong>역할 일괄 설정</strong>
                    <p>학생 카드를 직접 누르거나 아래 조건 버튼으로 여러 명을 선택하세요.</p>
                  </div>
                  <span className="status-pill active">{selectedRoleAssignments.length}명 선택</span>
                </div>

                <div className="bulk-role-row">
                  <span className="bulk-role-label">빠른 선택</span>
                  <div className="bulk-role-buttons">
                    <button className="btn btn-ghost btn-small" type="button" onClick={() => setSelectedRoleStudentIds(new Set(assignments.map((item) => item.student_id)))}>
                      전체
                    </button>
                    <button className="btn btn-ghost btn-small" type="button" onClick={() => setSelectedRoleStudentIds(new Set())} disabled={selectedRoleAssignments.length === 0}>
                      선택 해제
                    </button>
                    <button className="btn btn-ghost btn-small" type="button" onClick={() => addRoleStudents((item) => item.group_no === null || item.seat_index === null)}>
                      미배치
                    </button>
                    {[1, 2, 3, 4].map((seatIndex) => (
                      <button key={seatIndex} className="btn btn-ghost btn-small" type="button" onClick={() => addRoleStudents((item) => item.seat_index === seatIndex)}>
                        {seatIndex}번 자리
                      </button>
                    ))}
                    {[1, 2, 3, 4, 5, 6].map((groupNo) => (
                      <button key={groupNo} className="btn btn-ghost btn-small" type="button" onClick={() => addRoleStudents((item) => item.group_no === groupNo)}>
                        {groupNo}모둠
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bulk-role-row">
                  <span className="bulk-role-label">역할 적용</span>
                  <div className="bulk-role-buttons">
                    {ROLE_ORDER.map((role) => (
                      <button
                        key={role}
                        className={`btn btn-small bulk-role-apply role-${role}`}
                        type="button"
                        onClick={() => applyBulkRole(role)}
                        disabled={busy || selectedRoleAssignments.length === 0}
                      >
                        {ROLE_LABELS[role]}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {selectedSeason ? (
              <SeatingBoard
                assignments={visibleAssignments}
                editable={editMode}
                selectionMode={roleEditMode}
                selectedStudentIds={selectedRoleStudentIds}
                onPlanChange={handlePlanChange}
                onStudentClick={(assignment) => {
                  if (roleEditMode) {
                    toggleRoleStudent(assignment.student_id);
                    return;
                  }
                  setSelectedAssignment(assignment);
                  setModal("student");
                }}
                onGroupAward={awardGroup}
                sessionActive={Boolean(session)}
              />
            ) : (
              <section className="empty-panel">
                <h2>운영 기간이 없습니다.</h2>
                <button className="btn btn-primary" type="button" onClick={() => setModal("season")}>
                  운영 기간 만들기
                </button>
              </section>
            )}

            <section className="board-card" style={{ marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>최근 MP 기록</h2>
                <span className="status-pill">최근 {transactions.length}건</span>
              </div>
              <div className="recent-list">
                {transactions.length === 0 ? (
                  <p className="quick-note">아직 MP 기록이 없습니다.</p>
                ) : (
                  transactions.map((tx) => (
                    <div className={`recent-item ${tx.is_reversed ? "reversed" : ""}`} key={tx.id}>
                      <div className="recent-row">
                        <strong>{studentNameById.get(tx.student_id) ?? "학생"}</strong>
                        <span className={tx.amount >= 0 ? "amount-plus" : "amount-minus"}>
                          {tx.amount >= 0 ? "+" : ""}{tx.amount}MP
                        </span>
                      </div>
                      <div className="recent-row">
                        <span>{tx.reason} · {formatTime(tx.created_at)}</span>
                        {tx.amount > 0 && !tx.is_reversed && (
                          <button className="btn btn-ghost btn-small" type="button" onClick={() => reverseTransaction(tx)} disabled={busy}>
                            취소
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </main>

      {modal === "class" && (
        <ClassModal
          busy={busy}
          classes={classes}
          defaultAcademicYear={visibleAcademicYear}
          onClose={() => setModal(null)}
          onSubmit={createClass}
        />
      )}
      {modal === "classManage" && (
        <ClassManageModal
          busy={busy}
          classes={classes}
          selectedClassId={selectedClassId}
          onClose={() => setModal(null)}
          onSelect={(classroom) => {
            setAcademicYear(classroom.academic_year);
            setSelectedClassId(classroom.id);
          }}
          onUpdate={updateClassMetadata}
          onArchive={setClassArchived}
          onDelete={deleteClassPermanently}
        />
      )}
      {modal === "students" && selectedClass && (
        <StudentsModal busy={busy} className={selectedClass.name} onClose={() => setModal(null)} onSubmit={addStudents} />
      )}
      {modal === "season" && selectedClass && (
        <SeasonModal
          busy={busy}
          className={selectedClass.name}
          canCopy={Boolean(selectedSeasonId)}
          onClose={() => setModal(null)}
          onSubmit={createSeason}
        />
      )}
      {modal === "seasonManage" && selectedClass && (
        <SeasonManageModal
          busy={busy}
          className={selectedClass.name}
          seasons={seasons}
          selectedSeasonId={selectedSeasonId}
          onClose={() => setModal(null)}
          onSelect={setSelectedSeasonId}
          onUpdate={updateSeasonMetadata}
          onArchive={setSeasonArchived}
          onDelete={deleteSeasonPermanently}
        />
      )}
      {modal === "student" && selectedAssignment && (
        <StudentModal
          assignment={assignments.find((item) => item.id === selectedAssignment.id) ?? selectedAssignment}
          sessionActive={Boolean(session)}
          busy={busy}
          onClose={() => {
            setModal(null);
            setSelectedAssignment(null);
          }}
          onAward={awardStudent}
          onSkill={handleSkill}
          onPromote={promote}
          onUpdateRole={(assignment, role) => updateRole(assignment, role, null)}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}

function ClassModal({
  busy,
  classes,
  defaultAcademicYear,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  classes: Classroom[];
  defaultAcademicYear: number;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    academicYear: number;
    grade: number;
    classNumber: number;
    seasonName: string;
    startDate: string;
    endDate: string;
    copyStudentsFromClassId: string | null;
  }) => void;
}) {
  const [academicYear, setAcademicYear] = useState(defaultAcademicYear);
  const [grade, setGrade] = useState(1);
  const [classNumber, setClassNumber] = useState(1);
  const [name, setName] = useState("1학년 1반");
  const [seasonName, setSeasonName] = useState("1차 모둠 · 8~9월");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState("");
  const [copyStudentsFromClassId, setCopyStudentsFromClassId] = useState("");

  return (
    <Modal title="학급 만들기" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name,
            academicYear,
            grade,
            classNumber,
            seasonName,
            startDate,
            endDate,
            copyStudentsFromClassId: copyStudentsFromClassId || null,
          });
        }}
      >
        <div className="field">
          <label>학년도</label>
          <input
            type="number"
            min={2000}
            max={2100}
            value={academicYear}
            onChange={(event) => setAcademicYear(Number(event.target.value))}
            required
          />
        </div>
        <div className="two-columns">
          <div className="field">
            <label>학년</label>
            <select
              value={grade}
              onChange={(event) => {
                const nextGrade = Number(event.target.value);
                setGrade(nextGrade);
                setName(`${nextGrade}학년 ${classNumber}반`);
              }}
            >
              {[1, 2, 3].map((value) => <option key={value}>{value}</option>)}
            </select>
          </div>
          <div className="field">
            <label>반</label>
            <input
              type="number"
              min={1}
              max={20}
              value={classNumber}
              onChange={(event) => {
                const nextClassNumber = Number(event.target.value);
                setClassNumber(nextClassNumber);
                setName(`${grade}학년 ${nextClassNumber}반`);
              }}
            />
          </div>
        </div>
        <div className="field">
          <label>이전 학급 학생 명단 복사(선택)</label>
          <select value={copyStudentsFromClassId} onChange={(event) => setCopyStudentsFromClassId(event.target.value)}>
            <option value="">복사하지 않음</option>
            {classes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.academic_year}학년도 · {item.name}{item.archived_at ? " · 보관됨" : ""}
              </option>
            ))}
          </select>
          <span className="quick-note">번호와 이름만 복사하며 MP는 0, 역할은 입문자, 좌석은 미배치로 시작합니다.</span>
        </div>
        <div className="field">
          <label>학급 표시 이름</label>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="field">
          <label>첫 운영 기간 이름</label>
          <input value={seasonName} onChange={(event) => setSeasonName(event.target.value)} required />
        </div>
        <div className="two-columns">
          <div className="field">
            <label>시작일</label>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
          </div>
          <div className="field">
            <label>종료일(선택)</label>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" type="button" onClick={onClose}>취소</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>학급 생성</button>
        </div>
      </form>
    </Modal>
  );
}

function ClassManageModal({
  busy,
  classes,
  selectedClassId,
  onClose,
  onSelect,
  onUpdate,
  onArchive,
  onDelete,
}: {
  busy: boolean;
  classes: Classroom[];
  selectedClassId: string;
  onClose: () => void;
  onSelect: (classroom: Classroom) => void;
  onUpdate: (classroom: Classroom, payload: { name: string; academicYear: number; grade: number; classNumber: number }) => void;
  onArchive: (classroom: Classroom, archived: boolean) => void;
  onDelete: (classroom: Classroom) => void;
}) {
  const initial = classes.find((item) => item.id === selectedClassId) ?? classes[0] ?? null;
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [academicYear, setAcademicYear] = useState(initial?.academic_year ?? currentAcademicYear());
  const [grade, setGrade] = useState(initial?.grade ?? 1);
  const [classNumber, setClassNumber] = useState(initial?.class_number ?? 1);
  const selected = classes.find((item) => item.id === selectedId) ?? null;

  function choose(item: Classroom) {
    setSelectedId(item.id);
    setName(item.name);
    setAcademicYear(item.academic_year);
    setGrade(item.grade);
    setClassNumber(item.class_number);
  }

  return (
    <Modal title="학급 관리" onClose={onClose} large>
      <div className="management-layout">
        <div className="management-list">
          {classes.map((item) => (
            <button
              className={`management-item ${item.id === selectedId ? "selected" : ""}`}
              key={item.id}
              type="button"
              onClick={() => choose(item)}
            >
              <strong>{item.academic_year}학년도 · {item.name}</strong>
              <span>{item.archived_at ? "보관됨" : `${item.grade}학년 ${item.class_number}반`}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <div className="form-stack">
            <div className="two-columns">
              <div className="field">
                <label>학년도</label>
                <input type="number" min={2000} max={2100} value={academicYear} onChange={(event) => setAcademicYear(Number(event.target.value))} />
              </div>
              <div className="field">
                <label>학급 표시 이름</label>
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </div>
            </div>
            <div className="two-columns">
              <div className="field">
                <label>학년</label>
                <select value={grade} onChange={(event) => setGrade(Number(event.target.value))}>
                  {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className="field">
                <label>반</label>
                <input type="number" min={1} max={20} value={classNumber} onChange={(event) => setClassNumber(Number(event.target.value))} />
              </div>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !name}
              onClick={() => onUpdate(selected, { name, academicYear, grade, classNumber })}
            >
              학급 정보 저장
            </button>
            <div className="warning-box">
              보관은 기록을 유지한 채 기본 목록에서 숨깁니다. 영구 삭제는 학생·운영 기간·수업·MP 기록을 모두 삭제하며 복구할 수 없습니다.
            </div>
            <div className="modal-footer" style={{ marginTop: 0 }}>
              {!selected.archived_at && (
                <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => onSelect(selected)}>
                  이 학급 열기
                </button>
              )}
              <button className="btn btn-soft" type="button" disabled={busy} onClick={() => onArchive(selected, !selected.archived_at)}>
                {selected.archived_at ? "학급 복구" : "학급 보관"}
              </button>
              <button className="btn btn-danger" type="button" disabled={busy} onClick={() => onDelete(selected)}>
                영구 삭제
              </button>
            </div>
          </div>
        ) : (
          <p className="quick-note">관리할 학급이 없습니다.</p>
        )}
      </div>
    </Modal>
  );
}

function StudentsModal({
  busy,
  className,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  className: string;
  onClose: () => void;
  onSubmit: (raw: string) => void;
}) {
  const [raw, setRaw] = useState("");
  const count = parseStudentLines(raw).length;
  return (
    <Modal title={`${className} 학생 명단`} onClose={onClose}>
      <div className="warning-box" style={{ marginBottom: 14 }}>
        한 줄에 한 명씩 <strong>번호, 이름</strong> 형식으로 붙여 넣으세요. 같은 번호가 이미 있으면 이름을 수정합니다.
      </div>
      <div className="field">
        <label>명단 입력 · 인식 {count}명</label>
        <textarea
          rows={14}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          placeholder={"1, 김수학\n2, 이수학\n3, 박수학"}
        />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" type="button" onClick={onClose}>취소</button>
        <button className="btn btn-primary" type="button" disabled={busy || count === 0} onClick={() => onSubmit(raw)}>
          {count}명 반영
        </button>
      </div>
    </Modal>
  );
}

function SeasonModal({
  busy,
  className,
  canCopy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  className: string;
  canCopy: boolean;
  onClose: () => void;
  onSubmit: (payload: { name: string; startDate: string; endDate: string; copy: boolean }) => void;
}) {
  const [name, setName] = useState("2차 모둠 · 중간고사 이후");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState("");
  const [copy, setCopy] = useState(canCopy);

  return (
    <Modal title={`${className} 새 운영 기간`} onClose={onClose}>
      <div className="form-stack">
        <div className="field">
          <label>운영 기간 이름</label>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="two-columns">
          <div className="field">
            <label>시작일</label>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="field">
            <label>종료일(선택)</label>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800 }}>
          <input type="checkbox" checked={copy} disabled={!canCopy} onChange={(event) => setCopy(event.target.checked)} />
          현재 배치·역할을 복사해서 시작
        </label>
        <div className="warning-box">새 운영 기간을 만들면 기존 운영 기간은 과거 기록으로 보존되고 새 기간이 현재 기간이 됩니다.</div>
        <div className="modal-footer">
          <button className="btn btn-ghost" type="button" onClick={onClose}>취소</button>
          <button className="btn btn-primary" type="button" disabled={busy || !name || !startDate} onClick={() => onSubmit({ name, startDate, endDate, copy })}>
            운영 기간 생성
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SeasonManageModal({
  busy,
  className,
  seasons,
  selectedSeasonId,
  onClose,
  onSelect,
  onUpdate,
  onArchive,
  onDelete,
}: {
  busy: boolean;
  className: string;
  seasons: Season[];
  selectedSeasonId: string;
  onClose: () => void;
  onSelect: (seasonId: string) => void;
  onUpdate: (season: Season, payload: { name: string; startDate: string; endDate: string }) => void;
  onArchive: (season: Season, archived: boolean) => void;
  onDelete: (season: Season) => void;
}) {
  const initial = seasons.find((item) => item.id === selectedSeasonId) ?? seasons[0] ?? null;
  const [selectedId, setSelectedId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [startDate, setStartDate] = useState(initial?.start_date ?? todayIso());
  const [endDate, setEndDate] = useState(initial?.end_date ?? "");
  const selected = seasons.find((item) => item.id === selectedId) ?? null;

  function choose(item: Season) {
    setSelectedId(item.id);
    setName(item.name);
    setStartDate(item.start_date);
    setEndDate(item.end_date ?? "");
  }

  return (
    <Modal title={`${className} 운영 기간 관리`} onClose={onClose} large>
      <div className="management-layout">
        <div className="management-list">
          {seasons.map((item) => (
            <button
              className={`management-item ${item.id === selectedId ? "selected" : ""}`}
              key={item.id}
              type="button"
              onClick={() => choose(item)}
            >
              <strong>{item.name}</strong>
              <span>{item.archived_at ? "보관됨" : item.is_active ? "현재 운영 기간" : `${item.start_date} 시작`}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <div className="form-stack">
            <div className="field">
              <label>운영 기간 이름</label>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="two-columns">
              <div className="field">
                <label>시작일</label>
                <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </div>
              <div className="field">
                <label>종료일(선택)</label>
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </div>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !name || !startDate}
              onClick={() => onUpdate(selected, { name, startDate, endDate })}
            >
              운영 기간 정보 저장
            </button>
            <div className="warning-box">
              보관은 배치와 MP 기록을 유지합니다. 영구 삭제는 해당 기간의 배치·수업·MP 기록을 삭제하며 복구할 수 없습니다.
            </div>
            <div className="modal-footer" style={{ marginTop: 0 }}>
              {!selected.archived_at && (
                <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => onSelect(selected.id)}>
                  이 기간 열기
                </button>
              )}
              <button className="btn btn-soft" type="button" disabled={busy} onClick={() => onArchive(selected, !selected.archived_at)}>
                {selected.archived_at ? "기간 복구" : "기간 보관"}
              </button>
              <button className="btn btn-danger" type="button" disabled={busy} onClick={() => onDelete(selected)}>
                영구 삭제
              </button>
            </div>
          </div>
        ) : (
          <p className="quick-note">관리할 운영 기간이 없습니다.</p>
        )}
      </div>
    </Modal>
  );
}

function StudentModal({
  assignment,
  sessionActive,
  busy,
  onClose,
  onAward,
  onSkill,
  onPromote,
  onUpdateRole,
}: {
  assignment: AssignmentWithStudent;
  sessionActive: boolean;
  busy: boolean;
  onClose: () => void;
  onAward: (
    assignment: AssignmentWithStudent,
    baseAmount: number,
    reason: string,
    skillKey?: string | null,
    extraMultiplier?: 1 | 2,
  ) => void;
  onSkill: (assignment: AssignmentWithStudent, skill: SkillAction) => void;
  onPromote: (assignment: AssignmentWithStudent) => void;
  onUpdateRole: (assignment: AssignmentWithStudent, role: Role) => void;
}) {
  const [role, setRole] = useState<Role>(assignment.role);
  const [customMp, setCustomMp] = useState(1);
  const eligiblePromotion = ["beginner", "mentor"].includes(assignment.role) && roleProgress(assignment) >= 20;
  const skills = SKILLS_BY_ROLE[assignment.role];

  return (
    <Modal title={`${assignment.student.student_number}번 ${assignment.student.name}`} onClose={onClose} large>
      <div className="two-columns">
        <section>
          <div className="summary-box" style={{ marginBottom: 14 }}>
            <strong>{ROLE_LABELS[assignment.role]}</strong> · 누적 {assignment.student.total_mp}MP
            <br />
            {assignment.group_no ? `${assignment.group_no}모둠` : "미배치"}
            {["beginner", "mentor"].includes(assignment.role) && (
              <><br />현재 역할 진행도 {Math.max(0, roleProgress(assignment))}/20</>
            )}
          </div>

          <h3>빠른 MP 지급</h3>
          <div className="action-grid">
            <button className="action-card" type="button" disabled={!sessionActive || busy} onClick={() => onAward(assignment, 1, "개인 활동 점수 1점")}>
              <strong>개인 +1MP</strong><span>피버 타임이 켜져 있으면 자동 2배</span>
            </button>
            <button className="action-card" type="button" disabled={!sessionActive || busy} onClick={() => onAward(assignment, 2, "개인 활동 점수 2점")}>
              <strong>개인 +2MP</strong><span>수업 슬라이드의 활동 점수에 맞춰 사용</span>
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
            <input
              type="number"
              min={1}
              max={100}
              value={customMp}
              onChange={(event) => setCustomMp(Number(event.target.value))}
              style={{ width: 90, border: "1px solid #cbd7ea", borderRadius: 10, padding: "9px" }}
            />
            <button className="btn btn-soft" type="button" disabled={!sessionActive || busy || customMp <= 0} onClick={() => onAward(assignment, customMp, `개인 활동 점수 ${customMp}점`)}>
              직접 MP 지급
            </button>
          </div>

          <h3 style={{ marginTop: 20 }}>역할 스킬</h3>
          <div className="action-grid">
            {skills.map((skill) =>
              skill.passive ? (
                <div className="action-card" key={skill.key} style={{ opacity: .72 }}>
                  <strong>{skill.label} · 패시브</strong>
                  <span>{skill.description}</span>
                </div>
              ) : (
                <button className="action-card" key={skill.key} type="button" disabled={!sessionActive || busy} onClick={() => onSkill(assignment, skill)}>
                  <strong>{skill.label}</strong>
                  <span>{skill.description}</span>
                </button>
              ),
            )}
            {assignment.role === "guardian" && (
              <div className="action-card" style={{ opacity: .65 }}>
                <strong>피버 타임</strong><span>화면 상단의 피버 타임 버튼에서 실행</span>
              </div>
            )}
          </div>

          {eligiblePromotion && (
            <button className="btn btn-gold btn-wide" style={{ marginTop: 16 }} type="button" disabled={busy} onClick={() => onPromote(assignment)}>
              ✦ {assignment.role === "beginner" ? "수제자로" : "상급 수승님으로"} 승급 처리
            </button>
          )}
        </section>

        <section>
          <h3>역할·멘토 설정</h3>
          <div className="form-stack">
            <div className="field">
              <label>현재 역할</label>
              <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {ROLE_ORDER.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
              </select>
            </div>
            <div className="warning-box">
              담당 수승님은 자리 배치에 따라 자동 지정됩니다. 4인 모둠은 4→1, 3→2로 연결되고, 3인 모둠은 2·3번 학생이 1번 수승님과 연결됩니다. 역할 계열을 변경하면 새 역할의 성장 MP가 현재 누적 MP부터 다시 계산됩니다.
            </div>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => onUpdateRole(assignment, role)}>
              역할 설정 저장
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  large = false,
  children,
}: {
  title: string;
  onClose: () => void;
  large?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${large ? "large" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div><h2>{title}</h2></div>
          <button className="close-btn" type="button" onClick={onClose} aria-label="닫기">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}
