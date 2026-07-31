  /* ---- MY AGENTS: wallet-driven. Scans the CONNECTED wallet and shows only the agents it
     actually holds — across on-chain iNFTs (Base), Virtuals ACP, Robinhood and OKX, even the
     ones with no iNFT. No hardcoded roster. Every source is keyless where it can be and fully
     fault-tolerant: one economy failing never blanks the others. ---- */
  function wireAgents(p){
    const list=p.querySelector('#agentlist');
    let scanning=false;
    const safeImg=u=>(u&&/^(https?:|data:image\/)/i.test(u)&&!/['"()]/.test(u))?u:'';
    // The wallet holds all kinds of NFTs (airdrops, PFPs, spam, empty test contracts).
    // MY AGENTS shows AGENTS only, and "what is an agent" is defined ONCE — in the bridge
    // (nft.mjs · isAgentNft), which tags every scanned token with `isAgent`. The wallet
    // drawer and the LAB read the same tag, so the three surfaces can never disagree.
    const isAgentNft=a=>!!(a&&a.isAgent);

    // Fan out to every economy at once, keyed by the wallet address; merge + dedupe the result.
    async function scanAll(addr){
      const out=[],notes=[],add=o=>{if(o)out.push(o)},jobs=[];
      // What each economy actually answered. "Nothing found" is a claim about four
      // different systems, and the owner cannot check it unless the panel says which ones
      // replied, which held nothing, and which never ran. 'ok' = it answered and was empty.
      const probed={};
      const mark=(k,state,detail)=>{probed[k]={state,detail}};
      // ONE identity graph for every economy: on Virtuals an agent lives in its OWN wallet,
      // and a person's wallets are just as separate on any other chain. Resolve them once
      // here and hand the same set to each scan, instead of each one guessing.
      let wallets=[addr];
      try{const p=await RPC('virtuals','profile',addr);if(p&&Array.isArray(p.wallets)&&p.wallets.length)wallets=p.wallets}catch(_){}
      const short=w=>w.slice(0,6)+'…'+w.slice(-4);
      // 1) On-chain iNFTs the wallet holds on Base (keyless Blockscout indexer) — across
      // every wallet in the graph, each card saying which one it came from.
      jobs.push(Promise.all(wallets.slice(0,8).map(w=>RPC('nft','scanWallet',w,{}).then(r=>({w,r})).catch(()=>({w,r:null})))).then(res=>{
        let answered=0,held=0,needsConfig=false;
        res.forEach(({w,r})=>{
          if(!r)return; answered++;
          const list=(r&&r.agents)||[];
          // fail open when the bridge predates the tag — see the wallet drawer's note
          const inft=(typeof r.inftCount==='number')?list.filter(isAgentNft):list;
          held+=inft.length;
          if(r.needsConfig)needsConfig=true;
          inft.forEach(a=>add({
            key:'nft:'+(a.contract||'')+':'+(a.tokenId!=null?a.tokenId:''),
            name:a.name||('#'+a.tokenId),idText:a.tokenId!=null?('#'+a.tokenId):'',
            role:[a.collection||a.symbol||'on-chain agent',
                  w.toLowerCase()!==String(addr).toLowerCase()?('held by '+short(w)):''].filter(Boolean).join(' · '),
            image:safeImg(a.image),
            source:'iNFT · Base',tokenId:/^\d+$/.test(String(a.tokenId))?Number(a.tokenId):null,
            url:(a.contract&&a.tokenId!=null)?('https://basescan.org/token/'+a.contract+'?a='+a.tokenId):''
          }));
        });
        mark('base',answered?'ok':'down',answered+'/'+res.length+' wallet(s), '+held+' iNFT'+(held===1?'':'s'));
        if(needsConfig)notes.push('On-chain: add your agent collection (LAB → Agents) to widen the Base scan.');
      }).catch(()=>mark('base','down')));
      // 2) Virtuals — the IDENTITY GRAPH, not just this one wallet. An agent gets its own
      // wallet on Virtuals, and that wallet is what owns the agent: scanning only the
      // wallet the owner logs in with found nothing and said "no agents", which was a lie
      // (proven on his account: login → 0 registrations, agent wallet → agentId 55101).
      // holdings() walks every wallet the profile links and reports where each came from.
      jobs.push(RPC('virtuals','holdings',addr,{wallets}).then(r=>{
        ((r&&r.agents)||[]).forEach(a=>add({
          key:'virt:'+(a.id||a.virtualId||a.agentId||a.name),
          name:a.name||a.symbol||('agent '+(a.virtualId||a.agentId||'')),
          idText:a.symbol?('$'+a.symbol):(a.virtualId?('#'+a.virtualId):(a.agentId?('#'+a.agentId):'')),
          // An agent that exists without an on-chain identity is still YOURS — it is shown,
          // and labelled, instead of hidden. And an agent with completed ACP jobs is a
          // working business: say so here rather than making the owner go and look.
          //
          // The label says what was MEASURED. `activated` here is exactly one thing: this
          // agent has a registration in the ERC-8004 identity registry on Base. It read
          // "activated / not activated yet", which sounds like a switch on the agent — and
          // Virtuals' own docs never define such a switch, so the word was ours, not theirs.
          role:[
            a.source==='ACP'?'Virtuals ACP':(a.source==='ERC-8004'?'ERC-8004 · Base':'Virtuals'+(a.chain?(' · '+a.chain):'')),
            a.activated?'ERC-8004 registered':'no on-chain identity yet',
            (a.jobs&&a.jobs.total)?((a.jobs.completed||0)+' job'+(a.jobs.completed===1?'':'s')+' completed'+(a.jobs.open?(' · '+a.jobs.open+' open'):'')):'',
            (a.wallet&&a.wallet.toLowerCase()!==String(addr).toLowerCase())?('held by '+a.wallet.slice(0,6)+'…'+a.wallet.slice(-4)):'',
          ].filter(Boolean).join(' · '),
          image:safeImg(a.image),source:'Virtuals',tokenId:null,
          url:a.acpId?('https://app.virtuals.io/acp/agents/'+a.acpId)
             :(a.virtualId?('https://app.virtuals.io/virtuals/'+a.virtualId)
             :(a.agentId?('https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a='+a.agentId):''))
        }));
        mark('virtuals',(r&&r.ok)?'ok':'down',(r&&r.ok)?(r.wallets?r.wallets.length:1)+' wallet(s), '+((r.agents||[]).length)+' agent(s)':'');
        if(r&&r.ok&&r.linked>0)notes.push(r.linked+' linked wallet(s) from your Virtuals profile were scanned as well.');
        if(r&&r.ok&&!r.catalogOk)notes.push('The Virtuals catalog was unreachable, so only on-chain identities are shown.');
      }).catch(()=>{mark('virtuals','down');notes.push('Virtuals scan is unavailable right now.')}));
      // 3) Robinhood Chain — agent tokens + NFT holdings, across the same wallet graph
      // (keyless RPC + Blockscout). It only ever read the login wallet before.
      jobs.push(Promise.all(wallets.slice(0,8).map(w=>Promise.all([
        RPC('robinhood','tokens',w).catch(()=>null),RPC('robinhood','nfts',w).catch(()=>null),
      ]).then(([tk,nf])=>({w,tk,nf})))).then(res=>{
        let answered=0,found=0;
        res.forEach(({w,tk,nf})=>{
          if(tk||nf)answered++;
          const where=w.toLowerCase()!==String(addr).toLowerCase()?(' · held by '+short(w)):'';
          ((tk&&tk.tokens)||[]).forEach(t=>{found++;add({
            key:'rbh:t:'+(t.address||t.symbol),name:t.name||t.symbol||'token',
            idText:t.symbol?('$'+t.symbol):'',role:'Robinhood'+(t.balance?(' · '+t.balance):'')+where,
            image:'',source:'Robinhood',tokenId:null,
            url:t.address?('https://robinhoodchain.blockscout.com/token/'+t.address):''
          })});
          ((nf&&nf.items)||[]).forEach(t=>{found++;add({
            key:'rbh:n:'+(t.contract||'')+':'+(t.tokenId!=null?t.tokenId:''),name:t.name||('#'+t.tokenId),
            idText:t.tokenId!=null?('#'+t.tokenId):'',role:'Robinhood · NFT'+where,image:safeImg(t.image),
            source:'Robinhood',tokenId:null,url:t.contract?('https://robinhoodchain.blockscout.com/token/'+t.contract):''
          })});
        });
        mark('robinhood',answered?'ok':'down',answered+'/'+res.length+' wallet(s), '+found+' holding'+(found===1?'':'s'));
      }).catch(()=>mark('robinhood','down')));
      // 4) OKX (onchainos) — the wallet's own agents; needs the CLI + a live session.
      // "Not authenticated" used to send the owner to `onchainos login`, which is not a
      // command — the real flow is `onchainos wallet login` (OTP to email) then
      // `onchainos wallet verify`. And an expired session is not a missing account: the
      // CLI knows the account and its email, so say which one needs signing back in.
      jobs.push(RPC('okxai','status').then(async st=>{
        const state=(st&&st.state)||(st&&st.ok?(st.installed?(st.authenticated?'ready':'no-account'):'not-installed'):'down');
        if(state==='ready'){
          const r=await RPC('okxai','agents').catch(()=>null);
          const list=(r&&r.agents)||[];
          list.forEach(a=>add({
            key:'okx:'+(a.id||a.agentId||a.name),name:a.name||('agent '+(a.agentId||a.id||'')),
            idText:a.agentId?('#'+a.agentId):'',role:'OKX'+(a.status?(' · '+a.status):''),
            image:safeImg(a.image),source:'OKX',tokenId:null,url:''
          }));
          mark('okx',(r&&r.ok===false)?'down':'ok',list.length+' agent(s)');
        }else if(state==='session-expired'){
          mark('okx','auth','session expired');
          notes.push('OKX: your session expired'+(st.email?(' for '+st.email):'')+' — run “onchainos wallet login”, then “onchainos wallet verify <code>” in the terminal, and rescan.');
        }else if(state==='no-account'){
          mark('okx','auth','no account');
          notes.push('OKX: sign in once with “onchainos wallet login” to include your OKX agents (e.g. ATLAS).');
        }else if(state==='not-installed'){
          mark('okx','off','not installed');
          notes.push('OKX: install onchainos to include your OKX agents.');
        }else mark('okx','down');
      }).catch(()=>mark('okx','down')));
      await Promise.all(jobs);
      const seen=new Set(),uniq=[];out.forEach(o=>{if(!seen.has(o.key)){seen.add(o.key);uniq.push(o)}});
      return{agents:uniq,notes,probed,wallets};
    }

    // What the scan actually covered. Without this, "no agents found" is one sentence
    // standing in for four separate systems, and the owner has no way to tell an empty
    // wallet from an economy that never answered — the difference that matters most.
    const COVER=[['base','On-chain · Base'],['virtuals','Virtuals'],['robinhood','Robinhood'],['okx','OKX']];
    const COVER_MARK={ok:'✓',auth:'•',off:'–',down:'✕'};
    function coverageHTML(res){
      const p=res.probed||{};
      const parts=COVER.filter(([k])=>p[k]).map(([k,label])=>{
        const s=p[k];
        return `<span class="agcov ${escAttr(s.state)}" title="${escAttr(s.detail||s.state)}">${COVER_MARK[s.state]||'?'} ${escHtml(label)}</span>`;
      });
      if(!parts.length)return '';
      return `<div class="agcovrow">${parts.join('')}</div>`;
    }

    // one card — reuses .agentitem styling. iNFT agents (numeric tokenId) can be USED IN CODE;
    // economy-only agents get a VIEW link to their marketplace (opened in the in-app browser).
    function cardHTML(a,active){
      const useable=a.tokenId!=null,isActive=useable&&active===a.tokenId;
      const av=a.image?`<div class="av2" style="background-image:url('${a.image}');background-size:cover;background-position:center"></div>`
                      :`<div class="av2"><svg><use href="#i-agent"/></svg></div>`;
      return `<div class="agentitem" data-key="${escAttr(a.key)}" data-tid="${useable?a.tokenId:''}">
        <div class="top">${av}
          <div style="flex:1;min-width:0"><b>${escHtml(a.name)}</b> <span class="aid">${escHtml(a.idText||'')}</span><div class="role">${escHtml(a.role||'')}</div></div>
          <span class="agsrc">${escHtml(a.source)}</span>
        </div>
        <div class="modes">
          ${useable?`<button class="ause ${isActive?'active':''}" data-use>${isActive?'ACTIVE IN CODE':'USE IN CODE'}</button>`:''}
          ${a.url?'<button class="amode" data-view>VIEW ↗</button>':''}
        </div>
      </div>`;
    }

    function paint(res,addr){
      const active=Store.get().activeAgent,who=WalletAuth.short(addr);
      const notesHTML=coverageHTML(res)+(res.notes.length?`<div class="agnotes">${res.notes.map(n=>'· '+escHtml(n)).join('<br>')}</div>`:'');
      const scanned=(res.wallets&&res.wallets.length>1)?(res.wallets.length+' wallets scanned'):'';
      if(!res.agents.length){
        list.innerHTML=`<div class="agempty">No agents found in <b>${escHtml(who)}</b> yet.</div>`+notesHTML+
          `<div class="agfoot"><span>${escHtml(scanned||'Freshly minted holdings can take a moment to index.')}</span><button class="ause" data-rescan>Rescan</button></div>`;
      }else{
        list.innerHTML=res.agents.map(a=>cardHTML(a,active)).join('')+notesHTML+
          `<div class="agfoot"><span>${res.agents.length} agent(s)${scanned?(' · '+escHtml(scanned)):(' held by '+escHtml(who))}</span><button class="ause" data-rescan>Rescan</button></div>`;
      }
      list.querySelectorAll('[data-use]').forEach(b=>b.addEventListener('click',()=>{
        const item=b.closest('.agentitem'),tid=+item.dataset.tid,a=res.agents.find(x=>x.key===item.dataset.key);
        // The button said "USE IN CODE" and wrote `activeAgent`, which is LAB's selection key.
        // CODE binds a session to `pinnedAgents` (terminal.js:442, written by LAB's ✓), and
        // reads `activeAgent` nowhere — so the toast was true of LAB and false of CODE. Write
        // BOTH, in the shape LAB writes, so the two panels agree and the sentence is honest.
        const st0=Store.get();
        if(!Array.isArray(st0.pinnedAgents))st0.pinnedAgents=[];
        if(a){
          // `a` is a CARD, built by scanAll() — key/name/idText/role/image/source/tokenId/url.
          // The first version of this copied a.contract/a.collection/a.animation/a.mediaType/
          // a.description straight off it; none of those exist on a card, so every pin written
          // here carried contract:undefined. LAB pins the RAW scanWallet record and matches on
          // (contract, tokenId), so it could never find this one: pressing ✓ there pushed a
          // SECOND pin instead of toggling, CODE listed the agent twice, and the first entry
          // could never be removed because LAB's toggle is the only unpin control there is.
          // The card's `key` is 'nft:<contract>:<tokenId>' — the contract is right there.
          const contract=(String(a.key||'').startsWith('nft:')?String(a.key).split(':')[1]:'')||'';
          const same=x=>String(x.contract||'')===contract&&String(x.tokenId)===String(a.tokenId);
          if(!st0.pinnedAgents.some(same))st0.pinnedAgents.push({contract,tokenId:a.tokenId,name:a.name,collection:a.source||'',image:a.image,animation:'',mediaType:'',description:a.idText||''});
        }
        st0.activeAgent=tid;Store.save();
        if(typeof WalletPins!=='undefined'&&WalletPins.commit)WalletPins.commit(); // the pin belongs to this wallet
        Bus.emit('agent:active',tid);
        Toast.show((a&&a.name||'agent')+' pinned — pick it in CODE\'s agent selector');paint(res,addr);
      }));
      list.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{
        const a=res.agents.find(x=>x.key===b.closest('.agentitem').dataset.key);
        if(a&&a.url&&typeof webOpen==='function')webOpen(a.url,{newTab:true});
      }));
      const rs=list.querySelector('[data-rescan]');if(rs)rs.addEventListener('click',()=>scan(true));
    }

    async function scan(force){
      const addr=WalletAuth.addr();
      if(!addr){
        list.innerHTML='<div class="agempty">Connect your wallet to see the agents you hold — everywhere they live.</div><div class="agfoot"><span></span><button class="ause" data-connect>Connect wallet</button></div>';
        const c=list.querySelector('[data-connect]');if(c)c.addEventListener('click',()=>{try{WalletAuth.connect()}catch(_){}});
        return;
      }
      if(!Bridge.on()){list.innerHTML='<div class="agempty">Start the HUB Bridge to scan your wallet across on-chain, Virtuals, Robinhood and OKX.</div>';return;}
      if(scanning&&!force)return;scanning=true;
      list.innerHTML=`<div class="agscan"><span class="agspin"></span>Scanning ${escHtml(WalletAuth.short(addr))} — on-chain · Virtuals · Robinhood · OKX…</div>`;
      let res;try{res=await scanAll(addr)}catch(e){res={agents:[],notes:['Scan failed: '+(e&&e.message||e)]}}
      scanning=false;
      if(WalletAuth.addr()!==addr){scan(false);return}
      paint(res,addr);
    }

    panelBus(p).on('wallet',()=>scan(true)); // wallet connect/disconnect → rescan (auto-cleaned on close)
    scan(false);
  }
