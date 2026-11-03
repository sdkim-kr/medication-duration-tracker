// 러너가 동작함을 확인하는 최소 스모크 테스트.
// vitest 실행과 fast-check 설정 헬퍼가 함께 동작하는지 검증한다.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { NUM_RUNS, fcParams, makeFcParams } from "./fast-check.config.js";

describe("test runner smoke", () => {
  it("vitest가 동작한다", () => {
    expect(1 + 1).toBe(2);
  });

  it("fast-check 기본 설정은 최소 100회 반복을 보장한다", () => {
    expect(NUM_RUNS).toBeGreaterThanOrEqual(100);
    expect(fcParams.numRuns).toBe(100);
    expect(makeFcParams().numRuns).toBe(100);
    // overrides가 100 미만이어도 최소 반복 횟수를 유지한다.
    expect(makeFcParams({ numRuns: 10 }).numRuns).toBe(100);
    // overrides가 100 이상이면 그 값을 사용한다.
    expect(makeFcParams({ numRuns: 250 }).numRuns).toBe(250);
  });

  it("fast-check 속성 실행이 동작한다", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      fcParams,
    );
  });
});
