  async function wireHarness(p){
    const listEl=p.querySelector('#hnlist'),detEl=p.querySelector('#hndetail');
    if(!Bridge.on()){listEl.innerHTML='';needBridge(detEl);return}
    let harnesses=[],sel=null,pendingOpen=null;
    // the Harness Engine spine — the template a custom crew starts from
    const ENGINE_ROLES=[
      {name:'ORCHESTRATOR',desc:'head · delegates · moderates the crew',gate:false},
      {name:'SAFETY / HACKER',desc:'security veto · fail-closed',gate:true},
      {name:'EVALUATOR',desc:'quality gate',gate:true},
      {name:'TREASURY',desc:'funds gate · spending caps',gate:true},
      {name:'OWNER',desc:'human approval — you',gate:true},
      {name:'RESEARCH',desc:'specialist agent (research)',gate:false},
      {name:'DELIVERY',desc:'specialist agent (execution)',gate:false},
    ];
    const changed=()=>Bus.emit('harness:changed');
    async function load(){try{harnesses=await RPC('harness','list')}catch(e){showErr(detEl,e);return}sel=harnesses.find(h=>sel&&h.id===sel.id)||sel||harnesses[0];renderList();if(!applyPending())renderDetail()}
    function applyPending(){
      if(!pendingOpen||!harnesses.length)return false;
      const d=pendingOpen;pendingOpen=null;
      if(d.id==='__new__'){addForm();return true}
      sel=harnesses.find(h=>h.id===d.id)||sel;renderList();
      if(d.edit&&sel){sel.isBuiltin?duplicateAndEdit(sel):editForm(sel)}else renderDetail();
      return true;
    }
    function renderList(){
      listEl.innerHTML='<div class="hnhead">HARNESSES<button class="btn mini" id="hnadd">＋ New</button></div>'+harnesses.map(h=>`<div class="hnitem ${sel&&h.id===sel.id?'on':''}" data-id="${h.id}"><b>${escHtml(h.name)}</b>${h.activeForTerminal?' <span class="badge sent">terminal</span>':''}<div class="dim" style="font-size:10px">${escHtml(h.kind||'')} · ${(h.roles||[]).length} agent${(h.roles||[]).length===1?'':'s'}</div></div>`).join('');
      listEl.querySelectorAll('.hnitem').forEach(el=>el.addEventListener('click',()=>{sel=harnesses.find(h=>h.id===el.dataset.id);renderList();renderDetail()}));
      listEl.querySelector('#hnadd').addEventListener('click',()=>addForm());
    }
    function renderDetail(){
      if(!sel){detEl.innerHTML='<div class="qempty">No harness.</div>';return}
      detEl.innerHTML=`<div class="hntitle">${escHtml(sel.name)} ${sel.isBuiltin?'<span class="badge">built-in</span>':''}</div><div class="dim" style="font-size:10px;margin:2px 0 10px">${escHtml(sel.description||'')}</div>
        <div class="hnroles">${(sel.roles||[]).map(r=>`<div class="hnrole ${r.gate?'gate':''}"><b>${escHtml(r.name)}</b><span>${escHtml(r.desc||'')}</span>${r.gate?'<span class="hngate">GATE</span>':'<span class="hngate spec">agent</span>'}</div>`).join('')||'<div class="qempty" style="padding:10px">No agents yet — click Edit crew to build the team.</div>'}</div>
        <div class="dim" style="font-size:10px;margin:9px 2px">Non-collapsible gates: ${(sel.gates||[]).join(' · ')||'—'}</div>
        <div class="btnrow"><button class="btn" id="hnuse">${sel.activeForTerminal?'✓ IN TERMINAL':'USE IN TERMINAL'}</button><button class="btn" id="hnedit">${sel.isBuiltin?'⎘ Duplicate & edit':'✎ Edit crew'}</button>${sel.isBuiltin?'':'<button class="btn" id="hndel">remove</button>'}</div>`;
      detEl.querySelector('#hnuse').addEventListener('click',async()=>{const on=!sel.activeForTerminal;await RPC('harness','setActiveForTerminal',sel.id,on);Toast.show(on?'Harness active in CODE — pick it in the composer':'Removed from CODE');changed();await load()});
      detEl.querySelector('#hnedit').addEventListener('click',()=>{sel.isBuiltin?duplicateAndEdit(sel):editForm(sel)});
      detEl.querySelector('#hndel')?.addEventListener('click',async()=>{await RPC('harness','remove',sel.id);sel=null;changed();load()});
    }
    async function duplicateAndEdit(src){const r=await RPC('harness','duplicate',src.id,src.name+' (my copy)');if(r&&r.ok){await load();sel=harnesses.find(h=>h.id===r.id);changed();editForm(sel);Toast.show('Editable copy created')}else Toast.show((r&&r.error)||'failed')}
    function addForm(){editForm(null)}
    // full crew editor: name/type/description + the agent team (add/remove/edit roles, GATE toggle)
    function editForm(h){
      const draft={id:h?h.id:null,name:h?h.name:'',kind:h?(h.kind||'custom'):'custom',description:h?(h.description||''):'',roles:JSON.parse(JSON.stringify((h&&h.roles)||[]))};
      const roleRows=()=>draft.roles.map((r,i)=>`<div class="hnedit-row"><input class="hnr-n" data-i="${i}" value="${escAttr(r.name||'')}" placeholder="Agent / role"><input class="hnr-d" data-i="${i}" value="${escAttr(r.desc||'')}" placeholder="what it does"><button class="hnr-g ${r.gate?'on':''}" data-i="${i}" title="Gate = non-collapsible checkpoint (can veto / must approve)">GATE</button><button class="hnr-x" data-i="${i}" title="Remove">✕</button></div>`).join('');
      function paint(){
        detEl.innerHTML=`<div class="acctform"><div class="afh">${draft.id?'Edit harness':'New harness'}</div>
          <div class="af-row"><label>Name</label><input id="hnn" value="${escAttr(draft.name)}"></div>
          <div class="af-row"><label>Type</label><input id="hnk" value="${escAttr(draft.kind)}"></div>
          <div class="af-row"><label>Description</label><input id="hnd" value="${escAttr(draft.description)}"></div>
          <div class="hnhead" style="padding:10px 0 5px">AGENT TEAM<button class="btn mini" id="hnaddrole">＋ Add agent</button></div>
          <div class="hnedit-list">${roleRows()||'<div class="dim" style="font-size:10px;padding:4px 2px">No agents yet — add them, or load the Harness Engine crew below.</div>'}</div>
          <div class="dim" style="font-size:10px;margin:7px 2px 11px">Flag an agent as <b>GATE</b> to make it a non-collapsible checkpoint (like SAFETY / OWNER) — nothing irreversible passes without it.</div>
          <div class="compose-actions"><button class="btn acc" id="hnsave">${draft.id?'SAVE':'CREATE'}</button><button class="btn" id="hnengine" title="Start from the Harness Engine spine">⚙ Harness Engine crew</button><button class="btn" id="hncancel">← back</button></div></div>`;
        detEl.querySelector('#hnn').addEventListener('input',e=>draft.name=e.target.value);
        detEl.querySelector('#hnk').addEventListener('input',e=>draft.kind=e.target.value);
        detEl.querySelector('#hnd').addEventListener('input',e=>draft.description=e.target.value);
        detEl.querySelectorAll('.hnr-n').forEach(el=>el.addEventListener('input',e=>{draft.roles[+e.target.dataset.i].name=e.target.value}));
        detEl.querySelectorAll('.hnr-d').forEach(el=>el.addEventListener('input',e=>{draft.roles[+e.target.dataset.i].desc=e.target.value}));
        detEl.querySelectorAll('.hnr-g').forEach(el=>el.addEventListener('click',()=>{const i=+el.dataset.i;draft.roles[i].gate=!draft.roles[i].gate;paint()}));
        detEl.querySelectorAll('.hnr-x').forEach(el=>el.addEventListener('click',()=>{draft.roles.splice(+el.dataset.i,1);paint()}));
        detEl.querySelector('#hnaddrole').addEventListener('click',()=>{draft.roles.push({name:'',desc:'',gate:false});paint()});
        detEl.querySelector('#hnengine').addEventListener('click',()=>{draft.roles=JSON.parse(JSON.stringify(ENGINE_ROLES));paint();Toast.show('Loaded the Harness Engine crew — edit it to taste')});
        detEl.querySelector('#hncancel').addEventListener('click',()=>{if(draft.id)sel=harnesses.find(x=>x.id===draft.id)||sel;renderDetail()});
        detEl.querySelector('#hnsave').addEventListener('click',save);
      }
      async function save(){
        const name=(draft.name||'').trim();if(!name){Toast.show('Give it a name');return}
        const roles=draft.roles.map(r=>({name:(r.name||'').trim(),desc:(r.desc||'').trim(),gate:!!r.gate,collapsible:!r.gate})).filter(r=>r.name);
        const payload={name,kind:(draft.kind||'custom').trim(),description:(draft.description||'').trim(),roles};
        const r=draft.id?await RPC('harness','update',draft.id,payload):await RPC('harness','add',payload);
        if(r&&r.ok){Toast.show(draft.id?'Saved':'Harness created');changed();await load();sel=harnesses.find(x=>x.id===(draft.id||r.id))||sel;renderDetail()}
        else Toast.show((r&&r.error)||'name required');
      }
      paint();
    }
    panelBus(p).on('harness:open',d=>{pendingOpen=d;applyPending()});
    load();
  }

  Bus.on('open-panel',d=>{
    d=d||{};const type=d.type;if(!type)return;
    const cwd=d.cwd||'',url=d.url||'',key=d.key||'';
    // A square linked to a LIVE window is that window's handle: restore it if docked,
    // just focus it if it's already on screen. Never a copy, never someone else's window.
    if(key&&open[key]){
      const p=open[key];
      if(p.dataset.docked){
        delete p.dataset.docked;p.style.display='';focus(p);
        if(typeof p._onundock==='function')try{p._onundock()}catch(_){}
      }else focus(p);
      return;
    }
    if(MULTI.has(type)){
      // Launcher square (post-reload, popped tab, + menu): open its OWN new window and
      // link it to the square so later clicks focus/restore THIS window.
      let p=null;
      if(type==='shell'){if(cwd)pendingShellCwd=cwd;p=openPanel('shell',{newInstance:true})}
      else{p=openPanel(type,{newInstance:true});if(type==='research'&&url&&p)Bus.emit('web:open',{url,target:p.dataset.key||''})}
      if(p&&d.cell)d.cell.dataset.panelKey=p.dataset.key;
      return;
    }
    // BUG-L2-004 Part 2: a singleton reopened from its frame tile brings the window back,
    // so the launcher tile has served its purpose — release the source cell (no orphan tile).
    if(d.cell&&typeof Grid!=='undefined'&&Grid.release)Grid.release(d.cell);
    openPanel(type);
  });
  // Removing a square that holds a hidden docked window closes that window for real
  // (dispose hook reaps its pty sessions) — a tile ✕ must never leak an invisible panel.
  Bus.on('cell:removed',pk=>{const p=open[pk];if(p&&p.dataset.docked)close(p)});
  // T-060 — the whole panel set registers here, at the end of IIFE init (before any openPanel can
  // fire): openPanel dispatches every mount through the registry and the legacy wireX if-ladder is
  // gone. def = the DEFS entry (unchanged), mount = the same wireX the if-ladder used, so behaviour
  // is byte-identical; the win is one data-driven table instead of a 26-branch ladder. Adding a panel
  // is now one registerPanel line — the seam every web/panels/* module will self-register through.
  registerPanel('terminal',{def:DEFS.terminal,mount:wireTerminal});
  registerPanel('settings',{def:DEFS.settings,mount:wireSettings});
  registerPanel('theme',{def:DEFS.theme,mount:wireTheme});
  registerPanel('lab',{def:DEFS.lab,mount:wireLab});
  registerPanel('agentview',{def:DEFS.agentview,mount:wireAgentView});
  registerPanel('shell',{def:DEFS.shell,mount:wireShell});
  registerPanel('matrix',{def:DEFS.matrix,mount:wireMatrix});
  registerPanel('folders',{def:DEFS.folders,mount:wireFolders});
  registerPanel('machine',{def:DEFS.machine,mount:wireMachine});
  registerPanel('harness',{def:DEFS.harness,mount:wireHarness});
  registerPanel('agents',{def:DEFS.agents,mount:wireAgents});
  registerPanel('automations',{def:DEFS.automations,mount:wireAutomations});
  registerPanel('email',{def:DEFS.email,mount:wireEmail});
  registerPanel('tasks',{def:DEFS.tasks,mount:wireTasks});
  registerPanel('approval',{def:DEFS.approval,mount:wireApproval});
  registerPanel('contacts',{def:DEFS.contacts,mount:wireContacts});
  registerPanel('integrations',{def:DEFS.integrations,mount:wireIntegrations});
  registerPanel('notes',{def:DEFS.notes,mount:wireNotes});
  registerPanel('library',{def:DEFS.library,mount:wireLibrary});
  registerPanel('cookbook',{def:DEFS.cookbook,mount:wireCookbook});
  registerPanel('research',{def:DEFS.research,mount:wireWebBrowser});
  registerPanel('gallery',{def:DEFS.gallery,mount:wireGallery});
  registerPanel('compare',{def:DEFS.compare,mount:wireCompare});
  registerPanel('calendar',{def:DEFS.calendar,mount:wireCalendar});
  registerPanel('reminders',{def:DEFS.reminders,mount:wireReminders});
  registerPanel('brain',{def:DEFS.brain,mount:wireBrain});
  registerPanel('search',{def:DEFS.search,mount:wireSearch});
  return{openPanel,registerPanel,has:(t)=>REG.has(t)||!!DEFS[t],catalog:()=>Object.keys(DEFS).map(k=>({key:k,title:DEFS[k].title||k,sub:DEFS[k].sub||''})),layer,top:()=>topPanel};
})();

/* ---------- Snap ---------- */
const Snap=(()=>{
  const ghost=document.getElementById('snapghost');
  const EDGE=38;
  let zone=null;
  function geo(z){
    const lr=Panels.layer.getBoundingClientRect();
    if(z==='left') return{l:lr.left+8,t:lr.top+8,w:lr.width/2-12,h:lr.height-16};
    if(z==='right')return{l:lr.left+lr.width/2+4,t:lr.top+8,w:lr.width/2-12,h:lr.height-16};
    if(z==='max')  return{l:lr.left+8,t:lr.top+8,w:lr.width-16,h:lr.height-16};
    return null;
  }
  function probe(x,y){
    const lr=Panels.layer.getBoundingClientRect();
    let znew=null;
    if(x<lr.left+EDGE)znew='left';
    else if(x>lr.right-EDGE)znew='right';
    else if(y<lr.top+EDGE)znew='max';
    if(znew!==zone){
      zone=znew;
      if(zone){const g=geo(zone);Object.assign(ghost.style,{display:'block',left:g.l+'px',top:g.t+'px',width:g.w+'px',height:g.h+'px'})}
      else ghost.style.display='none';
    }
  }
  function syncBtn(p){
    const b=p.querySelector('.pbtns .f');if(!b)return;
    const snapped=!!p.dataset.snapped;
    b.textContent=snapped?'⤡':'⤢';b.title=snapped?'Restore':'Maximize';
  }
  function apply(p,z){
    const lr=Panels.layer.getBoundingClientRect();
    if(!p.dataset.snapped)p.dataset.restore=JSON.stringify({w:p.offsetWidth,h:p.offsetHeight,l:parseFloat(p.style.left)||12,t:parseFloat(p.style.top)||12});
    const g=geo(z);if(!g)return;
    p.classList.add('snapping');
    Object.assign(p.style,{left:(g.l-lr.left)+'px',top:(g.t-lr.top)+'px',width:g.w+'px',height:g.h+'px'});
    p.dataset.snapped=z;
    setTimeout(()=>p.classList.remove('snapping'),320);
    syncBtn(p);
  }
  function restore(p){
    if(!p.dataset.snapped)return;
    const m=JSON.parse(p.dataset.restore||'{}');
    p.classList.add('snapping');
    if(m.w){Object.assign(p.style,{width:m.w+'px',height:m.h+'px',left:(m.l??12)+'px',top:(m.t??12)+'px'})}
    delete p.dataset.snapped;
    setTimeout(()=>p.classList.remove('snapping'),320);
    syncBtn(p);
  }
  function commit(p){ghost.style.display='none';if(zone){apply(p,zone);zone=null}}
  return{probe,commit,apply,restore,sync:syncBtn};
})();

/* ---------- Tri: the morphological red mark — menu of EVERYTHING + navigation ---------- */
const Tri=(()=>{
  const el=document.getElementById('tri'),fly=document.getElementById('triflyout'),
        shape=document.getElementById('trishape'),menuEl=document.getElementById('flymenu');
  let flyOpen=false;
  // ---- morphology: triangle → square → circle (red, small) every 30s ----
  const SHAPES=['M20 6 34 33 6 33 Z','M7 7 33 7 33 33 7 33 Z','M6 20 A14 14 0 1 0 34 20 A14 14 0 1 0 6 20 Z'];
  let shapeIdx=0;
  function morph(){
    shapeIdx=(shapeIdx+1)%SHAPES.length;
    const svg=el.querySelector('svg');
    if(REDUCED){shape.setAttribute('d',SHAPES[shapeIdx]);return}
    svg.style.transform='scale(.45) rotate(-120deg)';svg.style.opacity='.35';
    setTimeout(()=>{shape.setAttribute('d',SHAPES[shapeIdx]);svg.style.transform='';svg.style.opacity='1'},175);
  }
  setInterval(morph,30000);
  // ---- menu of EVERYTHING (MENU is a shared top-level const, defined above the Grid module) ----
  function buildMenu(){
    // DOCK — present only while the owner has stashed the whole dock here (dragged it
    // onto the ▲). Drag the entry back to the workspace (or click it) to bring it back;
    // it never returns on its own.
    const stashed=!!((Store.get().wdock||{}).stashed);
    const dockHtml=stashed?('<div class="flygrp">DOCK</div>'+
      '<button class="flyitem flydock" title="Drag it back to the workspace — or click to restore"><svg><use href="#i-frame"/></svg>Dock — drag it back out</button>'):'';
    menuEl.innerHTML=dockHtml+MENU.map(([grp,items])=>`<div class="flygrp">${grp}</div>`+items.map(([type,label,icon])=>{
      const soon=type[0]!=='_'&&!Panels.has(type);
      return `<button class="flyitem${soon?' soon':''}" data-type="${type}"><svg><use href="${icon}"/></svg>${label}${soon?'<span class="badge">soon</span>':''}</button>`;
    }).join('')).join('');
    // drop the "more below" fade once the reader has actually reached the end
    const fade=()=>menuEl.classList.toggle('atend',menuEl.scrollTop+menuEl.clientHeight>=menuEl.scrollHeight-4);
    if(!menuEl._fadeWired){menuEl._fadeWired=true;menuEl.addEventListener('scroll',fade,{passive:true})}
    fade();
    const fd=menuEl.querySelector('.flydock');
    if(fd)fd.addEventListener('pointerdown',e=>{
      e.preventDefault();e.stopPropagation();
      const sx=e.clientX,sy=e.clientY;let ghost=null;
      const mm=ev=>{
        if(!ghost&&Math.hypot(ev.clientX-sx,ev.clientY-sy)<6)return;
        if(!ghost){ghost=document.createElement('div');ghost.className='flydock-ghost';ghost.textContent='DOCK';document.body.appendChild(ghost)}
        ghost.style.left=(ev.clientX-24)+'px';ghost.style.top=(ev.clientY-14)+'px';
      };
      const mu=ev=>{
        removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);
        if(ghost){
          ghost.remove();
          const fb=fly.getBoundingClientRect();
          const outside=ev.clientX<fb.left||ev.clientX>fb.right||ev.clientY<fb.top||ev.clientY>fb.bottom;
          if(outside){toggleFly(false);Bus.emit('wdock:unstash',{x:ev.clientX-30,y:ev.clientY-16});return}
          buildMenu();return; // dropped back inside the menu — stays stashed
        }
        toggleFly(false);Bus.emit('wdock:unstash',{}); // plain click also brings it back
      };
      addEventListener('pointermove',mm);addEventListener('pointerup',mu);
    });
    menuEl.querySelectorAll('.flyitem:not(.flydock)').forEach(b=>b.addEventListener('click',()=>{
      const t=b.dataset.type;toggleFly(false);
      if(t==='__search'){openSearch();return}
      if(t==='__theme'){Panels.openPanel('theme');return}
      if(t==='__wallet'){WalletAuth.addr()?Toast.show('Active session: '+WalletAuth.short(WalletAuth.addr())):PrivyLogin.open();return}
      Panels.openPanel(t);
    }));
  }
  Bus.on('wdock:changed',()=>{if(flyOpen)buildMenu()});
  function openSearch(){
    if(Bridge.on()&&Panels.has('search')){Panels.openPanel('search');return}
    const p=document.getElementById('pal');if(p){p.style.display='block';const i=document.getElementById('palinput');if(i){i.value='';setTimeout(()=>i.focus(),30)}}
    else Toast.show('⌘K to search');
  }
  function place(){
    const p=Store.get().tri||{x:16,y:innerHeight-104};
    p.x=Math.max(4,Math.min(innerWidth-44,p.x));p.y=Math.max(56,Math.min(innerHeight-46,p.y));
    el.style.left=p.x+'px';el.style.top=p.y+'px';
    if(flyOpen)placeFly();
  }
  function placeFly(){
    const b=el.getBoundingClientRect();
    fly.classList.add('open');
    let x=b.left,y=b.top-fly.offsetHeight-10;
    if(y<58)y=Math.min(b.bottom+10,innerHeight-fly.offsetHeight-8);
    x=Math.max(8,Math.min(innerWidth-fly.offsetWidth-8,x));
    fly.style.left=x+'px';fly.style.top=Math.max(8,y)+'px';
  }
  function toggleFly(force){
    flyOpen=force!==undefined?force:!flyOpen;
    if(flyOpen){buildMenu();placeFly()}else fly.classList.remove('open');
  }
  el.addEventListener('pointerdown',e=>{
    e.preventDefault();e.stopPropagation();
    const sx=e.clientX,sy=e.clientY;
    const p0=Object.assign({x:16,y:innerHeight-104},Store.get().tri);
    let moved=false;
    const mm=ev=>{
      if(!moved&&Math.hypot(ev.clientX-sx,ev.clientY-sy)<6)return;
      moved=true;toggleFly(false);
      Store.get().tri={x:p0.x+ev.clientX-sx,y:p0.y+ev.clientY-sy};
      place();
    };
    const mu=()=>{
      removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);
      if(moved)Store.save();else toggleFly();
    };
    addEventListener('pointermove',mm);addEventListener('pointerup',mu);
  });
  document.getElementById('fly-settings').addEventListener('click',e=>{e.stopPropagation();toggleFly(false);Bus.emit('themes:open')});
  function syncLock(){const on=Camera.isNav();const b=document.getElementById('t-lock');b.classList.toggle('on',on);document.getElementById('t-lock-label').textContent=on?'Zoom ON — lock':'Navigate universe'}
  document.getElementById('t-lock').addEventListener('click',()=>{
    const on=!Camera.isNav();Camera.setNav(on);if(on)Cosmos.prewarm();syncLock();
    Toast.show(on?'NAVIGATION MODE — wheel to zoom · drag to move':'Zoom locked — build mode');
  });
  // t-fit = "the FIT button in the menu": click = fit view · drag onto the canvas = place/restore FIT
  (()=>{const tf=document.getElementById('t-fit');
    // click = fit view · drag onto the canvas = place/restore the FIT reticle at the drop point (T-045)
    dragGesture(tf,{threshold:5,preventDefault:true,
      ghost:()=>{const g=document.createElement('div');g.className='fitghost';g.innerHTML='<svg><use href="#i-fit"/></svg>FIT';return g},
      onDrop:(e,d)=>{Reframe.restore(d.x,d.y);toggleFly(false);Toast.show('FIT placed — drag it anywhere, or onto the triangle to park it')},
      onTap:()=>{Camera.fit();toggleFly(false)}});
  })();
  // t-guide = "the guide bar stowed in the menu": click or drag onto the canvas = bring it back
  (()=>{const tg=document.getElementById('t-guide');if(!tg)return;
    // click OR drag off the menu = bring the guide bar back (T-045)
    const restore=()=>{Guide.restore();toggleFly(false);Toast.show('Guide restored')};
    dragGesture(tg,{threshold:5,preventDefault:true,
      ghost:()=>{const g=document.createElement('div');g.className='fitghost';g.innerHTML='<svg><use href="#i-guide"/></svg>GUIDE';return g},
      onDrop:restore,onTap:restore});
  })();
  // t-ruler = "the zoom-out scale parked in the menu": same gesture as the guide and the dock —
  // drag it onto the canvas to place it there, or click to put it back where it was. It only
  // becomes VISIBLE once you zoom out; Ruler.restore says so if you are zoomed in.
  (()=>{const tr=document.getElementById('t-ruler');if(!tr)return;
    dragGesture(tr,{threshold:5,preventDefault:true,
      ghost:()=>{const g=document.createElement('div');g.className='fitghost';g.textContent='SCALE';return g},
      onDrop:(e,d)=>{Ruler.restore(d.x,d.y);toggleFly(false)},
      onTap:()=>{Ruler.restore();toggleFly(false)}});
  })();
  // BUG-L2-003: the +/- buttons must never be silently dead. If navigation is locked
  // (build mode), an explicit zoom click turns navigation on first (one-time hint), then zooms.
  const zoomBtn=(f)=>{if(!Camera.isNav()){Camera.setNav(true);try{Cosmos.prewarm()}catch(_){}Toast.show('Navigation on — zooming')}Camera.zoomAt(innerWidth/2,innerHeight/2,f)};
  document.getElementById('t-zin').addEventListener('click',()=>zoomBtn(1.45));
  document.getElementById('t-zout').addEventListener('click',()=>zoomBtn(1/1.45));
  // Traffic vs Focus (audit L10). Traffic ON: zooming out tucks the floating panels away
  // (fade + shrink, non-destructive — CSS only, they return on zoom-in). Focus keeps them.
  (()=>{
    const tb=document.getElementById('t-traffic'),lb=document.getElementById('t-traffic-label');if(!tb)return;
    const on=()=>!!Store.get().trafficMode;
    function syncTraffic(){tb.classList.toggle('on',on());lb.textContent=on()?'Traffic mode':'Focus mode'}
    function applyTuck(s){document.documentElement.classList.toggle('traffic-tucked',on()&&s<0.5)} // 0.5 = grid starts fading in
    tb.addEventListener('click',()=>{
      Store.get().trafficMode=!on();Store.save();syncTraffic();
      if(!on())document.documentElement.classList.remove('traffic-tucked');
      Toast.show(on()?'TRAFFIC — zoom out to tuck panels away':'FOCUS — panels stay open');
    });
    Bus.on('camera',c=>applyTuck(c&&c.s!=null?c.s:1));
    syncTraffic();
  })();
  addEventListener('pointerdown',e=>{if(flyOpen&&!e.target.closest('#tri')&&!e.target.closest('#triflyout'))toggleFly(false)},true);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&flyOpen)toggleFly(false)}); // BUG-L0-002: ESC closes the tri fly-menu
  addEventListener('resize',place);
  Bus.on('mode',syncLock);
  place();
  return{open:()=>toggleFly(true)};
})();

/* ---------- Guide: retractable contextual footer ---------- */
const Guide=(()=>{
  const g=document.getElementById('guide'),tab=document.getElementById('guidetab');
  const title=document.getElementById('gtitle'),items=document.getElementById('gitems');
  const CTX={
    build:['FRAME LIVE SQUARE',[['CLICK','a frame → + → add'],['DRAG','occupied frames to move them'],['⌘K','commands'],['?','shortcuts'],['▲ RED','universe zoom']]],
    menu:['ADD TO FRAME',[['CHOOSE','agent · harness · terminal · lab'],['ESC','cancel'],['THEN','click the frame to open the panel']]],
    nav:['NAVIGATION MODE',[['WHEEL','zoom in/out (anchored at cursor)'],['DRAG','move around the universe'],['⌖ FIT','if you get lost'],['▲','lock again to build']]],
    web:['iFRAME UNIVERSE',[['EACH SQUARE','a frame waiting to be built'],['GALAXIES','thousands of frames together'],['⌖ FIT','back to your grid'],['WHEEL','zoom is infinite — keep going']]],
    palette:['COMMAND PALETTE',[['↑↓','navigate'],['ENTER','run'],['ESC','close']]],
    'panel-terminal':['CODE',[['TYPE','help · agents · exo · universe'],['DRAG THE HEADER','to the edge = split screen'],['EDGES','resize']]],
    'panel-shell':['iT',[['WORKSPACES','⌘B sidebar · ＋ new'],['SPLITS','⌘D right · ⌘⇧D down'],['⌘⇧P','command palette'],['⌥⌘B','files tree']]],
    'panel-harness':['HARNESS',[['SPINE','Orchestrator + Safety never collapse'],['SKILLS','signed Fabric patterns'],['DRAG','to the edge for split-screen']]],
    'panel-lab':['LAB',[['CHAT','any model — an API provider or your machine'],['AGENTS','your agents — pick the iNFTs to work with']]],
    'panel-machine':['MY MACHINE',[['BRIDGE','the real body on your machine'],['BRAIN','BYOK key · mock'],['KEYS','this session only, never saved']]],
    'panel-settings':['SETTINGS',[['BASE','fixed palettes'],['LIVE','themes with animated background'],['MY MACHINE','detects the local exo']]],
  };
  let mode='build',overlay=null,web=false;
  function renderG(){
    const key=web?'web':(overlay||(mode==='nav'?'nav':'build'));
    const c=CTX[key]||CTX.build;
    title.textContent=c[0];
    items.innerHTML=c[1].map(i=>`<span class="gi"><b>${i[0]}</b> ${i[1]}</span>`).join(' <span class="gi" style="opacity:.4">·</span> ');
  }
  // ── dock/undock: drag the tab onto the ▲ menu to stow the guide there (mirrors FIT) ──
  let docked=!!Store.get().guideDocked,suppressTabClick=false;
  function applyDock(){
    g.style.display=docked?'none':'';
    tab.style.display=docked?'none':'';
    const tg=document.getElementById('t-guide');if(tg)tg.style.display=docked?'flex':'none';
  }
  function dock(){docked=true;Store.get().guideDocked=true;Store.save();applyDock();Toast.show('Guide stowed — open the ▲ menu and drag it back out')}
  function restore(){docked=false;Store.get().guideDocked=false;Store.save();applyDock()}
  // drag the tab onto the ▲ menu to stow the guide there; a plain click toggles collapse (T-045)
  makeDragToTri(tab,{ghostOffset:[12,12],
    ghost:()=>{const g=document.createElement('div');g.className='fitghost';g.innerHTML='<svg><use href="#i-guide"/></svg>GUIDE';return g},
    onStart:()=>tab.classList.add('dragging'),
    onPark:(e,d,over)=>{tab.classList.remove('dragging');suppressTabClick=true;setTimeout(()=>{suppressTabClick=false},0);if(over)dock()}});
  tab.addEventListener('click',()=>{
    if(suppressTabClick)return; // a real drag just happened — don't also toggle
    const hidden=!g.classList.contains('hidden');
    g.classList.toggle('hidden',hidden);
    tab.classList.toggle('up',hidden); // island drifts to the screen edge when the bar retracts
    Store.get().guideHidden=hidden;Store.save();
  });
  if(Store.get().guideHidden){g.classList.add('hidden');tab.classList.add('up')}
  applyDock(); // restore docked/undocked state from last session
  Bus.on('help',k=>{overlay=k;renderG()});
  Bus.on('mode',m=>{mode=m;renderG()});
  Bus.on('camera',c=>{if(c.web!==web){web=c.web;renderG()}});
  renderG();
  return{restore,isDocked:()=>docked};
})();

/* ---------- Palette ⌘K (keyboard-first — agentsview pattern, MIT) ---------- */
const Palette=(()=>{
  const pal=document.getElementById('pal'),input=document.getElementById('palinput'),list=document.getElementById('pallist');
  let openF=false,sel=0,filtered=[];
  // Panel entries are GENERATED from the real panel registry (DEFS), so the palette
  // always covers every panel — BUG-L0-003: it listed 7, "notes" found nothing. A few
  // extra search keywords per key sharpen matching. All copy is English (owner, 2026-07-11).
  const PANEL_KW={terminal:'code chat agent diff shell run',shell:'it terminal multiplexer sessions ssh split',harness:'crew gates orchestrator roles',lab:'chat agents inft deck soul',matrix:'cluster local models exo distributed download',machine:'bridge brain byok connect endpoint',agents:'wallet iclone vegeta onchain erc8004',agentview:'inft identity card traits',folders:'files file manager tree',email:'mail inbox compose send write',approval:'approve drafts review',contacts:'address book vcard carddav',calendar:'events caldav month',reminders:'reminder alert time',tasks:'cron scheduled autonomous jobs',automations:'autonomy approvals actions queue',notes:'note todo memo',library:'documents research archive',research:'browser web navigate url search',search:'find global',brain:'memory skills',cookbook:'local models recipes download launch',compare:'model comparison side by side',gallery:'photos albums images',integrations:'connections connect services',theme:'themes appearance colors',settings:'settings preferences config'};
  const PANEL_ICON={terminal:'#i-term',shell:'#i-term2',harness:'#i-harness',lab:'#i-lab',matrix:'#i-cosmos',machine:'#i-chip',agents:'#i-agent',email:'#i-mail',automations:'#i-bolt',settings:'#i-gear'};
  const panelEntries=(()=>{
    const defs=(typeof DEFS!=='undefined'&&DEFS)?DEFS:null;
    const keys=defs?Object.keys(defs):Object.keys(PANEL_KW);
    return keys.map(k=>({l:'Open '+((defs&&defs[k]&&defs[k].title)||k.toUpperCase()),h:'panel',k:(k+' '+(PANEL_KW[k]||'')).toLowerCase(),i:PANEL_ICON[k]||'#i-frame',run:()=>Panels.openPanel(k)}));
  })();
  const A=[
    ...panelEntries,
    {l:'Sign in with wallet',h:'access',k:'wallet login siwe sign in connect',i:'#i-wallet',run:()=>WalletAuth.addr()?Toast.show('Already signed in: '+WalletAuth.short(WalletAuth.addr())):PrivyLogin.open()},
    {l:'Keyboard shortcuts',h:'help',k:'keyboard shortcuts keys help ?',i:'#i-frame',run:()=>Shortcuts.toggle(true)},
    {l:'Lock / unlock zoom',h:'universe',k:'zoom navigate lock pan',i:'#i-cosmos',run:()=>Camera.setNav(!Camera.isNav())},
    {l:'Fit to screen',h:'universe',k:'fit reset center frame',i:'#i-fit',run:()=>Camera.fit()},
    {l:'Reset grid layout',h:'layout',k:'reset grid clear layout',i:'#i-frame',run:()=>{Grid.reset();Toast.show('Layout reset')}},
    {l:'Show / hide guide',h:'help',k:'guide help footer hints',i:'#i-frame',run:()=>document.getElementById('guidetab').click()},
    ...Object.keys(Themes.T).map(n=>({l:'Theme: '+n.toUpperCase(),h:Themes.T[n].live?'live':'base',k:'theme '+n,i:'#i-gear',run:()=>Themes.apply(n)})),
  ];
  function renderL(){
    const q=input.value.trim().toLowerCase();
    filtered=A.filter(a=>!q||(a.l+' '+a.k).toLowerCase().includes(q));
    sel=Math.min(sel,Math.max(0,filtered.length-1));
    list.innerHTML=filtered.map((a,i)=>`<div class="palitem ${i===sel?'sel':''}" data-i="${i}"><svg><use href="${a.i}"/></svg>${a.l}<span class="h">${a.h}</span></div>`).join('')||'<div class="palitem" style="opacity:.5">no results</div>';
  }
  function openP(){openF=true;pal.style.display='block';input.value='';sel=0;renderL();input.focus();Bus.emit('help','palette')}
  function closeP(){openF=false;pal.style.display='none';Bus.emit('help',null)}
  addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openF?closeP():openP();return}
    if(!openF)return;
    if(e.key==='Escape')closeP();
    else if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,filtered.length-1);renderL()}
    else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);renderL()}
    else if(e.key==='Enter'){const a=filtered[sel];if(a){closeP();a.run()}}
  });
  input.addEventListener('input',()=>{sel=0;renderL()});
  list.addEventListener('click',e=>{
    const it=e.target.closest('.palitem');if(!it||it.dataset.i===undefined)return;
    const a=filtered[+it.dataset.i];if(a){closeP();a.run()}
  });
  pal.addEventListener('pointerdown',e=>{if(e.target===pal)closeP()});
  return{};
})();

/* ---------- Density: compact · cosy · comfy (rescales grid + UI) ---------- */
const Density=(()=>{
  const P={compact:[22,3],cosy:[28,4],comfy:[34,5]};
  function apply(d){
    if(!P[d])d='cosy';
    Store.get().density=d;Store.save();
    document.body.dataset.density=d;
    Grid.setDims(P[d][0],P[d][1]);
    Camera.reclamp();
    Bus.emit('density',d);
  }
  return{apply};
})();

/* ---------- Shortcuts: global registry + ? overlay (clean-room of the agentsview pattern) ---------- */
const Shortcuts=(()=>{
  const overlay=document.getElementById('keys');
  let open=false,gAt=0;
  function toggle(f){open=f!==undefined?f:!open;overlay.style.display=open?'block':'none'}
  document.getElementById('keysclose').addEventListener('click',()=>toggle(false));
  overlay.addEventListener('pointerdown',e=>{if(e.target===overlay)toggle(false)});
  const GO={t:'terminal',h:'harness',l:'lab',a:'agent',m:'machine',n:'agents',u:'automations',d:'settings'};
  addEventListener('keydown',e=>{
    if(e.key==='Escape'&&open){toggle(false);return}
    const el=document.activeElement;
    if(el&&(/INPUT|TEXTAREA|SELECT/.test(el.tagName)||el.isContentEditable))return;
    if(e.key==='?'){e.preventDefault();toggle();return}
    if(e.key==='g'&&!e.metaKey&&!e.ctrlKey){gAt=Date.now();return}
    if(gAt&&Date.now()-gAt<800&&GO[e.key]){e.preventDefault();Panels.openPanel(GO[e.key]);gAt=0;return}
    if((e.metaKey||e.ctrlKey)&&e.key==='\\'){const t=Panels.top();if(t){t.dataset.snapped?Snap.restore(t):Snap.apply(t,'max')}}
  });
  return{toggle};
})();

/* ---------- App ---------- */
(function App(){
  // launcher semantics: the pill lights on hover only — no persistent selected state
  document.getElementById('hubtabs').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    Panels.openPanel(b.dataset.open);
  });
  document.getElementById('devtabs').addEventListener('click',e=>{
    const b=e.target.closest('.devtab');if(!b)return;
    Toast.show(b.dataset.dev+' — in development. Coming soon to the HUB.');
  });
  document.getElementById('gear').addEventListener('click',()=>Panels.openPanel('settings'));

  // Native menu (Electron shell) → iT. The menu items forward an action; we route it to the
  // iT window when it's the FRONT panel (so ⌘-style items only act in iT context), and open
  // a fresh iT for the "new" actions when none is up. In-window shortcuts still work as before.
  if(window.cfhubNative&&typeof cfhubNative.onMenu==='function'){
    const itOpen=()=>[...document.querySelectorAll('.panel')].some(el=>el.dataset.type==='shell'&&!el.dataset.docked);
    cfhubNative.onMenu(action=>{
      if(action==='new-window'){Panels.openPanel('shell',{newInstance:true});return}
      if(!itOpen()){ // clicking an iT menu item with no iT up opens one; the rest need iT context
        if(action==='new-workspace'||action==='new-surface')Panels.openPanel('shell');
        return;
      }
      Bus.emit('it:menu',action); // the top iT window runs it (new-surface / split / palette / …)
    });
  }

  // logo = universe-zoom toggle (fast path — no need to open the triangle)
  const brandEl=document.querySelector('#topbar .brand');
  brandEl.title='Toggle universe zoom';
  brandEl.addEventListener('click',()=>{
    const on=!Camera.isNav();Camera.setNav(on);if(on)Cosmos.prewarm();
    Toast.show(on?'ZOOM ON — wheel zooms · drag empty space to move · frames still drag':'Zoom locked — build mode');
  });

  // themes icon — opens the theme picker directly (Settings only opens from the gear)
  const tpop=document.getElementById('themepop'),tbtn=document.getElementById('themesbtn');
  function renderThemePop(){
    const cur=Store.get().theme,ALL=Themes.all();
    const sw=names=>'<div class="swatches">'+names.map(n=>{const c=ALL[n];if(!c)return'';return `
      <div class="sw ${n===cur?'on':''} ${c.live?'live':''}" data-theme="${n}">
        <div class="dots"><i style="background:${c.bg}"></i><i style="background:${c.panel}"></i><i style="background:${c.accent}"></i></div>
        <span>${n.toUpperCase()}</span>
      </div>`}).join('')+'</div>';
    const customs=Object.keys(Store.get().customThemes||{});
    tpop.innerHTML='<h4><svg><use href="#i-pal"/></svg>THEMES</h4>'
      +'<div class="tphead">BASE</div>'+sw(['void','origin','kernel','forge','soul','graphite'])
      +'<div class="tphead">LIVE · ANIMATED BACKGROUND</div>'+sw(['neon','synapse','constellation','flux','embers','stardust'])
      +(customs.length?'<div class="tphead">YOUR THEMES</div>'+sw(customs):'')
      +'<div class="tpfoot">Create your own theme in <a id="tpgo">Settings → Appearance</a>.</div>';
    tpop.querySelectorAll('.sw').forEach(s=>s.addEventListener('click',()=>{Themes.apply(s.dataset.theme);renderThemePop()}));
    const go=tpop.querySelector('#tpgo');if(go)go.addEventListener('click',()=>{tpop.classList.remove('open');Panels.openPanel('settings')});
  }
  tbtn.addEventListener('click',()=>{
    const opening=!tpop.classList.contains('open');
    tpop.classList.toggle('open',opening);
    if(opening)renderThemePop();
  });
  Bus.on('themes:open',()=>{tpop.classList.add('open');renderThemePop()});
  addEventListener('pointerdown',e=>{if(tpop.classList.contains('open')&&!e.target.closest('#themepop')&&!e.target.closest('#themesbtn')&&!e.target.closest('#fly-settings'))tpop.classList.remove('open')},true);

  // wallet — clicking the connected account opens the ACCOUNT popover (details), never disconnects directly
  const wbtn=document.getElementById('wallet'),wlbl=document.getElementById('walletlbl'),wacct=document.getElementById('wacct');
  function renderWallet(a){
    if(a){wbtn.classList.add('on');wbtn.querySelector('use').setAttribute('href','#i-wallet');
      wlbl.textContent=WalletAuth.short(a);wbtn.title='Connected — click for account details';}
    else{wbtn.classList.remove('on');
      const pu=Store.get().privyUser; // email-only Privy session — no wallet yet
      wlbl.textContent=pu&&pu.label?String(pu.label).slice(0,18):'SIGN IN';
      wbtn.title=pu?'Signed in with Privy — click to manage':'Sign in with your wallet';
      wacct.classList.remove('open');}
  }
  // the owner can name each wallet; the label persists per address
  const walletLabel=a=>{const m=Store.get().walletNames||{};return m[(a||'').toLowerCase()]||''};
  function setWalletLabel(a,name){const s=Store.get();if(!s.walletNames)s.walletNames={};const k=(a||'').toLowerCase();const v=String(name||'').trim();if(v)s.walletNames[k]=v.slice(0,24);else delete s.walletNames[k];Store.save()}
  let ethUsd={v:0,ts:0}; // 5-min spot cache (keyless CoinGecko)
  async function ethPrice(){
    if(ethUsd.v&&Date.now()-ethUsd.ts<300000)return ethUsd.v;
    try{const r=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');const j=await r.json();if(j&&j.ethereum&&j.ethereum.usd)ethUsd={v:j.ethereum.usd,ts:Date.now()}}catch(_){}
    return ethUsd.v||0;
  }
  // `fresh` is the Rescan button: it bypasses the bridge's 10-minute metadata cache and
  // this panel's spot-price cache, so asking again actually asks again.
  async function fillAcct({fresh=false}={}){
    const a=WalletAuth.addr();if(!a)return;
    if(fresh)ethUsd={v:0,ts:0};
    document.getElementById('waname').textContent=(walletLabel(a)||WalletAuth.name()||'WALLET').toUpperCase();
    document.getElementById('waaddr').textContent=WalletAuth.short(a);
    const bal=document.getElementById('wabal'),usdEl=document.getElementById('wausd');bal.textContent='…';usdEl.textContent='';
    try{
      let eth=null;
      if(Bridge.on()){try{const r=await RPC('nft','balance',a);if(r&&r.ok)eth=r.eth}catch(_){}}
      if(eth===null){const pr=WalletAuth.provider();if(pr){const hex=await pr.request({method:'eth_getBalance',params:[a,'latest']});eth=Number(BigInt(hex))/1e18}}
      bal.textContent=eth===null?'—':(+eth.toFixed(5)).toString();
      if(eth!==null){const p=await ethPrice();if(p)usdEl.textContent='≈ $'+(eth*p).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}
    }catch(_){bal.textContent='—'}
    // The collection's own OpenSea page — whatever is listed there is what a buyer sees.
    const INFT_OPENSEA='https://opensea.io/icloneframe';
    // The way to get one is part of the section, not a consolation prize for an empty
    // wallet: it closes the strip whether the owner holds ten iNFTs or none.
    const buyHTML='<a class="btn wabuy" id="wabuy" href="'+escAttr(INFT_OPENSEA)+'" target="_blank" rel="noopener">GET AN iNFT ON OPENSEA</a>';
    const box=document.getElementById('wanfts');box.innerHTML='<span class="waempty">Loading…</span>';
    try{
      if(!Bridge.on())throw new Error('bridge off');
      // Every token the wallet holds (keyless indexer; falls back to configured collections).
      // This section is about iNFTs, so it shows iNFTs: the bridge tags each token with
      // `isAgent` — one definition, shared with the LAB and MY AGENTS — and a wallet's
      // airdrops, PFPs and empty test contracts stay out of it. They are not lost: the
      // LAB is the room that lists everything the wallet holds.
      const r=await RPC('nft','scanWallet',a,fresh?{fresh:true}:{});
      const list=(r&&r.ok&&r.agents)||[];
      // FAIL OPEN on version skew. A bridge started before the definition existed answers
      // without the tag, and filtering on a field that is simply absent would empty this
      // strip on a wallet full of iNFTs — which is exactly what it did. A missing filter
      // is cosmetic; a hidden iNFT is the app lying about the owner's property.
      const nfts=(r&&typeof r.inftCount==='number')?list.filter(n=>n&&n.isAgent):list;
      if(nfts.length){
        box.innerHTML=nfts.slice(0,8).map(n=>{
          const iu=safeImageUrl(n.image);const img=iu?`<img src="${escAttr(iu)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'wafall',textContent:'${escAttr((n.name||'N')[0].toUpperCase())}'}))">`:`<span class="wafall">${escAttr((n.name||'N')[0].toUpperCase())}</span>`;
          return `<div class="wanft" title="Open in LAB">${img}<span>${escHtml(n.name||('#'+n.tokenId))}</span></div>`;
        }).join('')+(nfts.length>8?`<span class="waempty" style="align-self:center">+${nfts.length-8} more in LAB</span>`:'')+buyHTML;
        box.querySelectorAll('.wanft').forEach(el=>el.addEventListener('click',()=>{wacct.classList.remove('open');Panels.openPanel('lab')}));
      }else{
        box.innerHTML='<span class="waempty">No iNFT in this wallet yet.</span>'+buyHTML;
      }
      // Open it INSIDE CLONE FRAME — the app has a browser; sending the owner out to
      // another one would be the app giving up on itself.
      const b=box.querySelector('#wabuy');
      if(b)b.addEventListener('click',e=>{e.preventDefault();wacct.classList.remove('open');Panels.openPanel('research');Bus.emit('web:open',{url:INFT_OPENSEA,newTab:true})});
      return{ok:true,inft:nfts.length};
    }catch(_){box.innerHTML='<span class="waempty">Connect the HUB Bridge (MY MACHINE) to read NFTs and balance on-chain.</span>';return{ok:false}}
  }
  // rename: the wallet title swaps to an inline input; Enter/blur saves, Esc cancels
  document.getElementById('waedit').addEventListener('click',()=>{
    const a=WalletAuth.addr();if(!a)return;
    const nameEl=document.getElementById('waname');
    const inp=document.createElement('input');inp.value=walletLabel(a)||'';inp.placeholder=WalletAuth.name()||'WALLET';inp.maxLength=24;
    nameEl.replaceWith(inp);inp.focus();inp.select();
    const done=save=>{if(save)setWalletLabel(a,inp.value);const b=document.createElement('b');b.id='waname';inp.replaceWith(b);fillAcct()};
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')done(true);else if(e.key==='Escape')done(false)});
    inp.addEventListener('blur',()=>done(true));
  });
  // Rescan. A keyless indexer can trail a fresh mint by minutes, and a reveal changes a
  // token's metadata without changing what the wallet holds — so the owner needs to ask
  // again without closing the drawer. Reports what it actually found, and stays quiet
  // about counts when the bridge never answered.
  const rescanBtn=document.getElementById('warescan');
  rescanBtn.addEventListener('click',async()=>{
    if(rescanBtn.disabled)return;
    rescanBtn.disabled=true;rescanBtn.classList.add('spin');
    let res=null;try{res=await fillAcct({fresh:true})}catch(_){}
    rescanBtn.disabled=false;rescanBtn.classList.remove('spin');
    if(res&&res.ok)Toast.show(res.inft?('Rescanned — '+res.inft+' iNFT'+(res.inft===1?'':'s')+' in this wallet'):'Rescanned — no iNFT in this wallet yet');
  });
  document.getElementById('wagear').addEventListener('click',()=>{
    wacct.classList.remove('open');Panels.openPanel('settings');
    setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="account"]');if(b)b.click()},80);
  });
  wbtn.addEventListener('click',()=>{
    if(WalletAuth.addr()){const opening=!wacct.classList.contains('open');wacct.classList.toggle('open',opening);if(opening)fillAcct()}
    else PrivyLogin.open();
  });
  document.getElementById('wacopy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(WalletAuth.addr()||'');Toast.show('Address copied')}catch(_){Toast.show('Copy blocked — select manually')}
  });
  document.getElementById('walab').addEventListener('click',()=>{wacct.classList.remove('open');Panels.openPanel('lab')});
  document.getElementById('waout').addEventListener('click',()=>{wacct.classList.remove('open');WalletAuth.disconnect();Toast.show('Signed out')});
  addEventListener('pointerdown',e=>{if(wacct.classList.contains('open')&&!e.target.closest('#wacct')&&!e.target.closest('#wallet'))wacct.classList.remove('open')},true);
  Bus.on('wallet',({addr})=>renderWallet(addr));
  WalletAuth.restore();renderWallet(WalletAuth.addr());

  // arrival of a journey in the universe → pulse at the center of the spot
  Bus.on('travel:done',()=>{
    const d=Grid.dims();
    const c=document.querySelector(`.cell[data-c="${Math.floor(d.cols/2)}"][data-r="${Math.floor(d.rows/2)}"]`);
    if(c){c.classList.add('autopulse');setTimeout(()=>c.classList.remove('autopulse'),2600)}
    Toast.show('You arrived at your frame neighborhood');
  });

  // pending approvals LIGHT UP the frame squares (agent/harness) + badge; clicking opens AUTOMATIONS
  function lightSquares(){
    const n=Approvals.pendingCount();
    document.querySelectorAll('.cell.occ').forEach(cell=>{
      const t=cell.dataset.type;
      const relevant=(t==='agent'||t==='harness'||t==='automations');
      cell.querySelector('.autobadge')?.remove();
      if(relevant&&n>0){
        cell.classList.add('autopulse');
        const b=document.createElement('div');b.className='autobadge';b.textContent=n;cell.appendChild(b);
      }else cell.classList.remove('autopulse');
    });
  }
  Bus.on('approvals:changed',lightSquares);
  Bus.on('camera',lightSquares); // rebuilds badges after the grid rebuild
  Grid.el.addEventListener('click',e=>{if(e.target.closest('.autobadge')){Panels.openPanel('automations')}},true);
  lightSquares();

  // brand — animated logo (several animations + color change)
  (function brandLogo(){
    const el=document.getElementById('brandlogo');if(!el)return;
    const i=el.querySelector('i'),u=el.querySelector('u');
    const modes=[
      ()=>{i.style.inset='4px';i.style.transform='rotate(0deg)';i.style.borderRadius='2px';i.style.opacity='1';u.style.opacity='0';el.style.transform='rotate(0deg)'},        // full frame
      ()=>{i.style.inset='6px';i.style.transform='rotate(45deg)';i.style.borderRadius='1px';el.style.transform='rotate(0deg)'},                                                  // diamond
      ()=>{i.style.inset='2px';i.style.opacity='.25';u.style.opacity='.9';el.style.transform='rotate(0deg)'},                                                                    // halo (frame within frame)
      ()=>{i.style.inset='5px';i.style.transform='rotate(0deg)';el.style.transform='rotate(90deg)'},                                                                             // rotates the frame
      ()=>{i.style.inset='7px';i.style.opacity='1';i.style.borderRadius='50%';u.style.opacity='0'},                                                                              // dot (star)
    ];
    // palette that cycles through the themes' accents — the square changes color
    const COLORS=['#f85149','#8ab4ff','#37e05f','#b06ae0','#ff8a4a','#4fd6c2','#0ff0fc','#e040fb'];
    let m=0,c=0;
    setInterval(()=>{
      m=(m+1)%modes.length;modes[m]();
      if(m===0){c=(c+1)%COLORS.length;el.style.borderColor=COLORS[c];i.style.background=COLORS[c];u.style.borderColor=COLORS[c];
        el.style.boxShadow='0 0 10px -2px '+COLORS[c];setTimeout(()=>{el.style.boxShadow='0 0 0 0 '+COLORS[c]},600);}
    },1500);
    modes[0]();
  })();

  Themes.apply(Store.get().theme);
  Density.apply(Store.get().density); // builds the grid with the density's pitch
  Camera.render();

  // ── op=app — the main-app control plane. The running window parks ONE socket here so an
  //    outside agent (Pi, via /mod/app) can OPEN panels and READ the live screen — the things
  //    the browser can do but the bridge cannot see. Sibling of iT's op=it; only the always-on
  //    App controller parks it, so it is alive whenever the app is open. Reconnects on drop.
  const APP_ALIASES={browser:'research',agent:'terminal',it:'shell',iterm:'shell','it terminal':'shell',code:'terminal',connections:'integrations','my machine':'machine','my agents':'agents','model comparison':'compare',web:'research'};
  function appResolveKey(name){
    let t=String(name||'').trim().toLowerCase().replace(/\b(the|open|please|panel|tab|window)\b/g,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
    if(!t)return null;
    if(Panels.has(t))return t;
    if(APP_ALIASES[t])return APP_ALIASES[t];
    const cat=Panels.catalog(),sq=t.replace(/\s+/g,'');
    const byTitle=cat.find(pp=>String(pp.title||'').toLowerCase()===t)||cat.find(pp=>String(pp.title||'').toLowerCase().replace(/\s+/g,'')===sq);
    if(byTitle)return byTitle.key;
    const pre=cat.find(pp=>pp.key.startsWith(t))||cat.find(pp=>String(pp.title||'').toLowerCase().startsWith(t));
    return pre?pre.key:null;
  }
  function appScreen(){
    const top=Panels.top(),panels=[];
    Panels.layer.querySelectorAll('.panel').forEach(el=>{
      const key=el.dataset.key||el.dataset.type||'?';const hb=el.querySelector('header b');
      panels.push({key,title:hb?hb.textContent.trim():key,docked:el.style.display==='none'||el.dataset.docked==='1',focused:el===top});
    });
    return {open:panels.filter(x=>!x.docked).map(x=>x.key),focused:top?(top.dataset.key||top.dataset.type):null,panels};
  }
  function appExec(action,params){
    params=params||{};
    try{
      if(action==='ping')return{ok:true,app:'CLONE FRAME'};
      if(action==='read_screen')return{ok:true,screen:appScreen()};
      if(action==='list_panels')return{ok:true,panels:Panels.catalog()};
      if(action==='open_panel'||action==='focus_panel'){
        const key=appResolveKey(params.panel);
        if(!key)return{ok:false,error:'no panel matches "'+(params.panel||'')+'" — use list_panels for keys'};
        const el=Panels.openPanel(key);
        // Settings is a panel of rooms; landing on the wrong one is a dead end for a caller
        // that cannot click. `section` takes it straight there, the same way the CODE tool
        // open_settings{section} already does. Sanitised hard — it goes into a selector.
        let sec='';
        if(el&&key==='settings'&&params.section){
          sec=String(params.section).trim().toLowerCase();
          if(!/^[a-z0-9]{1,24}$/.test(sec))sec='';
          else setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="'+sec+'"]');if(b)b.click()},80);
        }
        return el?{ok:true,key,out:(action==='focus_panel'?'focused ':'opened ')+key+(sec?' → '+sec:'')}:{ok:false,error:'could not open "'+key+'" (may be under construction)'};
      }
      if(action==='close_panel'){
        const key=appResolveKey(params.panel);if(!key)return{ok:false,error:'no panel matches "'+(params.panel||'')+'"'};
        if(key==='terminal')return{ok:false,error:'refusing to close CODE — it may host the agent'};
        let target=null;Panels.layer.querySelectorAll('.panel').forEach(el=>{if((el.dataset.key||el.dataset.type)===key)target=el});
        if(!target)return{ok:false,error:'panel "'+key+'" is not open'};
        const x=target.querySelector('.pbtns .x');if(x)x.click();else target.remove();
        return{ok:true,out:'closed '+key};
      }
      return{ok:false,error:'unknown app action: '+action};
    }catch(e){return{ok:false,error:String((e&&e.message)||e)}}
  }
  let appCtlWs=null;
  function appCtlConnect(){
    if(appCtlWs)return;
    const b=window.__CFHUB_BRIDGE__;if(!b||!b.token||!Bridge.on())return;
    let s;try{s=new WebSocket(b.endpoint.replace(/^http/,'ws')+'/stream?op=app',['cfhub','cfhub.bearer.'+b.token])}catch(_){return}
    appCtlWs=s;
    s.onmessage=e=>{
      let m=null;try{m=JSON.parse(e.data)}catch(_){}
      if(!m||!m.id)return;
      Promise.resolve().then(()=>appExec(m.action,m.params)).catch(err=>({ok:false,error:String((err&&err.message)||err)}))
        .then(res=>{try{s.send(JSON.stringify({id:m.id,result:res}))}catch(_){}});
    };
    s.onclose=()=>{if(appCtlWs===s)appCtlWs=null;setTimeout(appCtlConnect,3000)};
    s.onerror=()=>{};
  }
  Bus.on('bridge:changed',()=>appCtlConnect());
  appCtlConnect();
  (window.requestIdleCallback||(f=>setTimeout(f,900)))(()=>Brain.detect());
  // seed the agent at the center only once the grid has its final dimensions
  function seedIfEmpty(){
    if(Object.keys(Store.get().cells).length)return;
    const d=Grid.dims();
    const mid=document.querySelector(`.cell[data-c="${Math.floor(d.cols/2)}"][data-r="${Math.floor(d.rows/2)}"]`);
    if(mid)Grid.occupy(mid,'agent');
  }
