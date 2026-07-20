  function wireWebBrowser(p){
    const root=p.querySelector('#wbxroot');if(!root)return;
    const PROXY=(window.__CFHUB_BRIDGE__&&window.__CFHUB_BRIDGE__.endpoint)||'';
    // Chrome-only, no pickers — the engine picker and search-engine chip were removed
    // on purpose (owner call 2026-07-16): one clean browser, nothing in the way.
    // 2026-07-16 v0.49: the app launches in BRANDED Google Chrome (the CfT runtime is
    // retired), so the Framer XFO-stripping extension no longer loads — framerOn() is
    // false until the future native shell brings it back. Search runs on DuckDuckGo's
    // HTML endpoint THROUGH THE PROXY on purpose: the proxy CONTROLLER reports every
    // result click to this parent, so history/back work and every target re-probes
    // (frameable sites render direct; the rest go reader) instead of dying in-frame.
    // NATIVE = the app is running under the Electron shell (electron/main.js), where the
    // in-app browser is a REAL top-level WebContentsView, not an iframe: full JS, cookies,
    // logins — every site works interactively (only Google's own sign-in is blocked by
    // Google policy in every embedded browser → routed to the system Chrome). When absent
    // (plain chrome --app / preview) the whole native block is dormant and the iframe+proxy
    // path below runs unchanged.
    const NATIVE=!!(window.cfhubNative&&window.cfhubNative.web);
    const nid=t=>p.dataset.key+'::'+t.id; // stable per-tab native view id
    const framerOn=()=>document.documentElement.dataset.cfFramer==='1';
    // Under Electron the native view renders full Google — real search, no proxy needed
    // (only Google LOGIN is walled, handled separately). Otherwise: DDG-HTML via proxy.
    const SEARCH_URL=()=>NATIVE?'https://www.google.com/search?q=':(framerOn()?'https://www.google.com/search?q=':'https://html.duckduckgo.com/html/?q=');
    const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return u}};
    const isUrl=t=>/^https?:\/\//i.test(t)||(/^[\w-]+(\.[\w-]+)+([/:?#]|$)/i.test((t||'').trim())&&!/\s/.test((t||'').trim()));
    const proxURL=u=>PROXY+'/proxy?url='+encodeURIComponent(u)+'&ua=chrome';
    const normUrl=q=>{q=(q||'').trim();if(!q)return'';if(/^https?:\/\//i.test(q))return q;if(isUrl(q))return'https://'+q;return SEARCH_URL()+encodeURIComponent(q)};
    const fav=(u,label)=>{const h=(label||hostOf(u)||'?').trim();return `<span class="wbx-fav">${escHtml((h[0]||'?').toUpperCase())}</span>`};
    /* ---- hybrid loader: localhost + frame-friendly sites render DIRECTLY (real origin,
       full JS, SPAs work); the rest fall back to the read-only proxy ---- */
    const MAX_TABS=12;
    // NO allow-popups / allow-top-navigation, EVER (owner rule 2026-07-17, reaffirmed):
    // a framed site's window.open / target=_blank must NOT escape to another browser
    // window — browsing stays inside CLONE FRAME, period. The ONE exception is OAuth
    // SIGN-IN (server-side impossible inside any frame): loginPopup() below, opened by
    // the HUB itself, only for POPUP_ONLY hosts or the fallback card's explicit button.
    const DIRECT_SANDBOX='allow-scripts allow-same-origin allow-forms allow-downloads';
    const PROXY_SANDBOX='allow-scripts allow-forms allow-downloads';
    // Hosts that refuse to run inside ANY frame by policy (OAuth providers): don't even
    // try to embed — open the app-profile popup, finish sign-in, then refresh the tab.
    const POPUP_ONLY=/(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/i;
    function loginPopup(t,u){
      let w=null;try{w=window.open(u,'cfhub_login','popup=yes,width=520,height=720')}catch(e){}
      if(!w){Toast.show('Popup blocked — click again to allow sign-in');return}
      Toast.show('Sign-in opened in an app window — this tab refreshes when you finish');
      const backTo=t&&t.url&&!POPUP_ONLY.test(hostOf(t.url))?t.url:'';
      const iv=setInterval(()=>{if(!w.closed)return;clearInterval(iv);const tt=tabs.find(x=>x===t);if(tt&&backTo)nav(tt,backTo,{push:false,fresh:true})},600);
    }
    const frameKeyOf=u=>{try{const x=new URL(u);return x.origin+x.pathname}catch(e){return String(u||'')}};
    const bridgeOrigin=(()=>{try{return new URL(PROXY).origin}catch(e){return''}})();
    const isLocalUrl=u=>{try{const h=new URL(u).hostname.replace(/^\[|\]$/g,'').toLowerCase();return h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h==='::1'||h==='0.0.0.0'||/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||/^169\.254\./.test(h)}catch(e){return false}};
    // frameKeyOf -> boolean (direct?) · mirror of the bridge probe, PERSISTED so a page the
    // browser has already probed loads instantly in every later session (no re-probe wait)
    const fCache=new Map((()=>{try{return JSON.parse(localStorage.getItem('cfhub.web.frameable.v1')||'[]')}catch(e){return[]}})());
    const fCacheSave=()=>{try{localStorage.setItem('cfhub.web.frameable.v1',JSON.stringify([...fCache.entries()].slice(-220)))}catch(e){}};
    async function chooseLoad(u){
      let origin='';try{origin=new URL(u).origin}catch(e){}
      if(origin&&origin===bridgeOrigin)return 'proxy'; // never frame the app's own control-plane same-origin
      if(isLocalUrl(u))return 'direct';                // localhost: proxy SSRF-blocks it anyway; SPAs need real origin
      // Search results ALWAYS run through the proxy (even though the endpoint is
      // frameable): the proxy CONTROLLER reports every result click back here, so
      // history fills, back/forward work, and each clicked target re-probes for the
      // best mode — a direct frame would swallow those clicks and dead-end on
      // anti-framing sites now that the Framer runtime is gone.
      if(/^https:\/\/html\.duckduckgo\.com\//i.test(u))return 'proxy';
      // Tier 2: if the bundled Framer extension is loaded it strips X-Frame-Options/CSP,
      // so even the anti-framing giants (Google, X, YouTube) render directly. The 8s
      // load-timeout in nav() still catches the rare JS frame-buster and offers a fallback.
      if(document.documentElement.dataset.cfFramer==='1')return 'direct';
      const k=frameKeyOf(u);
      if(fCache.has(k))return fCache.get(k)?'direct':'proxy';
      // First visit: never make the user WAIT on the probe — race it against a short
      // budget and start rendering. A late answer still lands in the cache, so the
      // next visit to the site loads in the best mode instantly.
      let pr=null;try{pr=RPC('web','frameable',u)}catch(e){}
      let r=null;if(pr){try{r=await Promise.race([pr,new Promise(res=>setTimeout(()=>res(undefined),900))])}catch(e){}}
      // Persist ONLY a real answer: a bridge hiccup/timeout must degrade this one
      // navigation to proxy, never pin the site to reader mode across sessions.
      if(r&&r.ok){fCache.set(k,!!r.frameable);fCacheSave()}
      else if(r===undefined&&pr){pr.then(rr=>{if(rr&&rr.ok){fCache.set(k,!!rr.frameable);fCacheSave()}}).catch(()=>{})}
      return (r&&r.ok&&r.frameable)?'direct':'proxy';
    }

    let tabs=[],active=null,seq=0;
    let lastJointTab=null; // which tab last grew the browser's JOINT session history (in-frame nav steps)
    const at=()=>tabs.find(t=>t.id===active)||null;
    const el=id=>root.querySelector('#'+id);
    const inp=()=>el('wburl');

    // ── native browser engine (Electron only; dormant otherwise) ────────────────
    // Each tab owns a real WebContentsView in the main process, addressed by nid(t).
    // We keep it positioned over the browser panel's content area (#wbframes) and hide
    // it whenever the panel is minimized/docked, the tab isn't active, the start page is
    // showing, or another panel overlaps on top (native views float above the DOM, so
    // occlusion must be managed by hide, not CSS z-index).
    const CF=NATIVE?window.cfhubNative:null;
    const lastBounds=new Map(); // nid -> signature, to dedupe IPC while dragging/resizing
    function frameRect(){const host=el('wbframes');if(!host)return null;const r=host.getBoundingClientRect();return{x:r.left,y:r.top,width:r.width,height:r.height}}
    function occluded(r){
      if(!r)return true;const myZ=+p.style.zIndex||0;
      for(const o of document.querySelectorAll('.panel')){
        if(o===p||o.dataset.docked)continue;
        if((+o.style.zIndex||0)<=myZ)continue;
        const q=o.getBoundingClientRect();
        if(q.right>r.x&&q.left<r.x+r.width&&q.bottom>r.y&&q.top<r.y+r.height)return true;
      }
      return false;
    }
    function applyBounds(id,r,vis){
      if(!CF)return;
      const sig=r?[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height),vis?1:0].join(','):('h'+(vis?1:0));
      if(lastBounds.get(id)===sig)return;lastBounds.set(id,sig);
      CF.web.setBounds(id,r||null,!!vis);
    }
    function nativeSync(){
      if(!CF)return;const t=at();
      tabs.forEach(x=>{if(x._nv&&x!==t)applyBounds(nid(x),null,false)});
      if(!t||!t._nv)return;
      const onScreen=document.body.contains(p)&&!p.dataset.docked&&root.offsetParent!==null;
      const r=frameRect();
      const vis=onScreen&&!!t.url&&!t._authWall&&!!r&&r.width>4&&r.height>4&&t.home.style.display==='none'&&!occluded(r);
      applyBounds(nid(t),r,vis);
    }
    let syncRAF=0;
    function loopSync(){if(!document.body.contains(p)){syncRAF=0;return}nativeSync();syncRAF=requestAnimationFrame(loopSync)}
    async function nativeNav(t,u){
      t._authWall=false;const ov=t.wrap.querySelector('.wbx-fallback');if(ov)ov.remove(); // a fresh nav clears any auth-wall card
      if(!t._nv){await CF.web.create(nid(t));t._nv=true}
      CF.web.navigate(nid(t),u);
      nativeSync();
    }
    // main-process reports each view's real url/title/history back here
    p._wbxOnState=(tabId,s)=>{
      const t=tabs.find(x=>x.id===tabId);if(!t)return;
      t.canBack=!!s.canGoBack;t.canFwd=!!s.canGoForward;
      if(s.url&&/^https?:\/\//i.test(s.url))t.url=s.url;
      if(typeof s.title==='string'&&s.title.trim())t.title=s.title.slice(0,200);
      t.loading=!!s.loading;
      if(t.id===active){if(!t.loading)progDone(t);addrSync(t)}
      renderTabs();
    };

    let pT=null;
    function progStart(t){const b=el('wbprog');if(!t||t.id!==active||!b)return;clearInterval(pT);b.classList.remove('done');b.classList.add('run');let w=8;b.style.width=w+'%';pT=setInterval(()=>{w+=(90-w)*0.12;b.style.width=w.toFixed(1)+'%';if(w>89)clearInterval(pT)},180)}
    function progDone(t){const b=el('wbprog');if(!b)return;clearInterval(pT);if(!t||t.id===active){b.classList.add('done');b.classList.remove('run');setTimeout(()=>{if(b){b.classList.remove('done');b.style.width='0'}},420)}}
    function lockSync(v){const l=el('wblock');if(!l)return;l.classList.toggle('secure',/^https:\/\//i.test((v||'').trim())||/^[\w-]+(\.[\w-]+)+/.test((v||'').trim()))}
    function addrSync(t){const i=inp();if(i){i.value=t&&t.url||'';lockSync(i.value)}const b=el('wbback'),f=el('wbfwd');
      if(NATIVE){if(b)b.disabled=!(t&&(t.canBack||t.url));if(f)f.disabled=!(t&&t.canFwd)} // native: view history + home fallback
      else{if(b)b.disabled=!t||!(((t.hist&&t.hi>0))||(t.inFrame||0)>0);if(f)f.disabled=!t||!((t.hist&&t.hi<(t.hist.length-1))||(t.fwdFrames||0)>0)}}
    // '' is the start-page sentinel (entry zero of every tab) — Back can always
    // return to the clean start page, exactly like a real browser's Home.
    function histGo(t,d){if(!t.hist)return;const ni=t.hi+d;if(ni<0||ni>=t.hist.length)return;t.hi=ni;const v=t.hist[ni];if(v==='')showHome(t);else nav(t,v,{push:false})}

    let tabsT=0; // coalesced — nav/load/title storms repaint the strip once, not five times
    function renderTabs(){if(tabsT)return;tabsT=setTimeout(()=>{tabsT=0;renderTabsNow()},16)}
    function renderTabsNow(){
      const strip=el('wbtabs');if(!strip)return;
      strip.querySelectorAll('.wbx-tab').forEach(n=>n.remove());
      const nb=strip.querySelector('.wbx-new');
      tabs.forEach(t=>{
        const e=document.createElement('div');
        e.className='wbx-tab'+(t.id===active?' on':'')+(t.loading?' loading':'');
        e.innerHTML=`${t.url?fav(t.url,t.title):'<span class="wbx-fav">'+escHtml((t.title||'N')[0].toUpperCase())+'</span>'}<span class="tt">${escHtml(t.title||'New tab')}</span><span class="xx" title="Close (⌘W)">✕</span>`;
        e.addEventListener('click',ev=>{if(ev.target.classList.contains('xx')){ev.stopPropagation();closeTab(t.id)}else setActive(t.id)});
        strip.insertBefore(e,nb);
      });
    }
    function setActive(id){active=id;tabs.forEach(t=>t.wrap.classList.toggle('on',t.id===id));const t=at();if(t)addrSync(t);progDone(t);renderTabs();if(NATIVE)nativeSync()}
    function closeTab(id){const i=tabs.findIndex(t=>t.id===id);if(i<0)return;const[t]=tabs.splice(i,1);if(NATIVE&&t._nv){lastBounds.delete(nid(t));CF.web.destroy(nid(t))}t.wrap.remove();if(active===id)active=(tabs[i]||tabs[i-1]||tabs[0]||{}).id||null;if(!tabs.length)newTab('');else setActive(active)}

    function showHome(t){
      t.url='';t.title='New tab';t.loading=false;t.fr.style.display='none';t.fr.removeAttribute('src');t.home.style.display='';progDone(t);
      if(NATIVE){if(t._nv){lastBounds.delete(nid(t));CF.web.navigate(nid(t),'about:blank').catch(()=>{})}t.canBack=false;t.canFwd=false;nativeSync()} // blank + hide the native view behind the start page
      const i=inp();if(t.id===active&&i){i.value='';addrSync(t)}
      // Start page = the mark + ONE search field. Nothing else, ever: no suggestion
      // tiles, no bookmarks, no "recent" — and nothing is recorded anywhere (owner
      // call 2026-07-17: type, search, done; zero history kept).
      t.home.innerHTML=
        '<div class="wbx-hero"><div class="wbx-mark"><span class="g"><svg><use href="#i-globe"/></svg></span><b>CLONE FRAME</b><span class="w">Browser</span></div>'+
          '<div class="wbx-hs"><svg class="mag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/></svg><input id="wbhq" placeholder="Search or enter address" spellcheck="false" autocomplete="off"><button class="wbx-hsgo" id="wbhgo" title="Go">→</button></div></div>';
      const hq=t.home.querySelector('#wbhq');
      const hgo=()=>{const v=hq.value.trim();if(v)nav(t,v)};
      hq.addEventListener('keydown',e=>{if(e.key==='Enter')hgo()});
      t.home.querySelector('#wbhgo').addEventListener('click',hgo);
      if(t.id===active)setTimeout(()=>{try{hq.focus()}catch(_){}},40);
      renderTabs();
    }
    async function nav(t,q,opts){
      opts=opts||{};
      const u=normUrl(q);if(!u){showHome(t);return}
      // DuckDuckGo result links are /l/?uddg=<real-target> redirect WRAPPERS — the wrapper
      // page is a JS redirect that dies blank inside a frame. Unwrap and navigate straight
      // to the destination (recursing so the real URL gets the full probe/popup treatment).
      try{
        const x=new URL(u);
        if(/(^|\.)duckduckgo\.com$/i.test(x.hostname)&&/^\/l\/?$/.test(x.pathname)){
          const real=x.searchParams.get('uddg')||'';
          if(/^https?:\/\//i.test(real)){nav(t,real,opts);return}
        }
      }catch(_){}
      // Big-provider sign-in hosts: under the NATIVE shell the attempt runs right here —
      // the real WebContentsView can complete passkey/Touch ID flows; if the provider
      // actively rejects, main detects the rejection page and raises the honest wall.
      // Only the frame-based shells (no native views) still need the same-profile popup.
      if(POPUP_ONLY.test(hostOf(u))&&!NATIVE){
        loginPopup(t,u);
        if(t.id===active)addrSync(t);return;
      }
      if(opts.push!==false){t.hist=(t.hist||[]).slice(0,(t.hi==null?-1:t.hi)+1);if(t.hist[t.hist.length-1]!==u)t.hist.push(u);t.hi=t.hist.length-1}
      t.commit=true; // first loaded-report after a commanded nav REPLACES the entry (server redirects must not trap Back)
      t.url=u;t.loading=true;t.title=hostOf(u);t.home.style.display='none';t.fr.style.display=NATIVE?'none':'';
      const ov=t.wrap.querySelector('.wbx-fallback');if(ov)ov.remove();
      progStart(t);if(t.id===active)addrSync(t);
      renderTabs();
      // Native shell: a REAL top-level WebContentsView renders the page (full JS, cookies,
      // logins). No iframe, no proxy, no frameable probe — everything just works.
      if(NATIVE){nativeNav(t,u);return}
      // a newer nav on this tab supersedes a slow frameable() probe
      const nonce=t.nav=(t.nav||0)+1;
      const mode=opts.mode||await chooseLoad(u);
      if(t.nav!==nonce)return;
      t.mode=mode;clearTimeout(t.frameTO);
      // a commanded nav starts a fresh frame document: in-frame step counters reset,
      // the next load is the commanded page itself (not an internal navigation)
      t.awaitLoad=true;t.inFrame=0;t.fwdFrames=0;t.stepping=null;lastJointTab=t.id;
      t.fr.classList.remove('ready');
      if(mode==='direct'){
        t.fr.setAttribute('sandbox',DIRECT_SANDBOX);t.fr.removeAttribute('referrerpolicy');
        if(opts.fresh)t.fr.src='about:blank';
        t.fr.src=u;
        // blocked-despite-probe safety net: cross-origin load errors are unreadable, so if
        // the frame never fires `load` within the budget, offer a proxy/external fallback.
        t.frameTO=setTimeout(()=>{if(t.loading&&t.mode==='direct')showFrameFallback(t,u)},8000);
      }else{
        t.fr.setAttribute('sandbox',PROXY_SANDBOX);t.fr.setAttribute('referrerpolicy','no-referrer');
        t.fr.src=proxURL(u)+(opts.fresh?'&fresh=1':'');
      }
    }
    function siteInfo(anchor){ // surfaces per-tab state (host · https · direct/reader) that had no UI
      const old=root.querySelector('.wbx-pop');if(old){old.remove();return}
      const t=at();
      const pop=document.createElement('div');pop.className='wbx-pop';
      if(t&&t.url){
        const secure=/^https:\/\//i.test(t.url);
        pop.innerHTML='<div class="hd">SITE</div><div class="row"><b>'+escHtml(hostOf(t.url))+'</b></div>'+
          '<div class="row">'+(secure?'HTTPS — encrypted connection':'Not HTTPS')+'</div>'+
          '<div class="row">'+(t.mode==='proxy'?'Reader mode — rendered through the bridge':'Direct — the real page in a sandboxed frame')+'</div>';
      }else pop.innerHTML='<div class="hd">SITE</div><div class="row">Start page — nothing loaded yet</div>';
      root.appendChild(pop);
      const rr=root.getBoundingClientRect(),ar=anchor.getBoundingClientRect();
      pop.style.right=Math.max(8,rr.right-ar.right)+'px';pop.style.top=(ar.bottom-rr.top+8)+'px';
      setTimeout(()=>addEventListener('pointerdown',function once(ev){if(!ev.target.closest('.wbx-pop'))pop.remove();removeEventListener('pointerdown',once,true)},true),0);
    }
    function showFrameFallback(t,u){
      progDone(t);t.loading=false;renderTabs();
      let ov=t.wrap.querySelector('.wbx-fallback');
      if(!ov){ov=document.createElement('div');ov.className='wbx-fallback';t.wrap.appendChild(ov)}
      // In-app recoveries only — reader mode, retry, or a popup window of the app's
      // OWN Chrome profile (for sign-ins that refuse to run framed). Never the OS browser.
      ov.innerHTML='<div class="wbx-fbcard"><b>This site may block embedding</b>'+
        `<div class="sub">${escHtml(hostOf(u))} didn't finish loading in the frame.</div>`+
        '<div class="wbx-fbacts"><button class="btn" data-a="proxy">Try reader mode</button>'+
        '<button class="btn" data-a="retry">Retry</button>'+
        '<button class="btn" data-a="pop">Sign in — app window</button>'+
        '<button class="btn ghost" data-a="wait">Keep waiting</button></div></div>';
      ov.querySelector('[data-a="proxy"]').addEventListener('click',()=>{ov.remove();fCache.set(frameKeyOf(u),false);fCacheSave();nav(t,u,{mode:'proxy',push:false})});
      ov.querySelector('[data-a="retry"]').addEventListener('click',()=>{ov.remove();fCache.delete(frameKeyOf(u));fCacheSave();nav(t,u,{push:false,fresh:true})});
      ov.querySelector('[data-a="pop"]').addEventListener('click',()=>{ov.remove();loginPopup(t,u)});
      ov.querySelector('[data-a="wait"]').addEventListener('click',()=>ov.remove());
    }
    function newTab(url){
      if(tabs.length>=MAX_TABS){ // graceful reuse instead of an unbounded tab storm
        const victim=tabs.find(t=>t.id!==active)||tabs[0];
        Toast.show('Tab limit ('+MAX_TABS+') reached — reusing a tab');
        victim.hist=[''];victim.hi=0; // a reused tab must not inherit foreign history
        setActive(victim.id);if(url)nav(victim,url);else showHome(victim);return victim;
      }
      const id='wb'+(++seq);
      const wrap=document.createElement('div');wrap.className='wbx-frame';
      const home=document.createElement('div');home.className='wbx-home';
      const fr=document.createElement('iframe');fr.className='wbx-if';
      fr.setAttribute('sandbox',PROXY_SANDBOX);fr.setAttribute('referrerpolicy','no-referrer');
      fr.addEventListener('load',()=>{
        const t=tabs.find(x=>x.fr===fr);if(!t)return;
        clearTimeout(t.frameTO);
        const ov=t.wrap.querySelector('.wbx-fallback');if(ov)ov.remove();
        // In-frame history capture. Cross-origin frame URLs are unreadable (browser security
        // wall) but the load EVENT fires for every internal navigation — count them, and let
        // Back/Forward drive the browser's JOINT session history, which steps the frame
        // natively. Same-origin frames additionally yield the real URL → fully recorded.
        let cur='';try{cur=fr.contentWindow.location.href}catch(_){cur=''}
        if(cur!=='about:blank'){
          fr.classList.add('ready');
          if(t.awaitLoad){t.awaitLoad=false;t.postStep=0; // the commanded page itself arrived
            if(cur&&/^https?:\/\//i.test(cur)&&cur!==t.url&&t.hi>=0){t.hist[t.hi]=cur;t.url=cur;if(t.id===active)addrSync(t)} // readable server redirect → replace, don't trap Back
          }
          else if(t.stepping==='back'){t.stepping=null;t.postStep=Date.now();t.inFrame=Math.max(0,(t.inFrame||0)-1);t.fwdFrames=(t.fwdFrames||0)+1;if(t.id===active)addrSync(t)}
          else if(t.stepping==='fwd'){t.stepping=null;t.postStep=0;t.fwdFrames=Math.max(0,(t.fwdFrames||0)-1);t.inFrame=(t.inFrame||0)+1;if(t.id===active)addrSync(t)}
          else if(t.postStep&&Date.now()-t.postStep<900){ // a redirect shoved the frame forward right after our back-step — escape the trap through the known stack
            t.postStep=0;t.inFrame=0;t.fwdFrames=0;histGo(t,-1);
          }
          else{ // a navigation the user made INSIDE the page
            t.postStep=0;
            t.inFrame=(t.inFrame||0)+1;t.fwdFrames=0;lastJointTab=t.id;
            if(cur&&/^https?:\/\//i.test(cur)&&cur!==t.url){ // same-origin: real URL known → record it in the tab stack instead
              t.hist=(t.hist||[]).slice(0,(t.hi==null?-1:t.hi)+1);
              if(t.hist[t.hist.length-1]!==cur){t.hist.push(cur);t.hi=t.hist.length-1}
              t.inFrame=Math.max(0,t.inFrame-1);
              t.url=cur;t.title=hostOf(cur);
            }
            if(t.id===active)addrSync(t);
          }
          t.commit=false;
        }
        if(t.loading){t.loading=false;progDone(t);renderTabs()}
      });
      wrap.appendChild(home);wrap.appendChild(fr);
      el('wbframes').appendChild(wrap);
      const t={id,url:'',title:'New tab',loading:false,hist:[''],hi:0,fr,home,wrap};
      tabs.push(t);setActive(id);
      if(url)nav(t,url);else showHome(t);
      return t;
    }
    function build(){
      const IB=(id,title,dis,svg)=>`<button class="wbx-ib" id="${id}" title="${title}"${dis?' disabled':''}>${svg}</button>`;
      root.innerHTML=
        '<div class="wbx-chrome">'+
          '<div class="wbx-tabs" id="wbtabs"><button class="wbx-new" id="wbnew" title="New tab (⌘T)">＋</button></div>'+
          '<div class="wbx-bar">'+
            '<div class="wbx-nav">'+
              IB('wbback','Back',true,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>')+
              IB('wbfwd','Forward',true,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>')+
              IB('wbreload','Reload (⌘R)',false,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>')+
            '</div>'+
            '<div class="wbx-addr">'+
              '<span class="wbx-lock" id="wblock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>'+
              '<input id="wburl" placeholder="Search or enter address" spellcheck="false" autocomplete="off">'+
            '</div>'+
            IB('wbcopy','Copy link',false,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>')+
            IB('wbreader','Reader mode — render through the bridge (click again to try the real page)',false,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a3 3 0 0 0-3-3H4v13h5a3 3 0 0 1 3 2z"/><path d="M12 7a3 3 0 0 1 3-3h5v13h-5a3 3 0 0 0-3 2z"/></svg>')+
            IB('wbinfo','Site info',false,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg>')+
            IB('wbwin','New browser window — browse in parallel',false,'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/></svg>')+
            '<div class="wbx-prog" id="wbprog"></div>'+
          '</div>'+
        '</div>'+
        '<div class="wbx-frames" id="wbframes"></div>';
      const i=inp();
      const go=()=>{const t=at()||newTab('');nav(t,i.value)};
      // Native shell drives the real view's own history. Iframe mode: recorded entries walk
      // the tab's hist stack; UNTRACKED in-frame steps (cross-origin internal clicks) walk
      // the browser's JOINT session history — history.back() on the parent steps the frame.
      // A joint step MUST have a visible effect: if the frame produces no load in time
      // (SPA pushState entries, silent sites), degrade to the known stack automatically —
      // the Back/Forward buttons never dead-end, ever.
      const armStep=t=>{const dir=t.stepping;setTimeout(()=>{if(dir&&t.stepping===dir){t.stepping=null;histGo(t,dir==='back'?-1:1);if(t.id===active)addrSync(t)}},1100)};
      const goBack=t=>{if(NATIVE){if(t.canBack)CF.web.back(nid(t));else showHome(t);return}
        if((t.inFrame||0)>0&&lastJointTab===t.id&&!t.stepping){t.stepping='back';armStep(t);try{history.back();return}catch(_){t.stepping=null}}
        histGo(t,-1)};
      const goFwd=t=>{if(NATIVE){if(t.canFwd)CF.web.forward(nid(t));return}
        if((t.fwdFrames||0)>0&&lastJointTab===t.id&&!t.stepping){t.stepping='fwd';armStep(t);try{history.forward();return}catch(_){t.stepping=null}}
        histGo(t,1)};
      const doReload=t=>{if(!t.url)return;if(NATIVE)CF.web.reload(nid(t));else nav(t,t.url,{fresh:true,push:false})};
      el('wbnew').addEventListener('click',()=>{newTab('');const x=inp();if(x)x.focus()});
      el('wbreload').addEventListener('click',()=>{const t=at();if(t)doReload(t)});
      el('wbback').addEventListener('click',()=>{const t=at();if(t)goBack(t)});
      el('wbfwd').addEventListener('click',()=>{const t=at();if(t)goFwd(t)});
      i.addEventListener('keydown',e=>{if(e.key==='Enter')go();else if(e.key==='Escape'){const t=at();i.value=t&&t.url||'';i.blur()}});
      i.addEventListener('input',()=>lockSync(i.value));
      el('wbwin').addEventListener('click',()=>openPanel('research',{newInstance:true}));
      el('wbcopy').addEventListener('click',()=>{const t=at();if(!t||!t.url){Toast.show('Open a page first');return}try{navigator.clipboard.writeText(t.url);Toast.show('Link copied')}catch(_){Toast.show('Could not copy')}});
      el('wbreader').addEventListener('click',()=>{const t=at();if(!t||!t.url){Toast.show('Open a page first');return}
        if(t.mode==='proxy'){fCache.delete(frameKeyOf(t.url));fCacheSave();nav(t,t.url,{push:false,fresh:true})}   // try the real page again
        else{fCache.set(frameKeyOf(t.url),false);fCacheSave();nav(t,t.url,{mode:'proxy',push:false})}});          // force reader mode
      el('wbinfo').addEventListener('click',e=>{e.stopPropagation();siteInfo(e.currentTarget)});
      // Per-window API for the ONE pair of window-level listeners (wireWbxGlobals):
      // keys go to the top-most browser window; frame messages are matched to the
      // window that owns the sending iframe. No listeners accumulate across reopen.
      p._wbx={
        key(e){
          const k=e.key.toLowerCase();
          if(k==='l'){e.preventDefault();const x=inp();if(x){x.focus();x.select()}}
          else if(k==='t'){e.preventDefault();newTab('');const x=inp();if(x)x.focus()}
          else if(k==='w'){const t=at();if(t){e.preventDefault();closeTab(t.id)}}
          else if(k==='r'){const t=at();if(t&&t.url){e.preventDefault();doReload(t)}}
          else if(k==='['||(e.metaKey&&k==='arrowleft')){const t=at();if(t){e.preventDefault();goBack(t)}}
          else if(k===']'||(e.metaKey&&k==='arrowright')){const t=at();if(t){e.preventDefault();goFwd(t)}}
        },
        msg(d,src){
          const t=tabs.find(x=>x.fr&&x.fr.contentWindow===src);if(!t)return false;
          if(d.type==='navigate'){const u=typeof d.url==='string'?d.url:'';if(!/^https?:\/\//i.test(u))return true;if(d.newTab&&d.gesture){if(tabs.length>=MAX_TABS){nav(t,u)}else{const cur=active;const nt=newTab(u);if(nt&&cur)setActive(cur)}}else nav(t,u);return true}
          if(d.type==='external'){const u=typeof d.url==='string'?d.url:'';if(/^https?:\/\//i.test(u))nav(t,u,{push:false,fresh:true});return true} // stays in the app — re-probes for the best mode (a blind direct nav would just dead-end on anti-framing sites)
          if(d.type==='searchwall'){
            // Google demanded a captcha inside the frame — it can't be satisfied there
            // (SameSite exemption cookie), so the SAME query continues elsewhere: no wall,
            // no clicks, no dead end. Deep google links without a query get the fallback card.
            const q=(typeof d.q==='string'?d.q:'').trim();
            if(q){const ddg=(framerOn()?'https://duckduckgo.com/?q=':'https://html.duckduckgo.com/html/?q=')+encodeURIComponent(q);Toast.show('Google asked for a captcha — your search continued on DuckDuckGo');nav(t,ddg,{push:false})}
            else showFrameFallback(t,t.url||'https://google.com');
            return true;
          }
          if(d.type==='loaded'){
            // Proxy pages report title + completion only; direct/in-frame history is
            // captured on the iframe 'load' event (see newTab). No url ever arrives here.
            t.loading=false;progDone(t);t.commit=false;
            if(typeof d.title==='string'&&d.title.trim())t.title=d.title.slice(0,200);else if(!t.title)t.title=hostOf(t.url);
            if(t.id===active)addrSync(t);
            renderTabs();return true}
          return true;
        }
      };
      p._dockMeta=()=>{const t=at();return{label:(t&&t.url?hostOf(t.url):'Browser'),url:(t&&t.url)||''}};
      p._onundock=()=>{renderTabs();const t=at();if(t)addrSync(t);if(NATIVE)nativeSync()};
      // open a url from the native view's blocked window.open in a NEW tab of THIS window
      p._wbxOpenUrl=u=>{if(/^https?:\/\//i.test(u)){const cur=active;const nt=newTab(u);if(nt&&cur&&tabs.length<MAX_TABS)setActive(cur)}};
      // A provider ACTIVELY REJECTED sign-in inside the app (we let every attempt run —
      // passkey flows can succeed; this fires only on their rejection page). Never split
      // the flow across browsers. Two honest cases: the site IS the provider (google.com
      // → no third-party login exists) vs a third-party site (its own password/passkey
      // works right here). Hide the native view so this DOM card is visible over it.
      p._wbxAuthWall=(tabId,authUrl,siteUrl)=>{
        const t=tabs.find(x=>x.id===tabId);if(!t)return;
        t._authWall=true;t.loading=false;nativeSync();progDone(t);
        let host='this site';try{host=new URL(siteUrl||t.url||'').hostname.replace(/^www\./,'')}catch(_){}
        let prov='Google';try{const h=new URL(authUrl).hostname;prov=/google/.test(h)?'Google':/apple/.test(h)?'Apple':/microsoft|live/.test(h)?'Microsoft':'That provider'}catch(_){}
        const own=prov==='Google'&&/(^|\.)(google\.[a-z.]+|youtube\.com|gmail\.com)$/i.test(host);
        const site=siteUrl&&/^https?:\/\//i.test(siteUrl)?siteUrl:('https://'+host);
        let ov=t.wrap.querySelector('.wbx-fallback');if(!ov){ov=document.createElement('div');ov.className='wbx-fallback';t.wrap.appendChild(ov)}
        ov.innerHTML='<div class="wbx-fbcard"><b>'+prov+' sign-in doesn’t work in any in-app browser</b>'+
          '<div class="sub">'+(own
            ?'This is permanent, not a glitch: '+prov+' blocks account sign-in inside every embedded browser (their anti-phishing policy — even Slack, Notion and VS Code can’t bypass it, and 2026’s device-bound sessions make it stricter). A login done in your system browser can’t transfer into the app either. Use '+prov+' in your everyday browser; everything else browses fine right here.'
            :prov+' blocks its account sign-in inside every embedded browser (permanent policy). On <b>'+escHtml(host)+'</b> use its own login instead — your email &amp; password work right here. Or open '+escHtml(host)+' in your system browser to use “Continue with '+prov+'” there.')+'</div>'+
          '<div class="wbx-fbacts">'+(own
            ?'<button class="btn" data-a="site">Keep browsing signed-out</button><button class="btn" data-a="ext">Open '+prov+' in your browser</button>'
            :'<button class="btn" data-a="site">Back to '+escHtml(host)+' — sign in there</button><button class="btn" data-a="ext">Open '+escHtml(host)+' in your browser</button>')+'</div></div>';
        // in-app return goes to the site's ROOT: navigating back to the exact login URL
        // can resume the pending OAuth chain server-side and loop straight back into the
        // provider (observed with github.com/login → fresh Google OAuth redirect).
        let siteRoot=site;try{siteRoot=new URL(site).origin+'/'}catch(_){}
        ov.querySelector('[data-a="site"]').addEventListener('click',()=>{ov.remove();t._authWall=false;nav(t,siteRoot)});
        ov.querySelector('[data-a="ext"]').addEventListener('click',()=>{CF.openExternal(own?'https://accounts.google.com/':site);Toast.show('Opened in your browser — sessions there cannot cross back into the app')});
      };
      wireWbxGlobals();
      if(NATIVE){
        // reap every native view + stop the position loop when this window closes
        p._dispose=()=>{if(syncRAF){cancelAnimationFrame(syncRAF);syncRAF=0}tabs.forEach(t=>{if(t._nv){lastBounds.delete(nid(t));CF.web.destroy(nid(t))}})};
        loopSync();wireNativeGlobals();
      }
      if(!tabs.length)newTab('');
    }

    if(!Bridge.on()){
      root.innerHTML='<div class="wbx-off"><span class="g"><svg><use href="#i-globe"/></svg></span><h3>Connect the HUB Bridge</h3><p>The Browser renders real pages through your machine. Connect the HUB Bridge in <b>MY MACHINE</b> to start browsing.</p><button class="btn acc" id="wboff">Open MY MACHINE</button></div>';
      const b=root.querySelector('#wboff');if(b)b.addEventListener('click',()=>openPanel('machine'));
      // Don't drop asks that arrive while offline: remember the last one and replay it
      // the moment the bridge pairs (wireWebBrowser re-runs and builds the real UI).
      let pend=null;
      panelBus(p).on('web:open',d=>{if(p._wbx)return;const o=(typeof d==='string')?{url:d}:(d||{});if(o.target&&o.target!==p.dataset.key)return;if(o.url)pend=o});
      panelBus(p).on('bridge:changed',()=>{if(p._wbx||!Bridge.on())return;wireWebBrowser(p);if(pend){Bus.emit('web:open',Object.assign({},pend,{target:p.dataset.key}));pend=null}});
      return;
    }
    build();
    // An agent (or another panel) can open a URL here — accepts {url,newTab,target} or a
    // bare string. `target` addresses ONE browser window (its panel key); without it,
    // only the top-most browser window answers, so N windows never all grab the same URL.
    Bus.on('web:open',d=>{
      if(!document.body.contains(p)||!p._wbx)return;
      const o=(typeof d==='string')?{url:d}:(d||{});
      const u=o.url||'';if(!u)return;
      if(o.target&&o.target!==p.dataset.key)return;
      if(!o.target&&p!==topInstanceOf('research'))return;
      if(o.newTab){newTab(u);return}
      const t=tabs.find(x=>!x.url)||at();if(t){setActive(t.id);nav(t,u)}else newTab(u)
    });
  }
