import { expect, it } from "vite-plus/test";
import { Admission } from "./queued-admission.ts";

it("queues uploads until a slot is released and releases each slot once", async () => {
  const admission = new Admission();
  const first = await admission.acquire(true);
  const second = await admission.acquire(true);
  const order: number[] = [];
  const third = admission.acquire(true).then((release) => {
    order.push(3);
    return release;
  });
  const fourth = admission.acquire(true).then((release) => {
    order.push(4);
    return release;
  });
  expect(order).toEqual([]);
  first();
  const releaseThird = await third;
  expect(order).toEqual([3]);
  first();
  expect(order).toEqual([3]);
  second();
  const releaseFourth = await fourth;
  expect(order).toEqual([3, 4]);
  releaseThird();
  releaseFourth();
});
