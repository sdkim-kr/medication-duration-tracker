import { defineConfig } from "vitest/config";

// 테스트는 워치 모드가 아닌 단일 실행(`vitest --run`)으로 수행한다.
// 워치는 기본적으로 비활성화하고, Node 환경에서 ES 모듈로 테스트를 실행한다.
export default defineConfig({
  test: {
    // 워치 비활성화 기본값. CLI의 `--run` 플래그와 함께 단일 실행을 보장한다.
    watch: false,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.js", "test/**/*.test.js"],
  },
});
