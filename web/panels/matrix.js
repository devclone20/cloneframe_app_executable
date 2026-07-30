  function wireMatrix(p){
    const API='http://127.0.0.1:52415';
    const root=p.querySelector('#mxroot');
    const GB=n=>(n/1073741824);
    const gb1=n=>{const g=GB(n);return (g>=100?Math.round(g):g>=10?g.toFixed(1):g.toFixed(1))+'GB'};
    const mb2gb=mb=>{const g=mb/1024;return (g>=100?Math.round(g):g.toFixed(1))+'GB'};
    const FAVKEY='cfhub.matrix.favs.v1';
    const loadFavs=()=>{try{return new Set(JSON.parse(localStorage.getItem(FAVKEY)||'[]'))}catch(_){return new Set()}};
    const saveFavs=()=>{try{localStorage.setItem(FAVKEY,JSON.stringify([...st.favs]))}catch(_){}};
    const CONVKEY='cfhub.matrix.convs.v1';
    const loadConvs=()=>{try{const j=JSON.parse(localStorage.getItem(CONVKEY)||'[]');return Array.isArray(j)?j.map(c=>({...c,msgs:(c.msgs||[]).map(m=>({...m,done:true}))})):[]}catch(_){return []}};
    const packConvs=(n,withSent)=>JSON.stringify(st.convs.slice(0,n).map(c=>({id:c.id,title:c.title,model:c.model,stats:c.stats,
      msgs:c.msgs.filter(m=>m.content).map(m=>({role:m.role,content:m.content,t:m.t,err:m.err||undefined,stats:m.stats||null,files:m.files||null,
        sent:(withSent&&m.sent&&m.sent!==m.content&&m.sent.length<=65536)?m.sent:undefined}))})));
    // localStorage has a hard quota and 40 conversations can each carry 64KB of attachment
    // context. Swallowing the throw meant history silently stopped persisting for good;
    // shed weight in steps instead, and say so once when even the smallest payload fails.
    const saveConvs=()=>{
      if(st.convs.length>40)st.convs.length=40;
      for(const [n,withSent] of [[40,true],[40,false],[20,false],[10,false],[5,false],[1,false]]){
        try{localStorage.setItem(CONVKEY,packConvs(n,withSent));return}catch(_){}
      }
      if(!st.quotaWarned){st.quotaWarned=true;Toast.show('Conversation history is full — older MATRIX chats will not be saved.')}
    };
    const st={view:'home',online:false,fails:0,st8:null,models:null,convs:loadConvs(),chat:null,selModel:null,famFilter:'all',query:'',streaming:false,abort:null,stats:null,intTool:'claude',open:new Set(),timer:null,launching:false,armed:null,attach:[],favs:loadFavs(),renaming:null,preview:null,eng:{avail:false},prov:null,launchOpts:{sharding:'Pipeline',allNodes:false},local:null};
    const DEMO={
      nodes:[{id:'demo1',name:'MATRIX NODE 01',chip:'Apple M5',used:11.8*1073741824,total:16*1073741824},
             {id:'demo2',name:'MATRIX NODE 02',chip:'Apple M3 Ultra',used:64*1073741824,total:192*1073741824}],
      links:[['demo1','demo2','thunderbolt']],
      inst:[{id:'DEMO0000',model:'demo/local-model-4bit',shard:'PIPELINE',ring:'MLX RING',status:'READY',demo:true}],
    };

    root.innerHTML=`
      <div class="mx-top">
        <button class="mx-burger" data-mx="burger" title="Toggle conversations">«</button>
        <button class="mx-engbtn" data-mx="engine" style="display:none" title="Run your MATRIX cluster engine on this machine"></button>
        <div class="mx-logo"><i></i><b>MATRIX</b></div>
        <nav class="mx-nav">
          <button data-mxview="home" class="on"><svg><use href="#i-lab"/></svg>HOME</button>
          <button data-mxview="dl"><svg><use href="#i-folder"/></svg>DOWNLOADS</button>
          <button data-mxview="int"><svg><use href="#i-integrations"/></svg>INTEGRATIONS</button>
        </nav>
      </div>
      <div class="mx-body">
        <div class="mx-side">
          <button class="mx-newchat" data-mx="newchat">+ NEW CHAT</button>
          <div class="mx-search"><svg><use href="#i-search"/></svg><input data-mx="search" placeholder="Search conversations..."></div>
          <div class="mx-convs" data-mx="convs"></div>
          <div class="mx-sfoot" data-mx="convcount">0 CONVERSATIONS</div>
        </div>
        <div class="mx-main">
          <div class="mx-view mx-vhome on">
            <div class="mx-canvas"><svg data-mx="toposvg"></svg><div class="mx-scan"></div>
              <div class="mx-status" data-mx="status"><i></i><span data-mx="statustxt">CONNECTING…</span><button class="mx-engbtn" data-mx="addnode" style="display:none">＋ ADD NODE</button></div>
              <div class="mx-hintline" data-mx="hint">Select a model to get started.</div>
            </div>
          </div>
          <div class="mx-view mx-vchat"><div class="mx-msgs" data-mx="msgs"></div></div>
          <div class="mx-view mx-vdl"><div class="mx-dl" data-mx="dlbody"></div></div>
          <div class="mx-view mx-vint"><div class="mx-int" data-mx="intbody"></div></div>
          <div class="mx-composer" data-mx="composer">
            <div class="mx-crow1">
              <span>MODEL:</span>
              <button class="mx-modelbtn" data-mx="modelbtn"><em data-mx="modellbl">— SELECT MODEL —</em><span>▾</span></button>
              <div class="mx-cstats" data-mx="cstats"></div>
            </div>
            <div class="mx-chipsrow" data-mx="chips" style="display:none"></div>
            <div class="mx-crow2">
              <button class="mx-attach" title="Attach file — or drop one anywhere on MATRIX" data-mx="attach"><svg><use href="#i-file"/></svg></button>
              <span class="mx-caret">▶</span>
              <textarea class="mx-input" rows="1" data-mx="input" placeholder="Choose a model to start chatting"></textarea>
              <button class="mx-send" data-mx="send">SEND</button>
            </div>
          </div>
          <input type="file" multiple data-mx="fileinput" style="display:none">
        </div>
        <div class="mx-aside" data-mx="aside"></div>
      </div>
      <div class="mx-dropov"><b>DROP TO ATTACH</b></div>
      <div class="mx-picker" data-mx="addpop">
        <div class="mx-pbox" style="height:auto;max-height:88%">
          <div class="mx-phead"><span style="font-size:10px;font-weight:700;letter-spacing:.2em;color:var(--accent)">＋ ADD A NODE TO YOUR MATRIX</span><span class="mx-pmem"></span><button class="mx-pclose" data-mx="addclose" title="Close">✕</button></div>
          <div class="mx-addbody">
            <p>Any Mac on the <b>same network</b> (Wi-Fi, Ethernet or a Thunderbolt cable) joins this cluster automatically — no pairing, no config. Nodes discover each other as long as they run the <b>same engine version</b> (the discovery namespace is the version itself).</p>
            <p>On the new Mac, run:</p>
            <div class="mx-code"><div class="mx-codeh"><b>Second node setup</b><span>run on the new Mac</span><button class="mx-copy" data-mx="addcopy">COPY</button></div>
<pre data-mx="addcmd">git clone https://github.com/exo-explore/exo ~/exo && cd ~/exo
git checkout b5375f8   # match this node's version — namespaces must agree
curl -LsSf https://astral.sh/uv/install.sh | sh
uv sync --all-packages
uv pip install "mlx==0.32.0" mlx-vlm "git+https://github.com/rltakashige/mlx-lm@leo/deepseek-v4"
.venv/bin/exo</pre></div>
            <p class="dim">The node appears on this canvas within seconds of starting. Full runbook (firewall, Thunderbolt, troubleshooting): <b>MATRIX_LAB/SECOND_NODE_SETUP.md</b> — a ready-to-run copy lives at <b>setup-second-node.sh</b> (AirDrop it to the new Mac).</p>
          </div>
        </div>
      </div>
      <div class="mx-picker" data-mx="picker">
        <div class="mx-pbox">
          <div class="mx-phead">
            <svg><use href="#i-search"/></svg>
            <input data-mx="pq" placeholder="Search models...">
            <span class="mx-pmem" data-mx="pmem"></span>
            <button class="mx-pclose" data-mx="pclose" title="Close">✕</button>
          </div>
          <div class="mx-pbody">
            <div class="mx-fam" data-mx="fam"></div>
            <div class="mx-plist" data-mx="plist"></div>
          </div>
        </div>
      </div>`;

    const el=k=>root.querySelector(`[data-mx="${k}"]`);
    const E={status:el('status'),statustxt:el('statustxt'),hint:el('hint'),topo:el('toposvg'),convs:el('convs'),
      convcount:el('convcount'),search:el('search'),msgs:el('msgs'),aside:el('aside'),composer:el('composer'),
      modellbl:el('modellbl'),cstats:el('cstats'),input:el('input'),send:el('send'),picker:el('picker'),
      pq:el('pq'),pmem:el('pmem'),fam:el('fam'),plist:el('plist'),dlbody:el('dlbody'),intbody:el('intbody'),
      chips:el('chips'),fileinput:el('fileinput')};

    // ---- attachments (text files → chat context; tiny button or drop anywhere on MATRIX) ----
    const ATT_MAX=3,ATT_BYTES=200*1024;
    function renderChips(){
      E.chips.style.display=st.attach.length?'':'none';
      E.chips.innerHTML=st.attach.map((f,i)=>`<span class="mx-fchip">⎘ ${escHtml(f.name)}<span class="sz">${(f.size/1024).toFixed(0)}KB</span><button class="rm" data-mxfrm="${i}" title="Remove">✕</button></span>`).join('');
    }
    function looksBinary(t){let bad=0;const n=Math.min(t.length,2000);for(let i=0;i<n;i++){const c=t.charCodeAt(i);if(c===0||(c<9&&c!==0)||(c>13&&c<32))bad++}return bad>n*0.02}
    function addFiles(list){
      const files=[...(list||[])];
      for(const f of files){
        if(st.attach.length>=ATT_MAX){Toast.show('Max '+ATT_MAX+' attachments.');break}
        if(f.size>ATT_BYTES){Toast.show(f.name+' skipped — over 200KB.');continue}
        const rd=new FileReader();
        rd.onload=()=>{
          const t=String(rd.result||'');
          if(looksBinary(t)){Toast.show(f.name+' skipped — text files only for now.');return}
          st.attach.push({name:f.name,size:f.size,text:t});
          renderChips();
          if(st.view==='dl'||st.view==='int')Toast.show('Attached to chat: '+f.name);
        };
        rd.readAsText(f);
      }
    }

    // ---- cluster data (live /state or demo) ----
    // ONE definition of "we are looking at a real cluster". Every number the app shows
    // as the owner's must be gated on this: the demo topology is a drawing, not data.
    function liveCluster(){return !!(st.online&&st.st8)}
    function nodes(){
      if(liveCluster()){
        const s=st.st8,ids=(s.topology&&s.topology.nodes)||[];
        return ids.map(id=>{const nid=(s.nodeIdentities||{})[id]||{},m=(s.nodeMemory||{})[id]||{};
          const tot=m.ramTotal?m.ramTotal.inBytes:0,av=m.ramAvailable?m.ramAvailable.inBytes:0;
          return {id,name:nid.friendlyName||nid.modelId||id.slice(0,8),chip:nid.chipId||'',used:Math.max(0,tot-av),total:tot}});
      }
      return DEMO.nodes;
    }
    // exo serialises connections as {source:{sink:[edge,…]}} — reading the inner map as
    // a list of peers yielded node ids as "edges", so the label branch only ever fired
    // for DEMO data and the real interface was never drawn.
    function links(){ // [a,b,interfaceLabel] — label drawn at the link midpoint (exo hides this; we show it)
      if(liveCluster()){
        const conns=(st.st8.topology&&st.st8.topology.connections)||{},out=[],seen=new Set();
        for(const a in conns){
          const peers=conns[a]||{};
          for(const b in peers){
            const e=(Array.isArray(peers[b])?peers[b][0]:peers[b])||{};
            const lbl=(e.sourceRdmaIface||e.sinkRdmaIface)?'rdma':(e.sendBackInterface||e.interface||e.iface||(e.sinkMultiaddr?'socket':''));
            const k=[a,b].sort().join('|');
            if(b&&!seen.has(k)){seen.add(k);out.push([a,b,String(lbl)])}}}
        return out;
      }
      return DEMO.links;
    }
    function instances(){
      if(liveCluster()){
        const s=st.st8,out=[],ins=s.instances||{},run=s.runners||{};
        for(const iid in ins){
          const kind=Object.keys(ins[iid])[0]||'',b=ins[iid][kind]||{},sa=b.shardAssignments||{};
          const rids=Object.keys(sa.runnerToShard||{});
          // Unanimity: a sharded instance is only usable when EVERY runner is up. Taking
          // the first ready one made a 4-node model "READY" while three nodes still loaded,
          // and the first message then died against a half-assembled instance.
          const sts=rids.map(r=>run[r]?Object.keys(run[r])[0]||'':'');
          const status=sts.some(x=>/Failed/i.test(x))?'FAILED'
            :(rids.length&&sts.every(x=>/Ready|Running/i.test(x)))?'READY':'LOADING';
          const ready=sts.filter(x=>/Ready|Running/i.test(x)).length;
          const sk=rids.length?Object.keys(sa.runnerToShard[rids[0]])[0]||'':'';
          const ids8=s.nodeIdentities||{};
          const onNodes=Object.keys(sa.nodeToRunner||{}).map(nid=>(ids8[nid]&&(ids8[nid].friendlyName||ids8[nid].modelId))||nid.slice(0,8));
          out.push({id:iid,model:sa.modelId||'?',shard:/Tensor/i.test(sk)?'TENSOR':'PIPELINE',ring:/Jaccl/i.test(kind)?'RDMA':'MLX RING',status,ready,runners:rids.length,nodes:onNodes});
        }
        return out;
      }
      return st.fails>1?DEMO.inst:[];
    }
    function readyModel(){const i=instances().find(i=>i.status==='READY'&&!i.demo);return i?i.model:null}
    // Memory maths must never run on DEMO nodes: sizing a 70B model against a fictional
    // 208GB cluster told the owner it fit on a 16GB laptop.
    function realNodes(){return liveCluster()?nodes():[]}
    function clusterFree(){return realNodes().reduce((a,n)=>a+(n.total-n.used),0)}
    function clusterTotal(){return realNodes().reduce((a,n)=>a+n.total,0)}

    // ---- topology (orbit layout, exo-style but ours) ----
    function deviceSVG(n,x,y,scale){
      // Legible + alive (audit Obj 8): readable name/metrics, the memory % ON the
      // screen of the machine, the fill breathing faster under load, and the side
      // tower showing its REAL fill (was a hardcoded "0%").
      const s=scale,w=46*s,h=28*s,kb=7*s,ratio=Math.min(1,n.total?n.used/n.total:0),fillH=Math.round((h-4)*ratio);
      const pct=n.total?Math.round(ratio*100):0;
      const breathe=(3.4-2.4*ratio).toFixed(2); // idle 3.4s → loaded 1s pulse
      const towerH=h+kb,towerFill=Math.round((towerH-4)*ratio);
      return `<g class="mx-node" transform="translate(${x},${y})">
        <text x="0" y="${-h/2-14*s}" text-anchor="middle" style="fill:var(--accent)" font-size="${11*s}" font-weight="700" letter-spacing=".08em">${escHtml(n.name.length>22?n.name.slice(0,21)+'…':n.name)}</text>
        <rect x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="${3*s}" style="fill:color-mix(in srgb,var(--panel) 80%,transparent);stroke:color-mix(in srgb,var(--fg) 45%,transparent);stroke-width:1.2"/>
        <rect class="mx-nodefill" x="${-w/2+2}" y="${h/2-2-fillH}" width="${w-4}" height="${fillH}" rx="${2*s}" style="fill:color-mix(in srgb,var(--accent) 78%,transparent);animation-duration:${breathe}s"/>
        <text x="0" y="${4*s}" text-anchor="middle" style="fill:var(--fg)" font-size="${11*s}" font-weight="700">${pct}%</text>
        <rect x="${-w/2-4*s}" y="${h/2}" width="${w+8*s}" height="${kb}" rx="${2*s}" style="fill:color-mix(in srgb,var(--panel) 92%,var(--fg));stroke:color-mix(in srgb,var(--fg) 40%,transparent);stroke-width:1"/>
        <rect x="${w/2+7*s}" y="${-h/2}" width="${9*s}" height="${towerH}" rx="${2*s}" style="fill:color-mix(in srgb,var(--panel) 85%,transparent);stroke:color-mix(in srgb,var(--fg) 30%,transparent);stroke-width:1"/>
        <rect class="mx-nodefill" x="${w/2+7*s+2}" y="${-h/2+towerH-2-towerFill}" width="${9*s-4}" height="${towerFill}" rx="${1.5*s}" style="fill:color-mix(in srgb,var(--accent) 55%,transparent);animation-duration:${breathe}s"/>
        <text x="0" y="${h/2+kb+13*s}" text-anchor="middle" font-size="${10.5*s}"><tspan style="fill:var(--accent)" font-weight="700">${escHtml(gb1(n.used))}</tspan><tspan style="fill:var(--ink-dim)">/${escHtml(gb1(n.total))}</tspan></text>
        <text x="0" y="${h/2+kb+24*s}" text-anchor="middle" style="fill:var(--ink-faint)" font-size="${9*s}" letter-spacing=".06em">${escHtml(n.chip||'')}</text>
      </g>`;
    }
    function drawTopo(svg,compact){
      const ns=nodes(),ls=links(),r=svg.getBoundingClientRect();
      const W=Math.max(160,r.width),H=Math.max(120,r.height);
      const scale=compact?0.62:1;
      // Rewriting the SVG every tick restarted every CSS animation from t=0, so the
      // breathing fill and the flowing link never actually played. Redraw on change only.
      const sig=JSON.stringify([ns.map(n=>[n.id,n.name,n.chip,n.used,n.total]),ls,W,H,scale]);
      if(svg.__sig===sig)return;
      svg.__sig=sig;
      const orbit=ns.length===1?0:Math.min(W,H)/2-70*scale;
      const cx=W/2,cy=H/2-(compact?2:8);
      const pos={};ns.forEach((n,i)=>{const a=(i/ns.length)*2*Math.PI-Math.PI/2;pos[n.id]=[cx+orbit*Math.cos(a),cy+orbit*Math.sin(a)]});
      let out='';
      for(const [a,b,lbl] of ls){
        if(!pos[a]||!pos[b])continue;
        out+=`<line class="mx-link" x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}"/>`;
        if(lbl&&!compact)out+=`<text x="${(pos[a][0]+pos[b][0])/2}" y="${(pos[a][1]+pos[b][1])/2-6}" text-anchor="middle" style="fill:var(--ink-faint)" font-size="${7*scale}" letter-spacing=".14em">${escHtml(lbl.toUpperCase())}</text>`;
      }
      for(const n of ns)out+=deviceSVG(n,pos[n.id][0],pos[n.id][1],scale);
      svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=out;
    }

    // ---- renders ----
    function renderStatus(){
      const n=nodes().length;
      if(st.online){E.status.classList.remove('off');E.statustxt.innerHTML=`${n} NODE${n>1?'S':''} · ENGINE ONLINE`}
      else{E.status.classList.add('off');E.statustxt.innerHTML=`ENGINE OFFLINE — DEMO DATA <span class="hint">· start your MATRIX engine to go live</span>`}
      const eb=root.querySelector('[data-mx="engine"]');
      if(eb){
        const e=st.eng||{};
        eb.style.display='';
        if(!e.avail){eb.className='mx-engbtn muted';eb.dataset.mode='connect';eb.textContent='◦ CONNECT MACHINE'}
        // A start takes up to ~14s. Without a visible busy state a second click spawned a
        // second engine, and the survivor became one the app could see and never stop.
        else if(st.engBusy){eb.className='mx-engbtn muted';eb.dataset.mode='busy';eb.textContent='◌ STARTING…'}
        else if(st.online&&e.ownedPid){eb.className='mx-engbtn stop';eb.dataset.mode='stop';eb.textContent=(st.armed&&st.armed.key==='engine')?'SURE?':'■ STOP ENGINE'}
        else if(st.online&&e.external===null){eb.className='mx-engbtn live muted';eb.dataset.mode='extunknown';eb.textContent='● EXTERNAL ENGINE'}
        else if(st.online){eb.className='mx-engbtn live';eb.dataset.mode='takeover';eb.textContent=(st.armed&&st.armed.key==='engtake')?'SURE? — KILLS + RESTARTS':'● EXTERNAL — RESTART UNDER APP'}
        // Offering START on a machine with no engine binary is a control that can only fail.
        else if(e.found===false){eb.className='mx-engbtn muted';eb.dataset.mode='noengine';eb.textContent='◦ ENGINE NOT INSTALLED'}
        else if(e.crashed){eb.className='mx-engbtn stop';eb.dataset.mode='start';eb.textContent='⟳ ENGINE CRASHED — RESTART'}
        else{eb.className='mx-engbtn';eb.dataset.mode='start';eb.textContent='▶ START ENGINE'}
      }
      const ab=root.querySelector('[data-mx="addnode"]');
      if(ab)ab.style.display=st.online?'':'none';
    }
    function renderSide(){
      const q=(E.search.value||'').toLowerCase();
      const list=st.convs.filter(c=>!q||c.title.toLowerCase().includes(q));
      if(!st.convs.length){
        E.convs.innerHTML=`<div class="mx-sempty"><div class="ic">◍</div><b>NO CONVERSATIONS</b><span>Start a new chat to begin</span></div>`;
      }else{
        E.convs.innerHTML=`<div class="mx-convlbl">CONVERSATIONS</div>`+list.map(c=>`
          <div class="mx-conv${st.chat===c?' on':''}" data-cid="${c.id}">
            <button class="mx-convdel" data-mxcdel="${c.id}" title="Delete conversation">✕</button>
            <button class="mx-convren" data-mxcren="${c.id}" title="Rename">✎</button>
            ${st.renaming===c.id
              ?`<input class="mx-renin" data-mxrenin="${c.id}" value="${escAttr(c.title)}" maxlength="60">`
              :`<div class="t">${escHtml(c.title)}</div>`}
            <div class="m">${escHtml((c.model||'').split('/').pop()||'')}</div>
            ${c.stats?`<div class="s">TTFT ${c.stats.ttft}ms · ${c.stats.tps} tok/s</div>`:''}
          </div>`).join('');
      }
      E.convcount.textContent=`${st.convs.length} CONVERSATION${st.convs.length===1?'':'S'}`;
    }
    function instCard(i){
      const stuck=i.status!=='READY'&&i.status!=='FAILED'&&!i.demo&&st.instSeen&&st.instSeen[i.id]&&performance.now()-st.instSeen[i.id]>180000;
      const cls=i.status==='FAILED'?'bad':(i.status==='READY'?'':'wait');
      const badge=i.status==='READY'?'<span class="mx-badge">READY</span>':i.status==='FAILED'?'<span class="mx-badge bad">FAILED</span>':stuck?'<span class="mx-badge bad">STUCK?</span>':'<span class="mx-badge wait">LOADING</span>';
      return `<div class="mx-inst ${cls}">
        <div class="idrow"><i></i><b>${escAttr(i.id.slice(0,8).toUpperCase())}</b>${i.demo?'<span class="mx-badge wait">DEMO</span>':''}<button class="mx-instdel" data-mxdel="${escAttr(i.id)}"${i.demo?' data-demo="1"':''}>${st.armed&&st.armed.key==='inst:'+i.id?'SURE?':'DELETE'}</button></div>
        <div class="mdl">${escHtml(i.model)}</div>
        <div class="meta">${escHtml(i.shard)} · ${escHtml(i.ring)} ${badge}</div>
        ${i.nodes&&i.nodes.length?`<div class="meta">on ${escHtml(i.nodes.slice(0,2).map(n=>n.length>14?n.slice(0,13)+'…':n).join(' · '))}${i.nodes.length>2?` +${i.nodes.length-2}`:''}</div>`:''}
        <div class="foot">${i.status==='READY'?'Ready to chat!':i.status==='FAILED'?'Runner failed — check the engine log.':stuck?'Loading for over 3 min — the engine may be wedged. DELETE this and restart the engine.':'Loading into memory…'}</div>
      </div>`;
    }
    // The rail's first answer to "what do I have here?" — present whether or not the
    // engine is up, and the one place a local model can be loaded, used or removed.
    function localSection(disk){
      const here=disk.filter(r=>r.here),away=disk.filter(r=>!r.here&&r.remoteOn.length);
      if(!here.length&&!away.length)return st.local===null?'':`<div class="mx-ash"><i class="dia"></i>ON THIS MACHINE</div><div class="mx-lmnone">No model downloaded yet — pick one below and LAUNCH it.</div>`;
      const total=here.reduce((a,r)=>a+r.bytes,0);
      const row=(r,local)=>{
        const sel=st.selModel&&st.selModel.id===r.id;
        const state=r.live?'<span class="s live">● LIVE</span>'
          :r.loading?'<span class="s wait">◐ LOADING</span>'
          :(r.partial&&!r.usable)?'<span class="s wait">◐ INCOMPLETE</span>'
          :r.link?'<span class="s">↪ LINKED ELSEWHERE</span>'
          :r.readOnly?'<span class="s">▪ SHARED · READ-ONLY</span>'
          :local?'<span class="s">▪ ON DISK</span>'
          :`<span class="s">▪ ON ${escHtml(String(r.remoteOn[0]).toUpperCase())}</span>`;
        const act=r.live?`<button class="mx-lmb" data-mxlmuse="${escAttr(r.id)}">USE</button>`
          :(r.loading||!r.usable)?''
          :`<button class="mx-lmb" data-mxlmload="${escAttr(r.id)}">LOAD</button>`;
        // Only weights this machine owns are removable from here. A read-only root is the
        // engine's own no-go, a symlink points at someone else's disk, and a remote node's
        // storage is not ours to touch — a DELETE on any of those is a dead control.
        const rm=(local&&!r.readOnly&&!r.link)
          ?`<button class="mx-lmb rm" data-mxlmrm="${escAttr(r.id)}" title="Delete the weights from this machine">${st.armed&&st.armed.key==='purge:'+r.id?'SURE?':'DELETE'}</button>`
          :'';
        return `<div class="mx-lm${r.live?' live':''}${sel?' on':''}" data-mxlm="${escAttr(r.id)}" title="${escAttr(r.id)}">
          <div class="t"><b>${escHtml(r.name)}</b><span class="gb">${escHtml(r.bytes?gb1(r.bytes):'—')}</span></div>
          <div class="r">${state}${act}${rm}</div>
        </div>`;
      };
      return (here.length?`<div class="mx-ash"><i class="dia"></i>ON THIS MACHINE<span class="n">${escHtml(gb1(total))}</span></div>`+here.map(r=>row(r,true)).join(''):'')
        +(away.length?`<div class="mx-ash"><i class="dia"></i>ELSEWHERE IN THE CLUSTER</div>`+away.map(r=>row(r,false)).join(''):'');
    }
    function renderAside(){
      const ins=instances();
      const mcount=st.models?st.models.length:null;
      const m=st.selModel;
      const disk=onDisk();
      const dlDone=!!m&&disk.some(r=>r.id===m.id&&r.usable);
      const mLive=!!m&&ins.some(i=>i.model===m.id&&i.status==='READY');
      // An already-downloaded model is always launchable: the memory check is about
      // whether it CAN be pulled in, and one that is on disk has already answered that.
      // With no live cluster there is no memory to check against — say so instead of
      // sizing the model against a demo topology.
      const mFits=!!m&&(dlDone||(liveCluster()&&(m.storage_size_megabytes||0)*1048576<=clusterFree()));
      const launchLbl=st.launching?'LAUNCHING…':mLive?'● LIVE'
        :!liveCluster()?'START ENGINE FIRST':(!mFits?'INSUFFICIENT MEMORY':'▸ LAUNCH');
      const launchDim=st.launching||!liveCluster()||(!mFits&&!mLive);
      let prevHTML='';
      if(m&&st.preview&&st.preview.forId===m.id){
        const ok=st.preview.rows.filter(r=>!r.err).slice(0,3);
        prevHTML='<div class="mx-dllbl">PLACEMENT</div>'+(ok.length
          ?ok.map(r=>`<div class="mx-prevrow"><span>${escHtml(r.shard.toUpperCase())}</span><span>${escHtml(/jaccl/i.test(r.meta)?'RDMA':'RING')}</span><span>${r.nodes||1} node${(r.nodes||1)>1?'s':''}</span><span class="d">+${escHtml(gb1(r.delta))}</span></div>`).join('')
          :'<div class="mx-prevnone">no viable placement — free some memory</div>');
      }
      const html=
        (st.view==='chat'?`<div class="mx-ash"><i></i>TOPOLOGY<span class="n">${nodes().length} NODE${nodes().length>1?'S':''}</span></div><div class="mx-minitopo"><svg data-mx="minitopo"></svg></div>`:'')
        +(ins.length?`<div class="mx-ash"><i></i>INSTANCES</div>`+ins.map(instCard).join(''):'')
        +localSection(disk)
        +`<div class="mx-ash"><i class="dia"></i>LOAD MODEL<span class="n">${mcount===null?'—':mcount+' models'}</span></div>
        <button class="mx-mtrig" data-mx="mtrig"><em class="${m?'sel':''}">${m?escHtml(m.name):'— SELECT MODEL —'}</em>${m?`<span class="gb">${escHtml(m.gbLabel)}</span>`:''}<span class="car">▾</span></button>`
        +(m?`<div class="mx-mcard">
            <div class="nm"><b>${escHtml(m.name)}</b><span class="gb">${escHtml(m.gbLabel)}</span></div>
            <div class="hf">${escHtml(m.id)}</div>
            <div class="mx-chips">
              <span class="mx-chip tog" data-mxopt="sharding" title="Toggle sharding — Tensor needs 2+ nodes and a divisible model">${escHtml(st.launchOpts.sharding.toUpperCase())}</span>
              <span class="mx-chip">MLX RING</span>
              <span class="mx-chip tog" data-mxopt="nodes" title="AUTO lets placement pick; ALL spans every node">${st.launchOpts.allNodes?`ALL ${nodes().length} NODES`:'AUTO NODES'}</span>
            </div>
            <div class="mx-dllbl">DOWNLOAD</div>
            <div class="mx-dlrow"><span>${escHtml(nodes()[0]?nodes()[0].name.slice(0,10):'node')}…</span><div class="mx-dlbar"><i style="width:${dlDone?100:0}%"></i></div><span>${dlDone?'100%':'—'}</span></div>
            ${prevHTML}
            <button class="mx-launch${launchDim?' dim':''}" data-mx="launch">${launchLbl}</button>
          </div>`:'');
      // A 1 Hz innerHTML rewrite destroys the node under any pointer whose mousedown and
      // mouseup straddle a tick, so clicks on LOAD / USE / DELETE simply vanished. The
      // string is already built — comparing it is free, and an unchanged rail stays still.
      if(html!==st._asideHTML){st._asideHTML=html;E.aside.innerHTML=html}
      const mini=root.querySelector('[data-mx="minitopo"]');if(mini)drawTopo(mini,true);
    }
    const dlMeta={}; // "modelId|nodeId" → shardMetadata seen in state, reused for retry/resume
    function dlMap(){
      const out={};
      if(!st.online||!st.st8)return out;
      const dls=st.st8.downloads||{};
      for(const nid in dls)for(const d of dls[nid]||[]){
        const k=Object.keys(d)[0]||'',b=d[k]||{};
        const md=b.shardMetadata,sk=md?Object.keys(md)[0]:'';
        const card=sk&&md[sk]&&md[sk].modelCard;if(!card)continue;
        const mid=card.modelId;
        dlMeta[mid+'|'+nid]=md;
        const cell=(out[mid]=out[mid]||{});
        if(/Completed/i.test(k))cell[nid]={s:'done',bytes:b.total?b.total.inBytes:0};
        else if(/Ongoing/i.test(k)){const pr=b.downloadProgress||{};const tot=pr.total?pr.total.inBytes:0,dn=pr.downloaded?pr.downloaded.inBytes:0;cell[nid]={s:'run',pct:tot?Math.round(dn/tot*100):0}}
        else if(/Failed/i.test(k))cell[nid]={s:'fail',err:b.errorMessage||''};
        else cell[nid]={s:'wait'};
      }
      return out;
    }
    // ---- what is actually on this machine ---------------------------------------
    // Three witnesses, one answer: the engine's download log, a READY instance, and —
    // the only one that survives an engine restart — the weights themselves, read off
    // disk by the bridge. Asking only the first two is why a model you already owned
    // could vanish from every picker the moment the engine was restarted, and why it
    // could not be deleted at all while the engine was down.
    async function refreshLocal(){
      try{const r=await RPC('matrix','localModels');st.local=(r&&r.models)||[]}
      catch(_){if(st.local===null)st.local=[]}
      invalidateDisk();
    }
    // The bridge can only see THIS machine. The engine's download map covers the whole
    // cluster, so it is read per node: a model that lives on node B is real, but it is
    // not "on this machine" and its weights are not ours to delete from here.
    // Recomputed several times per render and once per tick; the inputs only change when
    // the tick pulls new state, so compute once per tick and hand back the same answer.
    let _diskMemo=null;
    const invalidateDisk=()=>{_diskMemo=null};
    function onDisk(){
      if(_diskMemo)return _diskMemo;
      const map=dlMap(),rows=new Map(),ids8=(st.st8&&st.st8.nodeIdentities)||{};
      const put=(id,patch)=>{const r=rows.get(id)||{id,name:String(id).split('/').pop(),bytes:0,live:false,loading:false,engine:false,disk:false,partial:false,readOnly:false,link:false,remoteOn:[]};Object.assign(r,patch);rows.set(id,r)};
      for(const id in map){
        const cells=map[id];
        const here=st.nodeId&&cells[st.nodeId];
        if(here&&here.s==='done')put(id,{engine:true,bytes:here.bytes||0});
        const elsewhere=Object.keys(cells).filter(n=>n!==st.nodeId&&cells[n].s==='done')
          .map(n=>(ids8[n]&&(ids8[n].friendlyName||ids8[n].modelId))||n.slice(0,8));
        if(elsewhere.length)put(id,{remoteOn:elsewhere});
      }
      for(const m of (st.local||[]))put(m.id,{disk:true,partial:!!m.partial,readOnly:!!m.readOnly,link:!!m.link,
        bytes:Math.max(m.bytes||0,(rows.get(m.id)||{}).bytes||0)});
      for(const i of instances()){
        if(i.demo)continue;
        if(i.status==='READY')put(i.model,{live:true});
        else if(i.status!=='FAILED')put(i.model,{loading:true});
      }
      for(const r of rows.values()){
        if(!r.bytes){const c=(st.models||[]).find(m=>m.id===r.id);if(c)r.bytes=(c.storage_size_megabytes||0)*1048576}
        // A stray .partial next to a finished model is exo's own litter, not an
        // incomplete download — the engine listing it as downloaded settles the question.
        r.usable=r.engine||r.live||(r.disk&&!r.partial);
        r.here=r.disk||r.engine||r.live;
      }
      _diskMemo=[...rows.values()].sort((a,b)=>(b.live?1:0)-(a.live?1:0)||(b.here?1:0)-(a.here?1:0)||a.name.localeCompare(b.name));
      return _diskMemo;
    }
    // ---- model ops (control-plane of the local engine) ----
    const liveNow=id=>instances().some(i=>i.model===id&&i.status==='READY'&&!i.demo);
    // Bring a model that is already on disk into memory and wait for it. tick() refreshes
    // the cluster state every second, so this waits on that rather than polling twice.
    // A stale FAILED instance used to be fatal in both directions: it blocked the place,
    // and then the "any FAILED?" check aborted the wait a second after a good instance
    // was placed. So: clear the dead ones first, then judge only what THIS attempt made.
    async function ensureLive(modelId,signal){
      if(liveNow(modelId))return true;
      const mine=()=>instances().filter(i=>i.model===modelId&&!i.demo);
      if(!mine().some(i=>i.status!=='FAILED')){
        for(const dead of mine().filter(i=>i.status==='FAILED')){
          try{await fetch(API+'/instance/'+encodeURIComponent(dead.id),{method:'DELETE',signal})}catch(_){}
        }
        const before=new Set(mine().map(i=>i.id));
        try{
          const r=await fetch(API+'/place_instance',{method:'POST',signal,headers:{'Content-Type':'application/json'},
            body:JSON.stringify({model_id:modelId,sharding:st.launchOpts.sharding,instance_meta:'MlxRing',
              min_nodes:st.launchOpts.allNodes?Math.max(1,nodes().length):1})});
          if(!r.ok)return false;
        }catch(_){return false}
        for(let i=0;i<150;i++){
          await new Promise(s=>setTimeout(s,1000));
          if(signal&&signal.aborted)return false;
          if(liveNow(modelId))return true;
          const fresh=mine().filter(i=>!before.has(i.id));
          if(fresh.length&&fresh.every(i=>i.status==='FAILED'))return false;
        }
        return false;
      }
      for(let i=0;i<150;i++){
        await new Promise(s=>setTimeout(s,1000));
        if(signal&&signal.aborted)return false;
        if(liveNow(modelId))return true;
        if(!mine().some(i=>i.status!=='FAILED'))return false;
      }
      return false;
    }
    async function launch(){
      const m=st.selModel;if(!m)return;
      if(!st.online){Toast.show('MATRIX engine is offline — start it first.');return}
      if(st.launching)return;
      if(liveNow(m.id)){Toast.show('Already live — ask anything.');return}
      // /place_instance answers 200 for "command received", with no memory check and no
      // dedupe, so a second press stacked a second instance and the toast called it a launch.
      if(instances().some(i=>i.model===m.id&&i.status!=='FAILED'&&!i.demo)){Toast.show('Already loading — watch INSTANCES.');return}
      const row=onDisk().find(r=>r.id===m.id);
      if(!(row&&row.usable)&&(m.storage_size_megabytes||0)*1048576>clusterFree()){
        Toast.show('Not enough free memory for '+m.name+' — free some, or pick a smaller variant.');return;
      }
      st.launching=true;renderAside();
      try{
        const r=await fetch(API+'/place_instance',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model_id:m.id,sharding:st.launchOpts.sharding,instance_meta:'MlxRing',
            min_nodes:st.launchOpts.allNodes?Math.max(1,nodes().length):1})});
        if(!r.ok){let tx='';try{tx=(await r.text()).slice(0,180)}catch(_){}throw new Error(tx||('HTTP '+r.status))}
        Toast.show('Launching '+m.name+' — watch INSTANCES.');
      }catch(err){Toast.show('Launch failed: '+((err&&err.message)||'error'))}
      st.launching=false;renderAside();
    }
    async function fetchPreview(modelId){ // where would this model land — the engine's dry-run placement
      if(!st.online){st.preview=null;return}
      try{
        const r=await fetch(API+'/instance/previews?model_id='+encodeURIComponent(modelId),{signal:AbortSignal.timeout(4000)});
        if(!r.ok)throw 0;
        const j=await r.json();
        const rows=(j.previews||[]).map(p=>{
          const mdl=p.memory_delta_by_node||p.memoryDeltaByNode||null;
          return {shard:String(p.sharding||''),meta:String(p.instance_meta||p.instanceMeta||''),
            nodes:mdl?Object.keys(mdl).length:null,
            delta:mdl?Object.values(mdl).reduce((a,b)=>a+b,0):0,err:p.error||null};
        });
        if(st.selModel&&st.selModel.id===modelId)st.preview={forId:modelId,rows};
      }catch(_){st.preview=null}
      if(!st.armed)renderAside(); // the SURE? freeze in tick() is worthless if this bypasses it
    }
    function arm(key){ // two-click confirm for destructive ops; tick() clears stale arms
      if(st.armed&&st.armed.key===key)return true;
      st.armed={key,ts:performance.now()};renderAside();renderStatus();if(st.view==='dl')renderDl();
      return false;
    }
    async function delInstance(id){
      try{
        const r=await fetch(API+'/instance/'+encodeURIComponent(id),{method:'DELETE'});
        if(!r.ok)throw new Error('HTTP '+r.status);
        Toast.show('Instance deleted.');
      }catch(err){Toast.show('Delete failed: '+((err&&err.message)||'error'))}
      st.armed=null;
    }
    async function dlStart(nodeId,modelId){
      const md=dlMeta[modelId+'|'+nodeId];
      if(!md){Toast.show('No shard metadata yet — LAUNCH the model once and MATRIX seeds the download through placement.');return}
      try{const r=await fetch(API+'/download/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetNodeId:nodeId,shardMetadata:md})});if(!r.ok)throw 0;Toast.show('Download started.')}
      catch(_){Toast.show('Download start failed.')}
    }
    async function dlCancel(nodeId,modelId){
      try{const r=await fetch(API+'/download/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetNodeId:nodeId,modelId})});if(!r.ok)throw 0;Toast.show('Download cancelled.')}
      catch(_){Toast.show('Cancel failed.')}
    }
    // ONE honest delete, done where it can actually be complete. The bridge stops the
    // instance, cancels the transfer, tells the engine to forget it, removes the weights,
    // the metadata cache and any Hugging Face copy from this machine, and repairs the
    // model registry so CODE · LAB · Brain stop offering something that no longer exists.
    // It works with the engine down — the old path could not delete anything at all then.
    async function purgeModel(modelId){
      const row=onDisk().find(r=>r.id===modelId);
      const label=(row&&row.name)||String(modelId).split('/').pop();
      st.armed=null;
      Toast.show('Removing '+label+'…');
      let r=null;
      try{r=await RPC('matrix','purgeModel',modelId)}
      catch(e){Toast.show('Delete failed: '+((e&&e.message)||'bridge error'));return}
      if(!r||r.ok===false){
        // The bridge reports partial failure through `errors`, with no `error` key —
        // reading only `error` turned every real filesystem fault into "delete failed".
        const err=(r&&r.error)||(r&&r.errors&&r.errors.length&&r.errors.join('; '))||'delete failed';
        const part=(r&&r.removed&&r.removed.length)?(' — '+gb1(r.freed)+' freed, the rest is still on disk'):'';
        Toast.show(/permission/.test(err)
          ?'Enable Settings → My Machine → “MATRIX engine control” to remove models from this machine.'
          :('Delete failed: '+err+part));
      }else if(r.removed&&r.removed.length){
        const hf=r.removed.some(x=>String(x.path).includes('/.cache/huggingface/'));
        Toast.show(label+' deleted — '+(r.freed?gb1(r.freed):'the weights')+' freed from this machine'
          +(hf?', including its Hugging Face cache copy':'')+'.');
      }else if(r.notFound){
        Toast.show(label+' was not on this machine — the app is back in sync.');
      }else{
        Toast.show(label+': nothing was removed here'+((r.engine&&r.engine.nodes)?' — the engine dropped it on '+r.engine.nodes+' node(s).':'.'));
      }
      if(st.selModel&&st.selModel.id===modelId){st.selModel=null;st.preview=null}
      for(const k of Object.keys(dlMeta))if(k.startsWith(modelId+'|'))delete dlMeta[k];
      invalidateDisk();
      await refreshLocal();
      await refreshProv();
      Bus.emit('models:changed'); // CODE · LAB drop it the moment the disk does
      renderAside();updateComposer();
      if(st.view==='dl')renderDl();
      if(st.view==='int')renderInt();
    }
    // ---- engine lifecycle (bridge/matrix.mjs — permission-gated daemon control) ----
    async function refreshEng(){ // just try the RPC — Bridge.on() lags the real pairing state
      try{const s=await RPC('matrix','status');st.eng={avail:true,ownedPid:s.ownedPid,external:s.externalPid,crashed:s.crashed,
        found:s.engineFound,path:s.enginePath,lanExposed:s.lanExposed,listenAddr:s.listenAddr}}
      catch(_){st.eng={avail:false}}
      renderStatus(); // reflect the engine state as soon as it resolves
    }
    async function engStart(){
      st.engBusy=true;renderStatus();
      try{
        const r=await RPC('matrix','start');
        if(r&&r.ok)Toast.show(r.already?'Engine already running.':'Engine starting — the node appears as soon as it elects itself.');
        else{
          const err=(r&&r.error)||'start failed';
          // The bridge hands back the engine's own last words when it dies on startup;
          // showing them beats a generic failure the owner cannot act on.
          const why=(r&&r.logTail&&r.logTail.length)?(' — '+String(r.logTail[r.logTail.length-1]).slice(0,140)):'';
          Toast.show(/permission/.test(err)?'Enable Settings → My Machine → “MATRIX engine control” first.':('Start failed: '+err+why));
        }
      }catch(e){Toast.show('Start failed: '+((e&&e.message)||'bridge error'))}
      st.engBusy=false;
      refreshEng();
    }
    async function engStop(){
      try{
        const r=await RPC('matrix','stop');
        Toast.show(r&&r.ok?'Engine stopped.':('Stop failed: '+((r&&r.error)||'error')));
      }catch(e){Toast.show('Stop failed: '+((e&&e.message)||'bridge error'))}
      st.armed=null;refreshEng();
    }
    async function engTakeover(){ // external engine → kill by port + restart under app ownership
      try{
        const r=await RPC('matrix','stop',{force:true});
        if(!(r&&r.ok)){Toast.show('Takeover failed: '+((r&&r.error)||'error'));st.armed=null;refreshEng();return}
        Toast.show('External engine stopped — restarting under the app…');
      }catch(e){Toast.show('Takeover failed: '+((e&&e.message)||'bridge error'));st.armed=null;refreshEng();return}
      st.armed=null;
      await engStart();
    }
    // ---- BYOK provider — the cluster's OpenAI-compatible endpoint in the Models registry,
    // so CODE · LAB · Brain · Compare · Harness pickers can run on the user's own cluster.
    // Kept in LIVE SYNC: whenever the on-disk model set changes (download / delete), the
    // provider's model list is rewritten and every picker refreshed. A downloaded model that
    // isn't running is auto-launched on the first message by the bridge (/provider-chat).
    async function refreshProv(){
      try{
        const provs=await RPC('models','listProviders');
        // Match the same record the bridge does — provider tag, oldest first. Matching by
        // baseUrl let a user-added local provider on the same port stand in for MATRIX.
        const p=(provs||[]).filter(x=>x.provider==='matrix').sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))[0]||null;
        st.prov=p?{id:p.id,models:(p.models||[]).length,enabled:p.enabled!==false}:null;
        return p;
      }catch(_){st.prov=null;return null}
    }
    // Reconciliation lives in the bridge (Matrix.syncModels) so it is ONE implementation,
    // callable when this panel is closed and honest when the engine is down: a failed probe
    // used to write an empty list, which took every MATRIX model out of CODE and LAB on a
    // single 3s timeout. The panel only asks and reports.
    async function syncCluster(opts){
      opts=opts||{};
      if(st.provBusy)return; st.provBusy=true; // connect-tick fires two calls at once → never double-add
      try{
        const r=await RPC('matrix','syncModels',{ensure:!!opts.ensure});
        if(!r||r.ok===false){if(opts.toast)Toast.show('Sync failed: '+((r&&r.error)||'error'));return}
        st.prov=r.registered?{id:r.id,models:(r.models||[]).length,offered:r.offered,enabled:r.enabled!==false}:null;
        if(r.changed)Bus.emit('models:changed'); // refresh CODE + LAB pickers live
        // Report what the pickers will REALLY show: a switched-off provider offers
        // nothing, and a per-model toggle keeps a model listed but never offered.
        if(opts.toast)Toast.show(!r.registered?'Could not register the cluster.'
          :r.enabled===false?'MATRIX synced, but the provider is switched off in Settings → Added Models — no picker shows it.'
          :r.offered?('MATRIX synced — '+r.offered+' local model(s) in CODE · LAB · Brain · Harness.')
          :r.models.length?('MATRIX synced — '+r.models.length+' model(s) found, all switched off in Settings → Added Models.')
          :'MATRIX registered — download a model and it shows up in every picker.');
        if(r.changed&&st.view==='int')renderInt();
      }catch(e){if(opts.toast)Toast.show('Sync failed: '+((e&&e.message)||'bridge error'))}
      finally{st.provBusy=false}
    }
    const registerProvider=()=>syncCluster({ensure:true,toast:true});
    function renderMsgs(){
      const c=st.chat;
      if(!c){E.msgs.innerHTML='';return}
      // Force-scrolling on every repaint made it impossible to read back while the model
      // was still answering. Stick to the bottom only for a reader who was already there.
      const pinned=E.msgs.scrollHeight-E.msgs.scrollTop-E.msgs.clientHeight<24;
      const keep=E.msgs.scrollTop;
      E.msgs.innerHTML=c.msgs.map((m,i)=>{
        const t=m.t||'';
        if(m.role==='user'){
          const fl=(m.files&&m.files.length)?`<div style="margin-top:5px;font-size:10px;color:var(--ink-faint)">⎘ ${m.files.map(escHtml).join(' · ')}</div>`:'';
          return `<div class="mx-msg q"><div class="mx-mhead">${escHtml(t)} QUERY <i></i></div><div class="mx-bub">${escHtml(m.content)}${fl}</div></div>`;
        }
        const stats=m.stats?`<span class="mx-mstats">TTFT ${m.stats.ttft}ms · ${m.stats.tps} tok/s</span>`:'';
        const body=m.done?(window.MDLite?MDLite.render(m.content):escHtml(m.content)):escHtml(m.content)+(st.streaming&&i===c.msgs.length-1?'<span class="mx-cursor"></span>':'');
        const pre=(!m.content&&st.streaming&&i===c.msgs.length-1)?(m.prefill!=null?`<div class="mx-prefill"><i style="width:${m.prefill}%"></i></div>`:'<span class="mx-cursor"></span>'):'';
        return `<div class="mx-msg a"><div class="mx-mhead"><i></i><b>MATRIX</b> ${escHtml(t)} ${stats}</div><div class="mx-bub">${pre||body}</div></div>`;
      }).join('');
      E.msgs.scrollTop=pinned?E.msgs.scrollHeight:keep;
    }
    function dlCell(m,n,map,have){
      // The disk answer is about THIS machine only. Using it as a fallback for every
      // column painted a ✓ under remote nodes that had never seen the model.
      const isLocal=n.id==='local'||n.id===st.nodeId;
      const local=isLocal?have.get(m.id):null;
      const c=(map[m.id]&&map[m.id][n.id])||(local?{s:'done',bytes:local.bytes}:null);
      const act=(kind,glyph,title)=>`<button class="mx-dlact" data-mxdla="${kind}" data-n="${escAttr(n.id)}" data-m="${escAttr(m.id)}" title="${title}">${glyph}</button>`;
      // DownloadPending = the engine's "not on this node yet" idle state, same as no entry
      if(!c||c.s==='wait')return `<td class="c">${act('start','⤓','Download to this node')}</td>`;
      if(c.s==='done'){const sz=c.bytes?gb1(c.bytes):mb2gb(m.storage_size_megabytes||0);
        const rm=st.armed&&st.armed.key==='purge:'+m.id?'SURE?':'RM';
        return `<td class="c"><span class="ok">✓</span><span class="szl">${escHtml(sz)}</span>${act('disk',rm,'Delete this model from this machine — instance, download, weights and caches')}</td>`}
      if(c.s==='run')return `<td class="c"><div class="mx-dlbar" style="width:56px;margin:0 auto 3px"><i style="width:${c.pct}%"></i></div><span class="szl">${c.pct}%</span>${act('cancel','✕','Cancel download')}</td>`;
      return `<td class="c"><span style="color:var(--mx-err)">✗</span>${act('start','↻','Retry download')}</td>`;
    }
    function renderDl(){
      const s=st.st8||{},free=s.nodeDisk||{},map=dlMap();
      // With the engine down there are no nodes to draw, but the weights are still here.
      // One honest column beats a demo grid you cannot act on.
      const ns=liveCluster()?nodes():[{id:'local',name:'This machine',used:0,total:0}];
      const have=new Map(onDisk().filter(r=>r.disk).map(r=>[r.id,r]));
      const catalog=(st.models||[]).slice();
      const known=new Set(catalog.map(m=>m.id));
      for(const r of have.values())if(!known.has(r.id))catalog.push({id:r.id,name:r.name,family:'other',quant:'',base:r.name,
        storage_size_megabytes:Math.round((r.bytes||0)/1048576),gbLabel:r.bytes?gb1(r.bytes):'—'});
      const hasState=m=>have.has(m.id)||(map[m.id]&&Object.values(map[m.id]).some(x=>x.s!=='wait'));
      catalog.sort((a,b)=>(hasState(b)?1:0)-(hasState(a)?1:0));
      const shown=catalog.slice(0,40);
      const rows=shown.map(m=>`<tr><td title="${escAttr(m.id)}">${escAttr(m.id)}</td>${ns.map(n=>dlCell(m,n,map,have)).join('')}</tr>`);
      const html=`<div class="mx-dlhead"><div><div class="mx-dlh1">DOWNLOADS</div><div class="mx-dlsub">Overview of models on each node${st.online?'':' — engine offline, showing what is on this machine'}</div></div><button class="mx-dlattach" data-mx="attach" title="Attach a file to the chat"><svg><use href="#i-file"/></svg>ATTACH FILE</button></div>
        <table class="mx-dltable"><thead><tr><th>MODEL</th>${ns.map(n=>{
          const d=free[n.id];const fr=d&&d.available?gb1(d.available.inBytes)+' free':'';
          return `<th class="nd">${escHtml(n.name.toUpperCase())}<span class="free">${escHtml(fr)}</span></th>`;}).join('')}</tr></thead>
        <tbody>${rows.join('')||`<tr><td colspan="${ns.length+1}" style="color:var(--ink-faint)">Nothing downloaded, and no catalog — start the engine to browse models.</td></tr>`}</tbody></table>
        ${catalog.length>40?`<div class="mx-dlsub" style="margin-top:10px">…${catalog.length-40} more models — search in the model picker.</div>`:''}`;
      if(html!==st._dlHTML){st._dlHTML=html;E.dlbody.innerHTML=html} // same reason as the rail: a 1 Hz rewrite eats clicks
    }
    const INT_TOOLS=[['claude','Claude Code'],['opencode','OpenCode'],['codex','Codex'],['webui','Open WebUI'],['n8n','n8n']];
    function intCmd(tool){
      const model=readyModel()||'<model-id>';
      if(tool==='claude')return `ANTHROPIC_BASE_URL=${API} \\\nANTHROPIC_API_KEY=x \\\nANTHROPIC_DEFAULT_OPUS_MODEL=${model} \\\nANTHROPIC_DEFAULT_SONNET_MODEL=${model} \\\nANTHROPIC_DEFAULT_HAIKU_MODEL=${model} \\\nclaude`;
      if(tool==='opencode')return `# ~/.config/opencode/opencode.json\n{\n  "provider": {\n    "matrix": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "${API}/v1" },\n      "models": { "${model}": {} }\n    }\n  }\n}`;
      if(tool==='codex')return `# ~/.codex/config.toml\nmodel = "${model}"\nmodel_provider = "matrix"\n\n[model_providers.matrix]\nname = "MATRIX"\nbase_url = "${API}/v1"\nwire_api = "chat"`;
      if(tool==='webui')return `docker run -d -p 3000:8080 \\\n  -e OPENAI_API_BASE_URL=${API}/v1 \\\n  -e OPENAI_API_KEY=matrix \\\n  ghcr.io/open-webui/open-webui:main`;
      return `# n8n — OpenAI-compatible credential\nBase URL: ${API}/v1\nAPI Key:  matrix (any value)\nModel:    ${model}`;
    }
    function renderInt(){
      const model=readyModel();
      E.intbody.innerHTML=`<h2>Integrations</h2><div class="mx-intsub">Connect external tools to your MATRIX cluster.</div>
        <div class="mx-kv"><span class="k">API ENDPOINT</span><span class="v">${escHtml(API)}</span></div>
        <div class="mx-kv"><span class="k">RUNNING MODEL</span><span class="v acc">${model?escHtml(model):'— none (launch a model first)'}</span></div>
        ${(st.eng&&st.eng.lanExposed)?`<div class="mx-lanwarn"><b>⚠ THIS ENGINE ANSWERS ON YOUR WHOLE NETWORK</b>
          <span>The engine listens on <b>${escHtml(st.eng.listenAddr||'0.0.0.0:52415')}</b>, not just this machine, and it asks for no password — that is how nodes find each other, and it is hardcoded in the engine. Anyone on this Wi-Fi can list, load and query your models. Stop it when you are on a network you do not trust.</span></div>`:''}
        <div class="mx-endp">
          <div class="mx-ecard"><div class="t">OPENAI-COMPATIBLE</div><div class="u">${escHtml(API)}/v1</div></div>
          <div class="mx-ecard"><div class="t">CLAUDE-COMPATIBLE</div><div class="u">${escHtml(API)}</div></div>
          <div class="mx-ecard"><div class="t">OLLAMA-COMPATIBLE</div><div class="u">${escHtml(API)}/ollama</div></div>
        </div>
        <div class="mx-provcard">
          <div class="t">USE THIS CLUSTER IN CLONE FRAME</div>
          <div class="d">Register MATRIX as a BYOK provider — its models join the Terminal, Brain, Compare and Harness model pickers, served from your own machines. No key, no cloud.</div>
          <div class="row"><button class="mx-provbtn" data-mx="provider">${st.prov?'↻ REFRESH MODELS':'⚡ REGISTER AS PROVIDER'}</button><span class="st">${st.prov?`<b>✓ registered</b> — ${st.prov.models} model(s) in the pickers`:'not registered yet'}</span></div>
        </div>
        <div class="mx-provcard">
          <div class="t">OR BRING A CLOUD MODEL</div>
          <div class="d">Prefer a hosted API? Connect <b>DeepSeek</b>, OpenAI, or <b>any OpenAI-compatible endpoint</b> (custom base URL + key). It joins the same Terminal, Brain, Compare and Harness pickers — your key stays on your machine.</div>
          <div class="row"><button class="mx-provbtn" data-mx="cloudmodel">＋ CONNECT DEEPSEEK / CUSTOM API</button><span class="st">opens Settings → Add Models</span></div>
        </div>
        <div class="mx-ttabs">${INT_TOOLS.map(t=>`<button data-mxtool="${t[0]}" class="${st.intTool===t[0]?'on':''}">${escHtml(t[1])}</button>`).join('')}</div>
        <div class="mx-code"><div class="mx-codeh"><b>Shell Command</b><span>Run in terminal</span><button class="mx-copy" data-mx="runit">▸ OPEN IN iT</button><button class="mx-copy" data-mx="copy">COPY</button></div>
        <pre data-mx="cmdpre">${escHtml(intCmd(st.intTool))}</pre></div>`;
    }
    function setView(v){
      st.view=v;
      root.querySelectorAll('.mx-nav button').forEach(b=>b.classList.toggle('on',b.dataset.mxview===(v==='chat'?'home':v)));
      root.querySelector('.mx-vhome').classList.toggle('on',v==='home');
      root.querySelector('.mx-vchat').classList.toggle('on',v==='chat');
      root.querySelector('.mx-vdl').classList.toggle('on',v==='dl');
      root.querySelector('.mx-vint').classList.toggle('on',v==='int');
      E.composer.style.display=(v==='home'||v==='chat')?'':'none';
      if(v==='dl')renderDl();
      if(v==='int'){renderInt();refreshProv().then(()=>{if(st.view==='int')renderInt()})}
      if(v==='home')requestAnimationFrame(()=>drawTopo(E.topo,false));
      if(v==='chat')renderMsgs();
      renderAside();
    }

    // ---- live polling ----
    async function tick(){
      if(!p.isConnected){clearInterval(st.timer);st.timer=null;return}
      invalidateDisk();
      try{
        const r=await fetch(API+'/state',{signal:AbortSignal.timeout(1500)});
        if(!r.ok)throw 0;
        st.st8=await r.json();st.fails=0;
        const was=st.online;st.online=true;
        if(!was){loadModels();syncCluster();st.nodeId=null} // just came online → register + sync the pickers
        // exo mints a NEW random node id on every start (routing/router.py: persistence is
        // disabled upstream), so this is per-session and must be re-read, never cached to disk.
        if(!st.nodeId){try{const q=await fetch(API+'/node_id',{signal:AbortSignal.timeout(1500)});if(q.ok)st.nodeId=await q.json()}catch(_){}}
      }catch(_){st.fails++;if(st.fails>=2)st.online=false}
      if(st.armed&&performance.now()-st.armed.ts>6000)st.armed=null;
      st.tickN=(st.tickN||0)+1;
      if(st.tickN%8===1)refreshEng();
      if(st.tickN%5===2)refreshLocal();          // the disk answers whether the engine is up or not
      if(st.online&&st.tickN%5===0)syncCluster(); // keep the pickers in sync with disk (download/delete)
      if(st.selModel&&st.online&&st.tickN%15===0)fetchPreview(st.selModel.id);
      // stall tracking: an instance that sits non-READY for minutes means the engine
      // wedged mid-load (seen killing WindowServer on 2026-07-21) — surface it honestly
      st.instSeen=st.instSeen||{};
      const now=performance.now(),liveIds=new Set();
      for(const i of instances()){liveIds.add(i.id);if(i.status==='READY'||i.demo)delete st.instSeen[i.id];else if(!st.instSeen[i.id])st.instSeen[i.id]=now}
      for(const id of Object.keys(st.instSeen))if(!liveIds.has(id))delete st.instSeen[id];
      renderStatus();
      if(st.view==='home')drawTopo(E.topo,false);
      // while a destructive confirm is armed, keep the DOM still — re-rendering every
      // second swapped the SURE? button from under the second click (BUG-L9-002)
      if(!st.armed){
        if(st.view==='dl')renderDl();
        renderAside();
      }
      updateComposer();
    }
    async function loadModels(){
      try{
        const r=await fetch(API+'/models',{signal:AbortSignal.timeout(3000)});
        const j=await r.json();st.models=(j.data||j||[]).map(m=>({id:m.id,name:m.name||m.id.split('/').pop(),family:m.family||'other',quant:m.quantization||'',base:m.base_model||m.name||m.id,storage_size_megabytes:m.storage_size_megabytes||0,caps:m.capabilities||[],gbLabel:mb2gb(m.storage_size_megabytes||0)}));
      }catch(_){st.models=null}
      renderAside();
    }
    // The model the composer will actually talk to. The selection wins over whatever
    // happens to be resident: the label and the request must name the same model.
    function chatModel(){return st.selModel?st.selModel.id:readyModel()}
    function updateComposer(){
      const mv=chatModel();
      // A promise the first guard in sendChat will refuse is not a promise. The engine
      // being up is part of "usable", so the hot SEND and the placeholder cannot lie.
      const usable=!!mv&&st.online&&onDisk().some(r=>r.id===mv&&r.usable);
      E.modellbl.textContent=mv?(st.selModel?st.selModel.name:mv.split('/').pop()):'— SELECT MODEL —';
      E.input.placeholder=!mv?'Choose a model to start chatting'
        :!st.online?'Engine offline — press START ENGINE to chat'
        :usable?(liveNow(mv)?'Ask anything':'Ask anything — it loads on your first message')
        :'Not on this machine yet — LAUNCH it once to download';
      E.send.classList.toggle('hot',!!(E.input.value.trim()&&usable)&&!st.streaming);
      E.send.classList.toggle('stop',st.streaming);
      E.send.textContent=st.streaming?'■ STOP':'SEND';
      if(st.stats)E.cstats.innerHTML=`<span>TTFT <b>${st.stats.ttft}ms</b></span><span>TPS <b>${st.stats.tps} tok/s</b></span>`;
    }

    // ---- chat (real streaming against the READY instance) ----
    async function sendChat(){
      if(st.streaming){try{st.abort&&st.abort.abort()}catch(_){}return}
      const text=E.input.value.trim();if(!text)return;
      const model=chatModel();
      if(!st.online){Toast.show('MATRIX engine is offline — start it first, then pick a model.');return}
      if(!model){Toast.show('Pick a model first — ON THIS MACHINE in the right rail, or SELECT MODEL for the full catalog.');return}
      if(!liveNow(model)&&!onDisk().some(r=>r.id===model&&r.usable)){
        Toast.show('That model is not ready on this machine yet — press LAUNCH once and MATRIX downloads it.');return;
      }
      const hhmm=new Date().toTimeString().slice(0,8);
      // Bind the conversation for the whole turn. "+ NEW CHAT" or deleting the open
      // conversation mid-stream used to null st.chat under this function, which then
      // threw on the first write and reported a successful answer as a failed chat.
      const conv=st.chat||{id:String(Date.now()),title:text.slice(0,42),model,msgs:[],stats:null};
      if(!st.chat){st.chat=conv;st.convs.unshift(conv)}
      // Error and status prose the PANEL wrote is not something the model said. Replaying
      // it as prior assistant turns taught the model to imitate the app's own failures.
      const history=conv.msgs.filter(m=>m.content&&!m.err).map(m=>({role:m.role,content:m.sent||m.content}));
      const files=st.attach.splice(0);renderChips();
      const sent=files.length?text+'\n\n'+files.map(f=>'--- attached file: '+f.name+' ---\n'+f.text).join('\n\n'):text;
      history.push({role:'user',content:sent});
      conv.msgs.push({role:'user',content:text,sent,t:hhmm,files:files.map(f=>f.name)});
      const bot={role:'assistant',content:'',t:hhmm,stats:null,prefill:null,done:false};
      conv.msgs.push(bot);
      E.input.value='';st.streaming=true;setView('chat');renderSide();updateComposer();
      const onScreen=()=>st.chat===conv;
      const paint=()=>{if(onScreen())renderMsgs()};
      // Per-token full rebuilds ran MDLite over the entire transcript for every delta.
      // Only the tail changes while streaming, so only the tail is written.
      let painting=0;
      const paintDelta=()=>{
        if(!onScreen()||painting)return;
        painting=requestAnimationFrame(()=>{
          painting=0;
          const el=E.msgs.querySelector('.mx-msg.a:last-child .mx-bub');
          if(!el){renderMsgs();return}
          const pinned=E.msgs.scrollHeight-E.msgs.scrollTop-E.msgs.clientHeight<24;
          el.textContent=bot.content;
          if(pinned)E.msgs.scrollTop=E.msgs.scrollHeight;
        });
      };
      st.abort=new AbortController();
      // A model already on disk answers on the first message. Nothing to hunt for, no
      // manual LAUNCH — the same promise the bridge keeps for CODE and LAB, kept here too.
      if(!liveNow(model)){
        bot.content='Loading '+String(model).split('/').pop()+' into memory — the first message after an engine restart takes a moment…';
        bot.err=true;paint();
        st.ensuring=true;
        const up=await ensureLive(model,st.abort.signal);
        st.ensuring=false;bot.content='';bot.err=false;
        if(!up){
          bot.content=st.abort.signal.aborted?'— stopped —'
            :'⚠ Could not bring '+String(model).split('/').pop()+' up. INSTANCES in the right rail says why — a FAILED runner means the engine log has the reason.';
          bot.err=true;bot.done=true;st.streaming=false;st.abort=null;
          saveConvs();paint();renderSide();updateComposer();return;
        }
        paint();
      }
      const t0=performance.now();let ttft=0,ntok=0;
      // stall watchdog: a local model must never hang the chat forever — if no first
      // token lands in 90s, abort with an honest message instead of infinite silence
      let stalled=false;
      const stallTO=setTimeout(()=>{if(!ntok&&st.abort){stalled=true;try{st.abort.abort()}catch(_){}}},90000);
      try{
        const r=await fetch(API+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model,messages:history,stream:true}),signal:st.abort.signal});
        if(!r.ok)throw new Error('HTTP '+r.status);
        const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
        for(;;){
          const {done,value}=await rd.read();if(done)break;
          buf+=dec.decode(value,{stream:true});
          const lines=buf.split('\n');buf=lines.pop();
          for(const line of lines){
            const L=line.trim();if(!L)continue;
            if(L.startsWith(':')){
              const m=L.match(/^:\s*(\w+)\s+(.*)$/);
              if(m){try{const j=JSON.parse(m[2]);
                if(m[1]==='prefill_progress'&&j.total)bot.prefill=Math.round((j.processed||0)/j.total*100);
                if(m[1]==='generation_stats'){const tps=j.tokens_per_second||j.tps;if(tps)bot.stats={ttft:Math.round(j.time_to_first_token_ms||ttft),tps:(+tps).toFixed(1)}}
              }catch(_){}}
              continue;
            }
            if(!L.startsWith('data:'))continue;
            const d=L.slice(5).trim();if(d==='[DONE]')continue;
            try{
              const j=JSON.parse(d);
              const delta=j.choices&&j.choices[0]&&j.choices[0].delta;
              const piece=delta&&delta.content;
              if(piece){if(!ntok){ttft=Math.round(performance.now()-t0);clearTimeout(stallTO);paint()}ntok++;bot.content+=piece;bot.prefill=null;paintDelta()}
            }catch(_){}
          }
        }
        const secs=(performance.now()-t0-ttft)/1000;
        if(!bot.stats)bot.stats={ttft,tps:secs>0?(ntok/secs).toFixed(1):'—'};
        conv.stats=bot.stats;st.stats=bot.stats;
      }catch(err){
        if(stalled){bot.content='⚠ No response from the local model after 90s — it may still be warming up, or the engine is wedged. Check INSTANCES (a STUCK? badge means restart the engine).';bot.err=true;Toast.show('Local model did not answer — see the chat for what to do.')}
        else if(err&&err.name==='AbortError'){if(!bot.content)bot.err=true;bot.content+=bot.content?'\n— stopped —':'— stopped —'}
        else{if(!bot.content)bot.err=true;bot.content=bot.content||('⚠ '+(err&&err.message||'stream failed'));Toast.show('MATRIX chat failed: '+(err&&err.message||'stream error'))}
      }
      clearTimeout(stallTO);
      if(painting)cancelAnimationFrame(painting);
      bot.done=true;st.streaming=false;st.abort=null;
      saveConvs();
      paint();renderSide();updateComposer(); // one full render at the end, for the markdown pass
    }

    // ---- model picker ----
    const FAM_ORDER=['kimi','qwen','glm','minimax','deepseek','gpt-oss','llama','gemma','nemotron'];
    function famList(){
      const fams=new Set((st.models||[]).map(m=>m.family));
      const rest=[...fams].filter(f=>!FAM_ORDER.includes(f)).sort();
      return ['all',...(st.favs.size?['fav']:[]),...FAM_ORDER.filter(f=>fams.has(f)),...rest];
    }
    // With no live cluster there is nothing to fit against. Colouring a size from DEMO
    // memory told the owner a 70B model was comfortable on a 16GB laptop.
    function fitClass(mb){if(!liveCluster())return '';const b=mb*1048576;if(b<=clusterFree())return '';if(b<=clusterTotal())return 'tight';return 'no'}
    function renderPicker(){
      const free=clusterFree(),total=clusterTotal();
      const disk=onDisk(),have=new Set(disk.filter(r=>r.usable).map(r=>r.id));
      E.pmem.innerHTML=liveCluster()?`<b>${escHtml(gb1(free))}</b>/${escHtml(gb1(total))}`:'<span class="dim">engine offline</span>';
      E.fam.innerHTML=famList().map(f=>`<button data-mxfam="${escAttr(f)}" class="${st.famFilter===f?'on':''}">${escAttr(f==='all'?'All':f==='fav'?'★ Fav':f)}</button>`).join('');
      // token-AND search: "3.2 3b" must find "Llama-3.2-3B-…" (separators vary per model id)
      const toks=st.query.toLowerCase().split(/\s+/).filter(Boolean);
      // Pinned above everything, family filter included: a model you already downloaded
      // must never be something you have to hunt for among a hundred you have not.
      const mine=disk.filter(r=>r.here&&toks.every(t=>(r.id+' '+r.name).toLowerCase().includes(t)));
      const mineHTML=mine.length?`<div class="mx-pgrp">◆ ON THIS MACHINE <span class="sub">— already downloaded</span></div>`
        +mine.map(r=>`<div class="mx-pvar have" data-mxpick="${escAttr(r.id)}"><span class="q">${r.live?'live':r.loading?'loading':(r.partial&&!r.usable)?'incomplete':'on disk'}</span><span>${escHtml(r.name)}</span><span class="dl">${r.usable?'✓':'◐'}</span><span class="sz">${escHtml(r.bytes?gb1(r.bytes):'—')}</span></div>`).join(''):'';
      if(!st.models){
        E.plist.innerHTML=mineHTML+`<div class="mx-pempty">${mine.length?'The full catalog needs the engine running — your downloaded models are above.':'Engine offline — no catalog.<br>Start your MATRIX engine to browse models.'}</div>`;
        return;
      }
      let list=st.models.filter(m=>{
        if(st.famFilter!=='all'&&st.famFilter!=='fav'&&m.family!==st.famFilter)return false;
        if(!toks.length)return true;
        const hay=(m.id+' '+m.name+' '+m.base+' '+m.quant).toLowerCase();
        return toks.every(t=>hay.includes(t));
      });
      // group variants by base model
      const groups=new Map();
      for(const m of list){const k=m.base+'|'+m.family;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(m)}
      let rows=[...groups.values()];
      if(st.famFilter==='fav')rows=rows.filter(g=>st.favs.has(g[0].base+'|'+g[0].family));
      const fits=g=>g.some(m=>fitClass(m.storage_size_megabytes)==='');
      const rec=rows.filter(fits),oth=rows.filter(g=>!fits(g));
      const rowHTML=g=>{
        const one=g.length===1,m0=g[0],key=m0.base+'|'+m0.family;
        const minMB=Math.min(...g.map(m=>m.storage_size_megabytes)),maxMB=Math.max(...g.map(m=>m.storage_size_megabytes));
        const sz=one?m0.gbLabel:`${g.length} variants (${mb2gb(minMB)}–${mb2gb(maxMB)})`;
        const openG=st.open.has(key),isFav=st.favs.has(key);
        return `<div class="mx-prow" data-mxpick="${escAttr(one?m0.id:'')}" data-mxgrp="${escAttr(one?'':key)}">
          <span class="car">${one?'':(openG?'▾':'▸')}</span><span class="nm">${escHtml(m0.base)}</span>
          <span class="sz ${fitClass(minMB)}">${escAttr(sz)}</span><span class="star${isFav?' on':''}" data-mxfav="${escAttr(key)}" title="Favorite">${isFav?'★':'☆'}</span>
        </div>${openG&&!one?g.map(v=>`<div class="mx-pvar" data-mxpick="${escAttr(v.id)}"><span class="q">${escAttr(v.quant||'default')}</span><span>${escAttr(v.name)}</span>${have.has(v.id)?'<span class="dl">✓ on disk</span>':''}<span class="sz ${fitClass(v.storage_size_megabytes)}">${escAttr(v.gbLabel)}</span></div>`).join(''):''}`;
      };
      // Offline, everything "fits" (fitClass refuses to guess), so the split would be a
      // lie dressed as a recommendation — show one honest list instead.
      E.plist.innerHTML=mineHTML
        +(!liveCluster()
          ?(rows.length?`<div class="mx-pgrp oth">ALL MODELS <span class="sub">— start the engine to see what fits</span></div>`+rows.map(rowHTML).join(''):'')
          :(rec.length?`<div class="mx-pgrp">◎ RECOMMENDED FOR YOUR CLUSTER <span class="sub">— fits in available memory</span></div>`+rec.map(rowHTML).join(''):'')
           +(oth.length?`<div class="mx-pgrp oth">OTHER MODELS</div>`+oth.map(rowHTML).join(''):''))
        ||'<div class="mx-pempty">No models match.</div>';
    }
    function pickModel(id){
      let m=(st.models||[]).find(x=>x.id===id);
      // A model on disk stays selectable when the engine — and with it the catalog — is
      // not answering. Owning a model and being unable to point at it are the same thing.
      if(!m){
        const r=onDisk().find(x=>x.id===id);if(!r)return;
        m={id:r.id,name:r.name,family:'other',quant:'',base:r.name,caps:[],
           storage_size_megabytes:Math.round((r.bytes||0)/1048576),gbLabel:r.bytes?gb1(r.bytes):'—'};
      }
      st.selModel=m;st.preview=null;E.picker.classList.remove('on');
      renderAside();updateComposer();fetchPreview(id);
    }

    // ---- events ----
    root.addEventListener('click',e=>{
      const t=e.target;
      const nav=t.closest('[data-mxview]');if(nav){setView(nav.dataset.mxview);return}
      const act=t.closest('[data-mx]');
      const frm=t.closest('[data-mxfrm]');
      if(frm){st.attach.splice(+frm.dataset.mxfrm,1);renderChips();return}
      const cren=t.closest('[data-mxcren]');
      if(cren){st.renaming=cren.dataset.mxcren;renderSide();
        const inp=root.querySelector('[data-mxrenin]');if(inp){inp.focus();inp.select()}return}
      if(t.closest('[data-mxrenin]'))return; // clicks inside the rename input never open the conversation
      const cdel=t.closest('[data-mxcdel]');
      if(cdel){const id=cdel.dataset.mxcdel;const c=st.convs.find(x=>x.id===id);
        st.convs=st.convs.filter(x=>x.id!==id);
        // Dropping the conversation a stream is writing into leaves the composer stuck in
        // STOP forever. Abort first and let the normal AbortError path unwind the turn.
        if(st.chat===c){if(st.streaming){try{st.abort&&st.abort.abort()}catch(_){}st.streaming=false}st.chat=null;setView('home');updateComposer()}
        saveConvs();renderSide();return}
      const conv=t.closest('.mx-conv');if(conv){const c=st.convs.find(x=>x.id===conv.dataset.cid);if(c){st.chat=c;setView('chat');renderSide()}return}
      const fam=t.closest('[data-mxfam]');if(fam){st.famFilter=fam.dataset.mxfam;renderPicker();return}
      const tool=t.closest('[data-mxtool]');if(tool){st.intTool=tool.dataset.mxtool;renderInt();return}
      const del=t.closest('[data-mxdel]');
      if(del){
        if(del.dataset.demo){Toast.show('Demo instance — start the engine for real ops.');return}
        if(arm('inst:'+del.dataset.mxdel))delInstance(del.dataset.mxdel);
        return;
      }
      // ON THIS MACHINE rows — buttons before the row itself, which selects the model
      const lmrm=t.closest('[data-mxlmrm]');
      if(lmrm){const id=lmrm.dataset.mxlmrm;if(arm('purge:'+id))purgeModel(id);return}
      const lmload=t.closest('[data-mxlmload]');
      if(lmload){pickModel(lmload.dataset.mxlmload);launch();return}
      const lmuse=t.closest('[data-mxlmuse]');
      if(lmuse){pickModel(lmuse.dataset.mxlmuse);E.input.focus();return}
      const lmrow=t.closest('[data-mxlm]');
      if(lmrow){pickModel(lmrow.dataset.mxlm);return}
      const dla=t.closest('[data-mxdla]');
      if(dla){
        const nid=dla.dataset.n,mid=dla.dataset.m;
        // Deleting is the one op that must survive the engine being down — the bridge
        // owns the disk, so it needs no node and no running daemon.
        if(dla.dataset.mxdla==='disk'){if(arm('purge:'+mid))purgeModel(mid);return}
        if(!st.online){Toast.show('MATRIX engine is offline.');return}
        if(dla.dataset.mxdla==='start')dlStart(nid,mid);
        else if(dla.dataset.mxdla==='cancel')dlCancel(nid,mid);
        return;
      }
      const opt=t.closest('[data-mxopt]');
      if(opt){
        if(opt.dataset.mxopt==='sharding')st.launchOpts.sharding=st.launchOpts.sharding==='Pipeline'?'Tensor':'Pipeline';
        if(opt.dataset.mxopt==='nodes')st.launchOpts.allNodes=!st.launchOpts.allNodes;
        renderAside();if(st.selModel)fetchPreview(st.selModel.id);
        return;
      }
      const favb=t.closest('[data-mxfav]');
      if(favb){const k=favb.dataset.mxfav;st.favs.has(k)?st.favs.delete(k):st.favs.add(k);
        if(st.famFilter==='fav'&&!st.favs.size)st.famFilter='all';
        saveFavs();renderPicker();return}
      const pick=t.closest('[data-mxpick]');
      if(pick){
        if(pick.dataset.mxpick){pickModel(pick.dataset.mxpick);return}
        const k=pick.dataset.mxgrp;if(k){st.open.has(k)?st.open.delete(k):st.open.add(k);renderPicker();return}
      }
      if(!act)return;
      switch(act.dataset.mx){
        case 'burger':root.classList.toggle('side-off');break;
        case 'newchat':
          if(st.streaming){try{st.abort&&st.abort.abort()}catch(_){}st.streaming=false}
          st.chat=null;st.stats=null;setView('home');renderSide();updateComposer();break;
        case 'modelbtn':case 'mtrig':E.picker.classList.add('on');renderPicker();setTimeout(()=>E.pq.focus(),30);break;
        case 'pclose':E.picker.classList.remove('on');break;
        case 'launch':launch();break;
        case 'engine':{
          const m=act.dataset.mode;
          if(st.engBusy||m==='busy')break; // a start is already in flight — a second one spawns a second engine
          if(m==='connect')Toast.show('To run the engine: relaunch the app so the bridge loads MATRIX control, then enable Settings → My Machine → “MATRIX engine control”.');
          else if(m==='noengine')Toast.show('No MATRIX engine on this machine. Expected at '+((st.eng&&st.eng.path)||'~/exo/.venv/bin/exo')+' — install it there, or set the path in matrix.json.');
          else if(m==='extunknown')Toast.show('An engine is serving this port but this system cannot tell which process it is — stop it where you started it.');
          else if(m==='takeover'){if(arm('engtake'))engTakeover()}
          else if(m==='stop'){if(arm('engine'))engStop()}
          else engStart();
          break;
        }
        case 'addnode':el('addpop').classList.add('on');break;
        case 'addclose':el('addpop').classList.remove('on');break;
        case 'addcopy':{const pre=root.querySelector('[data-mx="addcmd"]');
          navigator.clipboard.writeText(pre?pre.textContent:'').then(()=>Toast.show('Setup commands copied — AirDrop or paste them on the new Mac.')).catch(()=>Toast.show('Copy blocked — select the block manually.'));break}
        case 'provider':registerProvider();break;
        case 'cloudmodel':openPanel('settings');setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="addmodels"]');if(b)b.click()},80);break;
        case 'attach':E.fileinput.click();break;
        case 'send':sendChat();break;
        case 'copy':{const pre=root.querySelector('[data-mx="cmdpre"]');
          navigator.clipboard.writeText(pre?pre.textContent:'').then(()=>Toast.show('Copied.'));break}
        case 'runit':{const pre=root.querySelector('[data-mx="cmdpre"]');
          openPanel('shell'); // open first — a failed clipboard write must never block the terminal
          navigator.clipboard.writeText(pre?pre.textContent:'')
            .then(()=>Toast.show('Command copied — paste it in iT (⌘V) and run.'))
            .catch(()=>Toast.show('iT opened — copy the command from INTEGRATIONS.'));
          break}
      }
    });
    E.picker.addEventListener('click',e=>{if(e.target===E.picker)E.picker.classList.remove('on')});
    el('addpop').addEventListener('click',e=>{if(e.target===el('addpop'))el('addpop').classList.remove('on')});
    E.fileinput.addEventListener('change',()=>{addFiles(E.fileinput.files);E.fileinput.value=''});
    // drop a file anywhere on MATRIX → attached (dragenter/leave counted — children fire pairs)
    let dragDepth=0;
    root.addEventListener('dragenter',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files')){e.preventDefault();dragDepth++;root.classList.add('dropping')}});
    root.addEventListener('dragover',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files'))e.preventDefault()});
    root.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;root.classList.remove('dropping')}});
    root.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;root.classList.remove('dropping');addFiles(e.dataTransfer&&e.dataTransfer.files)});
    E.pq.addEventListener('input',()=>{st.query=E.pq.value;renderPicker()});
    E.search.addEventListener('input',renderSide);
    // rename commit/cancel — delegated so re-renders never drop the listeners
    E.convs.addEventListener('keydown',e=>{
      const inp=e.target.closest('[data-mxrenin]');if(!inp)return;
      if(e.key==='Enter'){e.preventDefault();inp.blur()}
      if(e.key==='Escape'){st.renaming=null;renderSide()}
    });
    E.convs.addEventListener('focusout',e=>{
      const inp=e.target.closest('[data-mxrenin]');if(!inp||st.renaming!==inp.dataset.mxrenin)return;
      const c=st.convs.find(x=>x.id===inp.dataset.mxrenin);
      if(c&&inp.value.trim())c.title=inp.value.trim();
      st.renaming=null;saveConvs();renderSide();
    });
    E.input.addEventListener('input',()=>{E.input.style.height='auto';E.input.style.height=Math.min(150,E.input.scrollHeight)+'px';updateComposer()});
    E.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendChat()}});

    // ---- boot ----
    renderSide();renderAside();renderStatus();updateComposer();
    requestAnimationFrame(()=>drawTopo(E.topo,false));
    new ResizeObserver(()=>{if(st.view==='home')drawTopo(E.topo,false)}).observe(root.querySelector('.mx-canvas'));
    tick();loadModels();refreshEng();refreshProv();
    refreshLocal().then(()=>{renderAside();updateComposer()}); // the rail must know what you own before the engine answers
    st.timer=setInterval(tick,1000);
    // Docking is "tuck this away", not "close this" — LAB already lets a docked chat
    // finish. A wait on ensureLive is different: it polls st.st8, which stops being
    // refreshed the moment the tick is cleared, so that one must still be cut.
    p._dispose=()=>{
      try{clearInterval(st.timer)}catch(_){ }
      if(!p.dataset.docking||st.ensuring){try{st.abort&&st.abort.abort()}catch(_){ }}
    };
  }
