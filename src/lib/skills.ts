import type { Role } from "@/types/app";

export type SkillAction = {
  key: string;
  label: string;
  description: string;
  baseAmount?: number;
  extraMultiplier?: 1 | 2;
  usageOnly?: boolean;
  pairedAward?: boolean;
  passive?: boolean;
};

export const SKILLS_BY_ROLE: Record<Role, SkillAction[]> = {
  beginner: [
    {
      key: "beginner_luck",
      label: "초심자의 행운",
      description: "발표 성공 MP 2배 · 수업당 1회",
      extraMultiplier: 2,
    },
  ],
  disciple: [
    {
      key: "eagle_eye_disciple",
      label: "매의 눈",
      description: "오류를 정확히 고치면 +2MP",
      baseAmount: 2,
    },
    {
      key: "retry",
      label: "재도전",
      description: "발표권 실패 후 1회 재도전 · 수업당 1회",
      usageOnly: true,
    },
    {
      key: "relief_pitcher_helped",
      label: "구원투수 도움받음",
      description: "수제자 +1MP",
      baseAmount: 1,
    },
  ],
  mentor: [
    {
      key: "mentor_grace",
      label: "수승의 은혜",
      description: "짝 멘티가 개인 MP를 얻으면 자동 +1MP",
      passive: true,
    },
    {
      key: "relief_pitcher",
      label: "구원투수",
      description: "수승님·수제자 각각 +1MP",
      baseAmount: 1,
      pairedAward: true,
    },
  ],
  senior_mentor: [
    {
      key: "mentor_grace",
      label: "수승의 은혜",
      description: "짝 멘티가 개인 MP를 얻으면 자동 +1MP",
      passive: true,
    },
    {
      key: "relief_pitcher",
      label: "구원투수",
      description: "수승님·수제자 각각 +1MP",
      baseAmount: 1,
      pairedAward: true,
    },
    {
      key: "eagle_eye_mentor",
      label: "매의 눈",
      description: "오류를 정확히 고치면 +1MP",
      baseAmount: 1,
    },
    {
      key: "mentor_prophecy",
      label: "수승의 예언",
      description: "예언 성공 시 +2MP",
      baseAmount: 2,
    },
  ],
  guardian: [
    {
      key: "never_give_up",
      label: "포기란 없다!",
      description: "발표 일부 성공 시 +1MP · 3·4번 자리에서는 수승의 은혜 발동",
      baseAmount: 1,
    },
  ],
};
