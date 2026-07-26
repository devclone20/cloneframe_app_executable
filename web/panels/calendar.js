  function wireCalendar(p){
    const root=p.querySelector('#calroot');
    if(!Bridge.on()){needBridge(root);return}
    const pad=n=>String(n).padStart(2,'0'),dISO=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,fmtD=d=>`${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
    const MO=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const WD=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const DOW={mon:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],sun:['Sun','Mon','Tue','Wed','Thu','Fri','Sat']};
    const today=new Date();let cur=new Date(today.getFullYear(),today.getMonth(),1),sel=new Date(today),tab='month',conn={connected:false};
    const ws=()=>Store.get().calWeekStart||'mon',calName=()=>Store.get().calName||'Personal';
    async function refresh(){try{conn=await RPC('calendar','status')}catch(e){conn={connected:false}}}
    /* ── (A) month view ── */
    async function main(){await refresh();
      root.innerHTML=`
      <div class="cal2bar">
        <button class="btn mini" id="c2prev" title="Previous month">‹</button><button class="btn mini" id="c2today">Today</button><span class="cal2mo">${MO[cur.getMonth()]} ${cur.getFullYear()}</span><button class="btn mini" id="c2next" title="Next month">›</button>
        <div class="cal2tabs">${['Week','Month','Year','Agenda'].map(t=>`<button class="cal2tab${tab===t.toLowerCase()?' on':''}" data-tab="${t.toLowerCase()}">${t}</button>`).join('')}</div>
        <button class="cal2ico" id="c2set" title="Calendar settings"><svg><use href="#i-gear"/></svg></button>
        <button class="cal2ico" id="c2sync" title="Refresh">⟳</button>
        <button class="btn mini cal2pri" id="c2new">+ New</button>
      </div>
      <div class="cal2quick"><input id="c2q" placeholder="Quick add — council on Ithaca Monday 2pm"><span class="cal2ret">↵</span></div>
      ${conn.connected?'':`<div class="cal2conn"><span class="dim">CalDAV not connected — events won't sync.</span><button class="btn mini" id="c2conn">connect CalDAV</button></div>`}
      <div class="cal2body" id="c2body"></div>
      <div class="cal2foot"><button class="cal2ico" id="c2more" title="More">…</button><div class="cal2menu" id="c2menu" hidden></div></div>`;
      root.querySelector('#c2prev').addEventListener('click',()=>{cur=new Date(cur.getFullYear(),cur.getMonth()-1,1);main()});
      root.querySelector('#c2next').addEventListener('click',()=>{cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);main()});
      root.querySelector('#c2today').addEventListener('click',()=>{cur=new Date(today.getFullYear(),today.getMonth(),1);sel=new Date(today);main()});
      root.querySelectorAll('.cal2tab').forEach(b=>b.addEventListener('click',()=>{const t=b.dataset.tab;if(t==='week'||t==='year'){Toast.show(t[0].toUpperCase()+t.slice(1)+' view — coming soon');return}tab=t;main()}));
      root.querySelector('#c2set').addEventListener('click',settings);
      root.querySelector('#c2sync').addEventListener('click',main);
      root.querySelector('#c2new').addEventListener('click',()=>composer(sel));
      const q=root.querySelector('#c2q');q.addEventListener('keydown',e=>{if(e.key==='Enter'&&q.value.trim())quickAdd(q.value.trim())});
      const cbtn=root.querySelector('#c2conn');if(cbtn)cbtn.addEventListener('click',connForm);
      const menu=root.querySelector('#c2menu');
      root.querySelector('#c2more').addEventListener('click',()=>{if(!menu.hidden){menu.hidden=true;return}
        menu.innerHTML=conn.connected?'<button class="btn mini" id="c2dis">disconnect CalDAV</button>':'<button class="btn mini" id="c2co2">connect CalDAV</button>';menu.hidden=false;
        const d=menu.querySelector('#c2dis');if(d)d.addEventListener('click',async()=>{await RPC('calendar','disconnect');Toast.show('Calendar disconnected');main()});
        const c=menu.querySelector('#c2co2');if(c)c.addEventListener('click',connForm)});
      if(tab==='agenda')agenda();else grid();}
    async function grid(){const body=root.querySelector('#c2body');
      const off=ws()==='sun'?cur.getDay():(cur.getDay()+6)%7;
      const start=new Date(cur.getFullYear(),cur.getMonth(),1-off);
      const days=[...Array(42)].map((_,i)=>new Date(start.getFullYear(),start.getMonth(),start.getDate()+i));
      let ev=[];if(conn.connected){try{ev=await RPC('calendar','events',{from:days[0].toISOString(),to:new Date(+days[41]+86400000).toISOString()})}catch(e){}}
      const byDay={};ev.forEach(e=>{const k=String(e.start||'').slice(0,10);(byDay[k]=byDay[k]||[]).push(e)});
      const tISO=dISO(today),sISO=dISO(sel);
      body.innerHTML=`<div class="cal2grid cal2dowr">${DOW[ws()].map(d=>`<div class="cal2dow">${d}</div>`).join('')}</div>
        <div class="cal2grid cal2days">${days.map(d=>{const k=dISO(d),out=d.getMonth()!==cur.getMonth(),evs=byDay[k]||[];
          return `<div class="cal2cell${out?' out':''}${!out&&k===sISO?' sel':''}"${out?'':` data-day="${k}"`}><span class="cal2num${k===tISO?' today':''}">${d.getDate()}</span>${evs.slice(0,3).map(e=>`<span class="cal2ev" title="${escAttr(e.summary||'')}">${escAttr(e.summary||'(event)')}</span>`).join('')}${evs.length>3?`<span class="cal2evmore">+${evs.length-3}</span>`:''}</div>`}).join('')}</div>`;
      body.querySelectorAll('[data-day]').forEach(c=>c.addEventListener('click',()=>{const[y,m,d]=c.dataset.day.split('-').map(Number);sel=new Date(y,m-1,d);
        body.querySelectorAll('.cal2cell.sel').forEach(x=>x.classList.remove('sel'));c.classList.add('sel')}));}
    async function agenda(){const body=root.querySelector('#c2body');
      if(!conn.connected){body.innerHTML='<div class="qempty">Connect a CalDAV calendar to see your events.</div>';return}
      let ev=[];try{ev=await RPC('calendar','upcoming',{limit:30})}catch(e){showErr(body,e);return}
      body.innerHTML=ev.length?ev.map(e=>`<div class="lprow"><div style="flex:1;min-width:0"><b>${escAttr(e.summary||'(event)')}</b><div class="dim" style="font-size:10px">${fmtTS(e.start)}${e.location?' · '+escAttr(e.location):''}</div></div><button class="btn mini" data-del="${escAttr(e.uid)}">✕</button></div>`).join(''):'<div class="qempty">No upcoming events.</div>';
      body.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',async()=>{await RPC('calendar','deleteEvent',b.dataset.del);agenda()}));}
    async function quickAdd(t){let title=t,d=new Date(sel),h=9,mi=0;
      const tm=t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)||t.match(/\b(\d{1,2}):(\d{2})\b/);
      if(tm){h=+tm[1];mi=+(tm[2]||0);const ap=(tm[3]||'').toLowerCase();if(ap==='pm'&&h<12)h+=12;if(ap==='am'&&h===12)h=0;title=title.replace(tm[0],'')}
      const dm=t.match(/\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if(dm){const w=dm[1].toLowerCase();d=new Date(today);if(w==='tomorrow')d.setDate(d.getDate()+1);else if(w!=='today'){d.setDate(d.getDate()+((WD.indexOf(w)-d.getDay()+7)%7||7))}title=title.replace(dm[0],'')}
      title=title.replace(/\b(on|at)\s*$/i,'').replace(/\s{2,}/g,' ').trim()||t;
      const start=new Date(d.getFullYear(),d.getMonth(),d.getDate(),h,mi);
      const r=await RPC('calendar','createEvent',{summary:title,start:start.toISOString(),end:new Date(+start+3600000).toISOString()});
      if(r.ok){Toast.show('Event created — '+title);main()}else Toast.show(r.error||'failed');}
    function connForm(){root.innerHTML=`<div class="acctform"><div class="afh">Connect CalDAV</div><div class="af-row"><label>URL</label><input id="cvu" placeholder="https://…/caldav/…/"></div><div class="af-row"><label>Username</label><input id="cvus"></div><div class="af-row"><label>Password</label><input id="cvp" type="password"></div><div id="cvmsg" style="font-size:10px"></div><div class="compose-actions"><button class="btn cal2pri" id="cvsave">CONNECT</button><button class="btn" id="cvback">← back</button></div></div>`;
      root.querySelector('#cvback').addEventListener('click',main);
      root.querySelector('#cvsave').addEventListener('click',async()=>{const m=root.querySelector('#cvmsg');m.textContent='connecting…';const r=await RPC('calendar','connect',{url:root.querySelector('#cvu').value.trim(),user:root.querySelector('#cvus').value.trim(),pass:root.querySelector('#cvp').value});if(r.ok){Toast.show('Calendar connected');main()}else{m.style.color='var(--accent)';m.textContent=r.error||'failed'}});}
    /* ── (B) settings ── */
    async function settings(){await refresh();const w=ws();
      root.innerHTML=`<div class="cal2set">
        <div class="cal2sethd"><button class="btn mini" id="csback">←</button><span>Calendar Settings</span></div>
        <div class="sethead">YOUR CALENDARS</div>
        ${conn.connected?`<div class="cal2calrow"><span class="cal2dot"></span><input id="csname" value="${escAttr(calName())}"><button class="btn mini" id="csdel" title="Remove calendar">✕</button></div><div class="dim" style="font-size:10px;margin-top:3px">${escAttr(conn.url||'')}</div>`:'<div class="qempty" style="padding:10px 0">No calendar connected.</div>'}
        <button class="btn mini" id="csnew" style="margin-top:8px">+ New calendar</button>
        <div class="sethead">IMPORT CALENDAR</div>
        <button class="btn mini" id="csimp">↥ Import .ics</button><div class="cal2help">Add events from an .ics file into your connected calendar.</div>
        <div class="sethead">EXPORT CALENDAR</div>
        <button class="btn mini" id="csexp">↧ ${escHtml(calName())}</button><div class="cal2help">Download the next 12 months as an .ics file.</div>
        <div class="sethead">WEEK STARTS ON</div>
        <div class="cal2tabs" style="margin:0;display:inline-flex">${[['mon','Monday'],['sun','Sunday']].map(([k,l])=>`<button class="cal2tab${w===k?' on':''}" data-ws="${k}">${l}</button>`).join('')}</div>
        <div class="sethead">SYNC</div>
        <button class="btn mini" id="cssync">⟳ Sync now</button><div class="cal2help">Live CalDAV sync also runs on every refresh. Manage connections in <a href="#" id="csint">Settings → Integrations</a>.</div>
      </div>`;
      root.querySelector('#csback').addEventListener('click',main);
      const nm=root.querySelector('#csname');if(nm)nm.addEventListener('change',()=>{Store.get().calName=nm.value.trim()||'Personal';Store.save()});
      const del=root.querySelector('#csdel');if(del)del.addEventListener('click',async()=>{await RPC('calendar','disconnect');Toast.show('Calendar removed');settings()});
      root.querySelector('#csnew').addEventListener('click',connForm);
      root.querySelector('#csimp').addEventListener('click',importIcs);
      root.querySelector('#csexp').addEventListener('click',exportIcs);
      root.querySelectorAll('[data-ws]').forEach(b=>b.addEventListener('click',()=>{Store.get().calWeekStart=b.dataset.ws;Store.save();settings()}));
      root.querySelector('#cssync').addEventListener('click',async()=>{if(!conn.connected){Toast.show('Connect a calendar first');return}const ev=await RPC('calendar','events',{});Toast.show('Synced — '+ev.length+' events')});
      root.querySelector('#csint').addEventListener('click',e=>{e.preventDefault();openPanel('integrations')});}
    function importIcs(){if(!conn.connected){Toast.show('Connect a calendar first');return}
      const f=document.createElement('input');f.type='file';f.accept='.ics,text/calendar';
      f.addEventListener('change',async()=>{const file=f.files[0];if(!file)return;const text=await file.text();
        const un=text.replace(/\r?\n[ \t]/g,''),evs=[],re=/BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;let m;
        while((m=re.exec(un))!==null){const b=m[1],g=k=>{const r=b.match(new RegExp('^'+k+'[^:\\r\\n]*:(.*)$','mi'));return r?r[1].trim():''};
          const iso=v=>{const x=v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);return x?(x[4]?`${x[1]}-${x[2]}-${x[3]}T${x[4]}:${x[5]}:${x[6]||'00'}${x[7]||''}`:`${x[1]}-${x[2]}-${x[3]}`):''};
          const ut=v=>v.replace(/\\n/gi,' ').replace(/\\([,;\\])/g,'$1');
          const st=iso(g('DTSTART'));if(!st)continue;
          evs.push({summary:ut(g('SUMMARY'))||'(imported)',start:st,end:iso(g('DTEND'))||st,location:ut(g('LOCATION'))})}
        if(!evs.length){Toast.show('No events found in file');return}
        Toast.show('Importing '+evs.length+' events…');let ok=0;
        for(const e of evs){const r=await RPC('calendar','createEvent',e);if(r.ok)ok++}
        Toast.show('Imported '+ok+'/'+evs.length+' events');settings()});
      f.click();}
    async function exportIcs(){if(!conn.connected){Toast.show('Connect a calendar first');return}
      let ev=[];try{ev=await RPC('calendar','events',{from:new Date().toISOString(),to:new Date(Date.now()+365*86400000).toISOString()})}catch(e){Toast.show('export failed');return}
      if(!ev.length){Toast.show('No events to export');return}
      const dt=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?';VALUE=DATE:'+v.replace(/-/g,''):':'+String(v).replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
      const ie=s=>String(s).replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g,x=>'\\'+x);
      const body=ev.map(e=>`BEGIN:VEVENT\r\nUID:${e.uid}\r\nDTSTART${dt(e.start||'')}\r\nDTEND${dt(e.end||e.start||'')}\r\nSUMMARY:${ie(e.summary||'')}\r\n${e.location?'LOCATION:'+ie(e.location)+'\r\n':''}END:VEVENT\r\n`).join('');
      const blob=new Blob(['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CLONE FRAME//HUB Calendar//EN\r\n'+body+'END:VCALENDAR\r\n'],{type:'text/calendar'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=calName().toLowerCase().replace(/\s+/g,'-')+'.ics';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      Toast.show('Exported '+ev.length+' events');}
    /* ── (C) new event composer ── */
    function composer(day){const now=new Date();
      const COLORS=['none','#e05252','#e8924d','#e8d24d','var(--ok)','#6fd0e8','#5a8fe8','#e87fc0','#e8836d'];
      root.innerHTML=`<div class="cal2comp">
        <div class="cal2cap">TODAY IS ${WD[now.getDay()]}, ${fmtD(now)} · ${pad(now.getHours())}:${pad(now.getMinutes())}</div>
        <div class="cal2clock" id="ceclock">09:00</div>
        <div class="cal2daylbl" id="ceday">${WD[day.getDay()]}, ${fmtD(day)}</div>
        <div class="cal2fld"><input id="cetitle" placeholder="What's happening?"><span class="cal2ret">↵</span></div>
        <div class="cal2row"><input type="date" id="cesd" value="${dISO(day)}"><span class="dim">to</span><input type="date" id="ceed" value="${dISO(day)}"><span class="dim" style="margin-left:auto">All day</span><div class="sw3" id="ceall" style="margin-left:0"><i></i></div></div>
        <div class="cal2row" id="cetimes"><input type="time" id="cest" value="09:00"><span class="dim">–</span><input type="time" id="ceet" value="10:00"></div>
        <div class="cal2fld"><input id="celoc" placeholder="Location"><span class="cal2ret">⌖</span></div>
        <div class="cal2row"><select id="cerep"><option>Does not repeat</option><option>Daily</option><option>Weekly</option><option>Monthly</option><option>Yearly</option></select></div>
        <textarea id="cedesc" class="cal2desc" placeholder="Description"></textarea>
        <div class="cal2row"><span class="dim">Reminder</span><select id="cerem"><option>15 minutes before</option><option>5 minutes before</option><option>30 minutes before</option><option>1 hour before</option><option>1 day before</option><option>None</option></select></div>
        <div class="cal2row"><span class="dim">Color</span><div class="cal2sws">${COLORS.map((c,i)=>`<button class="cal2sw${i===0?' none on':''}" data-c="${c}"${c==='none'?'':` style="background:${c}"`}></button>`).join('')}<button class="cal2sw rain" data-c="custom" title="Custom color"></button><input type="color" id="cecol" hidden></div></div>
        <div class="cal2row"><select id="cecal"><option>${escHtml(calName())}</option></select></div>
        <div class="cal2note">Repeat, description, reminder and color stay local to this HUB — CalDAV syncs title, dates, times and location.</div>
        <div class="compose-actions" style="margin-top:10px"><button class="btn" id="cecancel">✕ Cancel</button><button class="btn cal2pri" id="cecreate">＋ CREATE</button></div>
      </div>`;
      const g=id=>root.querySelector(id);
      g('#cest').addEventListener('input',()=>{g('#ceclock').textContent=g('#cest').value||'09:00'});
      g('#cesd').addEventListener('input',()=>{const[y,m,d]=g('#cesd').value.split('-').map(Number);if(y){const nd=new Date(y,m-1,d);g('#ceday').textContent=`${WD[nd.getDay()]}, ${fmtD(nd)}`;if(g('#ceed').value<g('#cesd').value)g('#ceed').value=g('#cesd').value}});
      let allDay=false;g('#ceall').addEventListener('click',()=>{allDay=!allDay;g('#ceall').classList.toggle('on',allDay);g('#cetimes').style.opacity=allDay?.35:1;g('#cest').disabled=g('#ceet').disabled=allDay});
      root.querySelectorAll('.cal2sw').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.c==='custom'){g('#cecol').click();return}root.querySelectorAll('.cal2sw').forEach(x=>x.classList.remove('on'));b.classList.add('on')}));
      g('#cecol').addEventListener('input',()=>{root.querySelectorAll('.cal2sw').forEach(x=>x.classList.remove('on'));const r=root.querySelector('.cal2sw.rain');r.classList.add('on');r.style.background=g('#cecol').value});
      g('#cecancel').addEventListener('click',main);
      async function create(){const title=g('#cetitle').value.trim();if(!title){Toast.show('Give the event a title');return}
        const sd=g('#cesd').value,ed=g('#ceed').value||sd;if(!sd){Toast.show('Pick a start date');return}
        const start=allDay?sd:`${sd}T${g('#cest').value||'09:00'}`,end=allDay?ed:`${ed}T${g('#ceet').value||'10:00'}`;
        if(g('#cerep').value!=='Does not repeat')Toast.show('Recurrence — coming soon · created as a single event');
        const r=await RPC('calendar','createEvent',{summary:title,start,end,location:g('#celoc').value.trim()});
        if(r.ok){const[y,m,d]=sd.split('-').map(Number);sel=new Date(y,m-1,d);cur=new Date(y,m-1,1);Toast.show('Event created');main()}else Toast.show(r.error||'failed');}
      g('#cecreate').addEventListener('click',create);
      g('#cetitle').addEventListener('keydown',e=>{if(e.key==='Enter')create()});}
    main();
  }
