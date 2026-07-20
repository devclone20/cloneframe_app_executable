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
    function renderBrains(){
      const b=Store.get().brain;
      const fixed=[['auto','AUTO — key → mock'],['mock','MOCK · demo']]
        .map(r=>`<div class="brainrow ${b.active===r[0]?'on':''}" data-b="${r[0]}">${r[1]}</div>`).join('');
      const provs=b.providers.map(pr=>`<div class="brainrow ${b.active===pr.id?'on':''}" data-b="${pr.id}">${escHtml(pr.name)}<span class="k">${escHtml(pr.masked)}${Keys.get(pr.id)?'':' · session expired'}</span><span class="rmk" data-rm="${pr.id}">remove</span></div>`).join('');
      brains.innerHTML=fixed+provs;
    }
    brains.addEventListener('click',e=>{
      const rm=e.target.dataset.rm;
      const b=Store.get().brain;
      if(rm){b.providers=b.providers.filter(x=>x.id!==rm);Keys.del(rm);if(b.active===rm)b.active='auto';Store.save();Brain.update();renderBrains();return}
      const row=e.target.closest('.brainrow');if(!row)return;
      b.active=row.dataset.b;Store.save();Brain.update();renderBrains();
    });
    p.querySelector('#mkeybtn').addEventListener('click',()=>{
      const key=p.querySelector('#mkey').value.trim();
      if(!key)return;
      const hit=PROV.find(x=>key.startsWith(x[0]));
      if(!hit){Toast.show('Key prefix not recognized');return}
      const id=hit[1].toLowerCase();
      const b=Store.get().brain;
      b.providers=b.providers.filter(x=>x.id!==id);
      b.providers.push({id,name:hit[1],base:hit[2],masked:'…'+key.slice(-4),present:true});
      b.active=id;Store.save();
      Keys.set(id,key);
      p.querySelector('#mkey').value='';
      Brain.update();renderBrains();
      Toast.show(hit[1]+' connected — the CONSOLE now uses it');
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
