"use client";

import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useMemo, useState } from "react";
import type { AssignmentWithStudent, SeatPosition } from "@/types/app";
import { StudentCard } from "@/components/student-card";

// 교사가 교탁 뒤에서 교실을 바라보는 시점
const GROUPS = [6, 5, 4, 3, 2, 1];
// 위쪽 1·4번, 아래쪽 3·2번
const SEATS = [1, 4, 3, 2];

function seatId(groupNo: number, seatIndex: number) {
  return `seat:${groupNo}:${seatIndex}`;
}

function parseSeatId(id: string): SeatPosition | null {
  if (id === "unassigned") return { groupNo: null, seatIndex: null };
  const [prefix, group, seat] = id.split(":");
  if (prefix !== "seat") return null;
  const groupNo = Number(group);
  const seatIndex = Number(seat);
  if (!GROUPS.includes(groupNo) || !SEATS.includes(seatIndex)) return null;
  return { groupNo, seatIndex };
}

function Seat({
  groupNo,
  seatIndex,
  assignment,
  editable,
  selectionMode,
  selectedStudentIds,
  onStudentClick,
}: {
  groupNo: number;
  seatIndex: number;
  assignment?: AssignmentWithStudent;
  editable: boolean;
  selectionMode: boolean;
  selectedStudentIds: Set<string>;
  onStudentClick: (assignment: AssignmentWithStudent) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: seatId(groupNo, seatIndex), disabled: !editable });
  return (
    <div ref={setNodeRef} className={`seat-slot ${isOver ? "over" : ""} ${!assignment ? "empty" : ""}`}>
      <span className="seat-position" aria-label={`${seatIndex}번 자리`}>{seatIndex}</span>
      {assignment ? (
        <StudentCard
          assignment={assignment}
          editable={editable}
          selected={selectionMode ? selectedStudentIds.has(assignment.student_id) : undefined}
          onClick={() => onStudentClick(assignment)}
        />
      ) : (
        <span>{editable ? "여기에 놓기" : "빈자리"}</span>
      )}
    </div>
  );
}

function UnassignedZone({
  assignments,
  editable,
  selectionMode,
  selectedStudentIds,
  onStudentClick,
}: {
  assignments: AssignmentWithStudent[];
  editable: boolean;
  selectionMode: boolean;
  selectedStudentIds: Set<string>;
  onStudentClick: (assignment: AssignmentWithStudent) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: "unassigned", disabled: !editable });
  return (
    <div ref={setNodeRef} className={`unassigned-zone ${isOver ? "over" : ""}`}>
      {assignments.length === 0 ? (
        <p className="quick-note">모든 학생이 배치되었습니다.</p>
      ) : (
        assignments.map((assignment) => (
          <StudentCard
            key={assignment.id}
            assignment={assignment}
            editable={editable}
            selected={selectionMode ? selectedStudentIds.has(assignment.student_id) : undefined}
            onClick={() => onStudentClick(assignment)}
          />
        ))
      )}
    </div>
  );
}

export default function SeatingBoard({
  assignments,
  editable,
  selectionMode = false,
  selectedStudentIds = new Set<string>(),
  onPlanChange,
  onStudentClick,
  onGroupAward,
  sessionActive,
}: {
  assignments: AssignmentWithStudent[];
  editable: boolean;
  selectionMode?: boolean;
  selectedStudentIds?: Set<string>;
  onPlanChange: (studentId: string, position: SeatPosition, swapStudentId?: string) => void;
  onStudentClick: (assignment: AssignmentWithStudent) => void;
  onGroupAward: (groupNo: number, amount: number) => void;
  sessionActive: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 7 } }),
    useSensor(KeyboardSensor),
  );
  const [activeStudentId, setActiveStudentId] = useState<string | null>(null);

  const positionMap = useMemo(() => {
    const map = new Map<string, AssignmentWithStudent>();
    assignments.forEach((assignment) => {
      if (assignment.group_no && assignment.seat_index) {
        map.set(seatId(assignment.group_no, assignment.seat_index), assignment);
      }
    });
    return map;
  }, [assignments]);

  const unassigned = assignments.filter((assignment) => assignment.group_no === null || assignment.seat_index === null);
  const activeAssignment = assignments.find((assignment) => assignment.student_id === activeStudentId);

  function handleDragEnd(event: DragEndEvent) {
    setActiveStudentId(null);
    const studentId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;

    const target = parseSeatId(overId);
    if (!target) return;
    const dragged = assignments.find((assignment) => assignment.student_id === studentId);
    if (
      dragged?.group_no === target.groupNo &&
      dragged?.seat_index === target.seatIndex
    ) {
      return;
    }
    const occupant = target.groupNo && target.seatIndex ? positionMap.get(seatId(target.groupNo, target.seatIndex)) : undefined;
    onPlanChange(studentId, target, occupant?.student_id);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => setActiveStudentId(String(event.active.id))}
      onDragCancel={() => setActiveStudentId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="layout-grid">
        <section className="board-card">
          {editable && (
            <div className="edit-mode-notice" role="status">
              배치 수정 중 · 저장하기 전까지 데이터베이스에는 반영되지 않습니다.
            </div>
          )}
          <div className="groups-grid">
            {GROUPS.map((groupNo) => (
              <article className="group-card" key={groupNo}>
                <header className="group-header">
                  <strong>{groupNo}모둠</strong>
                  <div className="group-actions">
                    <button
                      className="btn btn-gold btn-small"
                      type="button"
                      disabled={!sessionActive || editable}
                      onClick={() => onGroupAward(groupNo, 1)}
                    >
                      전원 +1
                    </button>
                    <button
                      className="btn btn-soft btn-small"
                      type="button"
                      disabled={!sessionActive || editable}
                      onClick={() => onGroupAward(groupNo, 2)}
                    >
                      전원 +2
                    </button>
                  </div>
                </header>
                <div className="group-seats">
                  {SEATS.map((seatIndex) => (
                    <Seat
                      key={seatIndex}
                      groupNo={groupNo}
                      seatIndex={seatIndex}
                      assignment={positionMap.get(seatId(groupNo, seatIndex))}
                      editable={editable}
                      selectionMode={selectionMode}
                      selectedStudentIds={selectedStudentIds}
                      onStudentClick={onStudentClick}
                    />
                  ))}
                </div>
              </article>
            ))}
          </div>
          <div className="teacher-desk">교탁</div>
        </section>

        <aside className="side-card">
          <div className="side-section">
            <div className="unassigned-title">
              <h3>미배치 학생</h3>
              <span className="status-pill">{unassigned.length}명</span>
            </div>
            <UnassignedZone
              assignments={unassigned}
              editable={editable}
              selectionMode={selectionMode}
              selectedStudentIds={selectedStudentIds}
              onStudentClick={onStudentClick}
            />
          </div>
          <div className="side-section">
            <h3>배치 안내</h3>
            <p className="quick-note">
              배치 수정 모드에서 학생을 원하는 자리로 끌어다 놓습니다. 이미 학생이 있는 자리로 놓으면 두 학생의 자리가 서로 바뀌고,
              오른쪽 미배치 영역으로 끌면 자리에서 제외됩니다.
            </p>
          </div>
        </aside>
      </div>

      <DragOverlay>
        {activeAssignment ? <StudentCard assignment={activeAssignment} editable={false} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
