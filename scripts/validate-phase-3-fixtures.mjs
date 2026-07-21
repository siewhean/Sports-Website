import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const REQUIRED_SPORTS = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"];
const REQUIRED_SIZES = [8, 12, 16, 24, 48];
const PACK_SCHEMA_VERSION = 1;
const PACK_VERSION = "0.1.0-draft.1";
const PACK_STATUS = "provisional_product_baseline";
const PACK_AUTHORITY = "product_recommendation_not_federation_profile";
const STRATEGIES = ["full_placement", "championship_focus", "compact_knockout"];
const STAGE_KINDS = [
  "round_robin",
  "group",
  "single_elimination",
  "placement",
  "consolation",
  "classification",
  "bronze",
];
const MATCH_PURPOSES = ["pool", "progression", "championship", "placement", "classification"];
const INVALID_SETTING_CODES = [
  "range",
  "unknown_key",
  "type",
  "ordered_enum",
  "invariant.best_of_is_odd",
  "invariant.cap_reaches_target",
  "invariant.deciding_target_not_higher",
  "invariant.forfeit_score_orientation",
  "invariant.no_draw",
];
const fixtureUrl = (path) => new URL(`../validation/phase-3/${path}`, import.meta.url);
const load = async (path) => JSON.parse(await readFile(fixtureUrl(path), "utf8"));

function record(value, context) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${context}: expected object`);
  return value;
}

function exactKeys(value, keys, context) {
  record(value, context);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${context}: unknown or missing key`);
}

function tuple(value, length, context) {
  assert(Array.isArray(value) && value.length === length, `${context}: expected ${length}-field tuple`);
}

function unique(values, context) {
  assert.equal(new Set(values).size, values.length, `${context}: duplicate value`);
}

function exactMembers(actual, expected, context) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${context}: exact coverage mismatch`);
  unique(actual, context);
}

function positiveInteger(value, context) {
  assert(Number.isInteger(value) && value > 0, `${context}: expected positive integer`);
}

function nonNegativeInteger(value, context) {
  assert(Number.isInteger(value) && value >= 0, `${context}: expected non-negative integer`);
}

function text(value, context) {
  assert(typeof value === "string" && value.trim() === value && value.length > 0, `${context}: expected text`);
}

function parseTime(value, context) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  assert(match, `${context}: expected HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  assert(hours <= 23 && minutes <= 59, `${context}: invalid time`);
  return hours * 60 + minutes;
}

function parseDate(value, context) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${context}: expected YYYY-MM-DD`);
  const instant = new Date(`${value}T00:00:00Z`);
  assert(
    Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value,
    `${context}: invalid date`,
  );
}

function assertTimeZone(value, context) {
  text(value, context);
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: value }), `${context}: invalid IANA timezone`);
}

function localParts(formatter, instant) {
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function localInstant(timeZone, date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(`${date}T${time}`);
  assert(match, `Invalid local date-time: ${date}T${time}`);
  const [, year, month, day, hour, minute] = match.map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const candidates = [];
  for (let offset = -26 * 60; offset <= 26 * 60; offset += 1) {
    const instant = target + offset * 60_000;
    const parts = localParts(formatter, instant);
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute
    ) {
      candidates.push(instant);
    }
  }
  assert(candidates.length > 0, `${date}T${time} does not exist in ${timeZone}`);
  return Math.min(...candidates);
}

function nextDate(date) {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function detectInvalidGraphIssues(graph, context) {
  exactKeys(graph, ["entryCount", "stages", "matches", "terminalMatchIds"], context);
  positiveInteger(graph.entryCount, `${context}/entryCount`);
  assert(Array.isArray(graph.stages) && Array.isArray(graph.matches) && Array.isArray(graph.terminalMatchIds));
  const issues = new Set();
  const stageIds = graph.stages.map((stage, index) => {
    exactKeys(stage, ["id", "order", "matchIds"], `${context}/stages[${index}]`);
    return stage.id;
  });
  if (new Set(stageIds).size !== stageIds.length) issues.add("duplicate_stage_id");
  const matchIds = graph.matches.map((match, index) => {
    exactKeys(match, ["id", "stageId", "order", "home", "away"], `${context}/matches[${index}]`);
    for (const slot of ["home", "away"]) {
      const source = match[slot];
      if (source.type === "entry_seed") exactKeys(source, ["type", "seed"], `${context}/${match.id}/${slot}`);
      else exactKeys(source, ["type", "matchId"], `${context}/${match.id}/${slot}`);
    }
    return match.id;
  });
  if (new Set(matchIds).size !== matchIds.length) issues.add("duplicate_match_id");
  const knownMatches = new Set(matchIds);
  const adjacency = new Map(matchIds.map((id) => [id, []]));
  for (const match of graph.matches) {
    for (const source of [match.home, match.away]) {
      if (source.type !== "winner" && source.type !== "loser") continue;
      if (!knownMatches.has(source.matchId)) issues.add("unknown_match");
      else adjacency.get(source.matchId).push(match.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return void issues.add("cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of adjacency.get(id) ?? []) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of matchIds) visit(id);
  return issues;
}

function independentFormat(entryCount, strategy) {
  const groupMatches = (entryCount / 4) * 6;
  const championshipMatches = entryCount / 2 - 1;
  const secondaryMatches = 2 * (entryCount / 4 - 1);
  if (strategy === "full_placement") {
    return {
      matchCount: groupMatches + championshipMatches + 1 + secondaryMatches,
      guaranteedMatches: 4,
      maximumMatches: 3 + Math.ceil(Math.log2(entryCount / 2)),
      stages: ["group", "single_elimination", "bronze", "placement", "consolation"],
      terminalCount: 4,
      firstMatch: "groups-G1-r1-m1",
      lastMatch: `consolation-r${Math.ceil(Math.log2(entryCount / 4))}-m1`,
    };
  }
  if (strategy === "championship_focus") {
    return {
      matchCount: groupMatches + championshipMatches + 1,
      guaranteedMatches: 3,
      maximumMatches: 3 + Math.ceil(Math.log2(entryCount / 2)),
      stages: ["group", "single_elimination", "bronze"],
      terminalCount: 2,
      firstMatch: "groups-G1-r1-m1",
      lastMatch: "bronze-final",
    };
  }
  assert.equal(strategy, "compact_knockout", `Unknown strategy: ${strategy}`);
  return {
    matchCount: entryCount,
    guaranteedMatches: 1,
    maximumMatches: Math.ceil(Math.log2(entryCount)),
    stages: ["single_elimination", "bronze"],
    terminalCount: 2,
    firstMatch: "championship-r1-m1",
    lastMatch: "bronze-final",
  };
}

function eliminationMatchIds(stageId, entrantCount) {
  const bracketSize = 2 ** Math.ceil(Math.log2(entrantCount));
  const ids = [];
  const firstRoundMatches = entrantCount - bracketSize / 2;
  for (let match = 1; match <= firstRoundMatches; match += 1) ids.push(`${stageId}-r1-m${match}`);
  for (let round = 2; round <= Math.log2(bracketSize); round += 1) {
    const matchCount = bracketSize / 2 ** round;
    for (let match = 1; match <= matchCount; match += 1) ids.push(`${stageId}-r${round}-m${match}`);
  }
  return ids;
}

function expectedGraphIdentity(entryCount, strategy) {
  const groupCount = entryCount / 4;
  const groupIds = [];
  for (let round = 1; round <= 3; round += 1) {
    for (let group = 1; group <= groupCount; group += 1) {
      for (let match = 1; match <= 2; match += 1) groupIds.push(`groups-G${group}-r${round}-m${match}`);
    }
  }
  const championship = eliminationMatchIds(
    "championship",
    strategy === "compact_knockout" ? entryCount : entryCount / 2,
  );
  const result =
    strategy === "compact_knockout"
      ? { championship, bronze: ["bronze-final"] }
      : {
          groups: groupIds,
          championship,
          bronze: ["bronze-final"],
        };
  if (strategy === "full_placement") {
    result.placement = eliminationMatchIds("placement", groupCount);
    result.consolation = eliminationMatchIds("consolation", groupCount);
  }
  return result;
}

function classifyInvalidSettingsCase(testCase) {
  const allowed = {
    canoe_polo: new Set(["slotMinutes", "forfeitWinnerScore", "forfeitLoserScore"]),
    badminton: new Set(["bestOf", "pointCap"]),
    table_tennis: new Set(["pointCap", "regularTargetPoints"]),
    volleyball: new Set(["standingsOrder", "regularTargetPoints", "decidingTargetPoints"]),
    basketball: new Set(["successiveOvertime", "overtimeDurationMinutes"]),
  }[testCase.sportId];
  assert(allowed, `Unknown settings sport ${testCase.sportId}`);
  const settings = testCase.settings;
  if (Object.keys(settings).some((key) => !allowed.has(key))) return "unknown_key";
  const integerKeys = [
    "slotMinutes",
    "bestOf",
    "pointCap",
    "regularTargetPoints",
    "decidingTargetPoints",
    "forfeitWinnerScore",
    "forfeitLoserScore",
    "overtimeDurationMinutes",
  ];
  for (const [key, value] of Object.entries(settings)) {
    if (integerKeys.includes(key) && !(key === "pointCap" && value === null) && !Number.isInteger(value)) return "type";
    if (key === "successiveOvertime" && typeof value !== "boolean") return "type";
    if (key === "standingsOrder" && !Array.isArray(value)) return "type";
  }
  if (
    (settings.slotMinutes !== undefined && settings.slotMinutes < 5) ||
    (settings.pointCap !== undefined && settings.pointCap !== null && settings.pointCap < 1) ||
    (settings.overtimeDurationMinutes !== undefined &&
      (settings.overtimeDurationMinutes < 1 || settings.overtimeDurationMinutes > 30))
  ) {
    return "range";
  }
  if (settings.standingsOrder) {
    const allowedCriteria = new Set(["match_wins", "set_ratio", "point_ratio", "head_to_head"]);
    if (
      settings.standingsOrder.length === 0 ||
      new Set(settings.standingsOrder).size !== settings.standingsOrder.length ||
      settings.standingsOrder.some((criterion) => !allowedCriteria.has(criterion))
    ) {
      return "ordered_enum";
    }
  }
  if (settings.bestOf !== undefined && settings.bestOf % 2 === 0) return "invariant.best_of_is_odd";
  if (
    settings.pointCap !== undefined &&
    settings.pointCap !== null &&
    settings.regularTargetPoints !== undefined &&
    settings.pointCap < settings.regularTargetPoints
  ) {
    return "invariant.cap_reaches_target";
  }
  if (
    settings.regularTargetPoints !== undefined &&
    settings.decidingTargetPoints !== undefined &&
    settings.decidingTargetPoints > settings.regularTargetPoints
  ) {
    return "invariant.deciding_target_not_higher";
  }
  if (
    settings.forfeitWinnerScore !== undefined &&
    settings.forfeitLoserScore !== undefined &&
    settings.forfeitWinnerScore <= settings.forfeitLoserScore
  ) {
    return "invariant.forfeit_score_orientation";
  }
  if (testCase.sportId === "basketball" && settings.successiveOvertime === false) return "invariant.no_draw";
  return null;
}

function validateAdvancementIdentities(advancement, context) {
  const known = new Set(advancement.knownEntries);
  unique(advancement.knownEntries, `${context}/known entries`);
  assert(known.has(advancement.withdrawnEntryId), `${context}: withdrawn entry is unknown`);
  assert(
    advancement.groupSnapshotOrder.includes(advancement.withdrawnEntryId),
    `${context}: withdrawn entry lacks standings row`,
  );
  assert(known.has(advancement.replacementEntryId), `${context}: replacement entry is unknown`);
  tuple(advancement.replacementLineage, 2, `${context}/replacement lineage`);
  assert.deepEqual(
    advancement.replacementLineage,
    [advancement.withdrawnEntryId, advancement.replacementEntryId],
    `${context}: replacement lineage mismatch`,
  );
  assert.notEqual(advancement.withdrawnEntryId, advancement.replacementEntryId);
  const completedAffected = advancement.fixtures.filter(
    (fixture) => fixture[3] === "completed" && fixture.slice(1, 3).includes(advancement.withdrawnEntryId),
  );
  const futureAffected = advancement.fixtures.filter(
    (fixture) => fixture[3] === "future" && fixture.slice(1, 3).includes(advancement.withdrawnEntryId),
  );
  assert(completedAffected.length > 0, `${context}: withdrawn entry has no completed result`);
  assert(futureAffected.length > 0, `${context}: withdrawn entry has no future fixture`);
  exactMembers(
    advancement.futureForfeitMatchIds,
    futureAffected.map((fixture) => fixture[0]),
    `${context}/future forfeit linkage`,
  );
}

function parseSource(source, graph, match, context) {
  text(source, context);
  let found = /^s:(\d+)$/.exec(source);
  if (found) {
    const seed = Number(found[1]);
    assert(seed >= 1 && seed <= graph.entryCount, `${context}: seed outside 1..${graph.entryCount}`);
    return { type: "seed", seed };
  }
  found = /^r:([^:]+):([^:]+):(\d+)$/.exec(source);
  if (found) {
    const [, stageId, groupId, rankText] = found;
    const stage = graph.stageById.get(stageId);
    assert(stage, `${context}: unknown rank stage ${stageId}`);
    assert.equal(stage.kind, "group", `${context}: rank source must reference group stage`);
    assert(stage.groupIds.includes(groupId), `${context}: unknown group ${groupId}`);
    const rank = Number(rankText);
    assert(rank >= 1 && rank <= stage.outputRanks, `${context}: impossible rank`);
    assert(stage.order < match.stage.order, `${context}: rank dependency must be from earlier stage`);
    return { type: "rank", stageId, groupId, rank };
  }
  found = /^([wl]):(.+)$/.exec(source);
  assert(found, `${context}: unknown source kind`);
  const sourceMatch = graph.matchById.get(found[2]);
  assert(sourceMatch, `${context}: unknown source match ${found[2]}`);
  assert(sourceMatch.order < match.order, `${context}: outcome dependency must be earlier`);
  return { type: found[1] === "w" ? "winner" : "loser", matchId: found[2] };
}

function validateFormatTemplate(template, entryCount, context) {
  exactKeys(template, ["strategy", "metrics", "stages", "matches", "terminals"], context);
  assert(STRATEGIES.includes(template.strategy), `${context}: unknown strategy`);
  exactKeys(template.metrics, ["matchCount", "guaranteedMatches", "maximumMatches"], `${context}/metrics`);
  for (const key of ["matchCount", "guaranteedMatches", "maximumMatches"]) {
    positiveInteger(template.metrics[key], `${context}/metrics/${key}`);
  }
  assert(Array.isArray(template.stages) && template.stages.length > 0, `${context}: stages missing`);
  assert(Array.isArray(template.matches) && template.matches.length > 0, `${context}: matches missing`);
  assert(Array.isArray(template.terminals) && template.terminals.length > 0, `${context}: terminals missing`);

  const stages = template.stages.map((raw, index) => {
    tuple(raw, 7, `${context}/stages[${index}]`);
    const [id, kind, order, groupSize, groupIds, outputRanks, matchIds] = raw;
    text(id, `${context}/stages[${index}]/id`);
    assert(STAGE_KINDS.includes(kind), `${context}/${id}: unknown stage kind`);
    positiveInteger(order, `${context}/${id}/order`);
    positiveInteger(outputRanks, `${context}/${id}/outputRanks`);
    assert(Array.isArray(groupIds) && Array.isArray(matchIds), `${context}/${id}: invalid lists`);
    unique(groupIds, `${context}/${id}/groupIds`);
    unique(matchIds, `${context}/${id}/matchIds`);
    if (kind === "group") {
      positiveInteger(groupSize, `${context}/${id}/groupSize`);
      assert(groupSize >= 2 && groupIds.length > 0, `${context}/${id}: invalid group shape`);
      assert(outputRanks <= groupSize, `${context}/${id}: output rank exceeds group size`);
      assert.equal(groupIds.length * groupSize, entryCount, `${context}/${id}: qualifier population mismatch`);
    } else {
      assert.equal(groupSize, null, `${context}/${id}: non-group stage has group size`);
      assert.deepEqual(groupIds, [], `${context}/${id}: non-group stage has groups`);
    }
    return { id, kind, order, groupSize, groupIds, outputRanks, matchIds };
  });
  unique(
    stages.map(({ id }) => id),
    `${context}/stage IDs`,
  );
  unique(
    stages.map(({ order }) => order),
    `${context}/stage orders`,
  );
  assert.deepEqual(
    stages.map(({ order }) => order),
    Array.from({ length: stages.length }, (_, index) => index + 1),
    `${context}: stage orders must be contiguous and stored in order`,
  );
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  const matches = template.matches.map((raw, index) => {
    tuple(raw, 8, `${context}/matches[${index}]`);
    const [id, stageId, groupId, round, order, purpose, home, away] = raw;
    text(id, `${context}/matches[${index}]/id`);
    const stage = stageById.get(stageId);
    assert(stage, `${context}/${id}: unknown stage ${stageId}`);
    positiveInteger(round, `${context}/${id}/round`);
    positiveInteger(order, `${context}/${id}/order`);
    assert(MATCH_PURPOSES.includes(purpose), `${context}/${id}: unknown purpose`);
    if (stage.kind === "group") assert(stage.groupIds.includes(groupId), `${context}/${id}: unknown match group`);
    else assert.equal(groupId, null, `${context}/${id}: non-group match has group`);
    assert.notEqual(home, away, `${context}/${id}: duplicate participant source`);
    return { id, stageId, stage, groupId, round, order, purpose, home, away };
  });
  unique(
    matches.map(({ id }) => id),
    `${context}/match IDs`,
  );
  unique(
    matches.map(({ order }) => order),
    `${context}/match orders`,
  );
  assert.deepEqual(
    matches.map(({ order }) => order),
    Array.from({ length: matches.length }, (_, index) => index + 1),
    `${context}: match orders must be contiguous and stored in order`,
  );
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const expectedIdentity = expectedGraphIdentity(entryCount, template.strategy);
  assert.deepEqual(
    stages.map(({ id }) => id),
    Object.keys(expectedIdentity),
    `${context}: deterministic stage identity mismatch`,
  );
  for (const stage of stages) {
    assert.deepEqual(
      stage.matchIds,
      expectedIdentity[stage.id],
      `${context}/${stage.id}: deterministic match IDs drifted`,
    );
  }
  assert.deepEqual(
    matches.map(({ id }) => id),
    Object.values(expectedIdentity).flat(),
    `${context}: deterministic match ordering drifted`,
  );
  const graph = { entryCount, stageById, matchById };
  for (const match of matches) {
    match.homeSource = parseSource(match.home, graph, match, `${context}/${match.id}/home`);
    match.awaySource = parseSource(match.away, graph, match, `${context}/${match.id}/away`);
  }
  const championshipMaxRound = Math.max(
    ...matches.filter(({ stageId }) => stageId === "championship").map(({ round }) => round),
  );
  for (const match of matches) {
    if (match.stage.kind === "group") assert.equal(match.purpose, "pool", `${context}/${match.id}: group purpose`);
    else if (match.stage.kind === "bronze")
      assert.equal(match.purpose, "classification", `${context}/${match.id}: bronze purpose`);
    else {
      const finalId = match.stage.matchIds.at(-1);
      assert.equal(
        match.purpose,
        match.id === finalId && match.stage.matchIds.length > 1
          ? match.stageId === "championship"
            ? "championship"
            : "placement"
          : "progression",
        `${context}/${match.id}: elimination purpose mismatch`,
      );
    }
    for (const source of [match.homeSource, match.awaySource]) {
      if (source.type === "winner") {
        const parent = matchById.get(source.matchId);
        assert.equal(match.stageId, parent.stageId, `${context}/${match.id}: winner crosses stage boundary`);
        assert.equal(match.round, parent.round + 1, `${context}/${match.id}: winner skips elimination round`);
      } else if (source.type === "loser") {
        const parent = matchById.get(source.matchId);
        assert.equal(match.stage.kind, "bronze", `${context}/${match.id}: loser may feed only bronze`);
        assert.equal(parent.stageId, "championship", `${context}/${match.id}: bronze loser is not championship source`);
        assert.equal(parent.round, championshipMaxRound - 1, `${context}/${match.id}: bronze must use semifinal loser`);
      }
    }
  }

  const memberships = stages.flatMap((stage) => stage.matchIds);
  assert.deepEqual(
    [...memberships].sort(),
    matches.map(({ id }) => id).sort(),
    `${context}: stage membership mismatch`,
  );
  for (const stage of stages) {
    for (const id of stage.matchIds)
      assert.equal(matchById.get(id)?.stageId, stage.id, `${context}/${id}: wrong stage`);
  }

  const adjacency = new Map(matches.map(({ id }) => [id, []]));
  const consumers = new Map();
  for (const match of matches) {
    for (const source of [match.homeSource, match.awaySource]) {
      if (source.type !== "winner" && source.type !== "loser") continue;
      const key = `${source.type}:${source.matchId}`;
      assert(!consumers.has(key), `${context}: outcome ${key} consumed twice`);
      consumers.set(key, match.id);
      adjacency.get(source.matchId).push(match.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    assert(!visiting.has(id), `${context}: dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of adjacency.get(id)) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const { id } of matches) visit(id);

  unique(template.terminals, `${context}/terminals`);
  assert(
    template.terminals.every((id) => matchById.has(id)),
    `${context}: unknown terminal`,
  );
  const nonPoolSinks = matches
    .filter((match) => match.stage.kind !== "group" && match.stage.kind !== "round_robin")
    .filter((match) => adjacency.get(match.id).length === 0)
    .map(({ id }) => id);
  exactMembers(template.terminals, nonPoolSinks, `${context}/terminal sinks`);

  const groupStage = stages.find(({ kind }) => kind === "group");
  if (groupStage) {
    const allGroupSeeds = [];
    for (const groupId of groupStage.groupIds) {
      const groupMatches = matches.filter((match) => match.stageId === groupStage.id && match.groupId === groupId);
      assert.equal(groupMatches.length, (groupStage.groupSize * (groupStage.groupSize - 1)) / 2);
      const seeds = new Set();
      const pairs = [];
      for (const match of groupMatches) {
        assert.equal(match.homeSource.type, "seed", `${context}/${match.id}: group home is not seed`);
        assert.equal(match.awaySource.type, "seed", `${context}/${match.id}: group away is not seed`);
        seeds.add(match.homeSource.seed);
        seeds.add(match.awaySource.seed);
        pairs.push([match.homeSource.seed, match.awaySource.seed].sort((a, b) => a - b).join("/"));
      }
      assert.equal(seeds.size, groupStage.groupSize, `${context}/${groupId}: wrong group population`);
      unique(pairs, `${context}/${groupId}: round-robin pairs`);
      allGroupSeeds.push(...seeds);
    }
    exactMembers(
      allGroupSeeds,
      Array.from({ length: entryCount }, (_, index) => index + 1),
      `${context}/group seeds`,
    );
  }

  const nonPoolSources = matches
    .filter((match) => match.stage.kind !== "group" && match.stage.kind !== "round_robin")
    .flatMap((match) => [match.home, match.away]);
  const rankSources = nonPoolSources.filter((source) => source.startsWith("r:"));
  unique(rankSources, `${context}/qualifier sources`);
  const expectedQualifierCount =
    template.strategy === "full_placement"
      ? entryCount
      : template.strategy === "championship_focus"
        ? entryCount / 2
        : 0;
  assert.equal(rankSources.length, expectedQualifierCount, `${context}: qualifier count mismatch`);
  const expectedRankSources = [];
  if (groupStage) {
    const ranks = template.strategy === "full_placement" ? [1, 2, 3, 4] : [1, 2];
    for (const rank of ranks) {
      for (const groupId of groupStage.groupIds) expectedRankSources.push(`r:${groupStage.id}:${groupId}:${rank}`);
    }
  }
  exactMembers(rankSources, expectedRankSources, `${context}/qualifier rank set`);
  if (!groupStage) {
    const seedSources = nonPoolSources
      .filter((source) => source.startsWith("s:"))
      .map((source) => Number(source.slice(2)));
    exactMembers(
      seedSources,
      Array.from({ length: entryCount }, (_, index) => index + 1),
      `${context}/seeded qualifiers`,
    );
  }

  const memo = new Map();
  const boundsFromMatch = (id) => {
    if (memo.has(id)) return memo.get(id);
    const outcomes = ["winner", "loser"].map((outcome) => {
      const child = consumers.get(`${outcome}:${id}`);
      return child ? boundsFromMatch(child) : { minimum: 0, maximum: 0 };
    });
    const result = {
      minimum: 1 + Math.min(...outcomes.map(({ minimum }) => minimum)),
      maximum: 1 + Math.max(...outcomes.map(({ maximum }) => maximum)),
    };
    memo.set(id, result);
    return result;
  };
  const initialConsumer = new Map();
  for (const match of matches.filter((candidate) => candidate.stage.kind !== "group")) {
    for (const source of [match.home, match.away]) {
      if (source.startsWith("r:") || source.startsWith("s:")) {
        assert(!initialConsumer.has(source), `${context}: initial source ${source} consumed twice`);
        initialConsumer.set(source, match.id);
      }
    }
  }
  const participantBounds = [];
  if (groupStage) {
    for (const groupId of groupStage.groupIds) {
      for (let rank = 1; rank <= groupStage.outputRanks; rank += 1) {
        const child = initialConsumer.get(`r:${groupStage.id}:${groupId}:${rank}`);
        const progression = child ? boundsFromMatch(child) : { minimum: 0, maximum: 0 };
        participantBounds.push({
          minimum: groupStage.groupSize - 1 + progression.minimum,
          maximum: groupStage.groupSize - 1 + progression.maximum,
        });
      }
    }
  } else {
    for (let seed = 1; seed <= entryCount; seed += 1) {
      const child = initialConsumer.get(`s:${seed}`);
      assert(child, `${context}: seed ${seed} has no first match`);
      participantBounds.push(boundsFromMatch(child));
    }
  }
  const calculated = {
    matchCount: matches.length,
    guaranteedMatches: Math.min(...participantBounds.map(({ minimum }) => minimum)),
    maximumMatches: Math.max(...participantBounds.map(({ maximum }) => maximum)),
  };
  assert.deepEqual(calculated, template.metrics, `${context}: independently calculated metrics mismatch`);
  const expected = independentFormat(entryCount, template.strategy);
  assert.deepEqual(
    {
      ...calculated,
      stages: stages.map(({ kind }) => kind),
      terminalCount: template.terminals.length,
      firstMatch: matches[0].id,
      lastMatch: matches.at(-1).id,
    },
    expected,
    `${context}: independent structural oracle mismatch`,
  );
  return calculated;
}

function uniqueParticipants(results) {
  return [...new Set(results.flatMap((result) => [result.homeEntryId, result.awayEntryId]))].sort();
}

function standingsOrder(testCase) {
  const ids = uniqueParticipants(testCase.results);
  const rows = new Map(ids.map((id) => [id, { id, points: 0, wins: 0, segmentDifference: 0, scoreDifference: 0 }]));
  for (const result of testCase.results) {
    const home = rows.get(result.homeEntryId);
    const away = rows.get(result.awayEntryId);
    const homeSegmentsWon = result.homeSegments?.filter((score, index) => score > result.awaySegments[index]).length;
    const awaySegmentsWon = result.awaySegments?.filter((score, index) => score > result.homeSegments[index]).length;
    const homeWon =
      homeSegmentsWon === undefined ? result.homeScore > result.awayScore : homeSegmentsWon > awaySegmentsWon;
    const awayWon =
      homeSegmentsWon === undefined ? result.awayScore > result.homeScore : awaySegmentsWon > homeSegmentsWon;
    home.scoreDifference += result.homeScore - result.awayScore;
    away.scoreDifference += result.awayScore - result.homeScore;
    if (homeSegmentsWon !== undefined) {
      home.segmentDifference += homeSegmentsWon - awaySegmentsWon;
      away.segmentDifference += awaySegmentsWon - homeSegmentsWon;
    }
    if (homeWon) {
      home.wins += 1;
      home.points += 3;
    } else if (awayWon) {
      away.wins += 1;
      away.points += 3;
    } else {
      home.points += 1;
      away.points += 1;
    }
  }
  return [...rows.values()]
    .sort((left, right) => {
      const primary = testCase.sport === "canoe_polo" ? right.points - left.points : right.wins - left.wins;
      const direct = testCase.results.find(
        (result) =>
          (result.homeEntryId === left.id && result.awayEntryId === right.id) ||
          (result.homeEntryId === right.id && result.awayEntryId === left.id),
      );
      const headToHead =
        testCase.sport === "basketball" && direct && direct.homeScore !== direct.awayScore
          ? (direct.homeScore > direct.awayScore ? direct.homeEntryId : direct.awayEntryId) === left.id
            ? -1
            : 1
          : 0;
      return (
        primary ||
        headToHead ||
        right.segmentDifference - left.segmentDifference ||
        right.scoreDifference - left.scoreDifference ||
        left.id.localeCompare(right.id)
      );
    })
    .map(({ id }) => id);
}

const gate = record(await load("gate-a.oracle.json"), "Gate A oracle");
exactKeys(
  gate,
  [
    "schema_version",
    "required_sports",
    "required_entry_counts",
    "sport_pack_contract",
    "format_strategies",
    "maximum_advantage_characters",
    "strategy_advantages",
    "recommendation_cases",
    "invalid_graph_cases",
  ],
  "Gate A oracle",
);
assert.equal(gate.schema_version, "1.0.0");
assert.deepEqual(gate.required_sports, REQUIRED_SPORTS);
assert.deepEqual(gate.required_entry_counts, REQUIRED_SIZES);
assert.deepEqual(gate.format_strategies, STRATEGIES);
exactKeys(gate.sport_pack_contract, ["schema_version", "version", "status", "authority"], "pack contract");
assert.deepEqual(gate.sport_pack_contract, {
  schema_version: PACK_SCHEMA_VERSION,
  version: PACK_VERSION,
  status: PACK_STATUS,
  authority: PACK_AUTHORITY,
});
positiveInteger(gate.maximum_advantage_characters, "maximum advantage characters");
exactKeys(gate.strategy_advantages, STRATEGIES, "strategy advantages");
for (const strategy of STRATEGIES) {
  const advantage = gate.strategy_advantages[strategy];
  text(advantage, `${strategy}/advantage`);
  assert(advantage.length <= gate.maximum_advantage_characters, `${strategy}: advantage is not brief`);
}

const packFixture = record(await load("sport-packs/expected-contracts.json"), "sport-pack contracts");
exactKeys(packFixture, ["schemaVersion", "version", "status", "authority", "packs"], "sport-pack contracts");
assert.deepEqual(
  [packFixture.schemaVersion, packFixture.version, packFixture.status, packFixture.authority],
  [PACK_SCHEMA_VERSION, PACK_VERSION, PACK_STATUS, PACK_AUTHORITY],
);
exactMembers(
  packFixture.packs.map(({ sportId }) => sportId),
  REQUIRED_SPORTS,
  "sport packs",
);
for (const pack of packFixture.packs) {
  exactKeys(
    pack,
    ["sportId", "displayName", "entryTypes", "hierarchy", "requiredEvents", "standingsOrder", "forfeit", "slotMinutes"],
    `pack/${pack.sportId}`,
  );
  text(pack.displayName, `${pack.sportId}/displayName`);
  for (const key of ["entryTypes", "hierarchy", "requiredEvents", "standingsOrder"]) {
    assert(Array.isArray(pack[key]) && pack[key].length > 0, `${pack.sportId}/${key}: missing`);
    pack[key].forEach((value, index) => text(value, `${pack.sportId}/${key}[${index}]`));
    unique(pack[key], `${pack.sportId}/${key}`);
  }
  tuple(pack.forfeit, 3, `${pack.sportId}/forfeit`);
  pack.forfeit.forEach((value, index) => nonNegativeInteger(value, `${pack.sportId}/forfeit[${index}]`));
  positiveInteger(pack.slotMinutes, `${pack.sportId}/slotMinutes`);
}

const history = record(await load("sport-packs/version-history.json"), "sport-pack version history");
exactKeys(
  history,
  ["sportId", "legacyVersion", "currentVersion", "legacySlotMinutes", "currentSlotMinutes", "invariant"],
  "sport-pack version history",
);
assert.equal(history.sportId, "canoe_polo");
assert.equal(history.legacyVersion, "0.0.1-draft.1");
assert.equal(history.currentVersion, PACK_VERSION);
assert.equal(history.legacySlotMinutes, 25);
assert.equal(history.currentSlotMinutes, 30);
assert.equal(
  history.invariant,
  "Existing competition snapshots retain their selected version and recommended settings.",
);

const invalidSettings = await load("sport-packs/invalid-settings.json");
assert(Array.isArray(invalidSettings) && invalidSettings.length >= REQUIRED_SPORTS.length);
exactMembers([...new Set(invalidSettings.map(({ sportId }) => sportId))], REQUIRED_SPORTS, "invalid setting sports");
const seenIssueCodes = new Set();
for (const [index, testCase] of invalidSettings.entries()) {
  const isValid = testCase.valid === true;
  exactKeys(
    testCase,
    isValid ? ["sportId", "settings", "valid"] : ["sportId", "settings", "code"],
    `invalid settings[${index}]`,
  );
  assert(REQUIRED_SPORTS.includes(testCase.sportId));
  exactKeys(testCase.settings, Object.keys(testCase.settings), `invalid settings[${index}]/settings`);
  const settingCount = Object.keys(testCase.settings).length;
  assert(settingCount >= 1 && settingCount <= 2, `invalid settings[${index}]: expected one bounded mutation`);
  if (isValid) assert(!("code" in testCase), `invalid settings[${index}]: valid case has issue code`);
  else {
    assert(INVALID_SETTING_CODES.includes(testCase.code), `invalid settings[${index}]: unknown issue code`);
    if (!testCase.code.startsWith("invariant.")) {
      assert.equal(settingCount, 1, `invalid settings[${index}]: issue code and mutation shape disagree`);
    }
    assert(!("valid" in testCase), `invalid settings[${index}]: invalid case has valid flag`);
    seenIssueCodes.add(testCase.code);
  }
  const calculatedCode = classifyInvalidSettingsCase(testCase);
  assert.equal(
    isValid ? calculatedCode : testCase.code,
    isValid ? null : calculatedCode,
    `invalid settings[${index}]: declared outcome disagrees with settings semantics`,
  );
}
exactMembers([...seenIssueCodes], INVALID_SETTING_CODES, "invalid setting issue codes");

const formatFixtures = [];
for (const entryCount of REQUIRED_SIZES) {
  const fixture = record(await load(`formats/${String(entryCount).padStart(2, "0")}.json`), `${entryCount} format`);
  exactKeys(fixture, ["entryCount", "templates"], `${entryCount} format`);
  assert.equal(fixture.entryCount, entryCount);
  exactMembers(
    fixture.templates.map(({ strategy }) => strategy),
    STRATEGIES,
    `${entryCount} strategies`,
  );
  const metrics = new Map();
  for (const template of fixture.templates) {
    metrics.set(template.strategy, validateFormatTemplate(template, entryCount, `${entryCount}/${template.strategy}`));
  }
  formatFixtures.push({ ...fixture, metrics });
}

assert(Array.isArray(gate.recommendation_cases) && gate.recommendation_cases.length === REQUIRED_SIZES.length);
exactMembers(
  gate.recommendation_cases.map(({ entry_count }) => entry_count),
  REQUIRED_SIZES,
  "recommendation sizes",
);
unique(
  gate.recommendation_cases.map(({ id }) => id),
  "recommendation IDs",
);
for (const testCase of gate.recommendation_cases) {
  exactKeys(
    testCase,
    ["id", "entry_count", "available_match_slots", "minimum_guaranteed_matches", "expected_feasible_strategies"],
    `recommendation/${testCase.id}`,
  );
  text(testCase.id, "recommendation ID");
  nonNegativeInteger(testCase.available_match_slots, `${testCase.id}/available slots`);
  positiveInteger(testCase.minimum_guaranteed_matches, `${testCase.id}/minimum guarantees`);
  const fixture = formatFixtures.find(({ entryCount }) => entryCount === testCase.entry_count);
  const feasible = STRATEGIES.filter((strategy) => {
    const metrics = fixture.metrics.get(strategy);
    return (
      metrics.matchCount <= testCase.available_match_slots &&
      metrics.guaranteedMatches >= testCase.minimum_guaranteed_matches
    );
  }).sort((left, right) => {
    const a = fixture.metrics.get(left);
    const b = fixture.metrics.get(right);
    return b.guaranteedMatches - a.guaranteedMatches || a.matchCount - b.matchCount || left.localeCompare(right);
  });
  assert.deepEqual(feasible, testCase.expected_feasible_strategies, `${testCase.id}: feasibility mismatch`);
}

assert(Array.isArray(gate.invalid_graph_cases));
exactMembers(
  gate.invalid_graph_cases.map(({ expected_issue }) => expected_issue),
  ["duplicate_stage_id", "unknown_match", "cycle"],
  "invalid graph classes",
);
unique(
  gate.invalid_graph_cases.map(({ id }) => id),
  "invalid graph IDs",
);
for (const testCase of gate.invalid_graph_cases) {
  exactKeys(testCase, ["id", "expected_issue", "graph"], `invalid graph/${testCase.id}`);
  const issues = detectInvalidGraphIssues(testCase.graph, `invalid graph/${testCase.id}/graph`);
  assert(
    issues.has(testCase.expected_issue),
    `${testCase.id}: expected ${testCase.expected_issue}, got ${[...issues]}`,
  );
}

const capacity = record(await load("capacity/required-size-contexts.json"), "capacity contexts");
exactKeys(capacity, ["schema_version", "description", "contexts"], "capacity contexts");
assert.equal(capacity.schema_version, "1.0.0");
text(capacity.description, "capacity description");
exactMembers(
  capacity.contexts.map(({ entry_count }) => entry_count),
  REQUIRED_SIZES,
  "capacity sizes",
);
unique(
  capacity.contexts.map(({ id }) => id),
  "capacity IDs",
);
for (const context of capacity.contexts) {
  exactKeys(
    context,
    [
      "id",
      "entry_count",
      "time_zone",
      "dates",
      "area_count",
      "open",
      "close",
      "breaks",
      "slot_minutes",
      "expected_raw_slots",
    ],
    `capacity/${context.id}`,
  );
  text(context.id, "capacity ID");
  assertTimeZone(context.time_zone, `${context.id}/timezone`);
  assert(Array.isArray(context.dates) && context.dates.length > 0);
  context.dates.forEach((date, index) => parseDate(date, `${context.id}/dates[${index}]`));
  unique(context.dates, `${context.id}/dates`);
  positiveInteger(context.area_count, `${context.id}/area count`);
  positiveInteger(context.slot_minutes, `${context.id}/slot minutes`);
  positiveInteger(context.expected_raw_slots, `${context.id}/expected slots`);
  const open = parseTime(context.open, `${context.id}/open`);
  const close = parseTime(context.close, `${context.id}/close`);
  assert(close > open, `${context.id}: close must follow open`);
  assert(Array.isArray(context.breaks));
  const intervals = context.breaks.map((closure, index) => {
    exactKeys(closure, ["start", "end"], `${context.id}/breaks[${index}]`);
    const start = parseTime(closure.start, `${context.id}/breaks[${index}]/start`);
    const end = parseTime(closure.end, `${context.id}/breaks[${index}]/end`);
    assert(start >= open && end <= close && end > start, `${context.id}: break outside opening`);
    return { start, end };
  });
  intervals.sort((left, right) => left.start - right.start);
  intervals.forEach((interval, index) => {
    if (index > 0) assert(interval.start >= intervals[index - 1].end, `${context.id}: overlapping breaks`);
  });
  const unavailable = intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
  const slotsPerAreaDay = Math.floor((close - open - unavailable) / context.slot_minutes);
  assert.equal(
    slotsPerAreaDay * context.area_count * context.dates.length,
    context.expected_raw_slots,
    `${context.id}: area/day capacity mismatch`,
  );
}

const boundaries = record(await load("capacity/timezone-boundaries.json"), "timezone boundaries");
exactKeys(boundaries, ["schema_version", "description", "cases"], "timezone boundaries");
assert.equal(boundaries.schema_version, "1.0.0");
text(boundaries.description, "timezone description");
unique(
  boundaries.cases.map(({ id }) => id),
  "timezone case IDs",
);
for (const testCase of boundaries.cases) {
  const keys = ["id", "time_zone", "date", "start", "end", "slot_minutes", "expected_usable_minutes", "expected_slots"];
  if (testCase.cross_midnight !== undefined) keys.push("cross_midnight");
  exactKeys(testCase, keys, `timezone/${testCase.id}`);
  text(testCase.id, "timezone case ID");
  assertTimeZone(testCase.time_zone, `${testCase.id}/timezone`);
  parseDate(testCase.date, `${testCase.id}/date`);
  parseTime(testCase.start, `${testCase.id}/start`);
  parseTime(testCase.end, `${testCase.id}/end`);
  positiveInteger(testCase.slot_minutes, `${testCase.id}/slot minutes`);
  positiveInteger(testCase.expected_usable_minutes, `${testCase.id}/usable minutes`);
  positiveInteger(testCase.expected_slots, `${testCase.id}/slots`);
  if (testCase.cross_midnight !== undefined) assert.equal(testCase.cross_midnight, true);
  const endDate = testCase.cross_midnight ? nextDate(testCase.date) : testCase.date;
  const elapsed =
    (localInstant(testCase.time_zone, endDate, testCase.end) -
      localInstant(testCase.time_zone, testCase.date, testCase.start)) /
    60_000;
  assert.equal(elapsed, testCase.expected_usable_minutes, `${testCase.id}: elapsed mismatch`);
  assert.equal(Math.floor(elapsed / testCase.slot_minutes), testCase.expected_slots, `${testCase.id}: slot mismatch`);
}

const lifecycle = record(await load("competition-lifecycle.oracle.json"), "competition lifecycle");
exactKeys(lifecycle, ["state_transitions", "csv", "free_entry_limit"], "competition lifecycle");
assert.deepEqual(lifecycle.state_transitions, {
  draft: ["ready", "archived"],
  ready: ["draft", "published", "archived"],
  published: ["live", "archived"],
  live: ["completed", "archived"],
  completed: ["archived"],
  archived: [],
});
assert.equal(lifecycle.free_entry_limit, 16);
exactKeys(lifecycle.csv, ["source", "expected"], "competition CSV");
text(lifecycle.csv.source, "competition CSV source");
assert.equal(lifecycle.csv.expected.length, 2);
for (const [index, row] of lifecycle.csv.expected.entries()) {
  exactKeys(row, ["name", "type", "seed", "club", "countryCode"], `competition CSV row ${index}`);
  positiveInteger(row.seed, `competition CSV row ${index}/seed`);
}

const standings = record(await load("standings/five-sport-packs.json"), "five-sport standings");
exactKeys(standings, ["cases"], "five-sport standings");
exactMembers(
  standings.cases.map(({ sport }) => sport),
  REQUIRED_SPORTS,
  "standings sports",
);
for (const testCase of standings.cases) {
  exactKeys(testCase, ["sport", "results", "order"], `standings/${testCase.sport}`);
  assert(testCase.results.length >= 2, `${testCase.sport}: incomplete results`);
  unique(
    testCase.results.map(({ matchId }) => matchId),
    `${testCase.sport}/match IDs`,
  );
  for (const result of testCase.results) {
    const segmented = result.homeSegments !== undefined || result.awaySegments !== undefined;
    exactKeys(
      result,
      segmented
        ? [
            "matchId",
            "homeEntryId",
            "awayEntryId",
            "homeScore",
            "awayScore",
            "homeSegments",
            "awaySegments",
            "status",
            "version",
          ]
        : ["matchId", "homeEntryId", "awayEntryId", "homeScore", "awayScore", "status", "version"],
      `${testCase.sport}/${result.matchId}`,
    );
    text(result.matchId, `${testCase.sport}/match ID`);
    assert(result.homeEntryId !== result.awayEntryId);
    nonNegativeInteger(result.homeScore, `${result.matchId}/home score`);
    nonNegativeInteger(result.awayScore, `${result.matchId}/away score`);
    assert.equal(result.status, "final");
    positiveInteger(result.version, `${result.matchId}/version`);
    if (segmented) {
      assert(Array.isArray(result.homeSegments) && Array.isArray(result.awaySegments));
      assert(result.homeSegments.length > 0 && result.homeSegments.length === result.awaySegments.length);
      result.homeSegments.forEach((score, index) =>
        nonNegativeInteger(score, `${result.matchId}/home segment ${index}`),
      );
      result.awaySegments.forEach((score, index) =>
        nonNegativeInteger(score, `${result.matchId}/away segment ${index}`),
      );
      assert.equal(
        result.homeSegments.reduce((sum, score) => sum + score, 0),
        result.homeScore,
      );
      assert.equal(
        result.awaySegments.reduce((sum, score) => sum + score, 0),
        result.awayScore,
      );
    }
  }
  exactMembers(testCase.order, uniqueParticipants(testCase.results), `${testCase.sport}/order entries`);
  assert.deepEqual(standingsOrder(testCase), testCase.order, `${testCase.sport}: independent order mismatch`);
}

const headToHead = record(await load("standings/scoped-head-to-head.json"), "head-to-head fixture");
exactKeys(headToHead, ["description", "entries", "tiedScope", "expectedOrder", "results"], "head-to-head fixture");
text(headToHead.description, "head-to-head description");
unique(headToHead.entries, "head-to-head entries");
exactMembers(headToHead.expectedOrder, headToHead.entries, "head-to-head expected order");
assert(headToHead.tiedScope.length >= 2 && headToHead.tiedScope.every((id) => headToHead.entries.includes(id)));
const h2hRows = new Map(headToHead.entries.map((id) => [id, { id, points: 0, difference: 0 }]));
const directPoints = new Map(headToHead.entries.map((id) => [id, 0]));
for (const [index, result] of headToHead.results.entries()) {
  tuple(result, 5, `head-to-head/results[${index}]`);
  const [id, homeId, awayId, homeScore, awayScore] = result;
  text(id, `head-to-head/results[${index}]/id`);
  assert(h2hRows.has(homeId) && h2hRows.has(awayId) && homeId !== awayId);
  nonNegativeInteger(homeScore, `${id}/home score`);
  nonNegativeInteger(awayScore, `${id}/away score`);
  const home = h2hRows.get(homeId);
  const away = h2hRows.get(awayId);
  home.difference += homeScore - awayScore;
  away.difference += awayScore - homeScore;
  if (homeScore > awayScore) home.points += 3;
  else if (awayScore > homeScore) away.points += 3;
  else {
    home.points += 1;
    away.points += 1;
  }
  if (headToHead.tiedScope.includes(homeId) && headToHead.tiedScope.includes(awayId)) {
    if (homeScore > awayScore) directPoints.set(homeId, directPoints.get(homeId) + 3);
    else if (awayScore > homeScore) directPoints.set(awayId, directPoints.get(awayId) + 3);
    else {
      directPoints.set(homeId, directPoints.get(homeId) + 1);
      directPoints.set(awayId, directPoints.get(awayId) + 1);
    }
  }
}
const h2hOrder = [...h2hRows.values()]
  .sort(
    (left, right) =>
      right.points - left.points ||
      (headToHead.tiedScope.includes(left.id) && headToHead.tiedScope.includes(right.id)
        ? directPoints.get(right.id) - directPoints.get(left.id)
        : 0) ||
      right.difference - left.difference ||
      left.id.localeCompare(right.id),
  )
  .map(({ id }) => id);
assert.deepEqual(h2hOrder, headToHead.expectedOrder, "head-to-head semantic order mismatch");

const advancement = record(await load("standings/withdrawal-and-advancement.json"), "advancement fixture");
exactKeys(
  advancement,
  [
    "withdrawalPolicy",
    "withdrawnEntryId",
    "completedMatchIds",
    "futureForfeitMatchIds",
    "replacementEntryId",
    "knownEntries",
    "replacementLineage",
    "controlledSlots",
    "manualSlot",
    "fixtures",
    "groupSnapshotOrder",
    "slots",
    "rules",
    "expectedControlledEntries",
  ],
  "advancement fixture",
);
assert.equal(advancement.withdrawalPolicy, "completed_results_stand");
const fixtureIds = advancement.fixtures.map((fixture, index) => {
  tuple(fixture, 4, `advancement/fixtures[${index}]`);
  const [id, home, away, state] = fixture;
  text(id, `advancement/fixtures[${index}]/id`);
  assert(home !== away && ["completed", "future"].includes(state));
  return id;
});
unique(fixtureIds, "advancement fixture IDs");
validateAdvancementIdentities(advancement, "advancement");
exactMembers(
  advancement.completedMatchIds,
  advancement.fixtures.filter((fixture) => fixture[3] === "completed").map((fixture) => fixture[0]),
  "completed match linkage",
);
exactMembers(
  advancement.futureForfeitMatchIds,
  advancement.fixtures
    .filter((fixture) => fixture[3] === "future" && fixture.slice(1, 3).includes(advancement.withdrawnEntryId))
    .map((fixture) => fixture[0]),
  "future forfeit linkage",
);
unique(advancement.groupSnapshotOrder, "group snapshot order");
const slots = new Map();
for (const [index, slot] of advancement.slots.entries()) {
  tuple(slot, 4, `advancement/slots[${index}]`);
  const [slotId, control, ruleId, entryId] = slot;
  text(slotId, `advancement/slots[${index}]/id`);
  assert(["automatic", "manual"].includes(control));
  if (control === "automatic") text(ruleId, `${slotId}/rule`);
  else assert.equal(ruleId, null, `${slotId}: manual slot has rule`);
  assert(entryId === null || typeof entryId === "string");
  slots.set(slotId, { control, ruleId, entryId });
}
assert.equal(slots.size, advancement.slots.length, "duplicate advancement slot");
exactMembers(
  advancement.controlledSlots,
  [...slots].filter(([, slot]) => slot.control === "automatic").map(([id]) => id),
  "controlled slot linkage",
);
assert.equal(slots.get(advancement.manualSlot)?.control, "manual");
const rules = new Map();
for (const [index, rule] of advancement.rules.entries()) {
  tuple(rule, 4, `advancement/rules[${index}]`);
  const [ruleId, groupId, rank, targetSlotId] = rule;
  text(ruleId, `advancement/rules[${index}]/id`);
  text(groupId, `${ruleId}/group`);
  positiveInteger(rank, `${ruleId}/rank`);
  assert(rank <= advancement.groupSnapshotOrder.length, `${ruleId}: rank unavailable`);
  const target = slots.get(targetSlotId);
  assert(target?.control === "automatic" && target.ruleId === ruleId, `${ruleId}: target slot linkage mismatch`);
  rules.set(ruleId, { groupId, rank, targetSlotId });
}
assert.equal(rules.size, advancement.rules.length, "duplicate advancement rule");
exactMembers(
  [...rules.keys()],
  [...slots.values()].filter(({ control }) => control === "automatic").map(({ ruleId }) => ruleId),
  "advancement rule linkage",
);
const controlledEntries = [...rules.values()].map(({ rank, targetSlotId }) => [
  targetSlotId,
  advancement.groupSnapshotOrder[rank - 1],
]);
assert.deepEqual(controlledEntries, advancement.expectedControlledEntries, "controlled advancement mismatch");

// Mutation probes guard the fail-closed checks most likely to regress.
assert.throws(() => exactKeys({ allowed: 1, extra: 2 }, ["allowed"], "self-test"), /unknown or missing key/);
const graphProbe = structuredClone(formatFixtures[0].templates[0]);
graphProbe.matches[0][6] = `s:${REQUIRED_SIZES[0] + 1}`;
assert.throws(() => validateFormatTemplate(graphProbe, REQUIRED_SIZES[0], "self-test/seed"), /seed outside/);
const tupleProbe = structuredClone(formatFixtures[0].templates[0]);
tupleProbe.matches[0].pop();
assert.throws(() => validateFormatTemplate(tupleProbe, REQUIRED_SIZES[0], "self-test/tuple"), /8-field tuple/);
const referenceProbe = structuredClone(formatFixtures[0].templates[0]);
referenceProbe.matches.at(-1)[6] = "w:missing-match";
assert.throws(
  () => validateFormatTemplate(referenceProbe, REQUIRED_SIZES[0], "self-test/reference"),
  /unknown source match/,
);
const dependencyProbe = structuredClone(formatFixtures[0].templates[0]);
dependencyProbe.matches[0][6] = `w:${dependencyProbe.matches.at(-1)[0]}`;
assert.throws(
  () => validateFormatTemplate(dependencyProbe, REQUIRED_SIZES[0], "self-test/dependency"),
  /must be earlier/,
);
const qualifierProbe = structuredClone(formatFixtures[0].templates[0]);
qualifierProbe.stages[0][5] = 5;
assert.throws(
  () => validateFormatTemplate(qualifierProbe, REQUIRED_SIZES[0], "self-test/qualifier"),
  /output rank exceeds/,
);
const terminalProbe = structuredClone(formatFixtures[0].templates[0]);
terminalProbe.terminals = [terminalProbe.matches[0][0]];
assert.throws(() => validateFormatTemplate(terminalProbe, REQUIRED_SIZES[0], "self-test/terminal"), /terminal sinks/);
const metricsProbe = structuredClone(formatFixtures[0].templates[0]);
metricsProbe.metrics.maximumMatches += 1;
assert.throws(() => validateFormatTemplate(metricsProbe, REQUIRED_SIZES[0], "self-test/metrics"), /calculated metrics/);
const identityProbe = structuredClone(formatFixtures[0].templates[0]);
const oldId = "championship-r1-m1";
const newId = "arbitrary-semifinal";
identityProbe.matches.find((match) => match[0] === oldId)[0] = newId;
for (const stage of identityProbe.stages) stage[6] = stage[6].map((id) => (id === oldId ? newId : id));
for (const match of identityProbe.matches) {
  match[6] = match[6].replace(`:${oldId}`, `:${newId}`);
  match[7] = match[7].replace(`:${oldId}`, `:${newId}`);
}
assert.throws(
  () => validateFormatTemplate(identityProbe, REQUIRED_SIZES[0], "self-test/identity"),
  /deterministic match IDs/,
);
const outcomeProbe = structuredClone(formatFixtures[0].templates[0]);
const bronze = outcomeProbe.matches.find((match) => match[0] === "bronze-final");
const championshipFinal = outcomeProbe.matches.find((match) => match[0] === "championship-r2-m1");
[bronze[6], championshipFinal[6]] = [championshipFinal[6], bronze[6]];
assert.throws(
  () => validateFormatTemplate(outcomeProbe, REQUIRED_SIZES[0], "self-test/outcome"),
  /winner crosses|loser may feed/,
);
const rankProbe = structuredClone(formatFixtures[0].templates[1]);
const secondRankMatch = rankProbe.matches.find((match) => match[6] === "r:groups:G1:2" || match[7] === "r:groups:G1:2");
if (secondRankMatch[6] === "r:groups:G1:2") secondRankMatch[6] = "r:groups:G1:3";
else secondRankMatch[7] = "r:groups:G1:3";
assert.throws(() => validateFormatTemplate(rankProbe, REQUIRED_SIZES[0], "self-test/rank"), /qualifier rank set/);
assert.equal(classifyInvalidSettingsCase({ sportId: "table_tennis", settings: { pointCap: -1 } }), "range");
assert.equal(classifyInvalidSettingsCase({ sportId: "badminton", settings: { bestOf: 2.5 } }), "type");
assert.equal(
  classifyInvalidSettingsCase({ sportId: "badminton", settings: { bestOf: 4 } }),
  "invariant.best_of_is_odd",
);
const withdrawalProbe = structuredClone(advancement);
withdrawalProbe.withdrawnEntryId = "nobody";
withdrawalProbe.futureForfeitMatchIds = [];
assert.throws(
  () => validateAdvancementIdentities(withdrawalProbe, "self-test/withdrawal"),
  /withdrawn entry is unknown/,
);
const replacementProbe = structuredClone(advancement);
replacementProbe.replacementEntryId = "arbitrary-replacement";
assert.throws(
  () => validateAdvancementIdentities(replacementProbe, "self-test/replacement"),
  /replacement entry is unknown/,
);

console.log(
  `Validated Phase 3 Gate A: ${REQUIRED_SPORTS.length} sports, ${REQUIRED_SIZES.length} sizes, ${REQUIRED_SIZES.length * STRATEGIES.length} full graph oracles, ${boundaries.cases.length} timezone boundaries, and ${gate.invalid_graph_cases.length} invalid graphs.`,
);
