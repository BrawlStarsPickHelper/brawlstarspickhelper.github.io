// =========================================================
// 브롤스타즈 신화 이상 경쟁전 배틀로그 수집 스크립트
// GitHub Actions에서 주기적으로 실행하는 것을 전제로 작성됨
// =========================================================
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ---- 설정값 ------------------------------------------------
// RoyaleAPI 프록시 사용: 발급받은 API 키의 화이트리스트 IP를
// 45.79.218.79 로 등록해두면, 아래처럼 도메인만 바꿔서 호출 가능
const BS_BASE = "https://bsproxy.royaleapi.dev/v1";

// ⚠️ 신화 랭크 트로피 레벨 임계값입니다. 정확한 값은 실제 배틀로그
// (teams[].brawler.trophies)를 몇 개 찍어보고 확인 후 채워넣으세요.
// (경쟁전 개편으로 시즌마다 바뀔 수 있어 하드코딩 대신 env로 뺐습니다)
const MIN_RANK_TROPHY = Number(process.env.MIN_RANK_TROPHY ?? 19);

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

function inferResult(player, battle) {
  // 경쟁전(ranked)은 battle.result가 없을 수 있어 trophyChange로 유추
  if (player.result) return player.result; // 'victory' | 'defeat' | 'draw'
  if (typeof battle.trophyChange === "number") {
    if (battle.trophyChange > 0) return "victory";
    if (battle.trophyChange < 0) return "defeat";
    return "draw";
  }
  return null;
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

let DEBUG_LOGGED = false; // 실행마다 딱 1번만 원본 JSON 출력

async function processBattle(battle, sourceTag) {
  const event = battle.event ?? {};
  const battleInfo = battle.battle ?? {};

  // 경쟁전(랭크)만, 그리고 팀 정보가 있는 3vs3 형태만 처리
  if (battleInfo.type !== "ranked") return;
  if (!Array.isArray(battleInfo.teams)) return;

  // ⚠️ 디버그용: 랭크 단계를 나타내는 필드가 실제로 있는지 확인하기 위해
  // 처음 발견한 ranked 배틀의 원본 JSON을 한 번만 통째로 출력함
  if (!DEBUG_LOGGED) {
    DEBUG_LOGGED = true;
    console.log("=== RAW RANKED BATTLE JSON (디버그용, 확인 후 제거) ===");
    console.log(JSON.stringify(battle, null, 2));
    console.log("=== 끝 ===");
  }

  const allPlayers = battleInfo.teams.flat();
  const tags = allPlayers.map((p) => p.tag);

  // 신화 이상 필터: 이 배틀에 참여한 브롤러들의 trophies로 판단
  const maxTrophy = Math.max(...allPlayers.map((p) => p.brawler?.trophies ?? 0));
  if (maxTrophy < MIN_RANK_TROPHY) return;

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
  const { data: battleRow, error: battleErr } = await supabase
    .from("battles")
    .upsert(
      {
        battle_hash: battleHash,
        battle_time: battleTimeISO,
        mode: battleInfo.mode ?? event.mode,
        map_id: event.id ?? null,
        trophy_level: maxTrophy,
      },
      { onConflict: "battle_hash" }
    )
    .select("id")
    .single();

  if (battleErr || !battleRow) return;

  // 참가자 6명 insert
  const participantRows = battleInfo.teams.flatMap((team, teamIdx) =>
    team.map((p) => ({
      battle_id: battleRow.id,
      player_tag: p.tag,
      brawler_id: p.brawler?.id,
      team: teamIdx,
      result: inferResult(p, battleInfo),
      trophy_change: battleInfo.trophyChange ?? null,
    }))
  );

  await supabase
    .from("battle_participants")
    .upsert(participantRows, { onConflict: "battle_id,player_tag", ignoreDuplicates: true });

  // 크롤링 확장: 이번 경기에 나온 태그들을 다음 수집 대상 큐에 추가
  await queueNewTags(tags.filter((t) => t !== sourceTag));
}

async function main() {
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

  for (const { tag } of queue) {
    const battles = await fetchBattleLog(tag);
    if (battles) {
      for (const battle of battles) {
        try {
          await processBattle(battle, tag);
        } catch (e) {
          console.warn(`[warn] battle 처리 실패 (${tag}):`, e.message);
        }
      }
    }
    await supabase
      .from("player_tags")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("tag", tag);
  }

  console.log("수집 완료");
}

main();
