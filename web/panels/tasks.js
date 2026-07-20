  function wireTasks(p){
    const card=p.querySelector('#tkcard'),foot=p.querySelector('#tkfoot'),cnt=p.querySelector('#tkcount'),tabs=[...p.querySelectorAll('.tktab')];
    let tab='tasks',tasks=[],cat='all',q='',mode='recent',sel=new Set(),acat='all',aq='',menuId=null;
    const ICO={email:'#i-mail',research:'#i-cosmos',memory:'#i-chip',calendar:'#i-cosmos',chats:'#i-agent',documents:'#i-frame',skills:'#i-lab'};
    const ico=c=>ICO[c]||'#i-bolt';
    const rel=relTime; // kernel relTime (T-046) — single-sourced s/m/h/d/w/y
    function clock(){const d=new Date();foot.textContent=d.toLocaleDateString('en-GB',{weekday:'long'})+', '+d.toLocaleDateString('en-GB')+' · '+d.toLocaleTimeString('en-GB',{hour12:false}).replace(/:/g,'.')}
    clock();const ck=setInterval(()=>{if(!document.body.contains(p)){clearInterval(ck);return}clock()},1000);
    function go(t){tab=t;tabs.forEach(b=>b.classList.toggle('on',b.dataset.tab===t));show()}
    tabs.forEach(b=>b.addEventListener('click',()=>go(b.dataset.tab)));
    async function loadTasks(){try{tasks=await RPC('tasks','list');cnt.textContent=tasks.length;return true}catch(e){showErr(card,e);return false}}
    function show(){if(!Bridge.on()){needBridge(card);return}if(tab==='tasks')tTasks();else if(tab==='activity')tActivity();else tAdd()}
    async function tTasks(){
      if(!await loadTasks())return;
      let pausedAll=false;try{pausedAll=await RPC('tasks','isPausedAll')}catch(e){}
      const c={all:tasks.length};tasks.forEach(t=>c[t.category]=(c[t.category]||0)+1);
      card.innerHTML=`<div class="tksec"><div><b>Ongoing Tasks</b> <span class="badge">${tasks.length} tasks</span><div class="tksub">Scheduled prompts and actions that run automatically. Results appear in a dedicated session.</div></div><button class="btn mini" id="tkpauseall">${pausedAll?'▶ Resume all':'⏸ Pause all'}</button></div>
        <div class="tkctl"><div class="tkseg"><button class="tksegb ${mode==='recent'?'on':''}" data-m="recent">Recent</button><button class="tksegb ${mode==='select'?'on':''}" data-m="select">Select</button></div><div class="tksearch"><span>⌕</span><input id="tkq" placeholder="Search tasks…" value="${escAttr(q)}"></div></div>
        <div class="tkchips">${Object.entries(c).map(([k,n])=>`<span class="tkchip ${k===cat?'on':''}" data-c="${escAttr(k)}">${escAttr(k)} (${n})</span>`).join('')}</div>
        ${mode==='select'?`<div class="tkbulk"><span>${sel.size} selected</span><button class="btn mini" id="tkbp">⏸ pause</button><button class="btn mini" id="tkbr">▶ resume</button><button class="btn mini" id="tkbd">✕ delete</button></div>`:''}
        <div class="tklist" id="tklist"></div>`;
      card.querySelector('#tkpauseall').addEventListener('click',async()=>{try{await RPC('tasks','pauseAll',!pausedAll);Toast.show(!pausedAll?'All tasks paused':'Resumed')}catch(e){Toast.show(e.message)}tTasks()});
      card.querySelectorAll('.tksegb').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.m;if(mode==='recent')sel.clear();tTasks()}));
      card.querySelector('#tkq').addEventListener('input',e=>{q=e.target.value;list()});
      card.querySelectorAll('.tkchip').forEach(el=>el.addEventListener('click',()=>{cat=el.dataset.c;tTasks()}));
      if(mode==='select'){
        card.querySelector('#tkbp').addEventListener('click',()=>bulk('paused'));
        card.querySelector('#tkbr').addEventListener('click',()=>bulk('running'));
        card.querySelector('#tkbd').addEventListener('click',async()=>{for(const id of sel){const t=tasks.find(x=>x.id===id);if(t&&!t.isBuiltin)try{await RPC('tasks','remove',id)}catch(e){}}sel.clear();Toast.show('Deleted (built-ins kept)');tTasks()});
      }
      list();
    }
    async function bulk(st){for(const id of sel){try{await RPC('tasks','setState',id,st)}catch(e){}}Toast.show(st==='paused'?'Selected paused':'Selected resumed');tTasks()}
    function list(){
      const el=card.querySelector('#tklist');if(!el)return;
      const ql=q.trim().toLowerCase();
      const L=tasks.filter(t=>(cat==='all'||t.category===cat)&&(!ql||t.name.toLowerCase().includes(ql)));
      el.innerHTML=L.map(t=>`<div class="tkrow">
        ${mode==='select'?`<input type="checkbox" class="tksel" data-sel="${t.id}"${sel.has(t.id)?' checked':''}>`:''}
        <svg class="tkico"><use href="${ico(t.category)}"/></svg>
        <div class="tkinfo"><div class="tkname">${escHtml(t.name)} ${t.isBuiltin?'<span class="badge">BUILT-IN</span>':''}</div><div class="tkmeta">Cron: <code>${escHtml(t.cron)}</code>${t.nextRunAt?' · next '+fmtTS(t.nextRunAt):''}${t.lastRunAt?' · last '+fmtTS(t.lastRunAt):''}</div></div>
        <button class="tkstbadge ${t.state==='running'?'active':'paused'}" data-st="${t.id}" title="${t.state==='running'?'click to pause':'click to resume'}">${t.state==='running'?'⏸ ACTIVE':'▶ PAUSED'}</button>
        <button class="btn mini" data-run="${t.id}" title="run now"><svg class="tkbico"><use href="#i-bolt"/></svg>RUN</button>
        <button class="btn mini tkmore" data-menu="${t.id}">⋮</button></div>
        ${menuId===t.id?`<div class="tkmenu"><button class="btn mini" data-log="${t.id}">run log · session</button>${t.isBuiltin?'':`<button class="btn mini" data-rm="${t.id}">✕ delete</button>`}</div>`:''}`).join('')||'<div class="qempty">no tasks match</div>';
      el.querySelectorAll('[data-sel]').forEach(cb=>cb.addEventListener('change',()=>{cb.checked?sel.add(cb.dataset.sel):sel.delete(cb.dataset.sel);const n=card.querySelector('.tkbulk span');if(n)n.textContent=sel.size+' selected'}));
      el.querySelectorAll('[data-st]').forEach(b=>b.addEventListener('click',async()=>{const t=tasks.find(x=>x.id===b.dataset.st);try{await RPC('tasks','setState',t.id,t.state==='running'?'paused':'running')}catch(e){Toast.show(e.message)}tTasks()}));
      el.querySelectorAll('[data-run]').forEach(b=>b.addEventListener('click',async()=>{b.textContent='…';try{const r=await RPC('tasks','runNow',b.dataset.run);Toast.show('run: '+((r.run&&r.run.status)||'ok'))}catch(e){Toast.show(e.message)}tTasks()}));
      el.querySelectorAll('[data-menu]').forEach(b=>b.addEventListener('click',()=>{menuId=menuId===b.dataset.menu?null:b.dataset.menu;list()}));
      el.querySelectorAll('[data-log]').forEach(b=>b.addEventListener('click',()=>taskLog(b.dataset.log)));
      el.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{try{await RPC('tasks','remove',b.dataset.rm)}catch(e){Toast.show(e.message)}menuId=null;tTasks()}));
    }
    async function taskLog(id){
      let runs=[],sess=[];try{runs=await RPC('tasks','activity',id,{limit:20})}catch(e){}try{sess=await RPC('tasks','session',id)}catch(e){}
      card.innerHTML='<div class="tkact"><button class="btn mini" id="tkback">← back</button><h4>Run log</h4>'+
        (runs.length?runs.map(r=>`<div class="tkrun ${escAttr(r.status)}"><b>${escAttr(r.status)}</b> · ${fmtTS(r.startedAt)} — ${escAttr(r.summary||r.error||'')}</div>`).join(''):'<div class="qempty">no runs yet</div>')+
        (sess&&sess.length?'<h4 style="margin-top:12px">Dedicated session</h4>'+sess.slice(-15).map(s=>`<div class="tksess"><span class="dim">${fmtTS(s.ts)}</span> ${escHtml(String(s.text||'').slice(0,400))}</div>`).join(''):'')+'</div>';
      card.querySelector('#tkback').addEventListener('click',show);
    }
    async function tActivity(){
      if(!await loadTasks())return;
      card.innerHTML=`<div class="tksec"><div><b>Activity</b><div class="tksub">Recent task runs across all scheduled tasks.</div></div><button class="btn mini" id="tkref" title="refresh">↻</button></div>
        <div class="tksearch"><span>⌕</span><input id="tkaq" placeholder="Filter activity…" value="${escAttr(aq)}"></div>
        <div class="tkchips" id="tkachips"></div>
        <div class="tklist" id="tkalist"><div class="qempty">loading…</div></div>`;
      card.querySelector('#tkref').addEventListener('click',tActivity);
      let runs=[];
      await Promise.all(tasks.map(async t=>{try{(await RPC('tasks','activity',t.id,{limit:20})).forEach(r=>runs.push({...r,t}))}catch(e){}}));
      runs.sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt));runs=runs.slice(0,60);
      const cats=['all',...new Set(runs.map(r=>r.t.category))];
      function paint(){
        const chips=card.querySelector('#tkachips'),listEl=card.querySelector('#tkalist');if(!chips||!listEl)return;
        chips.innerHTML=cats.map(k=>`<span class="tkchip ${k===acat?'on':''}" data-c="${escAttr(k)}">${escAttr(k)}</span>`).join('');
        chips.querySelectorAll('.tkchip').forEach(el=>el.addEventListener('click',()=>{acat=el.dataset.c;paint()}));
        const ql=aq.trim().toLowerCase();
        const L=runs.filter(r=>(acat==='all'||r.t.category===acat)&&(!ql||r.t.name.toLowerCase().includes(ql)||String(r.summary||'').toLowerCase().includes(ql)));
        listEl.innerHTML=L.map(r=>`<div class="tkarow"><i class="tkdot ${escAttr(r.status)}"></i><svg class="tkico"><use href="${ico(r.t.category)}"/></svg><div class="tkainfo"><b>${escAttr(r.t.name)}</b><span class="tkasum">${escAttr(r.summary||r.error||r.status)}</span></div><span class="tkago">${rel(r.startedAt)}</span></div>`).join('')||'<div class="qempty">no runs yet — enable a task or hit RUN in the Tasks tab</div>';
      }
      card.querySelector('#tkaq').addEventListener('input',e=>{aq=e.target.value;paint()});
      paint();
    }
    const TYPES=[
      ['Prompt on schedule','Run a prompt daily, weekly, etc.','#i-bolt','prompt'],
      ['Prompt on event','Trigger every N sessions or messages','#i-agent',''],
      ['Research on schedule','Run deep research on a topic','#i-cosmos','research'],
      ['Research on event','Run deep research after app events','#i-cosmos',''],
      ['Action on schedule','Run tidy/cleanup on a timer','#i-gear','action'],
      ['Action on event','Run tidy/cleanup every N sessions or messages','#i-gear',''],
      ['Webhook triggered','Trigger via external HTTP call','#i-frame','']];
    function tAdd(){
      card.innerHTML=`<div class="tksec"><div><b>Add Task</b><div class="tksub">Describe a task for the AI to draft, or pick a type below to set one up manually.</div></div></div>
        <div class="tkdraft"><div class="tksearch"><span>⌕</span><input id="tkdq" placeholder='Describe a task — e.g. "every weekday 7am summarize my unread email"'></div><button class="btn mini" id="tkdraftgo">+ Draft with AI</button></div>
        <div class="tklist">${TYPES.map((c,i)=>`<div class="tktcard" data-t="${i}"><svg class="tkico"><use href="${c[2]}"/></svg><div><b>${c[0]}</b><div class="tksub2">${c[1]}</div></div></div>`).join('')}</div>`;
      card.querySelector('#tkdraftgo').addEventListener('click',draft);
      card.querySelector('#tkdq').addEventListener('keydown',e=>{if(e.key==='Enter')draft()});
      card.querySelectorAll('.tktcard').forEach(el=>el.addEventListener('click',()=>{
        const t=TYPES[+el.dataset.t];
        if(t[3]==='prompt')openForm({title:'Prompt on schedule',cron:'0 7 * * *'});
        else if(t[3]==='research')openForm({title:'Research on schedule',category:'research',cron:'0 9 * * 1'});
        else if(t[3]==='action')Toast.show('Action tasks are built-in — enable Email Summary/Tags in the Tasks tab');
        else Toast.show(t[0]+' — coming soon');
      }));
    }
    async function draft(){
      const inp=card.querySelector('#tkdq'),b=card.querySelector('#tkdraftgo');
      const txt=(inp&&inp.value.trim())||'';
      if(!txt){Toast.show('Describe the task first');return}
      b.textContent='drafting…';
      try{const r=await RPC('tasks','draft',txt);if(r&&r.ok){Toast.show('Task drafted by AI');go('tasks');return}}catch(e){}
      openForm({title:'Prompt on schedule (drafted)',name:txt.slice(0,60),category:'custom',cron:'0 7 * * 1-5',prompt:txt});
    }
    function openForm(f={}){
      card.innerHTML=`<div class="acctform"><div class="afh">${escHtml(f.title||'New scheduled task')}</div>
        <div class="af-row"><label>Name</label><input id="tkn" value="${escAttr(f.name||'')}"></div>
        <div class="af-row"><label>Category</label><input id="tkc" value="${escAttr(f.category||'custom')}"></div>
        <div class="af-row"><label>Cron</label><input id="tkcr" value="${escAttr(f.cron||'0 */6 * * *')}"></div>
        <div class="af-row"><label>Prompt</label><input id="tkp" value="${escAttr(f.prompt||'')}" placeholder="what the agent should do"></div>
        <div class="compose-actions"><button class="btn" id="tksave">CREATE</button><button class="btn" id="tkcancel">CANCEL</button></div></div>`;
      const v=id=>card.querySelector('#'+id).value.trim();
      card.querySelector('#tksave').addEventListener('click',async()=>{
        try{const r=await RPC('tasks','add',{name:v('tkn')||'Task',category:v('tkc')||'custom',cron:v('tkcr'),action:'custom',prompt:v('tkp')});
        if(r.ok){Toast.show('Task created — starts paused');go('tasks')}else Toast.show(r.error||'failed')}catch(e){Toast.show(e.message)}});
      card.querySelector('#tkcancel').addEventListener('click',show);
    }
    panelBus(p).on('bridge:changed',()=>{show()});
    show();
  }
