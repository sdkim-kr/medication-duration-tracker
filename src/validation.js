// Feature: medication-duration-tracker
// validation: 저장 전 입력 검증(공통 순수 로직) (Requirement 5).
// 순수 함수만 포함한다. 어떤 값도 저장하지 않으며, 거부 사유를 구분된 코드로 반환한다.
// _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

import {
  MAX_MEDICATION_NAME_LEN,
  EFFECT_DURATION_CONFIRM_THRESHOLD,
  FUTURE_TOLERANCE_SEC,
  UNKNOWN,
} from "./constants.js";

/**
 * 구분된 거부 사유 코드. UI·저장 경로가 사유별로 분기·메시지 표시에 사용한다.
 * 어떤 코드도 저장을 수행하지 않으며, 검증 결과 메타데이터로만 쓰인다.
 * @readonly
 * @enum {string}
 */
export const ValidationCode = {
  // Dose_Time (Requirement 5.1, 5.2)
  DOSE_TIME_EMPTY: "DOSE_TIME_EMPTY", // 비어 있음 (5.2)
  DOSE_TIME_INVALID: "DOSE_TIME_INVALID", // 유효한 시각 형식이 아님 (5.2)
  DOSE_TIME_FUTURE: "DOSE_TIME_FUTURE", // 현재 시각 + 60초 초과 미래 (5.1)
  // Effect_Duration (Requirement 5.3, 5.4)
  EFFECT_DURATION_EMPTY: "EFFECT_DURATION_EMPTY", // 비어 있음 (5.4)
  EFFECT_DURATION_NOT_INTEGER: "EFFECT_DURATION_NOT_INTEGER", // 정수 아님 (5.4)
  EFFECT_DURATION_NEGATIVE: "EFFECT_DURATION_NEGATIVE", // 음수 (5.3)
  // Medication_Name
  MEDICATION_NAME_EMPTY: "MEDICATION_NAME_EMPTY", // 공백 제거 후 빈 값
  MEDICATION_NAME_TOO_LONG: "MEDICATION_NAME_TOO_LONG", // 100자 초과
};

/**
 * 단일 필드 검증 결과.
 * @typedef {Object} FieldValidationResult
 * @property {boolean} valid - 유효 여부.
 * @property {ValidationCode|null} code - 거부 사유 코드(유효하면 null).
 * @property {boolean} [needsConfirmation] - Effect_Duration이 임계(1,440분)를 초과하여 사용자 확인이 필요함(Requirement 5.5).
 * @property {number} [value] - 정규화된 값(유효 시).
 */

/**
 * 전체 입력 검증 결과.
 * @typedef {Object} InputValidationResult
 * @property {boolean} valid - 모든 필드가 유효한지 여부.
 * @property {ValidationCode[]} codes - 발생한 모든 거부 사유 코드(유효하면 빈 배열).
 * @property {boolean} needsConfirmation - 저장 전 사용자 확인이 필요한지 여부(Effect_Duration > 1,440분).
 * @property {{ medicationName: FieldValidationResult, doseTime: FieldValidationResult, effectDuration: FieldValidationResult }} fields - 필드별 상세 결과.
 */

/**
 * Dose_Time을 검증한다.
 * 거부: 비어 있음(5.2), 유효한 시각 형식 아님(5.2), 현재 시각 + 60초 초과 미래(5.1).
 * @param {number|string|null|undefined} doseTime - epoch ms 또는 파싱 가능한 날짜 문자열.
 * @param {number} now - 기준 현재 시각(epoch ms). 미래 판정에 사용.
 * @returns {FieldValidationResult}
 */
export function validateDoseTime(doseTime, now) {
  // 비어 있음: null/undefined/빈 문자열/공백 전용 (Requirement 5.2)
  if (
    doseTime === null ||
    doseTime === undefined ||
    (typeof doseTime === "string" && doseTime.trim() === "")
  ) {
    return { valid: false, code: ValidationCode.DOSE_TIME_EMPTY };
  }

  // epoch ms(number) 또는 파싱 가능한 날짜 문자열을 타임스탬프로 정규화
  let ms;
  if (typeof doseTime === "number") {
    ms = doseTime;
  } else if (typeof doseTime === "string") {
    ms = Date.parse(doseTime);
  } else {
    // boolean·object 등 지원하지 않는 타입은 유효한 시각 형식이 아님 (Requirement 5.2)
    return { valid: false, code: ValidationCode.DOSE_TIME_INVALID };
  }

  // 유효한 시각 형식이 아님: NaN·Infinity (Requirement 5.2)
  if (!Number.isFinite(ms)) {
    return { valid: false, code: ValidationCode.DOSE_TIME_INVALID };
  }

  // 현재 시각 + 허용 오차(60초)를 초과하는 미래 거부 (Requirement 5.1)
  const futureLimit = now + FUTURE_TOLERANCE_SEC * 1000;
  if (ms > futureLimit) {
    return { valid: false, code: ValidationCode.DOSE_TIME_FUTURE };
  }

  return { valid: true, code: null, value: ms };
}

/**
 * Effect_Duration을 검증한다.
 * '확인되지 않음'은 유효한 미집계 상태로 통과시킨다(저장 모델에서 허용되는 값).
 * 거부: 음수(5.3), 비어 있음(5.4), 정수 아님(5.4).
 * 1,440분 초과 시 needsConfirmation=true 플래그를 반환한다(Requirement 5.5, 거부는 아님).
 * @param {number|string|null|undefined|'확인되지 않음'} effectDuration
 * @returns {FieldValidationResult}
 */
export function validateEffectDuration(effectDuration) {
  // '확인되지 않음' 상태는 유효(집계에서 제외되는 미확인 값)
  if (effectDuration === UNKNOWN) {
    return { valid: true, code: null, value: undefined };
  }

  // 비어 있음: null/undefined/빈 문자열/공백 전용 (Requirement 5.4)
  if (
    effectDuration === null ||
    effectDuration === undefined ||
    (typeof effectDuration === "string" && effectDuration.trim() === "")
  ) {
    return { valid: false, code: ValidationCode.EFFECT_DURATION_EMPTY };
  }

  // 숫자로 정규화. 문자열은 정수 표기만 허용(공백 허용), 소수·비수치 표기는 거부.
  let num;
  if (typeof effectDuration === "number") {
    num = effectDuration;
  } else if (typeof effectDuration === "string") {
    const trimmed = effectDuration.trim();
    // 선택적 부호 + 숫자만 허용(정수 표기). "12.5", "1e3", "abc" 등은 비정수로 간주.
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return { valid: false, code: ValidationCode.EFFECT_DURATION_NOT_INTEGER };
    }
    num = Number(trimmed);
  } else {
    // boolean·object 등은 정수가 아님 (Requirement 5.4)
    return { valid: false, code: ValidationCode.EFFECT_DURATION_NOT_INTEGER };
  }

  // 정수가 아님: NaN·Infinity·소수 (Requirement 5.4)
  if (!Number.isInteger(num)) {
    return { valid: false, code: ValidationCode.EFFECT_DURATION_NOT_INTEGER };
  }

  // 음수 거부 (Requirement 5.3)
  if (num < 0) {
    return { valid: false, code: ValidationCode.EFFECT_DURATION_NEGATIVE };
  }

  // 1,440분(24시간) 초과 시 사용자 확인 필요 플래그 (Requirement 5.5)
  if (num > EFFECT_DURATION_CONFIRM_THRESHOLD) {
    return { valid: true, code: null, needsConfirmation: true, value: num };
  }

  return { valid: true, code: null, value: num };
}

/**
 * Medication_Name을 검증한다. 공백 제거(trim) 후 1..100자 제약.
 * @param {string|null|undefined} medicationName
 * @returns {FieldValidationResult}
 */
export function validateMedicationName(medicationName) {
  if (typeof medicationName !== "string") {
    return { valid: false, code: ValidationCode.MEDICATION_NAME_EMPTY };
  }
  const trimmed = medicationName.trim();
  if (trimmed.length < 1) {
    return { valid: false, code: ValidationCode.MEDICATION_NAME_EMPTY };
  }
  if (trimmed.length > MAX_MEDICATION_NAME_LEN) {
    return { valid: false, code: ValidationCode.MEDICATION_NAME_TOO_LONG };
  }
  return { valid: true, code: null, value: trimmed };
}

/**
 * 저장 전 입력 후보 전체를 검증한다. 어떤 값도 저장하지 않는다.
 * 각 필드를 독립적으로 검증하여 발생한 모든 거부 사유 코드를 모아 반환한다.
 * @param {{ medicationName?: string, doseTime?: number|string|null, effectDuration?: number|string|null|'확인되지 않음' }} candidate
 * @param {number} now - 기준 현재 시각(epoch ms).
 * @returns {InputValidationResult}
 */
export function validateInput(candidate, now) {
  const input = candidate ?? {};
  const medicationName = validateMedicationName(input.medicationName);
  const doseTime = validateDoseTime(input.doseTime, now);
  const effectDuration = validateEffectDuration(input.effectDuration);

  const codes = [];
  if (!medicationName.valid) codes.push(medicationName.code);
  if (!doseTime.valid) codes.push(doseTime.code);
  if (!effectDuration.valid) codes.push(effectDuration.code);

  return {
    valid: codes.length === 0,
    codes,
    needsConfirmation: effectDuration.needsConfirmation === true,
    fields: { medicationName, doseTime, effectDuration },
  };
}
