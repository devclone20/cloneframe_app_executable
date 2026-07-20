  function wireAgentView(p){
    const body=p.querySelector('#agvbody');if(!body)return;
    function artHTML(a){
      if(!a)return'<div class="ph">iNFT</div>';
      const anim=a.animation||'';
      // Scheme guard (T-071): only http(s)/ipfs media reaches a frame src — a javascript:/data:/blob:
      // anim (which, having no file extension, would land in the sandboxed iframe and EXECUTE) is
      // rejected to '' and degrades to the still image. escAttr stops attribute breakout, not schemes.
      const v=safeMediaUrl(anim);
      if(v){
        if(a.mediaType==='video'||/\.(mp4|webm|mov|m4v)(\?|$)/i.test(anim))return `<video src="${escAttr(v)}" autoplay loop muted playsinline></video>`;
        if(a.mediaType==='glb'||/\.(glb|gltf)(\?|$)/i.test(anim)){ensureModelViewer();const p=safeImageUrl(a.image);const poster=p?` poster="${escAttr(p)}"`:'';return `<model-viewer src="${escAttr(v)}"${poster} camera-controls auto-rotate autoplay shadow-intensity="1" interaction-prompt="none"></model-viewer>`}
        if(!/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))return `<iframe src="${escAttr(v)}" sandbox="allow-scripts" loading="lazy"></iframe>`;
      }
      const src=safeImageUrl((anim&&/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))?anim:(a.image||''));
      return src?`<img src="${escAttr(src)}" alt="" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=&quot;ph&quot;>iNFT</div>')">`:'<div class="ph">iNFT</div>';
    }
    function render(){
      const a=Store.get().labInft;
      if(!a||!a.name){
        body.innerHTML='<div class="qempty" style="padding:26px;text-align:center;line-height:1.8">No agent selected — pick one in <b>LAB → Agents</b> and come back.</div>';
        return;
      }
      const shortAddr=x=>x?x.slice(0,6)+'…'+x.slice(-4):'';
      const attrs=a.attributes||[];
      const contract=a.contract||'';
      const wallet=a.agentWallet||a.tba||a.tokenBoundAccount||'';
      const owner=a.owner||WalletAuth.addr()||'';
      body.innerHTML=`<div class="labagd">
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
          <div class="ag-sech"><b>NEURAL SOUL</b><span class="ag-legend">— the mutable mind of your agent: identity, faculties, limits</span><button class="btn mini" id="agvsouledit">Edit soul</button></div>
          <div id="agv-soul"></div>
        </div>
        <div class="ag-actions">
          <button class="btn primary" id="agvchat"><svg><use href="#i-agent"/></svg>Chat with agent</button>
          <button class="btn" id="agvterm"><svg><use href="#i-term"/></svg>Open in Terminal</button>
        </div></div>`;
      const cpy=body.querySelector('[data-copy]');
      if(cpy)cpy.addEventListener('click',async()=>{
        try{await navigator.clipboard.writeText(contract);cpy.textContent='COPIED';Toast.show('Contract copied');setTimeout(()=>{if(cpy)cpy.textContent='COPY'},1400)}
        catch(_){Toast.show('Copy blocked — select manually')}
      });
      body.querySelector('#agvsouledit').addEventListener('click',()=>Toast.show('Soul editing — coming soon'));
      body.querySelector('#agvchat').addEventListener('click',()=>{Store.get().activeAgent=a.tokenId;Store.save();openPanel('lab');Bus.emit('lab:goto','chat')});
      body.querySelector('#agvterm').addEventListener('click',()=>openPanel('terminal'));
      try{body.querySelector('#agv-soul').innerHTML=renderSoul(defaultSoul(a))}catch(_){}
    }
    panelBus(p).on('inft:changed',()=>{render()});
    render();
  }
