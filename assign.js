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
 * 멤버 제약을 검사한다.
 *  - 남성 premium: 남복 >= 1, 혼복 >= 1, 게임 코트 참여 >= minGames
 *  - 여성 premium: 여복 >= 1, 혼복 >= 1, 게임 코트 참여 >= minGames
 *  - guest: 게임 코트 참여 >= minGuestGames (0 이면 검사 안 함)
 *
 * @param {Array} assignments
 * @param {Array} members
 * @param {number} minGames - premium 최소 게임 횟수
 * @param {number} [minGuestGames=0] - guest 최소 게임 횟수 (0 이면 비활성)
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkPremiumConstraints(assignments, members, minGames, minGuestGames = 0) {
  // premium + guest 모두 게임 횟수를 추적한다.
  const stat = new Map();
  for (const p of members) {
    stat.set(p.name, {
      남복: 0, 여복: 0, 혼복: 0, 잡복: 0, game: 0,
      gender: p.gender, type: p.type,
    });
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
    if (s.type === "premium") {
      // minGames <= 0 이면 premium 보장 전체 비활성(복식/혼복/게임 모두 검사 안 함).
      if (minGames <= 0) continue;
      const singles = s.gender === "M" ? s.남복 : s.여복;
      const singlesLabel = s.gender === "M" ? "남복" : "여복";
      if (singles < 1) violations.push(`${name}: ${singlesLabel} 0회`);
      if (s.혼복 < 1) violations.push(`${name}: 혼복 0회`);
      if (s.game < minGames) violations.push(`${name}: 게임 ${s.game}회(<${minGames})`);
    } else {
      // guest: 게임 최소 횟수만 검사 (minGuestGames > 0 일 때)
      if (minGuestGames > 0 && s.game < minGuestGames) {
        violations.push(`${name}(guest): 게임 ${s.game}회(<${minGuestGames})`);
      }
    }
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
 * 코트의 특정 라운드 역할을 반환한다.
 * - court.roles (배열)가 있으면 라운드별 역할. 길이가 모자라면 마지막 값을 반복.
 * - 없으면 court.role (단일 값) 사용. 그것도 없으면 "게임".
 * @param {Object} court
 * @param {number} roundIdx - 0-indexed 라운드
 */
function courtRoleForRound(court, roundIdx) {
  if (Array.isArray(court.roles) && court.roles.length > 0) {
    const idx = Math.min(roundIdx, court.roles.length - 1);
    return court.roles[idx];
  }
  return court.role ?? "게임";
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
  // 랠리→다음 라운드 게임 규칙을 강제할지 여부 (기본 true).
  // premium 제약과 충돌해 배정이 불가능할 때 호출자가 false 로 완화할 수 있다.
  const enforceRallyToGame = options.enforceRallyToGame ?? true;

  const males = members.filter((p) => p.gender === "M");
  const females = members.filter((p) => p.gender === "W");

  // 라운드별 역할 구성(랠리/게임 코트 인덱스, 좌석 수, 성별 계획 후보)을 계산한다.
  // court.roles 로 라운드마다 역할이 달라질 수 있으므로 라운드별로 계산한다.
  // 같은 역할 구성은 캐시해서 재계산을 피한다.
  const planCache = new Map();

  function buildRoundConfig(roundIdx) {
    const rallyCourtIdx = [];
    const gameCourtIdx = [];
    courts.forEach((c, i) => {
      if (courtRoleForRound(c, roundIdx) === "랠리") rallyCourtIdx.push(i);
      else gameCourtIdx.push(i);
    });

    const cacheKey = gameCourtIdx.join(",") + "|" + rallyCourtIdx.join(",");
    if (planCache.has(cacheKey)) return planCache.get(cacheKey);

    const gameSeats = gameCourtIdx.length * COURT_SIZE;
    const maxCapacity = gameSeats + rallyCourtIdx.length * COURT_SIZE;

    if (members.length < gameSeats) {
      throw new Error(
        `라운드 ${roundIdx + 1}: 멤버 수(${members.length})가 게임 코트 좌석(${gameCourtIdx.length}코트 × ${COURT_SIZE} = ${gameSeats})보다 적습니다.`
      );
    }
    if (members.length > maxCapacity) {
      throw new Error(
        `라운드 ${roundIdx + 1}: 멤버 수(${members.length})가 최대 수용 인원(${maxCapacity}명)을 초과합니다.`
      );
    }

    const rallyTotal = members.length - gameSeats;
    const useRally = rallyTotal > 0 && rallyCourtIdx.length > 0;

    // 게임 코트 성별 계획 후보 수집 (랠리 남성 수에 따른 조합).
    const collectPlans = (preferSingles) => {
      const gameCourtCount = gameCourtIdx.length;
      const candidates = [];
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
      candidates.sort((a, b) => a.oddCount - b.oddCount);
      return candidates;
    };

    const basePlans = collectPlans(false);
    if (basePlans.length === 0) {
      throw new Error(
        `라운드 ${roundIdx + 1}: 현재 멤버 성비로 게임 코트 구성을 만들 수 없습니다.`
      );
    }
    const singlesPlans = collectPlans(true);

    const config = {
      rallyCourtIdx,
      gameCourtIdx,
      useRally,
      basePlans,
      singlesPlans,
    };
    planCache.set(cacheKey, config);
    return config;
  }

  const seed = options.seed ?? Date.now();
  const rng = createRng(seed);

  // 라운드별 역할 구성을 미리 계산 (검증 포함).
  const roundConfigs = [];
  for (let r = 0; r < rounds; r++) roundConfigs.push(buildRoundConfig(r));

  // "남복+여복 포함(singlesPlan)"을 적용할 라운드를 하나 고른다.
  // singlesPlan 이 가능한(게임 코트 2개 이상) 라운드 중에서만 선택한다.
  const singlesCandidates = roundConfigs
    .map((cfg, i) => (cfg.singlesPlans.length > 0 ? i : -1))
    .filter((i) => i >= 0);
  const singlesRound =
    singlesCandidates.length > 0
      ? singlesCandidates[Math.floor(rng() * singlesCandidates.length)]
      : -1;

  const result = [];
  let prevRallyNames = new Set(); // 직전 라운드에 랠리 코트에 있던 사람 이름

  // 멤버별 누적 게임 코트 참여 횟수 (공정성: 적게 한 사람을 다음 라운드 게임에 우선).
  const gameCount = new Map();
  members.forEach((p) => gameCount.set(p.name, 0));

  for (let r = 0; r < rounds; r++) {
    // 이 라운드의 역할 구성.
    const { rallyCourtIdx, gameCourtIdx, useRally, basePlans, singlesPlans } =
      roundConfigs[r];

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
    // 랠리 배치용: 게임을 "많이" 한 사람을 랠리로 먼저 보낸다(공정성). 동률이면 guest 우선.
    const byGuestFirst = (arr) =>
      arr.slice().sort((a, b) => {
        if (guestRank(a) !== guestRank(b)) return guestRank(a) - guestRank(b);
        return gameCount.get(b.name) - gameCount.get(a.name);
      });

    // 게임용 우선순위(앞일수록 게임 코트에 먼저 들어감):
    //   1) 직전 랠리 참가자 (랠리→게임 규칙상 반드시 게임)
    //   2) premium (게임 횟수 확보를 위해 게임 선호)
    //   3) guest (남는 자리는 랠리로 — guest 가 랠리를 더 많이 맡음)
    // 같은 그룹 안에서는 지금까지 게임을 "적게" 한 사람을 앞에 둬 공정하게 돌린다.
    const gamePriority = (p) => {
      // 랠리→게임 규칙을 강제할 때만 직전 랠리 참가자를 최우선 게임 배치.
      if (enforceRallyToGame && prevRallyNames.has(p.name)) return 0;
      if (p.type === "premium") return 1;
      return 2;
    };
    const orderGameFirst = (arr) =>
      arr.slice().sort((a, b) => {
        if (gamePriority(a) !== gamePriority(b)) {
          return gamePriority(a) - gamePriority(b);
        }
        // 게임을 적게 한 사람을 게임에 우선. 동률이면 랜덤(셔플 순서 유지).
        return gameCount.get(a.name) - gameCount.get(b.name);
      });

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
        const role = courtRoleForRound(court, r); // 이 라운드의 역할
        const isRally = role === "랠리";

        if (isRally) {
          // 랠리 코트: 팀 분할 없이 명단만. 인원이 0이면 생략.
          if (players.length === 0) return null;
          return {
            court: court.name,
            role,
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
          role,
          type: courtTypeLabel(maleCount),
          odd: isOddCourt(maleCount),
          teamA,
          teamB,
        };
      })
      .filter((c) => c !== null);

    // 코트 이름 순으로 정렬해 출력 일관성 유지
    roundCourts.sort((a, b) => a.court.localeCompare(b.court));

    // 이번 라운드 게임 코트 참가자의 누적 게임 횟수를 올린다(공정성 추적).
    for (const c of roundCourts) {
      if (c.role === "랠리") continue;
      for (const p of [...c.teamA, ...c.teamB]) {
        gameCount.set(p.name, (gameCount.get(p.name) || 0) + 1);
      }
    }

    result.push({ round: r + 1, courts: roundCourts });
    // 규칙을 강제하는 경우에만 직전 랠리 명단을 넘긴다.
    // 완화 모드에서는 빈 Set 으로 두어 랠리 제약을 없앤다.
    prevRallyNames = enforceRallyToGame ? curRallyNames : new Set();
  }

  return result;
}

/**
 * info 데이터를 기반으로 라운드별 코트 배정을 생성한다.
 * 목표 제약(premium 게임 >= minGames, guest 게임 >= minGuestGames, 성별복식·혼복 >=1)을
 * 만족하도록 여러 번 생성한다. 목표를 못 맞추면 제약을 단계적으로 완화하며 재시도하고,
 * 완화한 내용을 결과의 warning 에 기록한다.
 *
 * 완화 순서: 랠리→게임 규칙 해제 → premium 게임 목표 1씩 하향(최소 2) → guest 게임 목표 1씩 하향.
 *
 * @param {Object} info
 * @param {Object} [options]
 * @param {number} [options.seed] - 시작 시드 (재현용)
 * @param {number} [options.minGames] - premium 최소 게임 횟수 (기본 3)
 * @param {number} [options.minGuestGames] - guest 최소 게임 횟수 (기본 2)
 * @param {number} [options.maxAttempts] - 단계별 최대 재시도 횟수 (기본 1500)
 * @returns {Array} 라운드 배열 (완화/미충족 시 .warning 속성이 붙을 수 있음)
 */
function assignCourts(info, options = {}) {
  const members = info?.members ?? [];
  const hasPremium = members.some((m) => m.type === "premium");
  const hasGuest = members.some((m) => m.type !== "premium");
  // 최소 게임 횟수: options > info.info 설정 > 기본값 순으로 결정.
  // 0 이면 해당 보장을 끈다(premium 은 성별복식/혼복 검사도 함께 비활성).
  const cfg = info?.info ?? {};
  const minGames = options.minGames ?? cfg.minGames ?? 3; // premium 목표 게임 횟수
  const minGuestGames = options.minGuestGames ?? cfg.minGuestGames ?? 2; // guest 목표
  const maxAttempts = options.maxAttempts ?? 1500;
  const baseSeed = options.seed ?? Date.now();

  // 각 보장의 활성 여부.
  const premiumGuarantee = hasPremium && minGames > 0;
  const guestGuarantee = hasGuest && minGuestGames > 0;

  // 검사할 제약이 전혀 없으면 한 번만 생성.
  if (!premiumGuarantee && !guestGuarantee) {
    return generateOnce(info, { seed: baseSeed });
  }

  // --- 단계적 완화 탐색 ---
  // 목표 제약에서 시작해, 통과하는 단계가 없으면 제약을 한 단계씩 낮춰 재시도한다.
  // 각 단계: 랠리→게임 규칙(enforce), premium 게임 목표(pg), guest 게임 목표(gg).
  // 완화한 내용은 결과 warning 에 기록한다.
  const pg0 = premiumGuarantee ? minGames : 0;
  const gg0 = guestGuarantee ? minGuestGames : 0;
  // premium 완화 하한: 보장이 켜져 있으면 최소 2까지 낮춤, 꺼졌으면 0 고정.
  const pgMin = premiumGuarantee ? 2 : 0;

  // 완화 단계 정의 (위에서부터 시도, 통과 시 즉시 반환).
  // 완화 강도가 약한 것부터: (랠리규칙, premium게임, guest게임) 순서로 점점 낮춘다.
  // 같은 목표라도 랠리→게임 규칙은 ON(지킴)을 먼저, 안 되면 OFF(완화)를 시도한다.
  const stages = [];
  const relaxNote = (enforce, pg, gg) => {
    const parts = [];
    if (!enforce) parts.push("'랠리→다음 라운드 게임' 규칙 완화");
    if (pg < pg0) parts.push(`premium 최소 게임 ${pg}회`);
    if (gg < gg0) parts.push(`guest 최소 게임 ${gg}회`);
    return parts.length
      ? `제약을 만족시키기 위해 ${parts.join(", ")}로 조정했습니다.`
      : null;
  };

  // guest 목표를 바깥 루프(덜 중요하게 마지막에 낮춤)로, premium 목표를 그 안에서 낮춘다.
  const ggFloor = gg0 > 0 ? 1 : 0; // guest 보장이 켜지면 최소 1까지 낮춤
  for (let gg = gg0; gg >= ggFloor; gg--) {
    for (let pg = pg0; pg >= pgMin; pg--) {
      for (const enforce of [true, false]) {
        stages.push({ enforce, pg, gg, note: relaxNote(enforce, pg, gg) });
      }
      if (pgMin === pg0) break; // premium 보장 꺼짐: pg 루프 1회만
    }
    if (gg === 0) break;
  }

  let bestResult = null;
  let fewestViolations = Infinity;

  for (const stage of stages) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const seed = (baseSeed + attempt * 2654435761) >>> 0;
      const result = generateOnce(info, {
        seed,
        enforceRallyToGame: stage.enforce,
      });
      const { ok, violations } = checkPremiumConstraints(
        result,
        members,
        stage.pg,
        stage.gg
      );

      if (ok) {
        if (stage.note) result.warning = stage.note;
        return result;
      }
      if (violations.length < fewestViolations) {
        fewestViolations = violations.length;
        bestResult = result;
        bestResult.warning =
          `모든 제약을 만족하는 배정을 찾지 못했습니다. 가장 근접한 결과를 표시합니다. ` +
          `위반: ${violations.join(" / ")}`;
      }
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
