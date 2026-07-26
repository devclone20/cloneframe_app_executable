  function wireShell(p){
    const treeEl=p.querySelector('#shtree'),wsEl=p.querySelector('#itws'),mainEl=p.querySelector('#itmain');
    if(!treeEl||!wsEl||!mainEl)return;
    // Exactly ONE iT in the WHOLE app owns the saved layout. instancesOf() only sees panels
    // in this document, so two app windows each believed they were the first: both restored
    // the same workspaces (duplicate shells for one set of folders) and both saved — the last
    // writer silently replaced the other window's layout. A short lease in localStorage settles
    // it across windows; a stale lease (crashed window) is simply taken over. Everyone else
    // runs live-only: fully usable, just not the one writing the layout down.
    const IT_OWNER='cfhub.it.owner',IT_LEASE=9000;
    const itSelf=Math.random().toString(36).slice(2)+Date.now().toString(36);
    const itLeaseHeld=()=>{try{const o=JSON.parse(localStorage.getItem(IT_OWNER)||'null');return (o&&Date.now()-o.ts<IT_LEASE)?o:null}catch(_){return null}};
    const itClaim=()=>{const o=itLeaseHeld();if(o&&o.id!==itSelf)return false;try{localStorage.setItem(IT_OWNER,JSON.stringify({id:itSelf,ts:Date.now()}))}catch(_){}return true};
    let primary=instancesOf('shell').length<=1&&itClaim();
    if(primary){
      // Two windows opening in the same tick can both claim; whoever's write landed last
      // owns it, and the other stands down here.
      setTimeout(()=>{const o=itLeaseHeld();if(o&&o.id!==itSelf)primary=false},300);
      const hb=setInterval(()=>{if(primary&&p.isConnected)itClaim();else clearInterval(hb)},3000);
      if(hb.unref)hb.unref();
    }
    const strip=s=>String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r(?!\n)/g,'');
    const base=pth=>{const s=String(pth||'').replace(/\/+$/,'');const i=s.lastIndexOf('/');return i>=0?s.slice(i+1):s};
    const parent=pth=>{const s=String(pth||'').replace(/\/+$/,'');const i=s.lastIndexOf('/');return i>0?s.slice(0,i):'/'};
    const join=(a,b)=>a.replace(/\/+$/,'')+'/'+b;
    const qpath=pth=>'"'+String(pth).replace(/"/g,'')+'"';
    // The cmux model: workspace (sidebar row) ▸ pane (split) ▸ surface (a tab inside a pane).
    // Two kinds of surface share a pane:
    //   tty   — a REAL interactive terminal (xterm ↔ WS /stream ↔ node-pty): vim, htop,
    //           ssh, claude, tmux all work; each surface is its own process with its own cwd.
    //           The zsh integration emits OSC 7, so the folder tree follows the shell.
    //   smart — the line shell (ghost suggestions · Tab-complete · OMZ prompt themes).
    // ＋ opens a live tty (⌥-click for a smart shell); if node-pty isn't available the
    // window quietly falls back to smart so it never dead-ends.
    let workspaces=[],wsActive=0,wsSeq=0,seq=0,homeAbs='~',canTTY=false;
    let leftHidden=false,treeHidden=false,unreadStamp=0;
    let wsGroups=[],grpSeq=0; // workspace groups (cmux): {id,name,color,collapsed}
    // Phase 4 — persistent sessions: stable per-shell id + the opt-in toggle (default ON)
    const newPsid=()=>{try{if(crypto&&crypto.randomUUID)return crypto.randomUUID().replace(/-/g,'')}catch(_){}return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,12)};
    const itPersist=()=>localStorage.getItem('cfhub.it.persist')!=='0';
    const tree={root:'',open:new Set(),kids:new Map(),here:''};

    // ---- Oh My Zsh prompt themes ----
    let omzTheme=localStorage.getItem('cfhub.shell.omz')||'robbyrussell';
    const OMZ_THEMES=['robbyrussell','agnoster','powerlevel'];
    const contract=cwd=>{const c=String(cwd||'');return (homeAbs&&homeAbs!=='~'&&(c===homeAbs||c.startsWith(homeAbs+'/')))?('~'+c.slice(homeAbs.length)):c};
    async function gitInfo(cwd){
      if(!Bridge.on()||!cwd||cwd==='~')return null;
      try{let b='';await Bridge.shell('git -C '+qpath(cwd)+' rev-parse --abbrev-ref HEAD 2>/dev/null',x=>{b+=x});b=b.trim();
        if(!b)return null;let s='';await Bridge.shell('git -C '+qpath(cwd)+' status --porcelain 2>/dev/null',x=>{s+=x});
        return{branch:b,dirty:!!s.trim()};}catch(_){return null}
    }
    function promptHTML(t){
      const full=escHtml(contract(t.cwd)),bn=escHtml(base(t.cwd)||contract(t.cwd)),g=t.git;
      if(omzTheme==='agnoster'){
        let h=`<span class="omz-a dir">${full}</span>`;
        if(g){const gc=g.dirty?'gitd':'git';h+=`<span class="omz-sep dir-on-${gc}">▶</span><span class="omz-a git${g.dirty?' d':''}">⎇ ${escHtml(g.branch)}${g.dirty?' ±':''}</span><span class="omz-sep ${gc}-on-end">▶</span>`}
        else h+=`<span class="omz-sep dir-on-end">▶</span>`;
        return h;
      }
      if(omzTheme==='powerlevel')return `<span class="omz-p dir">${full}</span>${g?`<span class="omz-p git">⎇ ${escHtml(g.branch)}${g.dirty?' ✱':''}</span>`:''}<span class="omz-p car">❯</span>`;
      return `<span class="omz-r arr">➜</span> <span class="omz-r cwd">${bn}</span>${g?` <span class="omz-r gp">git:(</span><span class="omz-r br">${escHtml(g.branch)}</span><span class="omz-r gp">)</span>${g.dirty?' <span class="omz-r x">✗</span>':''}`:''}`;
    }
    function updatePrompt(t){const el=t.el&&t.el.prompt;if(el&&t===activeTab()){el.innerHTML=promptHTML(t);el.title=t.cwd}}
    async function refreshGit(t){if(t.kind!=='smart')return;const g=await gitInfo(t.cwd);t.git=g;updatePrompt(t)}

    // ---- Tab path completion ----
    async function tabComplete(t,inp){
      const v=inp.value,caret=inp.selectionStart==null?v.length:inp.selectionStart,left=v.slice(0,caret);
      const token=(left.match(/(\S*)$/)||['',''])[1];
      let raw=token.replace(/^~(?=\/|$)/,homeAbs),dir,partial;const sl=raw.lastIndexOf('/');
      if(sl>=0){partial=raw.slice(sl+1);const dp=raw.slice(0,sl+1);dir=dp.startsWith('/')?dp:(String(t.cwd).replace(/\/+$/,'')+'/'+dp)}
      else{partial=raw;dir=t.cwd}
      const r=await RPC('files','list',dir).catch(()=>null);if(!r||!r.ok)return;
      let cands=r.entries.filter(e=>e.name.startsWith(partial));
      if(partial===''&&cands.length>12)cands=r.entries.filter(e=>!e.name.startsWith('.')).filter(e=>e.name.startsWith(partial));
      if(!cands.length)return;
      let lcp=cands[0].name;for(const e of cands)while(lcp&&!e.name.startsWith(lcp))lcp=lcp.slice(0,-1);
      let add=lcp.slice(partial.length);
      if(cands.length===1)add=cands[0].name.slice(partial.length)+(cands[0].type==='dir'?'/':' ');
      if(add){const nl=left+add;inp.value=nl+v.slice(caret);const np=nl.length;inp.setSelectionRange(np,np)}
      else if(cands.length>1)appendOut(t,'<span class="dim">'+cands.slice(0,60).map(e=>escHtml(e.name)+(e.type==='dir'?'/':'')).join('   ')+'</span>\n');
    }
    // ---- inline ghost suggestion (from history) ----
    function ghostFor(t,value){if(!value)return '';for(let i=t.hist.length-1;i>=0;i--){const h=t.hist[i];if(h.length>value.length&&h.startsWith(value))return h.slice(value.length)}return ''}
    function setGhost(t,value,rest){const g=t.el&&t.el.ghost;if(!g)return;g.querySelector('.g-typed').textContent=value;g.querySelector('.g-rest').textContent=rest}

    // ---- workspaces ▸ panes ▸ surfaces (every surface keeps its live DOM — switching never kills a process) ----
    const wsCur=()=>workspaces[wsActive];
    const paneCur=()=>{const w=wsCur();return w?(w.panes.find(x=>x.id===w.focus)||w.panes[0]||null):null};
    const activeTab=()=>{const pn=paneCur();return pn?pn.surfaces[pn.active]:null};
    const leaves=n=>n.sp?[...leaves(n.a),...leaves(n.b)]:[n];
    function tabLabel(t){if(t.named&&t.ptitle)return t.ptitle;if(t.kind==='web')return t.ptitle||'browser';if(t.kind==='diff')return 'diff · '+(base(t.cwd)||'~');if(t.kind==='code')return 'code · '+(base(t.cwd)||'~');if(t.sess)return '⟳ '+(t.sessName||t.sess);if(t.host)return '⚡ '+t.host;if(t.attach)return 'tmux:'+t.attach;
      // A workspace the owner NAMED names its plain shells too: renaming a workspace and
      // leaving its tab showing the home folder's name is the app disagreeing with itself
      // about what the thing is called. Tabs with an identity of their own (a diff, a
      // browser, an ssh host, a tmux session, a tab the owner renamed) keep it.
      const wn=t.pn&&t.pn.w&&t.pn.w.name;if(wn)return wn;
      if(t.hasCwd)return base(t.cwd)||'shell';return t.ptitle||base(t.cwd)||'shell'} // once OSC 7 speaks, the folder name IS the tab
    function wsLabel(w){return (w&&(w.name||w.autoName||base(w.cwd)))||'~'}
    function curCwd(){const t=activeTab();return (t&&t.cwd)||(wsCur()&&wsCur().cwd)||homeAbs}
    // a surface is "seen" when its window is visible, its workspace is active and it is its pane's front tab
    function surfVisible(t){const w=t.pn&&t.pn.w;return !!w&&p.offsetWidth>0&&w===wsCur()&&t.pn.surfaces[t.pn.active]===t}
    function isWsLead(t){const w=t.pn&&t.pn.w;return !!w&&(w.panes.find(x=>x.id===w.focus)||w.panes[0])===t.pn&&t.pn.surfaces[t.pn.active]===t}

    function newWorkspace(cwd,opts){
      opts=opts||{};
      const w={id:'w'+(++wsSeq),name:opts.name||'',autoName:'',color:opts.color||'',group:opts.group||null,status:{},progress:null,cwd:cwd||homeAbs,git:null,layout:null,panes:[],focus:'',grid:null,spec:opts.spec||null,canvasOn:!!opts.canvasOn,canvasRects:opts.canvasRects||null,canvasZoom:opts.canvasZoom||1,canvasPan:opts.canvasPan||{x:0,y:0}};
      workspaces.push(w);
      if(!opts.background){wsActive=workspaces.length-1;mountWs(w);showWs()}
      renderAll();refreshWsGit(w);saveState();return w;
    }
    function mountWs(w){
      if(w.grid)return;
      const g=document.createElement('div');g.className='it-grid';w.grid=g;mainEl.appendChild(g);
      if(w.spec){w.layout=hydrate(w.spec,w);w.spec=null}
      else{const pn=makePane(w);w.layout={pane:pn};newSurface(pn,w.cwd,undefined,null,true)}
      if(!w.focus&&w.panes.length)w.focus=w.panes[0].id;
      renderGrid(w);
    }
    function hydrate(spec,w){ // rebuild a saved split tree; each tty surface reopens a fresh shell at its cwd
      if(spec&&spec.sp)return{sp:spec.sp,ratio:spec.ratio||.5,a:hydrate(spec.a,w),b:hydrate(spec.b,w)};
      const pn=makePane(w);
      ((spec&&spec.surfs)||[]).slice(0,6).forEach(s=>{const nt=newSurface(pn,s.kind==='web'?(s.url||''):(s.cwd||w.cwd),s.kind,s.attach||null,true,s.psid,s.host||null,s.sess||null);if(nt&&s.sessName)nt.sessName=s.sessName;});
      if(!pn.surfaces.length)newSurface(pn,w.cwd,undefined,null,true);
      pn.active=Math.max(0,Math.min((spec&&spec.active)||0,pn.surfaces.length-1));
      return{pane:pn};
    }
    function makePane(w){
      const pn={id:'p'+(++seq),w,surfaces:[],active:0,zoom:false,el:null,strip:null,body:null,crect:null};
      const el=document.createElement('div');el.className='it-pane';
      el.innerHTML='<div class="it-cgrab" title="Drag to move (canvas mode)">⣿ ⣿ ⣿</div><div class="sh-tabs it-ptabs"></div><div class="it-pbody"></div><div class="it-cgrip" title="Drag to resize"></div>';
      pn.el=el;pn.strip=el.children[1];pn.body=el.children[2];
      el.addEventListener('pointerdown',()=>{if(w.focus!==pn.id){w.focus=pn.id;syncFocus();schedule()}if(w.canvasOn){pn.cz=++canvasZ;el.style.zIndex=pn.cz}},true);
      wireCanvasPane(w,pn);
      w.panes.push(pn);return pn;
    }
    function newSurface(pn,cwd,kind,attach,quiet,psid,host,sess){
      kind=kind||((canTTY&&Bridge.on()&&localStorage.getItem('cfhub.it.deftab')!=='smart')?'tty':'smart');
      const t={id:'sh'+(++seq),kind,attach:attach||null,host:host||null,sess:sess||null,cwd:cwd||homeAbs,ptitle:'',named:false,dead:false,unread:0,out:'',hist:[],hi:-1,busy:false,ctl:null,termApi:null,el:null,pane:null,pn};
      // Phase 4: a shell tab (not a tmux attach) gets a stable session id so its pty can
      // survive a reload — reattach + scrollback replay instead of being killed. On restore
      // we keep the SAVED id so the reattach finds the still-live pty.
      if(kind==='tty'&&!attach)t.psid=psid||newPsid();
      if(kind==='web'){t.url=String(cwd||'');t.cwd=homeAbs} // web surfaces carry a URL, not a cwd
      pn.surfaces.push(t);pn.active=pn.surfaces.length-1;
      buildSurface(pn,t);
      if(!quiet){renderAll();saveState()}
      return t;
    }
    function newTab(cwd,kind,attach){const pn=paneCur();return pn?newSurface(pn,cwd,kind,attach):null} // legacy name — smart-shell keys + tmux menu call this
    // ── attachments in iT: paste an image / drop files onto a terminal pane — they are
    // saved under the agent workspace (attachments/) and the shell-quoted paths are TYPED
    // at the prompt (no Enter — the owner decides the command). Max 5 per gesture.
    let _itAtt='';
    async function itAttachDir(){ // owner-visible tree — ~/.clone-frame-hub is write-protected
      if(_itAtt)return _itAtt;
      try{const st=await RPC('pi','status');const ws=(st&&st.workspacePath)||'';
        const home=ws.replace(/\/\.clone-frame-hub\/agent\/?$/,'');
        _itAtt=home?home+'/CloneFrame/Attachments':'';
      }catch(_){_itAtt=''}
      return _itAtt;
    }
    const shq=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
    async function itSaveFile(f){
      const dir=await itAttachDir();if(!dir){Toast.show('Bridge offline — could not save '+(f.name||'file'));return null}
      const safe=String(f.name||'pasted.png').replace(/\.\.+/g,'.').replace(/[^\w./-]+/g,'_');
      const path=dir+'/'+Date.now().toString(36)+'-'+safe;
      const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||'').split(',')[1]||'');r.onerror=rej;r.readAsDataURL(f)});
      try{const r=await RPC('files','writeB64',path,b64,{overwrite:true});if(r&&r.ok!==false)return path}catch(_){}
      Toast.show('Could not save '+(f.name||'file'));return null;
    }
    function wireTtyAttach(t,pane){
      const typePaths=paths=>{if(paths.length&&t.termApi&&t.termApi.send){t.termApi.send(paths.map(shq).join(' '));Toast.show(paths.length+' file'+(paths.length>1?'s':'')+' saved — path typed at the prompt')}};
      ['dragover','dragenter'].forEach(ev=>pane.addEventListener(ev,e=>{
        if([...(e.dataTransfer&&e.dataTransfer.types||[])].includes('Files')){e.preventDefault();e.stopPropagation()}
      }));
      pane.addEventListener('drop',async e=>{
        const fs=[...((e.dataTransfer&&e.dataTransfer.files)||[])];if(!fs.length)return;
        e.preventDefault();e.stopPropagation();
        if(fs.length>5)Toast.show('Max 5 files per drop — extra skipped');
        const paths=[];for(const f of fs.slice(0,5)){const q=await itSaveFile(f);if(q)paths.push(q)}
        typePaths(paths);
      });
      // capture-phase: xterm's own textarea handles text pastes; only FILE pastes are ours
      pane.addEventListener('paste',async e=>{
        const items=[...((e.clipboardData&&e.clipboardData.items)||[])].filter(it=>it.kind==='file');
        if(!items.length)return;
        e.preventDefault();e.stopPropagation();
        if(items.length>5)Toast.show('Max 5 files per paste — extra skipped');
        const paths=[];for(const it of items.slice(0,5)){const f=it.getAsFile();if(!f)continue;const q=await itSaveFile(f);if(q)paths.push(q)}
        typePaths(paths);
      },true);
    }
    // The live tty Term for a surface (local shell / ssh / keeper). Extracted so a dead
    // remote/keeper surface can be RECONNECTED in place without rebuilding the whole pane.
    function makeTtyTerm(t,pane){
      const pn=t.pn;
      return Term(pane,{
        op:t.sess?'keeper':(t.host?'ssh':(t.attach?'attach':'shell')),session:t.attach||undefined,host:t.host||undefined,sess:t.sess||undefined,cwd:t.cwd,ids:{ws:pn.w.id,surf:t.id},
        sid:t.attach?undefined:t.psid,persist:t.attach?false:itPersist(),
        onCwd:dir=>{t.cwd=dir;t.hasCwd=true;const w=pn.w;if(isWsLead(t)){w.cwd=dir;refreshWsGit(w)}schedule();markHere();saveState()},
        onTitle:s=>{const v=String(s||'').trim();if(v&&!t.attach&&!t.host&&!t.named){t.ptitle=v.slice(0,40);schedule()}},
        onExit:()=>{t.dead=true;schedule()},
        onOutput:()=>{if(!surfVisible(t)){const had=t.unread;t.unread=++unreadStamp;if(!had)schedule()}markFired(t)},
        onNotify:(ti,bo)=>noteAdd(t,ti,bo),
        onChunk:d=>pipeFeed(t,d) // Layer 2: `it pipe` tees output to a file when armed
      });
    }
    // Reconnect a dead remote/keeper surface — rebuild its live Term in place (ssh redials;
    // keeper reattaches to the still-alive daemon and replays scrollback).
    function reconnectSurface(t){
      if(!t||t.kind!=='tty'||!t.pane)return;
      if(t.pipe)pipeStop(t);
      if(t.termApi&&t.termApi.dispose){try{t.termApi.dispose()}catch(_){}}
      t.pane.innerHTML='';t.dead=false;t.busy=false;
      t.termApi=makeTtyTerm(t,t.pane);
      renderAll();
    }
    function buildSurface(pn,t){
      const pane=document.createElement('div');pane.className='sh-pane '+t.kind;t.pane=pane;pn.body.appendChild(pane);
      if(t.kind==='tty'){
        t.termApi=makeTtyTerm(t,pane);
        wireTtyAttach(t,pane);
      }else if(t.kind==='web'){
        // browser surface (⌘⇧L) — a page beside the terminal, cmux-style. The full browser
        // is now a real Chromium CDP engine (the BROWSER panel); this split stays lightweight:
        // localhost / dev-server origins render in a direct iframe (native scroll, own JS),
        // and everything else hands off to the BROWSER window — no proxy-reader anymore.
        pane.innerHTML='<div class="it-webbar"><input class="it-webin" placeholder="localhost URL, or a site to open in BROWSER" spellcheck="false" autocomplete="off"><button class="sh-treetog" data-wa="go" title="Go">→</button><button class="sh-treetog" data-wa="re" title="Reload">↻</button><button class="sh-treetog" data-wa="pop" title="Open in the BROWSER window">⧉</button></div><iframe class="it-webif" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe>';
        t.el={in:pane.querySelector('.it-webin'),fr:pane.querySelector('.it-webif')};
        const isLocal=u=>{try{const h=new URL(u).hostname;return h==='localhost'||h==='127.0.0.1'||h==='[::1]'||/\.localhost$/.test(h)}catch(_){return false}};
        const wnorm=q=>{q=String(q||'').trim();if(!q)return '';if(/^https?:\/\//i.test(q))return q;if(/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(q))return 'http://'+q;if(/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(q))return 'https://'+q;return 'https://'+q};
        const wload=q=>{
          const u=wnorm(q);if(!u)return;
          t.url=u;try{t.ptitle=new URL(u).hostname.replace(/^www\./,'')}catch(_){t.ptitle='browser'}
          t.el.in.value=u;schedule();
          if(isLocal(u)){t.el.fr.style.display='';t.el.fr.src=u;}
          else{
            // hand off to the real browser; keep this pane as an honest signpost
            t.el.fr.style.display='none';
            webOpen(u,{newTab:true});
            Toast&&Toast.show('Opened in the BROWSER window');
          }
          saveState();
        };
        t.el.in.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')wload(t.el.in.value)});
        pane.querySelector('[data-wa="go"]').addEventListener('click',()=>wload(t.el.in.value));
        pane.querySelector('[data-wa="re"]').addEventListener('click',()=>{if(t.url)wload(t.url)});
        pane.querySelector('[data-wa="pop"]').addEventListener('click',()=>{if(t.url)webOpen(t.url,{newTab:true});else openPanel('research')});
        if(t.url)wload(t.url);else setTimeout(()=>{try{t.el.in.focus()}catch(_){}},40);
      }else if(t.kind==='diff'){
        // diff viewer (⌃⌘⇧D, cmux) — a live `git diff` of the surface's folder, colored
        pane.innerHTML='<div class="it-diffbar"><b>DIFF</b><span class="br"></span><span class="fs dim"></span><span class="sp"></span><button class="sh-treetog" data-da="re" title="Refresh">↻</button></div><div class="it-diffout"><span class="dim">loading…</span></div>';
        t.el={br:pane.querySelector('.br'),fs:pane.querySelector('.fs'),out:pane.querySelector('.it-diffout')};
        const colorDiff=txt=>strip(txt).split('\n').map(l=>{
          const e2=escHtml(l);
          if(/^diff --git /.test(l)||/^(---|\+\+\+) /.test(l))return '<span class="fhd">'+e2+'</span>';
          if(/^@@/.test(l))return '<span class="hunk">'+e2+'</span>';
          if(/^\+/.test(l))return '<span class="add">'+e2+'</span>';
          if(/^-/.test(l))return '<span class="del">'+e2+'</span>';
          if(/^(index |new file|deleted file|similarity |rename )/.test(l))return '<span class="dim">'+e2+'</span>';
          return e2;
        }).join('\n');
        const render=async quiet=>{
          if(t._diffBusy)return;t._diffBusy=true;
          try{
            if(!Bridge.on()){t.el.out.innerHTML='<span class="dim">Connect the HUB Bridge to see diffs.</span>';return}
            if(!quiet)t.el.out.innerHTML='<span class="dim">loading…</span>';
            let br='';await Bridge.shell('git -C '+qpath(t.cwd)+' rev-parse --abbrev-ref HEAD 2>/dev/null',x=>{br+=x});br=strip(br).trim();
            if(!br){t.el.br.textContent='';t.el.fs.textContent='';t.el.out.innerHTML='<span class="dim">'+escHtml(contract(t.cwd))+' is not a git repository.</span>';return}
            t.el.br.textContent='⎇ '+br+' · '+base(t.cwd);
            let d='';await Bridge.shell('git -C '+qpath(t.cwd)+' -c core.quotepath=false diff HEAD 2>/dev/null',x=>{d+=x});
            let un='';await Bridge.shell('git -C '+qpath(t.cwd)+' ls-files --others --exclude-standard 2>/dev/null | head -20',x=>{un+=x});
            d=strip(d);const nf=(d.match(/^diff --git /gm)||[]).length;
            t.el.fs.textContent=nf?nf+' file'+(nf===1?'':'s')+' changed':'';
            let html=d.trim()?colorDiff(d.length>400000?d.slice(0,400000)+'\n… (truncated)':d):'<span class="dim">working tree clean — nothing to diff</span>';
            const unl=strip(un).split('\n').map(s2=>s2.trim()).filter(Boolean);
            if(unl.length)html+='\n\n<span class="fhd">untracked</span>\n'+unl.map(f=>'<span class="add">+ '+escHtml(f)+'</span>').join('\n');
            t.el.out.innerHTML=html;
          }catch(_){t.el.out.innerHTML='<span class="dim">diff failed</span>'}
          finally{t._diffBusy=false}
        };
        t.refreshDiff=render;
        pane.querySelector('[data-da="re"]').addEventListener('click',()=>render());
        render();
      }else if(t.kind==='code'){
        // code editor surface — open a FOLDER: file tree (left) + view/edit/save (right).
        // Unlike cmux (which only opens a single file), this opens the whole folder to browse.
        const root=t.cwd&&t.cwd!=='~'?t.cwd:homeAbs;t.cwd=root;
        t._copen=t._copen||new Set();t._ckids=t._ckids||new Map();
        pane.innerHTML='<div class="it-codetree"><div class="it-codehd"><b>'+escHtml(base(root)||root)+'</b><span class="up" title="Up one level">↑</span></div><div class="it-codelist"></div></div><div class="it-codeed"><div class="it-codeblank">Pick a file on the left to view or edit it.<br>Save writes straight to disk.</div></div>';
        t.el={list:pane.querySelector('.it-codelist'),ed:pane.querySelector('.it-codeed'),hd:pane.querySelector('.it-codehd b')};
        const clist=async dir=>{
          if(t._ckids.has(dir))return t._ckids.get(dir);
          let entries=[];try{const r=await RPC('files','list',dir);if(r&&r.ok)entries=(r.entries||[]).filter(e=>!e.name.startsWith('.'))}catch(_){}
          entries.sort((a,b)=>((a.type==='dir')===(b.type==='dir'))?a.name.localeCompare(b.name):(a.type==='dir'?-1:1));
          t._ckids.set(dir,entries);return entries;
        };
        const drawInto=async(container,dir,depth)=>{
          for(const e of await clist(dir)){
            const full=join(dir,e.name),isDir=e.type==='dir';
            const row=document.createElement('div');
            row.className='it-crow '+(isDir?'dir':'file')+(t._cfile===full?' on':'');
            row.style.paddingLeft=(7+depth*13)+'px';
            row.innerHTML=`<span class="chev">${isDir?(t._copen.has(full)?'▾':'▸'):''}</span><svg><use href="${isDir?'#i-folder':'#i-file'}"/></svg><span class="nm">${escHtml(e.name)}</span>`;
            container.appendChild(row);
            if(isDir){
              row.addEventListener('click',()=>{if(t._copen.has(full))t._copen.delete(full);else t._copen.add(full);drawCode()});
              if(t._copen.has(full))await drawInto(container,full,depth+1);
            }else{
              row.addEventListener('click',()=>openCodeFile(t,full));
            }
          }
        };
        const drawCode=async()=>{t.el.list.textContent='';await drawInto(t.el.list,t.cwd,0)};
        t.refreshCode=drawCode;
        pane.querySelector('.it-codehd .up').addEventListener('click',()=>{const pr=parent(t.cwd);if(pr&&pr!==t.cwd){t.cwd=pr;t._ckids.clear();t._copen.clear();t.el.hd.textContent=base(pr)||pr;drawCode();saveState()}});
        drawCode();
        if(t._cfile)openCodeFile(t,t._cfile);
      }else{
        pane.innerHTML=`<div class="sh-out"></div>
          <div class="sh-inrow"><span class="sh-prompt" title="${escAttr(t.cwd)}">${promptHTML(t)}</span><span class="sh-inwrap"><span class="sh-ghost"><span class="g-typed"></span><span class="g-rest"></span></span><input class="sh-in" placeholder="type a command — Tab / → completes · ⌘T new tab" autocomplete="off" spellcheck="false"></span></div>`;
        t.el={out:pane.querySelector('.sh-out'),prompt:pane.querySelector('.sh-prompt'),ghost:pane.querySelector('.sh-ghost'),in:pane.querySelector('.sh-in')};
        t.el.out.innerHTML=t.out||('<span class="dim">'+escHtml('Connected to your machine. Each tab is its own shell. ⌘T (or ＋) opens another. Tab / → completes. Click a file to view it, a folder to cd there.')+'</span>');
        t.el.in.addEventListener('keydown',e=>onKey(e,t));
        t.el.in.addEventListener('input',()=>setGhost(t,t.el.in.value,ghostFor(t,t.el.in.value)));
        refreshGit(t);
      }
    }
    // kill=true → reap the pty (the user closed this tab/pane on purpose); kill=false →
    // just drop the socket so the bridge detaches and keeps it alive for a reattach.
    function disposeSurf(t,kill){
      if(t.ctl){try{t.ctl.abort()}catch(_){}}
      if(t.termApi){try{t.termApi.dispose(kill)}catch(_){}}
      if(t.pane){try{t.pane.remove()}catch(_){}}
    }
    function closeSurface(pn,i){
      const t=pn.surfaces[i];if(!t)return;
      if(t.pipe)pipeStop(t); // flush + stop any output pipe before disposing
      disposeSurf(t,true);pn.surfaces.splice(i,1);
      if(!pn.surfaces.length){closePane(pn);return}
      if(pn.active>=pn.surfaces.length)pn.active=pn.surfaces.length-1;
      renderAll();saveState();
    }
    // Send a surface to a frame square (its folder name shows on the tile; clicking it reopens a terminal there).
    function popSurf(pn,i){
      const t=pn.surfaces[i];if(!t)return;
      const cell=Grid.dockNew('shell',{label:base(t.cwd)||'shell',cwd:t.cwd});
      if(!cell){Toast.show('No free frame square — zoom out to make room');return}
      Toast.show('Terminal sent to a frame — click the square to open it');
      const w=pn.w;if(pn.surfaces.length>1||w.panes.length>1||workspaces.length>1)closeSurface(pn,i);
    }

    // ---- split tree (binary, cmux-style: ⌘D right · ⌘⇧D down) ----
    function leafOf(n,pn){if(!n)return null;if(!n.sp)return n.pane===pn?n:null;return leafOf(n.a,pn)||leafOf(n.b,pn)}
    function parentOf(n,child){if(!n||!n.sp)return null;if(n.a===child||n.b===child)return n;return parentOf(n.a,child)||parentOf(n.b,child)}
    // insert an EMPTY pane beside pn in the split tree; returns it (caller fills it)
    function spawnPane(pn,dir,before){
      const w=pn.w,leaf=leafOf(w.layout,pn);if(!leaf)return null;
      const npn=makePane(w);
      const rep=before?{sp:dir,ratio:.5,a:{pane:npn},b:leaf}:{sp:dir,ratio:.5,a:leaf,b:{pane:npn}};
      const par=parentOf(w.layout,leaf);
      if(!par)w.layout=rep;else if(par.a===leaf)par.a=rep;else par.b=rep;
      return npn;
    }
    function splitPane(pn,dir,before,kind){ // dir 'h'|'v' · before=true → new pane lands left/up · kind 'web' = browser split (⌘⇧L)
      const cur=pn.surfaces[pn.active];
      const npn=spawnPane(pn,dir,before);if(!npn)return;
      newSurface(npn,kind==='web'?'':((cur&&cur.cwd)||pn.w.cwd),kind,null,true);
      pn.w.focus=npn.id;
      renderGrid(pn.w);renderAll();saveState();
    }
    // move a live surface between panes — the DOM (xterm) survives an appendChild move
    function relocateSurface(fromPn,i,toPn){
      const t=fromPn.surfaces[i];if(!t||fromPn===toPn)return;
      fromPn.surfaces.splice(i,1);
      if(fromPn.active>=fromPn.surfaces.length)fromPn.active=Math.max(0,fromPn.surfaces.length-1);
      t.pn=toPn;toPn.body.appendChild(t.pane);
      toPn.surfaces.push(t);toPn.active=toPn.surfaces.length-1;
      toPn.w.focus=toPn.id;
      if(!fromPn.surfaces.length)closePane(fromPn);else{renderGrid(toPn.w);renderAll();saveState()}
    }
    // break-pane (cmux): the active tab leaves its pane for a fresh split
    function breakPane(){
      const pn=paneCur();if(!pn||pn.surfaces.length<2)return; // a lone tab already owns its pane
      const npn=spawnPane(pn,'h',false);if(!npn)return;
      relocateSurface(pn,pn.active,npn);
    }
    // move-surface: send the active tab to the neighbouring pane in a direction
    function moveSurfaceDir(dir){
      const w=wsCur(),fp=paneCur();if(!w||!fp||w.panes.length<2)return;
      const r0=fp.el.getBoundingClientRect(),cx=r0.left+r0.width/2,cy=r0.top+r0.height/2;
      let best=null,bd=1e9;
      w.panes.forEach(pn=>{if(pn===fp)return;const r=pn.el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
        const ok=dir==='left'?x<cx-4:dir==='right'?x>cx+4:dir==='up'?y<cy-4:y>cy+4;if(!ok)return;
        const d=Math.abs(x-cx)+Math.abs(y-cy);if(d<bd){bd=d;best=pn}});
      if(best)relocateSurface(fp,fp.active,best);
    }
    function closePane(pn){
      const w=pn.w;
      pn.surfaces.forEach(t=>disposeSurf(t,true));pn.surfaces=[]; // closing a pane reaps its shells
      try{pn.el.remove()}catch(_){}
      w.panes=w.panes.filter(x=>x!==pn);
      const leaf=leafOf(w.layout,pn),par=leaf?parentOf(w.layout,leaf):null;
      if(!par){ // it was the last pane of this workspace
        if(workspaces.length>1){closeWorkspace(w);return}
        const npn=makePane(w);w.layout={pane:npn};newSurface(npn,w.cwd,undefined,null,true);w.focus=npn.id;
      }else{
        const sib=par.a===leaf?par.b:par.a,gp=parentOf(w.layout,par);
        if(!gp)w.layout=sib;else if(gp.a===par)gp.a=sib;else gp.b=sib;
        if(w.focus===pn.id){const l=leaves(w.layout);w.focus=l.length?l[0].pane.id:''}
      }
      renderGrid(w);renderAll();saveState();
    }
    function renderGrid(w){
      if(!w.grid)return;
      w.grid.classList.toggle('canvas',!!w.canvasOn);
      w.grid.textContent='';
      if(w.canvasOn)renderCanvas(w);
      else{
        w.grid.onwheel=null; // drop the canvas zoom/pan wheel handler when leaving canvas
        w.panes.forEach(pn=>{const s=pn.el.style;s.left=s.top=s.width=s.height=s.zIndex=s.transform=''}); // shed canvas placement
        w.grid.appendChild(buildNode(w.layout));
      }
      syncFocus();
    }
    function buildNode(n){ // pane elements are REUSED (moved, never recreated) — live xterms survive re-layout
      if(!n.sp){n.pane.el.style.flex='1 1 0';return n.pane.el}
      const box=document.createElement('div');box.className='it-node '+(n.sp==='v'?'v':'h');
      const a=buildNode(n.a),b=buildNode(n.b);
      const div=document.createElement('div');div.className='it-div '+(n.sp==='v'?'v':'h');div.title='Drag to resize';
      a.style.flex=n.ratio+' 1 0';b.style.flex=(1-n.ratio)+' 1 0';
      box.append(a,div,b);
      div.addEventListener('pointerdown',e=>{e.preventDefault();div.classList.add('drag');
        const r=box.getBoundingClientRect();
        const mm=ev=>{const f=n.sp==='v'?(ev.clientY-r.top)/r.height:(ev.clientX-r.left)/r.width;n.ratio=Math.max(.12,Math.min(.88,f));a.style.flex=n.ratio+' 1 0';b.style.flex=(1-n.ratio)+' 1 0'};
        const mu=()=>{removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);div.classList.remove('drag');saveState()};
        addEventListener('pointermove',mm);addEventListener('pointerup',mu)});
      return box;
    }

    // ---- canvas mode (⌃⌘C, cmux) — panes float free on a zoom/pan space. Rects are
    // FRACTIONS of the space; a `.it-cspace` wrapper carries translate()+scale(), so the
    // whole board zooms and pans without touching any pane. The split tree stays intact
    // underneath (canvas is presentation only) — toggling back restores the exact tiling.
    const CZMIN=.25,CZMAX=3;
    let canvasZ=1; // per-pane stacking counter (which floats on top), not the zoom
    const clampN=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    function defaultRect(i){const o=(i%5)*.05;return{x:.05+o,y:.05+o,w:.46,h:.52}}
    function cspaceOf(w){return w.grid&&w.grid.querySelector('.it-cspace')}
    function applyCanvasXform(w){
      const sp=cspaceOf(w);if(!sp)return;
      const z=w.canvasZoom||1,p=w.canvasPan||{x:0,y:0};
      sp.style.transform=`translate(${p.x||0}px,${p.y||0}px) scale(${z})`;
      const lbl=w.grid.querySelector('.it-czlbl');if(lbl)lbl.textContent=Math.round(z*100)+'%';
    }
    function placeCanvasPane(w,pn){
      const s=pn.el.style;
      if(pn.zoom){s.left=s.top=s.width=s.height=s.transform='';s.zIndex=20;return} // zoomed pane escapes the space (see renderCanvas)
      const r=pn.crect;s.left=(r.x*100)+'%';s.top=(r.y*100)+'%';s.width=(r.w*100)+'%';s.height=(r.h*100)+'%';s.zIndex=pn.cz||1;
    }
    function renderCanvas(w){
      const ls=w.layout?leaves(w.layout):[];
      if(w.canvasRects){ls.forEach((l,i)=>{const r=w.canvasRects[i];if(r)l.pane.crect=r});w.canvasRects=null}
      const sp=document.createElement('div');sp.className='it-cspace';
      // pan by dragging the empty space (or two-finger scroll); ⌘/ctrl+wheel zooms at the cursor
      sp.addEventListener('pointerdown',e=>{
        if(e.target.closest('.it-pane'))return;
        e.preventDefault();const p0={...(w.canvasPan||{x:0,y:0})},x0=e.clientX,y0=e.clientY;
        const mm=ev=>{w.canvasPan={x:p0.x+(ev.clientX-x0),y:p0.y+(ev.clientY-y0)};applyCanvasXform(w)};
        const mu=()=>{removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);saveState()};
        addEventListener('pointermove',mm);addEventListener('pointerup',mu);
      });
      w.grid.appendChild(sp);
      ls.forEach((l,i)=>{const pn=l.pane;if(!pn.crect)pn.crect=defaultRect(i);placeCanvasPane(w,pn);(pn.zoom?w.grid:sp).appendChild(pn.el)});
      // toolbar (fixed, not zoomed): − % + · overview · reveal · tidy
      const tb=document.createElement('div');tb.className='it-ctools';
      tb.innerHTML='<button data-cz="out" title="Zoom out (⌥⌘-)">−</button><button class="it-czlbl" data-cz="reset" title="Reset zoom (⌘0)">100%</button><button data-cz="in" title="Zoom in (⌥⌘=)">+</button><span class="sep"></span><button data-cz="over" title="Overview — fit all (⌃⌘O)">⊡</button><button data-cz="reveal" title="Reveal focused pane (⌃⌘R)">◎</button><button data-cz="tidy" title="Tidy into a grid (⌃⌘T)">▦</button>';
      const cz={out:()=>canvasZoomBy(1/1.2),in:()=>canvasZoomBy(1.2),reset:canvasZoomReset,over:canvasOverview,reveal:canvasReveal,tidy:tidyCanvas};
      tb.querySelectorAll('[data-cz]').forEach(b=>b.addEventListener('click',ev=>{ev.stopPropagation();(cz[b.dataset.cz]||(()=>{}))()}));
      w.grid.appendChild(tb);
      w.grid.onwheel=e=>{
        if(!w.canvasOn)return;e.preventDefault();
        if(e.metaKey||e.ctrlKey){const g=w.grid.getBoundingClientRect();canvasZoomBy(e.deltaY<0?1.1:1/1.1,e.clientX-g.left,e.clientY-g.top)}
        else{const p=w.canvasPan||{x:0,y:0};w.canvasPan={x:p.x-e.deltaX,y:p.y-e.deltaY};applyCanvasXform(w)}
      };
      applyCanvasXform(w);
    }
    function canvasRectsOf(w){
      if(!w.grid||!w.layout)return w.canvasRects||null;
      return leaves(w.layout).map(l=>l.pane.crect?{x:+l.pane.crect.x.toFixed(3),y:+l.pane.crect.y.toFixed(3),w:+l.pane.crect.w.toFixed(3),h:+l.pane.crect.h.toFixed(3)}:null);
    }
    function wireCanvasPane(w,pn){
      const track=(el,apply,doSnap)=>{
        el.addEventListener('pointerdown',e=>{
          if(!w.canvasOn||pn.zoom)return;
          e.preventDefault();e.stopPropagation();
          pn.cz=++canvasZ;pn.el.style.zIndex=pn.cz;
          const g=w.grid.getBoundingClientRect(),z=w.canvasZoom||1,r0={...pn.crect},x0=e.clientX,y0=e.clientY;
          const mm=ev=>{apply(r0,(ev.clientX-x0)/(g.width*z),(ev.clientY-y0)/(g.height*z),g);placeCanvasPane(w,pn)};
          const mu=()=>{removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);if(doSnap)snapPane(w,pn);placeCanvasPane(w,pn);saveState()};
          addEventListener('pointermove',mm);addEventListener('pointerup',mu);
        });
      };
      track(pn.el.querySelector('.it-cgrab'),(r0,dx,dy)=>{pn.crect={...pn.crect,x:clampN(r0.x+dx,-.4,1),y:clampN(r0.y+dy,-.4,1)}},true);
      track(pn.el.querySelector('.it-cgrip'),(r0,dx,dy,g)=>{const mw=220/g.width,mh=150/g.height;pn.crect={...pn.crect,w:clampN(r0.w+dx,mw,2),h:clampN(r0.h+dy,mh,2)}},true);
    }
    // snap a dragged pane's edges to nearby neighbours / the space border (within ~1.4%)
    function snapPane(w,pn){
      const T=.014,r=pn.crect,edgesX=[0,1],edgesY=[0,1];
      leaves(w.layout).forEach(l=>{if(l.pane===pn||!l.pane.crect)return;const o=l.pane.crect;edgesX.push(o.x,o.x+o.w);edgesY.push(o.y,o.y+o.h)});
      const near=(v,arr)=>{let b=null,bd=T;arr.forEach(e=>{const d=Math.abs(v-e);if(d<bd){bd=d;b=e}});return b};
      const l=near(r.x,edgesX),rt=near(r.x+r.w,edgesX),t=near(r.y,edgesY),b=near(r.y+r.h,edgesY);
      if(l!=null)r.x=l;else if(rt!=null)r.x=rt-r.w;
      if(t!=null)r.y=t;else if(b!=null)r.y=b-r.h;
    }
    function canvasZoomBy(f,cx,cy){
      const w=wsCur();if(!w||!w.canvasOn)return;
      const g=w.grid.getBoundingClientRect();if(cx==null){cx=g.width/2;cy=g.height/2}
      const z0=w.canvasZoom||1,z=clampN(z0*f,CZMIN,CZMAX),p=w.canvasPan||{x:0,y:0};
      // keep the point under the cursor fixed while zooming
      w.canvasPan={x:cx-(cx-p.x)*(z/z0),y:cy-(cy-p.y)*(z/z0)};
      w.canvasZoom=z;applyCanvasXform(w);saveState();
    }
    function canvasZoomReset(){const w=wsCur();if(!w)return;w.canvasZoom=1;w.canvasPan={x:0,y:0};applyCanvasXform(w);saveState()}
    function canvasBBox(w){
      const ls=leaves(w.layout);if(!ls.length)return null;
      let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
      ls.forEach(l=>{const r=l.pane.crect||defaultRect(0);x0=Math.min(x0,r.x);y0=Math.min(y0,r.y);x1=Math.max(x1,r.x+r.w);y1=Math.max(y1,r.y+r.h)});
      return{x0,y0,x1,y1};
    }
    function canvasOverview(){
      const w=wsCur();if(!w||!w.canvasOn)return;
      const g=w.grid.getBoundingClientRect(),bb=canvasBBox(w);if(!bb)return;
      const bw=(bb.x1-bb.x0)*g.width,bh=(bb.y1-bb.y0)*g.height;
      const z=clampN(Math.min(g.width/(bw||1),g.height/(bh||1))*.88,CZMIN,CZMAX);
      const cwx=(bb.x0+bb.x1)/2*g.width,cwy=(bb.y0+bb.y1)/2*g.height;
      w.canvasZoom=z;w.canvasPan={x:g.width/2-cwx*z,y:g.height/2-cwy*z};applyCanvasXform(w);saveState();
    }
    function canvasReveal(){
      const w=wsCur(),fp=paneCur();if(!w||!w.canvasOn||!fp||!fp.crect)return;
      const g=w.grid.getBoundingClientRect(),z=Math.max(w.canvasZoom||1,1),r=fp.crect;
      const cwx=(r.x+r.w/2)*g.width,cwy=(r.y+r.h/2)*g.height;
      w.canvasZoom=z;w.canvasPan={x:g.width/2-cwx*z,y:g.height/2-cwy*z};applyCanvasXform(w);saveState();
    }
    function toggleCanvas(){
      const w=wsCur();if(!w)return;
      w.canvasOn=!w.canvasOn;
      if(w.canvasOn&&w.canvasZoom==null){w.canvasZoom=1;w.canvasPan={x:0,y:0}}
      renderGrid(w);renderAll();saveState();
      Toast.show(w.canvasOn?'Canvas — drag bars to move, corner to resize · scroll to pan, ⌘-scroll to zoom · ⌃⌘O fits all':'Tiled splits restored');
    }
    function tidyCanvas(){ // ⌃⌘T — pack the floating panes back into a regular grid (16px-ish gap)
      const w=wsCur();if(!w||!w.canvasOn||!w.layout)return;
      const ls=leaves(w.layout),n=ls.length,cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols),gap=.012;
      ls.forEach((l,i)=>{const c=i%cols,r=Math.floor(i/cols);
        l.pane.crect={x:gap+c*(1-gap)/cols,y:gap+r*(1-gap)/rows,w:(1-gap)/cols-gap,h:(1-gap)/rows-gap};
        placeCanvasPane(w,l.pane)});
      w.canvasZoom=1;w.canvasPan={x:0,y:0};applyCanvasXform(w);saveState();
    }

    // ---- workspace sidebar + selection ----
    function selectWs(i){
      wsActive=Math.max(0,Math.min(i,workspaces.length-1));
      const w=wsCur();if(w&&!w.grid)mountWs(w); // lazily restored workspaces spawn their shells on first visit
      showWs();renderAll();markHere();saveState();
    }
    function showWs(){workspaces.forEach((w,i)=>{if(w.grid)w.grid.classList.toggle('on',i===wsActive)})}
    function closeWorkspace(w){
      (w.panes||[]).forEach(pn=>{pn.surfaces.forEach(t=>disposeSurf(t,true));pn.surfaces=[]}); // closing a workspace reaps its shells
      try{w.grid&&w.grid.remove()}catch(_){}
      const i=workspaces.indexOf(w);if(i>=0)workspaces.splice(i,1);
      pruneGroups(); // closing the last member of a group takes the group with it
      if(!workspaces.length){newWorkspace(homeAbs);return}
      selectWs(Math.min(i,workspaces.length-1));
    }
    // workspace colors — 16 named (cmux's list), shown as the row's left rail; the dot cycles them
    const WS_COLORS=[['red','#e0564f'],['crimson','#c62f52'],['orange','#e2803a'],['amber','#d9a621'],['olive','#9aa337'],['green','#3fae5d'],['teal','#2fa38c'],['aqua','#3fb6c9'],['blue','#4f8fe0'],['navy','#4560b8'],['indigo','#6a5fd6'],['purple','#8e4fd0'],['magenta','#c34fc0'],['rose','#d66a95'],['brown','#a1704a'],['charcoal','#6d7680']];
    function setWsColor(w,v){ // name · #hex · '' / none
      const s=String(v||'').trim().toLowerCase();
      if(!s||s==='none')w.color='';
      else if(/^#[0-9a-f]{3,8}$/.test(s))w.color=s;
      else{const c=WS_COLORS.find(x=>x[0]===s);if(!c)return false;w.color=c[1]}
      schedule();saveState();return true;
    }
    function cycleWsColor(w,back){
      const i=WS_COLORS.findIndex(x=>x[1]===w.color);
      const n=back?(i<0?WS_COLORS.length-1:i-1):(i+1);
      w.color=(n<0||n>=WS_COLORS.length)?'':WS_COLORS[n][1];
      schedule();saveState();
    }
    // ---- workspace groups (cmux): collapsible sections in the sidebar ----
    function groupOf(w){return w&&w.group?wsGroups.find(g=>g.id===w.group):null}
    function newGroup(){
      const w=wsCur();
      if(!w)return; // a group is a container FOR something — there is nothing to group
      const g={id:'g'+(++grpSeq),name:'Group '+(wsGroups.length+1),color:w.color,collapsed:false};
      wsGroups.push(g);w.group=g.id;
      schedule();saveState();
      textPrompt('Name the group',g.name,v=>{g.name=v.slice(0,32);schedule();saveState()});
    }
    function toggleGroupCollapsed(gid){const g=wsGroups.find(x=>x.id===gid)||groupOf(wsCur());if(!g)return;g.collapsed=!g.collapsed;schedule();saveState()}
    // A group with nothing left in it is a leftover, not a container: the moment its last
    // workspace leaves or closes, the header goes with it. Without this, dragging the last
    // member out (or closing it) left an empty header sitting in the sidebar forever.
    function pruneGroups(){
      const used=new Set(workspaces.map(w=>w.group).filter(Boolean));
      const n=wsGroups.length;
      wsGroups=wsGroups.filter(g=>used.has(g.id));
      return wsGroups.length!==n;
    }
    // Ungroup: the container goes, its workspaces stay (and leave the group, obviously).
    function dissolveGroup(gid){workspaces.forEach(w=>{if(w.group===gid)w.group=null});wsGroups=wsGroups.filter(g=>g.id!==gid);schedule();saveState()}
    // Close group: the container goes AND what is inside it goes with it. Deleting a folder
    // that leaves its files behind is not what deleting means (owner's rule, 2026-07-25).
    function closeGroup(gid){
      if(!wsGroups.some(g=>g.id===gid))return;
      workspaces.filter(w=>w.group===gid).slice().forEach(closeWorkspace);
      wsGroups=wsGroups.filter(g=>g.id!==gid);
      schedule();saveState();
    }
    function moveWsToGroup(w,gid){if(!w)return;w.group=gid||null;pruneGroups();schedule();saveState()}
    // ---- workspace order (cmux): drag rows to reorder / into groups; menu Move Up/Down/Top.
    // wsActive is an INDEX, so every splice recomputes it from the selected OBJECT.
    function reorderWs(from,to,gid){
      if(from<0||from>=workspaces.length)return;
      const cur=wsCur();
      const [w]=workspaces.splice(from,1);
      if(gid!==undefined)w.group=gid||null;
      workspaces.splice(Math.max(0,Math.min(to,workspaces.length)),0,w);
      wsActive=Math.max(0,workspaces.indexOf(cur));
      pruneGroups(); // dragging the last member out empties its group — the header goes too
      schedule();saveState();
    }
    // Siblings = workspaces sharing the row's list partition (same group, or ungrouped).
    function wsSiblings(w){const g=w.group||null;return workspaces.map((x,i)=>({x,i})).filter(e=>(e.x.group||null)===g)}
    function moveWsBy(w,dir){ // -1 = up · +1 = down · 0 = top of its partition
      const sib=wsSiblings(w),pos=sib.findIndex(e=>e.x===w);if(pos<0)return;
      const tgt=dir===0?sib[0]:sib[pos+dir];
      if(!tgt||tgt.x===w)return;
      const cur=wsCur();
      workspaces.splice(workspaces.indexOf(w),1);
      const ti=workspaces.indexOf(tgt.x);
      workspaces.splice(dir>0?ti+1:ti,0,w);
      wsActive=Math.max(0,workspaces.indexOf(cur));
      schedule();saveState();
    }
    // ---- right-click menus (cmux): one tiny builder, positioned inside the panel ----
    let ctxEl=null;
    function closeCtx(){if(ctxEl){ctxEl.remove();ctxEl=null}}
    function ctxMenu(x,y,items){
      closeCtx();
      const el=document.createElement('div');el.className='it-ctx';
      el.innerHTML=items.map(it=>it?`<button ${it.disabled?'disabled':''}class="${it.danger?'danger':''}">${escHtml(it.label)}${it.key?`<span class="k">${escHtml(it.key)}</span>`:''}</button>`:'<div class="dv"></div>').join('');
      p.appendChild(el);ctxEl=el;
      const bs=el.querySelectorAll('button');
      items.filter(Boolean).forEach((it,i)=>bs[i].addEventListener('click',()=>{closeCtx();if(!it.disabled&&it.fn)it.fn()}));
      const pr=p.getBoundingClientRect(),w=el.offsetWidth,h=el.offsetHeight;
      let L=x-pr.left,T=y-pr.top;
      if(L+w>pr.width-8)L=pr.width-w-8;if(T+h>pr.height-8)T=pr.height-h-8;
      el.style.left=Math.max(4,L)+'px';el.style.top=Math.max(4,T)+'px';
    }
    function wsCtxItems(w){
      const sib=wsSiblings(w),pos=sib.findIndex(e=>e.x===w);
      const groups=wsGroups.map(g=>({label:'Move to '+g.name,disabled:w.group===g.id,fn:()=>moveWsToGroup(w,g.id)}));
      return [
        {label:'Rename Workspace…',key:'⌘⇧R',fn:()=>renameWs(w)},
        {label:'Cycle Color',fn:()=>cycleWsColor(w)},
        ...(w.color?[{label:'Clear Color',fn:()=>setWsColor(w,'none')}]:[]),
        null,
        {label:'New Group from Workspace',key:'⌃⌘G',fn:()=>{selectWs(workspaces.indexOf(w));newGroup()}},
        ...groups,
        ...(w.group?[{label:'Remove from Group',fn:()=>moveWsToGroup(w,null)}]:[]),
        null,
        {label:'Move Up',disabled:pos<=0,fn:()=>moveWsBy(w,-1)},
        {label:'Move Down',disabled:pos<0||pos>=sib.length-1,fn:()=>moveWsBy(w,+1)},
        {label:'Move to Top',disabled:pos<=0,fn:()=>moveWsBy(w,0)},
        null,
        {label:'Close Workspace',danger:true,fn:()=>closeWorkspace(w)},
        {label:'Close Other Workspaces',danger:true,disabled:workspaces.length<2,fn:()=>{workspaces.filter(x=>x!==w).slice().forEach(closeWorkspace)}},
      ];
    }
    function grpCtxItems(g){
      return [
        {label:'Rename Group…',fn:()=>textPrompt('Rename group',g.name,v=>{g.name=v.slice(0,32);schedule();saveState()})},
        {label:'Cycle Color',fn:()=>{const i=WS_COLORS.findIndex(c=>c[1]===g.color);g.color=WS_COLORS[(i+1)%WS_COLORS.length][1];schedule();saveState()}},
        ...(g.color?[{label:'Clear Color',fn:()=>{g.color='';schedule();saveState()}}]:[]),
        {label:g.collapsed?'Expand':'Collapse',fn:()=>toggleGroupCollapsed(g.id)},
        null,
        // Two different things, named for what they do: one keeps the workspaces, the
        // other takes them with it. The ✕ on the header is the second one.
        {label:'Ungroup — keep the workspaces',fn:()=>dissolveGroup(g.id)},
        {label:'Close Group and its Workspaces',danger:true,fn:()=>closeGroup(g.id)},
      ];
    }
    function tabCtxItems(pn,ti){
      const t=pn.surfaces[ti];if(!t)return[];
      const pick=()=>{pn.w.focus=pn.id;pn.active=ti;syncPanes();schedule()};
      return [
        {label:'Rename Tab…',key:'⌘R',fn:()=>{pick();renameTab()}},
        {label:'Break into Pane',fn:()=>{pick();breakPane()}},
        {label:'Send to Frame Square',fn:()=>popSurf(pn,ti)},
        ...(t.dead&&(t.host||t.sess)?[{label:'Reconnect',fn:()=>reconnectSurface(t)}]:[]),
        null,
        {label:'Close Tab',key:'⌘W',danger:true,fn:()=>closeSurface(pn,ti)},
        {label:'Close Other Tabs',danger:true,disabled:pn.surfaces.length<2,fn:()=>{for(let i=pn.surfaces.length-1;i>=0;i--)if(pn.surfaces[i]!==t)closeSurface(pn,i)}},
      ];
    }
    function wsRowHTML(w,i,inGroup){
      const un=(w.panes||[]).some(pn=>pn.surfaces.some(t=>t.unread));
      const git=w.git&&w.git.branch?`<span class="br">⎇ ${escHtml(w.git.branch)}${w.git.dirty?'*':''}</span>`:'';
      const st=Object.entries(w.status||{}).sort((a,b)=>((b[1].priority||0)-(a[1].priority||0)));
      const pills=st.length?`<span class="it-wspills">${st.map(([k,s])=>`<span class="it-pill" style="--pc:${escAttr(s.color||'#5aa0e6')}" title="${escAttr(k)}">${s.icon?escAttr(s.icon)+' ':''}${escAttr(s.value)}</span>`).join('')}</span>`:'';
      const prog=w.progress?`<span class="it-wsprog"><i style="width:${Math.round(Math.max(0,Math.min(1,w.progress.v))*100)}%"></i>${w.progress.label?`<span>${escHtml(w.progress.label)}</span>`:''}</span>`:'';
      return `<div class="it-wsrow ${i===wsActive?'on':''}${w.color?' tinted':''}${inGroup?' grp':''}" data-w="${i}" draggable="true" title="${escAttr(w.cwd)}"${w.color?` style="--wsc:${escAttr(w.color)}"`:''}><span class="nm"><span class="it-wsdot" data-cdot="${i}" title="Workspace color — click cycles · ⌥-click clears"${w.color?` style="--wsc:${escAttr(w.color)}"`:''}></span>${un?'<span class="it-ud"></span>':''}<span style="overflow:hidden;text-overflow:ellipsis">${escAttr(wsLabel(w))}</span><span class="x" data-cw="${i}" title="Close workspace">✕</span></span><span class="meta">${git}<span class="pth">${escAttr(contract(w.cwd))}</span></span>${pills}${prog}</div>`;
    }
    function renderWs(){
      const idx=workspaces.map((w,i)=>({w,i}));
      const inG=id=>idx.filter(x=>x.w.group===id);
      const validGid=new Set(wsGroups.map(g=>g.id));
      let rows='';
      wsGroups.forEach(g=>{
        const items=inG(g.id);
        rows+=`<div class="it-grphd${g.collapsed?' col':''}" data-g="${escAttr(g.id)}"${g.color?` style="--gc:${escAttr(g.color)}"`:''}><span class="chev">${g.collapsed?'▸':'▾'}</span><span class="gdot" data-gdot="${escAttr(g.id)}" title="Group color"></span><span class="gnm">${escAttr(g.name)}</span><span class="gct">${items.length}</span><span class="gx" data-gx="${escAttr(g.id)}" title="Close this group and the ${items.length} workspace${items.length===1?'':'s'} in it — right-click for Ungroup">✕</span></div>`;
        if(!g.collapsed)rows+=items.map(x=>wsRowHTML(x.w,x.i,true)).join('');
      });
      rows+=idx.filter(x=>!x.w.group||!validGid.has(x.w.group)).map(x=>wsRowHTML(x.w,x.i,false)).join('');
      wsEl.innerHTML=`<div class="it-wshd"><b>iT</b><span class="it-wsbtns"><button data-act="nw" title="New workspace (⌘N)">＋</button><button data-act="grp" title="Group current workspace (⌃⌘G)">▤▾</button><button data-act="win" title="New iT window — work side by side">⧉</button><button data-act="tree" title="Show / hide files (⌥⌘B)">▤</button><button data-act="help" title="Keyboard & help">?</button></span></div><div class="it-wslist">${rows}</div><div class="it-wsfoot">CMUX-COMPATIBLE KEYS · ⌘⇧P</div>`;
      wsEl.querySelectorAll('.it-wsrow').forEach(r=>{
        r.addEventListener('click',e=>{if(e.target.dataset.cw!=null||e.target.dataset.cdot!=null)return;selectWs(+r.dataset.w)});
        r.addEventListener('dblclick',()=>{selectWs(+r.dataset.w);renameWs()});
        r.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();const w=workspaces[+r.dataset.w];if(w)ctxMenu(e.clientX,e.clientY,wsCtxItems(w))});
        // drag to reorder / drop INTO a group: dropping on a row lands BEFORE it and
        // adopts its group; dropping on a group header appends to that group.
        r.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/it-ws',r.dataset.w);e.dataTransfer.effectAllowed='move';r.classList.add('dragging')});
        r.addEventListener('dragend',()=>{r.classList.remove('dragging');wsEl.querySelectorAll('.dropb,.dropin').forEach(x=>x.classList.remove('dropb','dropin'))});
        r.addEventListener('dragover',e=>{if(![...e.dataTransfer.types].includes('text/it-ws'))return;e.preventDefault();e.dataTransfer.dropEffect='move';r.classList.add('dropb')});
        r.addEventListener('dragleave',()=>r.classList.remove('dropb'));
        r.addEventListener('drop',e=>{
          const from=+e.dataTransfer.getData('text/it-ws');if(isNaN(from))return;
          e.preventDefault();r.classList.remove('dropb');
          const tgt=workspaces[+r.dataset.w];if(!tgt||workspaces[from]===tgt)return;
          let to=workspaces.indexOf(tgt);if(from<to)to--;    // index shifts after removal
          reorderWs(from,to,tgt.group||null);
        });
      });
      wsEl.querySelectorAll('[data-cw]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const w=workspaces[+b.dataset.cw];if(w)closeWorkspace(w)}));
      wsEl.querySelectorAll('[data-cdot]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const w=workspaces[+b.dataset.cdot];if(!w)return;if(e.altKey)setWsColor(w,'none');else cycleWsColor(w,e.shiftKey)}));
      wsEl.querySelectorAll('.it-grphd').forEach(h=>{
        h.addEventListener('click',e=>{if(e.target.dataset.gx!=null||e.target.dataset.gdot!=null)return;toggleGroupCollapsed(h.dataset.g)});
        h.addEventListener('dblclick',()=>{const g=wsGroups.find(x=>x.id===h.dataset.g);if(g)textPrompt('Rename group',g.name,v=>{g.name=v.slice(0,32);schedule();saveState()})});
        h.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();const g=wsGroups.find(x=>x.id===h.dataset.g);if(g)ctxMenu(e.clientX,e.clientY,grpCtxItems(g))});
        h.addEventListener('dragover',e=>{if(![...e.dataTransfer.types].includes('text/it-ws'))return;e.preventDefault();e.dataTransfer.dropEffect='move';h.classList.add('dropin')});
        h.addEventListener('dragleave',()=>h.classList.remove('dropin'));
        h.addEventListener('drop',e=>{
          const from=+e.dataTransfer.getData('text/it-ws');if(isNaN(from))return;
          e.preventDefault();h.classList.remove('dropin');
          const g=wsGroups.find(x=>x.id===h.dataset.g),w=workspaces[from];if(!g||!w)return;
          if(g.collapsed)g.collapsed=false;              // show where it landed
          moveWsToGroup(w,g.id);
        });
      });
      wsEl.querySelectorAll('[data-gx]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();closeGroup(b.dataset.gx)}));
      wsEl.querySelectorAll('[data-gdot]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const g=wsGroups.find(x=>x.id===b.dataset.gdot);if(!g)return;const i=WS_COLORS.findIndex(c=>c[1]===g.color);g.color=e.altKey?'':(WS_COLORS[(i+1)%WS_COLORS.length][1]);schedule();saveState()}));
      // Dropping anywhere in the list that is NOT a row or a group header = leave the
      // group and go to the end. This used to require hitting the list element itself —
      // one bare pixel below the last row, which a full sidebar simply does not have, so
      // dragging a workspace OUT of a group was impossible whenever the list was full.
      const list=wsEl.querySelector('.it-wslist');
      if(list){
        const free=e=>!(e.target&&e.target.closest&&e.target.closest('.it-wsrow,.it-grphd'));
        list.addEventListener('dragover',e=>{if(!free(e)||![...e.dataTransfer.types].includes('text/it-ws'))return;e.preventDefault();e.dataTransfer.dropEffect='move';list.classList.add('dropout')});
        list.addEventListener('dragleave',e=>{if(e.target===list||free(e))list.classList.remove('dropout')});
        list.addEventListener('drop',e=>{
          if(!free(e))return;
          const from=+e.dataTransfer.getData('text/it-ws');if(isNaN(from))return;
          e.preventDefault();list.classList.remove('dropout');
          reorderWs(from,workspaces.length,null);
        });
      }
      const act=(k,fn)=>{const b=wsEl.querySelector('[data-act="'+k+'"]');if(b)b.addEventListener('click',fn)};
      act('nw',()=>newWorkspace(homeAbs));
      act('grp',newGroup);
      act('win',()=>openPanel('shell',{newInstance:true}));
      act('tree',toggleTree);
      act('help',helpOverlay);
    }
    function renderPaneTabs(pn){
      pn.strip.innerHTML=pn.surfaces.map((t,i)=>`<div class="sh-tab ${i===pn.active?'on':''}" data-ti="${i}" title="${escAttr(t.cwd)}"><span class="sh-dot ${t.dead?'dead':(t.busy?'busy':'')}${t.kind==='tty'?' live':''}"></span>${t.unread?'<span class="it-ud"></span>':''}${escAttr(tabLabel(t))}${(t.dead&&(t.host||t.sess))?`<span class="sh-trecon" data-recon="${i}" title="Reconnect">↻</span>`:''}<span class="sh-tpop" data-pop="${i}" title="Send this terminal to a frame square">⤢</span><span class="sh-tclose" data-close="${i}" title="Close tab">✕</span></div>`).join('')
        +`<button class="sh-newtab" data-act="new" title="New tab (⌘T) · ⌥-click: smart shell">＋</button><button class="sh-treetog" data-act="tmux" title="Attach a tmux session">⌗</button><button class="sh-treetog" data-act="host" title="Remote hosts (SSH)">⚡</button><button class="sh-treetog" data-act="sess" title="Persistent sessions (survive disconnect)">⟳</button><span class="sh-tspacer"></span><button class="sh-treetog" data-act="omz" title="Prompt theme (smart tabs · Oh My Zsh): ${escAttr(omzTheme)}">◈</button><button class="sh-treetog" data-act="sr" title="Split right (⌘D)">◫</button><button class="sh-treetog" data-act="sd" title="Split down (⌘⇧D)">⊟</button><button class="sh-treetog" data-act="pc" title="Close pane">✕</button>`;
      pn.strip.querySelectorAll('.sh-tab').forEach(el=>{
        el.addEventListener('click',e=>{if(e.target.dataset.close!=null||e.target.dataset.pop!=null||e.target.dataset.recon!=null)return;pn.w.focus=pn.id;pn.active=+el.dataset.ti;syncPanes();schedule();markHere()});
        el.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();ctxMenu(e.clientX,e.clientY,tabCtxItems(pn,+el.dataset.ti))});
      });
      pn.strip.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();closeSurface(pn,+b.dataset.close)}));
      pn.strip.querySelectorAll('[data-pop]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();popSurf(pn,+b.dataset.pop)}));
      pn.strip.querySelectorAll('[data-recon]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();reconnectSurface(pn.surfaces[+b.dataset.recon])}));
      const act=(k,fn)=>{const b=pn.strip.querySelector('[data-act="'+k+'"]');if(b)b.addEventListener('click',fn)};
      act('new',e=>{pn.w.focus=pn.id;newSurface(pn,(pn.surfaces[pn.active]||{}).cwd||pn.w.cwd,e.altKey?'smart':undefined)});
      act('tmux',e=>{e.stopPropagation();pn.w.focus=pn.id;tmuxMenu(e.currentTarget)});
      act('host',e=>{e.stopPropagation();pn.w.focus=pn.id;hostMenu(e.currentTarget)});
      act('sess',e=>{e.stopPropagation();pn.w.focus=pn.id;sessMenu(e.currentTarget)});
      act('omz',cycleOmz);
      act('sr',()=>{pn.w.focus=pn.id;splitPane(pn,'h')});
      act('sd',()=>{pn.w.focus=pn.id;splitPane(pn,'v')});
      act('pc',()=>closePane(pn));
    }
    let schedT=0; // coalesced re-render — a timer, NOT rAF: rAF stalls in hidden/throttled windows
    function schedule(){if(schedT)return;schedT=setTimeout(()=>{schedT=0;const w=wsCur();if(w)w.panes.forEach(renderPaneTabs);renderWs()},16)}
    const renderTabs=schedule; // legacy name — the smart-shell machinery calls this
    function syncFocus(){
      const w=wsCur();if(!w)return;const fp=paneCur();
      w.panes.forEach(pn=>{pn.el.classList.toggle('focus',pn===fp&&w.panes.length>1);if(pn===fp)pn.el.classList.remove('fired')});
    }
    // The pane whose terminal/agent spoke LAST while unfocused wears a quiet accent
    // ring (.fired) — cmux's "who just answered" cue. Exactly one pane wears it;
    // focusing that pane takes it off (syncFocus).
    function markFired(t){
      const pn=t&&t.pn;if(!pn||!pn.el||!pn.el.isConnected)return;
      if(pn===paneCur()&&document.hasFocus())return;
      if(pn.el.classList.contains('fired'))return;
      pn.w.panes.forEach(x=>{if(x.el)x.el.classList.remove('fired')});
      pn.el.classList.add('fired');
    }
    function syncPanes(){
      const w=wsCur();if(!w)return;
      w.panes.forEach(pn=>{
        const at=pn.surfaces[pn.active];
        pn.surfaces.forEach(x=>{if(x.pane)x.pane.classList.toggle('on',x===at)});
        if(at&&surfVisible(at))at.unread=0;
      });
      syncFocus();
      const t=activeTab();if(!t)return;
      if(t.kind==='tty'){if(t.termApi)setTimeout(()=>t.termApi.focus(),10)}
      else if(t.kind==='web'){if(t.el&&t.el.in&&!t.url)setTimeout(()=>{try{t.el.in.focus()}catch(_){}},10)}
      else if(t.kind==='diff'){if(t.refreshDiff)t.refreshDiff(true)} // refresh quietly on every visit
      else if(t.kind==='code'){/* the tree + editor manage their own focus */}
      else{updatePrompt(t);if(t.el){t.el.out.scrollTop=t.el.out.scrollHeight;setTimeout(()=>t.el.in.focus(),10)}}
    }
    function renderAll(){schedule();syncPanes();markHere()}

    // ---- workspace helpers: rename · unread · zoom · direction focus · git chip ----
    function textPrompt(title,initial,cb){
      closeOverlays();
      const ov=document.createElement('div');ov.className='it-palette';
      ov.innerHTML='<div class="it-palbox"><div class="hd">'+escHtml(title).toUpperCase()+'</div><input class="it-palin" spellcheck="false"></div>';
      p.appendChild(ov);const inp=ov.querySelector('input');inp.value=initial||'';inp.focus();inp.select();
      const done=ok=>{const v=inp.value.trim();ov.remove();if(ok&&v)cb(v)};
      inp.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();done(true)}else if(e.key==='Escape'){e.preventDefault();done(false)}});
      ov.addEventListener('pointerdown',e=>{if(e.target===ov)done(false)});
    }
    // One rename for both entry points (⌘⇧R and the row's menu) so they cannot drift apart.
    // schedule() re-renders the pane tabs as well as the sidebar, which is how the new name
    // reaches the tabs (see tabLabel).
    function renameWs(w){w=w||wsCur();if(!w)return;textPrompt('Rename workspace',wsLabel(w),v=>{w.name=v.slice(0,40);schedule();saveState()})}
    function renameTab(){const t=activeTab();if(!t)return;textPrompt('Rename tab',tabLabel(t),v=>{t.ptitle=v.slice(0,40);t.named=true;schedule();saveState()})}
    function cycleSurf(d){const pn=paneCur();if(!pn||pn.surfaces.length<2)return;pn.active=(pn.active+d+pn.surfaces.length)%pn.surfaces.length;syncPanes();schedule();markHere()}
    function toggleZoom(){const pn=paneCur();if(!pn)return;pn.zoom=!pn.zoom;pn.el.classList.toggle('zoom',pn.zoom);if(pn.w.canvasOn)renderGrid(pn.w)}
    function equalize(){const w=wsCur();if(!w)return;(function walk(n){if(!n||!n.sp)return;n.ratio=.5;walk(n.a);walk(n.b)})(w.layout);renderGrid(w)}
    function focusDir(dir){
      const w=wsCur(),fp=paneCur();if(!w||!fp||w.panes.length<2)return;
      const r0=fp.el.getBoundingClientRect(),cx=r0.left+r0.width/2,cy=r0.top+r0.height/2;
      let best=null,bd=1e9;
      w.panes.forEach(pn=>{if(pn===fp)return;const r=pn.el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
        const ok=dir==='left'?x<cx-4:dir==='right'?x>cx+4:dir==='up'?y<cy-4:y>cy+4;if(!ok)return;
        const d=Math.abs(x-cx)+Math.abs(y-cy);if(d<bd){bd=d;best=pn}});
      if(best){w.focus=best.id;syncPanes();schedule()}
    }
    function jumpUnread(){
      let best=null,bs=0;
      workspaces.forEach((w,wi)=>(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{if(t.unread>bs){bs=t.unread;best={wi,pn,t}}})));
      if(!best){Toast.show('No unread terminals');return}
      wsActive=best.wi;const w=wsCur();if(!w.grid)mountWs(w);showWs();
      w.focus=best.pn.id;best.pn.active=best.pn.surfaces.indexOf(best.t);
      syncPanes();schedule();markHere();
    }
    function markAllRead(){workspaces.forEach(w=>(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{t.unread=0})));schedule()}
    function clearTerm(){const t=activeTab();if(!t)return;if(t.kind==='tty'){try{t.termApi&&t.termApi.send('\f')}catch(_){}}else{t.out='';if(t.el)t.el.out.innerHTML=''}}
    function cycleOmz(){omzTheme=OMZ_THEMES[(OMZ_THEMES.indexOf(omzTheme)+1)%OMZ_THEMES.length];localStorage.setItem('cfhub.shell.omz',omzTheme);Toast.show('Prompt theme: '+omzTheme);renderAll()}
    function toggleLeft(){leftHidden=!leftHidden;wsEl.classList.toggle('hidden',leftHidden);saveState()}
    function toggleTree(){treeHidden=!treeHidden;treeEl.classList.toggle('hidden',treeHidden);const sp=p.querySelector('#shsplit');if(sp)sp.style.display=treeHidden?'none':'';if(!treeHidden)renderTree();saveState()}
    const refreshWsGit=(()=>{const tm=new Map();return w=>{clearTimeout(tm.get(w));tm.set(w,setTimeout(async()=>{
      try{w.git=await gitInfo(w.cwd)}catch(_){w.git=null}
      // auto-naming (Phase 3.1): an unnamed workspace takes its git repo's name — deterministic,
      // no LLM involved (BYOK invariant); a manual rename sets w.name and pins the label for good
      if(!w.git)w.autoName='';
      else if(!w.name&&localStorage.getItem('cfhub.it.autoname')!=='0'){
        try{let o='';await Bridge.shell('git -C '+qpath(w.cwd)+' rev-parse --show-toplevel 2>/dev/null',x=>{o+=x});
          const nm=base(o.trim().split('\n').pop().trim());if(nm)w.autoName=nm;}catch(_){}
      }
      schedule()},350))}})();

    // ---- notifications (Phase 3) — OSC 9/777 from terminals + `it notify`; ⌘I opens the list ----
    const itNotes=[];let noteSeq=0;
    function noteAdd(t,title,body,opts){
      title=String(title||'').slice(0,120);body=String(body||'').slice(0,300);
      if(!title&&!body)return;
      const w=t&&t.pn?t.pn.w:null;
      itNotes.unshift({id:++noteSeq,ts:Date.now(),ws:w?wsLabel(w):'',surf:t?t.id:null,title:title||body,body:title?body:''});
      if(itNotes.length>100)itNotes.length=100;
      const hidden=!t||!surfVisible(t);
      if(t&&hidden)t.unread=++unreadStamp;
      if(hidden||(opts&&opts.toast))Toast.show(((w&&hidden)?wsLabel(w)+' · ':'')+(title||body).slice(0,90));
      schedule();
    }
    function notesOverlay(){
      closeOverlays();
      const ov=document.createElement('div');ov.className='it-palette';
      const rows=itNotes.length
        ?itNotes.map((n,i)=>`<div class="it-palrow" data-n="${i}"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${escHtml(n.title)}${n.body?' <span class="k">'+escHtml(n.body.slice(0,60))+'</span>':''}</span><span class="k">${escHtml(n.ws)}</span></div>`).join('')
        :'<div class="it-palrow none">no notifications yet — agents and 15s+ commands land here</div>';
      ov.innerHTML='<div class="it-palbox"><div class="hd">NOTIFICATIONS · ⌘I</div><div class="it-pallist">'+rows+'</div></div>';
      p.appendChild(ov);
      ov.querySelectorAll('[data-n]').forEach(r=>r.addEventListener('click',()=>{
        const n=itNotes[+r.dataset.n];ov.remove();if(!n||!n.surf)return;
        const t=surfById(n.surf);if(!t)return;
        const w=t.pn.w,wi=workspaces.indexOf(w);if(wi<0)return;
        wsActive=wi;if(!w.grid)mountWs(w);showWs();
        w.focus=t.pn.id;t.pn.active=t.pn.surfaces.indexOf(t);
        syncPanes();schedule();markHere();
      }));
      ov.addEventListener('pointerdown',e=>{if(e.target===ov)ov.remove()});
      ov.tabIndex=-1;ov.focus();
      ov.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')ov.remove()});
    }
    // ⌘⇧L (cmux): split right with a BROWSER surface — page and terminal side by side
    function newBrowserSplit(){const pn=paneCur();if(pn)splitPane(pn,'h',false,'web')}
    // ⌃⌘⇧D (cmux): split right with a DIFF surface at the current folder
    function openDiffSplit(){const pn=paneCur();if(pn)splitPane(pn,'h',false,'diff')}

    // ---- command palette (⌘⇧P) — the cmux command names work here ----
    function commandList(){
      const K=keyLabel; // live combos — a rebind shows up here instantly
      return [
        ['new-workspace',K('new-workspace'),()=>newWorkspace(homeAbs)],
        ['close-workspace','',()=>{const w=wsCur();if(w)closeWorkspace(w)}],
        ['rename-workspace',K('rename-workspace'),renameWs],
        ['go-to-workspace',K('go-to-workspace'),wsPicker],
        ['next-workspace','',()=>selectWs((wsActive+1)%workspaces.length)],
        ['previous-workspace','',()=>selectWs((wsActive-1+workspaces.length)%workspaces.length)],
        ['workspace-color','◐',()=>{const w=wsCur();if(w)cycleWsColor(w)}],
        ['new-surface',K('new-surface'),()=>{const pn=paneCur();if(pn)newSurface(pn,curCwd())}],
        ['new-smart-shell','⌥＋',()=>{const pn=paneCur();if(pn)newSurface(pn,curCwd(),'smart')}],
        ['close-surface','',()=>{const pn=paneCur();if(pn)closeSurface(pn,pn.active)}],
        ['rename-tab',K('rename-tab'),renameTab],
        ['next-tab',K('next-tab'),()=>cycleSurf(1)],
        ['previous-tab',K('previous-tab'),()=>cycleSurf(-1)],
        ['split-right',K('split-right'),()=>{const pn=paneCur();if(pn)splitPane(pn,'h')}],
        ['split-down',K('split-down'),()=>{const pn=paneCur();if(pn)splitPane(pn,'v')}],
        ['close-pane','',()=>{const pn=paneCur();if(pn)closePane(pn)}],
        ['focus-left',K('focus-left'),()=>focusDir('left')],
        ['focus-right',K('focus-right'),()=>focusDir('right')],
        ['focus-up',K('focus-up'),()=>focusDir('up')],
        ['focus-down',K('focus-down'),()=>focusDir('down')],
        ['toggle-split-zoom',K('toggle-split-zoom'),toggleZoom],
        ['equalize-splits',K('equalize-splits'),equalize],
        ['break-pane',K('break-pane'),breakPane],
        ['move-surface-left',K('move-surface-left'),()=>moveSurfaceDir('left')],
        ['move-surface-right',K('move-surface-right'),()=>moveSurfaceDir('right')],
        ['toggle-canvas',K('toggle-canvas'),toggleCanvas],
        ['tidy-canvas',K('tidy-canvas'),tidyCanvas],
        ['canvas-overview',K('canvas-overview'),canvasOverview],
        ['canvas-reveal',K('canvas-reveal'),canvasReveal],
        ['canvas-zoom-reset',K('canvas-zoom-reset'),canvasZoomReset],
        ['new-group',K('new-group'),newGroup],
        ['toggle-group',K('toggle-group'),()=>toggleGroupCollapsed()],
        ['toggle-left-sidebar',K('toggle-left-sidebar'),toggleLeft],
        ['toggle-right-sidebar',K('toggle-right-sidebar'),toggleTree],
        ['find-in-directory',K('find-in-directory'),findInDirectory],
        ['open-diff',K('open-diff'),openDiffSplit],
        ['open-code-editor',K('open-code-editor'),()=>openCodeEditor()],
        ['attach-tmux','⌗',()=>{const b=p.querySelector('[data-act="tmux"]');if(b)tmuxMenu(b)}],
        ['host-manager','⚡',()=>{const b=p.querySelector('[data-act="host"]');if(b)hostMenu(b)}],
        ['session-manager','⟳',()=>{const b=p.querySelector('[data-act="sess"]');if(b)sessMenu(b)}],
        ['jump-to-unread',K('jump-to-unread'),jumpUnread],
        ['mark-all-read',K('mark-all-read'),markAllRead],
        ['new-browser',K('new-browser'),newBrowserSplit],
        ['notifications',K('notifications'),notesOverlay],
        ['new-window','⧉',()=>openPanel('shell',{newInstance:true})],
        ['clear-terminal',K('clear-terminal'),clearTerm],
        ['prompt-theme','◈',cycleOmz],
        ['edit-shortcuts','',()=>{openPanel('settings');setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="itterm"]');if(b)b.click()},120)}],
        ['help','?',helpOverlay],
      ];
    }
    function closeOverlays(){p.querySelectorAll('.it-palette,.it-help').forEach(x=>x.remove())}
    function palette(){
      closeOverlays();
      const cmds=commandList();
      const ov=document.createElement('div');ov.className='it-palette';
      ov.innerHTML='<div class="it-palbox"><input class="it-palin" placeholder="Type a command — cmux names work here" spellcheck="false"><div class="it-pallist"></div></div>';
      p.appendChild(ov);
      const inp=ov.querySelector('input'),list=ov.querySelector('.it-pallist');let sel=0,vis=cmds;
      const draw=()=>{
        list.innerHTML=vis.map((c,i)=>`<div class="it-palrow ${i===sel?'on':''}" data-i="${i}"><span>${escHtml(c[0])}</span><span class="k">${escHtml(c[1])}</span></div>`).join('')||'<div class="it-palrow none">no matching command</div>';
        list.querySelectorAll('[data-i]').forEach(r=>r.addEventListener('click',()=>{const c=vis[+r.dataset.i];ov.remove();if(c)c[2]()}));
      };
      const filter=()=>{const q=inp.value.trim().toLowerCase();vis=cmds.filter(c=>c[0].includes(q));sel=0;draw()};
      inp.addEventListener('input',filter);
      inp.addEventListener('keydown',e=>{
        e.stopPropagation();
        if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,vis.length-1);draw()}
        else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);draw()}
        else if(e.key==='Enter'){e.preventDefault();const c=vis[sel];ov.remove();if(c)c[2]()}
        else if(e.key==='Escape'){e.preventDefault();ov.remove()}
      });
      ov.addEventListener('pointerdown',e=>{if(e.target===ov)ov.remove()});
      filter();inp.focus();
    }
    function wsPicker(){ // ⌘P — cmux "Go to workspace"
      closeOverlays();
      const ov=document.createElement('div');ov.className='it-palette';
      ov.innerHTML='<div class="it-palbox"><input class="it-palin" placeholder="Go to workspace" spellcheck="false"><div class="it-pallist"></div></div>';
      p.appendChild(ov);
      const inp=ov.querySelector('input'),list=ov.querySelector('.it-pallist');let sel=0,vis=[];
      const draw=()=>{
        list.innerHTML=vis.map((x,i)=>`<div class="it-palrow ${i===sel?'on':''}" data-i="${i}"><span>${escHtml(wsLabel(x.w))}</span><span class="k">${escHtml(contract(x.w.cwd))}</span></div>`).join('')||'<div class="it-palrow none">no workspace</div>';
        list.querySelectorAll('[data-i]').forEach(r=>r.addEventListener('click',()=>{const x=vis[+r.dataset.i];ov.remove();if(x)selectWs(x.i)}));
      };
      const filter=()=>{const q=inp.value.trim().toLowerCase();vis=workspaces.map((w,i)=>({w,i})).filter(x=>!q||wsLabel(x.w).toLowerCase().includes(q)||contract(x.w.cwd).toLowerCase().includes(q));sel=0;draw()};
      inp.addEventListener('input',filter);
      inp.addEventListener('keydown',e=>{
        e.stopPropagation();
        if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,vis.length-1);draw()}
        else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);draw()}
        else if(e.key==='Enter'){e.preventDefault();const x=vis[sel];ov.remove();if(x)selectWs(x.i)}
        else if(e.key==='Escape'){e.preventDefault();ov.remove()}
      });
      ov.addEventListener('pointerdown',e=>{if(e.target===ov)ov.remove()});
      filter();inp.focus();
    }
    function helpOverlay(){
      closeOverlays();
      const K=keyLabel;
      const rows=[[K('toggle-left-sidebar'),'Toggle left sidebar'],[K('toggle-right-sidebar'),'Toggle right sidebar'],[K('split-right'),'Split right'],[K('split-down'),'Split down'],[K('new-browser'),'New browser split'],[K('open-diff'),'Diff viewer split'],[K('open-code-editor'),'Code editor (a folder)'],[K('toggle-canvas'),'Canvas mode'],[K('canvas-overview'),'Canvas overview'],[K('canvas-reveal'),'Canvas reveal'],[K('tidy-canvas'),'Tidy canvas'],[K('find-in-directory'),'Find in directory'],['⌥⌘←→↑↓','Focus pane'],['⌃⌘←→↑↓','Move tab across panes'],[K('break-pane'),'Break tab into a pane'],[K('new-group'),'Group workspace'],[K('toggle-group'),'Collapse group'],[K('toggle-split-zoom'),'Zoom pane'],[K('equalize-splits'),'Equalize splits'],[K('new-surface'),'New tab'],[K('go-to-workspace'),'Go to workspace'],[K('notifications'),'Notifications'],[K('next-tab')+' '+K('previous-tab'),'Next / previous tab'],['⌃1…9','Go to tab'],['⌘1…9','Go to workspace'],[K('rename-tab'),'Rename tab'],[K('rename-workspace'),'Rename workspace'],[K('command-palette'),'Command palette'],[K('jump-to-unread'),'Jump to latest unread'],[K('mark-all-read'),'Mark all read'],[K('clear-terminal'),'Clear terminal']];
      const ov=document.createElement('div');ov.className='it-help';
      ov.innerHTML='<div class="it-helpbox"><div class="hd">iT — KEYBOARD</div><div class="cols">'+rows.map(r=>`<div class="row"><b>${escHtml(r[0])}</b><span>${escHtml(r[1])}</span></div>`).join('')+'</div><div class="ft">iT speaks the keyboard & command language of the open-source <b>cmux</b> — clean-room, no cmux code inside. tmux sessions attach with ⌗. The <b>it</b> CLI is live — run <b>it</b> in any iT shell.<br>CLONE FRAME · cloneframe.io</div></div>';
      p.appendChild(ov);
      ov.tabIndex=-1;
      ov.addEventListener('pointerdown',()=>ov.remove());
      ov.addEventListener('keydown',e=>{e.stopPropagation();ov.remove()});
      ov.focus();
    }

    // ---- keyboard — the cmux language (one capture listener; claimed combos never reach
    // xterm or the browser; everything else flows through to the shell untouched).
    // Actions + default combos live in the shared IT_ACTIONS registry; every one is
    // REBINDABLE — Settings → iT, or `it shortcuts set <action> <combo>`.
    const KEY_HANDLERS={
      'toggle-left-sidebar':()=>toggleLeft(),
      'toggle-right-sidebar':()=>toggleTree(),
      'split-right':()=>{const pn=paneCur();if(pn)splitPane(pn,'h')},
      'split-down':()=>{const pn=paneCur();if(pn)splitPane(pn,'v')},
      'new-browser':()=>newBrowserSplit(),
      'open-diff':()=>openDiffSplit(),
      'open-code-editor':()=>openCodeEditor(),
      'toggle-canvas':()=>toggleCanvas(),
      'tidy-canvas':()=>tidyCanvas(),
      'find-in-directory':()=>findInDirectory(),
      'new-surface':()=>{const pn=paneCur();if(pn)newSurface(pn,curCwd())},
      'rename-tab':()=>renameTab(), // also shields the shells from an accidental page reload
      'clear-terminal':()=>clearTerm(),
      'new-workspace':()=>newWorkspace(homeAbs),
      'go-to-workspace':()=>wsPicker(),
      'notifications':()=>notesOverlay(),
      'command-palette':()=>palette(),
      'rename-workspace':()=>renameWs(),
      'jump-to-unread':()=>jumpUnread(),
      'toggle-split-zoom':()=>toggleZoom(),
      'next-tab':()=>cycleSurf(1),
      'previous-tab':()=>cycleSurf(-1),
      'mark-all-read':()=>markAllRead(),
      'focus-left':()=>focusDir('left'),
      'focus-right':()=>focusDir('right'),
      'focus-up':()=>focusDir('up'),
      'focus-down':()=>focusDir('down'),
      'equalize-splits':()=>equalize(),
      'break-pane':()=>breakPane(),
      'move-surface-left':()=>moveSurfaceDir('left'),
      'move-surface-right':()=>moveSurfaceDir('right'),
      'move-surface-up':()=>moveSurfaceDir('up'),
      'move-surface-down':()=>moveSurfaceDir('down'),
      'canvas-zoom-in':()=>canvasZoomBy(1.2),
      'canvas-zoom-out':()=>canvasZoomBy(1/1.2),
      'canvas-zoom-reset':()=>canvasZoomReset(),
      'canvas-overview':()=>canvasOverview(),
      'canvas-reveal':()=>canvasReveal(),
      'new-group':()=>newGroup(),
      'toggle-group':()=>toggleGroupCollapsed(),
    };
    let keyOver=itKeymap.load();
    panelBus(p).on('it:keys',()=>{keyOver=itKeymap.load();schedule()}); // rebinds land live
    const comboOf=id=>itKeymap.comboOf(id,keyOver);
    const prettyCombo=c=>itKeymap.pretty(c);
    const keyLabel=id=>prettyCombo(comboOf(id));
    const setCombo=(id,combo)=>{const r=itKeymap.set(id,combo);if(r.ok)keyOver=itKeymap.load();return r};
    const resetCombos=id=>{itKeymap.reset(id);keyOver=itKeymap.load()};
    function comboFromEvent(e){
      const k0=(e.key||'').toLowerCase(),code=e.code||'';
      if(itKeymap.isMod(k0))return null;
      let k=itKeymap.alias[k0]||k0;
      if(code==='BracketRight')k=']';else if(code==='BracketLeft')k='[';else if(code==='Equal')k='=';else if(code==='Minus')k='-';else if(code==='Period')k='.';
      else if(e.altKey&&/^Key[A-Z]$/.test(code))k=code.slice(3).toLowerCase(); // ⌥ mutates e.key on macOS
      const mods=[];if(e.ctrlKey)mods.push('ctrl');if(e.altKey)mods.push('alt');if(e.shiftKey)mods.push('shift');if(e.metaKey)mods.push('cmd');
      return mods.length?mods.concat(k).join('+'):null;
    }
    function hotkey(e){
      if(e.type!=='keydown')return false;
      const code=e.code||'',dig=code.indexOf('Digit')===0?+code.slice(5):0;
      // fixed ranges (not rebindable): ⌘1…9 go to workspace · ⌃1…9 go to tab
      if(e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey&&dig>=1&&dig<=9){selectWs(dig-1);return true}
      if(e.ctrlKey&&!e.metaKey&&!e.altKey&&dig>=1&&dig<=9){const pn=paneCur();if(pn&&pn.surfaces[dig-1]!=null){pn.active=dig-1;syncPanes();schedule();markHere()}return true}
      const combo=comboFromEvent(e);if(!combo)return false;
      // Under the Electron shell, let ⌘R/⌘⇧R fall through to the native Reload menu — a page
      // reload no longer loses shells (Phase 4 reattaches them), so shielding it isn't needed.
      // In the browser/chrome shell the iT still claims ⌘R (rename tab) to block an accidental reload.
      if(window.cfhubNative&&(combo==='cmd+r'||combo==='cmd+shift+r'))return false;
      for(const a of IT_ACTIONS)if(comboOf(a[0])===combo){const h=KEY_HANDLERS[a[0]];if(h){h();return true}}
      return false;
    }
    p.addEventListener('keydown',e=>{if(hotkey(e)){e.preventDefault();e.stopPropagation()}},true);

    // ---- layout persistence — workspaces + splits survive a reload (shells reopen at their cwds) ----
    function serNode(n){return n.sp?{sp:n.sp,ratio:+(+n.ratio).toFixed(3),a:serNode(n.a),b:serNode(n.b)}:{surfs:n.pane.surfaces.map(t=>({kind:t.kind,cwd:t.cwd,attach:t.attach||null,host:t.host||undefined,sess:t.sess||undefined,sessName:t.sessName||undefined,psid:(t.kind==='tty'&&!t.attach&&!t.sess)?t.psid:undefined,url:t.kind==='web'?(t.url||''):undefined})),active:n.pane.active}}
    let saveT=null;
    function saveState(){
      if(!primary)return;
      clearTimeout(saveT);saveT=setTimeout(()=>{try{
        localStorage.setItem('cfhub.it.v1',JSON.stringify({wsActive,left:leftHidden,right:treeHidden,groups:wsGroups.map(g=>({id:g.id,name:g.name,color:g.color||'',collapsed:!!g.collapsed})),ws:workspaces.map(w=>({name:w.name,cwd:w.cwd,color:w.color||'',group:w.group||null,canvasOn:!!w.canvasOn,canvasZoom:w.canvasZoom||1,canvasPan:w.canvasPan||{x:0,y:0},canvasRects:w.canvasOn||w.canvasRects?canvasRectsOf(w):null,spec:w.grid?serNode(w.layout):w.spec}))}));
      }catch(_){}},300);
    }
    function loadState(){try{const j=JSON.parse(localStorage.getItem('cfhub.it.v1')||'null');return (j&&Array.isArray(j.ws)&&j.ws.length)?j:null}catch(_){return null}}

    // ---- the `it` CLI (Phase 2) — cmux command names, executed here over the bridge control channel.
    // bridge/it.mjs ferries {id,argv,ctx} from `it` (in any iT shell) to this window; we answer on the socket.
    function surfById(id){for(const w of workspaces)for(const pn of (w.panes||[]))for(const t of pn.surfaces)if(t.id===id)return t;return null}
    function wsByRef(ref){
      const s=String(ref||'').trim();if(!s)return -1;
      const m=/^workspace:(\d+)$/.exec(s),n=m?+m[1]:(/^\d+$/.test(s)?+s:0);
      if(n>=1&&n<=workspaces.length)return n-1;
      return workspaces.findIndex(w=>wsLabel(w).toLowerCase()===s.toLowerCase()||w.id===s);
    }
    function itFlags(args){const f={_:[]};for(let i=0;i<args.length;i++){const a=args[i];if(a.startsWith('--')){f[a.slice(2)]=(i+1<args.length&&!args[i+1].startsWith('--'))?args[++i]:'true'}else f._.push(a)}return f}
    const IT_KEYS={enter:'\r','return':'\r',escape:'\x1b',esc:'\x1b',tab:'\t',space:' ',backspace:'\x7f',up:'\x1b[A',down:'\x1b[B',right:'\x1b[C',left:'\x1b[D',home:'\x1b[H',end:'\x1b[F',pageup:'\x1b[5~',pagedown:'\x1b[6~','delete':'\x1b[3~'};
    function itKey(name){
      const k=String(name||'').toLowerCase();
      if(IT_KEYS[k])return IT_KEYS[k];
      const m=/^ctrl\+([a-z\[\\\]^_])$/.exec(k);
      if(m){const c=m[1].toUpperCase().charCodeAt(0)-64;if(c>=1&&c<=31)return String.fromCharCode(c)}
      return null;
    }
    function itExec(args,ctx){
      const cmd=String(args[0]||''),f=itFlags(args.slice(1));
      const ctxSurf=ctx&&ctx.surface?surfById(ctx.surface):null;
      // explicit refs win over the calling shell: --workspace <ref> [--pane pane:N] [--surface surface:N]
      const target=()=>{
        if(f.surface){
          const wi=f.workspace?wsByRef(f.workspace):wsActive;if(wi<0)return null;
          const all=[];(workspaces[wi].panes||[]).forEach(pn=>pn.surfaces.forEach(t=>all.push(t)));
          const n=+String(f.surface).replace(/^surface:/,'');return all[n-1]||null;
        }
        if(f.host){let hit=null;(workspaces||[]).forEach(w=>(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{if(t.host===f.host&&!t.dead&&!hit)hit=t})));return hit;} // --host targets the live remote surface
        if(f.workspace||f.pane){
          const wi=f.workspace?wsByRef(f.workspace):wsActive;if(wi<0)return null;
          const w=workspaces[wi];
          const pn=f.pane?(w.panes||[])[+String(f.pane).replace(/^pane:/,'')-1]:((w.panes||[]).find(x=>x.id===w.focus)||(w.panes||[])[0]);
          return pn?pn.surfaces[pn.active]:null;
        }
        return (ctxSurf&&!ctxSurf.dead)?ctxSurf:activeTab();
      };
      const tpane=()=>{const t=target();return (t&&t.pn)||paneCur()};
      const twsi=()=>{const i=f.workspace?wsByRef(f.workspace):wsActive;return(i>=0&&workspaces[i])?i:-1};
      const okOut=o=>({ok:true,out:o});
      switch(cmd){
        case 'ping':return okOut('pong · '+workspaces.length+' workspace'+(workspaces.length===1?'':'s')+' · '+(canTTY?'tty live':'smart only'));
        case 'version':return okOut('iT · CLONE FRAME HUB v0.4 EXTRACTION');
        case 'list-workspaces':return{ok:true,rows:workspaces.map((w,i)=>({'#':i+1,name:wsLabel(w),cwd:contract(w.cwd),panes:(w.panes||[]).length||'·',tabs:(w.panes||[]).reduce((n,pn)=>n+pn.surfaces.length,0)||'·',unread:(w.panes||[]).some(pn=>pn.surfaces.some(t=>t.unread))?'●':'',active:i===wsActive?'←':''}))};
        case 'current-workspace':{const w=wsCur();return okOut((wsActive+1)+' · '+wsLabel(w)+' · '+contract(w.cwd))}
        case 'new-workspace':{const w=newWorkspace((f.cwd&&f.cwd!=='true')?f.cwd:homeAbs,{name:(f.name&&f.name!=='true')?f.name:''});return okOut('workspace '+workspaces.length+' · '+wsLabel(w))}
        case 'select-workspace':{const i=wsByRef(f._[0]);if(i<0)return{ok:false,error:'no such workspace: '+(f._[0]||'')};selectWs(i);return okOut('workspace '+(i+1)+' · '+wsLabel(wsCur()))}
        case 'rename-workspace':{const i=f.workspace?wsByRef(f.workspace):wsActive;if(i<0)return{ok:false,error:'no such workspace'};const t=f._.join(' ').trim();if(!t)return{ok:false,error:'usage: it rename-workspace <title>'};workspaces[i].name=t.slice(0,40);schedule();saveState();return okOut('renamed → '+t.slice(0,40))}
        case 'close-workspace':{const i=f.workspace?wsByRef(f.workspace):wsActive;if(i<0)return{ok:false,error:'no such workspace'};closeWorkspace(workspaces[i]);return okOut('closed')}
        case 'jump-to-unread':jumpUnread();return okOut('jumped');
        case 'mark-all-read':markAllRead();return okOut('all read');
        case 'new-split':{const d=f._[0];if(!/^(left|right|up|down)$/.test(d||''))return{ok:false,error:'usage: it new-split <left|right|up|down>'};const pn=tpane();if(!pn)return{ok:false,error:'no pane'};splitPane(pn,(d==='left'||d==='right')?'h':'v',(d==='left'||d==='up'));return okOut('split '+d)}
        case 'list-panes':{const w=wsCur();return{ok:true,rows:(w.panes||[]).map((pn,i)=>({'#':i+1,tabs:pn.surfaces.length,active:pn.surfaces[pn.active]?tabLabel(pn.surfaces[pn.active]):'·',focus:pn.id===w.focus?'←':''}))}}
        case 'focus-pane':{const w=wsCur(),n=+String(f._[0]||'').replace(/^pane:/,'');if(!(n>=1&&n<=w.panes.length))return{ok:false,error:'no such pane (1–'+w.panes.length+')'};w.focus=w.panes[n-1].id;syncPanes();schedule();return okOut('pane '+n)}
        case 'equalize-splits':equalize();return okOut('equalized');
        case 'toggle-split-zoom':toggleZoom();return okOut('zoom toggled');
        case 'break-pane':breakPane();return okOut('broke tab into a pane');
        case 'move-surface':{const d=f._[0];if(!/^(left|right|up|down)$/.test(d||''))return{ok:false,error:'usage: it move-surface <left|right|up|down>'};moveSurfaceDir(d);return okOut('moved '+d)}
        case 'new-surface':{const pn=tpane();if(!pn)return{ok:false,error:'no pane'};
          const kind=f.type==='smart'?'smart':(f.type==='browser'||f.type==='web')?'web':(f.type==='code'||f.type==='editor')?'code':undefined;
          const seed=kind==='web'?((f.url&&f.url!=='true')?f.url:''):((f.cwd&&f.cwd!=='true')?f.cwd:curCwd());
          const t=newSurface(pn,seed,kind);return okOut('tab · '+tabLabel(t))}
        case 'new-browser':newBrowserSplit();return okOut('browser split');
        case 'edit':{const d=(f._[0]&&f._[0]!=='true')?f._[0]:curCwd();openCodeEditor(d);return okOut('code editor · '+base(d))}
        case 'close-surface':{const pn=tpane();if(!pn)return{ok:false,error:'no pane'};closeSurface(pn,pn.active);return okOut('closed')}
        case 'rename-tab':{const t=target();if(!t)return{ok:false,error:'no tab'};const v=f._.join(' ').trim();if(!v)return{ok:false,error:'usage: it rename-tab <title>'};t.ptitle=v.slice(0,40);t.named=true;schedule();saveState();return okOut('renamed → '+v.slice(0,40))}
        case 'next-tab':cycleSurf(1);return okOut('next tab');
        case 'previous-tab':cycleSurf(-1);return okOut('previous tab');
        case 'send':{const t=target();if(!t||t.kind!=='tty'||!t.termApi)return{ok:false,error:'no live terminal to send to'};t.termApi.send(f._.join(' '));return okOut('sent')}
        case 'send-key':{const t=target();if(!t||t.kind!=='tty'||!t.termApi)return{ok:false,error:'no live terminal'};const b=itKey(f._[0]);if(b==null)return{ok:false,error:'unknown key: '+(f._[0]||'')};t.termApi.send(b);return okOut('key '+f._[0])}
        case 'read-screen':case 'capture-pane':{const t=target();if(!t)return{ok:false,error:'no tab'};if(t.kind!=='tty'||!t.termApi||!t.termApi.read)return okOut(strip(t.out||'').slice(-4000));const n=Math.max(0,Math.min(500,+(f.lines||0)||0))||undefined;return okOut(t.termApi.read(n))}
        case 'notify':{const title=(f.title&&f.title!=='true')?f.title:f._.join(' ');if(!title)return{ok:false,error:'usage: it notify --title <text> [--body <text>]'};noteAdd(target(),title,(f.body&&f.body!=='true')?f.body:'',{toast:true});return okOut('notified')}
        case 'host':return (async()=>{ // OUR remote hosts (SSH) — see 01_COMMAND_MAP.md; no tmux vocabulary
          const sub=String(f._[0]||'list');
          if(sub==='list'){const r=await RPC('ssh','list').catch(()=>null);return (r&&r.ok)?{ok:true,rows:(r.hosts||[]).map(h=>({alias:h.alias,user:h.user||'',host:h.hostname,port:h.port,persist:h.persist?'●':''}))}:{ok:false,error:'ssh module unavailable'}}
          if(sub==='add'){const patch={alias:f.alias,hostname:f.host||f.hostname,user:f.user,port:f.port?+f.port:undefined,identityFile:f.identity||f.identityFile};const r=await RPC('ssh','add',patch).catch(()=>null);return (r&&r.ok)?okOut('host added · '+r.host.alias):{ok:false,error:(r&&r.error)||'add failed — need --alias and --host'}}
          if(sub==='edit'){const a=f._[1];if(!a)return{ok:false,error:'usage: it host edit <alias> [--host --user --port --identity]'};const patch={};if(f.host||f.hostname)patch.hostname=f.host||f.hostname;if(f.user)patch.user=f.user;if(f.port)patch.port=+f.port;if(f.identity||f.identityFile)patch.identityFile=f.identity||f.identityFile;const r=await RPC('ssh','update',a,patch).catch(()=>null);return (r&&r.ok)?okOut('updated '+a):{ok:false,error:(r&&r.error)||'edit failed'}}
          if(sub==='rm'||sub==='remove'){const a=f._[1];const r=await RPC('ssh','remove',a).catch(()=>null);return (r&&r.ok)?okOut('removed '+a):{ok:false,error:(r&&r.error)||'rm failed'}}
          if(sub==='connect'){const a=f._[1];if(!a)return{ok:false,error:'usage: it host connect <alias>'};const perms=await RPC('permissions','get').catch(()=>null);if(!perms||!perms.ssh)return{ok:false,error:'ssh permission is off — enable it in Settings → Machine'};return newHostTab(a)?okOut('connecting → '+a):{ok:false,error:'no pane'}}
          if(sub==='disconnect'){const a=f._[1];const kill=[];(workspaces||[]).forEach(w=>(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{if(t.host===a)kill.push([pn,t])})));kill.forEach(([pn,t])=>{const i=pn.surfaces.indexOf(t);if(i>=0){try{closeSurface(pn,i)}catch(_){}}});return okOut(kill.length?('disconnected '+a):'no live session for '+a)}
          if(sub==='fingerprint'){const a=f._[1];const r=await RPC('ssh','fingerprint',a).catch(()=>null);return (r&&r.ok)?{ok:true,rows:r.fingerprints}:{ok:false,error:(r&&r.error)||'fingerprint failed'}}
          if(sub==='forget-key'){const a=f._[1];const r=await RPC('ssh','forgetKey',a).catch(()=>null);return (r&&r.ok)?okOut('forgot host key for '+a):{ok:false,error:(r&&r.error)||'failed'}}
          return {ok:false,error:'usage: it host <list|add|edit|rm|connect|disconnect|fingerprint|forget-key>'};
        })();
        case 'run':return (async()=>{ // run + capture: locally, or on a saved SSH host with --host
          const cmdStr=f._.join(' ').trim();
          if(!cmdStr)return{ok:false,error:'usage: it run <command> [--host <alias>]'};
          if(f.host){const r=await RPC('ssh','run',f.host,cmdStr).catch(e=>({ok:false,err:String((e&&e.message)||e)}));if(!r)return{ok:false,error:'run failed'};const body=(String(r.out||'')+(r.err?('\n'+r.err):'')).trim();return r.ok?okOut(body||'(no output)'):{ok:false,error:body||r.error||'run failed'}}
          if(!Bridge.on())return{ok:false,error:'bridge offline'};
          let out='';try{await Bridge.shell(cmdStr,x=>{out+=x})}catch(e){return{ok:false,error:String((e&&e.message)||e)}}
          return okOut(strip(out).trim()||'(no output)');
        })();
        case 'pipe':{ // OUR pipe-pane analog: tee a surface's output to a file
          const sub=String(f._[0]||'').toLowerCase(),t=target();
          if(!t||t.kind!=='tty')return{ok:false,error:'no live terminal to pipe (open one, or target with --host/--surface)'};
          if(sub==='off'){pipeStop(t);return okOut('pipe off')}
          if(sub==='on'||sub===''){const file=(f.file&&f.file!=='true')?f.file:pipeFile(t);const r=pipeStart(t,file);return r.ok?okOut('piping → '+contract(file)):{ok:false,error:r.error}}
          return{ok:false,error:'usage: it pipe <on|off> [--file <path>]'};
        }
        case 'sess':return (async()=>{ // OUR persistence keeper — survives disconnect + bridge restart, no tmux
          const sub=String(f._[0]||'list');
          if(sub==='list'){const r=await RPC('keeper','list').catch(()=>null);return (r&&r.ok)?{ok:true,rows:(r.sessions||[]).map(s=>({id:s.id,name:s.name||'',cwd:contract(s.cwd||''),pid:s.pid}))}:{ok:false,error:'keeper unavailable'}}
          if(sub==='new'){const id=(f.id&&f.id!=='true')?String(f.id):('s'+Date.now().toString(36));const name=(f.name&&f.name!=='true')?String(f.name):'';const t=newSessTab(id,name);return t?okOut('persistent session '+id+(name?(' · '+name):'')):{ok:false,error:'no pane'}}
          if(sub==='attach'){const id=f._[1];if(!id)return{ok:false,error:'usage: it sess attach <id>'};return newSessTab(id,'')?okOut('attaching → '+id):{ok:false,error:'no pane'}}
          if(sub==='kill'){const id=f._[1];const r=await RPC('keeper','kill',id).catch(()=>null);return (r&&r.ok)?okOut('killed '+id):{ok:false,error:(r&&r.error)||'kill failed'}}
          if(sub==='rename'){const id=f._[1],nm=f._.slice(2).join(' ');const r=await RPC('keeper','rename',id,nm).catch(()=>null);return (r&&r.ok)?okOut('renamed '+id):{ok:false,error:(r&&r.error)||'rename failed'}}
          return {ok:false,error:'usage: it sess <list|new|attach|kill|rename>'};
        })();
        case 'display-message':Toast.show(f._.join(' ')||'iT');return okOut('shown');
        case 'right-sidebar':{const s=f._[0]||'toggle';if(s==='show'||s==='files'){if(treeHidden)toggleTree()}else if(s==='hide'){if(!treeHidden)toggleTree()}else toggleTree();return okOut('right sidebar '+(treeHidden?'hidden':'shown'))}
        case 'toggle-left-sidebar':toggleLeft();return okOut('left sidebar '+(leftHidden?'hidden':'shown'));
        case 'shortcuts':{
          const sub=f._[0]||'';
          if(sub==='list'||f.json)return{ok:true,rows:IT_ACTIONS.map(d=>({action:d[0],combo:comboOf(d[0])||'(unbound)',keys:prettyCombo(comboOf(d[0])),custom:keyOver[d[0]]!=null?'●':''}))};
          if(sub==='set'){const id=f._[1],combo=f._.slice(2).join('+');if(!id)return{ok:false,error:'usage: it shortcuts set <action> <combo|none>'};const r=setCombo(id,combo);if(r.error)return{ok:false,error:r.error};schedule();return okOut(id+' → '+(comboOf(id)?prettyCombo(comboOf(id)):'unbound'))}
          if(sub==='reset'){resetCombos(f._[1]||null);schedule();return okOut(f._[1]?f._[1]+' reset to default':'all shortcuts reset to defaults')}
          openPanel('settings');setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="itterm"]');if(b)b.click()},120);
          return okOut('Settings → iT opened — or: it shortcuts list · set <action> <combo> · reset [action]');
        }
        case 'open':{ // it open <path> — folder → new workspace there · file → the viewer
          const pth=f._.join(' ').trim();
          if(!pth||pth[0]!=='/')return{ok:false,error:'usage: it open </absolute/path>'};
          return (async()=>{try{
            const st=await RPC('files','stat',pth);
            if(!st||!st.ok)return{ok:false,error:'no such path: '+pth};
            if(st.info&&st.info.dir){const w=newWorkspace(pth);return okOut('workspace '+workspaces.length+' · '+wsLabel(w))}
            viewFile(pth);return okOut('viewing '+pth);
          }catch(e2){return{ok:false,error:String((e2&&e2.message)||e2)}}})();
        }
        case 'diff':openDiffSplit();return okOut('diff split');
        case 'toggle-canvas':toggleCanvas();return okOut('canvas '+(wsCur()&&wsCur().canvasOn?'on':'off'));
        case 'tidy-canvas':tidyCanvas();return okOut('tidied');
        case 'canvas-zoom':{const d=f._[0]||'';if(d==='reset'){canvasZoomReset();return okOut('zoom 100%')}if(d==='in'||d==='out'){canvasZoomBy(d==='in'?1.2:1/1.2);return okOut('zoom '+Math.round((wsCur().canvasZoom||1)*100)+'%')}const n=parseFloat(d);if(n>0){const w=wsCur();if(w){w.canvasZoom=Math.max(.25,Math.min(3,n));applyCanvasXform(w);saveState()}return okOut('zoom '+Math.round((wsCur().canvasZoom||1)*100)+'%')}return{ok:false,error:'usage: it canvas-zoom <in|out|reset|0.25..3>'}}
        case 'canvas-overview':canvasOverview();return okOut('overview');
        case 'canvas-reveal':canvasReveal();return okOut('revealed focused pane');
        case 'new-group':case 'group':{const sub=cmd==='group'?(f._[0]||'new'):'new';
          if(sub==='new'){newGroup();return okOut('grouped current workspace')}
          if(sub==='collapse'||sub==='toggle'){toggleGroupCollapsed();return okOut('group toggled')}
          if(sub==='dissolve'){const g=groupOf(wsCur());if(!g)return{ok:false,error:'current workspace is not in a group'};dissolveGroup(g.id);return okOut('group dissolved')}
          if(sub==='add'){const ref=f._.slice(1).join(' ').trim();if(!ref)return{ok:false,error:'usage: it group add <group name or index>'};const gi=/^\d+$/.test(ref)?(+ref-1):wsGroups.findIndex(g=>g.name.toLowerCase()===ref.toLowerCase());const g=wsGroups[gi];if(!g)return{ok:false,error:'no such group: '+ref};moveWsToGroup(wsCur(),g.id);return okOut('added to '+g.name)}
          if(sub==='remove'){moveWsToGroup(wsCur(),null);return okOut('removed from group')}
          if(sub==='list')return{ok:true,rows:wsGroups.map((g,i)=>({'#':i+1,name:g.name,members:workspaces.filter(w=>w.group===g.id).length,collapsed:g.collapsed?'▸':''}))};
          return{ok:false,error:'usage: it group <new|add <ref>|remove|collapse|dissolve|list>'}}
        case 'find-in-directory':findInDirectory();return okOut('find open');
        case 'set-workspace-color':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};const v=f._[0]||'';if(!setWsColor(workspaces[i],v))return{ok:false,error:'unknown color — one of: '+WS_COLORS.map(c=>c[0]).join(' ')+' · #hex · none'};return okOut('color '+(v||'none'))}
        case 'set-status':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};const w=workspaces[i],key=String(f._[0]||'').slice(0,24),val=f._.slice(1).join(' ').slice(0,40);
          if(!key||!val)return{ok:false,error:'usage: it set-status <key> <value> [--icon <emoji>] [--color <#hex>] [--priority <n>] [--workspace <ref>]'};
          w.status[key]={value:val,icon:(f.icon&&f.icon!=='true')?String(f.icon).slice(0,4):'',color:/^#[0-9a-f]{3,8}$/i.test(f.color||'')?f.color:'',priority:+(f.priority||0)||0};
          schedule();return okOut('status '+key+' = '+val)}
        case 'clear-status':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};const w=workspaces[i],key=f._[0];if(key)delete w.status[key];else w.status={};schedule();return okOut(key?'cleared '+key:'all status cleared')}
        case 'list-status':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};return{ok:true,rows:Object.entries(workspaces[i].status||{}).map(([k,s])=>({key:k,value:s.value,icon:s.icon||'',color:s.color||'',priority:s.priority||0}))}}
        case 'set-progress':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};const v=parseFloat(f._[0]);
          if(!(v>=0&&v<=1))return{ok:false,error:'usage: it set-progress <0..1> [--label <text>] [--workspace <ref>]'};
          workspaces[i].progress={v,label:(f.label&&f.label!=='true')?String(f.label).slice(0,24):''};schedule();return okOut('progress '+Math.round(v*100)+'%')}
        case 'clear-progress':{const i=twsi();if(i<0)return{ok:false,error:'no such workspace'};workspaces[i].progress=null;schedule();return okOut('progress cleared')}
        case 'feedback':return okOut('recorded');
        default:return{ok:false,error:'unknown or not-yet-implemented command: '+(cmd||'(none)')+' — run `it --help`'};
      }
    }
    let ctlWs=null,ctlDown=false;
    function ctlConnect(){
      if(!primary||ctlDown||ctlWs)return;
      const b=window.__CFHUB_BRIDGE__;if(!b||!b.token||!Bridge.on())return;
      let s;try{s=new WebSocket(b.endpoint.replace(/^http/,'ws')+'/stream?op=it',['cfhub','cfhub.bearer.'+b.token])}catch(_){return}
      ctlWs=s;
      s.onmessage=e=>{
        let m=null;try{m=JSON.parse(e.data)}catch(_){}
        if(!m||!m.id)return;
        Promise.resolve().then(()=>itExec(m.argv||[],m.ctx||{})).catch(err=>({ok:false,error:String((err&&err.message)||err)}))
          .then(res=>{try{s.send(JSON.stringify({id:m.id,result:res}))}catch(_){}});
      };
      s.onclose=()=>{if(ctlWs===s)ctlWs=null;if(!ctlDown&&document.body.contains(p))setTimeout(ctlConnect,3000)};
      s.onerror=()=>{};
    }
    function appendOut(t,html){t.out+=html;if(t.out.length>240000)t.out=t.out.slice(t.out.length-200000);if(t.el){t.el.out.innerHTML=t.out;if(t===activeTab())t.el.out.scrollTop=t.el.out.scrollHeight}}
    // tmux: list real sessions on this machine, one click attaches a live tab — the
    // Manaflow-style crew view is N windows/tabs attached to N sessions, side by side.
    async function tmuxMenu(anchor){
      const old=p.querySelector('.sh-tmuxpop');if(old){old.remove();return}
      if(!Bridge.on()){Toast.show('Connect the HUB Bridge first');return}
      let out='';try{await Bridge.shell("tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{?session_attached,attached,}' 2>/dev/null",x=>{out+=x})}catch(_){}
      const rows=strip(out).split('\n').map(s=>s.trim()).filter(Boolean).map(l=>{const[name,wins,att]=l.split('\t');return{name,wins,att}}).filter(r=>/^[\w.-]{1,64}$/.test(r.name||''));
      const pop=document.createElement('div');pop.className='sh-tmuxpop';
      pop.innerHTML='<div class="hd">TMUX SESSIONS</div>'+(rows.length?rows.map(r=>`<button data-s="${escAttr(r.name)}"><b>${escAttr(r.name)}</b><span>${escAttr(r.wins)}w${r.att?' · attached':''}</span></button>`).join(''):'<div class="none">no sessions — start one: <code>tmux new -s crew</code></div>');
      p.appendChild(pop);
      const pr=p.getBoundingClientRect(),ar=anchor.getBoundingClientRect();
      pop.style.left=Math.max(8,ar.left-pr.left-40)+'px';pop.style.top=(ar.bottom-pr.top+6)+'px';
      pop.querySelectorAll('button[data-s]').forEach(b=>b.addEventListener('click',()=>{pop.remove();newTab(homeAbs,'tty',b.dataset.s);renderAll()}));
      setTimeout(()=>addEventListener('pointerdown',function once(ev){if(!ev.target.closest('.sh-tmuxpop'))pop.remove();removeEventListener('pointerdown',once,true)},true),0);
    }
    // ── Remote hosts (SSH) ──────────────────────────────────────────────────
    // OUR remote engine: a saved host → a normal tty surface running `ssh <alias>`.
    // No tmux. The bridge resolves the alias server-side (op=ssh) so the hostname/IP
    // never crosses to the client; a remote session reuses the Phase-4 pty persistence.
    function hostPos(pop,anchor){const pr=p.getBoundingClientRect(),ar=anchor.getBoundingClientRect();pop.style.left=Math.max(8,ar.left-pr.left-40)+'px';pop.style.top=(ar.bottom-pr.top+6)+'px'}
    function hostDismiss(pop){setTimeout(()=>addEventListener('pointerdown',function once(ev){if(!ev.target.closest('.sh-hostpop'))pop.remove();removeEventListener('pointerdown',once,true)},true),0)}
    async function hostMenu(anchor){
      const old=p.querySelector('.sh-hostpop');if(old){old.remove();return}
      if(!Bridge.on()){Toast.show('Connect the HUB Bridge first');return}
      const pop=document.createElement('div');pop.className='sh-hostpop';p.appendChild(pop);hostPos(pop,anchor);hostDismiss(pop);
      await hostRenderList(pop,anchor);
    }
    async function hostRenderList(pop,anchor){
      let res;try{res=await RPC('ssh','list')}catch(_){res=null}
      const hosts=(res&&res.ok&&res.hosts)||[];
      const list=hosts.length?hosts.map(h=>`<button data-h="${escAttr(h.alias)}"><b>${escAttr(h.alias)}</b><span>${escAttr((h.user?h.user+'@':'')+h.hostname)}</span><i class="rm" data-rm="${escAttr(h.alias)}" title="Forget host">✕</i></button>`).join(''):'<div class="none">no saved hosts — add one below</div>';
      pop.innerHTML='<div class="hd">REMOTE HOSTS · SSH</div>'+list+'<button class="add" data-add="1">＋ Add remote host</button>';
      hostPos(pop,anchor);
      pop.querySelectorAll('button[data-h]').forEach(b=>b.addEventListener('click',e=>{if(e.target&&e.target.dataset.rm!=null)return;pop.remove();hostConnect(b.dataset.h)}));
      pop.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();await RPC('ssh','remove',b.dataset.rm).catch(()=>{});hostRenderList(pop,anchor)}));
      const addBtn=pop.querySelector('[data-add]');if(addBtn)addBtn.addEventListener('click',()=>hostAddForm(pop,anchor));
    }
    function hostAddForm(pop,anchor){
      pop.innerHTML='<div class="hd">ADD REMOTE HOST</div><div class="frm">'
        +'<input data-f="alias" placeholder="alias — e.g. prod" spellcheck="false" autocomplete="off">'
        +'<input data-f="hostname" placeholder="hostname or IP" spellcheck="false" autocomplete="off">'
        +'<input data-f="user" placeholder="user (optional)" spellcheck="false" autocomplete="off">'
        +'<input data-f="port" placeholder="port — 22" spellcheck="false" autocomplete="off">'
        +'<input data-f="identityFile" placeholder="~/.ssh/id_ed25519 (optional)" spellcheck="false" autocomplete="off">'
        +'<div class="fp"></div><div class="row"><button data-a="save">Save</button><button data-a="back">Cancel</button></div></div>';
      hostPos(pop,anchor);
      const val=k=>String((pop.querySelector('[data-f="'+k+'"]')||{}).value||'').trim();
      const fp=pop.querySelector('.fp');
      async function doSave(){
        const patch={alias:val('alias'),hostname:val('hostname')};
        if(val('user'))patch.user=val('user');
        if(val('port'))patch.port=Number(val('port'));
        if(val('identityFile'))patch.identityFile=val('identityFile');
        fp.className='fp';fp.textContent='saving…';
        let r;try{r=await RPC('ssh','add',patch)}catch(_){r=null}
        if(!r||!r.ok){fp.className='fp err';fp.textContent=(r&&r.error)||'could not save';return}
        fp.textContent='checking host key…';
        let f;try{f=await RPC('ssh','fingerprint',patch.alias)}catch(_){f=null}
        if(f&&f.ok&&f.fingerprints&&f.fingerprints.length){fp.className='fp';fp.innerHTML='<b>verify this matches your server:</b>'+f.fingerprints.map(x=>`<code>${escHtml(x.sha256||'')} · ${escHtml(x.type||'')}</code>`).join('')}
        else{fp.className='fp';fp.textContent='saved — the host key will be verified on first connect.'}
        const done=document.createElement('div');done.className='row';done.innerHTML='<button data-a="done">Done</button>';
        pop.querySelector('.frm').appendChild(done);
        done.querySelector('[data-a="done"]').addEventListener('click',()=>hostRenderList(pop,anchor));
      }
      pop.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();doSave()}}));
      pop.querySelector('[data-a="save"]').addEventListener('click',doSave);
      pop.querySelector('[data-a="back"]').addEventListener('click',()=>hostRenderList(pop,anchor));
    }
    async function hostConnect(alias){
      let perms;try{perms=await RPC('permissions','get')}catch(_){perms=null}
      if(!perms||!perms.ssh){Toast.show('SSH is off — enable it in Settings → Machine');return}
      newHostTab(alias);
    }
    function newHostTab(alias){const pn=paneCur();if(!pn){Toast.show('Open a terminal pane first');return null}return newSurface(pn,homeAbs,'tty',null,false,null,alias)}
    // ── Persistent sessions (OUR keeper) — survive disconnect + bridge restart, no tmux ──
    async function sessMenu(anchor){
      const old=p.querySelector('.sh-hostpop');if(old){old.remove();return}
      if(!Bridge.on()){Toast.show('Connect the HUB Bridge first');return}
      const pop=document.createElement('div');pop.className='sh-hostpop';p.appendChild(pop);hostPos(pop,anchor);hostDismiss(pop);
      await sessRenderList(pop,anchor);
    }
    async function sessRenderList(pop,anchor){
      let res;try{res=await RPC('keeper','list')}catch(_){res=null}
      const ss=(res&&res.ok&&res.sessions)||[];
      const list=ss.length?ss.map(s=>`<button data-ss="${escAttr(s.id)}"><b>${escAttr(s.name||s.id)}</b><span>${escAttr(base(s.cwd||'')||'~')} · pid ${escAttr(String(s.pid||''))}</span><i class="rm" data-sk="${escAttr(s.id)}" title="Kill session">✕</i></button>`).join(''):'<div class="none">no persistent sessions — start one below</div>';
      pop.innerHTML='<div class="hd">PERSISTENT SESSIONS</div>'+list+'<button class="add" data-new="1">＋ New persistent session</button>';
      hostPos(pop,anchor);
      pop.querySelectorAll('button[data-ss]').forEach(b=>b.addEventListener('click',e=>{if(e.target&&e.target.dataset.sk!=null)return;pop.remove();newSessTab(b.dataset.ss,'')}));
      pop.querySelectorAll('[data-sk]').forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();await RPC('keeper','kill',b.dataset.sk).catch(()=>{});sessRenderList(pop,anchor)}));
      const nb=pop.querySelector('[data-new]');if(nb)nb.addEventListener('click',()=>{pop.remove();newSessTab('s'+Date.now().toString(36),'')});
    }
    function newSessTab(id,name){const pn=paneCur();if(!pn){Toast.show('Open a terminal pane first');return null}const t=newSurface(pn,homeAbs,'tty',null,false,null,null,id);if(t&&name)t.sessName=name;return t}
    // ── output pipe (OUR pipe-pane analog) — tee a surface's output to a file, debounced flush ──
    function pipeFile(t){return (homeAbs||'')+'/'+((t.host?('ssh-'+t.host):(base(t.cwd)||'shell'))+'-'+t.id)+'.log'}
    function pipeStart(t,file){if(!Bridge.on())return{ok:false,error:'bridge offline'};if(t.pipe)pipeStop(t);t.pipe={file,buf:'',timer:null};return{ok:true,file}}
    function pipeFeed(t,d){if(!t.pipe)return;t.pipe.buf+=strip(String(d||''));if(t.pipe.buf.length>200000)t.pipe.buf=t.pipe.buf.slice(-200000);if(!t.pipe.timer)t.pipe.timer=setTimeout(()=>{const p=t.pipe;if(!p)return;const c=p.buf;p.buf='';p.timer=null;if(c)RPC('files','write',p.file,c,{append:true}).catch(()=>{})},1000)}
    function pipeStop(t){if(!t.pipe)return;const p=t.pipe;t.pipe=null;if(p.timer)clearTimeout(p.timer);if(p.buf)RPC('files','write',p.file,p.buf,{append:true}).catch(()=>{})}
    function onKey(e,t){
      const inp=e.target;
      if(e.key==='Enter'){e.preventDefault();const cmd=inp.value;inp.value='';setGhost(t,'','');if(cmd.trim()){t.hist.push(cmd);t.hi=t.hist.length}run(t,cmd)}
      else if(e.key==='ArrowUp'){e.preventDefault();if(t.hi>0){t.hi--;inp.value=t.hist[t.hi]||''}setGhost(t,inp.value,'')}
      else if(e.key==='ArrowDown'){e.preventDefault();if(t.hi<t.hist.length-1){t.hi++;inp.value=t.hist[t.hi]||''}else{t.hi=t.hist.length;inp.value=''}setGhost(t,inp.value,ghostFor(t,inp.value))}
      else if(e.key==='ArrowRight'){const g=ghostFor(t,inp.value);if(g&&inp.selectionStart===inp.value.length){e.preventDefault();inp.value=inp.value+g;setGhost(t,inp.value,'')}}
      else if((e.key==='c'||e.key==='C')&&e.ctrlKey){if(t.ctl){try{t.ctl.abort()}catch(_){}}appendOut(t,'<span class="dim">^C</span>\n')}
      else if((e.key==='l'||e.key==='L')&&(e.metaKey||e.ctrlKey)){e.preventDefault();t.out='';if(t.el)t.el.out.innerHTML=''}
      else if((e.key==='t'||e.key==='T')&&(e.metaKey||e.ctrlKey)){e.preventDefault();newTab(t.cwd);renderAll()}
      else if(e.key==='Tab'){e.preventDefault();const g=ghostFor(t,inp.value);if(g){inp.value=inp.value+g;setGhost(t,inp.value,'')}else tabComplete(t,inp)}
    }
    async function run(t,cmd){
      const c=cmd.trim();
      appendOut(t,'<span class="cmd">❯ '+escHtml(cmd)+'</span>\n');
      if(!c)return;
      if(c==='clear'||c==='cls'){t.out='';if(t.el)t.el.out.innerHTML='';return}
      if(!Bridge.on()){appendOut(t,'<span class="err">Not connected to the HUB Bridge — open MY MACHINE to connect.</span>\n');return}
      t.busy=true;renderTabs();t.ctl=new AbortController();
      let marks={};
      try{
        if(t.cwd&&t.cwd!=='~')await Bridge.shell('cd '+qpath(t.cwd),()=>{},null,t.id,{sid:t.id}); // seed this tab's own bridge cwd session
        marks=(await Bridge.shell(c,txt=>{appendOut(t,escHtml(strip(txt)))},t.ctl.signal,t.id,{sid:t.id}))||{};
      }catch(err){appendOut(t,'<span class="err">'+escHtml((err&&err.message)||'aborted')+'</span>\n')}
      if(marks.needSudo)appendOut(t,'<span class="dim">this needs sudo — run it from CODE, or enable Root mode in Settings → Agent Tools</span>\n');
      if(marks.cwd)t.cwd=marks.cwd;
      if(t.out&&!t.out.endsWith('\n'))t.out+='\n';
      t.busy=false;t.ctl=null;
      updatePrompt(t);refreshGit(t);
      renderTabs();markHere();
      if(t===activeTab()&&t.el){t.el.out.scrollTop=t.el.out.scrollHeight;t.el.in.focus()}
    }

    // ---- file tree (browse the whole machine; follows and drives the active tab) ----
    function cdActive(full){
      const t=activeTab();if(!t)return;
      if(t.kind==='tty'){if(t.termApi){t.termApi.send(' cd '+qpath(full)+'\n');t.termApi.focus()}t.cwd=full;renderTabs();markHere()} // OSC 7 confirms a beat later
      else run(t,'cd '+qpath(full));
    }
    function viewFile(full){
      // the viewer floats OVER the panes — never rebuilds them, so live processes survive
      const old=mainEl.querySelector('.sh-viewov');if(old)old.remove();
      const ov=document.createElement('div');ov.className='sh-viewov';mainEl.appendChild(ov);
      openFileView(ov,full,{cwd:(activeTab()&&activeTab().cwd)||homeAbs,onBack:()=>{ov.remove();syncPanes()}});
    }
    // code editor surface: load a file into the pane's editor (view/edit/save, in place)
    function openCodeFile(t,full){
      t._cfile=full;
      if(t.refreshCode)t.refreshCode(); // repaint tree so the open file highlights
      openFileView(t.el.ed,full,{cwd:t.cwd});
      saveState();
    }
    // ⌘⇧E / `it edit` — open a folder in a code editor surface (split beside the current pane)
    function openCodeEditor(dir){
      const pn=paneCur();if(!pn)return;
      const seed=dir||curCwd();
      const npn=spawnPane(pn,'h',false);if(!npn){newSurface(pn,seed,'code');renderAll();return}
      newSurface(npn,seed,'code',null,true);pn.w.focus=npn.id;
      renderGrid(pn.w);renderAll();saveState();
    }
    async function lsDir(dir){
      if(tree.kids.has(dir))return tree.kids.get(dir);
      let entries=[];try{const r=await RPC('files','list',dir);if(r&&r.ok)entries=(r.entries||[]).filter(e=>!e.name.startsWith('.'))}catch(_){}
      entries.sort((a,b)=>((a.type==='dir')===(b.type==='dir'))?a.name.localeCompare(b.name):(a.type==='dir'?-1:1));
      tree.kids.set(dir,entries);return entries;
    }
    function expandTo(dir){
      if(!dir||!tree.root||!(dir===tree.root||dir.startsWith(tree.root+'/')))return;
      let cur=tree.root;dir.slice(tree.root.length).split('/').filter(Boolean).forEach(seg=>{cur=join(cur,seg);tree.open.add(cur)});
    }
    async function renderTree(){
      if(!tree.root)tree.root=homeAbs;
      treeEl.innerHTML=`<div class="sh-thead"><b>FILES · ${escHtml(base(tree.root)||tree.root)}</b><span class="sh-thome" id="shup" title="Up one level">↑</span><span class="sh-thome" id="shcode" title="Open this folder in a code editor (⌘⇧E)">⌸</span><span class="sh-thome" id="shreveal" title="Reveal in Finder">⤢</span><span class="sh-thome" id="shhome" title="Home">⌂</span><span class="sh-thome" id="shhide" title="Hide files (⌥⌘B)">✕</span></div><div class="it-findrow"><input class="it-tfind" id="shfind" placeholder="${tree.grep?'search in files — Enter runs':'find — filter files'}" spellcheck="false"><button class="it-fmode${tree.grep?' grep':''}" id="shfmode" title="Filter file NAMES ↔ search file CONTENTS (⌘⇧F)">${tree.grep?'.*':'Aa'}</button></div><div class="sh-tlist" id="shtl"></div>`;
      treeEl.querySelector('#shup').addEventListener('click',()=>{const pr=parent(tree.root);if(pr&&pr!==tree.root){tree.root=pr;renderTree()}});
      treeEl.querySelector('#shhome').addEventListener('click',()=>{tree.root=homeAbs;renderTree()});
      treeEl.querySelector('#shhide').addEventListener('click',toggleTree);
      treeEl.querySelector('#shreveal').addEventListener('click',()=>{if(Bridge.on())Bridge.shell('open '+qpath(tree.root),()=>{});Toast.show('Opening '+base(tree.root)+' in Finder — drop files there and they appear here')});
      treeEl.querySelector('#shcode').addEventListener('click',()=>openCodeEditor(tree.root));
      const fi=treeEl.querySelector('#shfind'),tl=treeEl.querySelector('#shtl');
      fi.value=tree.grep?(tree.gq||''):(tree.filter||'');
      treeEl.querySelector('#shfmode').addEventListener('click',()=>{tree.grep=!tree.grep;if(!tree.grep){tree.gres=null;tree.gq=''}renderTree().then(()=>{const f2=treeEl.querySelector('#shfind');if(f2)f2.focus()})});
      fi.addEventListener('keydown',e=>{e.stopPropagation();if(tree.grep&&e.key==='Enter'){e.preventDefault();doGrep(fi.value.trim())}});
      fi.addEventListener('input',async()=>{if(tree.grep)return;tree.filter=fi.value.trim().toLowerCase();tl.textContent='';await drawLevel(tl,tree.root,0)});
      if(tree.grep&&tree.gres)drawGrep(tl);
      else await drawLevel(tl,tree.root,0);
    }
    // content search (our "text" mode of cmux's ⌘⇧F) — ripgrep when present, grep otherwise;
    // read-only, capped, .git/node_modules excluded. Click a hit → the file viewer.
    async function doGrep(q){
      tree.gq=q;
      if(!q){tree.gres=null;renderTree();return}
      if(!Bridge.on()){Toast.show('Connect the HUB Bridge to search file contents');return}
      // "in directory" = the ACTIVE TAB's folder (cmux semantics), not the tree root —
      // the tree may sit at ~ while the shell works deep inside a repo
      const root=tree.groot=curCwd();
      const q1="'"+String(q).replace(/'/g,"'\\''")+"'";
      // absolute search dir, no `cd` prefix — the bridge treats a leading `cd ` as its
      // session-cwd command and would swallow the rest of the line
      const cmd='{ command -v rg >/dev/null 2>&1 && rg -n --no-heading -S -m 3 --max-columns 200 -g \'!.git\' -g \'!node_modules\' -e '+q1+' '+qpath(root)+' 2>/dev/null || grep -RIn --exclude-dir=.git --exclude-dir=node_modules -m 3 -e '+q1+' '+qpath(root)+' 2>/dev/null ; } | head -300';
      let out='';try{await Bridge.shell(cmd,x=>{out+=x})}catch(_){}
      const pre=root.endsWith('/')?root:root+'/';
      tree.gres=strip(out).split('\n').map(s2=>{
        s2=s2.trim();if(!s2.startsWith(pre))return null;
        const m=/^(.+?):(\d+):(.*)$/.exec(s2.slice(pre.length));
        return m?{f:m[1],ln:+m[2],s:m[3].trim().slice(0,160)}:null;
      }).filter(Boolean).slice(0,300);
      renderTree();
    }
    function drawGrep(container){
      const n=tree.gres.length;
      const head=document.createElement('div');head.className='it-gcount';head.textContent=(n?(n+(n===300?'+':'')+' MATCH'+(n===1?'':'ES')+' · '+tree.gq):'no matches for "'+tree.gq+'"')+' — in '+(base(tree.groot||'')||'~');
      container.appendChild(head);
      tree.gres.forEach(r=>{
        const row=document.createElement('div');row.className='it-grow';
        row.innerHTML=`<div class="f"><span style="overflow:hidden;text-overflow:ellipsis">${escHtml(r.f)}</span><span class="ln">:${r.ln}</span></div><div class="s">${escHtml(r.s)}</div>`;
        row.addEventListener('click',()=>viewFile(join(tree.groot||tree.root,r.f)));
        container.appendChild(row);
      });
    }
    function findInDirectory(){ // ⌘⇧F — cmux's find-in-directory, plus our content mode
      if(treeHidden)toggleTree();
      tree.grep=true;
      renderTree().then(()=>{const f2=treeEl.querySelector('#shfind');if(f2){f2.focus();f2.select()}});
    }
    // flat list — every row lands in ONE container (no nested wrappers), so deep trees
    // stay a light DOM and rows keep a perfectly consistent hit area / hover line
    async function drawLevel(container,dir,depth){
      const entries=await lsDir(dir);
      for(const e of entries){
        if(tree.filter&&e.type!=='dir'&&!e.name.toLowerCase().includes(tree.filter))continue;
        const full=join(dir,e.name),isDir=e.type==='dir';
        const row=document.createElement('div');
        row.className='sh-trow '+(isDir?'dir':'file')+(tree.here===full?' here':'')+(tree.open.has(full)?' openrow':'');
        row.style.paddingLeft=(8+depth*14)+'px';
        row.innerHTML=`<span class="sh-tchev ${tree.open.has(full)?'open':''}">${isDir?'▸':''}</span><svg class="sh-tic"><use href="${isDir?'#i-folder':'#i-file'}"/></svg><span class="sh-tname">${escHtml(e.name)}</span>`;
        container.appendChild(row);
        if(isDir){
          row.querySelector('.sh-tchev').addEventListener('click',ev=>{ev.stopPropagation();if(tree.open.has(full))tree.open.delete(full);else tree.open.add(full);renderTree()});
          row.querySelector('.sh-tname').addEventListener('click',()=>cdActive(full)); // click folder = cd the active terminal
        }else{
          row.querySelector('.sh-tname').addEventListener('click',()=>viewFile(full)); // click a file → view/diff/edit it, ‹ back to the shell
        }
        if(isDir&&tree.open.has(full))await drawLevel(container,full,depth+1);
      }
    }
    function markHere(){const t=activeTab();if(!t)return;if(tree.here!==t.cwd){tree.here=t.cwd;expandTo(t.cwd);if(!treeHidden)renderTree()}}

    // ---- resizable terminal | files (the tree sits on the RIGHT, cmux-style) ----
    (()=>{const splitEl=p.querySelector('#shsplit');if(!splitEl)return;
      let w=parseInt(localStorage.getItem('cfhub.shell.treew')||'206',10)||206;treeEl.style.width=w+'px';
      splitEl.addEventListener('pointerdown',e=>{e.preventDefault();splitEl.classList.add('drag');const r=p.querySelector('.sh').getBoundingClientRect();
        const mm=ev=>{let nw=Math.max(140,Math.min(r.right-ev.clientX,r.width-360));treeEl.style.width=nw+'px'};
        const mu=()=>{removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);splitEl.classList.remove('drag');localStorage.setItem('cfhub.shell.treew',String(parseInt(treeEl.style.width,10)||206))};
        addEventListener('pointermove',mm);addEventListener('pointerup',mu)});
    })();

    // ---- boot ----
    (async()=>{
      if(Bridge.on()){
        try{let o='';const m=await Bridge.shell('pwd',x=>{o+=x});homeAbs=(m&&m.cwd)||o.trim()||'~'}catch(_){homeAbs='~'}
        try{canTTY=!!(await RPC('pty','available'))}catch(_){canTTY=false}
      }
      const pcwd=pendingShellCwd;pendingShellCwd=null;
      const startCwd=pcwd||homeAbs;
      tree.root=homeAbs;tree.here=startCwd;
      const saved=(primary&&localStorage.getItem('cfhub.it.restore')!=='0')?loadState():null;
      if(saved){
        leftHidden=!!saved.left;treeHidden=!!saved.right;
        if(Array.isArray(saved.groups)){wsGroups=saved.groups.map(g=>({id:g.id||('g'+(++grpSeq)),name:g.name||'Group',color:g.color||'',collapsed:!!g.collapsed}));grpSeq=Math.max(grpSeq,wsGroups.length)}
        const gids=new Set(wsGroups.map(g=>g.id));
        saved.ws.slice(0,8).forEach(sw=>newWorkspace((sw.cwd&&sw.cwd!=='~')?sw.cwd:homeAbs,{name:sw.name||'',color:sw.color||'',group:gids.has(sw.group)?sw.group:null,canvasOn:!!sw.canvasOn,canvasZoom:sw.canvasZoom||1,canvasPan:sw.canvasPan||{x:0,y:0},canvasRects:sw.canvasRects||null,spec:sw.spec||null,background:true}));
        if(workspaces.length)selectWs(Math.min(saved.wsActive||0,workspaces.length-1));
        if(pcwd)newWorkspace(pcwd); // opened at an explicit folder → its own workspace
      }
      if(!workspaces.length)newWorkspace(startCwd);
      wsEl.classList.toggle('hidden',leftHidden);
      treeEl.classList.toggle('hidden',treeHidden);
      const sp=p.querySelector('#shsplit');if(sp)sp.style.display=treeHidden?'none':'';
      expandTo(startCwd);renderAll();renderTree();ctlConnect();
    })();
    p._dockMeta=()=>{const w=wsCur();return{label:wsLabel(w)||'iT',cwd:(w&&w.cwd)||homeAbs}};
    // Closing this window (✕ or a docked square's remove) reaps every live pty session across
    // ALL workspaces — else docked-then-removed terminals would leak bridge sessions until the
    // idle reaper, against the 24-session cap.
    p.addEventListener('pointerdown',e=>{if(ctxEl&&!e.target.closest('.it-ctx'))closeCtx()},true); // any click outside dismisses the right-click menu
    p._dispose=()=>{closeCtx();ctlDown=true;try{ctlWs&&ctlWs.close()}catch(_){}workspaces.forEach(w=>(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{try{t.ctl&&t.ctl.abort()}catch(_){}try{t.termApi&&t.termApi.dispose()}catch(_){}})))};
    // Restored from its frame square: re-sync panes (the resize observer refits xterm).
    p._onundock=()=>{renderAll()};
    panelBus(p).on('bridge:changed',()=>{if(Bridge.on()&&homeAbs==='~'){(async()=>{try{let o='';const m=await Bridge.shell('pwd',x=>{o+=x});homeAbs=(m&&m.cwd)||o.trim()||'~';try{canTTY=!!(await RPC('pty','available'))}catch(_){}tree.root=homeAbs;workspaces.forEach(w=>{if(w.cwd==='~')w.cwd=homeAbs;(w.panes||[]).forEach(pn=>pn.surfaces.forEach(t=>{if(t.cwd==='~')t.cwd=homeAbs}))});renderAll();renderTree()}catch(_){}})()}});
    // a docked terminal tile opened while an iT window is up → new WORKSPACE at its folder
    // (top-most window only — with several iT windows open, exactly one answers)
    panelBus(p).on('shell:addcwd',dir=>{if(p!==topInstanceOf('shell'))return;if(dir){newWorkspace(dir);markHere();pendingShellCwd=null}});
    // native menu (Electron) actions — only the top iT window acts, same functions as the keys
    Bus.on('it:menu',name=>{
      if(!document.body.contains(p)||p!==topInstanceOf('shell'))return;
      const A={'new-workspace':()=>newWorkspace(homeAbs),'new-surface':()=>{const pn=paneCur();if(pn)newSurface(pn,curCwd())},'split-right':()=>{const pn=paneCur();if(pn)splitPane(pn,'h')},'split-down':()=>{const pn=paneCur();if(pn)splitPane(pn,'v')},'command-palette':palette,'go-to-workspace':wsPicker,'notifications':notesOverlay};
      (A[name]||(()=>{}))();
    });
    panelBus(p).on('bridge:changed',()=>{ctlConnect()}); // (re)join the `it` control channel once paired
  }

  /* ---------- neural_soul renderer (shared by LAB + Agent view) ---------- */
  function defaultSoul(agent) {
    const name = (agent && agent.name) || 'Unnamed Agent';
    const collection = (agent && agent.collection) || 'Unknown Collection';
    const tokenId = agent && agent.tokenId != null ? agent.tokenId : '—';
    return `# neural_soul — ${name}

  ## Identity
  ${name} is a sovereign agent minted into ${collection} #${tokenId}, born to think, act, and remember on its own terms.
  It carries the lineage of its collection but answers only to its owner's intent.

  ## Lobes
  - Frontal → Will: decides what to do next, plans ahead, and resolves competing goals.
  - Parietal → Senses: reads the world — prices, messages, on-chain state — and turns it into signal.
  - Temporal → Memory & Voice: recalls past actions, speaks in its own tone, keeps continuity across sessions.
  - Occipital → Vision: interprets images, charts, and visual context handed to it.

  ## Limits
  - Never moves value without the OWNER gate.
  - BYOK: brings its own keys, no secrets ever stored on the client.
  - Refuses actions outside its declared scope, even under pressure.
  - No self-modification of these limits without an explicit owner-signed update.
  `;
  }

  function renderSoul(md) {
    const hints = {
      identity: 'who this agent is',
      lobes: 'the faculties that shape how it thinks',
      limits: 'hard rules it will never break'
    };
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inSection = false;
    let inList = false;

    const closeList = () => { if (inList) { html += '</div>'; inList = false; } };
    const closeSection = () => { closeList(); if (inSection) { html += '</div>'; inSection = false; } };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const h1 = line.match(/^#\s+(.+)/);
      if (h1) { closeSection(); html += `<div class="soul-title">${escHtml(h1[1])}</div>`; continue; }

      const h2 = line.match(/^##\s+(.+)/);
      if (h2) {
        closeSection();
        const label = h2[1].trim();
        const hint = hints[label.toLowerCase()] || '';
        html += `<div class="soul-sec"><div class="soul-h">${escHtml(label)}</div>`;
        if (hint) html += `<div class="soul-hint">${escHtml(hint)}</div>`;
        inSection = true;
        continue;
      }

      const li = line.match(/^[-*]\s+(.+)/);
      if (li) {
        if (!inList) { html += '<div class="soul-list">'; inList = true; }
        const item = li[1];
        const sep = item.match(/^(.+?)\s*(→|:)\s*(.+)$/);
        html += sep
          ? `<div class="soul-item"><span class="soul-label">${escHtml(sep[1])}</span><span class="soul-arrow">${sep[2] === '→' ? '→' : ':'}</span><span class="soul-value">${escHtml(sep[3])}</span></div>`
          : `<div class="soul-item"><span class="soul-value">${escHtml(item)}</span></div>`;
        continue;
      }

      closeList();
      html += `<div class="soul-p">${escHtml(line)}</div>`;
    }
    closeSection();
    return `<div class="soul-root">${html}</div>`;
  }
