// HANA된 책과 문화 · 추천도서 표지 찾기
// adult/index.html의 책 목록을 읽어 알라딘 OpenAPI로 표지 주소를 찾고 adult/covers.json에 저장합니다.
// 한 번 찾은 책은 다시 조회하지 않고, 못 찾은 책은 30일 뒤에 한 번 더 찾아봅니다.
//
// 실행: ALADIN_TTB_KEY=... node scripts/covers.mjs

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const PAGE = new URL('../adult/index.html', import.meta.url);
const OUT = new URL('../adult/covers.json', import.meta.url);
const TTB_KEY = (process.env.ALADIN_TTB_KEY || '').trim();
const MAX_CALLS = Number(process.env.MAX_CALLS || 1500); // 알라딘 하루 한도 5000회 안에서 넉넉히
const RETRY_MISS_DAYS = 30;

// ── 페이지와 똑같은 정규화 (adult/index.html의 norm, coverKey와 반드시 같아야 함) ──
const norm = (s) => String(s).replace(/[\s()·,.:?!\-–—『』「」]/g, '').toLowerCase();
const mainTitle = (t) => String(t).split(/\s*[:：]\s*/)[0];
const coverKey = (title, pub) => norm(mainTitle(title)) + '|' + norm(pub || '');

// 출판사 비교: 괄호 안 표기를 빼고, 한쪽이 다른 쪽을 포함하면 같은 출판사로 봅니다. (예: 롱블랙(타임앤코) ↔ 롱블랙)
const pubCore = (p) => norm(String(p || '').replace(/\([^)]*\)/g, ''));
const samePublisher = (a, b) => {
  const x = pubCore(a), y = pubCore(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y));
};
// 저자 비교(출판사가 없을 때만): 첫 저자 이름이 알라딘 저자 칸에 들어 있는지
const firstAuthor = (a) => norm(String(a || '').split(/\s*[\/·,]\s*|\s+(?:외|글|그림|지음|엮음|편)(?=\s|$|·)/)[0]);
// 알라딘 서명은 "서명 - 부제" 꼴이 많습니다.
const aladinMain = (t) => norm(String(t || '').split(/\s+-\s+/)[0].split(/\s*[:：]\s*/)[0]);

async function readBooks() {
  const html = await readFile(PAGE, 'utf8');
  const m = html.match(/const CUR = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('adult/index.html에서 CUR 목록을 찾지 못했습니다.');
  const CUR = vm.runInNewContext(`(${m[1]})`, {});
  const books = new Map();
  for (const c of CUR) {
    for (const b of c.books) {
      const [title, author, pub, year] = b;
      const key = coverKey(title, pub === '—' ? '' : pub);
      if (!books.has(key)) books.set(key, { title, author, pub: pub === '—' ? '' : pub, year: String(year || '') });
    }
  }
  return books;
}

function parseAladinJson(text) {
  let t = String(text).trim().replace(/;\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    // 알라딘 응답에 가끔 섞이는 잘못된 이스케이프(\')와 제어문자를 정리하고 다시 시도
    t = t.replace(/\\'/g, "'").replace(/[\u0000-\u001f]/g, ' ');
    return JSON.parse(t);
  }
}

async function searchAladin(title) {
  const url = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?' + new URLSearchParams({
    ttbkey: TTB_KEY,
    Query: mainTitle(title),
    QueryType: 'Title',
    MaxResults: '20',
    start: '1',
    SearchTarget: 'Book',
    Cover: 'MidBig',
    output: 'js',
    Version: '20131101'
  });
  const res = await fetch(url, { headers: { 'User-Agent': 'hana-munhwa-covers/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = parseAladinJson(await res.text());
  if (data.errorCode) throw new Error(`알라딘 오류 ${data.errorCode}: ${data.errorMessage || ''}`);
  return Array.isArray(data.item) ? data.item : [];
}

function pickMatch(book, items) {
  const want = norm(mainTitle(book.title));
  const sameTitle = items.filter((it) => aladinMain(it.title) === want);
  let matched;
  let by;
  if (book.pub) {
    matched = sameTitle.filter((it) => samePublisher(book.pub, it.publisher));
    by = '서명+출판사';
  } else {
    const fa = firstAuthor(book.author);
    matched = fa.length >= 2 ? sameTitle.filter((it) => norm(it.author).includes(fa)) : [];
    by = '서명+저자';
  }
  if (!matched.length) return null;
  // 발행 연도가 있으면 같은 해 판을 우선
  const sameYear = book.year ? matched.filter((it) => String(it.pubDate || '').startsWith(book.year)) : [];
  const best = (sameYear[0] || matched[0]);
  if (book.year && !sameYear.length) by += '(연도 다름)';
  const cover = String(best.cover || '').replace(/^http:\/\//, 'https://');
  if (!/^https:\/\/image\.aladin\.co\.kr\//.test(cover)) return null;
  return {
    cover,
    link: String(best.link || '').replace(/^http:\/\//, 'https://').replace(/&amp;/g, '&'),
    isbn13: best.isbn13 || '',
    aladinTitle: best.title || '',
    matchedBy: by
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TTB_KEY) {
    console.error('ALADIN_TTB_KEY가 없습니다. 저장소 Secrets에 등록해 주세요.');
    process.exitCode = 1;
    return;
  }
  const books = await readBooks();
  let prev = { items: {}, misses: {} };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const items = {};
  const misses = {};
  const now = Date.now();
  let calls = 0, found = 0, missed = 0, kept = 0, errors = 0;
  const missList = [];

  for (const [key, book] of books) {
    if (prev.items?.[key]) { items[key] = prev.items[key]; kept++; continue; }
    const pm = prev.misses?.[key];
    if (pm && now - Date.parse(pm.checkedAt) < RETRY_MISS_DAYS * 86400000) { misses[key] = pm; continue; }
    if (calls >= MAX_CALLS) { if (pm) misses[key] = pm; continue; }
    try {
      calls++;
      const hit = pickMatch(book, await searchAladin(book.title));
      if (hit) { items[key] = hit; found++; }
      else { misses[key] = { title: book.title, pub: book.pub, checkedAt: new Date().toISOString() }; missed++; missList.push(`${book.title} (${book.pub || '출판사 없음'})`); }
    } catch (err) {
      errors++;
      console.error(`  ! ${book.title}: ${err.message}`);
      if (/오류 (100|901)/.test(err.message)) break; // 키 오류·한도 초과면 중단
      if (pm) misses[key] = pm;
    }
    await sleep(300);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source: '알라딘 OpenAPI (www.aladin.co.kr)',
    note: '서명이 같고 출판사(출판사가 없으면 첫 저자)가 일치하는 책만 표지를 붙였습니다.',
    items,
    misses
  };
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`책 ${books.size}권 · 표지 있음 ${Object.keys(items).length}권 (새로 찾음 ${found}, 기존 ${kept}) · 못 찾음 ${Object.keys(misses).length}권 · API 호출 ${calls}회 · 오류 ${errors}건`);
  if (missList.length) console.log('이번에 못 찾은 책:\n  ' + missList.join('\n  '));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
