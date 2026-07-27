  // ── BROWSER panel (panel key `research`) ──────────────────────────────────
  // A real Chromium tab rendered inside CLONE FRAME. The bridge runs the page in a
  // dedicated Chrome engine (bridge/webengine.mjs, CDP over a pipe) and streams JPEG
  // screencast frames; this panel paints them to a <canvas> and forwards pointer +
  // keyboard input back over the same token-gated /mod/webengine RPC. No iframe, no
  // proxy-reader — every site renders with full JS/WebGL/video, like the Claude Code
  // desktop browser pane. `wireWebBrowser` keeps its name so registerPanel is unchanged.
  function wireWebBrowser(p){
    const root=p.querySelector('#wbrroot');if(!root)return;
    const el=id=>root.querySelector('#'+id);
    const inp=()=>el('wbrurl');
    const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return u||''}};
    // Local tab list. Each tab owns a CDP target id (`eid`) on the engine.
    let tabs=[], active=null, uid=0, paintT=0, decoding=false, since=0, metaT=0, hidden=false;
    // WS push plane (op=web): frames/meta arrive the instant Chrome produces them and
    // input rides the same socket — the 33ms HTTP poll below stays as the fallback.
    let ws=null, wsOk=false, lastPush=null, drawing=false, moveHold=null, moveT=0, wheelAcc=null, wheelT=0;
    const utf8=('TextDecoder' in window)?new TextDecoder():null;

    // Offline gate — same contract as every bridge-backed panel: park the ask, replay
    // it the moment the bridge pairs (wireWebBrowser re-runs and builds the real UI).
    if(!Bridge.on()){
      root.innerHTML='<div class="wbr-off"><span class="g"><svg><use href="#i-globe"/></svg></span><h3>Connect the HUB Bridge</h3><p>The Browser renders real pages through your machine. Connect the HUB Bridge in <b>MY MACHINE</b> to start browsing.</p><button class="btn acc" id="wbroff">Open MY MACHINE</button></div>';
      const b=root.querySelector('#wbroff');if(b)b.addEventListener('click',()=>openPanel('machine'));
      let pend=null;
      panelBus(p).on('web:open',d=>{if(p._wbr)return;const o=(typeof d==='string')?{url:d}:(d||{});if(o.target&&o.target!==p.dataset.key)return;if(o.url)pend=o});
      panelBus(p).on('bridge:changed',()=>{if(p._wbr||!Bridge.on())return;wireWebBrowser(p);if(pend){Bus.emit('web:open',Object.assign({},pend,{target:p.dataset.key}));pend=null}});
      return;
    }

    const at=()=>tabs.find(t=>t.id===active)||null;
    const eng=(fn,args)=>RPC('webengine',fn,args||{});
    const lockSync=v=>{const l=el('wbrlock');if(l)l.classList.toggle('secure',/^https:\/\//i.test((v||'').trim()))};

    // The blank layer shows exactly while the active tab holds no page — and with nothing
    // else on screen, the caret belongs in the address bar.
    function startSync(){
      const s=el('wbrstart');if(!s)return;
      const t=at(),blank=!t||!t.url||t.url==='about:blank';
      s.style.display=blank?'':'none';
      const x=inp();
      if(x)x.classList.toggle('blank',blank);
      if(blank&&!hidden&&x&&document.activeElement!==x)setTimeout(()=>{try{x.focus()}catch(_){}},30);
    }
    // ── the passkey moment ────────────────────────────────────────────────────
    // A passkey or security key prompt is drawn by a real browser WINDOW. The engine that
    // paints this canvas has none, so that prompt could never appear and the page waited
    // forever — the owner's "it just stops at 'confirm with your key'". The engine now
    // announces the ceremony instead of swallowing it: either it already holds a real
    // window (sign-in mode) and raises it, or it says so here and offers to turn that on.
    // The app's own window rect is what the engine hides behind, so it travels with it.
    let signinOn=false, coverT=0, coverSig='';
    // screenX/screenY are the VIEWPORT's origin on the desktop, so they pair with
    // inner*, never outer* — an outer size hung off the viewport origin overhangs the
    // window by its title bar, and the engine window pokes out below the app.
    const coverRect=()=>({left:window.screenX||0,top:window.screenY||0,
      width:window.innerWidth||1280,height:window.innerHeight||800});
    function coverWatch(on){
      if(coverT){clearInterval(coverT);coverT=0}
      const s=el('wbrsign');
      if(s){
        s.classList.toggle('on',!!on);
        s.title=on
          ? 'Sign-in window is open. Finish signing in there — click to bring the session back and close it.'
          : 'Sign in — opens a real browser window on this site so a password, passkey, security key or SMS code all work. It closes when you are done and the session comes back here.';
      }
      if(!on)return;
      // Dragging a window fires no event anywhere, so the rect is sampled. It is four
      // numbers and a string compare; the RPC only leaves when the window actually moved.
      // 1s was too slack in practice — the owner saw the real window still sitting at the
      // app's OLD position after moving it. Also fire on resize, which does have an event.
      pushCover();
      coverT=setInterval(pushCover,400);
      if(!p._wbrCoverRz){p._wbrCoverRz=()=>{if(signinOn)pushCover()};window.addEventListener('resize',p._wbrCoverRz)}
    }
    function pushCover(){
      const c=coverRect(),sig=[c.left,c.top,c.width,c.height].join(',');
      if(sig===coverSig)return;
      coverSig=sig;eng('setCover',c).catch(()=>{});
    }
    function pkHide(){const k=el('wbrpk');if(!k)return;k.style.display='none';k.innerHTML=''}
    function pkShow(html){const k=el('wbrpk');if(!k)return;k.innerHTML='<div class="wbr-pkbox">'+html+'</div>';k.style.display=''}
    // Open a real window on a site, sign in there, and have it GO AWAY — the session comes
    // back here in cookies. No external browser is left sitting around, which is the whole
    // point (owner's brief: "nenhuma janela exterior fica aberta").
    // Starting or finishing a sign-in RESTARTS the engine, so every socket gets {t:'down'}.
    // That is not a crash — it is this panel's own request coming back — and treating it as
    // one is what wiped the sign-in card (leaving no way to finish) and opened a spare tab,
    // which in sign-in mode is a second real window on the desktop. Both were reported.
    let siBusy=false;
    // After a relaunch every eid the panel holds is dead. Re-bind to what the engine
    // actually rebuilt instead of guessing.
    function adoptTabs(list,activeEid){
      tabs.forEach(x=>owned.delete(x.eid));
      tabs=(list||[]).filter(x=>x&&x.id).map(x=>{owned.add(x.id);return{id:'t'+(++uid),eid:x.id,url:x.url||'',title:x.title||''}});
      since=0;
      if(!tabs.length){active=null;newTab('');return}
      active=(tabs.find(x=>x.eid===activeEid)||tabs[tabs.length-1]).id;
      setActive(active);
    }
    // A sign-in belongs to the SITE, never to the identity provider. Pressing SIGN IN while
    // already inside Google's flow used to open the window on accounts.google.com — the
    // wrong place to start, and a page the "finished" test can never leave. So the panel
    // remembers the last real site it was on and signs in THERE.
    const AUTHY=/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com|duosecurity\.com)$/i;
    const isAuthUrl=u=>{try{const x=new URL(u);return AUTHY.test(x.hostname)||/^\/(login|signin|sign_in|session|sessions|oauth|authorize)/i.test(x.pathname)}catch(_){return false}};
    let siteOrigin='';
    function noteSite(u){try{const x=new URL(u);if(/^https?:$/.test(x.protocol)&&!AUTHY.test(x.hostname))siteOrigin=x.origin}catch(_){}}

    async function signinBegin(url){
      if(signinOn||siBusy){Toast&&Toast.show('A sign-in window is already open');return false}
      const t=at();
      const here=url||(t&&t.url)||'';
      let origin='';
      try{origin=new URL(here).origin}catch(_){origin=''}
      if(!origin||isAuthUrl(here))origin=siteOrigin||origin;
      if(!origin){Toast&&Toast.show('Open the site you want to sign in to first');return false}
      pkShow('<h3>Opening a sign-in window…</h3><p>A real browser window is coming up on <b>'+escHtml(hostOf(origin))+'</b>.</p>');
      siBusy=true;
      const r=await eng('signinStart',{url:origin,cover:coverRect()}).catch(e=>({ok:false,error:String((e&&e.message)||e)}));
      siBusy=false;
      if(!r||r.ok===false){pkHide();Toast&&Toast.show('Could not open the sign-in window: '+((r&&r.error)||'engine refused'));return false}
      adoptTabs([{id:r.id,url:r.url}],r.id);
      signinOn=true;coverSig='';coverWatch(true);siCard();
      return true;
    }
    function siCard(lead){
      pkShow('<h3>Sign in in the window</h3>'+
        '<p>'+(lead||'A real browser window is in front. Sign in there however you like — password, passkey, security key, a code by SMS.')+'</p>'+
        '<p class="fine">When you are done the window closes and your session comes back here. Nothing stays open.</p>'+
        '<div class="row"><button class="btn acc" id="wbrsidone">I’m done</button><button class="btn" id="wbrsicancel">Cancel</button></div>');
      const d=el('wbrsidone'),c=el('wbrsicancel');
      if(d)d.addEventListener('click',()=>signinEnd());
      if(c)c.addEventListener('click',async()=>{
        pkShow('<h3>Closing the window…</h3><p>Nothing is carried back.</p>');
        siBusy=true;
        const r=await eng('signinCancel').catch(()=>null);
        siBusy=false;
        signinOn=false;coverWatch(false);pkHide();try{window.focus()}catch(_){}
        if(r&&r.tabs)adoptTabs(r.tabs,null);
      });
    }
    let siEnding=false;
    async function signinEnd(){
      if(!signinOn||siEnding)return;
      siEnding=true;
      pkShow('<h3>Bringing your session back…</h3><p>Closing the window and carrying the session into CLONE FRAME.</p>');
      siBusy=true;
      const r=await eng('signinFinish').catch(e=>({ok:false,error:String((e&&e.message)||e)}));
      siBusy=false;
      signinOn=false;siEnding=false;coverWatch(false);pkHide();
      try{window.focus()}catch(_){}
      if(!r||r.ok===false){Toast&&Toast.show('Sign-in window closed — '+((r&&r.error)||'nothing carried'));return}
      adoptTabs(r.tabs,(r.tabs&&r.tabs.length)?r.tabs[r.tabs.length-1].id:null);
      Toast&&Toast.show(r.restored
        ? 'Signed in · '+r.restored+'/'+(r.carried||0)+' cookies carried'+(r.rejected?' ('+r.rejected+' refused)':'')+' · no window left open'
        : 'Window closed, but nothing carried — the site keeps its session outside cookies');
    }
    function pkOn(m){
      if(m.phase==='done'){pkHide();try{window.focus()}catch(_){}return}
      const host=hostOf(m.origin||'')||'This page';
      if(m.phase==='open'){
        // macOS has no way to send a window back down (minimize+restore raises it again,
        // measured), so the honest instruction is the true one: click back here.
        pkShow('<h3>Approve with your key</h3><p><b>'+escHtml(host)+'</b> is asking for your passkey. The real sign-in window is now in front — approve it there, then click back on CLONE FRAME. The page carries on here.</p>');
        return;
      }
      pkShow('<h3>This sign-in needs your key</h3>'+
        '<p><b>'+escHtml(host)+'</b> asked for a passkey or security key. That prompt is drawn by a real browser window; the Browser paints an engine that has none, so it can never appear and the page would wait forever.</p>'+
        '<p class="fine">A sign-in window opens on this site, you sign in there with your key, and it closes again — your session comes back here and nothing stays open.</p>'+
        '<div class="row"><button class="btn acc" id="wbrpkgo">Open a sign-in window</button><button class="btn" id="wbrpkno">Use another method</button></div>');
      const no=el('wbrpkno'),go=el('wbrpkgo');
      // Refusing answers the page with NotAllowedError, which is what makes a site show
      // its "try another way" — silence is the one thing that helps nobody.
      if(no)no.addEventListener('click',()=>{eng('passkey',{tag:m.tag,verdict:'refuse'}).catch(()=>{});pkHide()});
      if(go)go.addEventListener('click',async()=>{
        go.disabled=true;go.textContent='Opening…';
        // The waiting page is answered before the engine restarts under it.
        await eng('passkey',{tag:m.tag,verdict:'refuse'}).catch(()=>{});
        await signinBegin(m.origin||(at()&&at().url)||'');
      });
    }

    const cleanTitle=t=>{const x=(t.title||'').trim();return (!x||x==='about:blank'||x===t.url)?(hostOf(t.url)||''):x};
    function renderTabs(){
      startSync();
      const strip=el('wbrtabs');if(!strip)return;
      const btns=tabs.map(t=>`<button class="wbr-tab${t.id===active?' on':''}" data-id="${t.id}"><span class="wbr-tl">${escHtml((cleanTitle(t)||'New tab').slice(0,24))}</span><span class="wbr-tx" data-x="${t.id}">✕</span></button>`).join('');
      strip.innerHTML=btns+'<button class="wbr-new" id="wbrnew" title="New tab (⌘T)">＋</button>';
      el('wbrnew').addEventListener('click',()=>{newTab('');const x=inp();if(x)x.focus()});
      strip.querySelectorAll('.wbr-tab').forEach(b=>b.addEventListener('click',e=>{
        const x=e.target.closest('.wbr-tx');
        if(x){closeTab(x.dataset.x);return}
        setActive(b.dataset.id);
      }));
    }
    function addrSync(t){const i=inp();if(i&&document.activeElement!==i){i.value=(t&&t.url)||'';lockSync(i.value)}}

    // Cross-window ownership: eids claimed by any live BROWSER window, so two ⧉
    // windows never fight over one engine tab and reload-adoption can't double-claim.
    const owned=(window.__cfwbrOwned=window.__cfwbrOwned||new Set());
    async function newTab(url){
      const u=(url||'').trim();
      const r=await eng('open',{url:u&&/^https?:/i.test(u)?u:'about:blank'}).catch(()=>({ok:false}));
      if(!r||!r.ok){Toast&&Toast.show('Browser engine unavailable');return null}
      owned.add(r.id);
      const t={id:'t'+(++uid),eid:r.id,url:u&&/^https?:/i.test(u)?u:'',title:''};
      tabs.push(t);setActive(t.id);
      if(u&&!/^https?:/i.test(u)&&u)nav(t,u);
      return t;
    }
    // The browser always opens BLANK (owner's order, 2026-07-25). The first window to
    // mount destroys whatever the engine still held — the private context of a previous
    // run, tabs left behind by a ⌘R or a crash — and starts from nothing. Later ⧉ windows
    // (some other window is already holding tabs) just add their own blank tab.
    // `ifIdle` lets the ENGINE decide: `owned` only knows about THIS document, so a second
    // browser window (or the second app window) used to arrive believing nothing was open
    // and wipe the first one's tabs away. The engine wipes only when nobody is watching.
    async function openClean(){
      if(!owned.size)await eng('wipe',{ifIdle:true}).catch(()=>{});
      newTab('');
    }
    function closeTab(id){
      const i=tabs.findIndex(t=>t.id===id);if(i<0)return;
      const[t]=tabs.splice(i,1);
      owned.delete(t.eid);wsSend({t:'unwatch',id:t.eid});
      eng('castStop',{id:t.eid}).catch(()=>{});eng('close',{id:t.eid}).catch(()=>{});
      if(active===id)active=(tabs[i]||tabs[i-1]||tabs[0]||{}).id||null;
      if(!tabs.length)newTab('');else{setActive(active)}
    }
    function setActive(id){
      active=id;const t=at();
      tabs.forEach(x=>{if(x.eid&&x.id!==id)eng('castStop',{id:x.eid}).catch(()=>{})});
      if(t){since=0;castOn(t);addrSync(t)}
      // Watch EVERY panel tab, not just the active one: a watch is the engine-side
      // keep-alive — an unwatched tab is reaped after 2min and the strip would keep
      // showing a dead handle (measured: a background tab vanished mid-session).
      // Background watches cost only tab-meta pushes — frames flow only for the
      // casting tab — and they keep background tab titles live as a bonus.
      tabs.forEach(x=>{if(x.eid)wsSend({t:'watch',id:x.eid,bin:true})});
      renderTabs();
    }
    // Retina-real. The viewport stays in CSS px (so input coords never scale) while the
    // CAST asks for stage×dpr TRUE pixels — the engine now runs at device scale 2, which
    // is what actually decides a screencast frame's resolution (measured: without it,
    // asking for 2400×1400 still returned 1200×700 and the canvas upscaled it — that was
    // the soft picture). setViewport's `scale` is what makes the PAGE report dpr 2, so
    // sites serve their 2× images instead of the 1× ones the owner was seeing.
    // MAXPX bounds a maximized window on a large display: 4× the pixels must not become
    // frames nobody can move in time. quality 64 at true 2× beats quality 82 at 1× on
    // both counts — sharper AND ~1.8× the bytes for 4× the pixels (measured).
    const CAST_MAXPX=3.6e6;
    // The viewport is set BEFORE the cast starts, and awaited: a tab that begins casting
    // at the engine's default desktop size and is resized a tick later can keep showing
    // that first mis-sized frame forever, because a static page has no reason to repaint.
    async function castOn(t){
      if(!t||!t.eid||hidden)return;
      const st=stageSize(),dpr=Math.min(2,window.devicePixelRatio||1);
      const px=st.w*st.h*dpr*dpr,s=px>CAST_MAXPX?dpr*Math.sqrt(CAST_MAXPX/px):dpr;
      // Zoom IS the viewport: a page laid out in stage/zoom css pixels, painted across the
      // whole stage, is magnified by exactly zoom — with real reflow, like Chrome's.
      await eng('setViewport',{id:t.eid,width:Math.round(st.w/zoom),height:Math.round(st.h/zoom),scale:dpr}).catch(()=>{});
      eng('castStart',{id:t.eid,maxWidth:Math.round(st.w*s),maxHeight:Math.round(st.h*s),quality:64}).catch(()=>{});
    }

    // Address-bar normalization: full URL → as-is; bare domain (has a dot, no space)
    // → https://; anything else → a web search. The engine accepts http(s) only.
    function normUrl(q){
      q=(q||'').trim();if(!q)return'';
      if(/^https?:\/\//i.test(q))return q;
      if(/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(q))return'http://'+q;
      if(/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(q)&&!/\s/.test(q))return'https://'+q;
      return'https://www.google.com/search?q='+encodeURIComponent(q);
    }
    // net:: codes are engine vocabulary — say what happened in the owner's language.
    const NETMSG={
      'net::ERR_NAME_NOT_RESOLVED':"Can't find that site — check the address",
      'net::ERR_INTERNET_DISCONNECTED':'No internet connection',
      'net::ERR_CONNECTION_REFUSED':'The site refused the connection',
      'net::ERR_CONNECTION_TIMED_OUT':'The site took too long to answer',
      'net::ERR_CONNECTION_RESET':'The connection was interrupted — try again',
      'net::ERR_CERT_AUTHORITY_INVALID':"The site's security certificate is not trusted",
      'net::ERR_CERT_COMMON_NAME_INVALID':"The site's security certificate doesn't match its address",
    };
    async function nav(t,q){
      t=t||at()||await newTab('');if(!t)return;
      const u=normUrl(q);if(!u)return;
      progStart();
      const r=await eng('navigate',{id:t.eid,url:u}).catch(e=>({ok:false,error:String(e&&e.message||e)}));
      if(r&&r.ok){
        // Bridge/engine restarted mid-browse: navigate() heals by opening a fresh
        // target and answers with ITS id — re-bind this tab to it (watch + cast),
        // otherwise the window keeps casting a dead handle forever (frozen canvas).
        if(r.id&&r.id!==t.eid){owned.delete(t.eid);t.eid=r.id;owned.add(r.id);since=0;castOn(t);wsSend({t:'watch',id:t.eid,bin:true})}
        t.url=r.url||u;
      }
      else Toast&&Toast.show(NETMSG[r&&r.error]||(r&&r.error)||'Could not open that');
      addrSync(t);
    }
    function progStart(){const b=el('wbrprog');if(!b)return;b.classList.remove('done');b.classList.add('run');b.style.width='16%';setTimeout(()=>{if(b.classList.contains('run'))b.style.width='82%'},200)}
    function progDone(){const b=el('wbrprog');if(!b)return;b.classList.add('done');b.classList.remove('run');b.style.width='100%';setTimeout(()=>{if(b){b.style.width='0';b.classList.remove('done')}},380)}

    // ── downloads: a strip that exists ONLY while something is downloading (and for a few
    // seconds after it lands), so a blank browser stays blank. Files go to ~/Downloads —
    // the browser session is ephemeral, a file the owner asked for by name is not.
    const dls=new Map();
    const fmtB=n=>{if(!n)return '0B';const u=['B','KB','MB','GB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return (v<10?v.toFixed(1):Math.round(v))+u[i]};
    function renderDl(){
      const box=el('wbrdl');if(!box)return;
      const list=[...dls.values()];
      if(!list.length){box.style.display='none';box.innerHTML='';return}
      box.style.display='';
      box.innerHTML=list.map(d=>{
        const pct=d.state==='completed'?100:(d.total?Math.min(100,Math.round(d.got/d.total*100)):0);
        const st=d.state==='completed'?'saved to Downloads':d.state==='canceled'?'canceled':(d.total?fmtB(d.got)+' of '+fmtB(d.total):fmtB(d.got));
        // escAttr inside the quotes, escHtml for text: a server picks the filename, and a
        // name carrying a double quote would otherwise walk straight out of the attribute.
        return `<div class="wbr-dlrow${d.state==='completed'?' done':''}"><i style="width:${pct}%"></i><span class="n">${escHtml(d.name)}</span><span class="s">${escHtml(st)}</span>${d.path?`<button data-p="${escAttr(d.path)}" title="Copy the file path">copy path</button>`:''}<button data-x="${escAttr(d.id)}" title="Dismiss">✕</button></div>`;
      }).join('');
      box.querySelectorAll('[data-x]').forEach(b=>b.addEventListener('click',()=>{dls.delete(b.dataset.x);renderDl()}));
      box.querySelectorAll('[data-p]').forEach(b=>b.addEventListener('click',()=>{try{navigator.clipboard.writeText(b.dataset.p);Toast&&Toast.show('Path copied')}catch(_){Toast&&Toast.show('Could not copy')}}));
    }
    // ── uploads. The web deliberately never gives a page's chooser a real path, and the
    // engine needs one, so the bytes are staged by the bridge and the path handed over.
    // Nothing is read from disk on the owner's behalf: he picks the file himself, in the
    // macOS panel he knows.
    function pickUpload(m){
      const t=at();if(!t||t.eid!==m.id)return;
      const inp=document.createElement('input');
      inp.type='file';inp.style.display='none';
      if(m.mode==='selectMultiple')inp.multiple=true;
      p.appendChild(inp);
      const done=()=>{try{inp.remove()}catch(_){}};
      inp.addEventListener('change',async()=>{
        const files=[...(inp.files||[])].slice(0,10);
        if(!files.length){done();return}
        const staged=[];
        for(const f of files){
          try{
            const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=rej;r.readAsDataURL(f)});
            const s=await eng('stageUpload',{name:f.name,data:b64});
            if(s&&s.ok)staged.push(s.path);else Toast&&Toast.show((s&&s.error)||('Could not prepare '+f.name));
          }catch(_){Toast&&Toast.show('Could not read '+f.name)}
        }
        if(staged.length){
          const r=await eng('setFiles',{id:t.eid,node:m.node,files:staged}).catch(()=>null);
          Toast&&Toast.show((r&&r.ok)?(staged.length===1?'Sent '+files[0].name:'Sent '+staged.length+' files'):'The page did not accept the file');
        }
        done();
      });
      inp.addEventListener('cancel',done);
      inp.click();
    }
    function dlSweep(){let ch=false;const now=Date.now();dls.forEach((d,k)=>{if(d.done&&now-d.done>9000){dls.delete(k);ch=true}});if(ch)renderDl()}

    // ── page context menu — the app's own menu chrome (.it-ctx), so every right-click in
    // CLONE FRAME looks and behaves the same. Built from what is actually under the
    // pointer: no dead entries, no "Open link" over empty space.
    let ctxEl=null;
    const closeCtx=()=>{if(ctxEl){ctxEl.remove();ctxEl=null}};
    function showCtx(cx,cy,items){
      closeCtx();
      const m=document.createElement('div');m.className='it-ctx';
      m.innerHTML=items.map(it=>it?`<button>${escHtml(it.label)}${it.key?`<span class="k">${escHtml(it.key)}</span>`:''}</button>`:'<div class="dv"></div>').join('');
      p.appendChild(m);ctxEl=m;
      const bs=m.querySelectorAll('button');
      items.filter(Boolean).forEach((it,i)=>bs[i].addEventListener('click',()=>{closeCtx();if(it.fn)it.fn()}));
      const pr=p.getBoundingClientRect();
      let L=cx-pr.left,T=cy-pr.top;
      if(L+m.offsetWidth>pr.width-8)L=pr.width-m.offsetWidth-8;
      if(T+m.offsetHeight>pr.height-8)T=pr.height-m.offsetHeight-8;
      m.style.left=Math.max(4,L)+'px';m.style.top=Math.max(4,T)+'px';
    }
    const copyTo=(text,what)=>{try{navigator.clipboard.writeText(text);Toast&&Toast.show(what+' copied')}catch(_){Toast&&Toast.show('Could not reach the clipboard')}};
    async function pageMenu(ev,pt){
      const t=at();if(!t)return;
      const h=await eng('hitTest',{id:t.eid,x:pt.x,y:pt.y}).catch(()=>null);
      const hit=(h&&h.ok)?h:{link:'',img:'',editable:false,selection:''};
      showCtx(ev.clientX,ev.clientY,[
        ...(hit.link?[
          {label:'Open Link in New Tab',fn:()=>newTab(hit.link)},
          {label:'Copy Link Address',fn:()=>copyTo(hit.link,'Link')},
          null]:[]),
        ...(hit.img?[{label:'Copy Image Address',fn:()=>copyTo(hit.img,'Image address')},null]:[]),
        ...(hit.selection?[{label:'Copy',key:'⌘C',fn:()=>copyTo(hit.selection,String(hit.selection.length)+' characters')}]:[]),
        ...(hit.editable?[{label:'Paste',key:'⌘V',fn:()=>navigator.clipboard.readText().then(x=>{if(x)eng('type',{id:t.eid,text:x.slice(0,100000)}).catch(()=>{})}).catch(()=>Toast&&Toast.show('The clipboard is not readable here'))}]:[]),
        {label:'Select All',key:'⌘A',fn:()=>eng('selectAll',{id:t.eid}).catch(()=>{})},
        null,
        {label:'Back',fn:()=>{progStart();eng('back',{id:t.eid}).catch(()=>{})}},
        {label:'Forward',fn:()=>{progStart();eng('forward',{id:t.eid}).catch(()=>{})}},
        {label:'Reload',key:'⌘R',fn:()=>{progStart();eng('reload',{id:t.eid}).catch(()=>{})}},
        null,
        {label:'Find on Page…',key:'⌘F',fn:()=>openFind()},
      ]);
    }

    // ── find on page (⌘F) — window.find in the engine both scrolls to the hit and selects
    // it, so the owner sees the match instead of being told a number.
    function openFind(){
      const b=el('wbrfind');if(!b)return;
      b.style.display='';
      const i=b.querySelector('input');i.focus();i.select();
    }
    function closeFind(){const b=el('wbrfind');if(!b)return;b.style.display='none';const c=el('wbrcanvas');if(c)c.focus()}
    async function runFind(back){
      const t=at(),b=el('wbrfind');if(!t||!b)return;
      const q=b.querySelector('input').value.trim();
      b.classList.remove('miss');
      if(!q)return;
      const r=await eng('findText',{id:t.eid,query:q,backwards:!!back}).catch(()=>null);
      if(!r||!r.ok||!r.found)b.classList.add('miss');
    }

    // ── zoom — a real browser zoom: the engine lays the page out in a SMALLER viewport and
    // the same canvas shows it, so text reflows and grows exactly as it does in Chrome.
    // (Input coordinates divide by it — see xy() — or clicks would land off-target.)
    let zoom=1;
    const ZOOMS=[0.5,0.67,0.8,0.9,1,1.1,1.25,1.5,1.75,2];
    function setZoom(z){
      const t=at();if(!t)return;
      zoom=Math.min(2,Math.max(0.5,z));
      castOn(t);
      Toast&&Toast.show('Zoom '+Math.round(zoom*100)+'%');
    }
    const zoomStep=d=>{const i=ZOOMS.findIndex(v=>Math.abs(v-zoom)<0.001);const n=Math.min(ZOOMS.length-1,Math.max(0,(i<0?4:i)+d));setZoom(ZOOMS[n])};

    function stageSize(){const st=el('wbrstage');if(!st)return{w:1000,h:680};const r=st.getBoundingClientRect();return{w:Math.max(320,Math.round(r.width)),h:Math.max(240,Math.round(r.height))}}

    // ── frame loop: poll the latest screencast frame and paint it 1:1 (engine
    // viewport is kept equal to the canvas CSS size, so input coords need no scaling).
    // Driven by setInterval, not requestAnimationFrame: rAF is fully paused when the
    // app window/tab is backgrounded, which would freeze even the on-screen browser
    // in some hosts; a timer keeps painting (and self-throttles when the panel hides).
    function paintImg(img){const c=el('wbrcanvas');if(!c)return;const dpr=Math.min(2,window.devicePixelRatio||1);const st=stageSize();if(c.width!==Math.round(st.w*dpr)||c.height!==Math.round(st.h*dpr)){c.width=Math.round(st.w*dpr);c.height=Math.round(st.h*dpr)}const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height)}
    function paintTick(){
      const t=at();if(!t||!t.eid||decoding)return;
      if(p.style.display==='none'||!document.body.contains(p)){if(!hidden){hidden=true;tabs.forEach(x=>x.eid&&eng('castStop',{id:x.eid}).catch(()=>{}))}return}
      if(hidden){hidden=false;castOn(t)}
      if(wsOk)return; // frames are pushed — this interval is only the fallback poller
      decoding=true;
      eng('frame',{id:t.eid,since}).then(r=>{
        if(!r||!r.ok||!r.data){decoding=false;return}
        since=r.seq;
        const img=new Image();
        img.onload=()=>{paintImg(img);decoding=false;progDone()};
        img.onerror=()=>{decoding=false};
        img.src='data:image/jpeg;base64,'+r.data;
      }).catch(()=>{decoding=false});
    }
    // pushed frames: decode-latest-only — if frames arrive faster than we can decode,
    // intermediate ones are dropped so the picture never lags behind the page.
    // Binary frames (`f.jpeg`, the WS default) decode via createImageBitmap — off the
    // main thread, no base64 round-trip; the JSON+base64 shape stays as the fallback.
    function drawPushed(){
      if(drawing||!lastPush)return;
      const f=lastPush;lastPush=null;drawing=true;
      const done=()=>{drawing=false;if(lastPush)drawPushed()};
      if(f.jpeg&&window.createImageBitmap){
        createImageBitmap(new Blob([f.jpeg],{type:'image/jpeg'})).then(bm=>{paintImg(bm);bm.close();progDone();done()}).catch(done);
        return;
      }
      const img=new Image();
      img.onload=()=>{paintImg(img);progDone();done()};
      img.onerror=done;
      img.src=f.jpeg?URL.createObjectURL(new Blob([f.jpeg],{type:'image/jpeg'})):'data:image/jpeg;base64,'+f.data;
    }
    // periodic light meta refresh (url/title) — fallback only; over WS the engine
    // pushes {t:'tab'} the instant a page's url/title changes.
    function metaLoop(){metaT=setTimeout(metaLoop,900);dlSweep();if(wsOk)return;eng('tabs').then(r=>{if(!Array.isArray(r))return;const by={};r.forEach(x=>by[x.id]=x);let ch=false;tabs.forEach(t=>{const e=by[t.eid];if(e){if(e.url&&e.url!==t.url&&e.url!=='about:blank'){t.url=e.url;ch=true}if(e.title&&e.title!==t.title){t.title=e.title;ch=true}}});if(ch){renderTabs();addrSync(at())}}).catch(()=>{})}

    // ── WS push plane — same /stream endpoint as the terminal, op=web; token rides
    // the subprotocol (never the URL). Falls back to the HTTP poll loop on failure.
    const wsSend=o=>{try{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))}catch(_){}};
    function wsConnect(){
      // Same store as every other live socket — see BridgeClient.wsAuth.
      const b=BridgeClient.wsAuth();if(!b.token)return;
      let s;try{s=new WebSocket(b.endpoint.replace(/^http/,'ws')+'/stream?op=web',['cfhub','cfhub.bearer.'+b.token])}catch(_){return}
      s.binaryType='arraybuffer';
      ws=s;
      s.onopen=()=>{wsOk=true;tabs.forEach(x=>{if(x.eid)wsSend({t:'watch',id:x.eid,bin:true})})};
      s.onmessage=e=>{
        if(e.data instanceof ArrayBuffer){
          // binary frame: [u32 header-len][JSON header][JPEG bytes] — no base64, no giant JSON.parse
          if(e.data.byteLength<5||!utf8)return;
          const n=new DataView(e.data).getUint32(0);if(4+n>e.data.byteLength)return;
          let h;try{h=JSON.parse(utf8.decode(new Uint8Array(e.data,4,n)))}catch(_){return}
          const t=at();if(h.t==='frame'&&t&&t.eid===h.id){since=h.seq;lastPush={jpeg:e.data.slice(4+n)};drawPushed()}
          return;
        }
        let m;try{m=JSON.parse(e.data)}catch(_){return}
        if(m.t==='frame'){const t=at();if(t&&t.eid===m.id){since=m.seq;lastPush=m;drawPushed()}}
        else if(m.t==='tab'){const t=tabs.find(x=>x.eid===m.id);if(t){let ch=false;
          // chrome-error:// is engine vocabulary — a failed navigation keeps the LAST
          // real address in the bar/label (Chrome's own bar does the same).
          if(m.url&&m.url!=='about:blank'&&!/^chrome-error:/.test(m.url)&&m.url!==t.url){t.url=m.url;ch=true;noteSite(m.url);if(/google\.[^/]+\/sorry\//.test(m.url))Toast&&Toast.show('Google is asking for a human check — solve it right here, once')}
          if(m.title&&m.title!=='about:blank'&&!/^chrome-error:/.test(m.title)&&m.title!==t.title){t.title=m.title;ch=true}
          if(ch){renderTabs();addrSync(at())}}}
        else if(m.t==='loading'){const t=at();if(t&&t.eid===m.id){if(m.on)progStart();else progDone()}}
        // A page opened a page: target="_blank", window.open. The engine routes it to the
        // window that caused it (opener watch, else the socket that carried the click), and
        // it becomes a real tab here — exactly what Chrome does. Before this, those pages
        // existed only inside the engine: the owner clicked GitHub, saw nothing, and the
        // invisible page kept rendering (owner report + 13 leaked tabs, 2026-07-25).
        else if(m.t==='popup'){
          if(owned.has(m.id))return; // another window already adopted it
          owned.add(m.id);
          const t={id:'t'+(++uid),eid:m.id,url:(m.url&&m.url!=='about:blank')?m.url:'',title:''};
          tabs.push(t);setActive(t.id);
        }
        // A download the engine started for us. Before this the click was simply eaten:
        // headless Chrome denies downloads unless told otherwise, so nothing happened at
        // all — no file, no message (measured 2026-07-25).
        else if(m.t==='dl'){
          const d=dls.get(m.id)||{id:m.id};
          Object.assign(d,{name:m.name,url:m.url,state:m.state,got:m.got,total:m.total});
          if(m.path)d.path=m.path;
          if(m.state!=='inProgress'&&!d.done)d.done=Date.now();
          dls.set(m.id,d);renderDl();
        }
        // The page wants a file. Put the owner's REAL macOS picker up — the file never
        // leaves his hands until he chooses it — then stage the bytes and answer the page.
        else if(m.t==='file'){pickUpload(m)}
        // While a sign-in is live an empty tab list must stay empty: opening one would be
        // opening another real window, which is what the owner saw when he closed the
        // sign-in window and a new one appeared in its place.
        else if(m.t==='gone'){const i=tabs.findIndex(x=>x.eid===m.id);if(i>=0){tabs.splice(i,1);if(!tabs.length){if(signinOn||siBusy){renderTabs()}else newTab('')}else if(!at())setActive((tabs[i]||tabs[i-1]||tabs[0]).id);else renderTabs()}}
        else if(m.t==='passkey')pkOn(m);
        // The engine noticed the sign-in window came back to the site it started on and
        // settled there: finish without making the owner say so.
        else if(m.t==='signin'&&m.phase==='ready'&&signinOn)signinEnd();
        // A restart this panel asked for is not a crash: keep the card, keep the tabs, and
        // let signinBegin/signinEnd re-bind to what the engine rebuilt.
        else if(m.t==='down'){if(siBusy)return;tabs=[];renderTabs();pkHide();newTab('');Toast&&Toast.show('Browser engine restarted')}
      };
      s.onclose=()=>{if(ws!==s)return;ws=null;wsOk=false;if(document.body.contains(p))setTimeout(wsConnect,1500)};
      s.onerror=()=>{};
    }

    // ── input forwarding (canvas CSS px == engine viewport px). Mouse moves coalesce
    // to one per 10ms; wheel deltas ACCUMULATE into one event per 16ms — a trackpad
    // momentum scroll fires hundreds of wheel events and each used to be its own
    // serialized round-trip, so the queue ran seconds behind the finger. Held moves
    // and wheels always flush BEFORE a click/key so the page sees them in order.
    function rawSend(events){const t=at();if(!t||!t.eid||!events.length)return;if(wsOk)wsSend({t:'input',id:t.eid,events});else eng('input',{id:t.eid,events}).catch(()=>{})}
    function flushHeld(){
      const evs=[];
      if(moveT){clearTimeout(moveT);moveT=0}
      if(wheelT){clearTimeout(wheelT);wheelT=0}
      if(moveHold){evs.push(moveHold);moveHold=null}
      if(wheelAcc){evs.push(wheelAcc);wheelAcc=null}
      if(evs.length)rawSend(evs);
    }
    function sendInput(ev){
      if(ev.kind==='mouse'&&ev.type==='move'){
        moveHold=ev;
        if(!moveT)moveT=setTimeout(()=>{moveT=0;const h=moveHold;moveHold=null;if(h)rawSend([h])},10);
        return;
      }
      if(ev.kind==='wheel'){
        if(wheelAcc){wheelAcc.deltaX+=ev.deltaX;wheelAcc.deltaY+=ev.deltaY;wheelAcc.x=ev.x;wheelAcc.y=ev.y}
        else wheelAcc=Object.assign({},ev);
        if(!wheelT)wheelT=setTimeout(()=>{wheelT=0;const w=wheelAcc;wheelAcc=null;if(w)rawSend([w])},16);
        return;
      }
      flushHeld();
      rawSend([ev]);
    }
    function wireCanvas(){
      const c=el('wbrcanvas');if(!c)return;
      // Canvas CSS px → page px. At zoom z the engine's viewport is 1/z of the canvas, so
      // every coordinate must be divided by z or the click lands somewhere else entirely.
      const xy=e=>{const r=c.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)/zoom),y:Math.round((e.clientY-r.top)/zoom)}};
      const BUT=b=>b===2?'right':b===1?'middle':'left';
      // Modifiers were dropped on the floor, so ⌘-click reached the page as a PLAIN click:
      // "open in a new tab" navigated in place instead, and shift/alt gestures were lost too.
      const MODS=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
      c.addEventListener('mousemove',e=>{const q=xy(e);sendInput({kind:'mouse',type:'move',x:q.x,y:q.y,modifiers:MODS(e)})});
      // ⌘-click and middle-click mean "open this link in a new tab". Headless Chrome does
      // NOT honour that itself — there is no tab strip for it to open into, and the click
      // simply evaporates (measured: neither a same-origin nor an external link produced
      // anything). So the browser does its own job: hit-test the link and open it here.
      const newTabClick=e=>(e.button===1)||(e.button===0&&e.metaKey);
      c.addEventListener('mousedown',e=>{
        if(e.button===2)return;
        const q=xy(e);
        if(newTabClick(e)){
          e.preventDefault();const t=at();if(!t)return;
          eng('hitTest',{id:t.eid,x:q.x,y:q.y}).then(h=>{if(h&&h.ok&&h.link)newTab(h.link)}).catch(()=>{});
          return;
        }
        c.focus();sendInput({kind:'mouse',type:'down',x:q.x,y:q.y,button:BUT(e.button),clickCount:e.detail||1,modifiers:MODS(e)});
      });
      c.addEventListener('mouseup',e=>{if(e.button===2||newTabClick(e))return;const q=xy(e);sendInput({kind:'mouse',type:'up',x:q.x,y:q.y,button:BUT(e.button),clickCount:e.detail||1,modifiers:MODS(e)})});
      // Right-click used to be swallowed with nothing offered in its place. Ask the page
      // what is under the pointer, then offer exactly what applies to it.
      c.addEventListener('contextmenu',e=>{e.preventDefault();pageMenu(e,xy(e))});
      // CDP wheel deltas follow the DOM sign convention (positive deltaY scrolls DOWN)
      // — proven empirically; the old negation inverted the owner's trackpad scrolling.
      c.addEventListener('wheel',e=>{e.preventDefault();const q=xy(e);sendInput({kind:'wheel',x:q.x,y:q.y,deltaX:e.deltaX,deltaY:e.deltaY})},{passive:false});
      c.tabIndex=0;
      c.addEventListener('keydown',e=>{
        // The app's own shortcuts win — they belong to the browser, not to the page:
        // ⌘L address · ⌘T tab · ⌘W close · ⌘R reload · ⌘F find · ⌘+ ⌘− ⌘0 zoom · ⌘K palette.
        // This is the ONLY list allowed to keep bubbling now that everything else stops here,
        // and its test must mirror the window router's (⌘ OR ⌃) or ⌃T dies on Windows.
        if((e.metaKey||e.ctrlKey)&&['l','t','w','r','f','k','=','+','-','0'].includes(String(e.key||'').toLowerCase()))return;
        if(e.key==='Escape'&&(ctxEl||(el('wbrfind')||{}).style?.display===''))
          {e.preventDefault();closeCtx();closeFind();return}
        // Clipboard has to be BRIDGED: the page lives in another process, so its own ⌘C
        // reaches nobody — text simply could not be taken out of a page. Read the
        // selection from the engine and put it on the app's clipboard; paste goes the
        // other way as inserted text. ⌘A stays a plain forward — the page selects itself.
        const ck=e.key.toLowerCase();
        if((e.metaKey||e.ctrlKey)&&ck==='a'){e.preventDefault();const t=at();if(t)eng('selectAll',{id:t.eid}).catch(()=>{});return}
        if((e.metaKey||e.ctrlKey)&&(ck==='c'||ck==='x')){
          e.preventDefault();const t=at();if(!t)return;
          eng('selection',{id:t.eid}).then(r=>{
            const s=(r&&r.ok&&r.text)||'';
            if(!s){Toast&&Toast.show('Nothing selected on the page');return}
            try{navigator.clipboard.writeText(s);Toast&&Toast.show((ck==='x'?'Cut ':'Copied ')+s.length+' characters')}
            catch(_){Toast&&Toast.show('Could not reach the clipboard')}
            if(ck==='x')sendInput({kind:'key',type:'down',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:4});
          }).catch(()=>{});
          return;
        }
        if((e.metaKey||e.ctrlKey)&&ck==='v'){
          e.preventDefault();const t=at();if(!t)return;
          navigator.clipboard.readText().then(txt=>{if(txt)eng('type',{id:t.eid,text:txt.slice(0,100000)}).catch(()=>{})})
            .catch(()=>Toast&&Toast.show('The clipboard is not readable here'));
          return;
        }
        // A key typed into a PAGE is not a command to the app. preventDefault alone left the
        // event bubbling to every window-level shortcut, so typing a Portuguese word with
        // "ga"/"gu" in a web page fired the g-chord and opened a panel. Stop it here.
        e.preventDefault();e.stopPropagation();
        const printable=e.key.length===1&&!e.metaKey&&!e.ctrlKey;
        sendInput({kind:'key',type:'down',key:e.key,code:e.code,keyCode:e.keyCode,text:printable?e.key:'',modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)});
      });
      c.addEventListener('keyup',e=>{if(e.metaKey&&['l','t','w','r'].includes(e.key.toLowerCase()))return;e.stopPropagation();sendInput({kind:'key',type:'up',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)})});
      // keep the engine viewport in step with the stage as the window resizes
      if('ResizeObserver' in window){const ro=new ResizeObserver(()=>{const t=at();if(t)castOn(t)});ro.observe(el('wbrstage'));p._wbrRO=ro}
    }

    function build(){
      const IB=(id,title,svg)=>`<button class="wbr-ib" id="${id}" title="${title}">${svg}</button>`;
      root.innerHTML=
        '<div class="wbr-chrome">'+
          '<div class="wbr-tabs" id="wbrtabs"></div>'+
          '<div class="wbr-bar">'+
            '<div class="wbr-nav">'+
              IB('wbrback','Back','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>')+
              IB('wbrfwd','Forward','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>')+
              IB('wbrreload','Reload (⌘R)','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>')+
            '</div>'+
            '<div class="wbr-addr">'+
              '<span class="wbr-lock" id="wbrlock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>'+
              '<input id="wbrurl" placeholder="Search or enter address" spellcheck="false" autocomplete="off">'+
            '</div>'+
            IB('wbrcopy','Copy link','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>')+
            IB('wbrwin','New browser window','<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/></svg>')+
            // Always present, never hidden: a control the owner can only reach when a page
            // happens to ask for a key is a control that does not exist. Off is the resting
            // state; the accent only comes on once a real window is being held.
            '<button class="wbr-ib wbr-sign" id="wbrsign" title="Sign in — opens a real browser window on this site so a password, passkey, security key or SMS code all work. It closes when you are done and the session comes back here.">SIGN IN</button>'+
            '<div class="wbr-prog" id="wbrprog"></div>'+
          '</div>'+
          // empty and display:none until something is actually downloading
          '<div class="wbr-dl" id="wbrdl" style="display:none"></div>'+
          // the find bar exists only while ⌘F is open — a blank browser stays blank
          '<div class="wbr-find" id="wbrfind" style="display:none"><input placeholder="Find on page" spellcheck="false"><button data-f="prev" title="Previous (⇧⏎)">‹</button><button data-f="next" title="Next (⏎)">›</button><button data-f="x" title="Close (Esc)">✕</button></div>'+
        '</div>'+
        '<div class="wbr-stage" id="wbrstage"><canvas class="wbr-canvas" id="wbrcanvas"></canvas>'+
          // A blank tab is BLANK: no wordmark, no tiles, no "recently visited" — there is
          // nothing to recall and nothing to look at but the address bar (owner's order,
          // 2026-07-25). This layer only covers the canvas's white while no page is loaded.
          '<div class="wbr-start" id="wbrstart"></div>'+
          // the passkey moment (see pkOn) — empty and hidden until a page asks for a key
          '<div class="wbr-pk" id="wbrpk" style="display:none"></div>'+
        '</div>';
      const i=inp();
      const go=()=>{const t=at();if(t)nav(t,i.value);else newTab(i.value)};
      el('wbrback').addEventListener('click',()=>{const t=at();if(t){progStart();eng('back',{id:t.eid}).catch(()=>{})}});
      el('wbrfwd').addEventListener('click',()=>{const t=at();if(t){progStart();eng('forward',{id:t.eid}).catch(()=>{})}});
      el('wbrreload').addEventListener('click',()=>{const t=at();if(t){progStart();eng('reload',{id:t.eid}).catch(()=>{})}});
      el('wbrcopy').addEventListener('click',()=>{const t=at();if(!t||!t.url){Toast&&Toast.show('Open a page first');return}try{navigator.clipboard.writeText(t.url);Toast&&Toast.show('Link copied')}catch(_){Toast&&Toast.show('Could not copy')}});
      el('wbrwin').addEventListener('click',()=>openPanel('research',{newInstance:true}));
      el('wbrsign').addEventListener('click',async()=>{
        const b=el('wbrsign');if(!b||b.disabled)return;
        b.disabled=true;
        try{ if(signinOn)await signinEnd(); else await signinBegin(); }
        finally { b.disabled=false }
      });
      coverWatch(false); // resting state + the honest tooltip, before any engine answer
      i.addEventListener('keydown',e=>{if(e.key==='Enter')go();else if(e.key==='Escape'){const t=at();i.value=(t&&t.url)||'';i.blur()}});
      // Click-to-focus selects the whole URL (every browser does this) — without it,
      // typing APPENDS to the old address and "google.com" becomes garbage.
      i.addEventListener('focus',()=>setTimeout(()=>{try{i.select()}catch(_){}},0));
      i.addEventListener('input',()=>lockSync(i.value));
      i.addEventListener('blur',()=>addrSync(at())); // a tab push that landed mid-edit resyncs on blur
      const fb=el('wbrfind');
      fb.querySelector('input').addEventListener('keydown',e=>{
        e.stopPropagation();
        if(e.key==='Enter'){e.preventDefault();runFind(e.shiftKey)}
        else if(e.key==='Escape'){e.preventDefault();closeFind()}
      });
      fb.querySelectorAll('[data-f]').forEach(b=>b.addEventListener('click',()=>{
        const k=b.dataset.f;if(k==='x')closeFind();else runFind(k==='prev');
      }));
      // any pointer that is not inside the menu dismisses it — capture phase, so a click
      // on the canvas closes the menu instead of being eaten by it
      p.addEventListener('pointerdown',e=>{if(ctxEl&&!ctxEl.contains(e.target))closeCtx()},true);
      wireCanvas();
      // per-window keyboard API (top-most browser window answers global keys)
      p._wbr={key(e){const k=e.key.toLowerCase();
        if(k==='l'){e.preventDefault();const x=inp();if(x){x.focus();x.select()}}
        else if(k==='t'){e.preventDefault();newTab('');const x=inp();if(x)x.focus()}
        else if(k==='w'){const t=at();if(t){e.preventDefault();closeTab(t.id)}}
        else if(k==='r'){const t=at();if(t){e.preventDefault();progStart();eng('reload',{id:t.eid}).catch(()=>{})}}
        else if(k==='f'){e.preventDefault();openFind()}
        else if(k==='='||k==='+'){e.preventDefault();zoomStep(+1)}
        else if(k==='-'){e.preventDefault();zoomStep(-1)}
        else if(k==='0'){e.preventDefault();setZoom(1)}
      }};
      p._dockMeta=()=>{const t=at();return{label:(t&&t.url?hostOf(t.url):'Browser'),url:(t&&t.url)||''}};
      p._onundock=()=>{const t=at();if(t){hidden=false;castOn(t)}renderTabs()};
      // Closing the window ends the browsing session: every tab is closed (which erases
      // its site's cookies and storage) and, once no window holds a tab any more, the
      // whole private context is destroyed — nothing of this session survives.
      p._dispose=()=>{
        closeCtx();
        if(paintT){clearInterval(paintT);paintT=0}clearTimeout(metaT);
        if(moveT){clearTimeout(moveT);moveT=0}if(wheelT){clearTimeout(wheelT);wheelT=0}
        if(coverT){clearInterval(coverT);coverT=0}
        if(p._wbrCoverRz){window.removeEventListener('resize',p._wbrCoverRz);p._wbrCoverRz=null}
        if(ws){const s=ws;ws=null;wsOk=false;try{s.close()}catch(_){}}
        if(p._wbrRO){try{p._wbrRO.disconnect()}catch(_){}}
        const mine=tabs.filter(t=>t.eid);tabs=[];
        mine.forEach(t=>owned.delete(t.eid));
        const closed=Promise.all(mine.map(t=>eng('close',{id:t.eid}).catch(()=>{})));
        // This window's socket is already closed above, so `ifIdle` sees only the OTHER
        // windows: the private context dies with the LAST one, never with this one alone.
        if(!owned.size)closed.then(()=>eng('wipe',{ifIdle:true}).catch(()=>{}));
      };
      if(!tabs.length)openClean();
      wsConnect();
      // Sign-in mode belongs to the ENGINE, not to a window: a second ⧉ browser window
      // must show the same state, and a reopened one must not forget it.
      eng('status').then(s=>{if(s&&s.headful){signinOn=true;coverSig='';coverWatch(true);eng('setCover',coverRect()).catch(()=>{})}}).catch(()=>{});
      paintT=setInterval(paintTick,33);metaLoop();
    }

    build();

    // An agent (or another panel) can open a URL here — {url,newTab,target} or a bare
    // string. `target` addresses ONE window (its panel key); without it only the
    // top-most browser window answers, so N windows never all grab the same URL.
    Bus.on('web:open',d=>{
      if(!document.body.contains(p)||!p._wbr)return;
      const o=(typeof d==='string')?{url:d}:(d||{});
      const u=o.url||'';if(!u)return;
      if(o.target&&o.target!==p.dataset.key)return;
      if(!o.target&&p!==topInstanceOf('research'))return;
      if(o.newTab){newTab(u);return}
      const t=tabs.find(x=>!x.url)||at();if(t){setActive(t.id);nav(t,u)}else newTab(u);
    });
  }
