  function wireNotes(p){
    const body=p.querySelector('#ntbody'),search=p.querySelector('#ntsearch'),chips=p.querySelector('#ntchips'),selbar=p.querySelector('#ntselbar'),selBtn=p.querySelector('#ntsel'),archBtn=p.querySelector('#ntarch'),gridBtn=p.querySelector('#ntgrid'),input=p.querySelector('#ntadd');
    const ARCH='archived',REM='reminder',sel=new Set();
    let chip='all',archView=false,selMode=false,grid=false,mode='todo',view=[];
    p.querySelector('#ntmin').addEventListener('click',()=>{const m=p.querySelector('.pbtns .m');if(m)m.click()});
    if(!Bridge.on()){needBridge(body);return}
    const hasTag=(n,t)=>(n.tags||[]).some(x=>String(x).toLowerCase()===t);
    const todosOf=sn=>(String(sn||'').match(/\[[ xX]\][^\[]*/g)||[]).map(c=>({done:c[1].toLowerCase()==='x',text:c.slice(3).trim()}));
    const restOf=sn=>String(sn||'').replace(/\[[ xX]\][^\[]*/g,'').trim();
    async function load(){
      let items=[];try{items=await RPC('notes','list',{search:search.value.trim()})}catch(e){showErr(body,e);return}
      const pool=items.filter(n=>hasTag(n,ARCH)===archView);
      const defN=pool.filter(n=>!hasTag(n,REM)).length,remN=pool.length-defN;
      view=chip==='default'?pool.filter(n=>!hasTag(n,REM)):chip==='rem'?pool.filter(n=>hasTag(n,REM)):pool;
      chips.innerHTML=`<span class="nts-chip ${chip==='all'?'on':''}" data-c="all">All</span><span class="nts-chip ${chip==='default'?'on':''}" data-c="default">Default<b>${defN}</b></span><span class="nts-chip ${chip==='rem'?'on':''}" data-c="rem"><svg><use href="#i-shield"/></svg>Reminders<b>${remN}</b></span>`;
      chips.querySelectorAll('.nts-chip').forEach(el=>el.addEventListener('click',()=>{chip=el.dataset.c;load()}));
      paintBar();
      body.classList.toggle('nts-grid',grid&&view.length>0);
      body.innerHTML=view.length?view.map(n=>{
        const td=todosOf(n.snippet),rest=restOf(n.snippet);
        return `<div class="lprow nts-card" data-id="${n.id}">${selMode?`<span class="nts-ck ${sel.has(n.id)?'on':''}"></span>`:''}<div style="flex:1;min-width:0">${n.title?`<b>${escHtml(n.title)}</b>`:''}${td.map((t,i)=>`<div class="nts-todo ${t.done?'done':''}" data-td="${i}"><span class="nts-tck ${t.done?'on':''}"></span><span class="nts-ttx">${escHtml(t.text)}</span></div>`).join('')}<div class="dim" style="font-size:10px">${rest?escHtml(rest.slice(0,80))+' · ':''}${fmtTS(n.updatedAt||n.createdAt)}</div></div>${selMode?'':`<button class="btn mini" data-rm="${n.id}">✕</button>`}</div>`;
      }).join(''):`<div class="qempty">${archView?'No archived notes 🙂':(search.value.trim()||chip!=='all')?'No notes match 🙂':'No notes yet 🙂'}</div>`;
      body.querySelectorAll('.nts-card').forEach(el=>el.addEventListener('click',e=>{
        if(e.target.closest('[data-rm]')||e.target.closest('.nts-todo'))return;
        const id=el.dataset.id;
        if(selMode){sel.has(id)?sel.delete(id):sel.add(id);el.querySelector('.nts-ck').classList.toggle('on',sel.has(id));paintBar();return}
        openNote(id);
      }));
      body.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();await RPC('notes','remove',b.dataset.rm);load()}));
      body.querySelectorAll('.nts-todo').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();if(selMode)return;toggleTodo(el.closest('.nts-card').dataset.id,+el.dataset.td)}));
    }
    function paintBar(){
      selBtn.textContent=selMode?'Cancel':'Select';
      selBtn.classList.toggle('nts-cancel',selMode);
      chips.style.display=selMode?'none':'flex';
      selbar.style.display=selMode?'flex':'none';
      if(!selMode)return;
      const n=sel.size,all=view.length>0&&view.every(v=>sel.has(v.id));
      selbar.innerHTML=`<span class="nts-ck ${all?'on':''}" id="ntall" title="Select all"></span><span class="nts-selcount">${n} Selected</span><span style="flex:1"></span><button class="btn mini" id="ntbarch" ${n?'':'disabled'}><svg><use href="#i-harness"/></svg>${archView?'Unarchive':'Archive'}</button><button class="btn mini nts-delbtn" id="ntbdel" ${n?'':'disabled'}>✕ Delete</button>`;
      selbar.querySelector('#ntall').addEventListener('click',()=>{if(all)view.forEach(v=>sel.delete(v.id));else view.forEach(v=>sel.add(v.id));load()});
      selbar.querySelector('#ntbarch').addEventListener('click',async()=>{
        if(!sel.size)return;
        for(const id of [...sel]){let n;try{n=await RPC('notes','get',id)}catch(e){continue}if(!n)continue;
          const tags=archView?(n.tags||[]).filter(t=>String(t).toLowerCase()!==ARCH):[...(n.tags||[]),ARCH];
          await RPC('notes','update',id,{tags});}
        Toast.show(archView?'Unarchived':'Archived');sel.clear();load();
      });
      selbar.querySelector('#ntbdel').addEventListener('click',async()=>{
        if(!sel.size)return;
        for(const id of [...sel])await RPC('notes','remove',id);
        Toast.show('Deleted');sel.clear();load();
      });
    }
    async function toggleTodo(id,idx){
      let n;try{n=await RPC('notes','get',id)}catch(e){return}
      if(!n)return;
      let k=-1;
      const lines=String(n.body||'').split('\n').map(l=>{
        if(!/^\s*(?:(?:[-*+]|\d+\.)\s+)?\[[ xX]\]/.test(l))return l;
        k++;if(k!==idx)return l;
        return l.replace(/\[[ xX]\]/,m=>m==='[ ]'?'[x]':'[ ]');
      });
      const r=await RPC('notes','update',id,{body:lines.join('\n')});
      if(r&&r.ok===false)Toast.show(r.error||'update failed');
      load();
    }
    async function openNote(id){let n;try{n=await RPC('notes','get',id)}catch(e){return}if(n)editor(n)}
    function editor(n){n=n||{};body.classList.remove('nts-grid');
      body.innerHTML=`<div class="acctform"><input id="nttitle" placeholder="Title" value="${escAttr(n.title||'')}"><textarea id="ntbodyt" placeholder="Write in markdown — use - [ ] for to-dos…" style="min-height:220px">${escAttr(n.body||'')}</textarea><input id="nttags" placeholder="tags (commas)" value="${escAttr((n.tags||[]).join(', '))}"><div class="compose-actions"><button class="btn" id="ntsave">SAVE</button><button class="btn" id="ntback">← back</button></div></div>`;
      body.querySelector('#ntsave').addEventListener('click',async()=>{
        const t=body.querySelector('#nttitle').value.trim(),b=body.querySelector('#ntbodyt').value,tags=body.querySelector('#nttags').value.split(',').map(s=>s.trim()).filter(Boolean);
        const r=n.id?await RPC('notes','update',n.id,{title:t,body:b,tags}):await RPC('notes','create',{title:t,body:b,tags});
        if(r&&r.ok===false){Toast.show(r.error||'save failed');return}
        Toast.show('Saved');load();
      });
      body.querySelector('#ntback').addEventListener('click',load);}
    const mNote=p.querySelector('#ntmnote'),mTodo=p.querySelector('#ntmtodo');
    function setMode(m){mode=m;mNote.classList.toggle('on',m==='note');mTodo.classList.toggle('on',m==='todo');input.placeholder=m==='todo'?'Add a to-do...':'Add a note...'}
    mNote.addEventListener('click',()=>setMode('note'));
    mTodo.addEventListener('click',()=>setMode('todo'));
    input.addEventListener('keydown',async e=>{
      if(e.key!=='Enter')return;
      const t=input.value.trim();if(!t)return;
      const payload=mode==='todo'?{title:'',body:'- [ ] '+t}:{title:t,body:''};
      if(archView)payload.tags=[ARCH];
      const r=await RPC('notes','create',payload);
      if(r&&r.ok===false){Toast.show(r.error||'create failed');return}
      input.value='';load();
    });
    p.querySelector('#ntimg').addEventListener('click',()=>Toast.show('Image attach — coming soon'));
    archBtn.addEventListener('click',()=>{archView=!archView;archBtn.classList.toggle('nts-on',archView);selMode=false;sel.clear();chip='all';load()});
    gridBtn.addEventListener('click',()=>{grid=!grid;gridBtn.classList.toggle('nts-on',grid);load()});
    selBtn.addEventListener('click',()=>{selMode=!selMode;sel.clear();load()});
    search.addEventListener('input',()=>{clearTimeout(search._t);search._t=setTimeout(load,250)});
    load();
  }
