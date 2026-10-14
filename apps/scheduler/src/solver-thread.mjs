import { parentPort, workerData } from "node:worker_threads";

import {
  constructRestAwareSchedule,
  evaluateScheduleQuality,
  generateScheduleCandidates,
  improveSchedule,
  measureScheduleShape,
  validateSchedule,
} from "@matchday/domain";

if (parentPort === null) throw new Error("Schedule solver thread requires a parent port");
const port = parentPort;
// One worker serves a whole job: the problem is transferred once and each request names only the
// iteration or the assignments to check, so per-iteration cost is solving, not thread start-up.
const problem = workerData.problem;

function checked(iteration, assignments) {
  return {
    candidate: { iteration, assignments },
    validation: validateSchedule(problem, assignments),
    quality: evaluateScheduleQuality(problem, assignments),
    backToBackCount: measureScheduleShape(problem, assignments).backToBackCount,
  };
}

port.on("message", (message) => {
  try {
    if (message.operation === "generate") {
      const candidates = generateScheduleCandidates(problem, {
        startIteration: message.iteration,
        maxIterations: 1,
      });
      const result = candidates.map((candidate) => checked(candidate.iteration, candidate.assignments));
      port.postMessage({ id: message.id, ok: true, result });
    } else if (message.operation === "improve") {
      const { assignments } = improveSchedule(problem, message.assignments, { seed: message.iteration });
      port.postMessage({ id: message.id, ok: true, result: checked(message.iteration, assignments) });
    } else if (message.operation === "rest_aware") {
      // Bounded witness search for the fewest back-to-backs; local search runs as a separate
      // "improve" request so each request stays within the yield deadline. `false` (not null)
      // when nothing is found, because a null result means "aborted" to the session.
      const constructed = constructRestAwareSchedule(problem, { maxNodes: message.maxNodes });
      port.postMessage({
        id: message.id,
        ok: true,
        result: constructed === null ? false : checked(message.iteration, constructed.assignments),
      });
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
