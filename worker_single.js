// ================================================================
//  החברה — Worker מאוחד (קובץ אחד)
//  מדביקים את כל הקובץ הזה בעורך הקוד ב-Cloudflare ונשמרים.
//  משתני סביבה:  SITE_PASSWORD (secret) · RESEND_API_KEY (secret) · MAIL_FROM (text)
// ================================================================

// יום רביעי = 3 (0=ראשון)
function nextWednesday(from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const diff = (3 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return fmt(d);
}
function fmt(d) { return d.toISOString().slice(0, 10); }
function hebrewDate(s) {
  const [y, m, dd] = s.split('-').map(Number);
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const d = new Date(Date.UTC(y, m - 1, dd));
  return `${dd}/${m} (יום ${days[d.getUTCDay()]})`;
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
function daysUntil(s) {
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(s + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}



async function pickHost(db, dateStr) {
  const row = await db.prepare(`
    SELECT m.id FROM members m
    LEFT JOIN events e ON e.host_member_id = m.id AND e.date < ?
    WHERE m.account_id = 1 AND m.active = 1
    GROUP BY m.id
    ORDER BY COUNT(e.id) ASC, m.id ASC
    LIMIT 1`).bind(dateStr).first();
  return row ? row.id : null;
}

async function ensureNextEvent(env) {
  const db = env.DB;
  const acct = await db.prepare('SELECT * FROM accounts WHERE id=1').first();
  const today = fmt(new Date());
  let ev = await db.prepare(
    "SELECT * FROM events WHERE account_id=1 AND date >= ? AND status != 'cancelled' ORDER BY date LIMIT 1"
  ).bind(today).first();
  if (ev) return ev;

  const d = nextWednesday();
  const host = await pickHost(db, d);
  await db.prepare(
    'INSERT INTO events (account_id, date, time, host_member_id, original_time) VALUES (1,?,?,?,?)'
  ).bind(d, acct.default_time, host, acct.default_time).run();
  return await db.prepare('SELECT * FROM events WHERE account_id=1 AND date=?').bind(d).first();
}

function subject(prefix, host, ev) {
  const dateStr = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' })
    .format(new Date(ev.date + 'T00:00:00'));
  return `${prefix} "חברה" — ${dateStr} בשעה ${ev.time} אצל ${host?.name ?? 'טרם נקבע'}`;
}

function body(ev, host, pending, isFinal, reason) {
  const dateStr = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' })
    .format(new Date(ev.date + 'T00:00:00'));
  const pendList = pending && pending.length
    ? `<p style="margin:12px 0 0"><b>עוד לא אישרו:</b> ${pending.map(m => m.name).join(', ')}</p>` : '';
  return `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.8;color:#111">
    <div style="max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
      <div style="background:#1f6feb;color:#fff;padding:20px 24px">
        <div style="font-size:13px;opacity:.85">${reason || 'החברה השבועית'}</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px">${dateStr}</div>
      </div>
      <div style="padding:20px 24px">
        <p style="margin:0 0 8px"><b>שעה:</b> ${ev.time}${ev.original_time && ev.original_time !== ev.time ? ` <span style="color:#8a6100">(שונה מ־${ev.original_time})</span>` : ''}</p>
        <p style="margin:0 0 8px"><b>אצל:</b> ${host?.name ?? 'טרם נקבע'}</p>
        ${ev.location ? `<p style="margin:0 0 8px"><b>מקום:</b> ${ev.location}</p>` : ''}
        ${ev.topics ? `<p style="margin:0 0 8px"><b>נושאים:</b> ${ev.topics}</p>` : ''}
        ${pendList}
        <p style="margin:22px 0 0">
          <a href="https://chevra.workers.dev" style="background:#1f6feb;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;display:inline-block;font-weight:600">אישור הגעה באתר</a>
        </p>
        ${isFinal ? '<p style="color:#b00;margin:16px 0 0"><b>אנא אשרו עכשיו — הפגישה מחר.</b></p>' : ''}
      </div>
    </div>
  </div>`;
}

async function sendMail(env, to, subj, html) {
  if (!env.RESEND_API_KEY || !to || !to.length) return null;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'Chevra <onboarding@resend.dev>', to, subject: subj, html })
    });
    return await res.json().catch(() => null);
  } catch (e) { return null; }
}

async function sendEventReminder(env, eventId, kind = 'weekly') {
  const db = env.DB;
  const ev = await db.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first();
  if (!ev) return { ok: false };
  const members = await db.prepare('SELECT * FROM members WHERE account_id=1 AND active=1 ORDER BY id').all();
  const host = members.results.find(m => m.id === ev.host_member_id);
  const rsvps = await db.prepare('SELECT member_id FROM rsvps WHERE event_id=?').bind(ev.id).all();
  const answered = new Set(rsvps.results.map(r => r.member_id));
  const pending = members.results.filter(m => !answered.has(m.id));
  const emails = members.results.map(m => m.email).filter(Boolean);
  const subj = kind === 'time' ? `עודכן: "חברה" — ${hebrewDate(ev.date)} בשעה ${ev.time}`
    : subject(kind === 'final' ? 'מחר' : 'השבוע', host, ev);
  await sendMail(env, emails, subj, body(ev, host, pending, kind === 'final', kind === 'time' ? 'השעה עודכנה' : ''));
  return { ok: true, sent: emails.length };
}

async function runCron(env) {
  const db = env.DB;
  const acct = await db.prepare('SELECT * FROM accounts WHERE id=1').first();
  const ev = await ensureNextEvent(env);
  if (!ev) return;
  const days = daysUntil(ev.date);
  const sent = new Set(
    (await db.prepare('SELECT kind FROM reminders_log WHERE event_id=?').bind(ev.id).all())
      .results.map(r => r.kind)
  );
  if (days <= acct.reminder_days_before && days >= 0 && !sent.has('weekly')) {
    await sendEventReminder(env, ev.id, 'weekly');
    await db.prepare("INSERT OR IGNORE INTO reminders_log (event_id,kind) VALUES (?,'weekly')").bind(ev.id).run();
  }
  if (days <= 1 && days >= 0 && !sent.has('final')) {
    await sendEventReminder(env, ev.id, 'final');
    await db.prepare("INSERT OR IGNORE INTO reminders_log (event_id,kind) VALUES (?,'final')").bind(ev.id).run();
  }
}




async function api(request, env, url) {
  const db = env.DB;
  const p = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.json().catch(() => ({})) : {};
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });

  if (p === '/api/rsvp' && request.method === 'POST') {
    const cur = await db.prepare('SELECT * FROM rsvps WHERE event_id=? AND member_id=?').bind(body.event_id, body.member_id).first();
    const answer = body.answer !== undefined && body.answer !== '' ? body.answer : (cur?.answer ?? '');
    const wants = body.wants_swap !== undefined ? (body.wants_swap ? 1 : 0) : (cur?.wants_swap ?? 0);
    await db.prepare(`
      INSERT INTO rsvps (event_id, member_id, answer, wants_swap, comment) VALUES (?,?,?,?,?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET
        answer=excluded.answer, wants_swap=excluded.wants_swap,
        comment=excluded.comment, updated_at=datetime('now')
    `).bind(body.event_id, body.member_id, answer, wants, body.comment ?? cur?.comment ?? null).run();
    return json({ ok: true });
  }

  if (p === '/api/time' && request.method === 'POST') {
    const ev = await db.prepare('SELECT * FROM events WHERE id=?').bind(body.event_id).first();
    if (!ev) return json({ error: 'not found' }, 404);
    await db.prepare('UPDATE events SET time=? WHERE id=?').bind(body.time, body.event_id).run();
    if (ev.time !== body.time) await sendEventReminder(env, ev.id, 'time');
    return json({ ok: true });
  }

  if (p === '/api/host' && request.method === 'POST') {
    await db.prepare('UPDATE events SET host_member_id=? WHERE id=?').bind(body.host_member_id, body.event_id).run();
    return json({ ok: true });
  }

  if (p === '/api/topics' && request.method === 'POST') {
    await db.prepare('UPDATE events SET topics=? WHERE id=?').bind(body.topics ?? '', body.event_id).run();
    return json({ ok: true });
  }

  if (p === '/api/tx' && request.method === 'POST') {
    const { member_id, type, amount, description, date } = body;
    if (!type || !amount) return json({ error: 'missing' }, 400);
    await db.prepare('INSERT INTO transactions (account_id, member_id, type, amount, description, date) VALUES (1,?,?,?,?,?)')
      .bind(member_id || null, type, Math.abs(Number(amount)), description ?? null, date ?? new Date().toISOString().slice(0, 10)).run();
    return json({ ok: true });
  }

  if (p === '/api/tx/delete' && request.method === 'POST') {
    await db.prepare('DELETE FROM transactions WHERE id=? AND account_id=1').bind(body.id).run();
    return json({ ok: true });
  }

  if (p === '/api/member/email' && request.method === 'POST') {
    await db.prepare('UPDATE members SET email=? WHERE id=? AND account_id=1').bind(body.email || null, body.member_id).run();
    return json({ ok: true });
  }

  if (p === '/api/member/add' && request.method === 'POST') {
    if (!body.name) return json({ error: 'missing' }, 400);
    await db.prepare('INSERT INTO members (account_id, name, email) VALUES (1,?,?)').bind(body.name, body.email || null).run();
    return json({ ok: true });
  }

  if (p === '/api/remind' && request.method === 'POST') {
    const r = await sendEventReminder(env, body.event_id, 'weekly');
    return json(r);
  }

  if (p === '/api/event/next' && request.method === 'POST') {
    const d = nextWednesday();
    const host = await db.prepare(`
      SELECT m.id FROM members m
      LEFT JOIN events e ON e.host_member_id = m.id AND e.date < ?
      WHERE m.account_id=1 AND m.active=1
      GROUP BY m.id ORDER BY COUNT(e.id) ASC, m.id ASC LIMIT 1`).bind(d).first();
    const acct = await db.prepare('SELECT * FROM accounts WHERE id=1').first();
    await db.prepare('INSERT INTO events (account_id,date,time,host_member_id,original_time) VALUES (1,?,?,?,?)')
      .bind(d, acct.default_time, host?.id ?? null, acct.default_time).run();
    return json({ ok: true });
  }

  return json({ error: 'unknown endpoint' }, 404);
}


function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function layout({ members, ev, host, rsvps, tx }) {
  const rsvpMap = Object.fromEntries(rsvps.map(r => [r.member_id, r]));

  let balance = 0;
  tx.forEach(t => { balance += (t.type === 'deposit' ? 1 : -1) * Number(t.amount); });
  const totalDeposits = tx.filter(t => t.type === 'deposit').reduce((s, t) => s + Number(t.amount), 0);
  const totalExpenses = tx.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);

  const answerCount = rsvps.filter(r => r.answer === 'yes').length;
  const answered = rsvps.filter(r => r.answer).length;
  const swapRequests = rsvps.filter(r => r.wants_swap && r.answer !== 'no');
  const pending = members.filter(m => !rsvpMap[m.id]?.answer);

  const rsvpRows = members.map(m => {
    const r = rsvpMap[m.id];
    const ar = r ? r.answer : '';
    const isHost = m.id === ev.host_member_id;
    return `<div class="rsvprow">
      <div class="rleft">
        <div class="rname">${esc(m.name)}${isHost ? ' <span class="badge host">מארח</span>' : ''}</div>
        ${r && r.wants_swap && ar !== 'no' ? '<div class="swapnote">מבקש שמישהו יחליף אותו</div>' : ''}
      </div>
      <div class="btns">
        <button class="b yes ${ar==='yes'?'on':''}" onclick="rsvp(${ev.id},${m.id},'yes')">מאשר</button>
        <button class="b maybe ${ar==='maybe'?'on':''}" onclick="rsvp(${ev.id},${m.id},'maybe')">אולי</button>
        <button class="b no ${ar==='no'?'on':''}" onclick="rsvp(${ev.id},${m.id},'no')">לא יכול</button>
        ${isHost ? `<button class="b swap ${r && r.wants_swap ? 'on' : ''}" onclick="swap(${ev.id},${m.id},${r && r.wants_swap ? 0 : 1})">${r && r.wants_swap ? 'ביטול בקשת החלפה' : 'מבקש להחליף'}</button>` : ''}
      </div>
      <input class="cin" placeholder="הערה (אופציונלי)" value="${r && r.comment ? esc(r.comment) : ''}" onchange="comment(${ev.id},${m.id},this.value)">
    </div>`;
  }).join('');

  const dateStr = new Intl.DateTimeFormat('he-IL',{weekday:'long',day:'numeric',month:'numeric',year:'numeric'})
    .format(new Date(ev.date + 'T00:00:00'));

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>החברה</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f7fb;--card:#fff;--ink:#111827;--mut:#6b7280;--line:#e5e7eb;--pri:#1f6feb;--pri2:#0f4fc4}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:Heebo,system-ui,Arial,sans-serif;color:var(--ink);line-height:1.6}
.wrap{max-width:900px;margin:0 auto;padding:18px 14px 70px}
header{display:flex;align-items:center;justify-content:space-between;margin:10px 0 20px}
h1{font-size:25px;margin:0;letter-spacing:-.4px}
.sub{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card h2{font-size:15px;margin:0 0 14px;font-weight:600;color:#374151;letter-spacing:0}
.hero{background:linear-gradient(135deg,#1f6feb,#0f4fc4);color:#fff;border:none;padding:22px 22px 18px}
.hero .lbl{font-size:13px;opacity:.85}
.big{font-size:27px;font-weight:800;margin:5px 0 0;letter-spacing:-.5px}
.hero .meta{display:flex;gap:22px;flex-wrap:wrap;margin-top:16px;align-items:flex-end}
.hero .meta>div{font-size:15px}
.hero .meta b{display:block;font-size:11px;opacity:.8;font-weight:400;margin-bottom:3px}
.hero input[type=time]{border:none;border-radius:8px;padding:6px 8px;font:inherit;font-size:16px;width:108px;color:#0f4fc4;font-weight:700}
.hero select{border:none;border-radius:8px;padding:7px 9px;font:inherit;font-size:15px;color:#0f4fc4;font-weight:600;background:#fff}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle}
.badge.host{background:#eef4ff;color:#1f4fd8}
.rsvprow{display:grid;grid-template-columns:1fr auto;gap:8px 14px;padding:13px 0;border-bottom:1px solid #f1f2f5;align-items:center}
.rsvprow:last-of-type{border-bottom:none}
.rname{font-weight:600;font-size:15px}
.swapnote{font-size:12px;color:#1f4fd8;margin-top:2px}
.btns{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.b{border:1px solid var(--line);background:#fff;padding:7px 12px;border-radius:9px;font:inherit;font-size:13px;cursor:pointer;transition:.15s;white-space:nowrap}
.b:hover{background:#f3f4f6}
.b.on.yes{background:#e7f7ec;border-color:#1a7f37;color:#1a7f37;font-weight:700}
.b.on.maybe{background:#fff8e1;border-color:#c99a00;color:#8a6100;font-weight:700}
.b.on.no{background:#fdecec;border-color:#b00;color:#b00;font-weight:700}
.b.on.swap{background:#eef4ff;border-color:#1f4fd8;color:#1f4fd8;font-weight:700}
.cin{grid-column:1/-1;border:1px solid var(--line);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:#fafbfc;width:100%}
.progress{height:7px;background:#eef0f4;border-radius:99px;overflow:hidden;margin:10px 0 4px}
.progress i{display:block;height:100%;background:linear-gradient(90deg,#1f6feb,#3b82f6);border-radius:99px;transition:.3s}
.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center}
.stat div{background:#f8f9fc;border-radius:12px;padding:13px 6px}
.stat span{display:block;font-size:11px;color:var(--mut)}
.stat b{font-size:20px;display:block;margin-top:3px}
.pos{color:#1a7f37}.neg{color:#b00}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:right;font-size:11px;color:var(--mut);font-weight:600;padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:9px 6px;border-bottom:1px solid #f4f5f7;font-size:13px}
.del{background:none;border:none;color:#b00;cursor:pointer;font-size:15px;padding:0 4px;opacity:.5}
.del:hover{opacity:1}
.form{display:grid;grid-template-columns:1.1fr .9fr .7fr 1.3fr auto;gap:7px;margin-top:14px}
.form input,.form select{border:1px solid var(--line);border-radius:9px;padding:9px;font:inherit;font-size:13px;background:#fff;width:100%}
.form button{background:var(--pri);color:#fff;border:none;border-radius:9px;padding:9px 16px;font:inherit;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap}
.form button:hover{background:var(--pri2)}
.topics{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;font:inherit;font-size:14px;min-height:76px;resize:vertical;background:#fafbfc;line-height:1.7}
.topics:focus,.cin:focus{outline:none;border-color:#1f6feb;background:#fff}
.small{font-size:12px;color:var(--mut)}
.mailrow{display:grid;grid-template-columns:120px 1fr auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #f4f5f7}
.mailrow:last-child{border-bottom:none}
.mailrow input{border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;background:#fafbfc;width:100%}
.btn-line{background:#fff;border:1px solid var(--line);border-radius:9px;padding:9px 14px;font:inherit;font-size:13px;cursor:pointer;font-weight:600;color:#374151}
.btn-line:hover{background:#f3f4f6}
@media(max-width:640px){
 .form{grid-template-columns:1fr 1fr}
 .rsvprow{grid-template-columns:1fr}
 .btns{justify-content:flex-start}
 .big{font-size:23px}
 .stat{grid-template-columns:1fr 1fr}
 .mailrow{grid-template-columns:1fr;gap:4px}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><h1>החברה</h1><div class="sub">${members.length} חברים · פגישה שבועית וקופה</div></div>
    <button class="btn-line" onclick="remindNow(${ev.id})">שלח תזכורת</button>
  </header>

  <div class="card hero">
    <div class="lbl">החברה הקרובה</div>
    <div class="big">${dateStr}</div>
    <div class="meta">
      <div><b>שעה</b><input type="time" value="${ev.time}" onchange="setTime(${ev.id},this.value)"></div>
      <div><b>אצל</b>
        <select onchange="setHost(${ev.id},this.value)">
          ${members.map(m => `<option value="${m.id}" ${m.id === ev.host_member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
      </div>
      <div><b>אישורים</b>${answerCount} מתוך ${members.length}</div>
      ${ev.original_time && ev.original_time !== ev.time ? `<div><b>השעה שונתה מ־</b>${ev.original_time}</div>` : ''}
    </div>
  </div>

  <div class="card">
    <h2>אישורי הגעה</h2>
    <div class="progress"><i style="width:${members.length ? Math.round(answered / members.length * 100) : 0}%"></i></div>
    <div class="small" style="margin-bottom:6px">
      ${answered === members.length ? 'כולם ענו.' : `ענו ${answered} מתוך ${members.length}${pending.length ? ' · חסר: ' + pending.map(m => esc(m.name)).join(', ') : ''}`}
      ${swapRequests.length ? `<br>בקשות החלפה: ${swapRequests.map(r => esc(members.find(m => m.id === r.member_id)?.name)).join(', ')}` : ''}
    </div>
    ${rsvpRows}
  </div>

  <div class="card">
    <h2>נושאים לשבוע</h2>
    <textarea class="topics" placeholder="על מה נדבר השבוע..." onchange="setTopics(${ev.id},this.value)">${esc(ev.topics || '')}</textarea>
  </div>

  <div class="card">
    <h2>קופה</h2>
    <div class="stat">
      <div><span>יתרה בקופה</span><b class="${balance >= 0 ? 'pos' : 'neg'}">₪${balance.toFixed(0)}</b></div>
      <div><span>סך הפקדות</span><b>₪${totalDeposits.toFixed(0)}</b></div>
      <div><span>סך הוצאות</span><b>₪${totalExpenses.toFixed(0)}</b></div>
    </div>
    <table style="margin-top:16px">
      <thead><tr><th>תאריך</th><th>מי</th><th>סוג</th><th>סכום</th><th>תיאור</th><th></th></tr></thead>
      <tbody>
        ${tx.length ? tx.map(t => `<tr>
          <td class="small">${t.date.slice(8)}/${t.date.slice(5,7)}</td>
          <td>${esc(t.name || '—')}</td>
          <td>${t.type === 'deposit' ? '<span class="badge" style="background:#e7f7ec;color:#1a7f37">הפקדה</span>' : '<span class="badge" style="background:#fdecec;color:#b00">הוצאה</span>'}</td>
          <td style="white-space:nowrap;font-weight:600">${t.type === 'deposit' ? '+' : '−'}₪${Number(t.amount).toFixed(0)}</td>
          <td class="small">${esc(t.description || '')}</td>
          <td><button class="del" onclick="delTx(${t.id})" title="מחק">×</button></td>
        </tr>`).join('') : '<tr><td colspan="6" class="small">אין תנועות עדיין.</td></tr>'}
      </tbody>
    </table>
    <div class="form">
      <select id="txm"><option value="">הוצאה כללית</option>${members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
      <select id="txt"><option value="deposit">הפקדה</option><option value="expense">הוצאה</option></select>
      <input id="txa" type="number" placeholder="סכום" min="1" inputmode="numeric">
      <input id="txd" placeholder="תיאור">
      <button onclick="addTx()">הוסף</button>
    </div>
    <div class="small" style="margin-top:8px">להפקדה: בחר את שם מי שהביא. להוצאה כללית: בחר "הוצאה כללית".</div>
  </div>

  <div class="card">
    <h2>חברים ומיילים</h2>
    ${members.map(m => `<div class="mailrow">
      <div style="font-weight:600;font-size:14px">${esc(m.name)} ${m.role === 'admin' ? '<span class="badge" style="background:#eef4ff;color:#1f4fd8">מנהל</span>' : ''}</div>
      <input value="${esc(m.email || '')}" placeholder="הכנס כתובת מייל" onchange="setEmail(${m.id},this.value)">
      <div></div>
    </div>`).join('')}
    <div class="small" style="margin-top:10px">תזכורות נשלחות לכל חבר שיש לו מייל מוגדר.</div>
  </div>
</div>

<script>
async function post(url, data){
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) });
  if (r.status === 401) { location.reload(); return; }
  location.reload();
}
function rsvp(eid,mid,a){ post('/api/rsvp',{event_id:eid,member_id:mid,answer:a}); }
function swap(eid,mid,v){ post('/api/rsvp',{event_id:eid,member_id:mid,wants_swap:v}); }
function comment(eid,mid,c){ post('/api/rsvp',{event_id:eid,member_id:mid,comment:c}); }
function setTime(eid,t){ post('/api/time',{event_id:eid,time:t}); }
function setHost(eid,hid){ post('/api/host',{event_id:eid,host_member_id:Number(hid)}); }
function setTopics(eid,t){ post('/api/topics',{event_id:eid,topics:t}); }
function setEmail(mid,e){ post('/api/member/email',{member_id:mid,email:e}); }
function delTx(id){ if(confirm('למחוק את התנועה?')) post('/api/tx/delete',{id}); }
function remindNow(eid){ post('/api/remind',{event_id:eid}); }
function addTx(){
  const m=document.getElementById('txm').value, t=document.getElementById('txt').value,
        a=document.getElementById('txa').value, d=document.getElementById('txd').value;
  if(!a || Number(a)<=0) return;
  post('/api/tx',{member_id:m||null,type:t,amount:a,description:d});
}
</script>
</body>
</html>`;
}


const COOKIE_NAME = 'chevra_auth';

function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp(name + '=([^;]+)'));
  return m ? m[1] : null;
}

function isAuthed(request, env) {
  if (!env.SITE_PASSWORD) return true; // אם לא הוגדרה סיסמה - פתוח
  return getCookie(request, COOKIE_NAME) === env.SITE_PASSWORD;
}

function loginPage(error = false) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>כניסה</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1f6feb,#0f4fc4);font-family:Heebo,Arial,sans-serif;padding:16px}
.box{background:#fff;border-radius:20px;padding:34px 28px;width:320px;max-width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.25)}
h1{font-size:22px;margin:0 0 6px}
p{color:#6b7280;font-size:13px;margin:0 0 20px}
input{width:100%;padding:13px;border:1px solid #e5e7eb;border-radius:11px;font:inherit;text-align:center;font-size:16px}
input:focus{outline:none;border-color:#1f6feb}
button{width:100%;margin-top:12px;padding:13px;border:none;border-radius:11px;background:#1f6feb;color:#fff;font:inherit;font-weight:600;font-size:15px;cursor:pointer}
button:hover{background:#0f4fc4}
.err{color:#b00;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form class="box" method="POST" action="/login">
  <h1>החברה</h1><p>הזן סיסמה לכניסה</p>
  <input type="password" name="password" placeholder="סיסמה" autofocus>
  <button type="submit">כניסה</button>
  <div class="err">${error ? 'סיסמה שגויה' : ''}</div>
</form></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/login' && request.method === 'POST') {
      const fd = await request.formData();
      if (String(fd.get('password') || '') === env.SITE_PASSWORD) {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': `${COOKIE_NAME}=${env.SITE_PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
          }
        });
      }
      return new Response(loginPage(true), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (!isAuthed(request, env)) {
      return new Response(loginPage(false), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname.startsWith('/api/')) return api(request, env, url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const db = env.DB;
      const ev = await ensureNextEvent(env);
      const members = await db.prepare('SELECT * FROM members WHERE account_id=1 AND active=1 ORDER BY id').all();
      const host = members.results.find(m => m.id === ev.host_member_id);
      const rsvps = await db.prepare('SELECT * FROM rsvps WHERE event_id=?').bind(ev.id).all();
      const tx = await db.prepare(`
        SELECT t.*, m.name FROM transactions t
        LEFT JOIN members m ON m.id = t.member_id
        WHERE t.account_id=1 ORDER BY t.date DESC, t.id DESC LIMIT 60`).all();
      return new Response(layout({ members: members.results, ev, host, rsvps: rsvps.results, tx: tx.results }), {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};
