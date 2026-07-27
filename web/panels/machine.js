  function wireMachine(p){
    const brains=p.querySelector('#mbrains');

    // BRAIN — BYOK with prefix detection (PROVIDER_PATTERNS pattern, reimplemented)
    const PROV=[['sk-ant-','Anthropic','https://api.anthropic.com/v1'],
                ['sk-or-','OpenRouter','https://openrouter.ai/api/v1'],
                ['sk-proj-','OpenAI','https://api.openai.com/v1'],
                ['sk-','OpenAI','https://api.openai.com/v1'],
                ['gsk_','Groq','https://api.groq.com/openai/v1'],
                ['AIza','Gemini','https://generativelanguage.googleapis.com/v1beta/openai'],
                ['xai-','xAI','https://api.x.ai/v1']];
    // Ask the vendor which models this key may actually call. A model id is NOT something to
    // guess: the app used to send the literal string "auto" to every provider, which no vendor
    // accepts, and the 400 that came back was hidden behind demo prose. Anthropic needs its
    // own header set (and its explicit browser opt-in) — everyone else is OpenAI-shaped.
    async function probeModels(base,key){
      const anthropic=/anthropic\.com/.test(base);
      const headers=anthropic
        ?{'x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}
        :{Authorization:'Bearer '+key};
      const r=await fetch(base+'/models',{headers});
      if(!r.ok)throw new Error(r.status+' '+((await r.text().catch(()=>''))||r.statusText).slice(0,160));
      const o=await r.json();
      const ids=(o.data||o.models||[]).map(m=>(typeof m==='string'?m:(m.id||m.name))).filter(Boolean);
      if(!ids.length)throw new Error('the provider listed no models for this key');
      return ids;
    }
    function renderBrains(){
      const b=Store.get().brain;
      const fixed=[['auto','AUTO — key → mock'],['mock','MOCK · demo']]
        .map(r=>`<div class="brainrow ${b.active===r[0]?'on':''}" data-b="${r[0]}">${r[1]}</div>`).join('');
      const provs=b.providers.map(pr=>{
        const live=!!Keys.get(pr.id);
        const models=pr.models||[];
        // The model picker and the switch are the two things an owner needs to reach without
        // deleting anything: park a key, try another, bring the first one back.
        const pick=models.length
          ? `<select class="brmodel" data-mid="${escAttr(pr.id)}">${models.map(m=>`<option value="${escAttr(m)}" ${m===pr.model?'selected':''}>${escHtml(m)}</option>`).join('')}</select>`
          : `<input class="brmodel" data-mid="${escAttr(pr.id)}" placeholder="model id" value="${escAttr(pr.model||'')}">`;
        return `<div class="brainrow ${b.active===pr.id?'on':''} ${pr.off?'brOff':''}" data-b="${escAttr(pr.id)}">
          ${escHtml(pr.name)}<span class="k">${escHtml(pr.masked)}${live?'':' · session expired'}</span>
          ${pick}
          <span class="brtog ${pr.off?'':'on'}" data-tog="${escAttr(pr.id)}" title="${pr.off?'Switch this key back on':'Switch this key off — it is kept, not deleted'}">${pr.off?'OFF':'ON'}</span>
          <span class="rmk" data-rm="${escAttr(pr.id)}">remove</span></div>`;
      }).join('');
      brains.innerHTML=fixed+provs;
    }
    brains.addEventListener('click',e=>{
      const b=Store.get().brain;
      const rm=e.target.dataset.rm,tog=e.target.dataset.tog;
      if(rm){b.providers=b.providers.filter(x=>x.id!==rm);Keys.del(rm);if(b.active===rm)b.active='auto';Store.save();Brain.update();renderBrains();return}
      // OFF parks the key without discarding it: the session key stays, the record stays, and
      // nothing routes to it until it is switched back on.
      if(tog){const p=b.providers.find(x=>x.id===tog);if(p){p.off=!p.off;Store.save();Brain.update();renderBrains();Toast.show(p.name+(p.off?' switched off — key kept':' switched on'))}return}
      if(e.target.classList.contains('brmodel'))return; // the picker is not a row selection
      const row=e.target.closest('.brainrow');if(!row)return;
      b.active=row.dataset.b;Store.save();Brain.update();renderBrains();
    });
    const saveModel=el=>{
      const b=Store.get().brain,p=b.providers.find(x=>x.id===el.dataset.mid);
      if(!p)return;const v=(el.value||'').trim();if(v===p.model)return;
      p.model=v;Store.save();Brain.update();
      if(v)Toast.show(p.name+' → '+v);
    };
    brains.addEventListener('change',e=>{if(e.target.classList.contains('brmodel'))saveModel(e.target)});
    brains.addEventListener('blur',e=>{if(e.target.classList&&e.target.classList.contains('brmodel'))saveModel(e.target)},true);
    p.querySelector('#mkeybtn').addEventListener('click',async()=>{
      const field=p.querySelector('#mkey'),btn=p.querySelector('#mkeybtn');
      const key=field.value.trim();
      if(!key)return;
      const hit=PROV.find(x=>key.startsWith(x[0]));
      if(!hit){Toast.show('Key prefix not recognized');return}
      const id=hit[1].toLowerCase(),b=Store.get().brain;
      const was=b.providers.find(x=>x.id===id); // pasting a key for a known provider REPLACES it
      btn.disabled=true;btn.textContent='CHECKING…';
      // The key is checked against the vendor BEFORE it is stored, so "connected" means the
      // vendor answered — not merely that the prefix looked familiar. This is also where the
      // model list comes from: guessing a model id is what produced the "auto" 400s.
      let models=[],err=null;
      try{models=await probeModels(hit[2],key)}catch(e){err=(e&&e.message)||'could not reach the provider'}
      btn.disabled=false;btn.textContent='CONNECT';
      if(err&&!was){Toast.show(hit[1]+' rejected the key — '+friendlyErr(err));return}
      const keep=was&&was.model&&models.includes(was.model)?was.model:(models[0]||(was&&was.model)||'');
      b.providers=b.providers.filter(x=>x.id!==id);
      b.providers.push({id,name:hit[1],base:hit[2],masked:'…'+key.slice(-4),present:true,models,model:keep,off:false});
      b.active=id;Store.save();
      Keys.set(id,key);
      field.value='';
      Brain.update();renderBrains();
      Toast.show(err
        ?(hit[1]+' key stored, but its model list is unreachable — '+friendlyErr(err))
        :(hit[1]+' connected · '+(keep||'pick a model')+(was?' — key replaced':'')));
    });
    // ---- HUB BRIDGE ----
    const brStat=p.querySelector('#brstat'),brInfo=p.querySelector('#brinfo'),brEp=p.querySelector('#brep');
    function paintBridge(){
      const inf=Bridge.info();
      if(inf){
        brStat.innerHTML='<span class="brdot on"></span>connected';
        brInfo.innerHTML='<b style="color:var(--ok)">● '+escHtml(inf.name)+' v'+escHtml(inf.version)+'</b> · '+((inf.brain&&inf.brain!=='none')?('brain: <b>'+escHtml(inf.model||'model')+'</b>'+(inf.provider?' · '+escHtml(inf.provider):'')):'<span style="color:var(--warn)">no brain — add a provider or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY in ~/.env.local</span>')+'<br>cwd: '+escHtml(inf.cwd||'');
        if(brEp)brEp.value='';
      }else{
        brStat.innerHTML='<span class="brdot"></span>disconnected';
        brInfo.textContent='run the command above, then paste the link it prints (with #token=…).';
      }
    }
    p.querySelector('#brcopy').addEventListener('click',e=>{navigator.clipboard?.writeText('node bridge/hub-bridge.mjs');e.target.textContent='COPIED';setTimeout(()=>{if(e.target)e.target.textContent='COPY'},1400)});
    async function connectBridge(){
      const v=brEp.value.trim();if(!v){Toast.show('Paste the bridge link (with #token=…)');return}
      brStat.innerHTML='<span class="brdot"></span>connecting…';
      const r=await Bridge.connect(v);
      Toast.show(r.on?('HUB Bridge connected — '+((Bridge.info().brain&&Bridge.info().brain!=='none')?('real shell + '+(Bridge.info().model||'brain')):'real shell')):'Failed — '+r.msg);
      paintBridge();
    }
    p.querySelector('#brbtn').addEventListener('click',connectBridge);
    brEp.addEventListener('keydown',e=>{if(e.key==='Enter')connectBridge()});
    panelBus(p).on('bridge:changed',()=>{paintBridge()});
    Bridge.refresh().then(paintBridge);paintBridge();
    renderBrains();
  }
