/**
 * matchCourt - 코트별 인원 배정 스크립트 (테니스 복식)
 *
 * 조건
 *  - 코트당 4명(복식) 배정, 코트 수 x 4 === 멤버 수 이면 매 라운드 전원 참여
 *  - 각 코트는 성별 구성에 따라 타입이 정해진다:
 *      남복(MD): 남4
 *      여복(WD): 여4
 *      혼복(XD): 남2 여2
 *  - 성별 수가 짝수로 안 맞으면 남3여1 / 여3남1 같은 "홀수 코트"가 생긴다.
 *    이 홀수 코트의 개수를 최소로 만드는 구성을 선택한다.
 *  - 매 라운드 조합을 섞어 같은 파트너/상대 반복을 최소화한다.
 *
 * 브라우저와 Node 양쪽에서 사용할 수 있도록 작성.
 */

const COURT_SIZE = 4; // 복식: 한 코트에 4명 (2 vs 2)

/** 시드 기반 난수 생성기 (Mulberry32). 같은 시드면 같은 결과. */
function createRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 셔플 (새 배열 반환) */
function shuffle(array, rng) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 코트의 남성 수(m)로 타입 라벨을 정한다. (여성 수는 4 - m) */
function courtTypeLabel(m) {
  switch (m) {
    case 4:
      return "남복";
    case 0:
      return "여복";
    case 2:
      return "혼복";
    case 3:
      return "남3여1";
    case 1:
      return "여3남1";
    default:
      return `남${m}여${4 - m}`;
  }
}

/** 홀수 구성(남1 또는 남3)이면 true */
function isOddCourt(m) {
  return m === 1 || m === 3;
}

/** 랠리 배치 우선순위: guest(0)가 premium(1)보다 먼저 랠리에 들어가게 한다. */
function guestRank(p) {
  return p.type === "premium" ? 1 : 0;
}

/** 코트 타입을 통계/제약용 분류로 변환 (잡복 = 홀수 코트) */
function categoryOf(court) {
  if (court.odd) return "잡복";
  if (court.type === "남복") return "남복";
  if (court.type === "여복") return "여복";
  return "혼복";
}

/**
 * premium 멤버 제약을 검사한다.
 *  - 남성 premium: 남복 >= 1, 혼복 >= 1, 게임 코트 참여 >= minGames
 *  - 여성 premium: 여복 >= 1, 혼복 >= 1, 게임 코트 참여 >= minGames
 *
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkPremiumConstraints(assignments, members, minGames) {
  const premium = members.filter((m) => m.type === "premium");
  const stat = new Map();
  for (const p of premium) {
    stat.set(p.name, { 남복: 0, 여복: 0, 혼복: 0, 잡복: 0, game: 0, gender: p.gender });
  }

  for (const round of assignments) {
    for (const c of round.courts) {
      const cat = categoryOf(c);
      const isGame = c.role !== "랠리";
      for (const p of [...c.teamA, ...c.teamB]) {
        const s = stat.get(p.name);
        if (!s) continue;
        s[cat] += 1;
        if (isGame) s.game += 1;
      }
    }
  }

  const violations = [];
  for (const [name, s] of stat) {
    const singles = s.gender === "M" ? s.남복 : s.여복;
    const singlesLabel = s.gender === "M" ? "남복" : "여복";
    if (singles < 1) violations.push(`${name}: ${singlesLabel} 0회`);
    if (s.혼복 < 1) violations.push(`${name}: 혼복 0회`);
    if (s.game < minGames) violations.push(`${name}: 게임 ${s.game}회(<${minGames})`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 남성 maleCount / 여성 femaleCount 를 courtCount개 코트(각 4명)로 나누는
 * 코트별 남성 수 배열을 찾는다. 홀수 코트 개수를 최소화한다.
 *
 * @returns {number[]} 각 코트의 남성 수 배열 (내림차순 정렬 안 됨, 조합 자체)
 */
function findGenderPlan(maleCount, femaleCount, courtCount) {
  // 각 코트의 남성 수는 0~4. 합이 maleCount 여야 하고,
  // 여성 합(4*courtCount - maleCount)은 femaleCount 와 같아야 한다.
  const total = courtCount * COURT_SIZE;
  if (maleCount + femaleCount !== total) {
    throw new Error(
      `멤버 수가 코트 수용 인원과 맞지 않습니다. (남 ${maleCount} + 여 ${femaleCount} ≠ ${total})`
    );
  }

  let best = null; // { plan: number[], oddCount, mixedPref }

  // courtCount개의 코트에 0~4 남성 수를 배정하는 모든 조합을 탐색 (코트 수가 적어 충분히 빠름)
  const plan = new Array(courtCount).fill(0);

  function recurse(index, remainingMale) {
    if (index === courtCount) {
      if (remainingMale !== 0) return;
      evaluate(plan);
      return;
    }
    const courtsLeft = courtCount - index - 1;
    for (let m = 0; m <= COURT_SIZE; m++) {
      const rest = remainingMale - m;
      // 남은 코트로 채울 수 있는 범위를 벗어나면 가지치기
      if (rest < 0 || rest > courtsLeft * COURT_SIZE) continue;
      plan[index] = m;
      recurse(index + 1, rest);
    }
  }

  function evaluate(candidate) {
    const oddCount = candidate.filter(isOddCourt).length;
    // 2차 기준: 혼복(남2) 코트가 많은 걸 선호 (경기 다양성)
    const mixedCount = candidate.filter((m) => m === 2).length;
    // 홀수 코트는 남3여1(m===3)보다 여3남1(m===1)을 선호한다.
    // 남3 코트 개수가 적을수록 좋은 계획.
    const male3Count = candidate.filter((m) => m === 3).length;
    if (best === null) {
      best = { plan: candidate.slice(), oddCount, mixedPref: mixedCount, male3: male3Count };
      return;
    }
    // 우선순위: 홀수 코트 최소 → 남3 코트 최소 → 혼복 최대
    if (oddCount !== best.oddCount) {
      if (oddCount < best.oddCount) {
        best = { plan: candidate.slice(), oddCount, mixedPref: mixedCount, male3: male3Count };
      }
      return;
    }
    if (male3Count !== best.male3) {
      if (male3Count < best.male3) {
        best = { plan: candidate.slice(), oddCount, mixedPref: mixedCount, male3: male3Count };
      }
      return;
    }
    if (mixedCount > best.mixedPref) {
      best = { plan: candidate.slice(), oddCount, mixedPref: mixedCount, male3: male3Count };
    }
  }

  recurse(0, maleCount);

  if (!best) {
    throw new Error("가능한 성별 구성을 찾지 못했습니다.");
  }
  return best.plan;
}

/**
 * 남복(남4) 코트 1개와 여복(여4) 코트 1개를 반드시 포함하는 성별 계획을 만든다.
 * 나머지 코트는 남은 인원으로 홀수 코트를 최소화하며 채운다.
 * 인원이 부족해 남복/여복을 동시에 넣을 수 없으면 null 을 반환한다.
 *
 * @returns {number[]|null} 각 코트의 남성 수 배열
 */
function findGenderPlanWithSingles(maleCount, femaleCount, courtCount) {
  // 남복(남4) + 여복(여4)을 빼고 남은 인원/코트로 나머지를 구성.
  if (maleCount < 4 || femaleCount < 4 || courtCount < 2) return null;
  const restCourts = courtCount - 2;
  const restMale = maleCount - 4;
  const restFemale = femaleCount - 4;
  if (restMale < 0 || restFemale < 0) return null;
  if (restMale + restFemale !== restCourts * COURT_SIZE) return null;

  // 남복(4), 여복(0)을 앞에 두고 나머지는 홀수 최소화 계획으로 채운다.
  const restPlan =
    restCourts === 0
      ? []
      : findGenderPlan(restMale, restFemale, restCourts);
  return [4, 0, ...restPlan];
}

/**
 * 한 코트(4명)를 받아 성별 균형을 맞춰 2팀으로 나눈다.
 * 가능하면 각 팀의 성별 구성을 같게 (혼복이면 팀마다 남1여1).
 */
function splitTeams(players) {
  const males = players.filter((p) => p.gender === "M");
  const females = players.filter((p) => p.gender === "W");

  // 혼복(남2여2): 각 팀 남1여1
  if (males.length === 2 && females.length === 2) {
    return {
      teamA: [males[0], females[0]],
      teamB: [males[1], females[1]],
    };
  }
  // 그 외(남4/여4/남3여1/여3남1): 앞에서부터 2명씩
  return {
    teamA: [players[0], players[1]],
    teamB: [players[2], players[3]],
  };
}

/**
 * 한 번의 배정 결과를 생성한다 (제약 검사는 하지 않음).
 * @param {Object} info
 * @param {Object} [options] - { seed }
 * @returns {Array} 라운드 배열
 */
function generateOnce(info, options = {}) {
  const rounds = info?.info?.rounds ?? 1;
  const members = info?.members ?? [];
  const courts = info?.courts ?? [];

  const capacity = courts.length * COURT_SIZE;
  if (members.length !== capacity) {
    throw new Error(
      `멤버 수(${members.length})가 코트 수용 인원(${courts.length}코트 x ${COURT_SIZE}명 = ${capacity})과 맞지 않습니다. ` +
        `매 라운드 쉬는 사람 없이 배정하려면 멤버 수가 ${capacity}명이어야 합니다.`
    );
  }

  const males = members.filter((p) => p.gender === "M");
  const females = members.filter((p) => p.gender === "W");

  // 기본 계획: 홀수 코트를 최소화하는 코트별 남성 수 계획 (혼복 위주)
  const basePlan = findGenderPlan(males.length, females.length, courts.length);

  // 남복/여복을 한 번씩 포함하는 특별 계획 (전체 라운드 중 일부에만 사용)
  const singlesPlan = findGenderPlanWithSingles(
    males.length,
    females.length,
    courts.length
  );

  // 역할별 코트 인덱스 (랠리 / 게임)
  const rallyCourtIdx = [];
  const gameCourtIdx = [];
  courts.forEach((c, i) => {
    if (c.role === "랠리") rallyCourtIdx.push(i);
    else gameCourtIdx.push(i);
  });

  const rallySeats = rallyCourtIdx.length * COURT_SIZE;
  if (rallySeats > gameCourtIdx.length * COURT_SIZE) {
    // 랠리 참가자는 다음 라운드에 모두 게임으로 가야 하므로,
    // 게임 좌석이 랠리 좌석보다 많아야 제약을 항상 만족할 수 있다.
    throw new Error(
      "랠리 좌석 수가 게임 좌석 수보다 많아 '랠리→다음 라운드 게임' 규칙을 보장할 수 없습니다."
    );
  }

  const seed = options.seed ?? Date.now();
  const rng = createRng(seed);

  // 전체 라운드 중 "남복+여복 포함(singlesPlan)"을 적용할 라운드를 하나 고른다.
  // 그 라운드 하나에서 남복과 여복이 동시에 등장하므로 "최소 1회씩" 조건이 충족된다.
  let singlesRound = -1;
  if (singlesPlan && rounds >= 1) {
    singlesRound = Math.floor(rng() * rounds);
  }

  const result = [];
  let prevRallyNames = new Set(); // 직전 라운드에 랠리 코트에 있던 사람 이름

  for (let r = 0; r < rounds; r++) {
    // 이 라운드에 사용할 성별 계획을 고른다.
    const planForRound = r === singlesRound ? singlesPlan : basePlan;

    // 각 코트에 배정될 남성 수 계획을 라운드마다 섞는다.
    const planOrder = shuffle(planForRound, rng);

    // 남녀 풀을 섞되, 랠리 코트에는 guest 를 먼저 쓰도록 정렬한다.
    // (premium 은 게임 코트에 더 많이 두어 "게임 N회 이상" 제약을 돕는다.)
    // 정렬 우선순위: guest 가 앞, premium 이 뒤. 같은 타입끼리는 셔플 순서 유지.
    const byGuestFirst = (arr) =>
      arr.slice().sort((a, b) => guestRank(a) - guestRank(b));
    const mPool = byGuestFirst(shuffle(males, rng));
    const wPool = byGuestFirst(shuffle(females, rng));

    // 랠리 가능(직전 랠리가 아닌) 사람과 불가능(직전 랠리) 사람으로 분리.
    const mAllowed = mPool.filter((p) => !prevRallyNames.has(p.name));
    const mBlocked = mPool.filter((p) => prevRallyNames.has(p.name));
    const wAllowed = wPool.filter((p) => !prevRallyNames.has(p.name));
    const wBlocked = wPool.filter((p) => prevRallyNames.has(p.name));

    // 홀수 구성(남1/남3)을 최대한 랠리 코트로 보낸다.
    // 단, 랠리 코트는 allowed 풀에서만 채울 수 있으므로, allowed 가용 수로 채울 수 있는
    // 계획 값만 랠리에 배정한다. (채울 수 없으면 게임 코트로 넘김)
    // 선호도: 홀수(남1/남3) > 그 외. 동률이면 랜덤(이미 planOrder가 섞여 있음).
    let availM = mAllowed.length;
    let availW = wAllowed.length;
    const remainingPlan = planOrder.slice();
    const rallyPlan = [];

    for (let s = 0; s < rallyCourtIdx.length; s++) {
      // 채울 수 있는 후보 인덱스 (남성 m명, 여성 4-m명이 allowed 에 남아있는지)
      const feasible = remainingPlan
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => m <= availM && COURT_SIZE - m <= availW);

      if (feasible.length === 0) {
        // 이론상 랠리 좌석 <= 게임 좌석이면 발생하지 않지만, 안전장치로 혼합값 하나 사용
        const idx = 0;
        const m = remainingPlan[idx];
        rallyPlan.push(m);
        availM -= m;
        availW -= COURT_SIZE - m;
        remainingPlan.splice(idx, 1);
        continue;
      }

      // 홀수 코트를 우선 선택
      feasible.sort((a, b) => {
        const aOdd = isOddCourt(a.m) ? 0 : 1;
        const bOdd = isOddCourt(b.m) ? 0 : 1;
        return aOdd - bOdd;
      });

      const chosen = feasible[0];
      rallyPlan.push(chosen.m);
      availM -= chosen.m;
      availW -= COURT_SIZE - chosen.m;
      remainingPlan.splice(chosen.idx, 1);
    }

    // 게임 코트 계획은 나머지 값. 순서를 섞어 코트별 타입을 변화시킨다.
    const gamePlan = shuffle(remainingPlan, rng);

    const assignment = new Array(courts.length); // courtIndex -> players[]
    const curRallyNames = new Set();

    // 랠리 코트 채우기: allowed 풀에서만 뽑는다.
    rallyCourtIdx.forEach((courtIndex, i) => {
      const maleNeeded = rallyPlan[i];
      const femaleNeeded = COURT_SIZE - maleNeeded;
      const players = [
        ...mAllowed.splice(0, maleNeeded),
        ...wAllowed.splice(0, femaleNeeded),
      ];
      players.forEach((p) => curRallyNames.add(p.name));
      assignment[courtIndex] = players;
    });

    // --- 2단계: 게임 코트를 나머지 인원으로 채운다 ---
    // 랠리에서 쓰고 남은 allowed + 랠리에 못 들어간 blocked 를 합쳐 게임 풀 구성.
    const mGame = [...mBlocked, ...mAllowed];
    const wGame = [...wBlocked, ...wAllowed];

    gameCourtIdx.forEach((courtIndex, i) => {
      const maleNeeded = gamePlan[i];
      const femaleNeeded = COURT_SIZE - maleNeeded;
      const players = [
        ...mGame.splice(0, maleNeeded),
        ...wGame.splice(0, femaleNeeded),
      ];
      assignment[courtIndex] = players;
    });

    // --- 결과 조립 ---
    const roundCourts = courts.map((court, courtIndex) => {
      const players = assignment[courtIndex];
      const maleCount = players.filter((p) => p.gender === "M").length;
      const { teamA, teamB } = splitTeams(players);
      return {
        court: court.name,
        role: court.role,
        type: courtTypeLabel(maleCount),
        odd: isOddCourt(maleCount),
        teamA,
        teamB,
      };
    });

    // 코트 이름 순으로 정렬해 출력 일관성 유지
    roundCourts.sort((a, b) => a.court.localeCompare(b.court));

    result.push({ round: r + 1, courts: roundCourts });
    prevRallyNames = curRallyNames;
  }

  return result;
}

/**
 * info 데이터를 기반으로 라운드별 코트 배정을 생성한다.
 * premium 멤버 제약(남/여복 >=1, 혼복 >=1, 게임 코트 >= minGames)을 만족하도록
 * 여러 번 생성해 보고, 만족하는 결과를 반환한다. 끝까지 못 찾으면 위반이 가장 적은
 * 결과를 반환하고 결과 객체에 warning 을 담는다.
 *
 * @param {Object} info
 * @param {Object} [options]
 * @param {number} [options.seed] - 시작 시드 (재현용)
 * @param {number} [options.minGames] - premium 최소 게임 코트 횟수 (기본 3)
 * @param {number} [options.maxAttempts] - 최대 재시도 횟수 (기본 2000)
 * @returns {Array} 라운드 배열 (제약 미충족 시 .warning 속성이 붙을 수 있음)
 */
function assignCourts(info, options = {}) {
  const members = info?.members ?? [];
  const hasPremium = members.some((m) => m.type === "premium");
  const minGames = options.minGames ?? 3;
  const maxAttempts = options.maxAttempts ?? 2000;
  const baseSeed = options.seed ?? Date.now();

  // premium 이 없으면 제약 검사 없이 한 번만 생성.
  if (!hasPremium) {
    return generateOnce(info, { seed: baseSeed });
  }

  let bestResult = null;
  let fewestViolations = Infinity;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 시도마다 시드를 바꿔 서로 다른 배정을 만든다.
    const seed = (baseSeed + attempt * 2654435761) >>> 0;
    const result = generateOnce(info, { seed });
    const { ok, violations } = checkPremiumConstraints(result, members, minGames);

    if (ok) {
      return result; // 제약을 모두 만족하는 첫 결과를 채택
    }
    if (violations.length < fewestViolations) {
      fewestViolations = violations.length;
      bestResult = result;
      bestResult.warning =
        `premium 제약을 완전히 만족하는 배정을 ${maxAttempts}회 내에 찾지 못했습니다. ` +
        `가장 근접한 결과를 표시합니다. 위반: ${violations.join(" / ")}`;
    }
  }

  return bestResult;
}

/** 배정 결과를 사람이 읽기 좋은 텍스트로 변환 */
function formatAssignments(assignments) {
  const lines = [];
  for (const round of assignments) {
    lines.push(`=== 라운드 ${round.round} ===`);
    for (const c of round.courts) {
      const a = c.teamA.map((p) => p.name).join(", ");
      const b = c.teamB.map((p) => p.name).join(", ");
      lines.push(
        `[${c.court} / ${c.role}] (${c.type}) ${a}  vs  ${b}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- 내보내기 (브라우저 / Node 겸용) ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    assignCourts,
    generateOnce,
    checkPremiumConstraints,
    formatAssignments,
    findGenderPlan,
    COURT_SIZE,
  };
}
if (typeof window !== "undefined") {
  window.matchCourt = {
    assignCourts,
    checkPremiumConstraints,
    formatAssignments,
    findGenderPlan,
    COURT_SIZE,
  };
}
