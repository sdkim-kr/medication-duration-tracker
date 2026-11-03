// Feature: medication-duration-tracker
// retry: 재시도 카운터(연속 실패·약물명 추출 실패) 순수 로직 (Requirement 1.6, 2.3, 2.5).
//
// 연속 실패 횟수 n을 추적하는 순수 함수 모음.
// - n < MAX_RETRY: 재시도 허용(계속).
// - n >= MAX_RETRY: 재시도 중단, 수동 입력 필요 상태 반환.
// 약물명 추출 실패 재요청(최대 MAX_RETRY회)과 3회 실패 시 미저장 상태 유지 판정에 재사용된다.
//
// 어떤 값도 저장하지 않으며, 불변(immutable) 상태 전이로만 동작한다.

import { MAX_RETRY } from "./constants.js";

/**
 * 재시도 진행 상태를 나타내는 구분 코드.
 * @readonly
 * @enum {string}
 */
export const RetryStatus = Object.freeze({
  /** n < MAX_RETRY: 아직 재시도가 허용된다(재시도 안내 계속). */
  RETRYABLE: "RETRYABLE",
  /** n >= MAX_RETRY: 재시도 중단, 수동 입력이 필요한 상태. */
  MANUAL_INPUT_REQUIRED: "MANUAL_INPUT_REQUIRED",
});

/**
 * 재시도 카운터 상태.
 * @typedef {Object} RetryState
 * @property {number} failureCount - 지금까지의 연속 실패 횟수 n (0 이상 정수).
 * @property {number} maxRetry - 재시도 중단 임계값(기본 MAX_RETRY).
 * @property {RetryStatus} status - 현재 상태(RETRYABLE | MANUAL_INPUT_REQUIRED).
 * @property {boolean} canRetry - 재시도가 허용되는지 여부(n < maxRetry).
 * @property {boolean} manualInputRequired - 수동 입력이 필요한지 여부(n >= maxRetry).
 * @property {number} attemptsRemaining - 중단 전 남은 재시도 횟수(max(0, maxRetry - n)).
 */

/**
 * failureCount와 maxRetry로부터 파생 상태를 계산하여 동결된 RetryState를 만든다.
 * @param {number} failureCount - 연속 실패 횟수 n.
 * @param {number} maxRetry - 재시도 중단 임계값.
 * @returns {RetryState}
 */
function makeState(failureCount, maxRetry) {
  // n >= maxRetry 이면 재시도 중단·수동 입력 필요(Requirement 1.6).
  const manualInputRequired = failureCount >= maxRetry;
  const canRetry = !manualInputRequired;
  return Object.freeze({
    failureCount,
    maxRetry,
    status: manualInputRequired
      ? RetryStatus.MANUAL_INPUT_REQUIRED
      : RetryStatus.RETRYABLE,
    canRetry,
    manualInputRequired,
    attemptsRemaining: Math.max(0, maxRetry - failureCount),
  });
}

/**
 * 새 재시도 카운터를 생성한다. 실패 횟수는 0에서 시작한다.
 * @param {number} [maxRetry=MAX_RETRY] - 재시도 중단 임계값. 1 이상의 정수여야 한다.
 * @returns {RetryState}
 */
export function createRetryCounter(maxRetry = MAX_RETRY) {
  if (!Number.isInteger(maxRetry) || maxRetry < 1) {
    throw new RangeError("createRetryCounter: maxRetry는 1 이상의 정수여야 합니다.");
  }
  return makeState(0, maxRetry);
}

/**
 * 실패를 1회 기록하여 다음 상태를 반환한다(불변 전이).
 * 이미 임계에 도달한 상태에서 호출해도 failureCount는 계속 증가하지만,
 * 상태는 MANUAL_INPUT_REQUIRED로 유지된다.
 * @param {RetryState} state - 현재 재시도 상태.
 * @returns {RetryState} 실패 횟수가 1 증가한 새 상태.
 */
export function recordFailure(state) {
  const { failureCount, maxRetry } = normalize(state);
  return makeState(failureCount + 1, maxRetry);
}

/**
 * 성공 시 연속 실패 카운터를 초기화한다(연속 실패만 추적하므로 성공하면 0으로 리셋).
 * @param {RetryState} state - 현재 재시도 상태.
 * @returns {RetryState} 실패 횟수가 0으로 초기화된 새 상태.
 */
export function reset(state) {
  const { maxRetry } = normalize(state);
  return makeState(0, maxRetry);
}

/**
 * 현재 상태에서 재시도가 허용되는지 여부(n < maxRetry).
 * @param {RetryState} state
 * @returns {boolean}
 */
export function canRetry(state) {
  const { failureCount, maxRetry } = normalize(state);
  return failureCount < maxRetry;
}

/**
 * 현재 상태에서 재시도를 중단하고 수동 입력이 필요한지 여부(n >= maxRetry).
 * 약물명 추출이 maxRetry회 모두 실패하면 해당 레코드를 저장하지 않은 상태로 유지해야 한다(Requirement 2.5).
 * @param {RetryState} state
 * @returns {boolean}
 */
export function isManualInputRequired(state) {
  return !canRetry(state);
}

/**
 * 임의의 실패 횟수 n과 임계값에 대해 상태를 직접 평가한다(저장된 카운터 없이 판정할 때 사용).
 * @param {number} failureCount - 연속 실패 횟수 n (0 이상 정수).
 * @param {number} [maxRetry=MAX_RETRY] - 재시도 중단 임계값.
 * @returns {RetryState}
 */
export function evaluate(failureCount, maxRetry = MAX_RETRY) {
  if (!Number.isInteger(failureCount) || failureCount < 0) {
    throw new RangeError("evaluate: failureCount는 0 이상의 정수여야 합니다.");
  }
  if (!Number.isInteger(maxRetry) || maxRetry < 1) {
    throw new RangeError("evaluate: maxRetry는 1 이상의 정수여야 합니다.");
  }
  return makeState(failureCount, maxRetry);
}

/**
 * 입력 상태를 { failureCount, maxRetry }로 정규화한다.
 * RetryState 객체가 아니면 안전한 기본값으로 보정한다.
 * @param {*} state
 * @returns {{ failureCount: number, maxRetry: number }}
 */
function normalize(state) {
  const obj = state && typeof state === "object" ? state : {};
  const failureCount =
    Number.isInteger(obj.failureCount) && obj.failureCount >= 0
      ? obj.failureCount
      : 0;
  const maxRetry =
    Number.isInteger(obj.maxRetry) && obj.maxRetry >= 1 ? obj.maxRetry : MAX_RETRY;
  return { failureCount, maxRetry };
}
