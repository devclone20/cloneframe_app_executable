  function wireBrain(p){
    const body=p.querySelector('#brnbody'),tabs=[...p.querySelectorAll('#brntabs .thp-tab')];
    const BK='cfhub.brain.v1',TYPES=['contact','fact','identity','preference','project'];
    const SEED=[
      {id:'fab-summarize',name:'summarize',desc:'Condense long content into a tight summary — main points and takeaways.',chip:'published',conf:96,uses:12,how:'fabric pattern'},
      {id:'fab-extract-wisdom',name:'extract_wisdom',desc:'Pull insights, ideas, quotes and references out of a transcript or article.',chip:'published',conf:92,uses:8,how:'fabric pattern'},
      {id:'fab-improve-writing',name:'improve_writing',desc:'Rewrite text for clarity, flow and tone without changing the meaning.',chip:'published',conf:88,uses:5,how:'fabric pattern'},
      {id:'fab-create-summary',name:'create_summary',desc:'Structured summary: one-liner, main points, actionable takeaways.',chip:'published',conf:71,uses:2,how:'fabric pattern'}];
    const dbCell=persisted(BK,null); let db=dbCell.get(); // kernel persisted (T-046)
    if(!db)db={memories:[],skills:SEED.slice(),memEnabled:true,skillsEnabled:true};
    db.memories=db.memories||[];db.skills=db.skills||[];
    if(db.memEnabled===undefined)db.memEnabled=true;if(db.skillsEnabled===undefined)db.skillsEnabled=true;
    const save=()=>dbCell.set(db);
    const st=Store.get();st.brainCfg=Object.assign({autoMem:true,autoSkill:true,autoApprove:true,minConf:85,maxSkills:3},st.brainCfg);Store.save();
    const cfg=st.brainCfg;
    const ago=relTime; // kernel relTime (T-046) — accepts a ms epoch; single-sourced s/m/h/d/w/y
    let tab='memories',editId=null,skMenu=null;
    let memQ='',memCat='all',memSort='new',memSel=false;const memPick=new Set();
    let skQ='',skSort='conf',skSel=false;const skPick=new Set();
    tabs.forEach(t=>t.addEventListener('click',()=>{tabs.forEach(x=>x.classList.toggle('on',x===t));tab=t.dataset.t;editId=null;skMenu=null;render()}));
    /* — memories — */
    function memCard(m){
      if(editId===m.id)return`<div class="brn-card sel"><textarea class="brn-ta" id="bmet">${escHtml(m.text)}</textarea><div class="brn-meta"><select id="bmety" class="brn-sel">${TYPES.map(t=>`<option${m.type===t?' selected':''}>${t}</option>`).join('')}</select><button class="btn mini" id="bmesave">save</button><button class="btn mini" id="bmedel">delete</button><button class="btn mini" id="bmecancel">cancel</button></div></div>`;
      return`<div class="brn-card ${memSel&&memPick.has(m.id)?'sel':''}" data-id="${escAttr(m.id)}"><div class="txt">${escAttr(m.text)}</div><div class="brn-meta"><span class="brn-tag ${escAttr(m.type)}">${escAttr(m.type)}</span><span>${escAttr(m.source||'manual')}</span><span>${m.uses||0}x</span><span>${ago(m.ts)}</span></div></div>`}
    function listMem(){
      const el=body.querySelector('#bmlist');if(!el)return;
      let items=db.memories.filter(m=>(memCat==='all'||m.type===memCat)&&(!memQ||(m.text||'').toLowerCase().includes(memQ)));
      items=items.slice().sort((a,b)=>memSort==='old'?(a.ts||0)-(b.ts||0):memSort==='used'?(b.uses||0)-(a.uses||0):(b.ts||0)-(a.ts||0));
      el.innerHTML=items.length?items.map(memCard).join(''):`<div class="qempty">${db.memories.length?'No memories match.':'No memories yet — add one in the <b>Add</b> tab.'}</div>`;
      el.querySelectorAll('.brn-card[data-id]').forEach(c=>c.addEventListener('click',()=>{const id=c.dataset.id;
        if(memSel){memPick.has(id)?memPick.delete(id):memPick.add(id);c.classList.toggle('sel');const d=body.querySelector('#bmdel');if(d)d.textContent=`Delete (${memPick.size})`}
        else{editId=id;listMem()}}));
      if(editId){const ed=db.memories.find(m=>m.id===editId),sv=el.querySelector('#bmesave');
        if(ed&&sv){
          sv.addEventListener('click',()=>{ed.text=el.querySelector('#bmet').value.trim()||ed.text;ed.type=el.querySelector('#bmety').value;editId=null;save();renderMem();Toast.show('Memory updated')});
          el.querySelector('#bmedel').addEventListener('click',()=>{db.memories=db.memories.filter(m=>m.id!==editId);editId=null;save();renderMem();Toast.show('Memory deleted')});
          el.querySelector('#bmecancel').addEventListener('click',()=>{editId=null;listMem()});
        }}
    }
    function renderMem(){
      body.innerHTML=`<div class="brn-head"><b>Memories</b><span class="badge">${db.memories.length} memories</span><span class="brn-enl">Enabled</span><div class="sw3 ${db.memEnabled?'on':''}" id="bmsw"><i></i></div></div>
        <div class="brn-toolbar"><select id="bmsort" class="brn-sel"><option value="new">Newest</option><option value="old">Oldest</option><option value="used">Most used</option></select><button class="btn mini" id="bmtidy">＋ Tidy</button><button class="btn mini" id="bmselect">${memSel?'Done':'Select'}</button>${memSel?`<button class="btn mini" id="bmdel">Delete (${memPick.size})</button>`:''}</div>
        <input class="brn-search" id="bmq" placeholder="Search memories...">
        <div class="tkchips brn-chips" id="bmchips">${['all',...TYPES].map(c=>`<span class="tkchip ${memCat===c?'on':''}" data-c="${c}">${c}</span>`).join('')}</div>
        <div id="bmlist"></div>`;
      body.querySelector('#bmsort').value=memSort;
      const q=body.querySelector('#bmq');q.value=memQ;
      body.querySelector('#bmsort').addEventListener('change',e=>{memSort=e.target.value;listMem()});
      q.addEventListener('input',()=>{clearTimeout(q._t);q._t=setTimeout(()=>{memQ=q.value.trim().toLowerCase();listMem()},200)});
      body.querySelector('#bmsw').addEventListener('click',e=>{db.memEnabled=!db.memEnabled;save();e.currentTarget.classList.toggle('on',db.memEnabled);Toast.show(db.memEnabled?'Memories enabled':'Memories disabled')});
      body.querySelector('#bmtidy').addEventListener('click',()=>{const seen=new Set(),n=db.memories.length;db.memories=db.memories.filter(m=>{const k=(m.text||'').trim().toLowerCase();if(!k||seen.has(k))return false;seen.add(k);m.text=m.text.trim();return true});save();Toast.show(n-db.memories.length?`Tidy: removed ${n-db.memories.length} duplicate(s)`:'Tidy: nothing to clean');renderMem()});
      body.querySelector('#bmselect').addEventListener('click',()=>{memSel=!memSel;memPick.clear();editId=null;renderMem()});
      const del=body.querySelector('#bmdel');if(del)del.addEventListener('click',()=>{if(!memPick.size){Toast.show('Nothing selected');return}db.memories=db.memories.filter(m=>!memPick.has(m.id));memPick.clear();memSel=false;save();renderMem();Toast.show('Deleted')});
      body.querySelectorAll('#bmchips .tkchip').forEach(ch=>ch.addEventListener('click',()=>{memCat=ch.dataset.c;body.querySelectorAll('#bmchips .tkchip').forEach(x=>x.classList.toggle('on',x.dataset.c===memCat));listMem()}));
      listMem();
    }
    /* — skills — */
    function skRow(s){
      const conf=s.conf==null?'<span class="brn-conf">—</span>':`<span class="brn-conf ${s.conf>=80?'hi':'mid'}">${s.conf}%</span>`;
      const right=skMenu===s.id
        ?`<button class="btn mini" data-del="${escAttr(s.id)}">delete</button><button class="btn mini" data-cxl="1">cancel</button>`
        :`<span class="badge ${s.chip==='published'?'sent':''}">${escAttr(s.chip||'manual')}</span>${conf}<span class="brn-uses">${s.uses||0}u</span><button class="brn-kebab" data-k="${escAttr(s.id)}" title="actions">⋮</button>`;
      return`<div class="lprow ${skSel&&skPick.has(s.id)?'brn-pick':''}" data-id="${escAttr(s.id)}"><div style="flex:1;min-width:0"><b>${escAttr(s.name)}</b><div class="brn-desc">${escAttr(s.desc||'')}</div></div>${right}</div>`}
    function listSk(){
      const el=body.querySelector('#bslist');if(!el)return;
      let items=db.skills.filter(s=>!skQ||((s.name||'')+' '+(s.desc||'')).toLowerCase().includes(skQ));
      items=items.slice().sort((a,b)=>skSort==='name'?(a.name||'').localeCompare(b.name||''):skSort==='uses'?(b.uses||0)-(a.uses||0):(b.conf||0)-(a.conf||0));
      el.innerHTML=items.length?items.map(skRow).join(''):`<div class="qempty">${db.skills.length?'No skills match.':'No skills yet — add one in the <b>Add</b> tab.'}</div>`;
      el.querySelectorAll('.brn-kebab').forEach(k=>k.addEventListener('click',e=>{e.stopPropagation();skMenu=skMenu===k.dataset.k?null:k.dataset.k;listSk()}));
      el.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();db.skills=db.skills.filter(s=>s.id!==b.dataset.del);skMenu=null;save();renderSkills();Toast.show('Skill removed')}));
      el.querySelectorAll('[data-cxl]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();skMenu=null;listSk()}));
      el.querySelectorAll('.lprow').forEach(r=>r.addEventListener('click',()=>{if(!skSel)return;const id=r.dataset.id;skPick.has(id)?skPick.delete(id):skPick.add(id);r.classList.toggle('brn-pick');const d=body.querySelector('#bsdel');if(d)d.textContent=`Delete (${skPick.size})`}));
    }
    function renderSkills(){
      body.innerHTML=`<div class="brn-head"><b>Skills</b><span class="badge">${db.skills.length} skills</span><span class="brn-enl">Enabled</span><div class="sw3 ${db.skillsEnabled?'on':''}" id="bssw"><i></i></div></div>
        <div class="brn-toolbar"><select id="bssort" class="brn-sel"><option value="conf">Confidence</option><option value="name">Name</option><option value="uses">Most used</option></select><button class="btn mini" id="bsaudit">＋ Audit</button><button class="btn mini" id="bsselect">${skSel?'Done':'Select'}</button>${skSel?`<button class="btn mini" id="bsdel">Delete (${skPick.size})</button>`:''}</div>
        <input class="brn-search" id="bsq" placeholder="Search skills...">
        <div id="bslist"></div>`;
      body.querySelector('#bssort').value=skSort;
      const q=body.querySelector('#bsq');q.value=skQ;
      body.querySelector('#bssort').addEventListener('change',e=>{skSort=e.target.value;listSk()});
      q.addEventListener('input',()=>{clearTimeout(q._t);q._t=setTimeout(()=>{skQ=q.value.trim().toLowerCase();listSk()},200)});
      body.querySelector('#bssw').addEventListener('click',e=>{db.skillsEnabled=!db.skillsEnabled;save();e.currentTarget.classList.toggle('on',db.skillsEnabled);Toast.show(db.skillsEnabled?'Skills enabled':'Skills disabled')});
      body.querySelector('#bsaudit').addEventListener('click',()=>{const names=db.skills.map(s=>(s.name||'').toLowerCase());const dups=names.length-new Set(names).size;const low=db.skills.filter(s=>s.conf!=null&&s.conf<cfg.minConf).length;const nohow=db.skills.filter(s=>!s.how).length;Toast.show(`Audit: ${dups} duplicate name(s) · ${low} below ${cfg.minConf}% · ${nohow} missing "how"`)});
      body.querySelector('#bsselect').addEventListener('click',()=>{skSel=!skSel;skPick.clear();skMenu=null;renderSkills()});
      const del=body.querySelector('#bsdel');if(del)del.addEventListener('click',()=>{if(!skPick.size){Toast.show('Nothing selected');return}db.skills=db.skills.filter(s=>!skPick.has(s.id));skPick.clear();skSel=false;save();renderSkills();Toast.show('Deleted')});
      listSk();
    }
    /* — add — */
    function renderAdd(){
      body.innerHTML=`<div class="brn-head"><b>Add Memory</b><span style="margin-left:auto;display:flex;gap:6px"><button class="btn mini" id="bimp">Import</button><button class="btn mini" id="bexp">Export</button></span></div>
        <div style="display:flex;gap:6px;margin-bottom:16px"><input class="brn-search" id="bamt" style="margin-bottom:0" placeholder="Add a memory — e.g. 'I prefer concise replies'"><select id="bamty" class="brn-sel">${TYPES.map(t=>`<option${t==='fact'?' selected':''}>${t}</option>`).join('')}</select><button class="btn mini" id="bamadd">＋ Add</button></div>
        <div class="brn-head"><b>Add Skill</b></div>
        <div style="display:flex;gap:6px;margin-bottom:10px"><input class="brn-search" id="basu" style="margin-bottom:0" placeholder="Import URL — e.g. GitHub tree link to a skill folder"><button class="btn mini" id="basimp">Import</button></div>
        <div class="acctform" style="padding:0;overflow:visible">
          <div class="af-row"><label>Title</label><input id="bast"></div>
          <div class="af-row"><label>When to use</label><input id="basw"></div>
          <div class="af-row" style="align-items:flex-start"><label style="padding-top:8px">How</label><textarea id="bash" class="brn-ta" style="flex:1;width:auto"></textarea></div>
          <div class="af-row"><label>Tags</label><input id="basg" placeholder="comma, separated"></div>
          <div class="compose-actions" style="justify-content:flex-end"><button class="btn" id="basadd">ADD SKILL</button></div>
        </div>`;
      const addMem=()=>{const t=body.querySelector('#bamt').value.trim();if(!t){Toast.show('Write the memory');return}db.memories.unshift({id:'m'+Date.now().toString(36),text:t,type:body.querySelector('#bamty').value,source:'manual',uses:0,ts:Date.now()});save();body.querySelector('#bamt').value='';Toast.show('Memory added')};
      body.querySelector('#bamadd').addEventListener('click',addMem);
      body.querySelector('#bamt').addEventListener('keydown',e=>{if(e.key==='Enter')addMem()});
      body.querySelector('#bexp').addEventListener('click',()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({memories:db.memories,skills:db.skills},null,2)],{type:'application/json'}));a.download='brain-export.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);Toast.show('Exported brain-export.json')});
      body.querySelector('#bimp').addEventListener('click',()=>{const f=document.createElement('input');f.type='file';f.accept='.json,application/json';
        f.addEventListener('change',()=>{const file=f.files[0];if(!file)return;const rd=new FileReader();
          rd.onload=()=>{try{const d=JSON.parse(rd.result);const mIn=Array.isArray(d.memories)?d.memories:[],sIn=Array.isArray(d.skills)?d.skills:[];const hm=new Set(db.memories.map(m=>m.id)),hs=new Set(db.skills.map(s=>s.id));let n=0;
            mIn.forEach(m=>{if(m&&m.id&&m.text&&!hm.has(m.id)){db.memories.push(m);n++}});
            sIn.forEach(s=>{if(s&&s.id&&s.name&&!hs.has(s.id)){db.skills.push(s);n++}});
            save();Toast.show('Imported '+n+' item(s)')}catch(e){Toast.show('Invalid JSON file')}};
          rd.readAsText(file)});
        f.click()});
      body.querySelector('#basimp').addEventListener('click',()=>Toast.show('Skill import from URL — coming soon'));
      body.querySelector('#basadd').addEventListener('click',()=>{const name=body.querySelector('#bast').value.trim();if(!name){Toast.show('Title required');return}
        db.skills.push({id:'sk'+Date.now().toString(36),name,desc:body.querySelector('#basw').value.trim(),how:body.querySelector('#bash').value.trim(),tags:body.querySelector('#basg').value.split(',').map(s=>s.trim()).filter(Boolean),chip:'manual',conf:null,uses:0});
        save();['#bast','#basw','#bash','#basg'].forEach(s=>body.querySelector(s).value='');Toast.show('Skill added')});
    }
    /* — settings (brain config in Store + connected models via bridge) — */
    function renderSettings(){
      body.innerHTML=`<div class="sethead">MEMORY</div>
        <div class="autotoggle"><div><b>Auto-extract memories</b><div class="sub">save facts from conversations automatically</div></div><div class="sw3 ${cfg.autoMem?'on':''}" data-k="autoMem"><i></i></div></div>
        <div class="sethead">SKILLS</div>
        <div class="autotoggle"><div><b>Auto-extract skills</b><div class="sub">learn reusable skills from what works</div></div><div class="sw3 ${cfg.autoSkill?'on':''}" data-k="autoSkill"><i></i></div></div>
        <div class="autotoggle"><div><b>Auto-approve skills</b><div class="sub">publish extracted skills without review</div></div><div class="sw3 ${cfg.autoApprove?'on':''}" data-k="autoApprove"><i></i></div></div>
        <div class="setline"><span style="flex:1">Minimum confidence <b id="bcfv" style="font-family:var(--mono)">≥${cfg.minConf}%</b></span><input type="range" min="50" max="100" step="1" value="${cfg.minConf}" id="bcf" class="brn-range"></div>
        <div class="sethead">INJECT SKILLS</div>
        <div class="setline"><span style="flex:1">Max skills per request</span><button class="btn mini" id="bmsdec">−</button><span class="brn-stepv" id="bmsv">${cfg.maxSkills}</span><button class="btn mini" id="bmsinc">＋</button></div>
        <div class="sethead">CONNECTED MODELS</div><div id="brnmodels"></div>`;
      body.querySelectorAll('.sw3[data-k]').forEach(sw=>sw.addEventListener('click',()=>{cfg[sw.dataset.k]=!cfg[sw.dataset.k];sw.classList.toggle('on',cfg[sw.dataset.k]);Store.save()}));
      body.querySelector('#bcf').addEventListener('input',e=>{cfg.minConf=+e.target.value;body.querySelector('#bcfv').textContent='≥'+cfg.minConf+'%';Store.save()});
      const stepv=body.querySelector('#bmsv');
      body.querySelector('#bmsdec').addEventListener('click',()=>{cfg.maxSkills=Math.max(1,cfg.maxSkills-1);stepv.textContent=cfg.maxSkills;Store.save()});
      body.querySelector('#bmsinc').addEventListener('click',()=>{cfg.maxSkills=Math.min(10,cfg.maxSkills+1);stepv.textContent=cfg.maxSkills;Store.save()});
      loadModels();
    }
    async function loadModels(){
      const mEl=body.querySelector('#brnmodels');if(!mEl)return;
      if(!Bridge.on()){needBridge(mEl);return}
      let provs=[];try{provs=await RPC('models','listProviders')}catch(e){showErr(mEl,e);return}
      if(!body.querySelector('#brnmodels'))return;
      mEl.innerHTML=`<div class="acctform" style="padding:6px 0">`+(provs.length?provs.map(pr=>`<div class="acctrow"><div style="flex:1;min-width:0"><b>${escHtml(pr.label||pr.provider)}</b> <span class="badge">${escHtml(pr.kind)}</span><div class="brn-desc">${escHtml(pr.baseUrl||'')}</div></div><button class="btn mini" data-rm="${pr.id}">remove</button></div>`).join(''):'<div class="qempty">No models. Add a local server or an API.</div>')+`<div class="af-sec">＋ Add</div><div class="af-row"><label>Type</label><select id="brk"><option value="api">API (cloud)</option><option value="local">Local (Ollama/vLLM)</option></select></div><div class="af-row"><label>Provider</label><input id="brp" placeholder="anthropic / openai / deepseek / ollama"></div><div class="af-row"><label>Base URL</label><input id="bru" placeholder="https://api…/v1  or  http://localhost:11434/v1"></div><div class="af-row"><label>API key</label><input id="brkey" type="password" placeholder="(empty for local)"></div><div id="brmsg" style="font-size:10px"></div><div class="compose-actions"><button class="btn" id="brtest">TEST</button><button class="btn" id="bradd">ADD</button></div></div>`;
      mEl.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{await RPC('models','removeProvider',b.dataset.rm);loadModels()}));
      const cfgOf=()=>({kind:mEl.querySelector('#brk').value,provider:mEl.querySelector('#brp').value.trim(),label:mEl.querySelector('#brp').value.trim(),baseUrl:mEl.querySelector('#bru').value.trim(),apiKey:mEl.querySelector('#brkey').value});
      mEl.querySelector('#brtest').addEventListener('click',async()=>{const m=mEl.querySelector('#brmsg');m.textContent='testing…';try{const r=await RPC('models','testProvider',cfgOf());m.style.color=r.ok?'var(--ok)':'var(--accent)';m.textContent=r.ok?('✓ '+(r.models?r.models.length+' models':'ok')):('✗ '+(r.error||'failed'))}catch(e){m.style.color='var(--accent)';m.textContent=e.message}});
      // Check the key against the vendor BEFORE storing it — the same guard MY MACHINE got,
      // which this door never received. TEST sits right here, but its verdict did not gate
      // ADD: press ADD without testing, or after a failed test, and the app said "Model
      // added" over a key that can never work. Connecting a model is the only thing between
      // a new owner and a working app; failing it silently reads as the app being broken.
      mEl.querySelector('#bradd').addEventListener('click',async()=>{
        const c=cfgOf(),m=mEl.querySelector('#brmsg'),btn=mEl.querySelector('#bradd');
        btn.disabled=true;btn.textContent='CHECKING…';m.style.color='';m.textContent='checking the key with the provider…';
        let t=null;try{t=await RPC('models','testProvider',c)}catch(e){t={ok:false,error:(e&&e.message)||'could not reach the provider'}}
        btn.disabled=false;btn.textContent='ADD';
        if(!t||!t.ok){m.style.color='var(--accent)';m.textContent='✗ '+friendlyErr((t&&t.error)||'the provider did not accept this');return}
        const r=await RPC('models','addProvider',c);
        if(r.ok){m.textContent='';Toast.show('Model added · '+((t.models&&t.models.length)?t.models.length+' models':'ok'));loadModels()}
        else{m.style.color='var(--accent)';m.textContent='✗ '+((r&&r.error)||'failed')}});
    }
    function render(){if(tab==='memories')renderMem();else if(tab==='skills')renderSkills();else if(tab==='add')renderAdd();else renderSettings()}
    render();
  }
