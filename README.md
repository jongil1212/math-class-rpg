# 수학 클래스 RPG · 교사용 1차 웹앱

2학기 수학 모둠활동을 위해 만든 **교사용 관리 웹앱 MVP**입니다.

핵심 목표는 다음과 같습니다.

- 실제 교실과 비슷한 `6모둠 × 4자리` 배치판
- 학생 카드 드래그 앤 드롭 및 자리 교환
- 개인·모둠 MP 빠른 지급
- 역할별 스킬 기록과 MP 계산
- 피버 타임 10분 자동 2배
- 모든 MP 내역 저장 및 취소 기록 보존
- 20MP 달성 시 승급 처리
- 중간고사 이후 새 운영 기간 생성 및 과거 기록 보존

학생용 로그인·조회 페이지, 승급 애니메이션, 칭호는 2차 개발 범위입니다.

---

## 1. 사용 기술

- Next.js 16 App Router
- React 19
- TypeScript
- Supabase Auth + PostgreSQL + RLS
- dnd-kit
- Vercel 배포 가능

---

## 2. 먼저 준비할 것

1. Node.js 22 이상
2. Supabase 프로젝트
3. Supabase Auth에 등록된 교사 이메일 계정 1개
4. Vercel 계정(배포할 때)

---

## 3. Supabase 설정

### 3-1. 프로젝트 만들기

Supabase에서 새 프로젝트를 만듭니다.

### 3-2. 데이터베이스 만들기

Supabase 대시보드의 **SQL Editor**에서 아래 파일을 번호 순서대로 전체 실행합니다.

```text
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_passive_mentor_grace.sql
supabase/migrations/003_auto_seating_mentors.sql
supabase/migrations/004_reset_class_mp.sql
supabase/migrations/005_expand_mentor_grace.sql
supabase/migrations/006_class_and_season_management.sql
supabase/migrations/007_bulk_role_assignment.sql
```

이 파일들은 다음을 생성합니다.

- 학급, 학생, 운영 기간, 모둠 배치
- 수업 세션, MP 기록, 스킬 사용, 승급 기록
- RLS 보안 정책
- MP 지급·취소·피버 타임·승급용 RPC 함수
- 1↔4, 2↔3 좌석 관계에 따른 `수승의 은혜` 자동 MP 지급
- 배치와 역할 변경 시 담당 수승님 관계 자동 동기화
- 기존 거래 기록을 보존하는 학급 MP 전체 초기화
- 수호자와 3인 모둠까지 포함하는 `수승의 은혜` 확장 규칙
- 학년도별 학급 구분과 학급·운영 기간 수정, 보관, 복구, 영구 삭제
- 학생 카드 다중 선택과 역할 일괄 설정

### 3-3. 교사 계정 만들기

Supabase 대시보드에서 다음 메뉴로 이동합니다.

```text
Authentication → Users → Add user
```

교사가 사용할 이메일과 비밀번호를 등록합니다.

현재 1차 버전에는 회원가입 화면이 없으므로, 계정은 관리자 화면에서 직접 만듭니다.

---

## 4. 환경 변수 설정

프로젝트 루트에서 `.env.example`을 복사해 `.env.local`을 만듭니다.

```bash
cp .env.example .env.local
```

Windows에서는 파일을 직접 복사해 이름을 `.env.local`로 바꿔도 됩니다.

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Supabase 프로젝트 설정에서 URL과 Publishable Key를 복사해 넣습니다.

---

## 5. 로컬 실행

```bash
npm install
npm run dev
```

브라우저에서 다음 주소로 접속합니다.

```text
http://localhost:3000
```

---

## 6. 첫 사용 순서

1. 교사 이메일·비밀번호로 로그인
2. `학급 만들기`
3. 첫 운영 기간 생성
4. `학생 명단`에서 아래 형식으로 붙여넣기

```text
1, 김수학
2, 이수학
3, 박수학
```

5. `배치 수정` 클릭
6. 미배치 학생을 빈자리로 드래그
7. 자리 배치 저장
8. 학생 카드를 클릭해 역할과 담당 수승님 지정
9. `오늘 수업 시작`
10. 개인·모둠 MP와 스킬 기록

---

## 7. 역할과 스킬

### 입문자

- 초심자의 행운: 발표 성공 MP 2배, 수업당 1회
- 현재 역할에서 20MP 획득 시 수제자 승급

### 수제자

- 매의 눈: +2MP
- 재도전: MP 없이 사용 기록, 수업당 1회
- 구원투수 도움받음: +1MP

### 수승님

- 수승의 은혜: +1MP
- 구원투수: 수승님과 연결된 학생 각각 +1MP
- 현재 역할에서 20MP 획득 시 상급 수승님 승급

### 상급 수승님

- 수승의 은혜: +1MP
- 구원투수: 각각 +1MP
- 매의 눈: +1MP
- 수승의 예언: +2MP

### 수호자

- 포기란 없다!: +1MP
- 피버 타임: 주 1회, 교사 승인 후 10분간 모든 MP 2배

---

## 8. MP 계산 원칙

```text
모둠 활동 점수 1점 = 모둠원 전원 +1MP
개인 활동 점수 1점 = 해당 학생 +1MP
```

모든 배율은 중복 적용합니다.

```text
발표 성공 +1MP × 초심자의 행운 2배 × 피버 타임 2배 = +4MP
```

수승의 은혜와 수승의 예언도 각각 모두 지급할 수 있습니다.

---

## 9. 데이터 보존 원칙

- MP 합계를 직접 덮어쓰지 않고 모든 거래 내역을 저장합니다.
- 잘못 지급한 MP는 삭제하지 않고 반대 거래를 생성해 취소합니다.
- 중간고사 이후 새 운영 기간을 만들 때 기존 배치와 역할을 복사하거나 빈 배치로 시작할 수 있습니다.
- 모둠과 역할이 바뀌어도 학생의 누적 MP는 유지됩니다.
- 새 역할을 직접 지정하면 그 시점의 누적 MP부터 새 20MP 성장을 시작합니다.

---

## 10. Vercel 배포

1. 이 폴더를 GitHub 저장소에 업로드
2. Vercel에서 저장소 Import
3. Environment Variables에 다음 값 등록

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

4. Deploy

Supabase Auth의 URL 설정에 Vercel 주소를 추가하면 운영 환경에서 로그인할 수 있습니다.

---

## 11. 현재 1차 버전의 제한

- 한 교사가 자신의 학급을 관리하는 구조입니다.
- 학생용 페이지는 없습니다.
- CSV 파일 자체 업로드 대신 명단 복사·붙여넣기를 우선 구현했습니다.
- 피버 타임의 주간 사용 여부는 서버에서 최종 검증합니다. 다른 수업에서 이미 사용했다면 시작 요청 시 안내 오류가 표시됩니다.
- 구원투수 대상이 여러 명이면 간단한 확인창으로 대상 학생을 고릅니다.
- 승급 애니메이션과 칭호는 데이터 구조만 확장 가능한 상태이며 화면에는 아직 없습니다.

---

## 12. 주요 파일

```text
src/components/dashboard-client.tsx   교사용 전체 관리 화면
src/components/seating-board.tsx      드래그 앤 드롭 모둠 배치판
src/components/student-card.tsx       역할·MP 학생 카드
src/lib/skills.ts                     역할별 스킬 설정
supabase/migrations/001_initial_schema.sql
                                       데이터베이스·RLS·RPC
```
