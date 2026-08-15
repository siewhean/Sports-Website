import { parentPort, workerData } from "node:worker_threads";

import { evaluateScheduleQuality, generateScheduleCandidates, validateSchedule } from "@matchday/domain";

if (parentPort === null) throw new Error("Schedule solver thread requires a parent port");

function isPlacementDeadEnd(error) {
  return error instanceof Error && error.message.startsWith("No valid slot remains for match ");
}

try {
  if (workerData.operation === "generate") {
    let candidates;
    try {
      candidates = generateScheduleCandidates(workerData.problem, {
        startIteration: workerData.iteration,
        maxIterations: 1,
      });
    } catch (error) {
      // A greedy search variation can legitimately paint itself into a corner
      // even when another deterministic variation is feasible. That is a
      // search miss, not corrupted persisted input and not a worker crash.
      // Return zero candidates so DomainScheduleOptimizer can try the next
      // iteration. Strict input validation still happens before the worker.
      if (isPlacementDeadEnd(error)) candidates = [];
      else throw error;
    }
    const result = candidates.map((candidate) => ({
      candidate,
      validation: validateSchedule(workerData.problem, candidate.assignments),
      quality: evaluateScheduleQuality(workerData.problem, candidate.assignments),
    }));
    parentPort.postMessage({ ok: true, result });
  } else if (workerData.operation === "verify") {
    parentPort.postMessage({
      ok: true,
      result: {
        validation: validateSchedule(workerData.problem, workerData.assignments),
        quality: evaluateScheduleQuality(workerData.problem, workerData.assignments),
      },
    });
  } else {
    throw new Error("Unknown schedule solver operation");
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "Schedule solver failed",
  });
}
