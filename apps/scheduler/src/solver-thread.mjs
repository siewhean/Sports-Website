import { parentPort, workerData } from "node:worker_threads";

import { evaluateScheduleQuality, generateScheduleCandidates, validateSchedule } from "@matchday/domain";

if (parentPort === null) throw new Error("Schedule solver thread requires a parent port");

try {
  if (workerData.operation === "generate") {
    const candidates = generateScheduleCandidates(workerData.problem, {
      startIteration: workerData.iteration,
      maxIterations: 1,
    });
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
