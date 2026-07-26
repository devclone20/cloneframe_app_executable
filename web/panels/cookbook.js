  function wireCookbook(p){
    const body=p.querySelector('#ckbody'),tabs=p.querySelector('#cktabs');
    const st=Store.get();
    st.cookbook=Object.assign({hfToken:'',modelDirs:['~/.cache/huggingface/hub'],servers:[{name:'Local',host:'',port:'',python:'None',venv:'~/venv',def:false}],engine:'llama.cpp',quant:'Q4-K',ctx:50,fit:'RAM',srv:'Local'},st.cookbook||{});
    const cfg=st.cookbook;
    if(!Array.isArray(cfg.modelDirs)||!cfg.modelDirs.length)cfg.modelDirs=['~/.cache/huggingface/hub'];
    if(!Array.isArray(cfg.servers)||!cfg.servers.length)cfg.servers=[{name:'Local',host:'',port:'',python:'None',venv:'~/venv',def:false}];
    const save=()=>Store.save();
    const soon=w=>Toast.show(w+' — coming soon');
    const srvOpts=()=>cfg.servers.map(s=>`<option ${s.name===cfg.srv?'selected':''}>${escHtml(s.name)}</option>`).join('');
    const wireSrvSel=el=>el.addEventListener('change',()=>{cfg.srv=el.value;save()});
    const INFO={engine:'Inference engine used to run the model (llama.cpp / MLX / vLLM).',quant:'Quantization — smaller is less VRAM, slightly lower quality.',ctx:'Context window the model is served with.'};
    const CATALOG=[
      {n:'gemma-4E2B-it',q:'Q4-K',pr:'5.1B',v:'5.5G',c:'49k',s:'32.9 t/s',sc:'74.8',m:'llama.cpp'},
      {n:'qwen2.5-14b-instruct',q:'Q4-K',pr:'14.8B',v:'9.0G',c:'32k',s:'18.4 t/s',sc:'79.2',m:'llama.cpp'},
      {n:'llama-3.3-8b-instruct',q:'Q5-K',pr:'8.0B',v:'6.2G',c:'128k',s:'26.1 t/s',sc:'76.5',m:'llama.cpp'},
      {n:'mistral-small-3.2',q:'Q3-K',pr:'24B',v:'10.2G',c:'32k',s:'11.2 t/s',sc:'81.0',m:'llama.cpp'},
      {n:'phi-4',q:'Q4-K',pr:'14.7B',v:'8.9G',c:'16k',s:'19.7 t/s',sc:'77.9',m:'llama.cpp'},
      {n:'deepseek-r1-distill-7b',q:'Q4-K',pr:'7.6B',v:'5.1G',c:'64k',s:'28.3 t/s',sc:'75.4',m:'llama.cpp'},
      {n:'qwen2.5-coder-7b',q:'Q4-K',pr:'7.6B',v:'5.0G',c:'32k',s:'29.0 t/s',sc:'74.1',m:'mlx'},
      {n:'smollm3-3b',q:'Q8-0',pr:'3.1B',v:'3.6G',c:'64k',s:'41.5 t/s',sc:'68.7',m:'mlx'},
    ];
    let hw=['Apple M5','10.7 GB VRAM','11.2 / 16.0 GB RAM','10 cores','metal'];
    let tab='launch';
    tabs.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.t;tabs.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));render()}));
    function render(){if(tab==='launch')launch();else if(tab==='download')download();else if(tab==='deps')deps();else if(tab==='settings')settings();else recipes()}

    /* — Launch: real local providers (models.mjs) — */
    async function launch(){
      body.innerHTML=`<div class="ckcard"><div class="ckhead"><b>Serve</b></div><div class="ckcardbody">
          <div class="ckline"><span class="ckpath" id="ckdir">${escHtml(cfg.modelDirs[0])}</span><a class="cklink" id="ckedit">edit</a></div>
          <div class="ckline"><select class="cksel" id="cksrv">${srvOpts()}</select><input class="ckin" id="cknm" placeholder="Name" style="flex:0 0 110px"><input class="ckin" id="ckq" placeholder="Search cached models…"><button class="btn mini" id="cksel2">Select</button></div>
          <div class="tkchips" id="ckfil"></div>
        </div></div>
        <div id="ckmdls"><div class="qempty">scanning local model servers…</div></div>`;
      wireSrvSel(body.querySelector('#cksrv'));
      body.querySelector('#ckedit').addEventListener('click',()=>{const d=body.querySelector('#ckdir');if(!d||d.tagName==='INPUT')return;d.outerHTML=`<input class="ckin" id="ckdir" value="${escAttr(cfg.modelDirs[0])}" style="font-family:var(--mono);flex:0 0 260px">`;const i=body.querySelector('#ckdir');i.focus();i.addEventListener('change',()=>{const v=i.value.trim();if(v)cfg.modelDirs[0]=v;save();launch()})});
      body.querySelector('#cksel2').addEventListener('click',()=>{const nm=body.querySelector('#cknm').value.trim();soon('Serve'+(nm?' "'+nm+'"':''))});
      const list=body.querySelector('#ckmdls');let items=[],fil='all',q='';
      let est=null,eready=new Set(),eavail=999;
      if(Bridge.on()){try{(await RPC('models','listProviders')).filter(x=>x.kind==='local').forEach(pr=>(pr.models||[]).forEach(m=>items.push({name:m,id:m,src:pr.label||pr.provider,sub:pr.baseUrl||'',gb:0})))}catch(e){}}
      function paint(){
        const fc=body.querySelector('#ckfil');if(!fc)return;
        fc.innerHTML=`<span class="tkchip ${fil==='all'?'on':''}" data-f="all">all (${items.length})</span><span class="tkchip ${fil==='llm'?'on':''}" data-f="llm">llm (${items.length})</span>`;
        fc.querySelectorAll('.tkchip').forEach(c=>c.addEventListener('click',()=>{fil=c.dataset.f;paint()}));
        if(!items.length){if(!Bridge.on()){needBridge(list);return}list.innerHTML='<div class="qempty">No cached models found. Add a local provider (Ollama · llama.cpp · vLLM) in BRAIN.</div>';return}
        const COL=['#e06c75','var(--info)','var(--ok)','var(--warn)','#c678dd'];const ci=s=>COL[[...String(s)].reduce((a,c)=>a+c.charCodeAt(0),0)%COL.length];
        const ff=items.filter(i=>!q||i.name.toLowerCase().includes(q)).sort((a,b)=>(eready.has(b.id)?1:0)-(eready.has(a.id)?1:0)||(a.gb>eavail?1:0)-(b.gb>eavail?1:0));
        list.innerHTML=ff.length?ff.map(i=>{const rdy=eready.has(i.id),big=i.gb>eavail;const tag=i.src==='exo'?(rdy?'<span class="ckhfb" style="color:var(--ok)">● running</span>':big?'<span class="ckhfb" style="color:var(--warn)">⚠ needs '+i.gb.toFixed(0)+'GB</span>':'<span class="ckhfb" style="color:var(--ok)">fits · '+(i.gb>=1?i.gb.toFixed(1)+'GB':Math.round(i.gb*1024)+'MB')+'</span>'):'<span class="ckhfb">'+escAttr(i.src)+' ↗</span>';return `<div class="ckmdl"><span class="ckdot" style="background:${ci(i.src)}"></span><div style="flex:1;min-width:0"><span class="ckname" style="color:${ci(i.src)}">${escAttr(i.name)}</span> ${tag}<div class="cksub">${escAttr(i.src)} · ${escAttr(i.sub)}</div></div>${rdy?`<button class="btn mini" data-del="${escAttr(i.id)}" style="border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent)">delete</button>`:`<button class="btn mini" data-l="${escAttr(i.id)}" data-src="${escAttr(i.src)}" data-gb="${i.gb}">launch</button>`}</div>`}).join(''):'<div class="qempty">No models match.</div>';
        list.querySelectorAll('[data-l]').forEach(b=>b.addEventListener('click',()=>{soon('Launch "'+b.dataset.l+'"')}));
      }
      body.querySelector('#ckq').addEventListener('input',e=>{q=e.target.value.trim().toLowerCase();paint()});
      paint();
    }

    /* — Download: static catalog (no downloader backend yet) — */
    function download(){
      let dd=true,tr=false,asc=true,q='';
      body.innerHTML=`<div class="ckcard"><div class="ckhead"><b>Direct Download</b><button class="ckchev" id="ckddc">▾</button></div>
          <div class="ckcardbody" id="ckddb">
            <div class="ckline"><input class="ckin" id="ckdd" placeholder="org/model-name, qwen2.5:14b, or HF URL"><button class="btn mini" id="ckdl">Download</button></div>
            <a class="cklink" id="cktr">Popular models · curated sample ▸</a>
            <div id="cktrl" style="display:flex;flex-direction:column;gap:5px"></div>
          </div></div>
        <div class="ckcard"><div class="ckhead"><b>Scan / Download</b></div>
          <div class="ckcardbody">
            <div class="ckline"><select class="cksel"><option>Standard</option></select><input class="ckin" id="cksq" placeholder="Search models…"><span class="cklbl">Engine<span class="ckinfo" title="${INFO.engine}">?</span></span><select class="cksel" id="ckeng"><option>llama.cpp</option><option>MLX</option><option>vLLM</option></select><span class="cklbl">Quant<span class="ckinfo" title="${INFO.quant}">?</span></span><select class="cksel" id="ckqu"><option>Q4-K</option><option>Q5-K</option><option>Q8-0</option><option>FP16</option></select><span class="cklbl">Context<span class="ckinfo" title="${INFO.ctx}">?</span></span><input type="range" class="ckrange" id="ckctx" min="4" max="128" value="${cfg.ctx}"><b id="ckctxv" style="font-family:var(--mono);font-size:10px">${cfg.ctx}k</b></div>
            <div class="ckline"><select class="cksel" id="cksrv2">${srvOpts()}</select><span class="ckseg" id="ckfit"><button data-m="RAM" class="${cfg.fit==='RAM'?'on':''}">RAM</button><button data-m="GPU" class="${cfg.fit==='GPU'?'on':''}">GPU</button><button data-m="EDIT">EDIT</button></span></div>
            <div class="ckline" id="ckhwl"></div>
            <div style="overflow:auto"><table class="cktable"><thead><tr><th>FIT</th><th class="cksort" id="ckms">MODEL (LATEST) <span id="ckarr">▾</span></th><th>PARAM</th><th>QUANT</th><th>VRAM</th><th>CTX</th><th>SPEED</th><th>SCORE</th><th>MODE</th></tr></thead><tbody id="cktb"></tbody></table></div>
          </div></div>`;
      wireSrvSel(body.querySelector('#cksrv2'));
      body.querySelector('#ckddc').addEventListener('click',e=>{dd=!dd;body.querySelector('#ckddb').style.display=dd?'':'none';e.target.textContent=dd?'▾':'▸'});
      body.querySelector('#ckdl').addEventListener('click',()=>{const v=body.querySelector('#ckdd').value.trim();if(!v){Toast.show('Enter a model id or HF URL');return}soon('Download "'+v+'"')});
      body.querySelector('#cktr').addEventListener('click',()=>{tr=!tr;body.querySelector('#cktr').textContent='Popular models · curated sample '+(tr?'▾':'▸');const tl=body.querySelector('#cktrl');tl.innerHTML=tr?CATALOG.slice(0,3).map(r=>`<div class="ckline"><span class="ckfit">PERFECT</span><b style="font-size:10.5px;color:var(--fg)">${r.n}</b><span class="cksub">${r.pr} · ${r.v} VRAM · ${r.m}</span><button class="btn mini" style="margin-left:auto" data-t2="${r.n}">Download</button></div>`).join(''):'';tl.querySelectorAll('[data-t2]').forEach(b=>b.addEventListener('click',()=>soon('Download "'+b.dataset.t2+'"')))});
      const eng=body.querySelector('#ckeng'),qu=body.querySelector('#ckqu');
      eng.value=cfg.engine;qu.value=cfg.quant;
      eng.addEventListener('change',()=>{cfg.engine=eng.value;save()});
      qu.addEventListener('change',()=>{cfg.quant=qu.value;save()});
      const rng=body.querySelector('#ckctx');
      rng.addEventListener('input',()=>{body.querySelector('#ckctxv').textContent=rng.value+'k'});
      rng.addEventListener('change',()=>{cfg.ctx=+rng.value;save()});
      body.querySelectorAll('#ckfit button').forEach(b=>b.addEventListener('click',()=>{const m=b.dataset.m;if(m==='EDIT'){soon('Edit hardware profile');return}cfg.fit=m;save();body.querySelectorAll('#ckfit button').forEach(x=>x.classList.toggle('on',x.dataset.m===m))}));
      function paintHw(){const el=body.querySelector('#ckhwl');if(!el)return;el.innerHTML=hw.length?hw.map((h,i)=>`<span class="ckhwc">${escHtml(h)}<i data-x="${i}">✕</i></span>`).join(''):'<span class="cksub">no hardware profile</span>';el.querySelectorAll('[data-x]').forEach(x=>x.addEventListener('click',()=>{hw.splice(+x.dataset.x,1);paintHw()}))}
      function paintTb(){const tb=body.querySelector('#cktb');if(!tb)return;
        let rows=CATALOG.filter(r=>!q||r.n.toLowerCase().includes(q)).slice().sort((a,b)=>asc?a.n.localeCompare(b.n):b.n.localeCompare(a.n));
        tb.innerHTML=rows.length?rows.map(r=>`<tr data-dl="${r.n}" title="download ${r.n}"><td><span class="ckfit">PERFECT</span></td><td><svg style="width:11px;height:11px;vertical-align:-1px"><use href="#i-chip"/></svg> <b>${r.n}</b><span class="ckqtag">${r.q}</span></td><td>${r.pr}</td><td>${r.q}</td><td>${r.v}</td><td>${r.c}</td><td>${r.s}</td><td>${r.sc}</td><td>${r.m}</td></tr>`).join(''):'<tr><td colspan="9"><div class="qempty">No models match.</div></td></tr>';
        tb.querySelectorAll('[data-dl]').forEach(t=>t.addEventListener('click',()=>soon('Download "'+t.dataset.dl+'"')));}
      body.querySelector('#cksq').addEventListener('input',e=>{q=e.target.value.trim().toLowerCase();paintTb()});
      body.querySelector('#ckms').addEventListener('click',()=>{asc=!asc;body.querySelector('#ckarr').textContent=asc?'▾':'▴';paintTb()});
      paintHw();paintTb();
    }

    /* — Dependencies: real checks (Bridge) + visual catalog — */
    function deps(){
      const DEP={app:[
        ['APFEL','Built-in local inference runtime.','LLM',false],
        ['rembg','Background removal for images.','Image',false],
        ['realesrgan','Image upscaling (Real-ESRGAN).','Image',false],
        ['playwright','Headless browser automation.','Tools',false],
      ],srv:[
        ['tmux','Terminal multiplexer for serve sessions.','System',true],
        ['docker','Container runtime.','System',true],
        ['hf_transfer','Fast HuggingFace downloads.','LLM',false],
        ['llama_cpp','GGUF inference engine.','LLM',true,'llama'],
        ['sglang','High-throughput LLM serving.','LLM',false,'chev'],
        ['vllm','PagedAttention LLM serving.','LLM',false,'chev'],
        ['diffusers','Diffusion image pipelines.','Image',false],
        ['transformers','HF transformers models.','Image',false],
      ]};
      const row=d=>`<div class="ckdep"><svg><use href="#i-chip"/></svg><div style="flex:1;min-width:0"><b style="font-size:11px;color:var(--fg)">${d[0]}</b><div class="ckdesc">${d[1]}</div>${d[4]==='llama'?'<div class="ckdesc" style="font-family:var(--mono)">~/.local/bin/llama-server <a class="cklink" data-rb="1">Rebuild</a></div>':''}</div><span class="ckcat">${d[2]}</span><button class="ckst ${d[3]?'on':''}" data-in="${d[0]}" data-on="${d[3]?1:0}">${d[3]?'Installed':'Install'}</button>${d[4]?'<button class="ckchev" data-cv="1">▾</button>':''}</div>`;
      body.innerHTML=`<div class="ckline" style="margin-bottom:10px"><b style="font-size:12px;color:var(--fg);flex:1">Dependencies</b><span class="cklbl">Server</span><select class="cksel" id="cksrv3">${srvOpts()}</select></div>
        <div class="sethead">LIVE CHECKS</div><div id="cklive"></div>
        <div class="sethead">ODYSSEUS APP</div><div class="cksub" style="margin:-2px 2px 8px">Run inside the Odysseus app itself.</div>${DEP.app.map(row).join('')}
        <div class="sethead">SERVER</div><div class="cksub" style="margin:-2px 2px 8px">Run on the server chosen above (over SSH when remote).</div>${DEP.srv.map(row).join('')}`;
      wireSrvSel(body.querySelector('#cksrv3'));
      body.querySelectorAll('[data-in]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.on==='1'){Toast.show(b.dataset.in+' is installed');return}soon('Install '+b.dataset.in)}));
      body.querySelectorAll('[data-rb]').forEach(b=>b.addEventListener('click',()=>soon('Rebuild llama_cpp')));
      body.querySelectorAll('[data-cv]').forEach(b=>b.addEventListener('click',()=>soon('Engine options')));
      const dot=on=>`<span class="igdot ${on?'connected':''}"></span>`;
      const live=body.querySelector('#cklive');
      live.innerHTML=`<div class="ckdep">${dot(Bridge.on())}<div style="flex:1;min-width:0"><b style="font-size:11px;color:var(--fg)">HUB Bridge</b><div class="ckdesc">${Bridge.on()?'connected — shell + local RPC available':'not connected — open MY MACHINE to pair'}</div></div><span class="ckcat">System</span><button class="ckst ${Bridge.on()?'on':''}" id="ckbrst">${Bridge.on()?'Online':'Connect'}</button></div>`;
      live.querySelector('#ckbrst').addEventListener('click',()=>{if(!Bridge.on())openPanel('machine')});
    }

    /* — Settings: persisted in Store.get().cookbook — */
    function settings(){
      body.innerHTML=`<div class="ckcard"><div class="ckhead"><b>HuggingFace Token</b></div><div class="ckcardbody"><input class="ckin" id="ckhft" type="password" placeholder="hf_..." value="${escAttr(cfg.hfToken)}"></div></div>
        <div class="ckcard"><div class="ckhead"><b>Servers</b><button class="btn mini" id="cksadd">+ Add</button></div><div class="ckcardbody" id="cksrvs"></div></div>
        <div class="ckcard"><div class="ckhead"><b>Model Directory</b><button class="btn mini" id="ckdadd">+ Add</button></div><div class="ckcardbody"><div class="ckline" id="ckdirs"></div></div></div>`;
      body.querySelector('#ckhft').addEventListener('change',e=>{cfg.hfToken=e.target.value.trim();save();Toast.show('Token saved')});
      function paintSrvs(){
        body.querySelector('#cksrvs').innerHTML=cfg.servers.map((s,i)=>`<div class="ckcard" style="margin:0"><div class="ckhead"><span class="igdot ${i===0?'connected':''}"></span><b>${escAttr(s.name)}</b>${i>0?`<button class="btn mini" data-sx="${i}">✕</button>`:''}</div><div class="ckcardbody"><div class="ckline"><input class="ckin" data-k="host" data-i="${i}" placeholder="e.g. user@ip" value="${escAttr(s.host||'')}"><input class="ckin" data-k="port" data-i="${i}" placeholder="Port" value="${escAttr(s.port||'')}" style="flex:0 0 60px"><select class="cksel" data-k="python" data-i="${i}"><option ${s.python==='None'?'selected':''}>None</option><option ${s.python==='conda'?'selected':''}>conda</option><option ${s.python==='uv'?'selected':''}>uv</option></select><input class="ckin" data-k="venv" data-i="${i}" placeholder="~/venv" value="${escAttr(s.venv||'')}" style="flex:0 0 100px"><label class="cksub" style="display:flex;gap:4px;align-items:center;cursor:pointer"><input type="radio" name="ckdef" data-d="${i}" ${s.def?'checked':''}>default</label></div></div></div>`).join('');
        body.querySelectorAll('#cksrvs [data-k]').forEach(el=>el.addEventListener('change',()=>{const v=typeof el.value==='string'?el.value.trim():el.value;cfg.servers[+el.dataset.i][el.dataset.k]=v;save()}));
        body.querySelectorAll('#cksrvs [data-d]').forEach(el=>el.addEventListener('change',()=>{cfg.servers.forEach((s,j)=>s.def=j===+el.dataset.d);save()}));
        body.querySelectorAll('#cksrvs [data-sx]').forEach(b=>b.addEventListener('click',()=>{cfg.servers.splice(+b.dataset.sx,1);save();paintSrvs()}));
      }
      function paintDirs(){const el=body.querySelector('#ckdirs');if(!el)return;el.innerHTML=cfg.modelDirs.map((d,i)=>`<span class="ckhwc" style="font-family:var(--mono)">${escHtml(d)}${cfg.modelDirs.length>1?`<i data-x="${i}">✕</i>`:''}</span>`).join('');el.querySelectorAll('[data-x]').forEach(x=>x.addEventListener('click',()=>{cfg.modelDirs.splice(+x.dataset.x,1);save();paintDirs()}))}
      body.querySelector('#cksadd').addEventListener('click',()=>{cfg.servers.push({name:'Server '+(cfg.servers.length+1),host:'',port:'',python:'None',venv:'~/venv',def:false});save();paintSrvs()});
      body.querySelector('#ckdadd').addEventListener('click',()=>{const el=body.querySelector('#ckdirs');if(el.querySelector('input'))return;const inp=document.createElement('input');inp.className='ckin';inp.placeholder='/path/to/models';el.appendChild(inp);inp.focus();inp.addEventListener('change',()=>{const v=inp.value.trim();if(v){cfg.modelDirs.push(v);save()}paintDirs()})});
      paintSrvs();paintDirs();
    }

    /* — Recipes: existing prompt cookbook (cookbook.mjs) — */
    function recipes(){
      if(!Bridge.on()){needBridge(body);return}
      let cat='';
      async function load(){let items=[],cats=[];try{items=await RPC('cookbook','list',{category:cat})}catch(e){showErr(body,e);return}try{cats=await RPC('cookbook','categories')}catch(e){}
        body.innerHTML=`<div class="ckline" style="margin-bottom:6px"><div class="tkchips" id="ckchips"></div><button class="btn mini" id="cknew" style="margin-left:auto">+ recipe</button></div><div id="ckrl"></div>`;
        const chips=body.querySelector('#ckchips'),list=body.querySelector('#ckrl');
        chips.innerHTML=`<span class="tkchip ${cat===''?'on':''}" data-c="">all</span>`+cats.map(c=>`<span class="tkchip ${cat===c?'on':''}" data-c="${escAttr(c)}">${escAttr(c)}</span>`).join('');
        chips.querySelectorAll('.tkchip').forEach(el=>el.addEventListener('click',()=>{cat=el.dataset.c;load()}));
        list.innerHTML=items.length?items.map(r=>`<div class="lprow"><div style="flex:1;min-width:0"><b>${escHtml(r.name)}</b> ${(r.builtin||r.isBuiltin)?'<span class="badge">built-in</span>':''}<div class="dim" style="font-size:10px">${escHtml(r.description||'')}</div></div><button class="btn mini" data-run="${r.id}">use</button></div>`).join(''):'<div class="qempty">No recipes.</div>';
        list.querySelectorAll('[data-run]').forEach(b=>b.addEventListener('click',async()=>{const r=await RPC('cookbook','get',b.dataset.run);runForm(r)}));
        body.querySelector('#cknew').addEventListener('click',newForm);
      }
      function runForm(r){const uniq=[...new Set((String(r.template||'').match(/{{\s*([\w.-]+)\s*}}/g)||[]).map(v=>v.replace(/[{}\s]/g,'')))];
        body.innerHTML=`<div class="acctform"><div class="afh">${escAttr(r.name)}</div><div class="dim" style="font-size:10px">${escAttr(r.description||'')}</div>`+uniq.map(v=>`<div class="af-row"><label>${escAttr(v)}</label><input data-v="${escAttr(v)}"></div>`).join('')+`<div id="ckout" class="mailtext" style="max-height:200px;overflow:auto"></div><div class="compose-actions"><button class="btn" id="ckrun">RUN</button><button class="btn" id="ckback">← list</button></div></div>`;
        body.querySelector('#ckrun').addEventListener('click',async()=>{const out=body.querySelector('#ckout');out.textContent='thinking…';const vv={};body.querySelectorAll('[data-v]').forEach(i=>vv[i.dataset.v]=i.value);try{const res=await RPC('cookbook','run',r.id,vv);out.textContent=res.ok?res.output:(res.error||'failed')}catch(e){out.textContent=e.message}});
        body.querySelector('#ckback').addEventListener('click',load);}
      function newForm(){body.innerHTML=`<div class="acctform"><div class="afh">New recipe</div><div class="af-row"><label>Name</label><input id="ckn"></div><div class="af-row"><label>Category</label><input id="ckc" value="custom"></div><div class="af-row"><label>Description</label><input id="ckd"></div><textarea id="ckt" placeholder="Template with {{variables}}…" style="min-height:140px"></textarea><div class="compose-actions"><button class="btn" id="cksave">CREATE</button><button class="btn" id="ckcancel">← list</button></div></div>`;body.querySelector('#cksave').addEventListener('click',async()=>{const r=await RPC('cookbook','add',{name:body.querySelector('#ckn').value.trim()||'Recipe',category:body.querySelector('#ckc').value.trim()||'custom',description:body.querySelector('#ckd').value.trim(),template:body.querySelector('#ckt').value});if(r.ok){Toast.show('Created');load()}else Toast.show(r.error||'failed')});body.querySelector('#ckcancel').addEventListener('click',load)}
      load();
    }
    render();
  }
