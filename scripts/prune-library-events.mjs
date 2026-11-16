// library-events.json(전국 도서관 행사 지도에서 가져온 자료)에서 이미 끝난 행사를 뺍니다.
// 조사는 주 1회(월요일)지만, 이 정리는 GitHub Actions가 매일 새벽 돌려서
// 문화행사 페이지에 끝난 도서관 행사가 남지 않게 합니다. Claude 사용량을 쓰지 않습니다.
//
// 실행: node scripts/prune-library-events.mjs

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../library-events.json', import.meta.url);
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function main() {
  let data;
  try {
    data = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    console.log('library-events.json이 없어 건너뜁니다.');
    return;
  }
  const today = todayKST();
  const before = Array.isArray(data.events) ? data.events.length : 0;
  const events = (data.events || []).filter((e) => (e.endDate || e.startDate || today) >= today);
  const removed = before - events.length;
  if (removed === 0) {
    console.log(`도서관 행사 지도 자료 ${before}건 · 끝난 행사 없음`);
    return;
  }
  data.events = events;
  data.count = events.length;
  data.prunedAt = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(data) + '\n', 'utf8');
  console.log(`도서관 행사 지도 자료: 끝난 행사 ${removed}건 정리 → ${events.length}건`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
