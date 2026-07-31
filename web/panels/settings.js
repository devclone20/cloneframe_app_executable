  function wireSettings(p){
    // Single quotes, like iT's qpath after a971b2e. JSON.stringify wraps a path in DOUBLE
    // quotes, and zsh still expands $(...), `...` and $VAR inside those — so a folder whose
    // NAME contained a command substitution would have executed when the owner clicked
    // "Open in Finder". Same defect class as the iT one, a different panel.
    // ----- sidebar-nav settings (left column of sections, content pane on the right) -----
    const nav=p.querySelector('#setnav'),pane=p.querySelector('#setpane');
    const loading=()=>{pane.innerHTML='<div class="qempty" style="padding:16px">loading…</div>'};
    const fail=e=>{pane.innerHTML='<div class="qempty" style="color:var(--accent);padding:16px">'+escHtml(e.message||e)+'</div>'};
    // This deliberately does NOT call the global needBridge(el): that one re-mounts the whole
    // panel on pairing, which in SETTINGS would throw the owner back to the default section.
    // What it DOES borrow from the global is the two things it was missing — telling the two
    // failures apart, and recovering without a reload.
    let cur=null;
    function needBridge(){
      // "Connect the HUB Bridge" is the wrong instruction when the bridge is already running
      // and only this window is unpaired. Same conflation wave W removed from Bridge.on().
      const why=(Bridge.unpaired&&Bridge.unpaired())
        ? 'The <b>HUB Bridge</b> is running — this window just is not paired with it yet.'
        : 'Connect the <b>HUB Bridge</b> (MY MACHINE) for this section.';
      pane.innerHTML='<div class="qempty" data-setneedbridge style="padding:22px;line-height:1.7">'+why+'<br><br><button class="btn" id="spm">OPEN MY MACHINE</button></div>';
      pane.querySelector('#spm').addEventListener('click',()=>openPanel('machine'));
    }
    // One subscription for the life of the window, and it has to work in BOTH directions.
    //
    // Pairing used to leave all twelve gated sections showing the card until the owner clicked
    // away and back — the app had recovered and CONFIG had not noticed. Losing the bridge was
    // the mirror image, and measured live: with AGENT TOOLS open, Bridge.disconnect() left the
    // permission toggles on screen, fully clickable, writing to a daemon that was no longer
    // reachable. A control that cannot work must not look like one.
    //
    // `go(cur)` is the whole mechanism either way: it re-reads Bridge.on() and picks the card
    // or the section. It re-runs only when the two disagree, so a section that recovered on its
    // own is never mounted twice.
    const GATED=['addmodels','added','aidefaults','piagent','email','reminders','agenttools','session','users','system','folders','servers'];
    panelBus(p).on('bridge:changed',()=>{
      if(!p.isConnected||!cur||!GATED.includes(cur))return;
      const showingCard=!!pane.querySelector('[data-setneedbridge]');
      if(Bridge.on()===showingCard)go(cur);   // paired but still carded, or unpaired but not
    });
    function go(name){
      cur=name;
      nav.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.sec===name));
      if(['addmodels','added','aidefaults','piagent','email','reminders','agenttools','session','users','system','folders','servers'].includes(name)&&!Bridge.on())return needBridge();
      const SEC={addmodels:secAddModels,added:secAdded,aidefaults:secDefaults,piagent:secPiAgent,search:secSearch,itterm:secIT,email:secEmail,reminders:secReminders,appearance:secAppearance,magicframes:secMagicFrames,shortcuts:secShortcuts,account:secAccount,tools:secToolsList,licenses:secLicenses,folders:secFolders,servers:secServers,agenttools:secAgentTools,session:secSession,users:secUsers,system:secSystem};
      (SEC[name]||secAddModels)();
    }
    // ----- MAGIC FRAMES — the little frame squares that hold docked tabs & their figures.
    // Frames = placement/distribution of those squares; the other rooms are announced here
    // and arrive later (owner's roadmap 2026-07-25).
    function secMagicFrames(){
      const dist=((Store.get().magic||{}).dist)||'organized';
      const selStyle='background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:10px;font-family:var(--mono)';
      const soon=n=>'<div class="setline"><b>'+n+'</b><span style="margin-left:auto" class="badge pending">COMING SOON</span></div>';
      pane.innerHTML='<div class="sethead">MAGIC FRAMES</div>'
        +'<div class="setline" style="display:block;line-height:1.7;color:var(--ink-dim);font-size:10.5px">The <b>magic frames</b> are the little squares of the CLONE FRAME canvas — each one can hold a docked tab, app window or figure, and clicking it brings that window back. This room collects everything about how they behave.</div>'
        +'<div class="sethead">FRAMES — DISTRIBUTION</div>'
        +'<div class="setline">How docked tabs take their squares<span style="margin-left:auto"><select id="mfdist" style="'+selStyle+'">'
          +'<option value="organized">Organized — one square apart</option>'
          +'<option value="random">Random — nearest square (legacy)</option>'
          +'<option value="cubic" disabled>Cubic view — coming soon</option>'
          +'<option value="diagrams" disabled>Diagrams — coming soon</option>'
        +'</select></span></div>'
        +'<div class="setline" style="display:block;color:var(--ink-faint);font-size:10px;line-height:1.6">Organized fills a tidy lattice — every square keeps one empty square of breathing room horizontally and vertically, starting on screen. Random is the old scatter (nearest free square to the window).</div>'
        +soon('Galaxies')+soon('Agentic Engineering')+soon('Magic');
      const sel=pane.querySelector('#mfdist');sel.value=dist;
      sel.addEventListener('change',()=>{const s=Store.get();s.magic=Object.assign({},s.magic,{dist:sel.value});Store.save();Toast.show('Frames: '+(sel.value==='organized'?'organized — one square apart':'random scatter'))});
    }
    function secIT(){
      const theme=localStorage.getItem('cfhub.shell.omz')||'robbyrussell';
      const deftab=localStorage.getItem('cfhub.it.deftab')||'tty';
      const restore=localStorage.getItem('cfhub.it.restore')!=='0';
      const persist=localStorage.getItem('cfhub.it.persist')!=='0';
      const autoname=localStorage.getItem('cfhub.it.autoname')!=='0';
      const selStyle='background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:10px;font-family:var(--mono)';
      pane.innerHTML='<div class="sethead">iT — TERMINAL</div>'
        +'<div class="setline" style="line-height:1.6;color:var(--ink-dim);font-size:10.5px;display:block"><b>iT is our own terminal</b> — the engine, the persistence and the multiplexing are CLONE FRAME\'s, with nothing to install and nothing to attach to. It is built for <b>a whole workflow on one screen</b>: <b>workspaces</b> hold a project, <b>split panes</b> put the work side by side, and every tab is a real TTY, so agents, builds, servers and shells run together and you watch them at once.<br>Around them: the file tree follows the live shell, <b>canvas mode</b> (⌃⌘C) turns a pane into a drawing surface, the <b>diff viewer</b> (⌃⌘⇧D) reads changes without leaving the terminal, and long commands raise a notification when they land — even from another workspace.<br>The <b>it</b> CLI is live inside every iT shell: run <span class="path">it</span> for the welcome screen, <span class="path">it --help</span> for every command, <span class="path">it hooks setup</span>, <span class="path">it feedback</span>.</div>'
        +'<div class="setline">Default new tab<span style="margin-left:auto"><select id="itdeftab" style="'+selStyle+'"><option value="tty">Live terminal (tty)</option><option value="smart">Smart shell</option></select></span></div>'
        +'<div class="setline">Prompt theme — smart tabs (Oh My Zsh)<span style="margin-left:auto"><select id="itomz" style="'+selStyle+'"><option>robbyrussell</option><option>agnoster</option><option>powerlevel</option></select></span></div>'
        +'<div class="autotoggle"><div><b>Restore workspaces &amp; splits on launch</b><div class="sub">the layout comes back after a reload — each shell reopens at its folder</div></div><div class="sw3 '+(restore?'on':'')+'" id="itrestore"><i></i></div></div>'
        +'<div class="autotoggle"><div><b>Keep sessions alive across reloads</b><div class="sub">a reload reattaches to the SAME live shells (running commands survive) and replays their scrollback. Closing a tab still ends it. Detached shells are reaped after 60 min.</div></div><div class="sw3 '+(persist?'on':'')+'" id="itpersist"><i></i></div></div>'
        +'<div class="autotoggle"><div><b>Workspace auto-naming</b><div class="sub">unnamed workspaces take their git repo\'s name — deterministic, no LLM; a manual rename pins it</div></div><div class="sw3 '+(autoname?'on':'')+'" id="itautoname"><i></i></div></div>'
        +'<div class="setline">Live sessions<span style="margin-left:auto" class="dim" id="itcap">— · cap 24</span></div>'
        +'<div class="setline" style="display:block;color:var(--ink-dim);font-size:10px;line-height:1.6">Notifications: commands taking 15s+ raise one when they finish (any agent, build or deploy — visible from other workspaces). Terminals can also send OSC 9/777, and <span class="path">it notify</span> works from scripts. <b>⌘I</b> opens the list.</div>'
        +'<div class="sethead">AGENT HOOKS — NOTIFICATIONS FROM YOUR CODING AGENTS</div>'
        +'<div class="setline" style="display:block;color:var(--ink-dim);font-size:10px;line-height:1.6">Run <span class="path">it hooks setup</span> in any iT shell to wire <b>Claude Code</b> and <b>Codex</b> so every finished task raises an iT notification (⌘I) \'s Automation. <span class="path">it hooks status</span> shows what\'s wired, <span class="path">it hooks remove</span> undoes it. Nothing is touched without you running the command.</div>'
        +'<div class="setline">Hooks state<span class="dim" id="ithooks" style="margin-left:auto;font-size:10px">checking…</span></div>'
        +'<div class="sethead">KEYBOARD — EVERY ROW REBINDABLE</div>'
        +'<div id="itkmap"></div>'
        +'<div class="setline"><span class="dim" style="font-size:10.5px">⌘1…9 go to workspace · ⌃1…9 go to tab (fixed)</span><span style="margin-left:auto"><button class="btn mini" id="itkreset">RESET ALL</button></span></div>'
        +'<div class="setline" style="display:block;color:var(--ink-faint);font-size:10px;line-height:1.6">Also from the command line: <span class="path">it shortcuts list</span> · <span class="path">it shortcuts set split-right cmd+e</span> · <span class="path">it shortcuts set new-workspace none</span> (unbind) · <span class="path">it shortcuts reset</span>.</div>';
      const dt=pane.querySelector('#itdeftab');dt.value=deftab;dt.addEventListener('change',()=>localStorage.setItem('cfhub.it.deftab',dt.value));
      const om=pane.querySelector('#itomz');om.value=theme;om.addEventListener('change',()=>{localStorage.setItem('cfhub.shell.omz',om.value);Toast.show('Prompt theme: '+om.value)});
      const rs=pane.querySelector('#itrestore');rs.addEventListener('click',()=>{const on=!rs.classList.contains('on');rs.classList.toggle('on',on);localStorage.setItem('cfhub.it.restore',on?'1':'0')});
      const ps=pane.querySelector('#itpersist');ps.addEventListener('click',()=>{const on=!ps.classList.contains('on');ps.classList.toggle('on',on);localStorage.setItem('cfhub.it.persist',on?'1':'0');Toast.show(on?'Sessions will survive reloads':'Sessions end on reload')});
      const an=pane.querySelector('#itautoname');an.addEventListener('click',()=>{const on=!an.classList.contains('on');an.classList.toggle('on',on);localStorage.setItem('cfhub.it.autoname',on?'1':'0')});
      (async()=>{try{const l=await RPC('pty','list');const el=pane.querySelector('#itcap');if(el&&Array.isArray(l))el.textContent=l.filter(s=>s&&s.alive).length+' live · cap 24'}catch(_){}})();
      (async()=>{const el=pane.querySelector('#ithooks');if(!el)return;
        if(!Bridge.on()){el.textContent='connect the HUB Bridge to check';return}
        try{let o='';await Bridge.shell('"$HOME/.clone-frame-hub/bin/it" hooks status 2>/dev/null',x=>{o+=x});o=o.replace(/\x1b\[[0-9;]*m/g,'').trim();el.textContent=o?o.split('\n').join(' · ').slice(0,120):'not wired yet — run: it hooks setup'}catch(_){el.textContent='not wired yet — run: it hooks setup'}})();
      // keymap editor — click REBIND, press the new combo (Esc cancels); UNBIND clears; RESET restores
      const km=pane.querySelector('#itkmap');
      const evCombo=e=>{
        const k0=(e.key||'').toLowerCase(),code=e.code||'';
        if(itKeymap.isMod(k0))return null;
        let k=itKeymap.alias[k0]||k0;
        if(code==='BracketRight')k=']';else if(code==='BracketLeft')k='[';else if(code==='Equal')k='=';else if(code==='Minus')k='-';else if(code==='Period')k='.';
        else if(e.altKey&&/^Key[A-Z]$/.test(code))k=code.slice(3).toLowerCase();
        else if(e.altKey&&/^Digit[0-9]$/.test(code))k=code.slice(5); // ⌥2 is "@" on a PT layout — bind the KEY, not the glyph
        const mods=[];if(e.ctrlKey)mods.push('ctrl');if(e.altKey)mods.push('alt');if(e.shiftKey)mods.push('shift');if(e.metaKey)mods.push('cmd');
        return mods.length?mods.concat(k).join('+'):null;
      };
      const kmDraw=()=>{
        const over=itKeymap.load();
        km.innerHTML=IT_ACTIONS.map(a=>{
          const c=itKeymap.comboOf(a[0],over),custom=over[a[0]]!=null;
          return `<div class="itk-row" data-a="${a[0]}"><span class="a">${a[0]}<span class="dim" style="margin-left:8px;font-size:10px">${a[2]}</span></span><span class="c${custom?' custom':''}">${itKeymap.pretty(c)}</span><button data-k="re">REBIND</button><button data-k="un">UNBIND</button><button data-k="rs" ${custom?'':'disabled style="opacity:.35"'}>RESET</button></div>`;
        }).join('');
        km.querySelectorAll('.itk-row').forEach(row=>{
          const id=row.dataset.a;
          row.querySelector('[data-k="re"]').addEventListener('click',()=>{
            row.classList.add('rec');row.querySelector('.c').textContent='press keys…';
            // While armed this eats EVERY keystroke in the whole app (capture + stopPropagation),
            // and a modifier-less key leaves evCombo empty — so it used to stay armed silently and
            // the app simply stopped accepting typing. It must never outlive the user's attention:
            // a click elsewhere, leaving the window, or 8 seconds of quiet all disarm it.
            let t=null;
            const done=()=>{clearTimeout(t);removeEventListener('keydown',onk,true);removeEventListener('pointerdown',off,true);removeEventListener('blur',off);kmDraw()};
            const off=ev=>{if(ev&&ev.type==='pointerdown'&&row.contains(ev.target))return;done()};
            const onk=e=>{e.preventDefault();e.stopPropagation();
              if((e.key||'')==='Escape'){done();return}
              const c=evCombo(e);if(!c)return;
              const r=itKeymap.set(id,c);if(r.error)Toast.show(r.error);
              done();
            };
            addEventListener('keydown',onk,true);
            addEventListener('pointerdown',off,true);
            addEventListener('blur',off);
            t=setTimeout(done,8000);
          });
          row.querySelector('[data-k="un"]').addEventListener('click',()=>{itKeymap.set(id,'none');kmDraw()});
          row.querySelector('[data-k="rs"]').addEventListener('click',()=>{itKeymap.reset(id);kmDraw()});
        });
      };
      pane.querySelector('#itkreset').addEventListener('click',()=>{itKeymap.reset();kmDraw();Toast.show('iT shortcuts reset to defaults')});
      kmDraw();
    }
    function secLicenses(){
      // Only what actually SHIPS inside the app is listed. A licence notice exists to satisfy
      // the licence of code we distribute — it is not a place to advertise other projects.
      const L=[
        ['xterm.js + addon-fit','MIT','github.com/xtermjs/xterm.js','Draws the interactive terminal in the window.'],
        ['node-pty','MIT','github.com/microsoft/node-pty','Real TTYs behind every iT tab, in the HUB bridge.'],
        ['ws','MIT','github.com/websockets/ws','The live socket the terminals and the browser engine ride on.'],
        ['imapflow · mailparser','MIT','github.com/postalsys','Reading your mail from the bridge.'],
        ['nodemailer','MIT-0','nodemailer.com','Sending it.'],
        ['@privy-io/react-auth','Apache-2.0','privy.io','Wallet sign-in, vendored in the login island.'],
        ['React · React-DOM','MIT','react.dev','Runtime for that login island.'],
      ];
      pane.innerHTML='<div class="sethead">CLONE FRAME IS OPEN SOURCE — MIT</div>'+
        '<div class="setline" style="line-height:1.7;color:var(--ink-dim);font-size:10.5px;display:block">The app, the HUB bridge and <b>iT</b> — its terminal, its persistence, its multiplexing — are ours, written here and released under <b>MIT</b>: use it, fork it, ship it. Nothing phones home, nothing is rented; it runs on your machine and the keys stay in your hands. <b>MATRIX</b> is ours too — the lab, the topology, the controls — and it drives a local cluster engine that <b>you</b> install and own, so that part is yours, not ours to license.<br>Everything below is code we <b>distribute inside the app</b>, so its licence travels with it. Full texts live in <span class="path">THIRD-PARTY-NOTICES.md</span>.</div>'+
        L.map(x=>`<div class="setline" style="align-items:flex-start"><svg style="width:13px;height:13px;color:var(--accent);flex:none;margin-top:2px"><use href="#i-shield"/></svg><span style="flex:1;margin-left:6px;min-width:0"><b style="font-size:10.5px;color:var(--fg)">${escHtml(x[0])}</b> <span class="badge" style="font-size:10px">${escHtml(x[1])}</span><br><span class="dim" style="font-size:10px">${escHtml(x[3])}</span><br><span class="path" style="font-size:10.5px">${escHtml(x[2])}</span></span></div>`).join('');
    }
    async function secPiAgent(){
      // The raw Pi coding agent (pi.dev, MIT) — the app's first-class agent: pi is the mind,
      // CLONE FRAME is its body (clone-frame extension + op=app channel). BYOK through pi's
      // own login; ships as plain "pi" — naming/soul is done BY pi in chat, on request.
      loading();
      let s=null;try{s=await RPC('pi','status')}catch(_){}
      const row=(label,ok,detail)=>'<div class="setline">'+label+'<span style="margin-left:auto;display:flex;align-items:center;gap:7px"><span class="dim" style="font-size:10px">'+escHtml(detail||'')+'</span><span class="brdot" style="background:'+(ok?'var(--ok,#37e05f)':'var(--accent)')+';box-shadow:0 0 6px '+(ok?'var(--ok,#37e05f)':'var(--accent)')+'"></span></span></div>';
      pane.innerHTML='<div class="sethead">PI AGENT — THE APP\'S CODING AGENT</div>'
        +'<div class="setline" style="line-height:1.7;color:var(--ink-dim);font-size:10.5px;display:block">The raw <b>Pi coding agent</b> (<span class="path">pi.dev</span>, MIT) is CLONE FRAME\'s first-class agent: <b>pi is the mind, this app is its body</b>. Through the <span class="path">clone-frame</span> extension it opens panels, reads the live screen, drives the iT terminal and reaches every bridge module — and its <b>bash runs free</b> (YOLO), with exactly one hard limit: the anti-wipe (<span class="path">rm -rf /</span> · <span class="path">mkfs</span> · <span class="path">dd</span> to a disk are refused, nothing else). Messages that ARE a command line run verbatim, like a terminal — everywhere. Because it works unwatched, it closes any <b>complex</b> job with a short diagnosis — what changed, what it decided for you, what it could not do, how to undo it — and stays quiet on the small ones.</div>'
        +(s&&s.installed
          ?(row('Pi engine',true,s.version||'installed')
            +row('Agent workspace (curriculum + skills)',!!s.workspace,s.workspace?'~/.clone-frame-hub/agent':'missing')
            +row('clone-frame extension (app tools + anti-wipe)',!!s.extension,s.extension?'loaded per launch':'missing')
            +row('iT launcher',!!s.launcher,s.launcher?'pi-clone':'missing')
            +row('Web access (search & fetch)',!!s.webAccess,s.webAccess?'pi-web-access':'not installed')
            +row('Live chat sessions',true,String(s.sessions||0)))
          :'<div class="setline" style="display:block;color:var(--accent);font-size:10.5px;line-height:1.6">Pi is not installed on this machine. Install it once, globally:<br><span class="path">npm i -g @earendil-works/pi-coding-agent</span><br>then hit INSTALL / REPAIR below.</div>')
        +'<div class="setline" style="gap:8px;flex-wrap:wrap"><button class="btn" id="pirepair">INSTALL / REPAIR</button><button class="btn" id="picode">OPEN CODE — TALK TO PI</button><button class="btn" id="piit">LAUNCH IN iT</button><span class="dim" style="font-size:10px;margin-left:auto">workspace + launcher are re-synced on every app start</span></div>'
        +'<div class="sethead">MIND — THE MODEL (BYOK)</div>'
        +row('Current LLM model',!!(s&&s.model),(s&&s.model)?(s.model+(s.provider&&!String(s.model).includes('/')?' · '+s.provider:'')):'not set — run pi /login')
        +'<div class="setline" style="display:block;line-height:1.7;color:var(--ink-dim);font-size:10.5px">Pi thinks on <b>your own model</b>, configured in pi itself: run <span class="path">pi</span> in any terminal → <span class="path">/login</span> (API key or OAuth). The key lives in <span class="path">~/.pi/agent/auth.json</span> — it never enters this app, its HTML or its logs. Pick a different LLM for pi below in <b>CODE</b>, or here.</div>'
        +'<div class="sethead">NAME &amp; SOUL — FACTORY: PLAIN “pi”</div>'
        +'<div class="setline" style="display:block;line-height:1.7;color:var(--ink-dim);font-size:10.5px">It ships as plain <b>pi</b> — no custom name, no persona. Want one? <b>Ask pi in chat</b> (“call yourself NAME”, “here is your soul: …”) and it writes its own identity layer (<span class="path">.pi/APPEND_SYSTEM.md</span> in its workspace) and answers to both names. Deleting that file resets it to factory. App updates never touch it.</div>';
      const rf=()=>secPiAgent();
      pane.querySelector('#pirepair').addEventListener('click',async()=>{try{const r=await RPC('pi','install');Toast.show(r&&r.ok?'Pi workspace + launcher installed':'Install had errors — see server.log')}catch(e){Toast.show('install failed: '+e.message)}rf()});
      pane.querySelector('#picode').addEventListener('click',()=>{openPanel('terminal');Toast.show('CODE opened — new sessions default to pi')});
      pane.querySelector('#piit').addEventListener('click',()=>{openPanel('shell');Toast.show('Type pi-clone in the iT shell to launch pi')});
    }
    async function secAddModels(){
      loading();
      let known=[];try{known=await RPC('models','knownProviders')}catch(e){return fail(e)}
      const locals=known.filter(k=>k.kind==='local'),apis=known.filter(k=>k.kind==='api');
      const opt=(k,seld)=>`<option value="${k.provider}" data-url="${escAttr(k.baseUrl||'')}"${seld?' selected':''}>${escAttr(k.label)}</option>`;
      // This is the ADVANCED view of the same registry MY MACHINE writes to — a local
      // endpoint, a custom base URL, a provider the key-prefix detector does not know.
      // Say so, or it reads as a competing place to put a key, which is exactly how
      // "my key works in one screen and not the other" starts.
      pane.innerHTML=`
        <div class="brn-desc" style="padding:0 2px 10px;line-height:1.6">For a cloud key, use <b>MY MACHINE → BRAIN</b> — it detects the provider, checks the key, and registers it here too. This page is for what that cannot do: a <b>local</b> server, a custom base URL, or a provider by hand.</div>
        <div class="mcard">
          <div class="mchead"><svg><use href="#i-chip"/></svg><b>Add Local Models</b><span class="tag">(Endpoint)</span><span class="acts"><button class="btn" id="ltest">▷ TEST</button></span></div>
          <div class="mcsub">Add a local model server (Ollama, llama.cpp, vLLM).</div>
          <div class="mcrow"><select id="lprov">${locals.map((k,i)=>opt(k,i===0)).join('')}<option value="custom" data-url="">Custom</option></select><input id="lurl" placeholder="Paste endpoint URL, e.g. http://localhost:11434/v1" value="${escAttr((locals[0]||{}).baseUrl||'')}"><button class="btn acc" id="ladd">✓ ADD</button></div>
          <div class="mcmsg" id="lmsg"></div>
        </div>
        <div class="mcard">
          <div class="mchead"><svg><use href="#i-cosmos"/></svg><b>Add API Models</b><span class="tag">(Endpoint)</span><span class="acts"><button class="btn" id="atest">▷ TEST</button></span></div>
          <div class="mcsub">Connect a cloud provider (Anthropic, OpenAI, DeepSeek, OpenRouter, etc.).</div>
          <div class="mcrow"><select id="aprov">${apis.map(k=>opt(k,k.provider==='anthropic')).join('')}<option value="custom" data-url="">Custom URL</option></select><input id="aurl" placeholder="Base URL" value="${escAttr((apis.find(k=>k.provider==='anthropic')||apis[0]||{}).baseUrl||'')}"></div>
          <div class="mcrow"><input id="akey" type="password" placeholder="API key, e.g. sk-proj-AbCdEf…"><button class="btn acc" id="aadd">✓ ADD</button></div>
          <div class="mcmsg" id="amsg"></div>
        </div>`;
      const lsel=pane.querySelector('#lprov'),asel=pane.querySelector('#aprov');
      const urlOf=sel=>{const o=sel.selectedOptions[0];return o?(o.dataset.url||''):''};
      lsel.addEventListener('change',()=>{pane.querySelector('#lurl').value=urlOf(lsel)});
      asel.addEventListener('change',()=>{pane.querySelector('#aurl').value=urlOf(asel)});
      const lcfg=()=>({kind:'local',provider:lsel.value==='custom'?'local':lsel.value,label:lsel.value==='custom'?'Local':lsel.selectedOptions[0].textContent,baseUrl:pane.querySelector('#lurl').value.trim(),apiKey:''});
      const acfg=()=>({kind:'api',provider:asel.value==='custom'?'custom':asel.value,label:asel.value==='custom'?'Custom':asel.selectedOptions[0].textContent,baseUrl:pane.querySelector('#aurl').value.trim(),apiKey:pane.querySelector('#akey').value});
      const test=async(cfg,m)=>{m.style.color='var(--ink-faint)';m.textContent='testing…';try{const r=await RPC('models','testProvider',cfg);m.style.color=r.ok?'var(--ok)':'var(--accent)';m.textContent=r.ok?('✓ '+(r.models?r.models.length+' models found':'ok')):('✗ '+(r.error||'failed'))}catch(e){m.style.color='var(--accent)';m.textContent=e.message}};
      const add=async(cfg,m)=>{try{const r=await RPC('models','addProvider',cfg);if(r.ok){try{await RPC('models','listModels',r.id)}catch(_){}Bus.emit('models:changed');Toast.show('Model added');go('added')}else{m.style.color='var(--accent)';m.textContent='✗ '+(r.error||'failed')}}catch(e){m.style.color='var(--accent)';m.textContent=e.message}};
      pane.querySelector('#ltest').addEventListener('click',()=>test(lcfg(),pane.querySelector('#lmsg')));
      pane.querySelector('#ladd').addEventListener('click',()=>add(lcfg(),pane.querySelector('#lmsg')));
      pane.querySelector('#atest').addEventListener('click',()=>test(acfg(),pane.querySelector('#amsg')));
      pane.querySelector('#aadd').addEventListener('click',()=>add(acfg(),pane.querySelector('#amsg')));
    }
    async function secAdded(){
      loading();
      let provs=[];try{provs=await RPC('models','listProviders')}catch(e){return fail(e)}
      pane.innerHTML='<div class="sethead">ADDED MODELS — provider toggle · click a model to activate it</div>'+(provs.length?provs.map(pr=>`
        <div class="mrow" style="flex-wrap:wrap">
          <b>${escHtml(pr.label||pr.provider)}</b><span class="kind">${escHtml((pr.kind||'').toUpperCase())}</span>
          <span class="url">${escHtml(pr.baseUrl||'')}</span>
          <div class="sw3 ${pr.enabled!==false?'on':''}" data-en="${pr.id}" title="Enable / disable provider"><i></i></div>
          <button class="rm" data-rm="${pr.id}" title="Remove">✕</button>
          <div style="flex-basis:100%;display:flex;flex-wrap:wrap;gap:5px;margin-top:7px">
            ${(pr.models||[]).map(m=>{const on=!(pr.disabledModels||[]).includes(m);return `<span class="mmodel ${on?'on':''}" data-pid="${pr.id}" data-m="${escAttr(m)}" data-on="${on?1:0}"><i></i>${escAttr(m)}</span>`}).join('')||'<span class="dim" style="font-size:10px">No models listed yet — TEST the provider in Add Models to fetch them.</span>'}
          </div>
        </div>`).join(''):'<div class="qempty" style="padding:14px">No models added yet — add one in <b>Add Models</b>.</div>');
      pane.querySelectorAll('[data-en]').forEach(sw=>sw.addEventListener('click',async()=>{const on=!sw.classList.contains('on');try{await RPC('models','setEnabled',sw.dataset.en,on);sw.classList.toggle('on',on);Bus.emit('models:changed');Toast.show(on?'Provider enabled':'Provider disabled')}catch(e){Toast.show(e.message)}}));
      pane.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{await RPC('models','removeProvider',b.dataset.rm);Bus.emit('models:changed');Toast.show('Model removed');secAdded()}));
      pane.querySelectorAll('.mmodel').forEach(ch=>ch.addEventListener('click',async()=>{const on=ch.dataset.on==='1';try{await RPC('models','setModelEnabled',ch.dataset.pid,ch.dataset.m,!on);Bus.emit('models:changed');secAdded()}catch(e){Toast.show(e.message)}}));
    }
    async function secDefaults(){
      loading();
      let defs={},provs=[];try{defs=await RPC('models','getDefaults');provs=await RPC('models','listProviders')}catch(e){return fail(e)}
      const caps=[['chat','Chat'],['email_summary','Email summary'],['email_reply','Email reply'],['email_tags','Email tags']];
      const offered=sel=>!!(sel&&provs.some(pr=>pr.id===sel.providerId&&(pr.models||[]).includes(sel.model)));
      const opts=(cap,sel)=>{
        const rows=[`<option value="">${cap==='chat'?'— first provider you added —':'— follow Chat —'}</option>`]
          .concat(provs.flatMap(pr=>(pr.models||[]).map(m=>`<option value="${pr.id}::${escAttr(m)}" ${sel&&sel.providerId===pr.id&&sel.model===m?'selected':''}>${escAttr(pr.label||pr.provider)} · ${escAttr(m)}</option>`)));
        // A default whose provider or model has since been removed still sits on disk and is
        // still quietly ignored. Show it, so the owner can see WHY the model they picked is
        // not the one answering — an empty select would just look like they never chose.
        if(sel&&!offered(sel))rows.splice(1,0,`<option value="" selected disabled>${escAttr(sel.model||'?')} — no longer available</option>`);
        return rows.join('');
      };
      const anyModel=provs.some(pr=>(pr.models||[]).length);
      pane.innerHTML='<div class="sethead">AI DEFAULTS — which model does what</div>'
        +caps.map(c=>`<div class="setline"><span style="flex:1">${c[1]}</span><select data-cap="${c[0]}" class="setsel">${opts(c[0],defs[c[0]])}</select></div>`).join('')
        +'<div style="font-size:10px;color:var(--ink-faint);padding:6px 2px;line-height:1.6">'
        +(anyModel?'':'<b>No models to choose from yet</b> — add a provider in <b>Add Models</b> first.<br>')
        +'Chat is the general default: everything not listed here follows it, including research, recipes and comparisons. With nothing selected the app uses the first provider you added, and falls back to a key in <code>~/.env.local</code>.</div>';
      pane.querySelectorAll('[data-cap]').forEach(s=>s.addEventListener('change',async()=>{const v=s.value;if(!v)await RPC('models','setDefault',s.dataset.cap,{providerId:null});else{const parts=v.split('::');await RPC('models','setDefault',s.dataset.cap,{providerId:parts[0],model:parts[1]})}Toast.show('Saved')}));
    }
    async function secSearch(){
      pane.innerHTML='<div class="sethead">SEARCH</div><div style="display:flex;margin-bottom:9px"><input id="ssq" placeholder="Search settings, tools, notes, tasks…" style="all:unset;flex:1;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:10.5px;color:var(--fg);caret-color:var(--accent)"></div><div id="ssres" class="qempty" style="padding:10px;font-size:10px;line-height:1.6">Type to search the settings sections and everything indexed (notes · tasks · reminders · research).</div>';
      const SECS=[['addmodels','Add Models'],['added','Added Models'],['aidefaults','AI Defaults'],['piagent','Pi Agent'],['itterm','iT — Terminal'],['email','Email'],['reminders','Reminders'],['appearance','Appearance'],['shortcuts','Shortcuts'],['account','Account'],['tools','Tools'],['licenses','Licenses'],['folders','Folders'],['servers','Servers'],['agenttools','Agent Tools'],['users','Users'],['system','System']];
      const inp=pane.querySelector('#ssq'),res=pane.querySelector('#ssres');let tmr=null;
      inp.addEventListener('input',()=>{clearTimeout(tmr);tmr=setTimeout(async()=>{
        const q=inp.value.trim().toLowerCase();
        if(!q){res.innerHTML='Type to search…';return}
        const hits=SECS.filter(x=>x[1].toLowerCase().includes(q)).map(x=>`<div class="setline" data-go="${x[0]}" style="cursor:pointer"><span style="flex:1">${x[1]}</span><span class="dim">settings</span></div>`).join('');
        let deep='';
        // `g.items` is not a key search.mjs returns — it returns `results`, as web/panels/
        // search.js reads it. Every cross-module hit was silently dropped by (undefined||[]).
        if(Bridge.on()){try{const r=await RPC('search','query',q);(r&&r.groups||[]).forEach(g=>{(g.results||[]).slice(0,4).forEach(it=>{deep+=`<div class="setline"><span style="flex:1">${escHtml(it.title||it.name||'')}</span><span class="dim">${escHtml(g.module||g.label||'')}</span></div>`})})}catch(_){}}
        res.innerHTML=(hits+deep)||'<div class="qempty">Nothing found.</div>';
        res.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.go)));
      },250)});
      inp.focus();
    }
    async function secEmail(){
      loading();
      let acc=[];try{const r=await Mail.accounts();acc=Array.isArray(r)?r:(r&&r.accounts)||[]}catch(e){return fail(e)}
      // There was no way to CONNECT an account anywhere in the app. This page listed
      // accounts and offered autonomy levels for an inbox that could never exist, and the
      // EMAIL panel opened onto nothing. The bridge had addAccount/testAccount all along —
      // only the door was missing. Presets fill the hosts for the common providers; the
      // bridge probes IMAP and SMTP before it stores anything, so "connected" means both
      // answered, never that the form looked right.
      const PRESET={gmail:['imap.gmail.com',993,'smtp.gmail.com',465,'Google requires an <b>app password</b> (Account → Security → 2-Step Verification → App passwords), not your normal one.'],
        icloud:['imap.mail.me.com',993,'smtp.mail.me.com',587,'iCloud requires an <b>app-specific password</b> from appleid.apple.com.'],
        outlook:['outlook.office365.com',993,'smtp.office365.com',587,'Microsoft accounts usually need an <b>app password</b> with 2FA on.'],
        fastmail:['imap.fastmail.com',993,'smtp.fastmail.com',465,'Fastmail wants an <b>app password</b> from Settings → Privacy &amp; Security.'],
        custom:['',993,'',465,'Ask your provider for its IMAP and SMTP hosts and ports.']};
      const F=(id,label,ph,type)=>`<div class="af-row"><label>${label}</label><input id="${id}" ${type?'type="'+type+'"':''} placeholder="${escAttr(ph||'')}"></div>`;
      pane.innerHTML='<div class="sethead">EMAIL ACCOUNTS</div>'+(acc.length?acc.map(a=>`<div class="setline"><span style="flex:1"><b style="color:var(--fg);font-size:10.5px">${escHtml(a.email||a.name||'')}</b>${a.isDefault?' <span class="badge">DEFAULT</span>':''}</span><span class="dim">${escHtml(a.kind||a.type||'imap/smtp')}</span>${a.isDefault?'':`<button class="btn mini" data-emdef="${escAttr(a.id)}">make default</button>`}<button class="btn mini" data-emrm="${escAttr(a.id)}">remove</button></div>`).join(''):'<div class="qempty" style="padding:12px">No accounts connected — add one below.</div>')+
        '<div class="af-sec">CONNECT AN ACCOUNT (IMAP · SMTP)</div>'+
        '<div class="acctform" style="padding:0;overflow:visible">'+
        '<div class="af-row"><label>Provider</label><select id="emprov"><option value="gmail">Gmail</option><option value="icloud">iCloud</option><option value="outlook">Outlook / Microsoft 365</option><option value="fastmail">Fastmail</option><option value="custom">Other (enter hosts)</option></select></div>'+
        F('emmail','Email','you@example.com')+F('empass','Password','app password','password')+
        '<div id="emhint" class="brn-desc" style="padding:2px 2px 6px"></div>'+
        F('emih','IMAP host','imap.example.com')+F('emip','IMAP port','993')+
        F('emsh','SMTP host','smtp.example.com')+F('emsp','SMTP port','465')+
        '<div id="emmsg" style="font-size:10px;padding:2px 2px"></div>'+
        '<div class="compose-actions"><button class="btn" id="emtest">TEST</button><button class="btn acc" id="emadd">CONNECT</button></div></div>'+
        // Four autonomy levels used to sit here — off / show first / direct / full-auto.
        // SETTINGS wrote the choice to the browser store and no agent path ever read it, so
        // picking "Off" did not stop anything and picking "Full-auto" did not start anything.
        // What DOES gate an agent email is the autoEmail permission the daemon enforces, and
        // AUTOMATIONS is where you can see it. A label is a promise; this one was not kept.
        '<div class="sethead" style="margin-top:14px">WHAT AN AGENT MAY DO WITH THIS</div>'+
        '<div class="setline" style="display:block;padding:10px 12px"><div class="dim" style="font-size:10px;line-height:1.6">An agent can only send from your account when <b style="color:var(--fg)">Send email without asking</b> is on in <b style="color:var(--fg)">Machine</b>. With it off, everything it writes waits for you in <b style="color:var(--fg)">APPROVAL</b>.</div>'+
        '<div class="btnrow" style="margin-top:9px"><button class="btn mini" id="semauto">OPEN AUTOMATIONS</button></div></div>'+
        '<div class="btnrow" style="margin-top:12px"><button class="btn" id="sem">OPEN EMAIL</button></div>';
      pane.querySelector('#semauto').addEventListener('click',()=>{Caps.set('automations',1);openPanel('automations')});
      pane.querySelector('#sem').addEventListener('click',()=>{Caps.set('email',1);openPanel('email')});
      const g=id=>pane.querySelector('#'+id),msg=g('emmsg');
      function fillPreset(){
        const k=g('emprov').value,d=PRESET[k];
        g('emih').value=d[0];g('emip').value=d[1];g('emsh').value=d[2];g('emsp').value=d[3];
        g('emhint').innerHTML=d[4]+' Your password is sent to <b>your own provider</b> by the bridge on this machine and stored in your hub config — never in the app, never in a log.';
      }
      g('emprov').addEventListener('change',fillPreset);fillPreset();
      const cfgOf=()=>{const email=g('emmail').value.trim();return{provider:g('emprov').value==='custom'?undefined:g('emprov').value,
        email,user:email,pass:g('empass').value,
        imapHost:g('emih').value.trim(),imapPort:Number(g('emip').value)||993,imapSecure:true,
        smtpHost:g('emsh').value.trim(),smtpPort:Number(g('emsp').value)||465,smtpSecure:Number(g('emsp').value)===465}};
      const show=(ok,t)=>{msg.style.color=ok?'var(--ok)':'var(--accent)';msg.innerHTML=(ok?'✓ ':'✗ ')+escHtml(t)};
      g('emtest').addEventListener('click',async()=>{
        const b=g('emtest');b.disabled=true;b.textContent='TESTING…';msg.style.color='';msg.textContent='asking your provider…';
        try{const r=await Mail.testAccount(cfgOf());
          show(!!(r&&r.ok),(r&&r.ok)?'IMAP and SMTP both answered':friendlyErr((r&&r.error)||'connection failed'))}
        catch(e){show(false,friendlyErr(e.message||'failed'))}
        b.disabled=false;b.textContent='TEST'});
      g('emadd').addEventListener('click',async()=>{
        const c=cfgOf();
        if(!c.email||!c.pass||!c.imapHost||!c.smtpHost){show(false,'email, password and both hosts are required');return}
        const b=g('emadd');b.disabled=true;b.textContent='CONNECTING…';msg.style.color='';msg.textContent='checking IMAP and SMTP before saving…';
        // addAccount probes both servers itself and refuses to store an account that cannot
        // connect — so reaching the success branch means mail can actually be read and sent.
        try{const r=await Mail.addAccount(c);
          if(r&&r.ok){Caps.set('email',1);Toast.show('Email connected — opening your inbox');secEmail();openPanel('email')}
          else{b.disabled=false;b.textContent='CONNECT';show(false,friendlyErr((r&&r.error)||'could not connect'))}}
        catch(e){b.disabled=false;b.textContent='CONNECT';show(false,friendlyErr(e.message||'failed'))}});
      // Report what the bridge actually did. Announcing success without reading the
      // result is how a removal that never happened looked like one that did.
      pane.querySelectorAll('[data-emdef]').forEach(b=>b.addEventListener('click',async()=>{
        let r;try{r=await Mail.setDefault(b.dataset.emdef)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        Toast.show(r&&r.ok?'Default account changed':('Could not change the default: '+((r&&r.error)||'unknown')));secEmail()}));
      pane.querySelectorAll('[data-emrm]').forEach(b=>b.addEventListener('click',async()=>{
        if(!b.dataset.armed){b.dataset.armed='1';b.textContent='confirm?';setTimeout(()=>{if(b&&b.dataset.armed){b.removeAttribute('data-armed');b.textContent='remove'}},2500);return}
        b.disabled=true;b.textContent='removing…';
        let r;try{r=await Mail.removeAccount(b.dataset.emrm)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        Toast.show(r&&r.ok?'Account removed':('Could not remove it: '+((r&&r.error)||'unknown')));
        Bus.emit('email:accounts');secEmail()}));
    }
    async function secReminders(){
      loading();
      let rs=[];try{const r=await RPC('reminders','list',{status:'all'});rs=Array.isArray(r)?r:(r&&r.items)||[]}catch(e){return fail(e)}
      pane.innerHTML='<div class="sethead">REMINDERS</div>'+(rs.length?rs.slice(0,10).map(x=>`<div class="setline"><span style="flex:1">${escHtml(x.note||x.title||'')}</span><span class="dim">${x.remindAt?new Date(x.remindAt).toLocaleString():''}</span></div>`).join(''):'<div class="qempty" style="padding:12px">No reminders.</div>')+
        '<div class="btnrow" style="margin-top:10px"><button class="btn" id="srem">OPEN REMINDERS</button></div>';
      pane.querySelector('#srem').addEventListener('click',()=>openPanel('reminders'));
    }
    function secToolsList(){
      const TOOLS=[
        ['brain','Brain','persistent memory · which model answers','#i-brain'],
        ['research','Browser','browse the web inside CLONE FRAME','#i-globe'],
        ['notes','Notes','markdown · search','#i-notes'],
        ['tasks','Tasks','cron · the agent works on its own','#i-tasks'],
        ['__theme','Theme','restyle the interface — pick or create a theme','#i-pal'],
      ];
      const CAP=Store.get().caps;
      const capRow=(k,label,sub)=>`<div class="autotoggle"><div><b>${label}</b><div class="sub">${sub}</div></div><div class="sw3 ${CAP[k]?'on':''}" data-cap="${k}"><i></i></div></div>`;
      pane.innerHTML='<div class="sethead">TOOLS</div>'+TOOLS.map(t=>`<div class="setline"><svg style="width:13px;height:13px;color:var(--accent);flex:none"><use href="${t[3]}"/></svg><span style="flex:1;margin-left:4px"><b style="font-size:10.5px;color:var(--fg)">${t[1]}</b> <span class="dim" style="font-size:10px">${t[2]}</span></span><button class="btn mini" data-open="${t[0]}">OPEN</button></div>`).join('')
        +'<div class="sethead">SHORTCUTS — the panels you have used</div>'
        +capRow('machine','My Machine','real shell + BYOK brain')
        +capRow('agents','My Agents','connect the real iCLONE / VEGETA')
        +capRow('email','Email','connect, write and send email')
        +capRow('automations','Automations','the agent proposes actions (with approval)')
        +'<div style="font-size:10px;color:var(--ink-faint);margin:2px 0 4px;line-height:1.6">These are a <b>record, not a gate</b>: opening a panel marks it here, and clearing one only forgets it until you open that panel again. Every panel stays reachable from the launcher and ⌘K either way. What an agent may DO is in <b>Machine → permissions</b>, not here.<br>CODE · HARNESS · LAB are always available. Nothing starts on its own — every action passes Safety and your approval.</div>';
      pane.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{const t=b.dataset.open;openPanel(t==='__theme'?'theme':t)}));
      // The toast used to say "Enabled:"/"Disabled:", which is what made this look like a gate.
      // Nothing reads Caps as a permission — openPanel only ever SETS it ("using = activating").
      // Say what actually happens.
      pane.querySelectorAll('[data-cap]').forEach(sw=>sw.addEventListener('click',()=>{const k=sw.dataset.cap,v=!Caps.on(k);Caps.set(k,v);sw.classList.toggle('on',v);Toast.show(v?('Marked as used: '+k):('Forgotten: '+k+' — opening it marks it again'))}));
    }
    async function secAgentTools(){
      loading();
      let perms={},tools=[],rpcp={mode:'open',allow:[],deny:[]};
      try{perms=await RPC('permissions','get')}catch(e){return fail(e)}
      try{tools=await RPC('admin','tools')}catch(_){}
      try{const r=await RPC('rpcallow','get');if(r&&r.ok)rpcp=r}catch(_){}
      const mc=!!perms.machineControl;
      const rows=[['fullAccess','Full app access','the LLM can open any tab and act inside the HUB'],['rootMode','Root mode (sudo)','allows sudo commands in the terminal (asks your password each time)'],['autoAutomations','Automations without approval','the agent runs services/automations on its own'],['fileWrite','Write files','the agent can create and edit files on your machine'],['webAccess','Browse the web','the agent can search and open pages'],['autoEmail','Send email without approval','the agent sends email automatically'],['ssh','Remote servers (SSH)','open SSH sessions to your own saved servers/VMs — kept separate from full machine control (remote reach ≠ local)'],['matrix','MATRIX engine control','start and stop the local cluster engine from the MATRIX tab — its own gate, a resident daemon is a deliberate choice']];
      pane.innerHTML='<div class="sethead">FULL MACHINE CONTROL</div>'+
        `<div class="autotoggle" style="border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 7%,transparent)"><div><b style="color:var(--accent)">Full machine control</b><div class="sub">Let your agent do ANYTHING on this computer — open any app or folder, run any command, automate the machine. One prompt in CODE is enough. This is your whole workstation, fully driveable by the AI.</div></div><div class="sw3 ${mc?'on':''}" data-perm="machineControl"><i></i></div></div>`+
        `<div class="secnote" style="${mc?'':'display:none'}" id="mcnote">✓ Full machine control is ON — the agent can open apps, folders and run anything you ask. The catastrophic-command guard (rm -rf /, mkfs, dd to disk) stays active even now, to protect you from mistakes.</div>`+
        '<div class="sethead">GRANULAR POWERS'+(mc?' <span style="color:var(--accent);font-weight:400">· all covered by Full machine control</span>':'')+'</div><div style="font-size:10px;color:var(--ink-faint);line-height:1.5;margin-bottom:8px">Everything is <b>OFF</b> by default. Enable only what you want — or flip the master switch above.</div>'+
        rows.map(r=>{const own=r[0]==='autoEmail'||r[0]==='ssh'||r[0]==='matrix';return `<div class="autotoggle" style="${mc&&!own?'opacity:.55':''}"><div><b>${r[1]}</b><div class="sub">${r[2]}</div></div><div class="sw3 ${(perms[r[0]]||(mc&&!own))?'on':''}" data-perm="${r[0]}"><i></i></div></div>`}).join('')+
        '<div class="secnote">Root mode asks for your password at the moment (never stored). Catastrophic patterns (rm -rf /, mkfs, dd to disk) are ALWAYS blocked, even as root.</div>'+
        // What these switches ARE, said plainly. Only ssh, matrix and root are enforced in the
        // daemon; the rest are checked in the agent's tool loop. bridge/rpcallow.mjs says why in
        // its own header — whoever holds the pairing token already has a shell, so there is no
        // boundary at that layer to lose. That is a sound design, and nothing on screen said it.
        // A row that reads like a lock will be read as a lock.
        '<div class="secnote">These shape what your agent <b>reaches for</b> in normal operation — they are not a sandbox. <b>ssh</b>, <b>MATRIX</b> and <b>Root mode</b> are enforced inside the HUB Bridge itself; the rest are enforced in the agent&rsquo;s own tool loop. Any process holding your pairing token already has a shell on this machine, so treat that token the way you treat your password.</div>'+
        '<div class="sethead">AGENT TOOLS — what the agent may use</div>'+(tools.length?tools.map(t=>`<div class="autotoggle"><div><b>${escHtml(t.name)}</b><div class="sub">${escHtml(t.kind||'')} ${escHtml((t.scopes||[]).join(' '))}</div></div><div class="sw3 ${t.enabled?'on':''}" data-tool="${t.id}"><i></i></div></div>`).join(''):'<div style="font-size:10px;color:var(--ink-faint)">No tools.</div>')+
        '<div class="sethead">app_rpc ALLOWLIST — yours to write</div>'+
        '<div style="font-size:10px;color:var(--ink-faint);line-height:1.6;margin-bottom:8px">Through <span class="path">app_rpc</span> the agent can call any bridge module — that is the point, and CLONE FRAME ships it <b>wide open</b>. If you want a narrower agent, write your own list here. It applies to <b>the agent\'s</b> calls only; this interface is never constrained by it.<br><span style="color:var(--ink-dim)">One entry per line: <span class="path">module</span> for a whole module, or <span class="path">module.fn</span> for one function.</span></div>'+
        `<div class="autotoggle"><div><b>Restrict the agent to a list</b><div class="sub">Off = everything is allowed except what you block. On = nothing is allowed except what you allow.</div></div><div class="sw3 ${rpcp.mode==='allowlist'?'on':''}" id="rpcmode"><i></i></div></div>`+
        `<div class="setline" style="display:block"><div style="font-size:10px;color:var(--ink-dim);margin-bottom:4px">${rpcp.mode==='allowlist'?'ALLOW — the only calls the agent may make':'BLOCK — calls the agent may never make'}</div><textarea id="rpclist" spellcheck="false" style="width:100%;min-height:72px;background:var(--bg-2,#111);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px;font:11px/1.5 ui-monospace,monospace;resize:vertical" placeholder="servers.run&#10;pty&#10;web.fetchUrl">${escHtml((rpcp.mode==='allowlist'?rpcp.allow:rpcp.deny).join('\n'))}</textarea><div style="display:flex;gap:6px;margin-top:6px"><button class="btn acc" id="rpcsave">SAVE</button><button class="btn" id="rpcreset">RESET</button></div></div>`+
        '<div class="secnote">This is a guardrail on the agent, not a security boundary — anything already holding the bridge token can call a module directly. For confinement inside the agent itself, install the guardrails from <span class="path">pi.dev</span>.</div>';
      // "Is permission X on" was derived twice and the two disagreed. The ROW renders the
      // EFFECTIVE value — `perms[k]||(mc&&!own)` — so under Full machine control the granular
      // rows paint as ON while their stored flags are false. The click then derived the new
      // value from that painted class, so clicking an implied row wrote `false` over a `false`,
      // reported success, and flipped back on the next render. Derive from the STORED value,
      // and when the master is what is switching this row on, say so rather than pretend.
      pane.querySelectorAll('[data-perm]').forEach(sw=>sw.addEventListener('click',async()=>{const k=sw.dataset.perm,ownGate=(k==='autoEmail'||k==='ssh'||k==='matrix');
        if(perms.machineControl&&!ownGate&&!perms[k]){Toast.show('Governed by Full machine control — turn that off to set this one individually');return}
        const on=!perms[k];try{await RPC('permissions','set',{[k]:on});perms[k]=on;Bus.emit('permissions:changed');if(k==='machineControl'){Toast.show(on?'Full machine control ON — the agent can do anything you ask':'Full machine control off');secAgentTools()}else{sw.classList.toggle('on',on);Toast.show((on?'Enabled: ':'Disabled: ')+k)}}catch(e){Toast.show(e.message)}}));
      pane.querySelectorAll('[data-tool]').forEach(sw=>sw.addEventListener('click',async()=>{const on=!sw.classList.contains('on');await RPC('admin','setToolEnabled',sw.dataset.tool,on);sw.classList.toggle('on',on)}));
      // app_rpc allowlist. The textarea edits whichever list the current mode uses, so the
      // owner never has to reason about two lists at once; flipping the mode re-renders.
      const rpcLines=()=>String((pane.querySelector('#rpclist')||{}).value||'').split('\n').map(x=>x.trim()).filter(Boolean);
      const rpcMode=pane.querySelector('#rpcmode');
      if(rpcMode)rpcMode.addEventListener('click',async()=>{const on=!rpcMode.classList.contains('on');try{await RPC('rpcallow','set',{mode:on?'allowlist':'open'});Toast.show(on?'app_rpc restricted to your allowlist':'app_rpc open — only your blocked entries are refused');secAgentTools()}catch(e){Toast.show(e.message)}});
      const rpcSave=pane.querySelector('#rpcsave');
      if(rpcSave)rpcSave.addEventListener('click',async()=>{const list=rpcLines();const patch=rpcp.mode==='allowlist'?{allow:list}:{deny:list};try{const r=await RPC('rpcallow','set',patch);const kept=(rpcp.mode==='allowlist'?r.allow:r.deny)||[];Toast.show(kept.length===list.length?'Saved — '+kept.length+' entr'+(kept.length===1?'y':'ies'):'Saved '+kept.length+' of '+list.length+' — the rest were not valid module or module.fn names');secAgentTools()}catch(e){Toast.show(e.message)}});
      const rpcReset=pane.querySelector('#rpcreset');
      if(rpcReset)rpcReset.addEventListener('click',async()=>{try{await RPC('rpcallow','reset');Toast.show('app_rpc back to the shipped default — wide open');secAgentTools()}catch(e){Toast.show(e.message)}});
    }
    // ----- SESSION — the pairing token and how long it lives (bridge/session.mjs).
    // Permanent is what ships and what every existing install keeps; everything in this
    // room is the owner deciding otherwise.
    async function secSession(){
      loading();
      // A bridge older than this build answers "unknown module" — say what to do, not HTTP 404.
      let s=null;try{const r=await RPC('session','get');if(r&&r.ok)s=r}catch(_){}
      if(!s)return fail(new Error('Session needs a bridge running this build — quit and relaunch the app.'));
      const exp=s.mode==='expiring';
      const left=ms=>{const m=Math.max(0,Math.round((ms||0)/60000));if(m<60)return m+' min';const h=Math.floor(m/60);if(h<24)return h+'h'+(m%60?' '+(m%60)+'m':'');return Math.floor(h/24)+'d'+(h%24?' '+(h%24)+'h':'')};
      const when=ts=>{try{return new Date(ts).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}catch(_){return ''}};
      // show the lifetime in whichever unit the owner most likely typed it in
      const unit=s.hours<1?'minutes':(s.hours>=24&&s.hours%24===0?'days':'hours');
      const amount=unit==='minutes'?Math.round(s.hours*60):unit==='days'?s.hours/24:s.hours;
      const selStyle='background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:10px;font-family:var(--mono)';
      const numStyle='width:78px;background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:11px;font-family:var(--mono);text-align:right';
      pane.innerHTML='<div class="sethead">SESSION — THE PAIRING TOKEN</div>'+
        '<div style="font-size:10.5px;color:var(--ink-dim);line-height:1.7;margin-bottom:10px">Every window, terminal and agent on this machine reaches the HUB Bridge with one secret — the <b>pairing token</b>. It is minted here, kept owner-only at <span class="path">~/.clone-frame-hub/bridge.token</span>, and never leaves this computer.<br><span style="color:var(--ink-faint)">It stays <b>permanent</b> unless you say otherwise: a local app should not log you out. Give it a lifetime if you would rather it retired itself — a machine you share, a screen you cast, or plain hygiene.</span></div>'+
        `<div class="autotoggle"><div><b>Let this session expire</b><div class="sub">Off — the token is permanent (default). On — it dies after the time you set, and the bridge retires it the moment it is next used.</div></div><div class="sw3 ${exp?'on':''}" id="sesmode"><i></i></div></div>`+
        `<div class="setline" style="${exp?'':'display:none'}" id="sesrow"><span style="flex:1">Lifetime</span><span style="display:flex;gap:6px;align-items:center"><input id="sesnum" type="number" min="1" step="1" value="${escAttr(String(amount))}" style="${numStyle}"><select id="sesunit" style="${selStyle}"><option value="minutes"${unit==='minutes'?' selected':''}>minutes</option><option value="hours"${unit==='hours'?' selected':''}>hours</option><option value="days"${unit==='days'?' selected':''}>days</option></select><button class="btn mini" id="sesset">SET</button></span></div>`+
        `<div class="setline"><span style="flex:1">Status</span><span class="dim" style="color:${exp?'var(--accent)':'var(--ok)'}">${exp?('expires in '+left(s.remainingMs)):'permanent — no expiry'}</span></div>`+
        (s.issuedAt?`<div class="setline"><span style="flex:1">Issued</span><span class="dim">${escHtml(when(s.issuedAt))}</span></div>`:'')+
        '<div class="sethead">ROTATE</div>'+
        '<div style="font-size:10px;color:var(--ink-faint);line-height:1.6;margin-bottom:8px">Replace the secret right now. <b>This window keeps working</b> — it receives the new token in the same reply. Every other open window, and any copy of the old one, stops immediately.</div>'+
        '<div class="btnrow"><button class="btn acc" id="sesrot">ROTATE NOW</button></div>'+
        '<div class="secnote">When a session expires this window simply stops being paired. <b>Relaunch the app</b> to get back in — the launcher reads the new token and pairs the window it opens. Be clear on what this is: a token is not a login. Anything already running as you can read the file directly, and always could. What a lifetime bounds is how long a token that got away keeps working. If you would rather the agent could not rotate it, add <span class="path">session</span> to your block list in Agent Tools.</div>';
      const rerender=()=>secSession();
      const mode=pane.querySelector('#sesmode');
      mode.addEventListener('click',async()=>{const on=!mode.classList.contains('on');try{await RPC('session','set',{mode:on?'expiring':'permanent'});Toast.show(on?'This session will expire — the clock starts now':'Token is permanent again');rerender()}catch(e){Toast.show(e.message)}});
      const setBtn=pane.querySelector('#sesset');
      if(setBtn)setBtn.addEventListener('click',async()=>{
        const n=Number(pane.querySelector('#sesnum').value),u=pane.querySelector('#sesunit').value;
        if(!isFinite(n)||n<=0)return Toast.show('Give the lifetime a number');
        const hours=u==='minutes'?n/60:u==='days'?n*24:n;
        try{const r=await RPC('session','set',{mode:'expiring',hours});Toast.show(r&&r.ok?('Lifetime set — expires in '+left(r.remainingMs)):'could not save');rerender()}catch(e){Toast.show(e.message)}
      });
      pane.querySelector('#sesrot').addEventListener('click',async()=>{
        try{const r=await RPC('session','rotate');
          if(r&&r.ok&&r.token){BridgeClient.setToken(r.token);Toast.show('New token — this window is already using it')}
          else Toast.show((r&&r.error)||'could not rotate');
          rerender()}catch(e){Toast.show(e.message)}
      });
    }
    // ----- USERS — who holds a key to this HUB.
    // The honest model: this bridge runs AS the owner, so every key that opens it gets the
    // owner's shell. Keys are therefore keys, never accounts, and the copy says so plainly
    // rather than dressing them up as roles. What the owner really controls is HOW MANY keys
    // exist, what each is for, how long it lives, and how fast it dies (bridge/session.mjs).
    async function secUsers(){
      loading();
      let users=[],ks={keys:[]};
      try{users=await RPC('admin','users')}catch(e){return fail(e)}
      try{const r=await RPC('session','keys');if(r&&r.ok)ks=r}catch(_){}
      const owner=(users[0]&&(users[0].name))||(Store.get().profile||{}).name||'owner';
      const when=ts=>{try{return new Date(ts).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}catch(_){return ''}};
      const left=ms=>{const m=Math.max(0,Math.round((ms||0)/60000));if(m<60)return m+' min';const h=Math.floor(m/60);return h<24?h+'h':Math.floor(h/24)+'d'};
      const selStyle='background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:10px;font-family:var(--mono)';
      const inStyle='background:color-mix(in srgb,var(--bg) 60%,transparent);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 9px;font-size:11px;font-family:var(--mono)';
      pane.innerHTML='<div class="sethead">THIS MACHINE</div>'+
        `<div class="setline"><span style="flex:1"><b>${escHtml(owner)}</b><div class="dim" style="font-size:10px">the account this HUB runs as — your files, your shell, your keys</div></span><span class="badge">owner</span></div>`+
        '<div class="sethead">KEYS TO THIS HUB</div>'+
        '<div class="setline" style="display:block;line-height:1.7;color:var(--ink-dim);font-size:10.5px">CLONE FRAME is open — anyone can run it, and you can hand out as many keys to <b>this</b> HUB as you want. Be clear about what a key is, because the app will not pretend otherwise: <b>the bridge runs as you</b>, so every key that opens it gets your shell, your files and your wallets. A key is a key, not a smaller kind of account.<br><span style="color:var(--ink-faint)">Issue one for a second window, another computer of yours, a colleague you actually trust at this desk, or an automation — name it so you know what you are revoking later, and give it a lifetime if it is temporary. Revoking is instant.</span></div>'+
        (ks.keys.length?ks.keys.map(k=>`<div class="setline"><span style="flex:1"><b>${escHtml(k.name)}</b><div class="dim" style="font-size:10px">issued ${escHtml(when(k.issuedAt))} · ${k.expiresAt?('expires in '+escHtml(left(k.remainingMs))):'no expiry'}</div></span><button class="btn mini" data-revoke="${escAttr(k.id)}">REVOKE</button></div>`).join(''):'<div class="setline"><span class="dim" style="font-size:10.5px">No extra keys — this HUB opens with yours alone.</span></div>')+
        '<div class="setline" style="display:block"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><input id="ukname" placeholder="what is this key for" spellcheck="false" style="'+inStyle+';flex:1;min-width:150px"><select id="ukmode" style="'+selStyle+'"><option value="permanent">no expiry</option><option value="expiring">expires in</option></select><input id="ukh" type="number" min="1" step="1" value="24" style="'+inStyle+';width:70px;text-align:right;display:none"><select id="ukunit" style="'+selStyle+';display:none"><option value="hours">hours</option><option value="days">days</option></select><button class="btn acc" id="ukadd">ISSUE KEY</button></div><div id="uknew" style="display:none;margin-top:8px"></div></div>'+
        '<div class="secnote">Your own key lives in <b>Settings → Session</b> — that is where you give it a lifetime or replace it. Real separate accounts, each with their own files and their own limits, would mean running a bridge per person; this one is local-first and deliberately single-owner. Anything else would be a login screen drawn on top of a shared shell, and that is worse than none.</div>';
      pane.querySelectorAll('[data-revoke]').forEach(b=>b.addEventListener('click',async()=>{
        try{const r=await RPC('session','revoke',b.dataset.revoke);Toast.show(r&&r.ok?'Key revoked — it stops working now':((r&&r.error)||'could not revoke'));secUsers()}catch(e){Toast.show(e.message)}
      }));
      const mode=pane.querySelector('#ukmode'),hEl=pane.querySelector('#ukh'),uEl=pane.querySelector('#ukunit');
      mode.addEventListener('change',()=>{const on=mode.value==='expiring';hEl.style.display=on?'':'none';uEl.style.display=on?'':'none'});
      pane.querySelector('#ukadd').addEventListener('click',async()=>{
        const name=(pane.querySelector('#ukname').value||'').trim();
        if(!name)return Toast.show('Name the key — future you needs to know what it opens');
        const patch={name,mode:mode.value};
        if(mode.value==='expiring'){const n=Number(hEl.value);if(!isFinite(n)||n<=0)return Toast.show('Give the lifetime a number');patch.hours=uEl.value==='days'?n*24:n}
        try{
          const r=await RPC('session','issue',patch);
          if(!r||!r.ok)return Toast.show((r&&r.error)||'could not issue');
          // Shown ONCE, here, and never again by any route — see bridge/session.mjs keys().
          const box=pane.querySelector('#uknew');
          box.style.display='';
          box.innerHTML='<div style="border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 7%,transparent);border-radius:8px;padding:9px 11px"><div style="font-size:10px;color:var(--accent);letter-spacing:.1em">COPY IT NOW — SHOWN ONCE</div><div class="path" style="font-size:11px;word-break:break-all;margin:5px 0 7px">'+escHtml('http://127.0.0.1:8765#token='+r.token)+'</div><div style="font-size:10px;color:var(--ink-faint);line-height:1.6">Paste that in MY MACHINE → HUB BRIDGE to pair with this key. We do not keep a copy you can read back: if it is lost, revoke it and issue another.</div></div>';
          Toast.show('Key issued — copy it now');
        }catch(e){Toast.show(e.message)}
      });
    }
    function secAppearance(){
      const cur=Store.get().theme,ALL=Themes.all();const curC=ALL[cur]||Themes.T.void;
      const sw=(names,rm)=>'<div class="swatches">'+names.map(n=>{const c=ALL[n];if(!c)return'';return `
        <div class="sw ${n===cur?'on':''} ${c.live?'live':''}" data-theme="${n}">
          ${rm?`<span class="del" data-rmtheme="${n}" style="position:absolute;top:5px;right:7px;font-size:10px;color:var(--ink-faint);cursor:pointer">✕</span>`:''}
          <div class="dots"><i style="background:${c.bg}"></i><i style="background:${c.panel}"></i><i style="background:${c.accent}"></i></div>
          <span>${n.toUpperCase()}</span>
        </div>`}).join('')+'</div>';
      const customs=Object.keys(Store.get().customThemes||{});
      pane.innerHTML='<div class="sethead">THEMES — BASE</div>'+sw(['void','origin','kernel','forge','soul','graphite'])
        +'<div class="sethead">THEMES — LIVE · ANIMATED BACKGROUND</div>'+sw(['neon','synapse','constellation','flux','embers','stardust'])
        +(customs.length?'<div class="sethead">YOUR THEMES</div>'+sw(customs,true):'')
        +'<div class="sethead">CREATE THEME — dark mono + 1 accent</div>'
        +'<div class="tcustom">'+['bg','fg','panel','border','accent'].map(k=>`<label>${k.toUpperCase()}<input type="color" data-k="${k}" value="${curC[k]}"></label>`).join('')+'</div>'
        +'<div class="trowsave"><input type="text" id="tname" placeholder="your theme name" maxlength="14"><button class="btn" id="tsave" style="padding:7px 12px;font-size:10px">SAVE</button></div>'
        +`<div class="setline">Density<div class="densseg" id="densseg">${['compact','cosy','comfy'].map(d=>`<button data-d="${d}" class="${Store.get().density===d?'on':''}">${d.toUpperCase()}</button>`).join('')}</div></div>`
        +`<div class="setline">Proximity animation<button class="btn" id="motionbtn">${Store.get().motion?'ON':'OFF'}</button></div>`
        +`<div class="setline">Grid layout<button class="btn" id="resetbtn">RESET</button></div>`;
      pane.querySelectorAll('.sw').forEach(swEl=>swEl.addEventListener('click',e=>{
        const rm=e.target.dataset.rmtheme;
        if(rm){Themes.remove(rm);secAppearance();return}
        Themes.apply(swEl.dataset.theme);secAppearance();
      }));
      pane.querySelectorAll('.tcustom input').forEach(inp=>inp.addEventListener('input',()=>document.documentElement.style.setProperty('--'+inp.dataset.k,inp.value)));
      pane.querySelector('#tsave').addEventListener('click',()=>{
        const name=(pane.querySelector('#tname').value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'')||'my-theme');
        const def={};pane.querySelectorAll('.tcustom input').forEach(i=>def[i.dataset.k]=i.value);
        if(Themes.register(name,def)){Toast.show('Theme "'+name.toUpperCase()+'" saved');secAppearance()}
        else Toast.show('Reserved name or 8-custom-theme limit reached');
      });
      pane.querySelector('#densseg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;Density.apply(b.dataset.d);pane.querySelectorAll('#densseg button').forEach(x=>x.classList.toggle('on',x===b))});
      pane.querySelector('#motionbtn').addEventListener('click',e=>{const s=Store.get();s.motion=!s.motion;Store.save();e.target.textContent=s.motion?'ON':'OFF';Bus.emit('motion',s.motion);Themes.apply(s.theme)});
      pane.querySelector('#resetbtn').addEventListener('click',()=>{Grid.reset();Toast.show('Grid layout reset')});
    }
    function secShortcuts(){
      const K=[['⌘K','Search / command palette'],['click the △','Menu of everything'],['G · T/H/L/A/M/D','Go to Terminal/Harness/LAB/Agent/Machine/Settings'],['[ ]','Switch conversation (console)'],['↑ ↓','History / recall (terminal)'],['! command','Real shell (console)'],['/ command','Commands'],['Ctrl+C','Interrupt (terminal)'],['Ctrl+L','Clear (terminal)']];
      pane.innerHTML='<div class="sethead">KEYBOARD SHORTCUTS</div>'+K.map(k=>`<div class="setline"><span style="flex:1">${escHtml(k[1])}</span><kbd class="skbd">${escHtml(k[0])}</kbd></div>`).join('');
    }
    function secAccount(){
      const P=Store.get().profile,acc=WalletAuth.access();
      pane.innerHTML='<div class="sethead">PROFILE</div>'
        +`<div class="trowsave" style="margin-bottom:8px"><input type="text" id="pname" placeholder="your name" value="${escAttr(P.name||'')}" maxlength="28"></div>`
        +`<div class="setline">Access<span style="margin-left:auto;font-size:10px;color:${acc.ok?'var(--ok)':'var(--ink-faint)'}">${acc.ok?'WALLET CONNECTED · '+WalletAuth.short(WalletAuth.addr()):'no wallet'}</span></div>`
        +'<div style="font-size:10px;color:var(--ink-faint);line-height:1.5;margin:4px 0 10px">3 keys (one is enough): 100k $ICLONE staked · OG CARD · house iNFT. '+(acc.ok?'':'Connect the wallet in the top-right corner.')+'</div>'
        +'<div class="sethead">DATA</div>'
        +'<div class="setline">Export / import settings<span style="margin-left:auto;display:flex;gap:6px"><button class="btn" id="expbtn" style="padding:5px 12px;font-size:10.5px">EXPORT</button><button class="btn" id="impbtn" style="padding:5px 12px;font-size:10.5px">IMPORT</button></span></div>'
        +'<div class="setline" style="border-color:color-mix(in srgb,var(--accent) 30%,transparent)">Delete everything (danger zone)<button class="btn" id="wipebtn" style="margin-left:auto;padding:5px 12px;font-size:10.5px;border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent)">DELETE</button></div>'
        +'<div class="sethead">ABOUT</div>'
        +'<div style="font-size:10.5px;color:var(--ink-faint);line-height:1.6">CLONE FRAME HUB · v@@CF_VERSION@@ EXTRACTION<br>Own Your AI — Terminal · Harness · LAB. iNFT on Base 8453. BYOK: your key, your model. Our own engines: iT terminal (workspaces · splits · persistent sessions), the HUB bridge, MATRIX. MIT.</div>';
      pane.querySelector('#pname').addEventListener('change',e=>{Store.get().profile.name=e.target.value.trim();Store.save()});
      pane.querySelector('#expbtn').addEventListener('click',()=>{
        const blob=new Blob([JSON.stringify(Store.get(),null,2)],{type:'application/json'});
        const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='clone-frame-hub.json';a.click();
        Toast.show('Settings exported');
      });
      pane.querySelector('#impbtn').addEventListener('click',()=>{
        const inp=document.createElement('input');inp.type='file';inp.accept='application/json';
        inp.onchange=()=>{const f=inp.files[0];if(!f)return;const rd=new FileReader();
          rd.onload=()=>{try{Object.assign(Store.get(),JSON.parse(rd.result));Store.save();Toast.show('Imported — reloading');setTimeout(()=>location.reload(),700)}catch(e){Toast.show('Invalid file')}};rd.readAsText(f)};
        inp.click();
      });
      pane.querySelector('#wipebtn').addEventListener('click',e=>{
        if(e.target.dataset.armed){localStorage.clear();sessionStorage.clear();location.reload();return}
        e.target.dataset.armed='1';e.target.textContent='CONFIRM?';
        setTimeout(()=>{if(e.target){delete e.target.dataset.armed;e.target.textContent='DELETE'}},3000);
      });
    }
    async function secSystem(){
      loading();
      let sys={};try{sys=await RPC('admin','system')}catch(e){return fail(e)}
      pane.innerHTML=`<div class="sethead">SYSTEM</div><div class="setline"><span style="flex:1">Node</span><span class="dim">${escHtml(sys.node||'')}</span></div><div class="setline"><span style="flex:1">Uptime</span><span class="dim">${Math.round((sys.uptimeSec||0)/60)} min</span></div><div class="setline"><span style="flex:1">Scheduler</span><span class="dim" style="color:${sys.schedulerHealthy?'var(--ok)':'var(--accent)'}">${sys.schedulerHealthy?'healthy':'off'}</span></div><div class="setline"><span style="flex:1">Stores</span><span class="dim">${(sys.stores||[]).length} files</span></div><div class="btnrow"><button class="btn" id="admlogs">VIEW LOGS</button></div><pre id="admlogsout" class="mailtext" style="max-height:160px;overflow:auto;display:none"></pre>`;
      pane.querySelector('#admlogs').addEventListener('click',async()=>{const out=pane.querySelector('#admlogsout');out.style.display='';out.textContent='…';try{const lines=await RPC('admin','logs',{lines:80});out.textContent=(lines||[]).join('\n')}catch(e){out.textContent=e.message}});
    }
    const fmtB=b=>b>=1e9?(b/1e9).toFixed(1)+' GB':b>=1e6?(b/1e6).toFixed(1)+' MB':b>=1e3?(b/1e3).toFixed(0)+' KB':(b||0)+' B';
    async function secFolders(){
      loading();
      let s,st;try{s=await RPC('folders','structure');st=await RPC('folders','stats').catch(()=>null)}catch(e){return fail(e)}
      if(!s||!s.ok)return fail((s&&s.error)||'folders unavailable');
      const totals={};(st&&st.ok?st.totals:[]).forEach(t=>totals[t.rel]=t);
      const tops=s.nodes.filter(n=>!n.rel.includes('/'));
      pane.innerHTML='<div class="sethead">FOLDER SYSTEM</div>'+
        '<div style="font-size:10.5px;color:var(--ink-faint);line-height:1.6;margin-bottom:10px">Everything the app installs and creates lives here — local & remote models, caches, data, and each agent\'s <b>neural_soul.md</b>. Click a folder to open it: its contents unfold right beneath it, and clicking a file opens it to read or edit. Edit inside the app or straight in Finder.</div>'+
        '<div class="setline"><span style="flex:1;font-family:var(--mono);font-size:10px;color:var(--fg);overflow:hidden;text-overflow:ellipsis">'+escHtml(s.root)+'</span><button class="btn mini" id="foreveal">Open in Finder ↗</button><button class="btn mini" id="forecreate">Re-create</button></div>'+
        '<div class="fldtree" id="fldtree"></div>'+
        '<div class="fld-viewov" id="fldview" style="display:none"></div>';
      const treeRoot=pane.querySelector('#fldtree'),viewOv=pane.querySelector('#fldview');
      const chev='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
      const pad=d=>(6+d*15)+'px';
      // open a file in the shared viewer (View / Diff / Edit) as a retractable overlay over the tree
      function openFile(it){
        if(!it._abs){Toast.show('cannot resolve path');return}
        treeRoot.style.display='none';viewOv.style.display='';viewOv.innerHTML='';
        const cwd=it._abs.slice(0,it._abs.lastIndexOf('/'))||it._abs;
        openFileView(viewOv,it._abs,{cwd,onBack:()=>{viewOv.style.display='none';viewOv.innerHTML='';treeRoot.style.display=''}});
      }
      // one row = one folder or file; folders lazily unfold their children directly beneath them
      function fldRow(it,depth){
        const wrap=document.createElement('div');wrap.className='fld-node';
        const isDir=it.type==='dir';
        const row=document.createElement('div');row.className='fld-row'+(isDir?' dir':' file');row.style.paddingLeft=pad(depth);
        const meta=isDir?(it.items!=null?(it.items+' · '+fmtB(it.bytes||0)):'folder'):fmtB(it.size||0);
        row.innerHTML='<span class="fld-chev">'+(isDir?chev:'')+'</span>'+
          '<svg class="fld-ic" style="color:'+(isDir?'var(--accent)':'var(--ink-faint)')+'"><use href="#i-'+(isDir?'frame':'harness')+'"/></svg>'+
          '<span class="fld-nm"><b>'+escHtml(it.name)+'</b>'+(it.desc?' <span class="dim">'+escHtml(it.desc)+'</span>':'')+'</span>'+
          '<span class="fld-mt dim">'+escHtml(meta)+'</span>'+
          '<button class="btn mini fld-rev" title="Open in Finder">↗</button>';
        wrap.appendChild(row);
        const kids=document.createElement('div');kids.className='fld-kids';kids.style.display='none';wrap.appendChild(kids);
        let loaded=false,open=false;
        row.querySelector('.fld-rev').addEventListener('click',async e=>{e.stopPropagation();const rr=await RPC('folders','revealPath',it.rel);if(rr&&rr.ok&&Bridge.on())Bridge.shell('open '+shq(rr.abs),()=>{})});
        row.addEventListener('click',async()=>{
          if(!isDir){openFile(it);return}
          open=!open;wrap.classList.toggle('open',open);kids.style.display=open?'':'none';
          if(open&&!loaded){
            loaded=true;kids.innerHTML='<div class="fld-empty" style="padding-left:'+pad(depth+1)+'">…</div>';
            const tr=await RPC('folders','tree',it.rel).catch(()=>null);
            kids.innerHTML='';
            if(!tr||!tr.ok){kids.innerHTML='<div class="fld-empty" style="padding-left:'+pad(depth+1)+'">could not read this folder</div>';return}
            const items=(tr.items||[]).slice().sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):(a.type==='dir'?-1:1));
            if(!items.length){kids.innerHTML='<div class="fld-empty" style="padding-left:'+pad(depth+1)+'">Empty</div>';return}
            items.forEach(ch=>{ch._abs=tr.abs+'/'+ch.name;kids.appendChild(fldRow(ch,depth+1))});
          }
        });
        return wrap;
      }
      tops.forEach(n=>{const t=totals[n.rel]||{};treeRoot.appendChild(fldRow({name:n.rel,type:'dir',rel:n.rel,desc:n.desc,items:t.items,bytes:t.bytes},0))});
      pane.querySelector('#foreveal').addEventListener('click',()=>{if(Bridge.on())Bridge.shell('open '+shq(s.root),()=>{});Toast.show('Opening '+s.root)});
      pane.querySelector('#forecreate').addEventListener('click',async()=>{const r=await RPC('folders','ensure');Toast.show('Structure ensured — '+((r&&r.created&&r.created.length)||0)+' created');secFolders()});
    }
    async function secServers(){
      loading();
      let r;try{r=await RPC('servers','list')}catch(e){return fail(e)}
      const servers=(r&&r.ok?r.servers:[]);
      pane.innerHTML='<div class="sethead">ONLINE SERVERS</div>'+
        '<div style="font-size:10.5px;color:var(--ink-faint);line-height:1.6;margin-bottom:10px">Connect a DigitalOcean droplet (or any SSH server) and control it from inside CLONE FRAME — deploy your agent, run automations, all from <b>LAB → iNFT → Online Server</b> or by just asking in CODE.</div>'+
        (servers.length?servers.map(s=>`<div class="setline"><svg style="width:13px;height:13px;color:var(--accent);flex:none"><use href="#i-cosmos"/></svg><span style="flex:1;margin-left:4px;min-width:0"><b style="font-size:10.5px;color:var(--fg)">${escAttr(s.name)}</b> <span class="dim" style="font-size:10px">${escAttr(s.host||s.provider||'')}${s.hasToken?' · DO token ✓':''}${s.hasKey?' · key ✓':''}</span></span><button class="btn mini" data-test="${escAttr(s.id)}">Test</button><button class="btn mini" data-rm="${escAttr(s.id)}">✕</button></div>`).join(''):'<div class="qempty" style="padding:12px">No servers yet — add one below.</div>')+
        '<div class="sethead">ADD A SERVER</div>'+
        '<div class="mcrow"><input id="svname" placeholder="Name (e.g. my droplet)"><input id="svhost" placeholder="IP or host (leave blank to provision)"></div>'+
        '<div class="mcrow"><input id="svuser" placeholder="SSH user" value="root"><input id="svkey" placeholder="SSH key path (~/.ssh/id_ed25519)"></div>'+
        '<div class="mcrow"><input id="svtoken" type="password" placeholder="DigitalOcean API token (optional — enables provisioning)"><button class="btn acc" id="svadd">✓ ADD</button></div>'+
        '<div class="mcmsg" id="svmsg"></div>'+
        '<div style="font-size:10px;color:var(--ink-faint);line-height:1.6;margin-top:8px">Your keys and tokens are stored only on your machine (<span style="font-family:var(--mono)">~/.clone-frame-hub</span>, chmod 600) — never in the app UI, never in the cloud, never logged.</div>';
      const msg=pane.querySelector('#svmsg');
      pane.querySelector('#svadd').addEventListener('click',async()=>{
        const svtok=pane.querySelector('#svtoken').value.trim();
        const cfg={name:pane.querySelector('#svname').value.trim(),host:pane.querySelector('#svhost').value.trim(),user:pane.querySelector('#svuser').value.trim()||'root',keyPath:pane.querySelector('#svkey').value.trim(),doToken:svtok,provider:svtok?'digitalocean':'ssh'};
        if(!cfg.name){msg.style.color='var(--accent)';msg.textContent='Give it a name';return}
        msg.style.color='var(--ink-faint)';msg.textContent='adding…';
        try{const a=await RPC('servers','add',cfg);if(a&&a.ok){Toast.show('Server added');secServers()}else{msg.style.color='var(--accent)';msg.textContent='✗ '+((a&&a.error)||'failed')}}catch(e){msg.style.color='var(--accent)';msg.textContent=e.message}
      });
      pane.querySelectorAll('[data-test]').forEach(b=>b.addEventListener('click',async()=>{b.textContent='…';const t=await RPC('servers','test',b.dataset.test);b.textContent=t&&t.reachable?'✓ up':'✗ down';Toast.show(t&&t.reachable?'Reachable':'Not reachable '+((t&&t.detail)||''))}));
      pane.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{await RPC('servers','remove',b.dataset.rm);Toast.show('Removed');secServers()}));
    }
    nav.addEventListener('click',e=>{const b=e.target.closest('button');if(b)go(b.dataset.sec)});
    go('addmodels');
  }
