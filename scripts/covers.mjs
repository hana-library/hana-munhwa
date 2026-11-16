// HANA된 책과 문화 · 추천도서 표지 찾기 (국립중앙도서관 ISBN 서지정보 API)
// adult/index.html의 책 목록을 읽어 표지 주소(TITLE_URL)를 찾고 adult/covers.json에 저장합니다.
// 한 번 찾은 책은 다시 조회하지 않고, 못 찾은 책은 30일 뒤에 한 번 더 찾아봅니다.
// API 안내: https://www.nl.go.kr/NL/contents/N31101030500.do
//
// 실행: NL_CERT_KEY=... node scripts/covers.mjs

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const PAGE = new URL('../adult/index.html', import.meta.url);
const OUT = new URL('../adult/covers.json', import.meta.url);
const CERT_KEY = (process.env.NL_CERT_KEY || '').trim();
const SOURCE = '국립중앙도서관 ISBN 서지정보 API';
const MAX_CALLS = Number(process.env.MAX_CALLS || 1500);
const RETRY_MISS_DAYS = 30;
const SCRIPT_VERSION = 3; // 바꾸면 '못 찾은 책'을 모두 다시 조회

// ── 페이지와 똑같은 정규화 (adult/index.html의 norm, coverKey와 반드시 같아야 함) ──
const norm = (s) => String(s).replace(/[\s()·,.:?!\-–—『』「」]/g, '').toLowerCase();
const mainTitle = (t) => String(t).split(/\s*[:：]\s*/)[0];
const coverKey = (title, pub) => norm(mainTitle(title)) + '|' + norm(pub || '');

// 출판사 비교: 괄호 안 표기를 빼고, 한쪽이 다른 쪽을 포함하면 같은 출판사로 봅니다. (예: 롱블랙(타임앤코) ↔ 롱블랙)
const pubCore = (p) => norm(String(p || '').replace(/\([^)]*\)/g, '').replace(/^(주식회사|\(주\)|㈜)\s*/, ''));
// 국립중앙도서관 자료는 'Holidaybooks(홀리데이북스)', 'Our Media(아워미디어) :메타미디어월드'처럼
// 영문 표기 + 괄호 안 한글 표기로 적힌 경우가 많아, 괄호 안 표기와 ':' 앞뒤 표기도 각각 비교합니다.
const pubVariants = (p) => {
  const raw = String(p || '');
  const parts = [raw, raw.replace(/\([^)]*\)/g, ''), ...(raw.match(/\(([^)]*)\)/g) || []).map((m) => m.slice(1, -1)), ...raw.split(/\s*:\s*/)];
  return [...new Set(parts.map((x) => pubCore(x)).filter((x) => x.length >= 2))];
};
const samePublisher = (a, b) => {
  const xs = pubVariants(a), ys = pubVariants(b);
  return xs.some((x) => ys.some((y) => x === y || y.includes(x) || x.includes(y)));
};
// 저자 비교(출판사가 없을 때만): 첫 저자 이름이 API 저자 칸에 들어 있는지
const firstAuthor = (a) => norm(String(a || '').split(/\s*[\/·,]\s*|\s+(?:외|글|그림|지음|엮음|편)(?=\s|$|·)/)[0]);
// API 서명 비교용: 부제(: 또는 " - " 뒤)를 뗀 본서명
const apiMain = (t) => norm(String(t || '').split(/\s+-\s+/)[0].split(/\s*[:：=]\s*/)[0]);

async function readBooks() {
  const html = await readFile(PAGE, 'utf8');
  const m = html.match(/const CUR = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('adult/index.html에서 CUR 목록을 찾지 못했습니다.');
  const CUR = vm.runInNewContext(`(${m[1]})`, {});
  const books = new Map();
  for (const c of CUR) {
    for (const b of c.books) {
      const [title, author, pub, year] = b;
      const p = pub === '—' ? '' : pub;
      const key = coverKey(title, p);
      if (!books.has(key)) books.set(key, { title, author, pub: p, year: String(year || '') });
    }
  }
  return books;
}

// 응답에서 서지 레코드 배열을 찾습니다(보통 docs). 필드 이름이 바뀌어도 TITLE이 있는 배열을 찾아 씁니다.
function findDocs(data) {
  if (Array.isArray(data?.docs)) return data.docs;
  for (const v of Object.values(data || {})) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object' && 'TITLE' in x)) return v;
  }
  return [];
}

async function searchNl(book) {
  const params = new URLSearchParams({
    cert_key: CERT_KEY,
    result_style: 'json',
    page_no: '1',
    page_size: '30',
    title: mainTitle(book.title)
  });
  const url = `https://www.nl.go.kr/seoji/SearchApi.do?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'hana-munhwa-covers/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`JSON 아님: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
    if (data.ERR_CODE || data.ERROR_CODE || data.result?.ERR_CODE) {
      throw new Error(`API 오류: ${JSON.stringify(data).slice(0, 160)}`);
    }
    return findDocs(data);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCoverUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  if (s.startsWith('/')) s = 'https://www.nl.go.kr' + s;
  s = s.replace(/^http:\/\//i, 'https://');
  return /^https:\/\/[a-z0-9.-]*nl\.go\.kr\//i.test(s) ? s : '';
}

function diagnose(book, docs) {
  const want = norm(mainTitle(book.title));
  if (!docs.length) return '검색 결과 없음';
  const sameTitle = docs.filter((d) => apiMain(d.TITLE) === want);
  if (!sameTitle.length) return `서명 불일치(예: ${docs.slice(0, 2).map((d) => d.TITLE).join(' / ')})`;
  const samePub = book.pub ? sameTitle.filter((d) => samePublisher(book.pub, d.PUBLISHER)) : sameTitle;
  if (!samePub.length) return `출판사 불일치(예: ${sameTitle.slice(0, 2).map((d) => d.PUBLISHER).join(' / ')})`;
  if (!samePub.some((d) => normalizeCoverUrl(d.TITLE_URL))) return '표지 이미지 미등록';
  return '저자 불일치';
}

function pickMatch(book, docs) {
  const want = norm(mainTitle(book.title));
  const withCover = docs.filter((d) => normalizeCoverUrl(d.TITLE_URL));
  const sameTitle = withCover.filter((d) => apiMain(d.TITLE) === want);
  let matched, by;
  if (book.pub) {
    matched = sameTitle.filter((d) => samePublisher(book.pub, d.PUBLISHER));
    by = '서명+출판사';
  } else {
    const fa = firstAuthor(book.author);
    matched = fa.length >= 2 ? sameTitle.filter((d) => norm(d.AUTHOR).includes(fa)) : [];
    by = '서명+저자';
  }
  if (!matched.length) return null;
  const yearOf = (d) => String(d.PUBLISH_PREDATE || d.REAL_PUBLISH_DATE || '').slice(0, 4);
  const sameYear = book.year ? matched.filter((d) => yearOf(d) === book.year) : [];
  const best = sameYear[0] || matched[0];
  if (book.year && !sameYear.length) by += '(연도 다름)';
  const isbn = String(best.EA_ISBN || best.SET_ISBN || '').replace(/[^0-9X]/gi, '');
  return {
    cover: normalizeCoverUrl(best.TITLE_URL),
    link: isbn ? `https://www.nl.go.kr/NL/contents/search.do?kwd=${isbn}` : '',
    isbn13: isbn,
    apiTitle: best.TITLE || '',
    matchedBy: by
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CERT_KEY) {
    console.log('NL_CERT_KEY가 아직 없습니다. 저장소 Secrets에 국립중앙도서관 인증키를 등록하면 표지를 찾기 시작합니다.');
    return; // 실패로 표시하지 않음
  }
  const books = await readBooks();
  let prev = { items: {}, misses: {} };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  if (prev.source !== SOURCE) prev = { items: {}, misses: {} }; // 출처가 바뀌면 처음부터 다시 찾기
  if (prev.version !== SCRIPT_VERSION) prev.misses = {}; // 스크립트가 바뀌면 못 찾은 책 다시 조회

  const items = {}, misses = {};
  const now = Date.now();
  let calls = 0, found = 0, kept = 0, errors = 0;
  const missList = [];

  for (const [key, book] of books) {
    if (prev.items?.[key]) { items[key] = prev.items[key]; kept++; continue; }
    const pm = prev.misses?.[key];
    if (pm && now - Date.parse(pm.checkedAt) < RETRY_MISS_DAYS * 86400000) { misses[key] = pm; continue; }
    if (calls >= MAX_CALLS) { if (pm) misses[key] = pm; continue; }
    try {
      calls++;
      const docs = await searchNl(book);
      const hit = pickMatch(book, docs);
      if (hit) { items[key] = hit; found++; }
      else {
        misses[key] = { title: book.title, pub: book.pub, reason: diagnose(book, docs), checkedAt: new Date().toISOString() };
        missList.push(`${book.title} (${book.pub || '출판사 없음'}) — ${misses[key].reason}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ! ${book.title}: ${err.name === 'AbortError' ? '시간초과' : err.message}`);
      if (pm) misses[key] = pm;
      if (errors >= 10 && found === 0 && kept === 0) { console.error('오류가 계속되어 중단합니다.'); break; }
    }
    await sleep(250);
  }

  if (errors > 0 && found === 0 && calls === errors) {
    console.error('한 건도 조회하지 못했습니다. 인증키나 접속 차단 여부를 확인해 주세요. covers.json은 바꾸지 않습니다.');
    process.exitCode = 1;
    return;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source: SOURCE,
    version: SCRIPT_VERSION,
    sourceUrl: 'https://www.nl.go.kr/seoji/',
    note: '서명이 같고 출판사(출판사가 없으면 첫 저자)가 일치하는 책만 표지를 붙였습니다.',
    items,
    misses
  };
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`책 ${books.size}권 · 표지 있음 ${Object.keys(items).length}권 (새로 찾음 ${found}, 기존 ${kept}) · 못 찾음 ${Object.keys(misses).length}권 · API 호출 ${calls}회 · 오류 ${errors}건`);
  if (missList.length) console.log('이번에 못 찾은 책:\n  ' + missList.join('\n  '));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
