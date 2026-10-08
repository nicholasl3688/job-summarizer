// Turns raw page text (+ optional JobPosting structured data) into key job details.
// Pure functions, no DOM access, so it runs in the popup and in node tests.
(function (root) {
  'use strict';

  const LABEL = { hour: '/hr', year: '/yr', month: '/mo', week: '/wk' };
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const money = (n) => '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2));
  const uniq = (arr) => [...new Set(arr)];

  // ---------- pay ----------

  const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
  const PAY_SRC =
    String.raw`\$\s?` + NUM + String.raw`\s?([kK])?` +
    String.raw`(?:\s?(?:-|–|—|to)\s?\$?\s?` + NUM + String.raw`\s?([kK])?)?`;

  const CUR = String.raw`^(?:\s*(?:usd|cad)\b)?[\s/]{0,3}(?:per\s|an?\s)?`;
  const UNIT_AFTER = [
    ['hour', new RegExp(CUR + String.raw`(?:hour|hr)\b`)],
    ['year', new RegExp(CUR + String.raw`(?:year|yr|annum|annually)\b|^\s*(?:annual|yearly)`)],
    ['month', new RegExp(CUR + String.raw`(?:month|mo)\b`)],
    ['week', new RegExp(CUR + String.raw`(?:week|wk)\b`)],
  ];
  const UNIT_BEFORE = [
    ['hour', /hourly|per hour|hour(?:ly)? rate|\/\s?hr/g],
    ['year', /annual|yearly|base salary|salary range|per year|\/\s?yr/g],
  ];
  const NOISE = /bonus|signing|relocation|equipment|reimburs|tuition|401|match|allowance|referral|budget|funding|revenue|raised|valuation|million|billion|\bmm\b/;
  const PAY_CTX = /salary|pay|compensation|wage|rate|range|stipend|earn/;

  function unitAfter(after) {
    for (const [u, re] of UNIT_AFTER) if (re.test(after)) return u;
    return null;
  }

  function unitBefore(before) {
    let best = null, bestAt = -1;
    for (const [u, re] of UNIT_BEFORE) {
      let m;
      while ((m = re.exec(before))) if (m.index > bestAt) { best = u; bestAt = m.index; }
    }
    return best;
  }

  function annualize(n, unit) {
    return unit === 'hour' ? n * 2080 : unit === 'week' ? n * 52 : unit === 'month' ? n * 12 : n;
  }

  function buildPay(lo, hi, unit, source) {
    const range = hi && hi !== lo ? `${money(lo)}–${money(hi)}` : money(lo);
    const out = { text: `${range}${LABEL[unit]}`, source };
    if (unit !== 'year') {
      const a = annualize(lo, unit), b = hi ? annualize(hi, unit) : null;
      const span = b && b !== a ? `${money(Math.round(a))}–${money(Math.round(b))}` : money(Math.round(a));
      out.annual = `≈ ${span}/yr` + (unit === 'hour' ? ' at 40 hrs/wk' : '');
    }
    return out;
  }

  function findPay(text) {
    const found = [];
    const re = new RegExp(PAY_SRC, 'g');
    let m;
    while ((m = re.exec(text))) {
      let lo = num(m[1]);
      let hi = m[3] ? num(m[3]) : null;
      if (m[2]) lo *= 1000;
      if (hi !== null) {
        if (m[4]) hi *= 1000;
        if (m[4] && !m[2] && lo < 1000) lo *= 1000; // "$80-100k"
        if (hi < lo) hi = null;
      }
      const top = hi || lo;
      const end = m.index + m[0].length;
      const after = text.slice(end, end + 30).toLowerCase();
      const before = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      const near = text.slice(Math.max(0, m.index - 30), end + 30).toLowerCase();
      if (NOISE.test(near)) continue;

      let unit = unitAfter(after);
      let score = unit ? 2 : 0;
      if (!unit) unit = unitBefore(before);
      if (!unit) {
        if (top >= 10000) unit = 'year';
        else if (top <= 300 && PAY_CTX.test(before)) unit = 'hour';
        else continue;
      }
      if (unit === 'hour' && top < 7) continue;
      if (unit === 'year' && (top < 10000 || top > 1000000)) continue;
      if (hi) score += 2;
      if (PAY_CTX.test(before)) score += 1;
      found.push({ score, ...buildPay(lo, hi, unit, 'page text') });
    }
    found.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return found.filter((p) => !seen.has(p.text) && seen.add(p.text)).slice(0, 3);
  }

  function payFromLd(ld) {
    const s = ld && ld.baseSalary;
    if (!s || typeof s !== 'object') return null;
    const v = s.value && typeof s.value === 'object' ? s.value : s;
    const lo = Number(v.minValue ?? v.value);
    const hi = v.maxValue != null ? Number(v.maxValue) : null;
    const unit = { HOUR: 'hour', YEAR: 'year', MONTH: 'month', WEEK: 'week' }[String(v.unitText || '').toUpperCase()];
    if (!lo || !unit) return null;
    return buildPay(lo, hi, unit, 'structured data');
  }

  // ---------- other fields ----------

  const TYPES = [
    [/\bintern(?:ship)?\b/i, 'Internship'],
    [/\bco-?op\b/i, 'Co-op'],
    [/\bfull[- ]time\b/i, 'Full-time'],
    [/\bpart[- ]time\b/i, 'Part-time'],
    [/\bcontract(?:or)?\b/i, 'Contract'],
    [/\btemporary\b/i, 'Temporary'],
  ];

  const EDU = [
    [/\bph\.?d\b|doctorate/i, 'PhD'],
    [/master'?s|\bmba\b/i, "Master's"],
    [/bachelor'?s|\bb\.?[sa]\.?\b(?= (?:degree|in))|undergraduate degree/i, "Bachelor's"],
    [/associate'?s/i, "Associate's"],
    [/high school (?:diploma|degree)|\bged\b/i, 'High school'],
    [/currently (?:enrolled|pursuing)|rising (?:junior|senior)|current student/i, 'Current student'],
  ];

  function findExperience(text) {
    const re = /\b(\d{1,2})\s?(\+)?(?:\s?(?:-|–|to)\s?(\d{1,2})\s?(\+)?)?\s?(?:years?|yrs?)\b/gi;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const window = text.slice(m.index, m.index + 90).toLowerCase();
      if (!/experience|exp\b/.test(window)) continue;
      const a = Number(m[1]), b = m[3] ? Number(m[3]) : null;
      if (a > 15 || (b && b > 20)) continue;
      out.push(b ? `${a}–${b} yrs` : m[2] || m[4] ? `${a}+ yrs` : `${a} yrs`);
    }
    return uniq(out).slice(0, 3);
  }

  function findAuthorization(text) {
    const sents = text.split(/(?<=[.!?])\s+|\n+/).map(clean);
    const re = /sponsor|authorized to work|work authorization|legally|citizen|clearance|green card|\bvisa\b/i;
    return uniq(sents.filter((s) => s.length >= 15 && s.length <= 260 && re.test(s))).slice(0, 3);
  }

  function findDeadline(text, ld) {
    if (ld && ld.validThrough) return String(ld.validThrough).slice(0, 10);
    const m = text.match(/(?:apply by|application deadline|applications? (?:close|are due|due)|closing date|deadline|apply before)[:\s-]*([^\n.]{3,40})/i);
    return m ? clean(m[1]) : '';
  }

  const REQ_HEAD = /^(?:(?:basic|minimum|required|key)\s+)?(?:qualifications|requirements)|^what you(?:'|’)?ll need|^what we(?:'|’)?re looking for|^who you are|^you have|^must[- ]haves?|^skills(?: and| &) experience/i;
  const STOP_HEAD = /^(?:preferred|nice to have|bonus|responsibilities|what you(?:'|’)?ll do|benefits|perks|about|what we offer|compensation|salary|why |who we are|equal opportunity|how to apply|the role|the team)/i;

  function findRequirements(text) {
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    const isHeading = (l) => l.length <= 60 && !/[.;]$/.test(l);
    for (let i = 0; i < lines.length; i++) {
      if (!isHeading(lines[i]) || !REQ_HEAD.test(lines[i])) continue;
      const items = [];
      for (let j = i + 1; j < lines.length && items.length < 8; j++) {
        const l = lines[j];
        if (isHeading(l) && (STOP_HEAD.test(l) || REQ_HEAD.test(l))) break;
        if (l.length >= 8) items.push(l.length > 220 ? l.slice(0, 217) + '…' : l);
      }
      if (items.length >= 2) return items;
    }
    return [];
  }

  function jobScore(page) {
    const hits = (page.text.match(/responsibilit|qualification|requirements|apply now|job description|full-time|salary|benefits/gi) || []).length;
    return (page.selection ? 10 : 0) + (page.ld ? 5 : 0) + Math.min(hits, 8);
  }

  const orgName = (o) => (typeof o === 'string' ? o : o && o.name) || '';

  function ldLocation(ld) {
    const locs = [].concat((ld && ld.jobLocation) || []);
    return uniq(
      locs.map((l) => {
        const a = (l && l.address) || {};
        const country = typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry;
        return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ');
      }).filter(Boolean)
    );
  }

  // ---------- main ----------

  function parseJob(page) {
    const text = page.selection || page.text || '';
    const head = text.slice(0, 12000); // keep footer / "similar jobs" noise out of type detection
    const ld = page.ld || null;

    const pay = [];
    const ldPay = payFromLd(ld);
    if (ldPay) pay.push(ldPay);
    for (const p of findPay(text)) if (!pay.some((x) => x.text === p.text)) pay.push(p);

    const arrangement = [];
    if (ld && ld.jobLocationType === 'TELECOMMUTE') arrangement.push('Remote');
    if (/\bhybrid\b/i.test(head)) arrangement.push('Hybrid');
    if (/\b(?:fully remote|100% remote|remote[- ]first|work from home|remote)\b/i.test(head)) arrangement.push('Remote');
    if (/\b(?:on-?site|in[- ]office|in[- ]person)\b/i.test(head)) arrangement.push('On-site');

    const type = TYPES.filter(([re]) => re.test(head)).map(([, l]) => l);
    for (const t of [].concat((ld && ld.employmentType) || [])) {
      const label = String(t).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
      if (!type.some((x) => x.toLowerCase() === label.toLowerCase())) type.push(label);
    }

    const posted = (ld && ld.datePosted && String(ld.datePosted).slice(0, 10)) ||
      ((text.match(/posted\s+[^\n.]{1,25}?ago/i) || [''])[0]);

    return {
      scoped: !!page.selection,
      looksLikeJob: jobScore(page) >= 3,
      title: clean(ld && ld.title) || page.h1 || page.title || 'Untitled page',
      company: clean(orgName(ld && ld.hiringOrganization)) || page.site || '',
      location: ldLocation(ld),
      pay,
      type: uniq(type),
      arrangement: uniq(arrangement),
      experience: findExperience(text),
      education: EDU.filter(([re]) => re.test(text)).map(([, l]) => l),
      authorization: findAuthorization(text),
      deadline: findDeadline(text, ld),
      posted: clean(posted),
      requirements: findRequirements(text),
    };
  }

  // ---------- card (what the popup shows) ----------

  const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  function firstSentence(text) {
    const t = clean(text);
    const m = t.match(/^.+?[.!?](?=\s|$)/);
    return short(m ? m[0] : t, 220);
  }

  // field text if it has numbers, else numbers found in the description, else the raw field text ("Competitive")
  function payFor(field, desc) {
    return (field && findPay(field)[0]) || findPay(desc)[0] || (field ? { text: field, raw: true } : null);
  }

  // page comes from the injected collector in popup.js. On NU Works it carries
  // labeled `fields` read straight from the listing; elsewhere we fall back to text parsing.
  function buildCard(page) {
    if (page.nuworks) {
      const f = page.fields || {};
      const desc = page.description || '';
      const reqs = [];
      if (f['Minimum Grade Point Average']) reqs.push(`Min GPA ${f['Minimum Grade Point Average']}`);
      if (f['Degree Level']) reqs.push(`Degree level: ${f['Degree Level']}`);
      if (f['Applicant Type']) reqs.push(`Term: ${f['Applicant Type']}`);
      for (const r of findRequirements(desc).slice(0, 4)) reqs.push(short(r, 140));
      return {
        nuworks: true,
        title: page.jobTitle || page.h1,
        company: page.company,
        location: f['Location'] || '',
        pay: payFor(f['Compensation'], desc),
        tags: [f['Position Type'], f['Job Length'], f['Hours Per Week'], f['Workplace Type']]
          .filter(Boolean).map((s) => s.replace(/\s*\(.*?\)/g, '')),
        deadline: f['Application Deadline'] || '',
        status: f['Hiring Status'] || '',
        reqs,
        blurb: firstSentence(desc),
        source: desc,
      };
    }
    const source = page.selection || page.text || '';
    const r = parseJob({ text: source, title: page.title, h1: page.h1, site: page.site, selection: page.selection });
    return {
      nuworks: false,
      title: r.title,
      company: r.company,
      location: r.location.join(' | '),
      pay: r.pay[0] || null,
      tags: [...r.type, ...r.arrangement],
      deadline: r.deadline,
      status: '',
      reqs: [
        ...r.experience.map((x) => `Experience: ${x}`),
        ...r.education.map((x) => `Education: ${x}`),
        ...r.requirements.slice(0, 4).map((x) => short(x, 140)),
      ],
      blurb: '',
      source: source.slice(0, 12000),
    };
  }

  function toPlainText(c) {
    const out = [`${c.title}${c.company ? ' @ ' + c.company : ''}`];
    if (c.location) out.push(c.location);
    if (c.summary) out.push('', c.summary);
    if (c.pay) out.push('', 'Pay: ' + c.pay.text + (c.pay.annual ? ` (${c.pay.annual})` : ''));
    if (c.tags.length) out.push(c.tags.join(' · '));
    if (c.deadline) out.push('Deadline: ' + c.deadline);
    if (c.status) out.push('Hiring status: ' + c.status);
    if (c.reqs.length) out.push('', 'Requirements:', ...c.reqs.map((x) => '- ' + x));
    return out.join('\n');
  }

  const api = { parseJob, buildCard, toPlainText, jobScore, findPay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobParse = api;
})(typeof self !== 'undefined' ? self : this);
