// Feature: medication-duration-tracker
// Text_Input_Module: 텍스트 직접 입력을 받아 Input_Draft를 구성 (Requirement 7).
// 음성 경로의 Record_Parser.parse와 동일한 형태(Input_Draft, source 제외 시 ParseResult와 동일)를
// 산출하여 이후 확인·검증·저장 경로를 공유한다.
// 이 모듈은 저장·검증·개인정보 검사를 수행하지 않는다. 그 로직은 공통 저장 경로에서 수행된다.
// _Requirements: 7.2, 7.3, 7.4_

import { truncateToMinute, UNKNOWN } from "./constants.js";

/**
 * 값이 "비어 있는지" 판정한다. null/undefined/빈 문자열/공백 전용 문자열을 비어 있음으로 본다.
 * @param {*} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/**
 * 사용자가 텍스트로 입력한 필드를 받아 Input_Draft 형태 객체로 구성한다. 저장하지 않는다.
 *
 * - Medication_Name이 비어 있으면 `null`로 두고 `missing`에 기록한다.
 * - Dose_Time이 비어 있으면 `now`를 분 해상도로 절삭하여 설정한다(Requirement 7.4,
 *   음성 경로 Requirement 2.2와 동일한 규칙). 이 경우 기본값을 채웠으므로 `missing`에 포함하지 않는다.
 * - Effect_Duration이 비어 있으면 `'확인되지 않음'`으로 두고 `missing`에 기록한다
 *   (음성 경로 Requirement 2.4와 동일). 명시적으로 `'확인되지 않음'`이 전달되어도 동일하게 처리한다.
 *
 * 입력 검증(Requirement 5)·개인정보 검사(Requirement 3)는 여기서 수행하지 않는다. 따라서
 * 전달된 값은 정규화(trim 등)만 하고 유효성은 판단하지 않는다. 구성된 Input_Draft는 음성 경로와
 * 동일한 확인 단계(UI 계층)로 전달된다(Requirement 7.3).
 *
 * @param {{ medicationName?: string|null, doseTime?: number|string|null, effectDuration?: number|string|null|'확인되지 않음' }} fields
 *   사용자가 입력한 필드. 누락된 키는 비어 있는 것으로 간주한다.
 * @param {Date|number} now - 레코드 생성 기준 시각. Date 또는 epoch ms.
 * @returns {import('./constants.js').InputDraft} source: 'text'인 Input_Draft.
 */
export function collectInput(fields, now) {
  const input = fields ?? {};
  const missing = [];

  // 기준 시각을 epoch ms로 정규화한다. (Date | number 모두 허용)
  const nowMs = now instanceof Date ? now.getTime() : now;

  // --- Medication_Name ---
  let medicationName;
  if (isBlank(input.medicationName)) {
    medicationName = null;
    missing.push("medicationName");
  } else {
    // 검증은 공통 경로에서 수행하므로 여기서는 trim 정규화만 한다.
    medicationName = String(input.medicationName).trim();
  }

  // --- Dose_Time ---
  // 비어 있으면 현재 시각(분 해상도)으로 기본값 설정 (Requirement 7.4).
  let doseTime;
  if (isBlank(input.doseTime)) {
    doseTime = truncateToMinute(nowMs);
    // 기본값을 채웠으므로 미입력으로 기록하지 않는다(음성 경로 2.2와 동일하게 '확인되지 않음'이 아닌 기본 적용).
  } else {
    doseTime = input.doseTime;
  }

  // --- Effect_Duration ---
  // 비어 있거나 '확인되지 않음'이면 '확인되지 않음'으로 두고 미입력으로 기록한다(음성 경로 2.4와 동일).
  let effectDuration;
  if (isBlank(input.effectDuration) || input.effectDuration === UNKNOWN) {
    effectDuration = UNKNOWN;
    missing.push("effectDuration");
  } else {
    effectDuration = input.effectDuration;
  }

  return {
    medicationName,
    doseTime,
    effectDuration,
    source: "text",
    missing,
  };
}
