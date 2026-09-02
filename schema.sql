-- =========================================================
-- 브롤스타즈 경쟁전(신화 이상) 맵별 브롤러 승률 통계 스키마
-- Supabase(Postgres)에 그대로 실행하면 됩니다.
-- =========================================================

-- 1) 브롤러 참조 테이블
create table if not exists brawlers (
  id         bigint primary key,        -- 공식 API의 brawler id (예: 16000030)
  name       text not null,             -- 영문 이름 (API 원본, 예: EMZ)
  name_ko    text,                      -- 한글 이름 (직접 매핑해서 채워넣기)
  rarity     text                       -- 기본/희귀/초희귀/영웅/신화/전설/울트라 라전
);

-- 2) 맵 참조 테이블
create table if not exists maps (
  id         bigint primary key,        -- 공식 API의 map id
  name       text not null,             -- 영문 맵 이름
  name_ko    text,                      -- 한글 맵 이름
  mode       text not null              -- 게임 모드 (젬그랩, 녹아웃 등)
);

-- 2-1) 수집 대상 플레이어 태그 큐 (크롤링으로 계속 확장됨)
create table if not exists player_tags (
  tag              text primary key,     -- 예: #ABCDEFG
  discovered_at    timestamptz default now(),
  last_checked_at  timestamptz           -- 마지막으로 battlelog 조회한 시각
);
-- 주의: 이 테이블은 RLS를 켜두고 public 읽기 정책을 만들지 않습니다.
-- (수집 스크립트의 service_role key만 접근 가능 - 굳이 프론트에 노출할 필요 없음)
alter table player_tags enable row level security;

-- 3) 배틀(경기) 테이블 - 한 경기당 한 행
create table if not exists battles (
  id            bigserial primary key,
  battle_hash   text unique not null,   -- 중복 수집 방지용 해시 (아래 설명 참고)
  battle_time   timestamptz not null,
  mode          text not null,
  map_id        bigint references maps(id),
  trophy_level  int,                    -- 배틀 시점 트로피/랭크 레벨 (신화 이상만 저장)
  inserted_at   timestamptz default now()
);

create index if not exists idx_battles_map on battles(map_id);
create index if not exists idx_battles_time on battles(battle_time);

-- 4) 배틀 참가자 테이블 - 한 경기당 6행 (3vs3 기준)
create table if not exists battle_participants (
  id            bigserial primary key,
  battle_id     bigint references battles(id) on delete cascade,
  player_tag    text not null,
  brawler_id    bigint references brawlers(id),
  team          smallint,               -- 0 또는 1
  result        text check (result in ('victory','defeat','draw')),
  trophy_change int,
  unique (battle_id, player_tag)
);

create index if not exists idx_participants_battle on battle_participants(battle_id);
create index if not exists idx_participants_brawler on battle_participants(brawler_id);

-- 5) 집계 캐시 뷰: 맵별 x 브롤러별 승률
-- 표본이 적은 조합은 프론트에서 min_games로 걸러서 "표본 부족" 처리 권장
create or replace view map_brawler_winrate as
select
  b.map_id,
  m.name_ko as map_name,
  bp.brawler_id,
  br.name_ko as brawler_name,
  count(*) as games,
  count(*) filter (where bp.result = 'victory') as wins,
  round(
    100.0 * count(*) filter (where bp.result = 'victory')
    / nullif(count(*) filter (where bp.result in ('victory','defeat')), 0)
  , 1) as win_rate
from battle_participants bp
join battles b on b.id = bp.battle_id
join maps m on m.id = b.map_id
join brawlers br on br.id = bp.brawler_id
group by b.map_id, m.name_ko, bp.brawler_id, br.name_ko;

-- =========================================================
-- 6) RLS (Row Level Security) 설정
--    - 프론트(Netlify)는 anon key로 "읽기"만 가능
--    - 데이터 적재는 GitHub Actions에서 service_role key로만
-- =========================================================
alter table brawlers enable row level security;
alter table maps enable row level security;
alter table battles enable row level security;
alter table battle_participants enable row level security;

create policy "public read brawlers" on brawlers for select using (true);
create policy "public read maps" on maps for select using (true);
create policy "public read battles" on battles for select using (true);
create policy "public read participants" on battle_participants for select using (true);

-- insert/update/delete 정책을 따로 만들지 않으면 anon key로는 쓰기가 자동 차단됩니다.
-- service_role key는 RLS를 무시하고 항상 쓰기가 가능하니, 수집 스크립트에서만 그 키를 사용하세요.

-- =========================================================
-- 참고: battle_hash 만드는 법
-- 같은 경기가 참가자 6명의 battlelog에 각각 찍혀서 6번 중복 수집될 수 있습니다.
-- battle_time + 참가자 태그 6개를 정렬해서 합친 문자열을 sha256 해시한 값을
-- battle_hash로 저장하면, 이미 들어온 경기는 upsert 시 자연스럽게 걸러집니다.
-- (수집 스크립트에서 처리 예정)
-- =========================================================
