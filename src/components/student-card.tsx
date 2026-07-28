"use client";

import { CSS } from "@dnd-kit/utilities";
import { useDraggable } from "@dnd-kit/core";
import type { AssignmentWithStudent } from "@/types/app";
import { ROLE_LABELS } from "@/types/app";

function progressText(assignment: AssignmentWithStudent) {
  if (!['beginner', 'mentor'].includes(assignment.role)) return null;
  const progress = assignment.student.total_mp - assignment.role_started_mp;
  return progress >= 20 ? "승급 가능" : `${Math.max(0, progress)}/20`;
}

export function StudentCard({
  assignment,
  editable,
  onClick,
  overlay = false,
}: {
  assignment: AssignmentWithStudent;
  editable: boolean;
  onClick?: () => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: assignment.student_id,
    disabled: !editable || overlay,
    data: { studentId: assignment.student_id },
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  const progress = progressText(assignment);

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      className={`student-card role-${assignment.role} ${editable ? "draggable" : ""} ${
        isDragging ? "dragging" : ""
      }`}
      onClick={() => {
        if (!editable) onClick?.();
      }}
      {...(editable ? attributes : {})}
      {...(editable ? listeners : {})}
    >
      <div className="student-top">
        <span className="student-name">{assignment.student.name}</span>
        <span className="student-number">{assignment.student.student_number}번</span>
      </div>
      <div className="student-meta">
        <span className="role-badge">
          {assignment.role === "guardian" ? "🛡 " : ""}
          {ROLE_LABELS[assignment.role]}
        </span>
        <span className="mp-badge">{assignment.student.total_mp}MP</span>
        {progress && <span className="progress-badge">{progress}</span>}
      </div>
    </button>
  );
}
