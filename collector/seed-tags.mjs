// =========================================================
// 리더보드(글로벌+국가별 랭킹) 기반으로 player_tags 큐에 대량 시드 추가
// 한 번(또는 가끔) 수동으로 실행하는 스크립트입니다.
// - 글로벌 상위 200명
// - 브롤러별 글로벌 상위 200명 (전체 브롤러 대상)
// - 국가별 상위 200명 (주요 국가들)
// =========================================================
import { createClient } from "@supabase/supabase-js";

const BS_BASE = "https://bsproxy.royaleapi.dev/v1";
const BS_API_KEY = process.env.BS_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 주요 국가 코드 (필요하면 더 추가/삭제 가능)
const COUNTRY_CODES = ["KR", "JP", "US", "GB", "DE", "FR", "IT", "ES", "NL", "PL", "TR", "SE", "IN"];

async function fetchJSON(path) {
  const res = await fetch(`${BS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${BS_API_KEY}` },
  });
  if (!res.ok) {
    console.warn(`[warn] ${path} 조회 실패: ${res.status}`);
    return null;
  }
  return res.json();
}

async function queueTags(tags) {
  if (tags.length === 0) return;
  const rows = tags.map((tag) => ({ tag }));
  const { error } = await supabase
    .from("player_tags")
    .upsert(rows, { onConflict: "tag", ignoreDuplicates: true });
  if (error) console.warn("[warn] 태그 큐 추가 실패:", error.message);
}

async function main() {
  let totalAdded = 0;

  // 1) 글로벌 상위 200명
  const globalRanking = await fetchJSON("/rankings/global/players");
  if (globalRanking?.items) {
    const tags = globalRanking.items.map((p) => p.tag);
    await queueTags(tags);
    totalAdded += tags.length;
    console.log(`글로벌 상위 ${tags.length}명 큐에 추가`);
  }

  // 2) 국가별 상위 200명
  console.log(`국가별 랭킹 조회 시작 (${COUNTRY_CODES.length}개국)`);
  for (const cc of COUNTRY_CODES) {
    const ranking = await fetchJSON(`/rankings/${cc}/players`);
    if (ranking?.items) {
      const tags = ranking.items.map((p) => p.tag);
      await queueTags(tags);
      totalAdded += tags.length;
      console.log(`  ${cc}: ${tags.length}명 추가`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // 3) 브롤러 목록 조회 후, 브롤러별 글로벌 상위 200명씩
  const brawlersRes = await fetchJSON("/brawlers");
  const brawlers = brawlersRes?.items ?? [];
  console.log(`브롤러 ${brawlers.length}종에 대해 브롤러별 랭킹 조회 시작`);

  for (const brawler of brawlers) {
    const ranking = await fetchJSON(`/rankings/global/brawlers/${brawler.id}`);
    if (ranking?.items) {
      const tags = ranking.items.map((p) => p.tag);
      await queueTags(tags);
      totalAdded += tags.length;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`시드 추가 완료 (중복 제외 전 총 ${totalAdded}건 큐잉 시도)`);
}

main();
