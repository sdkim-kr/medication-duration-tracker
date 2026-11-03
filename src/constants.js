// Feature: medication-duration-tracker
// 공용 상수·제약, 공통 JSDoc 타입 정의, 그리고 입력 경로가 공유하는 분 해상도 절삭 유틸.
// _Requirements: 2.1, 7.4_

// ---------------------------------------------------------------------------
// 공용 상수 및 제약 (Constraints)
// ---------------------------------------------------------------------------

/** 약물명 최대 길이(문자 수). 공백 제거 후 1..100자 제약의 상한. */
export const MAX_MEDICATION_NAME_LEN = 100;

/** Effect_Duration(분) 최솟값. */
export const EFFECT_DURATION_MIN = 1;

/** Effect_Duration(분) 최댓값. 10,080분 = 7일. */
export const EFFECT_DURATION_MAX = 10080;

/** Effect_Duration이 이 값(분, 24시간)을 초과하면 사용자 확인이 필요하다(Requirement 5.5). */
export const EFFECT_DURATION_CONFIRM_THRESHOLD = 1440;

/** 단일 음성 입력의 오디오 캡처 자동 종료까지의 최대 녹음 시간(초). */
export const MAX_RECORDING_DURATION_SEC = 180;

/** Dose_Time 미래 허용 오차(초). 현재 시각 + 이 값을 초과하는 미래는 거부(Requirement 5.1). */
export const FUTURE_TOLERANCE_SEC = 60;

/** 연속 실패·약물명 추출 재요청 최대 횟수(Requirement 1.6, 2.3, 2.5). */
export const MAX_RETRY = 3;

/** 추출·확인되지 않은 값을 나타내는 상태 문자열. 집계에서 항상 제외된다. */
export const UNKNOWN = "확인되지 않음";

// ---------------------------------------------------------------------------
// 공통 타입 정의 (JSDoc typedefs)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MedicationRecord
 * @property {string} id - 고유 식별자 (예: crypto.randomUUID()).
 * @property {string} medicationName - 약물명, 1..100자.
 * @property {number} doseTime - 복용 시각, epoch ms, 분 해상도(초/밀리초 0).
 * @property {number|'확인되지 않음'} effectDuration - 효과 지속 시간(분), 1..10080 또는 '확인되지 않음'.
 * @property {number} createdAt - 레코드 생성 시각, epoch ms.
 */

/**
 * 저장 전 공통 중간 표현. 음성·텍스트 두 입력 경로가 수렴하는 단일 계약이다.
 * @typedef {Object} InputDraft
 * @property {string|null} medicationName - 약물명, 최대 100자 (미추출/미입력 시 null).
 * @property {number|null} doseTime - 복용 시각, epoch ms, 분 해상도 (미지정 시 현재 시각으로 설정).
 * @property {number|'확인되지 않음'|null} effectDuration - 효과 지속 시간(분), 1..10080 또는 '확인되지 않음'.
 * @property {'voice'|'text'} source - 입력 출처. 확인 이후 로직은 이 값과 무관하게 동작한다.
 * @property {string[]} missing - 추출/입력되지 않은 필드 목록.
 */

/**
 * `id`, `createdAt`을 제외한 사용자 확인 값. 저장 시 Record_Store가 식별자와 생성 시각을 부여한다.
 * @typedef {Object} MedicationRecordInput
 * @property {string} medicationName - 약물명, 1..100자.
 * @property {number} doseTime - 복용 시각, epoch ms, 분 해상도.
 * @property {number|'확인되지 않음'} effectDuration - 효과 지속 시간(분), 1..10080 또는 '확인되지 않음'.
 */

/**
 * @typedef {Object} DateRange
 * @property {number} startMs - 기간 시작, epoch ms (포함).
 * @property {number} endMs - 기간 끝, epoch ms (포함).
 */

/**
 * 음성 경로(Record_Parser.parse)의 추출 결과. source를 제외하면 InputDraft와 동일한 형태.
 * @typedef {Object} ParseResult
 * @property {string|null} medicationName - 약물명, 최대 100자 (미추출 시 null).
 * @property {number|null} doseTime - 복용 시각, epoch ms, 분 해상도.
 * @property {number|'확인되지 않음'|null} effectDuration - 효과 지속 시간(분), 1..10080 또는 '확인되지 않음'.
 * @property {'voice'} source - 입력 출처(음성).
 * @property {string[]} missing - 추출 실패 필드 목록.
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {number|null} average - 분 단위 정수(반올림), 집계 0건이면 null.
 * @property {'증가'|'감소'|'변화 없음'|null} trend - 2건 미만이면 null.
 * @property {number} includedCount - 집계에 포함된 기록 수.
 * @property {number} excludedUnknownCount - '확인되지 않음' 제외 건수.
 * @property {'ok'|'데이터 부족'|'집계 가능 데이터 없음'} status - 집계 상태.
 */

/**
 * @typedef {Object} ComparisonPerMedication
 * @property {string} medicationName - 약물명.
 * @property {number|null} average - 분 단위 정수(반올림), 집계 0건이면 null.
 * @property {'증가'|'감소'|'변화 없음'|null} trend - 2건 미만이면 null.
 * @property {number} includedCount - 집계에 포함된 기록 수.
 * @property {number} excludedUnknownCount - '확인되지 않음' 제외 건수.
 * @property {'ok'|'데이터 부족'} status - 약물별 집계 상태.
 */

/**
 * @typedef {Object} ComparisonResult
 * @property {ComparisonPerMedication[]} perMedication - 약물별 통계 목록(나란히 비교).
 * @property {string} [invalid] - 비교 불가 안내 메시지(약물 2개 미만 시).
 */

// ---------------------------------------------------------------------------
// 공유 유틸 (Shared utilities)
// ---------------------------------------------------------------------------

/**
 * 타임스탬프(epoch ms)를 분 해상도로 절삭한다(초·밀리초를 0으로 만든다).
 * 파서·텍스트 입력·저장이 복용 시각을 분 해상도로 맞추기 위해 공유한다.
 * @param {number} ms - epoch 밀리초.
 * @returns {number} 분 해상도로 절삭된 epoch 밀리초.
 */
export function truncateToMinute(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new TypeError("truncateToMinute: ms는 유한한 number여야 합니다.");
  }
  const MS_PER_MINUTE = 60 * 1000;
  return Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
}
