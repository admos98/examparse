import test from "node:test";
import assert from "node:assert/strict";
import { isNearUniformColor } from "../src/utils/hash";
test("thin nonuniform strips are not classified as uniform merely for being under 32px; one-pixel dimensions terminate", () => {
  const canvas = (width: number, height: number, uniform = false) =>
    ({
      width,
      height,
      getContext: () => ({
        getImageData: (x: number, y: number) => ({
          data: [uniform ? 100 : x * 2, uniform ? 100 : y * 12, 50, 255],
        }),
      }),
    }) as unknown as HTMLCanvasElement;
  assert.equal(isNearUniformColor(canvas(100, 10)), false);
  assert.equal(isNearUniformColor(canvas(100, 1)), false);
  assert.equal(isNearUniformColor(canvas(1, 100)), false);
  assert.equal(isNearUniformColor(canvas(100, 10, true)), true);
  assert.equal(isNearUniformColor(canvas(1, 1, true)), true);
});
