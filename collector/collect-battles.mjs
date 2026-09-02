// =========================================================
// 브롤스타즈 경쟁전(솔로 랭크, 신화 이상) 배틀로그 수집 스크립트
// GitHub Actions에서 주기적으로 실행하는 것을 전제로 작성됨
// =========================================================
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// ---- 설정값 ------------------------------------------------
const BS_BASE = "https://bsproxy.royaleapi.dev/v1";

// DRY_RUN=true 이면 DB에 아무것도 쓰지 않고, soloRanked 배틀의 원본 JSON을
// 콘솔에 몇 개만 찍고 끝냄. "신화 이상" 판별에 쓸 정확한 필드/점수 값을
// 확인하기 전까지는 이 모드로만 돌려서 데이터 오염을 막는다.
const DRY_RUN = process.env.DRY_RUN === "true";
const DRY_RUN_SAMPLE_LIMIT = 3;

// 한 번 실행에서 처리할 태그 수 (API 레이트리밋 고려해서 보수적으로)
const TAGS_PER_RUN = Number(process.env.TAGS_PER_RUN ?? 50);

// ---- 클라이언트 초기화 --------------------------------------
const supabase = DRY_RUN
  ? null
  : createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY // service_role 키 (RLS 무시하고 씀)
    );

const BS_API_KEY = process.env.BS_API_KEY;

function encodeTag(tag) {
  return encodeURIComponent(tag.startsWith("#") ? tag : `#${tag}`);
}

async function fetchBattleLog(tag) {
  const res = await fetch(`${BS_BASE}/players/${encodeTag(tag)}/battlelog`, {
    headers: { Authorization: `Bearer ${BS_API_KEY}` },
  });
  if (res.status === 404) return null;
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

// =========================================================
// ⚠️ TODO (미확정): 경쟁전 랭크 점수(예: 신화=8250점) 판별 로직
//
// battle.type이 'soloRanked'인 배틀의 원본 JSON을 DRY_RUN=true로 몇 개
// 확인한 뒤, 실제로 점수/티어 정보가 어느 필드에 들어있는지 보고 채워넣을 것.
// 그 전까지는 항상 null을 반환해서, 아래 processBattle이 안전하게
// insert를 건너뛰도록 되어 있음 (잘못된 기준으로 저장하는 것 방지).
//
// 확인해야 할 후보:
//   - battle.trophyChange (경쟁전에서는 트로피 대신 랭크 포인트 변화량일 가능성)
//   - teams[][].brawler 하위에 새로 생긴 필드
//   - player 엔드포인트(/players/{tag})의 랭크 관련 필드
// =========================================================
const MIN_RANK_SCORE = Number(process.env.MIN_RANK_SCORE ?? 8250); // 신화 이상 기준(확정 전까지 참고용)

function extractRankScore(_battleInfo, _sourceTag) {
  // TODO: 실제 필드 확인 후 구현
  return null;
}

function resultForTeam(battleInfo, teamIdx, sourceTeamIdx) {
  // battle.result는 "조회한 플레이어(sourceTag)의 팀" 기준 승/패/무 이다.
  // 팀 인덱스가 다르면 반대 결과를 준다.
  const base = battleInfo.result;
  if (!base) return null;
  if (base === "draw") return "draw";
  if (sourceTeamIdx === -1) return null; // 소속 팀을 못 찾으면 결과 불확실 -> null
  if (teamIdx === sourceTeamIdx) return base;
  return base === "victory" ? "defeat" : "victory";
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

let dryRunSampleCount = 0;

async function processBattle(battle, sourceTag) {
  const event = battle.event ?? {};
  const battleInfo = battle.battle ?? {};

  // 경쟁전 "솔로 랭크"만 처리. 팀 랭크(teamRanked)는 별도로 필요하면 나중에 추가.
  if (battleInfo.type !== "soloRanked") return;
  if (!Array.isArray(battleInfo.teams)) return;

  if (DRY_RUN) {
    if (dryRunSampleCount >= DRY_RUN_SAMPLE_LIMIT) return;
    dryRunSampleCount++;
    console.log(`=== [DRY_RUN] soloRanked 원본 JSON 샘플 #${dryRunSampleCount} ===`);
    console.log(JSON.stringify(battle, null, 2));
    console.log("=== 끝 ===");
    return; // DB에 아무것도 쓰지 않음
  }

  const allPlayers = battleInfo.teams.flat();
  const tags = allPlayers.map((p) => p.tag);

  const rankScore = extractRankScore(battleInfo, sourceTag);
  if (rankScore === null) {
    // 점수 판별 로직이 아직 구현되지 않음 -> 안전하게 건너뜀
    console.warn("[skip] extractRankScore 미구현 상태라 저장하지 않음. DRY_RUN=true 로 먼저 원본 JSON을 확인하세요.");
    return;
  }
  if (rankScore < MIN_RANK_SCORE) return; // 신화 미만은 저장하지 않음

  const battleTimeISO = new Date(
    battle.battleTime.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
      "$1-$2-$3T$4:$5:$6"
    )
  ).toISOString();

  const battleHash = makeBattleHash(battleTimeISO, tags);

  for (const p of allPlayers) {
    if (p.brawler) await upsertBrawler(p.brawler);
  }
  await upsertMap(event.id, event.map, battleInfo.mode ?? event.mode);

  const { data: battleRow, error: battleErr } = await supabase
    .from("battles")
    .upsert(
      {
        battle_hash: battleHash,
        battle_time: battleTimeISO,
        mode: battleInfo.mode ?? event.mode,
        map_id: event.id ?? null,
        trophy_level: rankScore,
      },
      { onConflict: "battle_hash" }
    )
    .select("id")
    .single();

  if (battleErr || !battleRow) return;

  const sourceTeamIdx = battleInfo.teams.findIndex((team) =>
    team.some((p) => p.tag === sourceTag)
  );

  const participantRows = battleInfo.teams.flatMap((team, teamIdx) =>
    team.map((p) => ({
      battle_id: battleRow.id,
      player_tag: p.tag,
      brawler_id: p.brawler?.id,
      team: teamIdx,
      result: resultForTeam(battleInfo, teamIdx, sourceTeamIdx),
      // trophyChange는 조회한 태그(sourceTag) 기준 값이라, 그 행에만 의미가 있음
      trophy_change: p.tag === sourceTag ? battleInfo.trophyChange ?? null : null,
    }))
  );

  await supabase
    .from("battle_participants")
    .upsert(participantRows, { onConflict: "battle_id,player_tag", ignoreDuplicates: true });

  await queueNewTags(tags.filter((t) => t !== sourceTag));
}

async function main() {
  if (DRY_RUN) {
    console.log("=== DRY_RUN 모드: DB에 쓰지 않고 soloRanked 원본 JSON만 출력합니다 ===");
  }

  const tagSource = DRY_RUN ? [{ tag: process.env.DRY_RUN_TAG }] : null;

  const queue = tagSource
    ? tagSource
    : (
        await supabase
          .from("player_tags")
          .select("tag")
          .order("last_checked_at", { ascending: true, nullsFirst: true })
          .limit(TAGS_PER_RUN)
      ).data ?? [];

  if (!DRY_RUN && queue.length === 0) {
    console.warn(
      "player_tags 테이블이 비어있습니다. 최소 1개 이상의 태그를 직접 넣어서 크롤링을 시작해야 합니다 " +
        "(예: insert into player_tags (tag) values ('#YOUR_TAG');)"
    );
  }

  console.log(`이번 실행 대상 태그 ${queue.length}개`);

  for (const { tag } of queue) {
    if (!tag) continue;
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
    if (!DRY_RUN) {
      await supabase
        .from("player_tags")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("tag", tag);
    }
    if (DRY_RUN && dryRunSampleCount >= DRY_RUN_SAMPLE_LIMIT) break;
  }

  console.log("수집 완료");
}

main();
