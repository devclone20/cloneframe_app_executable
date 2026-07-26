  function wireLab(p){
    const body=p.querySelector('#labbody');
    let tab='chat',cat=[],fam='all',mq='',pollT=null;
    let inftSub=localStorage.getItem('cfhub.lab.inftsub')||'turbo',osSel=null; // SERVER section: Turbo (local) | Online Server (droplet)
    if(inftSub==='myinft')inftSub='turbo'; // legacy stored value — normalize to the default server view
    let load={sharding:'pipeline',interconnect:'tcp',minDevices:1};
    let chat={model:'',msgs:[],streaming:false,ctl:null};
    let _lastLabChat=null; // scroll: first render jumps to bottom, later renders respect the reader
    let agView='list';                       // Agents tab: 'list' | 'detail' (the full AGENT view lives here now)
    const deck={i:0,list:[],el:null,ct:null}; // Chat tab: the draggable stack of selected agents
    const gb=n=>n>=1?n.toFixed(1)+'GB':Math.round(n*1024)+'MB';
    const sameAgent=(a,b)=>!!(a&&b)&&String(a.tokenId)===String(b.tokenId)&&(!a.contract||!b.contract||String(a.contract).toLowerCase()===String(b.contract).toLowerCase());

    // ---- active iNFT (shows the animated art while you work with an iNFT agent) ----
    // agent art at OpenSea-style fidelity: 3D .glb/.gltf → <model-viewer>, video → <video>,
    // html/interactive → sandboxed <iframe>, image → <img>
    function artHTML(a){
      if(!a)return'<div class="ph">iNFT</div>';
      const anim=a.animation||'';
      // Scheme guard (T-071): only http(s)/ipfs media reaches a frame src — a javascript:/data:/blob:
      // anim would otherwise land in the sandboxed iframe and EXECUTE; rejected → still image.
      const v=safeMediaUrl(anim);
      if(v){
        if(a.mediaType==='video'||/\.(mp4|webm|mov|m4v)(\?|$)/i.test(anim))return `<video src="${escAttr(v)}" autoplay loop muted playsinline></video>`;
        // poster = the agent's still, shown instantly while the 3D model streams in
        // (no blank flash when a deck card is promoted to the front)
        if(a.mediaType==='glb'||/\.(glb|gltf)(\?|$)/i.test(anim)){ensureModelViewer();const p=safeImageUrl(a.image);const poster=p?` poster="${escAttr(p)}"`:'';return `<model-viewer src="${escAttr(v)}"${poster} camera-controls auto-rotate autoplay shadow-intensity="1" interaction-prompt="none"></model-viewer>`}
        if(!/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))return `<iframe src="${escAttr(v)}" sandbox="allow-scripts" loading="lazy"></iframe>`;
      }
      const src=safeImageUrl((anim&&/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))?anim:(a.image||''));
      return src?`<img src="${escAttr(src)}" alt="" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;ph&quot;>iNFT</div>')">`:'<div class="ph">iNFT</div>';
    }
    // Two deliberate click zones: the ART is for interacting with the agent (model-viewer
    // orbit — drag rotates the animated 3D, OpenSea-style, it never navigates); only the
    // FOOTER strip ("Your agent iNFT… / View everything →") opens the agent detail,
    // which now lives inside LAB → Agents.
    function inftCard(a,live){
      if(!a||!a.name)return'';
      const attrs=a.attributes||[];
      const desc=a.description||'Your agent iNFT — its art animates while you work with it.';
      return `<div class="labinft ${live?'live':''}">
        <div class="art">${artHTML(a)}${live?'<span class="live"><i></i>LIVE</span>':''}</div>
        <div class="im">
          <div class="hd"><b>${escHtml(a.name)}</b>${a.collection?`<span class="col">· ${escHtml(a.collection)}</span>`:''}</div>
          <div class="at">${attrs.slice(0,3).map(x=>`<span>${escHtml(x.value||x.trait_type||'')}</span>`).join('')}</div>
          <div class="ft" data-agdetail title="View everything about this agent"><div class="d">${escHtml(desc)}</div><div class="go">View everything <i>→</i></div></div>
        </div></div>`;
    }
    // a light still for the side (ghost) cards — one live <model-viewer> at a time keeps
    // the deck fluid; a ghost promoted to the front swaps its still for the full art
    function stillArt(a){
      const img=safeImageUrl(a.image||((a.animation&&/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(a.animation))?a.animation:''));
      return img?`<img src="${escAttr(img)}" alt="" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;ph&quot;>iNFT</div>')">`:artHTML(a);
    }
    function pickAgent(a){
      const st0=Store.get();if(!Array.isArray(st0.pinnedAgents))st0.pinnedAgents=[];
      const i=st0.pinnedAgents.findIndex(x=>x.contract===a.contract&&String(x.tokenId)===String(a.tokenId));
      if(i>=0){st0.pinnedAgents.splice(i,1);Toast.show(a.name+' removed from the terminal')}
      else{st0.pinnedAgents.push({contract:a.contract,tokenId:a.tokenId,name:a.name,collection:a.collection,image:a.image,animation:a.animation,mediaType:a.mediaType,description:a.description,attributes:a.attributes});Toast.show('✓ '+a.name+' — pick it in CODE\'s agent selector')}
      Store.save();WalletPins.commit(); // the selection is this wallet's, not the app's
      if(tab==='agents')renderAgents();
    }

    // ---- AGENTS — detect EVERY iNFT the connected wallet holds ----
    let scan={loading:false,addr:'',agents:[],source:'',done:false};
    // The bridge tags each scanned token with `isAgent`. A bridge started before that
    // definition existed answers without it, and filtering on an absent field would hide
    // every holding — so when the tag is missing we FAIL OPEN and treat the scan as agents.
    const tagged=()=>typeof scan.inftCount==='number';
    const inftOf=()=>tagged()?(scan.agents||[]).filter(a=>a&&a.isAgent):(scan.agents||[]).slice();
    const agentKey=a=>String((a&&a.contract)||'').toLowerCase()+':'+String((a&&a.tokenId)??'');
    // What the CONNECTED wallet actually holds — or null when we cannot say yet. Null means
    // "filter nothing": an unanswered scan must never be read as "you own none of these".
    function heldSet(){
      const addr=WalletAuth.addr();
      if(!addr||!scan.done||scan.addr!==addr||scan.source==='error'||scan.source==='no-wallet')return null;
      return new Set(inftOf().map(agentKey));
    }
    // labInft is the ONE active-agent object every iNFT card reads (Cluster · Chat ·
    // agentview). A freshly scanned on-chain agent carries the real art (3D .glb / 2D
    // image); a locally-created or stale labInft does not. Reconcile merges the scanned
    // media onto the active agent so its art shows everywhere — one source of truth.
    function reconcileInft(){
      // Only agents may become the active agent. This used to reconcile against every
      // token in the wallet and fall back to list[0], so a stranger's empty contract
      // became the card the whole app showed — the wallet's first NFT impersonating the
      // owner's agent everywhere at once.
      const st0=Store.get(),list=inftOf();
      if(!list.length)return false;
      const sameTok=(a,b)=>String(a.tokenId)===String(b.tokenId)&&(!a.contract||!b.contract||String(a.contract).toLowerCase()===String(b.contract).toLowerCase());
      let cur=st0.labInft,match=null;
      if(cur&&cur.name){
        match=list.find(a=>sameTok(a,cur))||list.find(a=>String(a.tokenId)===String(cur.tokenId))||list.find(a=>a.name===cur.name);
      }else{
        const pinned=st0.pinnedAgents||[];
        match=list.find(a=>pinned.some(pnd=>sameTok(a,pnd)))||list.find(a=>String(a.tokenId)===String(st0.activeAgent))||list[0];
      }
      if(!match)return false;
      const merged=Object.assign({},cur||{},{
        name:match.name||(cur&&cur.name),collection:match.collection||(cur&&cur.collection),
        symbol:match.symbol||(cur&&cur.symbol),contract:match.contract||(cur&&cur.contract),
        tokenId:(match.tokenId!=null?match.tokenId:(cur&&cur.tokenId)),
        image:match.image||(cur&&cur.image)||'',animation:match.animation||(cur&&cur.animation)||'',
        mediaType:match.mediaType||(cur&&cur.mediaType)||'',
        attributes:(match.attributes&&match.attributes.length?match.attributes:(cur&&cur.attributes))||[],
        description:match.description||(cur&&cur.description)||'',owner:match.owner||(cur&&cur.owner)||''
      });
      const changed=!cur||cur.image!==merged.image||cur.animation!==merged.animation||cur.name!==merged.name;
      st0.labInft=merged;Store.save();
      return changed;
    }
    // after any scan: reconcile the active art, refresh whatever card is on screen, and
    // notify the (separate) agentview panel so "View everything" shows the same art.
    function afterScan(){
      const changed=reconcileInft();
      if(tab==='agents')renderAgents();
      else if(tab==='chat'&&!chat.streaming)renderChat(); // never rip the DOM out from under a live stream
      if(changed)Bus.emit('inft:changed');
    }
    async function scanAgents(force){
      const addr=WalletAuth.addr();
      if(!addr||!Bridge.on()){scan={loading:false,addr:'',agents:[],source:'no-wallet',done:true};if(tab==='agents')renderAgents();return}
      // A finished scan belongs to the address it was run for. Without that, connecting a
      // second wallet re-used the first one's result and this panel showed agents the
      // connected wallet does not hold — the same class of lie as the rest of this wave.
      if(scan.done&&!force&&scan.addr===addr){afterScan();return}
      scan.loading=true;if(tab==='agents')renderAgents();
      try{const r=await RPC('nft','scanWallet',addr,force?{fresh:true}:{});scan={loading:false,addr,agents:(r&&r.agents)||[],inftCount:r&&r.inftCount,source:(r&&r.source)||'',needsConfig:r&&r.needsConfig,done:true};Store.get().walletAgents=scan.agents;Store.save()}
      catch(e){scan={loading:false,addr,agents:[],source:'error',err:e.message,done:true}}
      afterScan();
    }
    // ---- full AGENT view (identity · attributes · soul) — INSIDE the Agents tab ----
    function renderAgentDetail(){
      const a=Store.get().labInft;
      const back='<div class="labagd-back"><button class="labagd-bk" id="agback">‹ Agents</button></div>';
      if(!a||!a.name){
        body.innerHTML=back+'<div class="qempty" style="padding:26px;text-align:center;line-height:1.8">No agent selected — pick one below.</div>';
        body.querySelector('#agback').addEventListener('click',()=>{agView='list';renderAgents()});
        return;
      }
      const shortAddr=x=>x?x.slice(0,6)+'…'+x.slice(-4):'';
      const attrs=a.attributes||[];
      const contract=a.contract||'';
      const wallet=a.agentWallet||a.tba||a.tokenBoundAccount||'';
      const owner=a.owner||WalletAuth.addr()||'';
      body.innerHTML=back+`<div class="labagd">
        <div class="ag-hero">
          <div class="ag-art">${artHTML(a)}</div>
          <div class="ag-name">${escHtml(a.name)}</div>
          <div class="ag-metarow">${a.collection?`<span class="ag-coll">${escHtml(a.collection)}</span>`:''}<span class="ag-chain">Base 8453</span></div>
        </div>
        <div class="ag-sec">
          <div class="ag-sech"><b>IDENTITY</b><span class="ag-legend">— the on-chain facts about this agent</span></div>
          <div class="ag-row"><span class="k">Token ID</span><span class="v">${escHtml(a.tokenId??'—')}</span></div>
          <div class="ag-row"><span class="k">Contract</span><span class="v">${contract?escHtml(shortAddr(contract)):'—'}${contract?'<button class="ag-copybtn" data-copy>COPY</button>':''}</span></div>
          <div class="ag-row"><span class="k">Owner</span><span class="v">${owner?escHtml(WalletAuth.short(owner)):'—'}</span></div>
          <div class="ag-row"><span class="k">Standard</span><span class="v">ERC-721 · 2981 · 6551</span></div>
          <div class="ag-row"><span class="k">Agent Wallet (ERC-6551)</span><span class="v">${wallet?escHtml(shortAddr(wallet)):'—'}${!wallet?'<span class="note">derived, not deployed yet</span>':''}</span></div>
        </div>
        <div class="ag-sec">
          <div class="ag-sech"><b>ATTRIBUTES</b><span class="ag-legend">— traits carried on-chain</span></div>
          ${attrs.length?`<div class="ag-attrs">${attrs.map(x=>`<div class="ag-chip"><span class="t">${escHtml(x.trait_type||'')}</span><span class="v">${escHtml(x.value??'')}</span></div>`).join('')}</div>`:'<div class="ag-empty">no attributes on this token</div>'}
        </div>
        <div class="ag-sec">
          <div class="ag-sech"><b>NEURAL SOUL</b><span class="ag-legend">— the mutable mind of your agent: identity, faculties, limits</span><button class="btn mini" id="agsouledit">Edit soul</button></div>
          <div id="ag-soul"></div>
        </div>
        <div class="ag-actions">
          <button class="btn primary" id="agchat"><svg><use href="#i-agent"/></svg>Chat with agent</button>
          <button class="btn" id="agterm"><svg><use href="#i-term"/></svg>Open in Terminal</button>
        </div></div>`;
      body.querySelector('#agback').addEventListener('click',()=>{agView='list';renderAgents()});
      const cpy=body.querySelector('[data-copy]');
      if(cpy)cpy.addEventListener('click',async()=>{
        try{await navigator.clipboard.writeText(contract);cpy.textContent='COPIED';Toast.show('Contract copied');setTimeout(()=>{if(cpy)cpy.textContent='COPY'},1400)}
        catch(_){Toast.show('Copy blocked — select manually')}
      });
      body.querySelector('#agsouledit').addEventListener('click',()=>Toast.show('Soul editing — coming soon'));
      body.querySelector('#agchat').addEventListener('click',()=>{Store.get().activeAgent=a.tokenId;Store.save();tab='chat';setTab();Toast.show('Working with '+a.name+' — chat below its card')});
      body.querySelector('#agterm').addEventListener('click',()=>openPanel('terminal'));
      try{body.querySelector('#ag-soul').innerHTML=renderSoul(defaultSoul(a))}catch(_){}
    }
    function renderAgents(){
      if(agView==='detail')return renderAgentDetail();
      const addr=WalletAuth.addr();
      if(!addr){
        body.innerHTML=`<div class="qempty" style="padding:30px 22px;text-align:center;line-height:1.8"><div style="font-family:var(--mono);font-size:15px;color:var(--fg)">YOUR AGENTS</div><div style="margin-top:7px">Connect your wallet — the LAB detects every iNFT it holds and lets you work with each one.</div><br><button class="btn" id="agconnect">CONNECT WALLET</button></div>`;
        body.querySelector('#agconnect').addEventListener('click',()=>PrivyLogin.open());return;
      }
      if(scan.loading){body.innerHTML='<div class="qempty" style="padding:22px">scanning '+escHtml(WalletAuth.short(addr))+' on-chain…</div>';return}
      const pinned=Store.get().pinnedAgents||[];
      const isPinned=a=>pinned.some(x=>x.contract===a.contract&&String(x.tokenId)===String(a.tokenId));
      // A wallet holds more than agents, and this panel shows ONLY the agents. The rest —
      // airdrops, PFPs, empty test contracts — is not listed anywhere: the owner's call,
      // and the right one. A wallet with no iNFT shows nothing rather than a consolation
      // grid of tokens that are not what this room is for.
      const inft=inftOf();
      let html='<div class="labaghead"><div><b>YOUR AGENTS</b> <span class="dim">'+inft.length+' iNFT'+(inft.length===1?'':'s')+' · ✓ to use in the terminal</span></div><button class="btn mini" id="agrescan">↻ Rescan</button></div>';
      if(!inft.length){
        html+='<div class="qempty" style="padding:20px;line-height:1.7">No iNFTs found in this wallet'+(scan.needsConfig?' — add your collection address below to scan it directly.':'.')+'</div>';
      }else{
        html+='<div class="labaggrid">'+inft.map((a,i)=>`
          <div class="labag ${isPinned(a)?'on':''}" data-i="${i}">
            <div class="labagcb ${isPinned(a)?'on':''}" title="Use in the terminal">${isPinned(a)?'✓':''}</div>
            <div class="labagart">${artHTML(a)}</div>
            <div class="labagn">${escHtml(a.name)}</div>
            <div class="labagc">${escHtml(a.collection||a.symbol||'')}</div>
          </div>`).join('')+'</div>';
      }
      html+='<div class="labagadd"><input id="agcol" placeholder="Add a collection address (0x…) to scan"><button class="btn mini" id="agcoladd">ADD</button></div>';
      body.innerHTML=html;
      body.querySelectorAll('.labag').forEach(el=>el.addEventListener('click',()=>pickAgent(inft[+el.dataset.i])));
      body.querySelector('#agpinhint')&&0;
      body.querySelector('#agrescan').addEventListener('click',()=>scanAgents(true));
      body.querySelector('#agcoladd').addEventListener('click',async()=>{const v=body.querySelector('#agcol').value.trim();if(!v)return;const r=await RPC('nft','addCollection',v);if(r&&r.ok){Toast.show('Collection added — rescanning');scanAgents(true)}else Toast.show((r&&r.error)||'invalid address')});
    }
    async function refreshInft(){ if(WalletAuth.addr()&&Bridge.on())scanAgents(false); }



    // ---- CHAT (any model: API provider · machine) ----
    async function modelOptions(){
      const opts=[];
      if(Bridge.on()){try{const provs=await RPC('models','listProviders');provs.forEach(pr=>{if(pr.enabled===false)return;(pr.models||[]).forEach(m=>{if((pr.disabledModels||[]).includes(m))return;opts.push({v:pr.id+'::'+m,label:(pr.label||pr.provider)+' · '+m})})})}catch(_){}}
      if(Bridge.brainReady()){const inf=Bridge.info&&Bridge.info();opts.push({v:'machine',label:'machine · '+((inf&&inf.model)||'model')})}
      // The Brain route is ALWAYS present: it cascades bridge → BYOK key → local mock,
      // so the chat can never be silently dead again.
      opts.push({v:'brain',label:Brain.label()});
      const saved=(()=>{try{return localStorage.getItem('cfhub.lab.chatmodel')||''}catch(_){return''}})();
      if(!chat.model&&saved)chat.model=saved;
      if(!chat.model||!opts.some(o=>o.v===chat.model))chat.model=opts[0].v;
      return opts;
    }
    // Live-refresh the chat model picker when the registry changes (e.g. MATRIX cluster sync) —
    // rewrites only the <select> options so typing and the open conversation are untouched.
    Bus.on('models:changed',async()=>{
      if(!document.body.contains(p))return;
      const sel=body.querySelector('#labcmodel');if(!sel)return;
      const opts=await modelOptions();
      sel.innerHTML=opts.map(o=>`<option value="${escAttr(o.v)}" ${o.v===chat.model?'selected':''}>${escAttr(o.label)}</option>`).join('');
    });
    // ---- the agent DECK — every agent selected in Agents, as one draggable stack ----
    // The front card is the live one (full animated art + LIVE); neighbours peek from the
    // sides as dimmed stills. Drag the info strip (or a side card) horizontally — or use
    // the dots / a trackpad swipe — to bring the next agent forward. The 3D art is NOT a
    // drag handle: pointer there belongs to model-viewer (rotate the model).
    function deckList(){
      const st0=Store.get();
      const list=(Array.isArray(st0.pinnedAgents)?st0.pinnedAgents:[]).slice();
      const cur=st0.labInft;
      if(cur&&cur.name&&!list.some(x=>sameAgent(x,cur)))list.unshift(cur);
      const out=list.filter(a=>a&&a.name);
      // Second guard, after the per-wallet pins: a pin can also go stale inside its own
      // wallet (the token was sold or moved). The deck is what you can work with, so it
      // shows only what THIS wallet's scan actually found — and filters nothing at all
      // until that scan has answered, so a slow bridge never empties the chat.
      const held=heldSet();
      return held?out.filter(a=>held.has(agentKey(a))):out;
    }
    function deckFrontIndex(list){
      const cur=Store.get().labInft;
      const i=list.findIndex(x=>sameAgent(x,cur));
      return i>=0?i:0;
    }
    function applyDeck(fr){ // fr = fractional slot offset while dragging (0 when settled)
      if(!deck.el)return;
      const cards=[...deck.el.querySelectorAll('.labinft')];
      if(!cards.length)return;
      const W=cards[0].offsetWidth||320;
      cards.forEach((el,i)=>{
        const off=i-deck.i+(fr||0),ax=Math.abs(off);
        el.style.transform=`translateX(calc(-50% + ${Math.round(off*W*0.56)}px)) scale(${Math.max(.78,1-.11*Math.min(ax,2)).toFixed(3)})`;
        // ghosts stay SOLID (they must occlude the message stream behind them) — the
        // "shadow" read comes from brightness/saturation, not deep transparency
        el.style.opacity=ax<.5?'1':String(Math.max(.55,.96-.18*ax).toFixed(2));
        el.style.zIndex=String(60-Math.round(ax*10));
      });
      const dots=deck.el.querySelectorAll('.labdots i');
      dots.forEach((d,i)=>d.classList.toggle('on',i===deck.i));
    }
    function setFront(i,opts2){
      const list=deck.list;
      i=Math.max(0,Math.min(list.length-1,i));
      const changed=i!==deck.i||(opts2&&opts2.force);
      deck.i=i;
      const a=list[i];
      if(a){
        const st0=Store.get();
        if(!sameAgent(st0.labInft,a)){st0.labInft=Object.assign({},a);st0.activeAgent=a.tokenId;Store.save();Bus.emit('inft:changed')}
        else if(!st0.activeAgent){st0.activeAgent=a.tokenId;Store.save()}
      }
      if(changed&&deck.el){
        // one live art at a time: the new front gets the full animated media, the rest go still
        [...deck.el.querySelectorAll('.labinft')].forEach((el,k)=>{
          const isF=k===deck.i,ag=list[k];
          el.classList.toggle('front',isF);
          el.classList.toggle('ghost',!isF);
          const art=el.querySelector('.art');
          const want=isF?'full':'still';
          if(art&&art.dataset.mode!==want){art.dataset.mode=want;art.innerHTML=(isF?artHTML(ag):stillArt(ag))+(isF?'<span class="live"><i></i>LIVE</span>':'')}
        });
      }
      applyDeck(0);
    }
    // card opacity: read from storage, apply to the deck container, toggle the control
    const DECK_OP_KEY='cfhub.lab.deckopacity';
    function deckOpacity(){const v=parseInt(localStorage.getItem(DECK_OP_KEY)||'100',10);return isNaN(v)?100:Math.max(20,Math.min(100,v))}
    function applyDeckOpacity(){
      const chatEl=deck.el&&deck.el.closest('.labchat');if(chatEl)chatEl.style.setProperty('--deck-op',(deckOpacity()/100).toFixed(2));
    }
    function renderDeck(){
      if(!deck.el)return;
      deck.list=deckList();
      const list=deck.list;
      const opc=deck.el.parentElement&&deck.el.parentElement.querySelector('#labopac');
      if(!list.length){deck.el.style.display='none';if(opc)opc.classList.remove('show');syncPad();return}
      deck.el.style.display='';
      if(opc)opc.classList.add('show');
      applyDeckOpacity();
      deck.i=deckFrontIndex(list);
      deck.el.innerHTML=list.map((a,i)=>{
        const isF=i===deck.i;
        return `<div class="labinft ${isF?'front live':'ghost'}" data-di="${i}">
          <div class="art" data-mode="${isF?'full':'still'}">${isF?artHTML(a):stillArt(a)}${isF?'<span class="live"><i></i>LIVE</span>':''}</div>
          <div class="im">
            <div class="hd"><b>${escHtml(a.name)}</b>${a.collection?`<span class="col">· ${escHtml(a.collection)}</span>`:''}</div>
            <div class="at">${(a.attributes||[]).slice(0,3).map(x=>`<span>${escHtml(x.value||x.trait_type||'')}</span>`).join('')}</div>
            <div class="ft" data-agdetail title="View everything about this agent"><div class="d">${escHtml(a.description||'Your agent iNFT — its art animates while you work with it.')}</div><div class="go">View everything <i>→</i></div></div>
          </div></div>`;
      }).join('')+(list.length>1?`<div class="labdots">${list.map((_,i)=>`<i data-dot="${i}" class="${i===deck.i?'on':''}"></i>`).join('')}</div>`:'');
      applyDeck(0);
      requestAnimationFrame(syncPad);setTimeout(syncPad,90); // rAF can be throttled in background tabs
      // the panel is user-resizable — keep the deck geometry and the message padding true
      try{if(deck.ro)deck.ro.disconnect();deck.ro=new ResizeObserver(()=>{clearTimeout(deck.rt);deck.rt=setTimeout(()=>{applyDeck(0);syncPad()},80)});deck.ro.observe(deck.el.parentElement)}catch(_){}
      // Taps are decided INSIDE the pointer engine (endDrag), never via 'click':
      // setPointerCapture retargets the synthesized click to the container, so a
      // per-node click listener on the footer can never fire in current Chromium.
      deck.el.querySelectorAll('[data-dot]').forEach(d=>d.addEventListener('click',()=>setFront(+d.dataset.dot)));
      // drag: anywhere on a card EXCEPT the front card's art (that drag rotates the 3D)
      let dg=null;
      deck.el.addEventListener('pointerdown',e=>{
        const card=e.target.closest('.labinft');if(!card)return;
        if(card.classList.contains('front')&&e.target.closest('.art'))return;
        // record the REAL hit-test target now — capture would destroy it later
        dg={x0:e.clientX,W:(card.offsetWidth||320)*0.56,moved:false,card,ft:!!e.target.closest('[data-agdetail]'),pid:e.pointerId};
      });
      deck.el.addEventListener('pointermove',e=>{
        if(!dg)return;
        const dx=e.clientX-dg.x0;
        if(!dg.moved&&Math.abs(dx)>5){
          // capture only when the drag becomes REAL — genuine taps keep native targets
          dg.moved=true;deck.el.classList.add('dragging');
          try{deck.el.setPointerCapture(dg.pid)}catch(_){}
        }
        if(!dg.moved)return;
        let fr=-dx/dg.W;
        fr=Math.max(-(deck.i+0.35),Math.min(deck.list.length-1-deck.i+0.35,fr)); // soft edges
        dg.fr=fr;applyDeck(fr);
      });
      const endDrag=e=>{
        if(!dg)return;
        deck.el.classList.remove('dragging');
        const fr=dg.fr||0,card=dg.card,moved=dg.moved,wasFt=dg.ft;dg=null;
        if(!moved){
          const di=+card.dataset.di;
          if(di!==deck.i)setFront(di);                    // a side card's tap brings it forward
          else if(wasFt)openPanel('agentview');           // front footer → the standalone AGENT panel
          else applyDeck(0);
          return;
        }
        setFront(Math.round(deck.i+fr));
      };
      deck.el.addEventListener('pointerup',endDrag);
      deck.el.addEventListener('pointercancel',endDrag);
      // trackpad horizontal swipe
      let wAcc=0,wT=null;
      deck.el.addEventListener('wheel',e=>{
        if(Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;
        e.preventDefault();wAcc+=e.deltaX;
        clearTimeout(wT);wT=setTimeout(()=>{wAcc=0},180);
        if(wAcc>70){wAcc=0;setFront(deck.i+1)}else if(wAcc<-70){wAcc=0;setFront(deck.i-1)}
      },{passive:false});
    }
    function syncPad(){ // messages start below the deck, then scroll BENEATH it
      if(!deck.ct)return;
      const ctH=deck.ct.clientHeight||0;
      // The conversation must ALWAYS keep ≥140px of readable stream below the card:
      // on small panels the deck shrinks (square art ⇒ height tracks width); on big
      // panels it grows back to the full 320px card.
      if(deck.el&&ctH){const w=Math.max(178,Math.min(320,ctH-304));deck.el.style.setProperty('--deckw',w+'px')}
      const front=deck.el&&deck.el.querySelector('.labinft.front');
      const h=(deck.el&&deck.el.style.display!=='none'&&front)?front.offsetHeight:0;
      const maxPad=Math.max(120,ctH-140);
      deck.ct.style.paddingTop=Math.min(h?h+34:12,maxPad)+'px';
    }
    function openAgentDetail(){tab='agents';agView='detail';setTab()}
    function msgHTML(m){return `<div class="labcm ${m.role}">${m.role==='user'?escHtml(m.content):MDLite.render(m.content||'…')}</div>`}
    async function renderChat(){
      const opts=await modelOptions();
      const draft=(()=>{const i=body.querySelector('#labcin');return i?i.value:''})(); // never destroy what the user was typing
      body.innerHTML=`<div class="labchat">
        <div class="labct" id="labct"></div>
        <div class="labopac" id="labopac" title="Card opacity — see the chat underneath"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2 A6 6 0 0 1 8 14 Z" fill="currentColor"/></svg><input type="range" id="labopacr" min="20" max="100" step="5"></div>
        <div class="labdeck" id="labdeck"></div>
        <div class="labcbar">
          <select id="labcmodel">${opts.map(o=>`<option value="${escAttr(o.v)}" ${o.v===chat.model?'selected':''}>${escAttr(o.label)}</option>`).join('')}</select>
          <textarea id="labcin" rows="1" placeholder="Message the model…"></textarea>
          <button class="btn" id="labcsend">${chat.streaming?'STOP':'SEND'}</button>
        </div></div>`;
      deck.el=body.querySelector('#labdeck');deck.ct=body.querySelector('#labct');
      renderDeck();
      const ct=deck.ct;
      ct.innerHTML=chat.msgs.length?chat.msgs.map(msgHTML).join(''):'<div class="qempty labhint" style="padding:24px;text-align:center;line-height:1.7">Chat with any model — an API provider or your machine.<br>Pick the model below and start.</div>';
      if(_lastLabChat!==(chat&&chat.id)){_lastLabChat=chat&&chat.id;forceBottom(ct)}else stickBottom(ct);
      body.querySelector('#labcmodel').addEventListener('change',e=>{chat.model=e.target.value;try{localStorage.setItem('cfhub.lab.chatmodel',chat.model)}catch(_){}});
      const opr=body.querySelector('#labopacr');
      if(opr){opr.value=String(deckOpacity());opr.addEventListener('input',()=>{try{localStorage.setItem(DECK_OP_KEY,opr.value)}catch(_){}applyDeckOpacity()})}
      const inp=body.querySelector('#labcin');
      if(draft)inp.value=draft;
      inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();labSend(inp.value)}});
      body.querySelector('#labcsend').addEventListener('click',()=>chat.streaming?(chat.ctl&&chat.ctl.abort()):labSend(inp.value));
      inp.focus();
    }
    // send = append DOM nodes, never a full re-render: the deck (and its live 3D art)
    // must not reload on every message
    async function labSend(text){
      text=(text||'').trim();if(!text||chat.streaming)return;
      const ct=deck.ct||body.querySelector('#labct');if(!ct)return;
      const inp=body.querySelector('#labcin');if(inp)inp.value='';
      const hint=ct.querySelector('.labhint');if(hint)hint.remove();
      chat.msgs.push({role:'user',content:text});
      const bot={role:'ai',content:''};chat.msgs.push(bot);
      ct.insertAdjacentHTML('beforeend',msgHTML({role:'user',content:text}));
      ct.insertAdjacentHTML('beforeend',msgHTML(bot));
      const botEl=ct.lastElementChild;
      ct.scrollTop=ct.scrollHeight;
      const sendBtn=body.querySelector('#labcsend');if(sendBtn)sendBtn.textContent='STOP';
      chat.streaming=true;chat.ctl=new AbortController();
      // Survive a mid-stream re-render (scan/wallet events rebuild the chat DOM): if the
      // streaming bubble got detached, re-acquire it — chat.msgs is the source of truth.
      let ctEl=ct,botRef=botEl;
      const onTok=t=>{bot.content+=t;
        if(!botRef||!botRef.isConnected){ctEl=deck.ct||body.querySelector('#labct')||ctEl;botRef=ctEl?ctEl.lastElementChild:null}
        if(botRef)botRef.innerHTML=MDLite.render(bot.content);
        if(ctEl)stickBottom(ctEl)};
      const hist=chat.msgs.filter(m=>m!==bot).map(m=>({role:m.role==='ai'?'assistant':'user',content:m.content}));
      const sys='You are running inside the CLONE FRAME LAB. Answer helpfully and directly.';
      try{
        const mv=chat.model||'';
        // streamRaw reports failures as an ERR MARKER in its return value, not a throw —
        // swallowing it was exactly the "type and nothing happens" bug.
        if(mv.includes('::')){const k=mv.indexOf('::');const r=await Bridge.providerChat(mv.slice(0,k),mv.slice(k+2),hist,onTok,chat.ctl.signal,{system:sys});if(r&&r.err)throw new Error(r.err)}
        else if(mv==='machine'&&Bridge.brainReady()){const r=await Bridge.chat(hist,onTok,chat.ctl.signal,{system:sys});if(r&&r.err)throw new Error(r.err)}
        else{await Brain.stream([{role:'system',content:sys}].concat(hist),onTok,chat.ctl.signal)} // bridge → BYOK → mock: never dead
      }catch(e){if(e.name!=='AbortError'&&!/abort/i.test(e.message||'')){const fe=friendlyErr(e.message||'request failed');bot.content+=(bot.content?'\n':'')+'⚠ '+fe;Toast.show('Chat error — '+fe)}}
      chat.streaming=false;chat.ctl=null;
      if(botRef&&botRef.isConnected)botRef.innerHTML=MDLite.render(bot.content||'…');
      else{const c2=deck.ct||body.querySelector('#labct');if(c2&&c2.lastElementChild)c2.lastElementChild.innerHTML=MDLite.render(bot.content||'…')}
      if(sendBtn)sendBtn.textContent='SEND';
      if(inp)inp.focus();
    }




    function render(){if(tab==='agents')renderAgents();else renderChat()}
    function setTab(){if(tab!=='chat'&&tab!=='agents')tab='chat';p.querySelectorAll('.labtab').forEach(t=>t.classList.toggle('on',t.dataset.lt===tab));if(tab==='agents'&&!scan.done)scanAgents(false);else render()}
    p.querySelectorAll('.labtab').forEach(t=>t.addEventListener('click',()=>{tab=t.dataset.lt;if(tab==='agents')agView='list';setTab()}));
    async function renderOnlineServer(){
      body.innerHTML='<div class="qempty" style="padding:16px">loading servers…</div>';
      let sv=[],autos=[];
      try{const r=await RPC('servers','list');sv=(r&&r.ok)?r.servers:[]}catch(e){}
      try{const r=await RPC('servers','automations');autos=(r&&r.ok)?r.items:[]}catch(e){}
      const openServers=()=>{openPanel('settings');setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="servers"]');if(b)b.click()},80)};
      if(!sv.length){
        body.innerHTML='<div class="os-empty"><svg><use href="#i-cosmos"/></svg><h3>Bring your agent online</h3><p>Connect a DigitalOcean droplet (or any SSH server) and run your agent 24/7 — deploy it, start it, and trigger automations with one click.</p><button class="btn acc" id="osadd">Connect a server</button><p class="dim">Or just tell CODE: “provision a droplet and deploy my agent”.</p></div>';
        body.querySelector('#osadd').addEventListener('click',openServers);return;
      }
      if(!osSel||!sv.find(s=>s.id===osSel))osSel=sv[0].id;
      body.innerHTML=`<div class="os">
        <div class="os-head"><select id="ossel">${sv.map(x=>`<option value="${escAttr(x.id)}" ${x.id===osSel?'selected':''}>${escAttr(x.name)} · ${escAttr(x.host||x.provider||'')}</option>`).join('')}</select><button class="btn mini" id="ostest">Test</button><button class="btn mini" id="osmanage">Manage</button></div>
        <div class="os-status" id="osstatus">Not checked yet — hit “Test”.</div>
        <div class="os-sec">ONE-CLICK AUTOMATIONS</div>
        <div class="os-autos">${autos.map(a=>`<button class="os-auto ${a.danger?'danger':''}" data-auto="${escAttr(a.key)}"><b>${escAttr(a.label)}</b><span>${escAttr(a.desc)}</span></button>`).join('')||'<div class="qempty" style="padding:10px">no automations</div>'}</div>
        <div class="os-sec">DEPLOY</div>
        <div class="os-deploy"><button class="btn acc" id="osdeploy">▲ Send my agent to this server</button><button class="btn" id="osprov">＋ Provision a new droplet</button></div>
        <div class="os-sec">CONSOLE</div>
        <pre class="os-console" id="osconsole">$ _</pre>
        <div class="os-cmd"><input id="oscmd" placeholder="Run a command on the server…" spellcheck="false"><button class="btn" id="osrun">Run</button></div>
      </div>`;
      const out=t=>{const c=body.querySelector('#osconsole');if(!c)return;c.textContent=String(t||'').slice(-6000);c.scrollTop=c.scrollHeight};
      body.querySelector('#ossel').addEventListener('change',e=>{osSel=e.target.value;renderOnlineServer()});
      body.querySelector('#osmanage').addEventListener('click',openServers);
      body.querySelector('#ostest').addEventListener('click',async()=>{const stEl=body.querySelector('#osstatus');stEl.textContent='testing…';const t=await RPC('servers','test',osSel);stEl.textContent=t&&t.reachable?'● online · reachable':('○ not reachable '+((t&&t.detail)||''));stEl.style.color=t&&t.reachable?'var(--ok)':'var(--accent)'});
      body.querySelectorAll('[data-auto]').forEach(b=>b.addEventListener('click',async()=>{out('running '+b.dataset.auto+'…');const r=await RPC('servers','runAutomation',osSel,b.dataset.auto);out(r&&r.ok?(r.output||'(done)'):('failed: '+((r&&r.error)||'')))}));
      body.querySelector('#osdeploy').addEventListener('click',async()=>{out('deploying agent…');const r=await RPC('servers','deployAgent',osSel,{name:'agent'});out(r&&r.ok?('deployed:\n'+(r.steps?JSON.stringify(r.steps,null,1):'ok')):('failed: '+((r&&r.error)||'')))});
      body.querySelector('#osprov').addEventListener('click',async()=>{out('requesting a new droplet…');const r=await RPC('servers','provision',{name:'clone-droplet'});out(r&&r.ok?('droplet requested: '+(r.note||'booting')):('failed: '+((r&&r.error)||'')+'\nAdd a DigitalOcean token on this server in Settings → Servers.'))});
      const runCmd=async()=>{const i=body.querySelector('#oscmd'),cmd=(i.value||'').trim();if(!cmd)return;i.value='';out('$ '+cmd+'\n…');const r=await RPC('servers','run',osSel,cmd);out('$ '+cmd+'\n'+(r&&r.ok?(r.output||'(no output)'):('failed: '+((r&&r.error)||''))))};
      body.querySelector('#osrun').addEventListener('click',runCmd);
      body.querySelector('#oscmd').addEventListener('keydown',e=>{if(e.key==='Enter')runCmd()});
    }

    panelBus(p).on('wallet',()=>{refreshInft()});
    // deep-links: 'agentdetail' (old AGENT panel callers land on Agents → detail) or a tab name
    panelBus(p).on('lab:goto',t=>{if(!t)return;if(t==='agentdetail'){tab='agents';agView='detail'}else{tab=t;if(t==='agents')agView='list'}setTab()});
    setTab();refreshInft();
  }
  /* ---------- Shared file viewer / editor (used by FOLDERS + TERMINAL) ---------- */
  // Renders a file into `host` with View (syntax-highlighted / markdown) · Diff (git) · Edit (save) modes.
  async function openFileView(host, filePath, opts){
    opts=opts||{};
    const fesc=t=>String(t).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const name=String(filePath).split('/').pop()||filePath;
    const ext=((name.match(/\.([A-Za-z0-9]+)$/)||[])[1]||'').toLowerCase();
    const langMap={js:'js',mjs:'js',cjs:'js',jsx:'js',ts:'js',tsx:'js',json:'json',py:'python',css:'css',scss:'css',less:'css',html:'html',htm:'html',xml:'html',svg:'html',sh:'bash',bash:'bash',zsh:'bash',sol:'solidity'};
    const isMd=(ext==='md'||ext==='markdown'||ext==='mdown'),lang=langMap[ext]||'';
    let mode='view',text='',orig='',changed=false;
    const head=extra=>`<div class="fv-head">${opts.onBack?'<button class="fv-back" id="fvback" title="Back">‹</button>':''}<span class="fv-name">${fesc(name)}</span>${extra||''}${(opts.onClose&&!opts.onBack)?'<button class="fv-back" id="fvclose" title="Close">✕</button>':''}</div>`;
    function bindHead(){const b=host.querySelector('#fvback');if(b&&opts.onBack)b.addEventListener('click',opts.onBack);const c=host.querySelector('#fvclose');if(c&&opts.onClose)c.addEventListener('click',opts.onClose)}
    host.innerHTML=`<div class="fv">${head('')}<div class="fv-note">Loading ${fesc(name)}…</div></div>`;bindHead();
    // 64MB ceiling (owner's order: a size limit only ever got in the way of reading and
    // editing big source files). Above HEAVY_BYTES syntax highlighting is skipped — it is
    // O(n) and would freeze the DOM; the file still opens, reads and saves fine.
    const HEAVY_BYTES=260*1024;
    const r=await RPC('files','read',filePath,{maxKB:65536}).catch(e=>({ok:false,error:String(e&&e.message||e)}));
    if(!r||!r.ok){host.querySelector('.fv').innerHTML=head('')+`<div class="fv-note">${fesc((r&&r.error)||'could not open this file')}${/large|too/i.test((r&&r.error)||'')?'':' — it may be a binary file. Reveal it in Finder or open it in the terminal instead.'}</div>`;bindHead();return}
    text=orig=r.text;
    if(opts.cwd&&Bridge.on()){try{let o='';await Bridge.shell('git -C "'+String(opts.cwd).replace(/"/g,'')+'" status --porcelain -- "'+String(filePath).replace(/"/g,'')+'" 2>/dev/null',t=>{o+=t});changed=!!o.trim()}catch(_){}}
    function seg(){return `<div class="fv-seg"><button data-m="view" class="${mode==='view'?'on':''}">View</button>${changed?`<button data-m="diff" class="${mode==='diff'?'on':''}">Diff</button>`:''}<button data-m="edit" class="${mode==='edit'?'on':''}">Edit</button></div>${mode==='edit'?`<span class="fv-dirty" id="fvd" style="${text!==orig?'':'visibility:hidden'}">● unsaved</span><button class="fv-save" id="fvsave" ${text===orig?'disabled':''}>Save</button>`:''}`}
    async function bodyHTML(){
      if(mode==='edit')return `<textarea class="fv-edit" id="fvta" spellcheck="false"></textarea>`;
      if(mode==='diff'){let patch='';try{await Bridge.shell('git -C "'+String(opts.cwd).replace(/"/g,'')+'" diff -- "'+String(filePath).replace(/"/g,'')+'"',t=>{patch+=t})}catch(_){}
        if(!patch.trim())return `<div class="fv-note">No tracked changes for this file.</div>`;
        return '<div class="fv-code">'+patch.split('\n').map(l=>{const c=(l[0]==='+'&&!l.startsWith('+++'))?'add':((l[0]==='-'&&!l.startsWith('---'))?'del':(l.startsWith('@@')?'hunk':''));return `<div class="cl ${c}"><span class="ln"></span><span class="cd">${fesc(l)}</span></div>`}).join('')+'</div>';}
      const heavy=text.length>HEAVY_BYTES;
      if(isMd&&!heavy)return `<div class="fv-md">${MDLite.render(text)}</div>`;
      // large files → plain escaped text, no highlighter (keeps the viewer responsive)
      const code=heavy?fesc(text):MDLite.highlight(text,lang);
      return `<div class="fv-code">${heavy?`<div class="fv-note" style="padding:6px 12px">Large file (${Math.round(text.length/1024)}KB) — shown as plain text. Edit works; syntax colors are off to stay fast.</div>`:''}<pre style="margin:0;white-space:pre-wrap;word-break:break-word;padding:2px 12px"><code>${code}</code></pre></div>`;
    }
    async function render(){
      const fv=host.querySelector('.fv');fv.innerHTML=head(seg())+`<div class="fv-body" id="fvbody"></div>`;bindHead();
      fv.querySelectorAll('.fv-seg button').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.m;render()}));
      fv.querySelector('#fvbody').innerHTML=await bodyHTML();
      if(mode==='edit'){const ta=fv.querySelector('#fvta');ta.value=text;
        ta.addEventListener('input',()=>{text=ta.value;const d=fv.querySelector('#fvd'),s=fv.querySelector('#fvsave');if(d)d.style.visibility=(text!==orig)?'':'hidden';if(s)s.disabled=(text===orig)});
        const sv=fv.querySelector('#fvsave');if(sv)sv.addEventListener('click',async()=>{sv.disabled=true;sv.textContent='Saving…';const w=await RPC('files','write',filePath,text).catch(e=>({ok:false,error:e.message}));if(w&&w.ok){orig=text;sv.textContent='Saved ✓';Toast.show('Saved '+name);if(opts.onSave)opts.onSave();setTimeout(()=>{if(sv.isConnected)sv.textContent='Save'},1200)}else{sv.textContent='Save';sv.disabled=false;Toast.show('Save failed: '+((w&&w.error)||''))}});
        setTimeout(()=>ta.focus(),20);}
    }
    render();
  }
