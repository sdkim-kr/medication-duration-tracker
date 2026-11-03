// Feature: medication-duration-tracker
// Comparison_Engine: 2개 이상 약물의 통계를 나란히 비교 (Requirement 6).
// 순수 함수 compare(recordsByMedication, range) — 저장소를 읽지 않으며 통계 필드만 반환한다.
// 각 약물의 통계는 Analysis_Engine.analyze의 산출 규칙을 재사용하여 단일 분석과의 일관성을 유지한다.
// 결과는 사용자가 관찰·보고한 데이터에 근거한 통계값으로만 표시하며,
// 어떤 약물이 더 우수하다는 식의 효능·안전성 결론이나 단정적 표현을 포함하지 않는다(Requirement 6.7).
// _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

import { analyze } from "./Analysis_Engine.js";

/** 비교에 필요한 최소 약물 수(Requirement 6.2). */
const MIN_COMPARISON_SET_SIZE = 2;

/** 약물 2개 미만일 때 반환하는 안내 메시지(Requirement 6.2). */
const INVALID_GUIDANCE = "비교에는 2개 이상의 약물이 필요합니다";

/**
 * Analysis_Engine의 AnalysisResult를 비교용 약물별 통계로 변환한다.
 *
 * 비교 결과의 약물별 status는 'ok' 또는 '데이터 부족' 두 가지만 사용한다.
 * analyze의 '집계 가능 데이터 없음'(0건)과 '데이터 부족'(2건 미만)은
 * 모두 비교 관점에서 '데이터 부족'으로 격리한다(Requirement 6.5).
 * 평균·추세·포함 건수·'확인되지 않음' 제외 건수는 analyze 결과를 그대로 재사용하여
 * 단일 분석과의 동치를 유지한다(Requirement 6.3, 6.6).
 *
 * @param {string} medicationName - 약물명.
 * @param {import('./constants.js').AnalysisResult} result - analyze 산출 결과.
 * @returns {import('./constants.js').ComparisonPerMedication}
 */
function toPerMedication(medicationName, result) {
  // analyze의 'ok'만 비교에서도 'ok'로 유지하고, 그 외(0건·2건 미만)는 '데이터 부족'으로 격리한다.
  const status = result.status === "ok" ? "ok" : "데이터 부족";
  return {
    medicationName,
    average: result.average,
    trend: result.trend,
    includedCount: result.includedCount,
    excludedUnknownCount: result.excludedUnknownCount,
    status,
  };
}

/**
 * 2개 이상 약물의 Effect_Duration 통계를 나란히 비교한다. 순수 함수이며 저장소를 읽지 않는다.
 *
 * - Comparison_Set(약물명→기록 맵)의 크기가 2 미만이면 비교를 수행하지 않고 안내만 반환한다(Requirement 6.2).
 * - 각 약물의 통계는 Analysis_Engine.analyze를 재사용하여 산출한다(Requirement 6.3). 따라서 기간 필터와
 *   '확인되지 않음' 제외·제외 건수 보고(Requirement 6.6)는 단일 분석과 동일하게 적용된다.
 * - 특정 약물의 집계 대상이 0건 또는 2건 미만이면 해당 약물만 '데이터 부족'으로 표시하고,
 *   나머지 약물의 비교는 영향을 받지 않고 계속 수행한다(Requirement 6.5).
 * - 반환되는 각 약물 항목은 평균·추세·집계 기록 수를 나란히 비교할 수 있는 통계 필드만 포함하며,
 *   어떤 약물이 더 우수하다는 결론을 포함하지 않는다(Requirement 6.4, 6.7).
 *
 * @param {Map<string, import('./constants.js').MedicationRecord[]>} recordsByMedication
 *   - 약물명 → 해당 약물 기록 집합. Map 또는 동등한 entries 순회가 가능한 객체.
 * @param {import('./constants.js').DateRange} [range] - 비교 기간(포함). 생략 시 전체 기록 대상.
 * @returns {import('./constants.js').ComparisonResult}
 */
export function compare(recordsByMedication, range) {
  // 입력 정규화: Map 또는 일반 객체를 [name, records] 엔트리 배열로 변환한다.
  const entries = normalizeEntries(recordsByMedication);

  // Comparison_Set 크기 2 미만: 비교 미수행, 안내만 반환(Requirement 6.2).
  if (entries.length < MIN_COMPARISON_SET_SIZE) {
    return {
      perMedication: [],
      invalid: INVALID_GUIDANCE,
    };
  }

  // 각 약물에 대해 analyze를 적용하여 통계를 나란히 산출한다(Requirement 6.3, 6.4).
  // 특정 약물의 데이터 부족은 해당 약물에만 격리되고 나머지는 계속 산출된다(Requirement 6.5).
  const perMedication = entries.map(([medicationName, records]) => {
    const result = analyze(Array.isArray(records) ? records : [], range);
    return toPerMedication(medicationName, result);
  });

  return { perMedication };
}

/**
 * recordsByMedication를 [name, records] 엔트리 배열로 정규화한다.
 * Map, 또는 { name: records } 형태의 일반 객체를 허용하며, 그 외에는 빈 배열로 처리한다.
 * @param {Map<string, import('./constants.js').MedicationRecord[]>|Object|null|undefined} input
 * @returns {Array<[string, import('./constants.js').MedicationRecord[]]>}
 */
function normalizeEntries(input) {
  if (input instanceof Map) {
    return [...input.entries()];
  }
  if (input && typeof input === "object") {
    return Object.entries(input);
  }
  return [];
}

export default { compare };
