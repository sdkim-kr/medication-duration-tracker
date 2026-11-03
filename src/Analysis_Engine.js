// Feature: medication-duration-tracker
// Analysis_Engine: 단일 약물의 평균·추세 산출 (Requirement 4).
// 순수 함수 analyze(records, range) — 저장소를 읽지 않으며 통계 필드만 반환한다.
// 결과는 사용자가 관찰·보고한 데이터에 근거한 통계값으로만 표시하며,
// 약물의 효능·안전성에 대한 의학적 결론이나 단정적 표현을 포함하지 않는다(Requirement 4.6).
// _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

import { UNKNOWN } from "./constants.js";

/**
 * 기록이 분석 기간(DateRange) 내에 있는지 판정한다.
 * range가 없으면 모든 기록을 대상으로 한다.
 * @param {import('./constants.js').MedicationRecord} record
 * @param {import('./constants.js').DateRange} [range]
 * @returns {boolean}
 */
function isWithinRange(record, range) {
  if (!range || typeof range !== "object") return true;
  const { startMs, endMs } = range;
  const t = record.doseTime;
  if (typeof startMs === "number" && t < startMs) return false;
  if (typeof endMs === "number" && t > endMs) return false;
  return true;
}

/**
 * Effect_Duration이 '확인되지 않음'인지 판정한다.
 * '확인되지 않음' 기록은 모든 집계(평균·추세)에서 제외된다(Requirement 4.4).
 * @param {import('./constants.js').MedicationRecord} record
 * @returns {boolean}
 */
function isUnknown(record) {
  return record.effectDuration === UNKNOWN;
}

/**
 * 집계 대상(기간 내 + '확인되지 않음'이 아닌) 기록 집합에 대해
 * Effect_Duration의 산술 평균을 소수 첫째 자리에서 반올림한 분 단위 정수로 산출한다(Requirement 4.1).
 * @param {import('./constants.js').MedicationRecord[]} included - 집계 대상 기록.
 * @returns {number} 분 단위 정수 평균.
 */
function computeAverage(included) {
  const sum = included.reduce((acc, r) => acc + r.effectDuration, 0);
  // 소수 첫째 자리에서 반올림 → 분 단위 정수(Requirement 4.1).
  return Math.round(sum / included.length);
}

/**
 * 집계 대상 기록을 기록 시각(doseTime) 오름차순으로 정렬한 뒤,
 * 첫 기록과 마지막 기록의 Effect_Duration을 비교하여 추세를 산출한다(Requirement 4.2).
 * @param {import('./constants.js').MedicationRecord[]} included - 집계 대상 기록(2건 이상).
 * @returns {'증가'|'감소'|'변화 없음'}
 */
function computeTrend(included) {
  const sorted = [...included].sort((a, b) => a.doseTime - b.doseTime);
  const first = sorted[0].effectDuration;
  const last = sorted[sorted.length - 1].effectDuration;
  if (last > first) return "증가";
  if (last < first) return "감소";
  return "변화 없음";
}

/**
 * 단일 약물의 평균·추세를 산출한다. 순수 함수이며 저장소를 읽지 않는다.
 *
 * - 기간(range) 내 기록만 대상으로 하며, '확인되지 않음' 기록은 집계에서 제외한다(Requirement 4.4).
 * - 평균은 집계 대상의 Effect_Duration 산술 평균을 분 단위 정수(소수 첫째 자리 반올림)로 산출한다(Requirement 4.1).
 * - 추세는 집계 대상을 doseTime 오름차순 정렬 후 첫·마지막 비교로 산출한다(Requirement 4.2).
 * - 집계 대상이 2건 미만이면 추세를 산출하지 않는다(trend=null)(Requirement 4.3).
 * - 집계 대상이 0건이면 평균·추세를 산출하지 않는다(Requirement 4.5).
 * - 결과는 통계·열거 필드만 포함하며 의학적 결론을 포함하지 않는다(Requirement 4.6).
 *
 * @param {import('./constants.js').MedicationRecord[]} records - 분석 대상 기록 집합.
 * @param {import('./constants.js').DateRange} [range] - 분석 기간(포함). 생략 시 전체 기록 대상.
 * @returns {import('./constants.js').AnalysisResult}
 */
export function analyze(records, range) {
  const all = Array.isArray(records) ? records : [];

  // 기간 필터 적용(Requirement 4.1, 4.2 — "해당 기간 내 집계 대상 기록").
  const inRange = all.filter((r) => isWithinRange(r, range));

  // '확인되지 않음' 제외 및 제외 건수 집계(Requirement 4.4).
  const included = inRange.filter((r) => !isUnknown(r));
  const excludedUnknownCount = inRange.length - included.length;
  const includedCount = included.length;

  // 집계 대상 0건: 평균·추세 미산출(Requirement 4.5).
  if (includedCount === 0) {
    return {
      average: null,
      trend: null,
      includedCount: 0,
      excludedUnknownCount,
      status: "집계 가능 데이터 없음",
    };
  }

  const average = computeAverage(included);

  // 집계 대상 2건 미만: 추세 미산출·데이터 부족(Requirement 4.3).
  if (includedCount < 2) {
    return {
      average,
      trend: null,
      includedCount,
      excludedUnknownCount,
      status: "데이터 부족",
    };
  }

  const trend = computeTrend(included);

  return {
    average,
    trend,
    includedCount,
    excludedUnknownCount,
    status: "ok",
  };
}

export default { analyze };
