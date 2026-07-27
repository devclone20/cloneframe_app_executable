  function wireCompare(p){
    const body=p.querySelector('#cmpbody'),cfg=p.querySelector('#cmpcfg');
    if(!Bridge.on()){needBridge(body);return}
    const DEF={blind:true,parallel:true,shuffle:false,type:'chat',timeout:300,models:[]};
    let st=Object.assign({},DEF,Store.get().compareCfg||{});
    // pid = the provider that serves this model. Without it the run went to whichever
    // provider sorted first, so a cross-vendor comparison hit one vendor with every model.
    // Older saved selections carry only a display label — they still run, unrouted, as before.
    st.models=(st.models||[]).map(m=>typeof m==='string'?{model:m,prov:'',pid:''}:Object.assign({pid:''},m)).filter(m=>m&&m.model);
    const shortModel=s=>{const i=String(s).indexOf('::');return i>0?String(s).slice(i+2):String(s)};
    const wireId=m=>m.pid?m.pid+'::'+m.model:m.model;
    const tOut=()=>Math.max(5,Math.min(3600,parseInt(cfg.querySelector('#cmptimeout').value,10)||300));
    function renderCfg(){
      cfg.innerHTML=`<div class="cmpv2sub">Select models to compare side-by-side. Send the same prompt to all.</div>
        <div class="cmpv2lbl">Mode:</div>
        <div class="cmpv2chips">
          <button class="cmpv2chip${st.blind?' on':''}" data-mode="blind"><span class="cmpv2ci">⊘</span>Blind</button>
          <button class="cmpv2chip${st.parallel?' on':''}" data-mode="parallel"><span class="cmpv2ci">≡</span>Parallel</button>
          <button class="cmpv2chip${st.shuffle?' on':''}" data-mode="shuffle"><span class="cmpv2ci">⇄</span>Shuffle</button>
          <button class="cmpv2chip" data-act="save"><span class="cmpv2ci">↧</span>Save</button>
          <button class="cmpv2chip" data-act="reset"><span class="cmpv2ci">↺</span>Reset</button>
        </div>
        <div class="cmpv2lbl">Type:</div>
        <div class="cmpv2chips">
          <button class="cmpv2chip${st.type==='chat'?' on':''}" data-type="chat"><span class="cmpv2ci">❝</span>Chat</button>
          <button class="cmpv2chip" data-type="agent"><span class="cmpv2ci">&gt;_</span>Agent</button>
          <button class="cmpv2chip" data-type="search"><span class="cmpv2ci">⌕</span>Search</button>
          <button class="cmpv2chip" data-type="research"><span class="cmpv2ci">⌕+</span>Research</button>
        </div>
        <div class="cmpv2mlist" id="cmpmlist"></div>
        <button class="cmpv2add" id="cmpadd">+ Add Model</button>
        <div class="cmpv2pick" id="cmppick" hidden></div>
        <div class="cmpv2foot"><label>Timeout:</label><input id="cmptimeout" type="number" min="5" max="3600" value="${st.timeout}"><span>seconds</span><button class="btn mini" id="cmpboard">⊞ Scoreboard</button></div>
        <div class="cmpv2div"></div>
        <div class="cmpv2run"><textarea id="cmpprompt" placeholder="prompt to send to all models…"></textarea><button class="cmpv2start" id="cmprun">▶ Start</button></div>`;
      cfg.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.mode;st[k]=!st[k];b.classList.toggle('on',st[k])}));
      cfg.querySelector('[data-act="save"]').addEventListener('click',()=>{st.timeout=tOut();Store.get().compareCfg=JSON.parse(JSON.stringify(st));Store.save();Toast.show('Comparison setup saved')});
      cfg.querySelector('[data-act="reset"]').addEventListener('click',()=>{st=Object.assign({},DEF,{models:[]});delete Store.get().compareCfg;Store.save();renderCfg();Toast.show('Reset to defaults')});
      cfg.querySelectorAll('[data-type]').forEach(b=>b.addEventListener('click',()=>{const t=b.dataset.type;
        if(t!=='chat'){Toast.show(t[0].toUpperCase()+t.slice(1)+' runs — coming soon');return}
        st.type='chat';cfg.querySelectorAll('[data-type]').forEach(x=>x.classList.toggle('on',x.dataset.type==='chat'))}));
      cfg.querySelector('#cmptimeout').addEventListener('change',()=>{st.timeout=tOut()});
      cfg.querySelector('#cmpadd').addEventListener('click',()=>{const pk=cfg.querySelector('#cmppick');if(pk.hidden)picker();else pk.hidden=true});
      cfg.querySelector('#cmpboard').addEventListener('click',scoreboard);
      cfg.querySelector('#cmprun').addEventListener('click',runCompare);
      renderList();
    }
    function renderList(){const el=cfg.querySelector('#cmpmlist');
      el.innerHTML=st.models.length?st.models.map((m,i)=>`<div class="cmpv2mrow"><button class="cmpv2mx" data-i="${i}" title="remove">✕</button><div class="cmpv2mfield">${escHtml(m.model)}${m.prov?' ('+escHtml(m.prov)+')':''}</div></div>`).join(''):'<div class="cmpv2mrow"><div class="cmpv2mfield dimmed">no models selected — use + Add Model</div></div>';
      el.querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click',()=>{st.models.splice(+b.dataset.i,1);renderList();const pk=cfg.querySelector('#cmppick');if(!pk.hidden)picker()}));}
    async function picker(){const pk=cfg.querySelector('#cmppick');pk.hidden=false;pk.innerHTML='<div class="qempty">loading models…</div>';
      let provs=[];try{provs=await RPC('models','listProviders')}catch(e){pk.innerHTML='<div class="qempty">'+escHtml(e.message||'failed to list providers')+'</div>';return}
      provs=(provs||[]).filter(pr=>pr.enabled!==false);
      if(!provs.length){pk.innerHTML='<div class="qempty">No providers connected — add models in Brain.</div><button class="btn mini" id="cmpbrain" style="align-self:center">open Brain</button>';pk.querySelector('#cmpbrain').addEventListener('click',()=>openPanel('brain'));return}
      // Keyed by provider AND model: two vendors can offer the same model name, and one
      // checkbox must not tick for both. Selections saved before this carry no provider —
      // they still run unrouted, and ticking that model here replaces them with a routed one.
      const sel=new Set(st.models.filter(m=>m.pid).map(wireId));
      pk.innerHTML=provs.map(pr=>{const lb=pr.label||pr.provider,off=new Set(pr.disabledModels||[]),ms=(pr.models||[]).filter(m=>!off.has(m));
        return `<div class="cmpv2ph">${escAttr(lb)}</div>`+(ms.length?ms.map(m=>`<label class="cmpv2pl"><input type="checkbox" data-m="${escAttr(m)}" data-p="${escAttr(pr.id)}" data-l="${escAttr(lb)}"${sel.has(pr.id+'::'+m)?' checked':''}>${escAttr(m)}</label>`).join(''):`<button class="btn mini" data-load="${escAttr(pr.id)}" style="align-self:flex-start">load models</button>`)}).join('');
      pk.querySelectorAll('input[data-m]').forEach(c=>c.addEventListener('change',()=>{const m=c.dataset.m,pid=c.dataset.p,lb=c.dataset.l;
        st.models=st.models.filter(x=>!(x.model===m&&(x.pid===pid||!x.pid))); // clear this exact pick and any unrouted leftover
        if(c.checked)st.models.push({model:m,prov:lb,pid});
        renderList()}));
      pk.querySelectorAll('[data-load]').forEach(b=>b.addEventListener('click',async()=>{b.textContent='probing…';try{await RPC('models','listModels',b.dataset.load)}catch(e){}picker()}));}
    function renderResults(results){
      let arr=(results||[]).slice();
      if(st.shuffle)for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]]}
      if(!arr.length){body.innerHTML='<div class="qempty">No results.</div>';return}
      const blind=st.blind&&arr.length>1;
      body.innerHTML=(blind?'<div class="cmpv2rev"><span class="dim">blind mode — model names hidden</span><button class="btn mini" id="cmpreveal">reveal</button></div>':'')+
        // The wire id carries the provider; the column header shows the model, not the id.
        '<div class="cmpgrid">'+arr.map((x,i)=>`<div class="cmpcol"><div class="cmphd"><span class="cmpv2nm" data-real="${escAttr(shortModel(x.model))}">${blind?'MODEL '+String.fromCharCode(65+i):escAttr(shortModel(x.model))}</span> <span class="dim">${x.ms?x.ms+'ms':''}</span></div><div class="cmptext">${x.error?'<span style="color:var(--accent)">'+escAttr(x.error)+'</span>':escAttr(x.text||'')}</div></div>`).join('')+'</div>';
      if(blind)body.querySelector('#cmpreveal').addEventListener('click',()=>{body.querySelectorAll('.cmpv2nm').forEach(n=>{n.textContent=n.dataset.real});body.querySelector('#cmpreveal').remove()});}
    async function runCompare(){
      const prompt=cfg.querySelector('#cmpprompt').value.trim(),models=st.models.map(wireId);
      if(!prompt||!models.length){Toast.show('Prompt + at least one model');return}
      const timeoutMs=tOut()*1000;
      try{
        let results=[];
        if(st.parallel){
          body.innerHTML='<div class="qempty">running on '+models.length+' models in parallel…</div>';
          const r=await RPC('compare','run',{prompt,models,timeoutMs});
          results=r.results||[];
          if(r.error&&!results.length){body.innerHTML='<div class="qempty">'+escHtml(r.error)+'</div>';return}
        }else{
          for(let i=0;i<models.length;i++){
            body.innerHTML='<div class="qempty">running '+escHtml(shortModel(models[i]))+' ('+(i+1)+'/'+models.length+')…</div>';
            const r=await RPC('compare','run',{prompt,models:[models[i]],timeoutMs});
            results.push(...(r.results||[]));
          }
        }
        renderResults(results);
      }catch(e){showErr(body,e)}}
    async function scoreboard(){
      let runs=[];try{runs=await RPC('compare','history',{limit:20})}catch(e){showErr(body,e);return}
      body.innerHTML='<div class="cmpv2rev"><span class="dim">scoreboard — past runs (click to view)</span></div>'+
        (runs.length?runs.map(r=>`<div class="lprow" data-id="${escAttr(r.id)}"><div style="flex:1;min-width:0"><b>${escAttr((r.prompt||'').slice(0,80))}</b><div class="dim" style="font-size:10px">${(r.models||[]).length} models · ${fmtTS(r.createdAt)}</div></div><button class="btn mini" data-del="${escAttr(r.id)}">✕</button></div>`).join(''):'<div class="qempty">No runs yet. Press Start to create the first.</div>');
      body.querySelectorAll('.lprow[data-id]').forEach(row=>row.addEventListener('click',async()=>{try{const run=await RPC('compare','get',row.dataset.id);if(run)renderResults(run.results||[])}catch(e){showErr(body,e)}}));
      body.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();await RPC('compare','remove',b.dataset.del);scoreboard()}));}
    renderCfg();
    body.innerHTML='<div class="qempty">Add models, write a prompt, press Start.</div>';
  }
