// HANA된 문화 예술 · 데이터 수집 스크립트
// GitHub Actions가 하루 한 번 실행해 events.json을 만듭니다.
// 아래 "페이지에서 옮겨온 파서" 구간은 index.html에 있던 함수를 그대로 복사한 것입니다.
//
// 실행: KOPIS_KEY=... CULTURE_KEY=... SEOUL_KEY=... node scripts/collect.mjs

import { DOMParser } from 'linkedom';
import { readFile, writeFile } from 'node:fs/promises';

const OUTPUT_PATH = new URL('../events.json', import.meta.url);

// 인증키는 코드에 쓰지 않고 GitHub Secrets → 환경변수로 받습니다.
const KOPIS_KEY = (process.env.KOPIS_KEY || '').trim();
const CULTURE_KEY = (process.env.CULTURE_KEY || '').trim();
const SEOUL_KEY = (process.env.SEOUL_KEY || '').trim();

// 공식 API가 아닌 사이트(allgongyeon.com, 구글 뉴스 RSS)까지 긁어올지 여부.
// 이용약관 문제가 걱정되면 저장소 Variables에 ENABLE_SCRAPING=false 로 꺼 둘 수 있습니다.
const ENABLE_SCRAPING = (process.env.ENABLE_SCRAPING || 'true').toLowerCase() !== 'false';

const PALETTES = { length: 6 }; // 파서가 paletteIdx 계산에 길이만 씁니다.
const FETCH_TIMEOUT_MS = 25000;
const MAX_CONCURRENCY = 6;

// ── 네트워크: 직접 요청 → (실패 시) 프록시 순서로 "하나씩" 시도 ──────────────
// GitHub 서버에는 CORS 제한이 없어서 대부분 직접 요청으로 끝납니다.
// 일부 국내 기관 사이트는 해외 IP를 막기 때문에 그때만 프록시를 씁니다.
async function fetchOnce(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; hana-munhwa-collector/1.0; +https://hana-library.github.io/hana-munhwa/)',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 80) throw new Error(`${label} 응답이 너무 짧음`);
    if (/Access Denied|Just a moment\.\.\.|Attention Required! \| Cloudflare/i.test(text)) {
      throw new Error(`${label} 차단됨`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(targetUrl) {
  const attempts = [
    ['직접', targetUrl],
    ['allorigins', `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`],
    ['jina', `https://r.jina.ai/${targetUrl}`]
  ];
  const errors = [];
  for (const [label, url] of attempts) {
    try {
      return await fetchOnce(url, label);
    } catch (err) {
      errors.push(err.name === 'AbortError' ? `${label} 시간초과` : err.message);
    }
  }
  throw new Error(errors.join(' / '));
}

// 동시에 최대 N개만 실행 (상대 서버에 부담을 주지 않도록)
async function runLimited(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await jobs[i].run() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// ═══════════════ 페이지에서 옮겨온 파서 (index.html 원본 그대로) ═══════════════
function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysStr(baseDate, days) {
  const dt = new Date(baseDate.getTime());
  dt.setDate(dt.getDate() + days);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function parseDateMs(dateStr) {
  if (!dateStr) return Date.now();
  const clean = String(dateStr).replace(/\./g, '-').slice(0, 10);
  const parts = clean.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return Date.now();
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

function getEventStatus(ev) {
  const todayStr = getTodayStr();
  const todayMs = parseDateMs(todayStr);
  const startMs = parseDateMs(ev.startDate);
  const endMs = parseDateMs(ev.endDate || ev.startDate);

  if (todayMs > endMs) {
    return { code: 'ENDED', label: '종료', badgeClass: 'bg-slate-200 text-slate-600' };
  }
  if (todayMs < startMs) {
    const diffDays = Math.ceil((startMs - todayMs) / 86400000);
    return {
      code: 'UPCOMING',
      label: diffDays <= 14 ? `개막 D-${diffDays}` : '개막예정',
      badgeClass: 'bg-indigo-600 text-white'
    };
  }
  const leftDays = Math.ceil((endMs - todayMs) / 86400000);
  return {
    code: 'ONGOING',
    label: leftDays === 0 ? '오늘 마감' : leftDays <= 7 ? `진행중 · D-${leftDays}` : '진행중',
    badgeClass: 'bg-emerald-600 text-white'
  };
}

function formatPeriod(startDate, endDate) {
  const s = String(startDate || '').replace(/-/g, '.');
  const e = String(endDate || startDate || '').replace(/-/g, '.');
  return s === e ? s : `${s} ~ ${e}`;
}

// 제목 정제 유틸리티 (Image 1, Image 2, 배지 텍스트 제거)
function cleanEventTitle(rawTitle) {
  if (!rawTitle) return '';
  return String(rawTitle)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/^Image\s*\d+\s*[:\-]?\s*/gi, '')
    .replace(/\bImage\s*\d+\b/gi, '')
    .replace(/^(공연중|공연예정|진행중|예정|마감\s*D-\d+|오늘\s*개막|오늘\s*마감|상설|\d+위|무료)\s*/g, '')
    .replace(/\s*(공연\s*포스터|소개\s*이미지|사진)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferRegionFromText(text) {
  const t = String(text || '');
  if (/경기|수원|성남|고양|용인|부천|안산|안양|평택|시흥|파주|양주|과천|인천|의정부|하남|광명|김포|화성|경기도서관/.test(t)) return '경기·인천';
  if (/강원|춘천|원주|강릉|속초|삼척|인제|평창|동해|태백/.test(t)) return '강원';
  if (/대전|세종|충북|충남|청주|천안|공주|아산|충주|부여|보령|서산|제천|한밭도서관/.test(t)) return '충청';
  if (/광주|전북|전남|전주|여수|순천|목포|군산|익산|정읍|광양|나주|남원|무등도서관/.test(t)) return '전라';
  if (/부산|대구|울산|경북|경남|포항|경주|창원|김해|진주|통영|안동|거제|구미|양산|부산도서관/.test(t)) return '경상';
  if (/제주|서귀포|한라도서관/.test(t)) return '제주';
  return '서울';
}

function inferGenreFromText(text, urlPath = '') {
  const combined = `${text || ''} ${urlPath || ''}`;
  if (/도서관|북토크|북콘서트|강연|인문학|북큐레이션|독서|작가와의\s*만남|저자\s*특강/.test(combined)) return '도서관/강연';
  if (/\/exhibition|미술|전시|박물관|비엔날레|갤러리|아트|회화|사진|조각|소장품/.test(combined)) return '미술/전시';
  if (/클래식|서양음악|오페라|교향악|필하모닉|리사이틀|독주회|합창|콘서트|대중음악|가곡|피아노|바이올린|첼로/.test(combined)) return '클래식/음악';
  if (/무용|국악|한국음악|발레|판소리|창극|댄스|풍류/.test(combined)) return '무용/국악';
  if (/\/festival|축제|페스티벌|페스타|복합|서커스|마술/.test(combined)) return '복합/페스티벌';
  return '연극/뮤지컬';
}

function unwrapPosterUrl(rawSrc, baseUrl = 'https://www.kopis.or.kr') {
  if (!rawSrc) return '';
  let candidate = String(rawSrc).trim();
  if (!candidate) return '';
  if (candidate.startsWith('data:')) return candidate;
  try {
    const full = new URL(candidate, baseUrl);
    if (full.pathname.includes('/_next/image') && full.searchParams.get('url')) {
      candidate = decodeURIComponent(full.searchParams.get('url'));
    } else {
      candidate = full.href;
    }
  } catch (e) {
    // URL 파싱 실패 시 원본 유지
  }
  if (/logo|default|noimg|banner|sns|icon|btn|qr|favicon|ad_|banner_/i.test(candidate)) {
    return '';
  }
  return candidate;
}


function parseKopisXmlText(rawText) {
  let xmlText = String(rawText || '').trim();
  const dbsMatch = xmlText.match(/<dbs[\s\S]*?<\/dbs>/i);
  if (dbsMatch) {
    xmlText = dbsMatch[0];
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  const returnCode = xmlDoc.querySelector('returncode')?.textContent?.trim();
  const errMsg = xmlDoc.querySelector('errmsg')?.textContent?.trim();
  if (returnCode && returnCode !== '00' && returnCode !== '0') {
    throw new Error(errMsg || `KOPIS 응답 오류 (${returnCode})`);
  }

  const dbNodes = Array.from(xmlDoc.querySelectorAll('db'));
  const results = [];

  dbNodes.forEach((node, idx) => {
    const getTag = (tag) => node.querySelector(tag)?.textContent?.trim() || '';
    const mt20id = getTag('mt20id');
    const prfnm = cleanEventTitle(getTag('prfnm'));
    if (!prfnm) return;

    const startRaw = getTag('prfpdfrom').replace(/\./g, '-');
    const endRaw = getTag('prfpdto').replace(/\./g, '-') || startRaw;
    const venue = getTag('fcltynm') || '공연장';
    const poster = unwrapPosterUrl(getTag('poster'), 'https://www.kopis.or.kr');
    const area = getTag('area');
    const genrenm = getTag('genrenm');
    const id = mt20id ? `kopis-${mt20id}` : `kopis-${idx}-${prfnm.slice(0, 10)}`;

    results.push({
      id,
      title: prfnm,
      venue,
      region: inferRegionFromText(`${area} ${venue}`),
      // [수집 스크립트 수정] 공연장 이름(예: ○○도서관 공연장)이 장르를 '도서관/강연'으로 바꾸지 않도록 KOPIS 장르명과 공연명만 본다
    genre: inferGenreFromText(`${genrenm} ${prfnm}`),
      startDate: startRaw || getTodayStr(),
      endDate: endRaw || startRaw || getTodayStr(),
      price: 'KOPIS · 예매처 확인',
      cast: `KOPIS 공연예술통합전산망 (${genrenm || '공연'})`,
      desc: `${venue}에서 열리는 ${genrenm || '공연'} 작품입니다. KOPIS 공식 상세 페이지에서 회차 및 좌석 정보를 확인하실 수 있습니다.`,
      posterUrl: poster,
      sourceUrl: mt20id
        ? `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?menuId=MNU_00020&mt20Id=${encodeURIComponent(mt20id)}`
        : 'https://www.kopis.or.kr/',
      paletteIdx: idx % PALETTES.length
    });
  });

  return results;
}

function parsePublicCultureFeed(payloadText, pageUrl) {
  const items = [];
  const seenUrls = new Set();
  const isExhibition = pageUrl.includes('/exhibition');
  const isFestival = pageUrl.includes('/festival');

  const nestedRegex = /\[!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)([^\]]*)\]\((https:\/\/allgongyeon\.com\/(?:p|exhibition|festival|performance)\/[^\s)]+)\)/g;
  let match;
  let idx = 0;

  while ((match = nestedRegex.exec(payloadText)) !== null) {
    const altText = match[1] || '';
    const rawImg = match[2] || '';
    const bodyText = match[3] || '';
    const sourceUrl = match[4] || '';
    if (!sourceUrl || seenUrls.has(sourceUrl)) continue;

    const posterUrl = unwrapPosterUrl(rawImg, 'https://allgongyeon.com');
    if (!posterUrl) continue;

    const cleanCombined = `${altText} ${bodyText}`.replace(/\s+/g, ' ').trim();
    const dateMatch = cleanCombined.match(/(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})/);
    const startDate = dateMatch ? dateMatch[1].replace(/\./g, '-') : getTodayStr();
    const endDate = dateMatch ? dateMatch[2].replace(/\./g, '-') : startDate;

    let titleCandidate = cleanEventTitle(altText);
    if (!titleCandidate || titleCandidate.length < 2) {
      titleCandidate = cleanEventTitle(bodyText.split(/\d{4}\.\d{2}\.\d{2}/)[0]);
    }
    if (!titleCandidate || titleCandidate.length < 2) continue;

    const venueParts = bodyText.split('·').map((s) => s.trim());
    const venue = venueParts.length >= 2
      ? venueParts[venueParts.length - 1].replace(/\d{4}\.\d{2}\.\d{2}.*$/, '').trim() || '공식 기관 · 공연장'
      : '공식 기관 · 공연장';

    const genre = isExhibition
      ? '미술/전시'
      : isFestival
        ? '복합/페스티벌'
        : inferGenreFromText(`${titleCandidate} ${cleanCombined}`, sourceUrl);
    const region = inferRegionFromText(`${titleCandidate} ${venue} ${cleanCombined}`);
    const slug = sourceUrl.split('/').pop() || String(idx);

    seenUrls.add(sourceUrl);
    items.push({
      id: `feed-ag-${slug}`,
      title: titleCandidate,
      venue,
      region,
      genre,
      startDate,
      endDate,
      price: cleanCombined.includes('무료') ? '무료 관람' : '원본 페이지 확인',
      cast: 'KOPIS · 한국문화정보원 공공연계',
      desc: `${venue}에서 진행되는 ${genre} 프로그램입니다.`,
      posterUrl,
      sourceUrl,
      paletteIdx: idx % PALETTES.length
    });
    idx++;
  }

  if (items.length === 0 && /<a\s/i.test(payloadText)) {
    try {
      const doc = new DOMParser().parseFromString(payloadText, 'text/html');
      Array.from(doc.querySelectorAll('a[href]')).forEach((a, i) => {
        const href = a.getAttribute('href') || '';
        if (!/^\/(p|exhibition|festival|performance)\/[^/?#]+/.test(href) && !/^https:\/\/allgongyeon\.com\/(p|exhibition|festival|performance)\/[^/?#]+/.test(href)) {
          return;
        }
        const sourceUrl = new URL(href, 'https://allgongyeon.com').href;
        if (seenUrls.has(sourceUrl)) return;

        const imgEl = a.querySelector('img');
        if (!imgEl) return;
        const rawImg = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
        const posterUrl = unwrapPosterUrl(rawImg, 'https://allgongyeon.com');
        if (!posterUrl) return;

        const rawText = (a.textContent || '').replace(/\s+/g, ' ').trim();
        const dateMatch = rawText.match(/(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})/);
        const startDate = dateMatch ? dateMatch[1].replace(/\./g, '-') : getTodayStr();
        const endDate = dateMatch ? dateMatch[2].replace(/\./g, '-') : startDate;

        let titleCandidate = cleanEventTitle(imgEl.getAttribute('alt') || '');
        if (!titleCandidate || titleCandidate.length < 2) {
          titleCandidate = cleanEventTitle(rawText.split(/\d{4}\.\d{2}\.\d{2}/)[0]);
        }
        if (!titleCandidate || titleCandidate.length < 2) return;

        const venueParts = rawText.split('·').map((s) => s.trim());
        const venue = venueParts.length >= 2
          ? venueParts[venueParts.length - 1].replace(/\d{4}\.\d{2}\.\d{2}.*$/, '').trim() || '공식 기관 · 공연장'
          : '공식 기관 · 공연장';

        const genre = isExhibition
          ? '미술/전시'
          : isFestival
            ? '복합/페스티벌'
            : inferGenreFromText(`${titleCandidate} ${rawText}`, sourceUrl);
        const region = inferRegionFromText(`${titleCandidate} ${venue} ${rawText}`);
        const slug = sourceUrl.split('/').pop() || String(i);

        seenUrls.add(sourceUrl);
        items.push({
          id: `feed-ag-${slug}`,
          title: titleCandidate,
          venue,
          region,
          genre,
          startDate,
          endDate,
          price: rawText.includes('무료') ? '무료 관람' : '원본 페이지 확인',
          cast: 'KOPIS · 한국문화정보원 공공연계',
          desc: `${venue}에서 진행되는 ${genre} 프로그램입니다.`,
          posterUrl,
          sourceUrl,
          paletteIdx: i % PALETTES.length
        });
      });
    } catch (e) {
      // 무시
    }
  }

  return items;
}

function extractDatePairFromText(text) {
  const str = String(text || '');
  const m = str.match(/(202\d)[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})[\s일~부터\-]+(?:(202\d)[.\-/년\s]+)?(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (m) {
    const y1 = m[1];
    const m1 = m[2].padStart(2, '0');
    const d1 = m[3].padStart(2, '0');
    const y2 = m[4] || y1;
    const m2 = m[5].padStart(2, '0');
    const d2 = m[6].padStart(2, '0');
    return [`${y1}-${m1}-${d1}`, `${y2}-${m2}-${d2}`];
  }
  const single = str.match(/(202\d)[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (single) {
    const y1 = single[1];
    const m1 = single[2].padStart(2, '0');
    const d1 = single[3].padStart(2, '0');
    const dt = new Date(Number(y1), Number(m1) - 1, Number(d1) + 14);
    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getDate()).padStart(2, '0');
    return [`${y1}-${m1}-${d1}`, `${y2}-${m2}-${d2}`];
  }
  const md = str.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (md) {
    const year = new Date().getFullYear();
    const m1 = md[1].padStart(2, '0');
    const d1 = md[2].padStart(2, '0');
    const dt = new Date(year, Number(m1) - 1, Number(d1) + 14);
    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getDate()).padStart(2, '0');
    return [`${year}-${m1}-${d1}`, `${y2}-${m2}-${d2}`];
  }
  // [수집 스크립트 수정] 날짜를 찾지 못하면 '오늘~30일 뒤'로 지어내지 않고 빈 값으로 돌려준다 → 아래 main에서 제외
  return ['', ''];
}

function isLibraryRelatedText(text) {
  return /(도서관|북토크|북콘서트|독서|인문학|북큐레이션|저자\s*특강|작가와의\s*만남|문헌|서재|낭독|그림책|독서교실|책축제|사서)/.test(
    String(text || '')
  );
}

function isMenuNoiseTitle(title) {
  const compact = String(title || '').replace(/\s+/g, '');
  if (compact.length < 4) return true;
  return /^(로그인|회원가입|이용안내|오시는길|개인정보|사이트맵|공지사항|자주묻는질문|바로가기|더보기|메뉴|검색|자료검색|전자도서관|희망도서|대출|반납|예약|이전|다음|목록|닫기|새창열림|홈으로|전체|접수중|진행중|마감|종료|예정|상세보기|신청하기|자세히보기|프로그램안내|문화행사|도서관소개)$/.test(
    compact
  );
}

function inferLibraryVenue(text, fallbackVenue) {
  const m = String(text || '').match(/([가-힣A-Za-z0-9·]{2,20}(?:공공도서관|시립도서관|구립도서관|군립도서관|중앙도서관|어린이도서관|청소년도서관|경기도서관|서울도서관|부산도서관|충남도서관|도서관|평생학습관))/);
  return m ? m[1] : fallbackVenue;
}

function parseLibraryPortalContent(payload, portal) {
  const items = [];
  const seenTitles = new Set();
  const raw = String(payload || '');

  const pushItem = (rawTitle, href, contextText, rawImgUrl, idx) => {
    const cleanedTitle = cleanEventTitle(
      String(rawTitle || '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
        .replace(/202\d[.\-/]\d{1,2}[.\-/]\d{1,2}[\s~\-]+(?:202\d[.\-/])?\d{1,2}[.\-/]\d{1,2}/g, '')
        .replace(/\[(?:접수중|진행중|마감|예정|모집중|선착순|무료|성인|어린이|청소년|가족|초등)\]/g, '')
        .replace(/^(?:접수중|진행중|마감|예정|모집중)\s+/g, '')
    );

    if (cleanedTitle.length < 4 || cleanedTitle.length > 95) return;
    if (isMenuNoiseTitle(cleanedTitle) || seenTitles.has(cleanedTitle)) return;

    const detailUrlPattern = /(program-detail|programView|event-detail|exhibition-detail|lecture|apply|teach|view\.do|detail|N309|N305|C302|board\/view)/i;
    const hasDetailHref = detailUrlPattern.test(String(href || ''));
    const hasDateInCtx = /202\d[.\-/]\d{1,2}[.\-/]\d{1,2}/.test(String(contextText || ''));
    const hasProgramKeyword = /(강연|북토크|북콘서트|특강|전시|프로그램|독서|작가|인문학|콘서트|아카데미|교육|기획전|특별전|문화|포럼|낭독|큐레이션|토크|워크숍|클래스|상영|그림책|동화|체험|탐방|클럽|살롱|챕터|교실)/.test(
      cleanedTitle
    );

    if (!hasDetailHref && !hasDateInCtx && !hasProgramKeyword) return;

    const [startDate, endDate] = extractDatePairFromText(`${cleanedTitle} ${contextText}`);
    const posterUrl = unwrapPosterUrl(rawImgUrl, portal.url);

    let sourceUrl = portal.url;
    try {
      if (href && !href.startsWith('javascript:') && href !== '#') {
        sourceUrl = new URL(href, portal.url).href;
      }
    } catch (e) {
      sourceUrl = portal.url;
    }

    seenTitles.add(cleanedTitle);
    items.push({
      id: `lib-portal-${portal.key}-${idx}-${cleanedTitle.slice(0, 10)}`,
      title: cleanedTitle,
      venue: portal.venue,
      region: portal.region,
      genre: '도서관/강연',
      startDate,
      endDate,
      price: /유료|참가비\s*\d/.test(contextText) ? '기관 누리집 확인' : '무료 · 기관 누리집 확인',
      cast: portal.venue,
      desc: `${portal.venue} 공식 누리집에 등록된 독서·강연·전시·문화 프로그램입니다.`,
      posterUrl,
      sourceUrl,
      paletteIdx: 5
    });
  };

  // 1) 마크다운 링크 파싱 (멀티라인 카드 및 링크 외부 이미지 블록 모두 지원)
  const mdLinkRegex = /\[([\s\S]{4,280}?)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g;
  let match;
  let idx = 0;

  while ((match = mdLinkRegex.exec(raw)) !== null && idx < 45) {
    const inner = match[1];
    const href = match[2];
    const sliceBefore = raw.slice(Math.max(0, match.index - 220), match.index);
    const sliceAfter = raw.slice(match.index + match[0].length, match.index + match[0].length + 240);

    const innerImg = inner.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/);
    const beforeImgs = Array.from(sliceBefore.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g));
    const afterImg = sliceAfter.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/);
    const rawImg = innerImg
      ? innerImg[1]
      : beforeImgs.length > 0
        ? beforeImgs[beforeImgs.length - 1][1]
        : afterImg
          ? afterImg[1]
          : '';

    const lines = inner
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '\n')
      .split(/\n+/)
      .map((l) => l.replace(/^[#*\-\s]+/, '').trim())
      .filter((l) => l.length >= 4 && !/^(접수중|진행중|마감|예정|상세보기|신청하기|202\d[.\-/])/.test(l));

    const candidateTitle = lines[0] || inner.replace(/\s+/g, ' ').trim();
    pushItem(candidateTitle, href, `${sliceBefore.slice(-100)} ${inner} ${sliceAfter}`, rawImg, idx);
    idx++;
  }

  // 2) 마크다운 헤딩(### 제목) 기반 카드 파싱 (링크가 별도 버튼으로 분리된 SPA 대응)
  const headingRegex = /^#{2,4}\s+(.{5,90})$/gm;
  while ((match = headingRegex.exec(raw)) !== null && idx < 60) {
    const headingText = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    const sliceAfter = raw.slice(match.index, match.index + 320);
    const linkInBlock = sliceAfter.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/);
    const sliceBefore = raw.slice(Math.max(0, match.index - 200), match.index);
    const beforeImgs = Array.from(sliceBefore.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g));
    const rawImg = beforeImgs.length > 0 ? beforeImgs[beforeImgs.length - 1][1] : '';

    pushItem(headingText, linkInBlock ? linkInBlock[1] : portal.url, sliceAfter, rawImg, idx);
    idx++;
  }

  // 3) HTML 게시판/카드 DOM 파싱
  if (items.length < 3 && /<(a|tr|li|div|article)\s/i.test(raw)) {
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      Array.from(doc.querySelectorAll('a[href]')).forEach((a, i) => {
        if (items.length >= 45) return;
        const href = a.getAttribute('href') || '';
        const container = a.closest('li, tr, article, .card, .item, .board-item, .program-item') || a.parentElement;
        const containerText = container ? container.textContent || '' : a.textContent || '';
        const imgEl = container ? container.querySelector('img') : null;
        const rawImg = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : '';
        pushItem(a.textContent || '', href, containerText, rawImg, 100 + i);
      });
    } catch (e) {
      // 무시
    }
  }

  return items;
}
// ═══════════════ 페이지에서 옮겨온 파서 끝 ═══════════════

// ── 수집 대상 목록 (index.html의 sync 함수들에 있던 주소 그대로) ──────────────
function buildJobs() {
  const jobs = [];
  const now = new Date();

  // A. KOPIS 공연예술통합전산망
  if (KOPIS_KEY) {
    const queries = [
      { st: addDaysStr(now, 0), ed: addDaysStr(now, 30), page: 1, rows: 100 },
      { st: addDaysStr(now, 0), ed: addDaysStr(now, 30), page: 2, rows: 100 },
      { st: addDaysStr(now, 31), ed: addDaysStr(now, 60), page: 1, rows: 100 },
      { st: addDaysStr(now, 31), ed: addDaysStr(now, 60), page: 2, rows: 100 },
      { st: addDaysStr(now, 61), ed: addDaysStr(now, 90), page: 1, rows: 100 },
      { st: addDaysStr(now, 91), ed: addDaysStr(now, 120), page: 1, rows: 100 },
      { st: addDaysStr(now, 121), ed: addDaysStr(now, 150), page: 1, rows: 100 }
    ];
    queries.forEach((q) => {
      jobs.push({
        source: 'KOPIS',
        name: `KOPIS ${q.st}~${q.ed} p${q.page}`,
        run: async () => {
          const url = `http://www.kopis.or.kr/openApi/restful/pblprfr?service=${encodeURIComponent(KOPIS_KEY)}&stdate=${q.st}&eddate=${q.ed}&cpage=${q.page}&rows=${q.rows}`;
          return parseKopisXmlText(await fetchText(url));
        }
      });
    });
  }

  // B. 서울 열린데이터광장 culturalEventInfo (도서관 관련만)
  if (SEOUL_KEY) {
    [[1, 300], [301, 600], [601, 900]].forEach(([startIdx, endIdx], rIdx) => {
      jobs.push({
        source: '서울 열린데이터',
        name: `서울 문화행사 ${startIdx}-${endIdx}`,
        run: async () => {
          const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(SEOUL_KEY)}/json/culturalEventInfo/${startIdx}/${endIdx}/`;
          const data = JSON.parse(await fetchText(url));
          const rows = data?.culturalEventInfo?.row || [];
          const collected = [];
          rows.forEach((row, idx) => {
            const title = cleanEventTitle(row.TITLE || '');
            const place = String(row.PLACE || row.ORG_NAME || '').trim();
            const codename = String(row.CODENAME || '').trim();
            const program = String(row.PROGRAM || '').trim();
            if (!title || !isLibraryRelatedText(`${title} ${place} ${codename} ${program}`)) return;
            const sRaw = String(row.STRTDATE || row.DATE || '').slice(0, 10);
            const eRaw = String(row.END_DATE || sRaw).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(sRaw)) return;
            collected.push({
              id: `seoul-lib-${rIdx}-${idx}-${title.slice(0, 10)}`,
              title,
              venue: place || '서울 공공도서관',
              region: '서울',
              genre: '도서관/강연',
              startDate: sRaw,
              endDate: /^\d{4}-\d{2}-\d{2}$/.test(eRaw) ? eRaw : sRaw,
              price: row.USE_FEE || (row.IS_FREE === '무료' ? '무료' : '기관 누리집 확인'),
              cast: row.ORG_NAME || place || '서울특별시 도서관',
              desc: program || row.ETC_DESC || `${place}에서 진행되는 도서관 독서·강연 프로그램입니다.`,
              posterUrl: unwrapPosterUrl(row.MAIN_IMG || '', 'https://culture.seoul.go.kr'),
              sourceUrl: row.ORG_LINK || row.HMPG_ADDR || 'https://lib.seoul.go.kr/',
              paletteIdx: 5
            });
          });
          return collected;
        }
      });
    });
  }

  // C. 공공데이터포털 · 문화포털 (도서관 관련만)
  if (CULTURE_KEY) {
    const fromYmd = addDaysStr(now, 0);
    const toYmd = addDaysStr(now, 60);
    const encKey = encodeURIComponent(CULTURE_KEY);
    const cultureUrls = [
      `https://apis.data.go.kr/B553457/nopenapi/rest/publicperformancedisplays/period?serviceKey=${encKey}&from=${fromYmd}&to=${toYmd}&PageNo=1&numOfRows=100`,
      `https://apis.data.go.kr/B553457/nopenapi/rest/publicperformancedisplays/period?serviceKey=${encKey}&from=${fromYmd}&to=${toYmd}&PageNo=2&numOfRows=100`,
      `https://apis.data.go.kr/B553457/nopenapi/rest/publicperformancedisplays/period?serviceKey=${encKey}&from=${fromYmd}&to=${toYmd}&PageNo=3&numOfRows=100`,
      `https://api.kcisa.kr/openapi/CNV_060/request?serviceKey=${encKey}&numOfRows=150&pageNo=1`,
      `https://api.kcisa.kr/openapi/CNV_060/request?serviceKey=${encKey}&numOfRows=150&pageNo=2`,
      `https://api.kcisa.kr/openapi/CNV_060/request?serviceKey=${encKey}&numOfRows=150&pageNo=3`,
      `https://api.kcisa.kr/openapi/API_CIA_089/request?serviceKey=${encKey}&numOfRows=150&pageNo=1`
    ];
    cultureUrls.forEach((cUrl, uIdx) => {
      jobs.push({
        source: '공공데이터포털·문화포털',
        name: `문화 API #${uIdx + 1}`,
        run: async () => {
          const doc = new DOMParser().parseFromString(await fetchText(cUrl), 'text/xml');
          const nodes = Array.from(doc.querySelectorAll('perforList, item'));
          const collected = [];
          nodes.forEach((node, idx) => {
            const getTag = (t) => node.querySelector(t)?.textContent?.trim() || '';
            const title = cleanEventTitle(getTag('title'));
            const place = getTag('place') || getTag('cntrctInsttNm') || getTag('spatialCoverage') || '';
            const realm = getTag('realmName') || getTag('subjectCategory') || '';
            if (!title || !isLibraryRelatedText(`${title} ${place} ${realm}`)) return;
            const sDigits = (getTag('startDate') || getTag('period')).replace(/[^0-9]/g, '');
            const eDigits = (getTag('endDate') || sDigits).replace(/[^0-9]/g, '');
            if (sDigits.length < 8) return;
            const startDate = `${sDigits.slice(0, 4)}-${sDigits.slice(4, 6)}-${sDigits.slice(6, 8)}`;
            const endDate = eDigits.length >= 16
              ? `${eDigits.slice(8, 12)}-${eDigits.slice(12, 14)}-${eDigits.slice(14, 16)}`
              : eDigits.length >= 8
                ? `${eDigits.slice(0, 4)}-${eDigits.slice(4, 6)}-${eDigits.slice(6, 8)}`
                : startDate;
            collected.push({
              id: `kcisa-lib-${uIdx}-${idx}-${title.slice(0, 10)}`,
              title,
              venue: place || '전국 공공도서관',
              region: inferRegionFromText(`${getTag('area')} ${place} ${title}`),
              genre: '도서관/강연',
              startDate,
              endDate,
              price: getTag('price') || getTag('charge') || '기관 누리집 확인',
              cast: place || '공공데이터포털 연계 기관',
              desc: getTag('description') || `${place}에서 진행되는 도서관 강연·전시·문화 프로그램입니다.`,
              posterUrl: unwrapPosterUrl(getTag('thumbnail') || getTag('referenceIdentifier'), 'https://www.culture.go.kr'),
              sourceUrl: getTag('url') || 'https://www.culture.go.kr/',
              paletteIdx: 5
            });
          });
          return collected;
        }
      });
    });
  }

  // D. 공공도서관 누리집 직접 수집
  const libraryPortals = [
    { key: 'ggl-p1', url: 'https://www.library.kr/ggl/community/events/program-list', venue: '경기도서관 (수원 광교)', region: '경기·인천' },
    { key: 'ggl-p2', url: 'https://www.library.kr/ggl/community/events/program-list?page=2', venue: '경기도서관 (수원 광교)', region: '경기·인천' },
    { key: 'ggl-p3', url: 'https://www.library.kr/ggl/community/events/program-list?page=3', venue: '경기도서관 (수원 광교)', region: '경기·인천' },
    { key: 'ggl-pi2', url: 'https://www.library.kr/ggl/community/events/program-list?pageIndex=2', venue: '경기도서관 (수원 광교)', region: '경기·인천' },
    { key: 'ggl-exhi', url: 'https://www.library.kr/ggl/community/events/exhibition-list', venue: '경기도서관 전시실 (수원 광교)', region: '경기·인천' },
    { key: 'ggl-event', url: 'https://www.library.kr/ggl/community/events/event-list', venue: '경기도서관 (수원 광교)', region: '경기·인천' },
    { key: 'nl-lecture', url: 'https://www.nl.go.kr/NL/contents/N30902000000.do', venue: '국립중앙도서관 (서울 서초)', region: '서울' },
    { key: 'nl-exhi', url: 'https://www.nl.go.kr/NL/contents/N30502000000.do', venue: '국립중앙도서관 전시실', region: '서울' },
    { key: 'seoul-lib', url: 'https://lib.seoul.go.kr/lecture/applyList', venue: '서울도서관 (서울 중구)', region: '서울' },
    { key: 'nlcy-lib', url: 'https://www.nlcy.go.kr/NLCY/contents/C30201000000.do', venue: '국립어린이청소년도서관 (서울 강남)', region: '서울' },
    { key: 'sejong-nl', url: 'https://sejong.nl.go.kr/', venue: '국립세종도서관', region: '충청' },
    { key: 'suwon-lib', url: 'https://www.suwonlib.go.kr/', venue: '수원시도서관', region: '경기·인천' },
    { key: 'goyang-lib', url: 'https://www.goyanglib.or.kr/', venue: '고양시도서관센터', region: '경기·인천' },
    { key: 'yongin-lib', url: 'https://lib.yongin.go.kr/', venue: '용인시도서관', region: '경기·인천' },
    { key: 'pt-lib', url: 'https://www.ptlib.go.kr/', venue: '평택시립도서관', region: '경기·인천' },
    { key: 'busan-lib', url: 'https://library.busan.go.kr/busanlibrary/module/teach/index.do?menu_idx=15', venue: '부산도서관 (부산 사상구)', region: '경상' },
    { key: 'daegu-lib', url: 'https://library.daegu.go.kr/jungang/module/teach/index.do?menu_idx=15', venue: '대구광역시립중앙도서관', region: '경상' },
    { key: 'jeonju-lib', url: 'https://lib.jeonju.go.kr/', venue: '전주시립도서관', region: '전라' }
  ];
  libraryPortals.forEach((portal) => {
    jobs.push({
      source: '도서관 누리집',
      name: portal.venue + (portal.key.match(/-p\d|-pi\d/) ? ` (${portal.key})` : ''),
      run: async () => parseLibraryPortalContent(await fetchText(portal.url), portal)
    });
  });

  if (ENABLE_SCRAPING) {
    // E. allgongyeon.com (공식 API 아님)
    [
      'https://allgongyeon.com/',
      'https://allgongyeon.com/performance',
      'https://allgongyeon.com/exhibition',
      'https://allgongyeon.com/festival',
      'https://allgongyeon.com/area/seoul',
      'https://allgongyeon.com/area/gyeonggi',
      'https://allgongyeon.com/area/busan',
      'https://allgongyeon.com/area/daegu',
      'https://allgongyeon.com/area/incheon',
      'https://allgongyeon.com/area/gwangju',
      'https://allgongyeon.com/area/daejeon',
      'https://allgongyeon.com/area/jeju'
    ].forEach((pageUrl) => {
      jobs.push({
        source: 'allgongyeon',
        name: pageUrl.replace('https://', ''),
        run: async () => parsePublicCultureFeed(await fetchText(pageUrl), pageUrl)
      });
    });

    // F. 구글 뉴스 RSS (공식 API 아님)
    [
      '경기도서관 프로그램 OR 강연 OR 북토크 OR 전시',
      '수원 OR 성남 OR 고양 OR 용인 OR 평택 도서관 강연 OR 북토크',
      '부천 OR 안산 OR 화성 OR 파주 OR 인천 도서관 강연 OR 북토크',
      '국립중앙도서관 OR 서울도서관 강연 OR 북토크 OR 전시',
      '서울 구립도서관 OR 정독도서관 OR 마포중앙도서관 강연 북토크',
      '국립세종도서관 OR 대전한밭도서관 OR 청주 도서관 강연 북토크',
      '부산도서관 OR 대구중앙도서관 OR 울산도서관 강연 북토크',
      '경남 OR 경북 도서관 강연 OR 북토크 OR 독서문화',
      '광주무등도서관 OR 전주시립도서관 OR 순천 도서관 강연 북토크',
      '춘천시립도서관 OR 원주 OR 제주 한라도서관 강연 북토크'
    ].forEach((q, qIdx) => {
      jobs.push({
        source: '구글 뉴스 RSS',
        name: `RSS #${qIdx + 1}`,
        run: async () => {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
          const doc = new DOMParser().parseFromString(await fetchText(rssUrl), 'text/xml');
          const items = Array.from(doc.querySelectorAll('item')).slice(0, 15);
          const collected = [];
          items.forEach((item, idx) => {
            const rawTitle = (item.querySelector('title')?.textContent || '').replace(/\s*-\s*[^-]+$/, '').trim();
            const title = cleanEventTitle(rawTitle);
            const link = item.querySelector('link')?.textContent?.trim() || '';
            const descRaw = (item.querySelector('description')?.textContent || '').replace(/<[^>]+>/g, ' ').trim();
            const pubDateStr = item.querySelector('pubDate')?.textContent?.trim() || '';
            if (title.length < 6 || !isLibraryRelatedText(`${title} ${descRaw}`)) return;
            if (pubDateStr) {
              const pubMs = Date.parse(pubDateStr);
              if (!Number.isNaN(pubMs)) {
                const diffDays = Math.floor((Date.now() - pubMs) / 86400000);
                if (diffDays > 35 || diffDays < -2) return;
              }
            }
            const combined = `${title} ${descRaw}`;
            const [startDate, endDate] = extractDatePairFromText(combined);
            const venue = inferLibraryVenue(combined, '전국 공공도서관');
            collected.push({
              id: `lib-rss-${qIdx}-${idx}-${title.slice(0, 10)}`,
              title,
              venue,
              region: inferRegionFromText(combined),
              genre: '도서관/강연',
              startDate,
              endDate,
              price: '무료 · 해당 도서관 누리집 확인',
              cast: venue,
              desc: descRaw || `${venue}에서 진행되는 독서·강연·문화 프로그램입니다.`,
              posterUrl: '',
              sourceUrl: link || 'https://www.library.kr/',
              paletteIdx: 5
            });
          });
          return collected;
        }
      });
    });
  }

  return jobs;
}

// ── 합치기: 중복 제거 + 종료된 행사 제거 + 실패한 출처는 지난번 데이터 유지 ──────
const dedupeKey = (e) => `${String(e.title).replace(/\s+/g, '')}|${String(e.venue || '').replace(/\s+/g, '').slice(0, 12)}`;

async function readPrevious() {
  try {
    const data = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
    return Array.isArray(data) ? data : Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

async function main() {
  const startedAt = Date.now();
  const jobs = buildJobs();
  console.log(`수집 대상 ${jobs.length}곳 (공식 API 키: KOPIS ${KOPIS_KEY ? 'O' : 'X'}, 문화 ${CULTURE_KEY ? 'O' : 'X'}, 서울 ${SEOUL_KEY ? 'O' : 'X'}, 비공식 사이트 ${ENABLE_SCRAPING ? '켬' : '끔'})`);

  const settled = await runLimited(jobs, MAX_CONCURRENCY);
  const today = getTodayStr();
  const fresh = [];
  const failedSources = new Set();
  const okSources = new Set();
  const report = [];

  settled.forEach((res, i) => {
    const job = jobs[i];
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      okSources.add(job.source);
      fresh.push(...res.value.map((ev) => ({ ...ev, _source: job.source })));
      report.push(`  ✓ ${job.name}: ${res.value.length}건`);
    } else {
      failedSources.add(job.source);
      report.push(`  ✗ ${job.name}: ${res.reason?.message || res.reason}`);
    }
  });
  console.log(report.join('\n'));

  // 이번에 한 건도 못 가져온 출처는 지난번 데이터를 그대로 이어서 씁니다.
  const previous = await readPrevious();
  const carried = previous.filter((ev) => ev._source && !okSources.has(ev._source));

  const dropped = { noDate: 0, ended: 0, pastYear: 0 };
  const thisYear = Number(today.slice(0, 4));
  const byId = new Set();
  const byKey = new Set();
  const events = [];
  for (const ev of [...fresh, ...carried]) {
    if (!ev || !ev.title) continue;
    if (!ev.startDate) { dropped.noDate++; continue; } // 원문에서 날짜를 찾지 못한 항목 제외(날짜를 지어내지 않음)
    if ((ev.endDate || ev.startDate) < today) { dropped.ended++; continue; } // 이미 끝난 행사 제외
    const years = (String(ev.title).match(/20\d{2}/g) || []).map(Number);
    if (years.length && Math.max(...years) < thisYear) { dropped.pastYear++; continue; } // 제목에 지난 연도만 있는 행사(예: 2024 독서대전) 제외
    const key = dedupeKey(ev);
    if (byId.has(ev.id) || byKey.has(key)) continue;
    byId.add(ev.id);
    byKey.add(key);
    events.push(ev);
  }

  // 수집이 전부 실패했으면 기존 파일을 덮어쓰지 않습니다.
  if (fresh.length === 0 && previous.length > 0) {
    console.error('새로 가져온 데이터가 없어 기존 events.json을 유지합니다.');
    process.exitCode = 1;
    return;
  }

  const sourceCounts = {};
  events.forEach((ev) => { sourceCounts[ev._source || '기타'] = (sourceCounts[ev._source || '기타'] || 0) + 1; });

  const output = {
    updatedAt: new Date().toISOString(),
    count: events.length,
    sources: sourceCounts,
    events
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 0) + '\n', 'utf8');
  console.log(`events.json 저장: ${events.length}건 (이어 쓴 지난 데이터 ${carried.length}건, ${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
  console.log('출처별:', sourceCounts);
  console.log(`제외: 날짜 없음 ${dropped.noDate}건 · 종료 ${dropped.ended}건 · 지난 연도 제목 ${dropped.pastYear}건`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
