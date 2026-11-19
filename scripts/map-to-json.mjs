// data/library-events-source.html(도서관 행사 조사 원본, 옛 「전국 도서관 행사 지도」 형식)의 EVENTS·SRC를 문화행사 페이지용 library-events.json으로 바꿉니다.
// 행사 지도는 주 1회 조사 작업이 출처를 하나씩 확인해 만든 자료이고,
// 문화행사 페이지(index.html)는 이 파일을 '도서관/강연' 장르로 함께 보여 줍니다.
//
// 실행: node scripts/map-to-json.mjs  (인자 없으면 data/library-events-source.html)

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const OUT = new URL('../library-events.json', import.meta.url);
const MAP_URL = ''; // 행사 지도 아티팩트는 더 갱신하지 않음(2026-11-19). 원문 링크가 없는 행사는 빈칸.
const DEFAULT_SRC = new URL('../data/library-events-source.html', import.meta.url);

// 행사 지도 지역(16개 시·도) → 문화행사 페이지 권역
const REGION = {
  서울: '서울', 인천: '경기·인천', 경기: '경기·인천', 강원: '강원',
  충북: '충청', 세종: '충청', 충남: '충청', 대전: '충청',
  전북: '전라', 전남광주: '전라',
  경북: '경상', 대구: '경상', 울산: '경상', 경남: '경상', 부산: '경상',
  제주: '제주'
};

// 페이지 스크립트 안의 `const NAME = {...};` / `[...]` 덩어리를 괄호 짝을 맞춰 잘라 냅니다(JS 객체 리터럴).
function grab(src, name) {
  const i = src.indexOf(`const ${name} = `);
  if (i < 0) throw new Error(`${name}를 찾지 못했습니다.`);
  const start = src.indexOf('=', i) + 1;
  let depth = 0, inStr = null, j = start;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (inStr) { if (ch === '\\') { j++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) break; }
  }
  return vm.runInNewContext(`(${src.slice(start, j + 1)})`, {});
}

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function main() {
  const path = process.argv[2] || DEFAULT_SRC;

  const html = await readFile(path, 'utf8');
  const SRC = grab(html, 'SRC');
  const EVENTS = grab(html, 'EVENTS');
  const asof = (html.match(/(\d{4})\.(\d{2})\.(\d{2}) 기준 조사/) || []).slice(1).join('-');
  const today = todayKST();

  const out = [];
  EVENTS.forEach((e, idx) => {
    if (!e || !e.title || !e.start) return;
    const end = e.end || e.start;
    if (end < today) return; // 끝난 행사 제외
    const src = (e.src || []).map((k) => SRC[k]).filter(Boolean);
    const srcName = src.length ? String(src[0].t).split(' 「')[0] : '';
    const lines = [
      e.when && `일시: ${e.when}`,
      e.place && `장소: ${e.place}`,
      e.who && `대상: ${e.who}`,
      !e.who && e.target && e.target.length && `대상: ${e.target.join(', ')}`,
      e.apply && `신청: ${e.apply}`,
      !e.end && '종료일은 원문에 없습니다.',
      e.online && '온라인 행사입니다.',
      e.note,
      srcName && `출처: ${srcName}`
    ].filter(Boolean);
    out.push({
      id: `libmap-${idx}-${String(e.lib).slice(0, 8)}-${e.start}`,
      title: e.title,
      venue: e.lib,
      region: REGION[e.region] || e.region,
      genre: '도서관/강연',
      startDate: e.start,
      endDate: end,
      price: e.apply || '원문 확인',
      cast: `${e.lib} · ${e.cat || '프로그램'}`,
      desc: lines.join('\n'),
      posterUrl: '',
      sourceUrl: (src[0] && src[0].u) || MAP_URL,
      paletteIdx: 5,
      _source: '전국 도서관 행사 지도'
    });
  });

  await writeFile(OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    surveyedAt: asof || null,
    source: '도서관 행사 조사(libraryviolin, 주 1회 갱신)',
    sourceUrl: MAP_URL,
    count: out.length,
    events: out
  }) + '\n', 'utf8');
  console.log(`library-events.json 저장: ${out.length}건 (행사 지도 전체 ${EVENTS.length}건, 조사일 ${asof || '알 수 없음'})`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
