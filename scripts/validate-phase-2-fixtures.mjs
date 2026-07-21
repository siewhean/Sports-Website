import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixtureUrls = [
  new URL("../validation/phase-2/canoe-polo-08.vertical-slice.json", import.meta.url),
  new URL("../validation/phase-2/canoe-polo-16.vertical-slice.json", import.meta.url),
];

function unique(values, context) {
  assert.equal(new Set(values).size, values.length, `${context}: duplicate value`);
}

function validateStandings(oracle, entrySeeds) {
  const rows = new Map(
    oracle.entries.map((entryId) => [entryId, { entryId, played: 0, won: 0, gf: 0, ga: 0, points: 0, discipline: 0 }]),
  );
  for (const [homeId, awayId, homeGoals, awayGoals, homeDiscipline, awayDiscipline] of oracle.results) {
    const home = rows.get(homeId);
    const away = rows.get(awayId);
    assert(home && away, "Standings result references unknown entry");
    for (const [row, own, opponent, discipline] of [
      [home, homeGoals, awayGoals, homeDiscipline],
      [away, awayGoals, homeGoals, awayDiscipline],
    ]) {
      row.played += 1;
      row.gf += own;
      row.ga += opponent;
      row.discipline += discipline;
      if (own > opponent) {
        row.won += 1;
        row.points += 3;
      } else if (own === opponent) row.points += 1;
    }
  }
  const allRows = [...rows.values()];
  const miniPoints = (entryId, tiedIds) => {
    let points = 0;
    for (const [homeId, awayId, homeGoals, awayGoals] of oracle.results) {
      if (homeId !== entryId && awayId !== entryId) continue;
      const opponentId = homeId === entryId ? awayId : homeId;
      if (!tiedIds.has(opponentId)) continue;
      const own = homeId === entryId ? homeGoals : awayGoals;
      const opponent = homeId === entryId ? awayGoals : homeGoals;
      points += own > opponent ? 3 : own === opponent ? 1 : 0;
    }
    return points;
  };
  allRows.sort((left, right) => {
    const simple = right.points - left.points || right.gf - right.ga - (left.gf - left.ga) || right.gf - left.gf;
    if (simple) return simple;
    const tiedIds = new Set(
      allRows
        .filter((row) => row.points === left.points && row.gf - row.ga === left.gf - left.ga && row.gf === left.gf)
        .map((row) => row.entryId),
    );
    return (
      miniPoints(right.entryId, tiedIds) - miniPoints(left.entryId, tiedIds) ||
      left.discipline - right.discipline ||
      entrySeeds.get(left.entryId) - entrySeeds.get(right.entryId)
    );
  });
  const calculated = allRows.map((row, index) => [
    row.entryId,
    index + 1,
    row.played,
    row.won,
    row.gf - row.ga,
    row.points,
    row.discipline,
  ]);
  assert.deepEqual(calculated, oracle.expected, "Independent standings oracle mismatch");
}

function validateScoring(oracle) {
  const goals = new Map();
  let sequence = 0;
  for (const event of oracle.events) {
    assert.equal(event.sequence, sequence + 1, "Score events must be contiguous");
    sequence = event.sequence;
    assert(event.client_event_id && event.actor_id, "Score event attribution is required");
    assert([1, 2].includes(event.period), "Score event period must be manual and valid");
    assert(
      Number.isInteger(event.manual_time_seconds) && event.manual_time_seconds >= 0,
      "Score event time must be manual and valid",
    );
    if (event.type === "goal")
      goals.set(event.sequence, { teamId: event.team_id, scorerId: event.scorer_id, reversed: false });
    else if (event.type === "goal_reversed") {
      const target = goals.get(event.target_sequence);
      assert(target && !target.reversed && event.reason.trim(), "Invalid score-event reversal");
      target.reversed = true;
    } else {
      assert(
        ["match_started", "yellow_card", "timeout", "incident", "match_finalised"].includes(event.type),
        `Unsupported scoring oracle event ${event.type}`,
      );
    }
  }
  const score = Object.fromEntries(Object.keys(oracle.expected_score).map((teamId) => [teamId, 0]));
  for (const goal of goals.values()) if (!goal.reversed) score[goal.teamId] = (score[goal.teamId] ?? 0) + 1;
  assert.deepEqual(score, oracle.expected_score, "Independent score-event oracle mismatch");
  const valid = [...goals.values()].filter((goal) => !goal.reversed).every((goal) => Boolean(goal.scorerId));
  assert.equal(valid, oracle.finalisation_valid, "Independent scorer-attribution oracle mismatch");
}

function validateCorrection(oracle) {
  for (const scenario of [oracle.unstarted_downstream, oracle.started_downstream]) {
    const conflicts = Object.entries(scenario.downstream_states)
      .filter(([, state]) => state === "started" || state === "finalised")
      .map(([matchId]) => matchId)
      .sort();
    assert.deepEqual(conflicts, [...scenario.expected_conflicts].sort(), "Correction conflict oracle mismatch");
  }
}

function validatePublication(oracle) {
  assert(
    oracle.result_publication_version > oracle.schedule_publication_version,
    "Results must publish independently of schedule",
  );
  assert(
    oracle.private_schedule_revision_version > oracle.schedule_publication_version,
    "Private schedule revision must remain newer",
  );
  assert.notDeepEqual(
    oracle.public_schedule,
    oracle.private_schedule_draft,
    "Private schedule change must not leak publicly",
  );
  assert(
    oracle.public_result.home_goals !== undefined && oracle.public_result.away_goals !== undefined,
    "Public result score missing",
  );
  assert(!("home_goals" in oracle.public_schedule), "Schedule projection must not contain result fields");
  assert(!("start_minute" in oracle.public_result), "Result projection must not contain schedule fields");
}

function evaluateQrCase(qr, testCase) {
  if (testCase.revoked) return "revoked";
  if (Date.parse(testCase.now) > Date.parse(qr.expires_at)) return "expired";
  if (testCase.requested_match_id !== qr.match_id) return "wrong_match";
  if (testCase.attempts > qr.retry_limit) return "rate_limited";
  if (testCase.bound_device_id && testCase.bound_device_id !== testCase.device_id) return "transfer_required";
  return "accepted";
}

function validateQr(oracle) {
  assert(oracle.match_id && oracle.role === "scorer" && Number.isFinite(Date.parse(oracle.expires_at)));
  assert.deepEqual(oracle.cases.map((testCase) => testCase.case).sort(), [
    "expired",
    "retry",
    "revoked",
    "transfer",
    "valid",
    "wrong-match",
  ]);
  for (const testCase of oracle.cases) {
    assert.equal(evaluateQrCase(oracle, testCase), testCase.expected, `QR oracle mismatch: ${testCase.case}`);
  }
}

function validateFixture(fixture) {
  assert.equal(fixture.schema_version, "1.0.0");
  assert.equal(fixture.sport, "canoe_polo");
  assert.equal(fixture.timezone, "Asia/Singapore");
  assert(
    Number.isFinite(Date.parse(fixture.clock.now)) && Number.isFinite(Date.parse(fixture.clock.competition_day_start)),
  );
  assert([8, 16].includes(fixture.entry_count));
  assert.equal(fixture.entries.length, fixture.entry_count);
  unique(fixture.entries, `${fixture.fixture_id}/entries`);
  const entrySeeds = new Map(fixture.entries.map((entryId, index) => [entryId, index + 1]));
  assert.equal(fixture.teams.length, fixture.entry_count);
  assert.deepEqual(
    fixture.teams.map((team) => team.id),
    fixture.entries,
    "Named team IDs must match entries",
  );
  unique(
    fixture.teams.map((team) => team.name),
    `${fixture.fixture_id}/team names`,
  );
  assert.deepEqual(
    fixture.teams.map((team) => team.seed),
    fixture.entries.map((_, index) => index + 1),
    "Team seeds must be contiguous",
  );

  const groups = Object.entries(fixture.groups);
  assert.equal(groups.length, fixture.entry_count / 4);
  assert.deepEqual(
    groups.flatMap(([, entries]) => entries).sort(),
    [...fixture.entries].sort(),
    "Groups must place each entry once",
  );
  const groupMatchesByGroup = new Map();
  for (const [matchId, homeId, awayId] of fixture.group_matches) {
    assert(
      entrySeeds.has(homeId) && entrySeeds.has(awayId) && homeId !== awayId,
      `${matchId}: invalid group participants`,
    );
    const groupId = /^group-([A-Z])-r[1-3]-m[1-2]$/.exec(matchId)?.[1];
    assert(
      groupId && fixture.groups[groupId].includes(homeId) && fixture.groups[groupId].includes(awayId),
      `${matchId}: participants outside group`,
    );
    const current = groupMatchesByGroup.get(groupId) ?? [];
    current.push([matchId, homeId, awayId]);
    groupMatchesByGroup.set(groupId, current);
  }
  for (const [groupId, groupEntries] of groups) {
    const matches = groupMatchesByGroup.get(groupId) ?? [];
    assert.equal(matches.length, 6, `Group ${groupId} must have six round-robin matches`);
    const pairs = matches.map(([, home, away]) => [home, away].sort().join("/")).sort();
    const expectedPairs = groupEntries
      .flatMap((home, index) => groupEntries.slice(index + 1).map((away) => [home, away].sort().join("/")))
      .sort();
    assert.deepEqual(pairs, expectedPairs, `Group ${groupId} round-robin pairing mismatch`);
  }

  const matchIds = [...fixture.group_matches, ...fixture.knockout_matches].map((match) => match[0]);
  unique(matchIds, `${fixture.fixture_id}/matches`);
  assert.equal(matchIds.length, fixture.entry_count === 8 ? 16 : 32);

  const intervals = new Map(fixture.availability.map(([id, areaId, start, end]) => [id, { areaId, start, end }]));
  const capacity = fixture.availability.reduce(
    (total, [, , start, end]) => total + Math.floor((end - start) / fixture.slot_minutes),
    0,
  );
  assert.equal(capacity, fixture.expected_capacity_slots, "Continuous capacity oracle mismatch");

  assert.equal(fixture.schedule.length, matchIds.length);
  assert.deepEqual(
    fixture.schedule.map((match) => match[0]).sort(),
    [...matchIds].sort(),
    "Schedule must assign every match once",
  );
  const scheduled = new Map();
  for (const [matchId, areaId, intervalId, start, end] of fixture.schedule) {
    const interval = intervals.get(intervalId);
    assert(interval, `${matchId}: unknown interval`);
    assert.equal(interval.areaId, areaId, `${matchId}: interval/area mismatch`);
    assert(start >= interval.start && end <= interval.end, `${matchId}: assignment crosses availability boundary`);
    assert.equal(end - start, fixture.slot_minutes, `${matchId}: incorrect slot duration`);
    scheduled.set(matchId, { areaId, start, end });
  }
  for (let index = 0; index < fixture.schedule.length; index += 1) {
    const [, areaId, , start, end] = fixture.schedule[index];
    for (const [, otherArea, , otherStart, otherEnd] of fixture.schedule.slice(index + 1)) {
      if (areaId === otherArea) assert(end <= otherStart || otherEnd <= start, "Schedule has an area clash");
    }
  }
  const teamAssignments = new Map();
  for (const [matchId, homeId, awayId] of fixture.group_matches) {
    for (const entryId of [homeId, awayId]) {
      const list = teamAssignments.get(entryId) ?? [];
      list.push(scheduled.get(matchId));
      teamAssignments.set(entryId, list);
    }
  }
  for (const assignments of teamAssignments.values()) {
    assignments.sort((left, right) => left.start - right.start);
    for (let index = 1; index < assignments.length; index += 1) {
      assert(
        assignments[index].start >= assignments[index - 1].end + fixture.minimum_rest_minutes,
        "Team rest oracle mismatch",
      );
    }
  }
  for (const [matchId, , , ...dependencies] of fixture.knockout_matches) {
    const assignment = scheduled.get(matchId);
    for (const dependency of dependencies) {
      const dependencyIds = dependency.startsWith("group:")
        ? groupMatchesByGroup.get(dependency.slice(6)).map((match) => match[0])
        : [dependency];
      for (const dependencyId of dependencyIds) {
        assert(
          assignment.start >= scheduled.get(dependencyId).end + fixture.minimum_rest_minutes,
          `${matchId}: dependency/rest violation`,
        );
      }
    }
  }

  validateStandings(fixture.standings_oracle, entrySeeds);
  validateScoring(fixture.scoring_oracle);
  validateCorrection(fixture.correction_oracle);
  validatePublication(fixture.publication_oracle);
  assert.deepEqual(fixture.audit_oracle, [
    "score_event_appended",
    "match_finalised",
    "results_published",
    "result_corrected",
    "correction_conflict_detected",
    "results_republished",
  ]);
  validateQr(fixture.qr_oracle);
}

for (const fixtureUrl of fixtureUrls) validateFixture(JSON.parse(await readFile(fixtureUrl, "utf8")));
console.log("Validated independent Phase 2 Canoe Polo golden fixtures for 8 and 16 entries.");
