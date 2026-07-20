  function wireLibrary(p){
    const body=p.querySelector('#lbbody'),search=p.querySelector('#lbsearch'),chips=p.querySelector('#lbchips'),
      title=p.querySelector('#lbtitle'),count=p.querySelector('#lbcount'),sub=p.querySelector('#lbsub'),
      acts=p.querySelector('#lbacts'),recentB=p.querySelector('#lbrecent'),selectB=p.querySelector('#lbselect'),tidyB=p.querySelector('#lbtidy');
    if(!Bridge.on()){needBridge(body);return}
    let tab='docs',type='all',recent=true,selMode=false,openId=null;const sel=new Set();
    const TABS={docs:{t:'Documents',s:'Open documents in a session, clone to a new or import new files.',ph:'Search titles & content…'},research:{t:'Research',s:'Completed deep research reports. Click to view.',ph:'Search research…'},archive:{t:'Archive',s:'Archived documents. Restore to make active again.',ph:'Search archive…'}};
    const ICON={email:'#i-mail',bash:'#i-term',python:'#i-chip',markdown:'#i-lab',json:'#i-gear',html:'#i-frame',image:'#i-frame',text:'#i-lab'};
    const rel=ts=>relTime(ts)||fmtTS(ts); // kernel relTime (T-046); keep this scope's absolute fallback for invalid/future
    const dtype=d=>{const m=String(d.mimeType||'').toLowerCase(),n=String(d.name||'').toLowerCase();
      if(m.includes('rfc822')||n.endsWith('.eml'))return 'email';
      if(m.includes('x-sh')||n.endsWith('.sh')||n.endsWith('.zsh')||n.endsWith('.bash'))return 'bash';
      if(m.includes('markdown')||n.endsWith('.md')||n.endsWith('.markdown'))return 'markdown';
      if(m.includes('python')||n.endsWith('.py'))return 'python';
      if(m.includes('json'))return 'json';
      if(m.includes('html'))return 'html';
      if(m.startsWith('image/'))return 'image';
      return 'text'};
    const ver=d=>((d.tags||[]).find(t=>/^v\d+$/.test(t))||'v1');
    const bumpV=tags=>{const n=parseInt((ver({tags})).slice(1),10)||1;return [...(tags||[]).filter(t=>!/^v\d+$/.test(t)),'v'+(n+1)]};
    const isArch=d=>(d.tags||[]).some(t=>t.toLowerCase()==='archived');
    const ck=id=>`<span class="libck ${sel.has(id)?'on':''}"></span>`;
    const bulkbar=()=>selMode?`<div class="libbulk"><span>${sel.size} selected</span>${tab==='docs'?'<button class="btn mini" id="lbbarc">Archive</button>':''}${tab==='archive'?'<button class="btn mini" id="lbbres">Restore</button>':''}<button class="btn mini libdel" id="lbbdel">Delete</button></div>`:'';
    function setTab(t){tab=t;type='all';selMode=false;sel.clear();openId=null;
      p.querySelectorAll('.libtab').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
      selectB.classList.remove('on');search.value='';search.placeholder=TABS[t].ph;
      title.textContent=TABS[t].t;sub.textContent=TABS[t].s;
      acts.style.display=t==='docs'?'':'none';tidyB.style.display=t==='docs'?'':'none';load()}
    function wireBulk(){
      const del=body.querySelector('#lbbdel');if(del)del.addEventListener('click',async()=>{if(!sel.size){Toast.show('Nothing selected');return}const n=sel.size;for(const id of sel)await RPC(tab==='research'?'research':'library','remove',id);Toast.show(n+' deleted');sel.clear();load()});
      const arc=body.querySelector('#lbbarc');if(arc)arc.addEventListener('click',async()=>{if(!sel.size){Toast.show('Nothing selected');return}const n=sel.size;for(const id of sel){const d=await RPC('library','get',id);if(d&&!isArch(d))await RPC('library','update',id,{tags:[...(d.tags||[]),'archived']})}Toast.show(n+' archived');sel.clear();load()});
      const res=body.querySelector('#lbbres');if(res)res.addEventListener('click',async()=>{if(!sel.size){Toast.show('Nothing selected');return}const n=sel.size;for(const id of sel){const d=await RPC('library','get',id);if(d)await RPC('library','update',id,{tags:(d.tags||[]).filter(t=>t.toLowerCase()!=='archived')})}Toast.show(n+' restored');sel.clear();load()})}
    async function load(){
      if(tab==='research')return loadResearch();
      let items=[];try{items=await RPC('library','list',{search:search.value.trim()})}catch(e){showErr(body,e);return}
      items=items.filter(d=>tab==='archive'?isArch(d):!isArch(d));
      count.textContent=items.length+(tab==='archive'?' archived':' documents');
      if(tab==='docs'){const cnt={};items.forEach(d=>{const t=dtype(d);cnt[t]=(cnt[t]||0)+1});
        chips.innerHTML=`<span class="tkchip ${type==='all'?'on':''}" data-t="all">all <b>(${items.length})</b></span>`+Object.keys(cnt).sort().map(t=>`<span class="tkchip ${type===t?'on':''}" data-t="${t}">${t} <b>(${cnt[t]})</b></span>`).join('');
        chips.querySelectorAll('.tkchip').forEach(el=>el.addEventListener('click',()=>{type=el.dataset.t;openId=null;load()}));
        if(type!=='all')items=items.filter(d=>dtype(d)===type)}
      else chips.innerHTML='';
      if(!recent)items=[...items].sort((a,b)=>String(a.name).localeCompare(String(b.name)));
      if(!items.length){body.innerHTML=bulkbar()+(tab==='archive'?'<div class="qempty">No archived items 🙁</div>':'<div class="qempty">No documents yet. Import a file or create one.</div>');wireBulk();return}
      body.innerHTML=bulkbar()+items.map(d=>{const t=dtype(d),o=openId===d.id;return `<div class="librow"><div class="librowh" data-id="${d.id}">${selMode?ck(d.id):`<svg><use href="${ICON[t]||'#i-lab'}"/></svg>`}<div style="flex:1;min-width:0"><b>${escHtml(d.name)}</b> <span class="badge">${ver(d)}</span><div class="libmeta">${t} · ${rel(d.updatedAt||d.createdAt)}</div></div><span class="libchev">${o?'▲':'▼'}</span></div>${o?'<div class="libdetail" id="lbdetail"></div>':''}</div>`}).join('');
      wireBulk();
      body.querySelectorAll('.librowh').forEach(el=>el.addEventListener('click',()=>docClick(el.dataset.id)));
      if(openId)fillDoc(openId)}
    async function docClick(id){
      if(selMode){sel.has(id)?sel.delete(id):sel.add(id);load();return}
      if(openId===id){openId=null;load();return}
      openId=id;load()}
    async function fillDoc(id){
      let d;try{d=await RPC('library','get',id)}catch(e){return}
      const det=body.querySelector('#lbdetail');if(!det||!d)return;
      det.innerHTML=`<pre class="libpre">${escHtml(d.text||'(no text — '+(d.mimeType||'binary')+' stored as metadata)')}</pre><div class="libfoot"><button class="btn mini libdel" id="lbdel">Delete</button>${tab==='archive'?'<button class="btn mini" id="lbres">Restore</button>':'<button class="btn mini" id="lbarc">Archive</button>'}<span class="libgap"></span><button class="btn mini" id="lbcl">Clone</button><button class="btn mini" id="lbop">Open →</button></div>`;
      det.querySelector('#lbdel').addEventListener('click',async()=>{await RPC('library','remove',id);Toast.show('Deleted');openId=null;load()});
      const arc=det.querySelector('#lbarc');if(arc)arc.addEventListener('click',async()=>{await RPC('library','update',id,{tags:[...(d.tags||[]),'archived']});Toast.show('Archived');openId=null;load()});
      const res=det.querySelector('#lbres');if(res)res.addEventListener('click',async()=>{await RPC('library','update',id,{tags:(d.tags||[]).filter(t=>t.toLowerCase()!=='archived')});Toast.show('Restored');openId=null;load()});
      det.querySelector('#lbcl').addEventListener('click',async()=>{const r=await RPC('library','add',{name:d.name+' (copy)',mimeType:d.mimeType,text:d.text||'',tags:(d.tags||[]).filter(t=>t.toLowerCase()!=='archived'&&!/^v\d+$/.test(t))});Toast.show(r.ok?'Cloned':r.error||'failed');openId=null;load()});
      det.querySelector('#lbop').addEventListener('click',()=>editor(d))}
    function editor(d){openId=null;body.innerHTML=`<div class="acctform"><input id="lbn" placeholder="Document name" value="${escAttr(d.name)}"><textarea id="lbt" style="min-height:240px">${escAttr(d.text||'')}</textarea><div class="compose-actions"><button class="btn" id="lbsave">SAVE</button><button class="btn" id="lbback">← list</button></div></div>`;
      body.querySelector('#lbsave').addEventListener('click',async()=>{const r=await RPC('library','update',d.id,{name:body.querySelector('#lbn').value.trim()||d.name,text:body.querySelector('#lbt').value,tags:bumpV(d.tags)});Toast.show(r.ok?'Saved':r.error||'failed');load()});
      body.querySelector('#lbback').addEventListener('click',load)}
    async function loadResearch(){
      let items=[];try{items=await RPC('research','list')}catch(e){showErr(body,e);return}
      const q=search.value.trim().toLowerCase();if(q)items=items.filter(r=>String(r.question).toLowerCase().includes(q));
      count.textContent=items.length+' research';chips.innerHTML='';
      if(!recent)items=[...items].sort((a,b)=>String(a.question).localeCompare(String(b.question)));
      if(!items.length){body.innerHTML=bulkbar()+'<div class="qempty">No research reports yet. Run one in DEEP RESEARCH.</div>';wireBulk();return}
      body.innerHTML=bulkbar()+items.map(r=>{const o=openId===r.id;return `<div class="librow"><div class="librowh" data-id="${r.id}">${selMode?ck(r.id):'<svg><use href="#i-cosmos"/></svg>'}<div style="flex:1;min-width:0"><b>${escHtml(r.question)}</b><div class="libmeta">${fmtTS(r.createdAt)}</div></div><span class="libchev">${o?'▲':'▼'}</span></div>${o?'<div class="libdetail" id="lbdetail"></div>':''}</div>`}).join('');
      wireBulk();
      body.querySelectorAll('.librowh').forEach(el=>el.addEventListener('click',()=>resClick(el.dataset.id)));
      if(openId)fillResearch(openId)}
    async function resClick(id){
      if(selMode){sel.has(id)?sel.delete(id):sel.add(id);loadResearch();return}
      if(openId===id){openId=null;loadResearch();return}
      openId=id;loadResearch()}
    async function fillResearch(id){
      let d;try{d=await RPC('research','get',id)}catch(e){return}
      const det=body.querySelector('#lbdetail');if(!det||!d)return;
      det.innerHTML=`<div class="libmeta" style="margin-bottom:7px">${fmtTS(d.createdAt)} · ${d.sourceCount||0} sources · ${escHtml(d.mode||'reason')} mode${d.model?' · '+escHtml(d.model):''}</div><div class="libpre md">${MDLite.render(d.markdown||'')}</div><div class="libfoot"><button class="btn mini libdel" id="lbdel">Delete</button><span class="libgap"></span><button class="btn mini" id="lbop">Open →</button></div>`;
      det.querySelector('#lbdel').addEventListener('click',async()=>{await RPC('research','remove',id);Toast.show('Deleted');openId=null;loadResearch()});
      det.querySelector('#lbop').addEventListener('click',()=>{body.innerHTML=`<div class="mread"><div class="mrhead"><button class="btn mini" id="lbback">← back</button></div><h4>${escHtml(d.question)}</h4><div class="content">${MDLite.render(d.markdown||'')}</div></div>`;body.querySelector('#lbback').addEventListener('click',loadResearch)})}
    p.querySelectorAll('.libtab').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
    recentB.addEventListener('click',()=>{recent=!recent;recentB.classList.toggle('on',recent);load()});
    selectB.addEventListener('click',()=>{selMode=!selMode;sel.clear();openId=null;selectB.classList.toggle('on',selMode);load()});
    tidyB.addEventListener('click',()=>Toast.show('Tidy — coming soon'));
    search.addEventListener('input',()=>{clearTimeout(search._t);search._t=setTimeout(load,250)});
    p.querySelector('#lbadd').addEventListener('click',()=>{openId=null;body.innerHTML=`<div class="acctform"><input id="lbn" placeholder="Document name"><textarea id="lbt" placeholder="Paste the text…" style="min-height:220px"></textarea><div class="compose-actions"><button class="btn" id="lbsave">SAVE</button><button class="btn" id="lbcancel">← list</button></div></div>`;
      body.querySelector('#lbsave').addEventListener('click',async()=>{const r=await RPC('library','add',{name:body.querySelector('#lbn').value.trim()||'Document',mimeType:'text/plain',text:body.querySelector('#lbt').value});Toast.show(r.ok?'Added':r.error||'failed');load()});
      body.querySelector('#lbcancel').addEventListener('click',load)});
    p.querySelector('#lbimp').addEventListener('click',()=>{const inp=document.createElement('input');inp.type='file';inp.onchange=()=>{const f=inp.files[0];if(!f)return;const rd=new FileReader();const textual=!f.type||/^text\/|json|xml|yaml|javascript|markdown|x-sh|sql|toml|csv/.test(f.type);
      rd.onload=async()=>{const r=await RPC('library','add',textual?{name:f.name,mimeType:f.type||'text/plain',text:String(rd.result)}:{name:f.name,mimeType:f.type,contentBase64:String(rd.result)});Toast.show(r.ok?'Imported':r.error||'failed');load()};
      textual?rd.readAsText(f):rd.readAsDataURL(f)};inp.click()});
    load();
  }
