// fast-check 기본 설정 헬퍼
//
// 설계 문서(Testing Strategy)에 따라 모든 속성 기반 테스트는 최소 100회 반복한다.
// 각 속성 테스트에서 `fc.assert(..., fcParams)` 형태로 이 설정을 재사용한다.

/**
 * 최소 반복 횟수. 설계 문서 요구사항(numRuns: 100 이상).
 * @type {number}
 */
export const NUM_RUNS = 100;

/**
 * fast-check의 `assert` / `check`에 전달하는 기본 파라미터.
 * @type {{ numRuns: number }}
 */
export const fcParams = Object.freeze({
  numRuns: NUM_RUNS,
});

/**
 * 기본 설정 위에 호출부별 옵션을 덧씌워 파라미터 객체를 만든다.
 * numRuns는 항상 최소 NUM_RUNS 이상을 보장한다.
 * @param {{ numRuns?: number, seed?: number } & Record<string, unknown>} [overrides]
 * @returns {{ numRuns: number } & Record<string, unknown>}
 */
export function makeFcParams(overrides = {}) {
  const merged = { ...fcParams, ...overrides };
  merged.numRuns = Math.max(NUM_RUNS, merged.numRuns ?? NUM_RUNS);
  return merged;
}
