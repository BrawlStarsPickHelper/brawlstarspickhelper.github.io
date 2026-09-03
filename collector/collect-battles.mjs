// =========================================================
// 브롤스타즈 경쟁전(전설 3 이상) 배틀로그 수집 스크립트
// GitHub Actions에서 주기적으로 실행하는 것을 전제로 작성됨
//
// 전설 3 이상 필터링 방식:
// 각 태그의 프로필(/players/{tag})에서 rankedRank 필드를 확인해서
// (18 = 전설 III, 그 이상이면 전설 3 이상) 통과한 플레이어의
// 경쟁전 배틀만 수집한다.
// =========================================================
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ---- 설정값 ------------------------------------------------
// RoyaleAPI 프록시 사용: 발급받은 API 키의 화이트리스트 IP를
// 45.79.218.79 로 등록해두면, 아래처럼 도메인만 바꿔서 호출 가능
const BS_BASE = "https://bsproxy.royaleapi.dev/v1";

// 전설 III = 18 (브론즈I~III=1~3, 실버=4~6, 골드=7~9, 다이아=10~12, 신화=13~15, 전설=16~18)
// 실측으로 확인된 값. 시즌/패치로 바뀔 수 있으니 이상하면 재확인 필요.
const MIN_RANKED_RANK = Number(process.env.MIN_RANKED_RANK ?? 18);

// 한 번 실행에서 처리할 태그 수 (API 레이트리밋 고려해서 보수적으로)
const TAGS_PER_RUN = Number(process.env.TAGS_PER_RUN ?? 50);

// ---- 클라이언트 초기화 --------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role 키 (RLS 무시하고 씀)
);

const BS_API_KEY = process.env.BS_API_KEY;

function encodeTag(tag) {
  // '#ABCDEF' -> '%23ABCDEF'
  return encodeURIComponent(tag.startsWith("#") ? tag : `#${tag}`);
}

async function loadRankedMapWhitelist() {
  const { data, error } = await supabase.from("ranked_map_whitelist").select("mode,map_name");
  if (error) {
    console.warn("[warn] 맵 화이트리스트 조회 실패:", error.message);
    return new Set();
  }
  return new Set(data.map((r) => `${r.mode}::${r.map_name}`));
}

async function fetchProfile(tag) {
  try {
    const res = await fetch(`${BS_BASE}/players/${encodeTag(tag)}`, {
      headers: { Authorization: `Bearer ${BS_API_KEY}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[warn] ${tag} 프로필 조회 실패: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    // 네트워크 순간 오류(ECONNRESET 등)는 이 태그만 건너뛰고 계속 진행
    console.warn(`[warn] ${tag} 프로필 조회 중 네트워크 오류:`, e.message);
    return null;
  }
}

async function fetchBattleLog(tag) {
  try {
    const res = await fetch(`${BS_BASE}/players/${encodeTag(tag)}/battlelog`, {
      headers: { Authorization: `Bearer ${BS_API_KEY}` },
    });
    if (res.status === 404) return null; // 태그가 사라졌거나 오탈자
    if (!res.ok) {
      console.warn(`[warn] ${tag} battlelog fetch failed: ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.items ?? [];
  } catch (e) {
    console.warn(`[warn] ${tag} battlelog 조회 중 네트워크 오류:`, e.message);
    return null;
  }
}

function makeBattleHash(battleTimeISO, tags) {
  const sorted = [...tags].sort().join(",");
  return crypto.createHash("sha256").update(`${battleTimeISO}|${sorted}`).digest("hex");
}

function resultForTeam(teamIdx, sourceTeamIdx, battleResult) {
  if (battleResult == null) return null;
  const sameTeam = teamIdx === sourceTeamIdx;
  if (battleResult === "draw") return "draw";
  if (sameTeam) return battleResult; // 소스 태그가 속한 팀은 배틀 결과 그대로
  return battleResult === "victory" ? "defeat" : "victory"; // 반대 팀은 반대 결과
}

async function upsertBrawlers(brawlers) {
  if (brawlers.length === 0) return;
  const rows = brawlers.map((b) => ({ id: b.id, name: b.name }));
  await supabase.from("brawlers").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
}

async function upsertMap(mapId, mapName, mode) {
  if (!mapId) return;
  await supabase
    .from("maps")
    .upsert({ id: mapId, name: mapName, mode }, { onConflict: "id", ignoreDuplicates: true });
}

async function queueNewTags(tags) {
  const rows = tags.map((tag) => ({ tag }));
  await supabase.from("player_tags").upsert(rows, { onConflict: "tag", ignoreDuplicates: true });
}

async function processBattle(battle, sourceTag, sourceRankedRank, mapWhitelist) {
  const event = battle.event ?? {};
  const battleInfo = battle.battle ?? {};

  // 경쟁전(랭크)만, 그리고 팀 정보가 있는 3vs3 형태만 처리
  // ⚠️ 실측 확인: 진짜 경쟁전의 type 값은 "ranked"가 아니라 "soloRanked"/"teamRanked" 였음.
  // "ranked"는 일반 트로피 매칭 등 다른 것들까지 포함하는 값이라 이걸로 거르면 안 됨.
  if (!["soloRanked", "teamRanked"].includes(battleInfo.type)) return;
  if (!Array.isArray(battleInfo.teams)) return;
  // 진짜 경쟁전 모드는 트로피가 전혀 변동되지 않아 trophyChange 필드 자체가 없음.
  // 필드가 있으면(=일반 트로피 매칭인데 type만 ranked로 찍힌 경우) 제외.
  if (battleInfo.trophyChange) return;
  // 실제 경쟁전에 나오는 맵인지 화이트리스트로 한 번 더 검증
  const mode = battleInfo.mode ?? event.mode;
  if (!mapWhitelist.has(`${mode}::${event.map}`)) {
    // 화이트리스트에 없어서 걸러진 맵은, 혹시 이름 오타/불일치일 수 있으니
    // 한 번 실행당 조합별로 한 번만 경고 로그를 남김 (동일 이름 반복 스팸 방지)
    const key = `${mode}::${event.map}`;
    if (!global.__loggedMissingMaps) global.__loggedMissingMaps = new Set();
    if (!global.__loggedMissingMaps.has(key)) {
      global.__loggedMissingMaps.add(key);
      console.warn(`[whitelist-miss] 화이트리스트에 없는 맵 발견: mode=${mode}, map="${event.map}" (오타/누락일 수 있음)`);
    }
    return;
  }

  const allPlayers = battleInfo.teams.flat();
  const tags = allPlayers.map((p) => p.tag);

  const battleTimeISO = new Date(
    battle.battleTime.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
      "$1-$2-$3T$4:$5:$6"
    )
  ).toISOString();

  const battleHash = makeBattleHash(battleTimeISO, tags);

  // 브롤러/맵 참조 테이블 채우기 (서로 독립적이라 병렬로 실행)
  const brawlersInBattle = allPlayers.map((p) => p.brawler).filter(Boolean);
  await Promise.all([
    upsertBrawlers(brawlersInBattle),
    upsertMap(event.id, event.map, battleInfo.mode ?? event.mode),
  ]);

  // battles insert (이미 있으면 건너뜀)
  // ranked_rank는 "이 배틀을 가져온 소스 플레이어"의 현재 rankedRank 스냅샷
  // (매칭 상대까지 전부 조회하진 않으므로 근사치임)
  const { data: battleRow, error: battleErr } = await supabase
    .from("battles")
    .upsert(
      {
        battle_hash: battleHash,
        battle_time: battleTimeISO,
        mode: battleInfo.mode ?? event.mode,
        map_id: event.id ?? null,
        ranked_rank: sourceRankedRank,
        raw_battle: battle,
      },
      { onConflict: "battle_hash" }
    )
    .select("id")
    .single();

  if (battleErr || !battleRow) return;

  // 소스 태그가 속한 팀 인덱스를 찾아서, 팀별로 승/패를 정확히 나눔
  const sourceTeamIdx = battleInfo.teams.findIndex((team) =>
    team.some((p) => p.tag === sourceTag)
  );

  // 참가자 6명 insert
  const participantRows = battleInfo.teams.flatMap((team, teamIdx) =>
    team.map((p) => ({
      battle_id: battleRow.id,
      player_tag: p.tag,
      brawler_id: p.brawler?.id,
      team: teamIdx,
      result: resultForTeam(teamIdx, sourceTeamIdx, battleInfo.result),
      trophy_change: p.tag === sourceTag ? battleInfo.trophyChange ?? null : null,
    }))
  );

  await supabase
    .from("battle_participants")
    .upsert(participantRows, { onConflict: "battle_id,player_tag", ignoreDuplicates: true });

  // 크롤링 확장: 이번 경기에 나온 태그들을 다음 수집 대상 큐에 추가
  // (이후 실행에서 이 태그들도 프로필 조회 -> rankedRank 확인을 거쳐서 처리됨)
  await queueNewTags(tags.filter((t) => t !== sourceTag));
}

async function updateCurrentRotation() {
  const res = await fetch(`${BS_BASE}/events/rotation`, {
    headers: { Authorization: `Bearer ${BS_API_KEY}` },
  });
  if (!res.ok) {
    console.warn(`[warn] 로테이션 조회 실패: ${res.status}`);
    return;
  }
  const events = await res.json();
  for (const e of events) {
    const map = e.event ?? e; // 응답 형태 방어적으로 처리
    if (!map?.id || !map?.mode) continue;
    await upsertMap(map.id, map.map, map.mode);
    await supabase
      .from("current_rotation")
      .upsert({ mode: map.mode, map_id: map.id, updated_at: new Date().toISOString() }, { onConflict: "mode" });
  }
}

async function main() {
  await updateCurrentRotation();
  const mapWhitelist = await loadRankedMapWhitelist();

  const { data: queue, error } = await supabase
    .from("player_tags")
    .select("tag")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(TAGS_PER_RUN);

  if (error) {
    console.error("player_tags 조회 실패:", error);
    process.exit(1);
  }

  // DEBUG_TAG는 큐 순서(수만 명 밀려있어도)와 무관하게 이번 실행에 무조건 포함시킴
  let finalQueue = queue;
  if (process.env.DEBUG_TAG && !queue.some((q) => q.tag === process.env.DEBUG_TAG)) {
    finalQueue = [{ tag: process.env.DEBUG_TAG }, ...queue];
    console.log(`DEBUG_TAG(${process.env.DEBUG_TAG})를 큐 순서 무시하고 강제로 포함시킴`);
  }

  console.log(`이번 실행 대상 태그 ${finalQueue.length}개`);

  let skippedLowRank = 0;
  let processedCount = 0;

  for (const { tag } of finalQueue) {
    const profile = await fetchProfile(tag);
    const rankedRank = profile?.rankedRank ?? null;

    // 전설 3 미만이면 이 태그의 배틀은 아예 수집하지 않음
    if (rankedRank == null || rankedRank < MIN_RANKED_RANK) {
      skippedLowRank++;
    } else {
      processedCount++;
      const battles = await fetchBattleLog(tag);
      if (battles) {
        // ⚠️ 디버그용: DEBUG_TAG 환경변수와 일치하면 이 사람의 25경기 전부를
        // 통과/제외 여부와 이유까지 자세히 로그로 출력
        if (process.env.DEBUG_TAG && tag === process.env.DEBUG_TAG) {
          const rosterCounts = new Map();
          for (const b of battles) {
            const teams = b.battle?.teams;
            if (!Array.isArray(teams)) continue;
            const allTags = teams.flat().map((p) => p.tag);
            if (allTags.length !== 6) continue;
            const key = [...allTags].sort().join(",");
            rosterCounts.set(key, (rosterCounts.get(key) ?? 0) + 1);
          }
          console.log(`=== DEBUG_TAG(${tag}) 배틀 ${battles.length}개 상세 ===`);
          for (const b of battles) {
            const bi = b.battle ?? {};
            const ev = b.event ?? {};
            let reason = "통과";
            if (!["soloRanked", "teamRanked"].includes(bi.type)) reason = `제외: type=${bi.type}`;
            else if (!Array.isArray(bi.teams)) reason = "제외: teams 없음";
            else if (bi.trophyChange) reason = `제외: trophyChange=${bi.trophyChange} (일반매칭)`;
            else if (!mapWhitelist.has(`${bi.mode ?? ev.mode}::${ev.map}`)) reason = `제외: 화이트리스트에 없는 맵 (${bi.mode ?? ev.mode}/${ev.map})`;
            else {
              const allTags = (bi.teams ?? []).flat().map((p) => p.tag);
              const key = [...allTags].sort().join(",");
              const rosterCount = rosterCounts.get(key) ?? 1;
              if (rosterCount > 1) reason = `제외: 반복 로스터 (이 6명 조합이 ${rosterCount}번 나옴)`;
            }
            console.log(`  ${b.battleTime} | mode=${bi.mode ?? ev.mode} | map=${ev.map} | trophyChange=${bi.trophyChange} | ${reason}`);
          }
          console.log("=== 끝 ===");
        }

        for (const battle of battles) {
          try {
            await processBattle(battle, tag, rankedRank, mapWhitelist);
          } catch (e) {
            console.warn(`[warn] battle 처리 실패 (${tag}):`, e.message);
          }
        }
      }
    }

    await supabase
      .from("player_tags")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("tag", tag);
  }

  console.log(`전설3+ 통과: ${processedCount}명 / 미달로 스킵: ${skippedLowRank}명`);
  console.log("수집 완료");
}

main();
