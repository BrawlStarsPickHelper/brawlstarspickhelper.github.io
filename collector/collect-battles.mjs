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

async function fetchProfile(tag) {
  const res = await fetch(`${BS_BASE}/players/${encodeTag(tag)}`, {
    headers: { Authorization: `Bearer ${BS_API_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`[warn] ${tag} 프로필 조회 실패: ${res.status}`);
    return null;
  }
  return res.json();
}

async function fetchBattleLog(tag) {
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

async function upsertBrawler(brawler) {
  await supabase
    .from("brawlers")
    .upsert({ id: brawler.id, name: brawler.name }, { onConflict: "id", ignoreDuplicates: true });
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

let DIAG_rankedTypeCount = 0;
let DIAG_zeroTrophyChangeCount = 0;

async function processBattle(battle, sourceTag, sourceRankedRank) {
  const event = battle.event ?? {};
  const battleInfo = battle.battle ?? {};

  // 경쟁전(랭크)만, 그리고 팀 정보가 있는 3vs3 형태만 처리
  if (battleInfo.type !== "ranked") return;
  if (!Array.isArray(battleInfo.teams)) return;
  DIAG_rankedTypeCount++;
  // 진짜 경쟁전 모드는 트로피가 전혀 변동되지 않음. trophyChange가 0이 아니면
  // (구)일반 트로피 매칭인데 type만 "ranked"로 찍힌 경우이므로 제외.
  if (battleInfo.trophyChange) return;
  DIAG_zeroTrophyChangeCount++;

  const allPlayers = battleInfo.teams.flat();
  const tags = allPlayers.map((p) => p.tag);

  const battleTimeISO = new Date(
    battle.battleTime.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
      "$1-$2-$3T$4:$5:$6"
    )
  ).toISOString();

  const battleHash = makeBattleHash(battleTimeISO, tags);

  // 브롤러/맵 참조 테이블 채우기
  for (const p of allPlayers) {
    if (p.brawler) await upsertBrawler(p.brawler);
  }
  await upsertMap(event.id, event.map, battleInfo.mode ?? event.mode);

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

  const { data: queue, error } = await supabase
    .from("player_tags")
    .select("tag")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(TAGS_PER_RUN);

  if (error) {
    console.error("player_tags 조회 실패:", error);
    process.exit(1);
  }

  console.log(`이번 실행 대상 태그 ${queue.length}개`);

  let skippedLowRank = 0;
  let processedCount = 0;

  for (const { tag } of queue) {
    const profile = await fetchProfile(tag);
    const rankedRank = profile?.rankedRank ?? null;

    // 전설 3 미만이면 이 태그의 배틀은 아예 수집하지 않음
    if (rankedRank == null || rankedRank < MIN_RANKED_RANK) {
      skippedLowRank++;
    } else {
      processedCount++;
      const battles = await fetchBattleLog(tag);
      if (battles) {
        for (const battle of battles) {
          try {
            await processBattle(battle, tag, rankedRank);
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
  console.log(
    `[진단] type=ranked 배틀: ${DIAG_rankedTypeCount}개 / 그 중 trophyChange=0(진짜 경쟁전): ${DIAG_zeroTrophyChangeCount}개`
  );
  console.log("수집 완료");
}

main();
