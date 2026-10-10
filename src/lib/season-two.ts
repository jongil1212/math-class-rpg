import type { AssignmentWithStudent, Role } from "@/types/app";

export const PRODUCTS = [
  { key: "presentation_priority", name: "발표 1회 우선권", cost: 2, description: "다음 발표 1회에 우선 참여" },
  { key: "fever_request", name: "피버타임 요청권", cost: 4, description: "교사 승인 후 10분간 MP 2배" },
  { key: "teacher_hint", name: "선생님의 힌트권", cost: 4, description: "문제 풀이 힌트 1회" },
  { key: "snack_draw", name: "간식 뽑기권", cost: 5, description: "교사가 운영하는 간식 뽑기 1회" },
  { key: "early_finish", name: "수업 10분 조기 종료권", cost: 20, description: "교사가 승인한 수업에서 반 전체에 적용" },
] as const;

export type Coupon = {
  id: string; student_id: string; product_key: string; cost: number;
  status: "unused" | "used" | "refunded"; created_at: string; used_at: string | null;
};
export type ShopAccount = { student_id: string; reserved_mp: number };
export type SessionEffect = {
  id: string; kind: "shield" | "fortune" | "duo" | "steal";
  student_id: string; target_student_id: string | null; group_no: number | null;
  consumed: boolean; note: string;
};
export function promotion(assignment: AssignmentWithStudent) {
  const version2 = assignment.rules_version === 2;
  const next: Partial<Record<Role, Role>> = {
    beginner: "disciple", mentor: "senior_mentor",
    ...(version2 ? { disciple: "senior_disciple" as Role, senior_mentor: "math_saint" as Role } : {}),
  };
  const role = next[assignment.role];
  if (!role) return null;
  const threshold = ["disciple", "senior_mentor"].includes(assignment.role) ? 40 : 20;
  const progress = version2 ? assignment.student.total_mp : assignment.student.total_mp - assignment.role_started_mp;
  return { role, threshold, progress, eligible: progress >= threshold };
}
export function shopBalance(total: number, reserved: number, coupons: Coupon[]) {
  return Math.max(0, total - reserved - coupons.filter((c) => c.status !== "refunded").reduce((sum, c) => sum + c.cost, 0));
}
