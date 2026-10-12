import { parentPort, workerData } from "node:worker_threads";

import { evaluateScheduleQuality, generateScheduleCandidates, validateSchedule } from "@matchday/domain";

if (parentPort === null) throw new Error("Schedule solver thread requires a parent port");
const port = parentPort;
// One worker serves a whole job: the problem is transferred once and each request names only the
// iteration or the assignments to check, so per-iteration cost is solving, not thread start-up.
const problem = workerData.problem;

port.on("message", (message) => {
  try {
    if (message.operation === "generate") {
      const candidates = generateScheduleCandidates(problem, {
        startIteration: message.iteration,
        maxIterations: 1,
      });
      const result = candidates.map((candidate) => ({
        candidate,
        validation: validateSchedule(problem, candidate.assignments),
        quality: evaluateScheduleQuality(problem, candidate.assignments),
      }));
      port.postMessage({ id: message.id, ok: true, result });
    } else if (message.operation === "verify") {
      port.postMessage({
        id: message.id,
        ok: true,
        result: {
          validation: validateSchedule(problem, message.assignments),
          quality: evaluateScheduleQuality(problem, message.assignments),
        },
      });
    } else {
      throw new Error("Unknown schedule solver operation");
    }
  } catch (error) {
    port.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : "Schedule solver failed",
    });
  }
});
