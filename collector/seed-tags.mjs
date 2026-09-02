// =========================================================
// 리더보드(글로벌 랭킹) 기반으로 player_tags 큐에 대량 시드 추가
// 한 번(또는 가끔) 수동으로 실행하는 스크립트입니다.
// - 글로벌 상위 200명
// - 브롤러별 상위 200명 (전체 브롤러 대상)
// 상위 200명은 사실상 마스터~프로급이 확실해서 전설3+ 통과율이 높습니다.
// =========================================================
import { createClient } from "@supabase/supabase-js";

const BS_BASE = "https://bsproxy.royaleapi.dev/v1";
const BS_API_KEY = process.env.BS_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  // 2) 브롤러 목록 조회 후, 브롤러별 상위 200명씩
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
    // API 레이트리밋 배려용 약간의 딜레이
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`시드 추가 완료 (중복 제외 전 총 ${totalAdded}건 큐잉 시도)`);
}

main();
