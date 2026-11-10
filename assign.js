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

  // 역할별 코트 인덱스 (랠리 / 게임)
  const rallyCourtIdx = [];
  const gameCourtIdx = [];
  courts.forEach((c, i) => {
    if (c.role === "랠리") rallyCourtIdx.push(i);
    else gameCourtIdx.push(i);
  });

  // 게임 코트는 항상 4명(복식). 랠리 코트는 4명 이하 허용(남는 인원 흡수).
  const gameSeats = gameCourtIdx.length * COURT_SIZE;
  const maxCapacity = gameSeats + rallyCourtIdx.length * COURT_SIZE;

  if (members.length < gameSeats) {
    throw new Error(
      `멤버 수(${members.length})가 게임 코트 좌석(${gameCourtIdx.length}코트 × ${COURT_SIZE} = ${gameSeats})보다 적습니다. ` +
        `게임 코트는 4명이 꽉 차야 하므로 최소 ${gameSeats}명이 필요합니다.`
    );
  }
  if (members.length > maxCapacity) {
    throw new Error(
      `멤버 수(${members.length})가 최대 수용 인원(${maxCapacity}명)을 초과합니다. ` +
        `코트를 늘리거나 멤버를 줄여주세요.`
    );
  }

  // 랠리 코트에 들어갈 총 인원 (게임 좌석을 채우고 남는 인원).
  // 0 이면 이 라운드에 랠리 코트는 운영하지 않는다.
  const rallyTotal = members.length - gameSeats; // 0 ~ rallyCourtIdx.length*4
  const useRally = rallyTotal > 0 && rallyCourtIdx.length > 0;

  const males = members.filter((p) => p.gender === "M");
  const females = members.filter((p) => p.gender === "W");

  // --- 게임 코트 성별 계획 ---
  // 랠리에 남녀 몇 명을 보낼지 먼저 정하고, 나머지로 게임 코트 성별 계획을 세운다.
  // 홀수(남3여1/여3남1)를 랠리로 흡수시켜 게임 코트를 최대한 짝수 구성으로 만든다.
  // rallyMale: 랠리에 보낼 남성 수 (0 ~ min(rallyTotal, males.length))
  // 게임 코트 남성 수 = males.length - rallyMale, 이 값으로 findGenderPlan 가능해야 함.
  // 가능한 (게임 코트 성별 계획, 랠리 남성 수) 후보를 모두 모은다.
  // 랠리 남성 수(rallyMale)에 따라 게임 코트의 성별 구성이 달라진다.
  // 라운드마다 가용 인원 상황에 맞는 후보를 골라 유연하게 배정한다.
  function collectPlans(preferSingles) {
    const gameCourtCount = gameCourtIdx.length;
    const candidates = []; // { plan, rallyMale, rallyFemale, oddCount }
    const minRM = Math.max(0, rallyTotal - females.length);
    const maxRM = Math.min(rallyTotal, males.length);
    for (let rallyMale = minRM; rallyMale <= maxRM; rallyMale++) {
      const rallyFemale = rallyTotal - rallyMale;
      const gMale = males.length - rallyMale;
      const gFemale = females.length - rallyFemale;
      if (gMale < 0 || gFemale < 0) continue;
      if (gMale + gFemale !== gameCourtCount * COURT_SIZE) continue;
      let plan;
      if (preferSingles) {
        plan = findGenderPlanWithSingles(gMale, gFemale, gameCourtCount);
        if (!plan) continue;
      } else {
        plan = findGenderPlan(gMale, gFemale, gameCourtCount);
      }
      candidates.push({
        plan,
        rallyMale,
        rallyFemale,
        oddCount: plan.filter(isOddCourt).length,
      });
    }
    // 게임 코트 홀수가 적은(=랠리가 홀수 흡수) 후보를 앞에 둔다.
    candidates.sort((a, b) => a.oddCount - b.oddCount);
    return candidates;
  }

  const basePlans = collectPlans(false);
  if (basePlans.length === 0) {
    throw new Error("현재 멤버 성비로 게임 코트 구성을 만들 수 없습니다.");
  }
  const singlesPlans = collectPlans(true);

  const seed = options.seed ?? Date.now();
  const rng = createRng(seed);

  // 전체 라운드 중 "남복+여복 포함(singlesPlan)"을 적용할 라운드를 하나 고른다.
  // 그 라운드 하나에서 남복과 여복이 동시에 등장하므로 "최소 1회씩" 조건이 충족된다.
  let singlesRound = -1;
  if (singlesPlans.length > 0 && rounds >= 1) {
    singlesRound = Math.floor(rng() * rounds);
  }

  const result = [];
  let prevRallyNames = new Set(); // 직전 라운드에 랠리 코트에 있던 사람 이름

  for (let r = 0; r < rounds; r++) {
    // 이 라운드에 사용할 게임 코트 성별 계획 후보를 고른다.
    const useSingles = r === singlesRound && singlesPlans.length > 0;
    const pool = useSingles ? singlesPlans : basePlans;
    // 후보 중 하나를 라운드마다 랜덤 선택(시드에 따라 달라짐 → 재시도 시 다양성 확보).
    const pick = pool[Math.floor(rng() * pool.length)];
    const gamePlan = shuffle(pick.plan, rng);
    const rallyMale = pick.rallyMale; // 랠리에 보낼 남성 수
    const rallyFemale = pick.rallyFemale; // 랠리에 보낼 여성 수

    // 게임 코트에 들어갈 남녀 수.
    const gameMaleTotal = males.length - rallyMale;
    const gameFemaleTotal = females.length - rallyFemale;

    // --- 사람 풀 구성 ---
    // 랠리→게임 규칙: 직전 랠리 참가자는 이번 라운드에 게임 코트로 가야 한다.
    // 따라서 게임 코트에 직전 랠리 참가자를 "우선" 배치하고, 랠리 코트에는
    // 직전 랠리가 아닌(allowed) 사람 중에서, guest 를 우선으로 채운다.
    const byGuestFirst = (arr) =>
      arr.slice().sort((a, b) => guestRank(a) - guestRank(b));

    // 게임용 우선순위(앞일수록 게임 코트에 먼저 들어감):
    //   1) 직전 랠리 참가자 (랠리→게임 규칙상 반드시 게임)
    //   2) premium (게임 횟수 확보를 위해 게임 선호)
    //   3) guest (남는 자리는 랠리로 — guest 가 랠리를 더 많이 맡음)
    const gamePriority = (p) => {
      if (prevRallyNames.has(p.name)) return 0;
      if (p.type === "premium") return 1;
      return 2;
    };
    const orderGameFirst = (arr) =>
      arr.slice().sort((a, b) => gamePriority(a) - gamePriority(b));

    const mPool = orderGameFirst(shuffle(males, rng));
    const wPool = orderGameFirst(shuffle(females, rng));

    const assignment = new Array(courts.length);
    const curRallyNames = new Set();

    // --- 1단계: 게임 코트 채우기 ---
    // 게임 풀에서 앞에서부터 뽑는다(직전 랠리 참가자 우선).
    const mGame = mPool.slice(0, gameMaleTotal);
    const wGame = wPool.slice(0, gameFemaleTotal);
    // 게임에 들어가지 않은 나머지가 랠리 후보.
    const mRest = mPool.slice(gameMaleTotal);
    const wRest = wPool.slice(gameFemaleTotal);

    const mGameQ = mGame.slice();
    const wGameQ = wGame.slice();
    gameCourtIdx.forEach((courtIndex, i) => {
      const maleNeeded = gamePlan[i];
      const femaleNeeded = COURT_SIZE - maleNeeded;
      assignment[courtIndex] = [
        ...mGameQ.splice(0, maleNeeded),
        ...wGameQ.splice(0, femaleNeeded),
      ];
    });

    // --- 2단계: 랠리 코트 채우기 (4명 이하 허용) ---
    // 랠리 후보(mRest+wRest)를 랠리 코트에 담는다. guest 우선.
    const rallyPeople = byGuestFirst([...mRest, ...wRest]);
    if (useRally) {
      rallyCourtIdx.forEach((courtIndex, i) => {
        // 랠리 코트가 1개인 전제: 남는 인원 전부를 한 코트에 담는다.
        // (여러 개면 균등 분배)
        const share = Math.ceil(rallyPeople.length / rallyCourtIdx.length);
        const players = rallyPeople.splice(0, share);
        players.forEach((p) => curRallyNames.add(p.name));
        assignment[courtIndex] = players;
      });
    } else {
      // 랠리 미운영: 랠리 코트에 빈 배열
      rallyCourtIdx.forEach((courtIndex) => {
        assignment[courtIndex] = [];
      });
    }

    // --- 결과 조립 ---
    const roundCourts = courts
      .map((court, courtIndex) => {
        const players = assignment[courtIndex] || [];
        const isRally = court.role === "랠리";

        if (isRally) {
          // 랠리 코트: 팀 분할 없이 명단만. 인원이 0이면 생략.
          if (players.length === 0) return null;
          return {
            court: court.name,
            role: court.role,
            type: "랠리",
            odd: false,
            players,
            teamA: players, // 호환성: 표시용
            teamB: [],
          };
        }

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
      })
      .filter((c) => c !== null);

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
      if (c.role === "랠리") {
        // 랠리 코트: 명단만 표시
        const names = (c.players || c.teamA).map((p) => p.name).join(", ");
        lines.push(`[${c.court} / ${c.role}] (${c.type}) ${names}`);
        continue;
      }
      const a = c.teamA.map((p) => p.name).join(", ");
      const b = c.teamB.map((p) => p.name).join(", ");
      lines.push(`[${c.court} / ${c.role}] (${c.type}) ${a}  vs  ${b}`);
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
