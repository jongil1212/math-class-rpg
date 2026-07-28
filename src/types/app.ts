export type Role =
  | "beginner"
  | "disciple"
  | "mentor"
  | "senior_mentor"
  | "guardian";

export type Classroom = {
  id: string;
  owner_id: string;
  name: string;
  grade: number;
  class_number: number;
  created_at: string;
};

export type Student = {
  id: string;
  owner_id: string;
  class_id: string;
  student_number: number;
  name: string;
  total_mp: number;
  active: boolean;
  created_at: string;
};

export type Season = {
  id: string;
  owner_id: string;
  class_id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
  created_at: string;
};

export type Assignment = {
  id: string;
  owner_id: string;
  season_id: string;
  student_id: string;
  group_no: number | null;
  seat_index: number | null;
  role: Role;
  role_started_mp: number;
  mentor_student_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ClassSession = {
  id: string;
  owner_id: string;
  class_id: string;
  season_id: string;
  session_date: string;
  started_at: string;
  ended_at: string | null;
  status: "active" | "ended";
  fever_started_at: string | null;
  fever_ended_at: string | null;
  created_at: string;
};

export type MpTransaction = {
  id: string;
  owner_id: string;
  class_id: string;
  student_id: string;
  session_id: string | null;
  amount: number;
  base_amount: number;
  multiplier: number;
  reason: string;
  skill_key: string | null;
  group_no: number | null;
  reversal_of: string | null;
  is_reversed: boolean;
  created_at: string;
};

export type AssignmentWithStudent = Assignment & {
  student: Student;
};

export type SeatPosition = {
  groupNo: number | null;
  seatIndex: number | null;
};

export const ROLE_LABELS: Record<Role, string> = {
  beginner: "입문자",
  disciple: "수제자",
  mentor: "수승님",
  senior_mentor: "상급 수승님",
  guardian: "수호자",
};

export const ROLE_ORDER: Role[] = [
  "beginner",
  "disciple",
  "mentor",
  "senior_mentor",
  "guardian",
];
