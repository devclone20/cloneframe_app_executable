  function wireSettings(p){
    // ----- sidebar-nav settings (left column of sections, content pane on the right) -----
    const nav=p.querySelector('#setnav'),pane=p.querySelector('#setpane');
    const loading=()=>{pane.innerHTML='<div class="qempty" style="padding:16px">loading…</div>'};
    const fail=e=>{pane.innerHTML='<div class="qempty" style="color:var(--accent);padding:16px">'+escHtml(e.message||e)+'</div>'};
    function needBridge(){
      pane.innerHTML='<div class="qempty" style="padding:22px;line-height:1.7">Connect the <b>HUB Bridge</b> (MY MACHINE) for this section.<br><br><button class="btn" id="spm">OPEN MY MACHINE</button></div>';
      pane.querySelector('#spm').addEventListener('click',()=>openPanel('machine'));
    }
    function go(name){
      nav.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.sec===name));
      if(['addmodels','added','aidefaults','piagent','integrations','email','reminders','agenttools','users','system','folders','servers'].includes(name)&&!Bridge.on())return needBridge();
      const SEC={addmodels:secAddModels,added:secAdded,aidefaults:secDefaults,piagent:secPiAgent,search:secSearch,itterm:secIT,integrations:secIntegrations,email:secEmail,reminders:secReminders,appearance:secAppearance,magicframes:secMagicFrames,shortcuts:secShortcuts,account:secAccount,tools:secToolsList,licenses:secLicenses,folders:secFolders,servers:secServers,agenttools:secAgentTools,users:secUsers,system:secSystem};
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
        +'<div class="setline" style="line-height:1.6;color:var(--ink-dim);font-size:10.5px;display:block">Our terminal multiplexer: workspaces ▸ split panes ▸ tabs, a real TTY per tab, tmux attach (⌗), canvas mode (⌃⌘C), diff viewer (⌃⌘⇧D) and the file tree following the shell. Keyboard and command names are <b>cmux-compatible</b> — clean-room, no cmux code (credits: Settings → Licenses). The <b>it</b> CLI is LIVE inside iT shells: run <span class="path">it</span> for the welcome screen, <span class="path">it --help</span> for all commands (cmux names), <span class="path">it hooks setup</span>, <span class="path">it feedback</span>.</div>'
        +'<div class="setline">Default new tab<span style="margin-left:auto"><select id="itdeftab" style="'+selStyle+'"><option value="tty">Live terminal (tty)</option><option value="smart">Smart shell</option></select></span></div>'
        +'<div class="setline">Prompt theme — smart tabs (Oh My Zsh)<span style="margin-left:auto"><select id="itomz" style="'+selStyle+'"><option>robbyrussell</option><option>agnoster</option><option>powerlevel</option></select></span></div>'
        +'<div class="autotoggle"><div><b>Restore workspaces &amp; splits on launch</b><div class="sub">the layout comes back after a reload — each shell reopens at its folder</div></div><div class="sw3 '+(restore?'on':'')+'" id="itrestore"><i></i></div></div>'
        +'<div class="autotoggle"><div><b>Keep sessions alive across reloads</b><div class="sub">a reload reattaches to the SAME live shells (running commands survive) and replays their scrollback — tmux-style. Closing a tab still ends it. Detached shells are reaped after 60 min.</div></div><div class="sw3 '+(persist?'on':'')+'" id="itpersist"><i></i></div></div>'
        +'<div class="autotoggle"><div><b>Workspace auto-naming</b><div class="sub">unnamed workspaces take their git repo\'s name — deterministic, no LLM; a manual rename pins it</div></div><div class="sw3 '+(autoname?'on':'')+'" id="itautoname"><i></i></div></div>'
        +'<div class="setline">Live sessions<span style="margin-left:auto" class="dim" id="itcap">— · cap 24</span></div>'
        +'<div class="setline" style="display:block;color:var(--ink-dim);font-size:10px;line-height:1.6">Notifications: commands taking 15s+ raise one when they finish (any agent, build or deploy — visible from other workspaces). Terminals can also send OSC 9/777, and <span class="path">it notify</span> works from scripts. <b>⌘I</b> opens the list.</div>'
        +'<div class="sethead">AGENT HOOKS — NOTIFICATIONS FROM YOUR CODING AGENTS</div>'
        +'<div class="setline" style="display:block;color:var(--ink-dim);font-size:10px;line-height:1.6">Run <span class="path">it hooks setup</span> in any iT shell to wire <b>Claude Code</b> and <b>Codex</b> so every finished task raises an iT notification (⌘I) — like cmux\'s Automation. <span class="path">it hooks status</span> shows what\'s wired, <span class="path">it hooks remove</span> undoes it. Nothing is touched without you running the command.</div>'
        +'<div class="setline">Hooks state<span class="dim" id="ithooks" style="margin-left:auto;font-size:10px">checking…</span></div>'
        +'<div class="sethead">KEYBOARD — CMUX-COMPATIBLE · EVERY ROW REBINDABLE</div>'
        +'<div id="itkmap"></div>'
        +'<div class="setline"><span class="dim" style="font-size:10.5px">⌘1…9 go to workspace · ⌃1…9 go to tab (fixed)</span><span style="margin-left:auto"><button class="btn mini" id="itkreset">RESET ALL</button></span></div>'
        +'<div class="setline" style="display:block;color:var(--ink-faint);font-size:10px;line-height:1.6">Also by CLI, cmux-style: <span class="path">it shortcuts list</span> · <span class="path">it shortcuts set split-right cmd+e</span> · <span class="path">it shortcuts set new-workspace none</span> (unbind) · <span class="path">it shortcuts reset</span>.</div>';
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
            const done=()=>{removeEventListener('keydown',onk,true);kmDraw()};
            const onk=e=>{e.preventDefault();e.stopPropagation();
              if((e.key||'')==='Escape'){done();return}
              const c=evCombo(e);if(!c)return;
              const r=itKeymap.set(id,c);if(r.error)Toast.show(r.error);
              done();
            };
            addEventListener('keydown',onk,true);
          });
          row.querySelector('[data-k="un"]').addEventListener('click',()=>{itKeymap.set(id,'none');kmDraw()});
          row.querySelector('[data-k="rs"]').addEventListener('click',()=>{itKeymap.reset(id);kmDraw()});
        });
      };
      pane.querySelector('#itkreset').addEventListener('click',()=>{itKeymap.reset();kmDraw();Toast.show('iT shortcuts reset to defaults')});
      kmDraw();
    }
    function secLicenses(){
      const L=[
        ['cmux (Manaflow)','GPL-3.0 · behavior only','github.com/manaflow-ai/cmux','iT speaks the cmux keyboard & command language — clean-room, no cmux code bundled.'],
        ['tmux','ISC','github.com/tmux/tmux','iT attaches to your tmux sessions. Runs on your machine, not bundled.'],
        ['exo','Apache-2.0','github.com/exo-explore/exo','Local AI cluster — integration coming. Not bundled.'],
        ['xterm.js + addon-fit','MIT','github.com/xtermjs/xterm.js','In-app interactive terminal renderer.'],
        ['node-pty','MIT','github.com/microsoft/node-pty','Real interactive TTYs, in the HUB bridge.'],
        ['ws','MIT','github.com/websockets/ws','WebSocket transport for live terminals.'],
        ['Privy','Privy SDK license','privy.io','Sign-in (@privy-io/react-auth), vendored in the login island.'],
        ['React · React-DOM','MIT','react.dev','Runtime for the Privy login island.'],
      ];
      pane.innerHTML='<div class="sethead">OPEN-SOURCE LICENSES</div>'+
        '<div class="setline" style="line-height:1.6;color:var(--ink-dim);font-size:10.5px;display:block">CLONE FRAME is open source. Every bundled engine keeps its own license and travels with the app. iT is built on ideas from the open-source <b>cmux</b>, <b>tmux</b> and <b>exo</b> — cmux-compatible keys &amp; commands, clean-room code, none of their code bundled. Full texts live in <span class="path">THIRD-PARTY-NOTICES.md</span> and each <span class="path">apps/&lt;tool&gt;/NOTICE.md</span>.</div>'+
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
      pane.innerHTML=`
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
      const opts=sel=>['<option value="">— default (machine) —</option>'].concat(provs.flatMap(pr=>(pr.models||[]).map(m=>`<option value="${pr.id}::${escAttr(m)}" ${sel&&sel.providerId===pr.id&&sel.model===m?'selected':''}>${escAttr(pr.label||pr.provider)} · ${escAttr(m)}</option>`))).join('');
      pane.innerHTML='<div class="sethead">AI DEFAULTS — which model does what</div>'+caps.map(c=>`<div class="setline"><span style="flex:1">${c[1]}</span><select data-cap="${c[0]}" class="setsel">${opts(defs[c[0]])}</select></div>`).join('')+'<div style="font-size:10px;color:var(--ink-faint);padding:6px 2px">No selection → uses your machine\'s Anthropic key (default brain).</div>';
      pane.querySelectorAll('[data-cap]').forEach(s=>s.addEventListener('change',async()=>{const v=s.value;if(!v)await RPC('models','setDefault',s.dataset.cap,{providerId:null});else{const parts=v.split('::');await RPC('models','setDefault',s.dataset.cap,{providerId:parts[0],model:parts[1]})}Toast.show('Saved')}));
    }
    async function secSearch(){
      pane.innerHTML='<div class="sethead">SEARCH</div><div style="display:flex;margin-bottom:9px"><input id="ssq" placeholder="Search settings, tools, notes, docs, contacts…" style="all:unset;flex:1;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:10.5px;color:var(--fg);caret-color:var(--accent)"></div><div id="ssres" class="qempty" style="padding:10px;font-size:10px;line-height:1.6">Type to search the settings sections and everything indexed (notes · library · contacts · recipes · tasks · reminders · research).</div>';
      const SECS=[['addmodels','Add Models'],['added','Added Models'],['aidefaults','AI Defaults'],['piagent','Pi Agent'],['itterm','iT — Terminal'],['integrations','Integrations'],['email','Email'],['reminders','Reminders'],['appearance','Appearance'],['shortcuts','Shortcuts'],['account','Account'],['tools','Tools'],['licenses','Licenses'],['folders','Folders'],['servers','Servers'],['agenttools','Agent Tools'],['users','Users'],['system','System']];
      const inp=pane.querySelector('#ssq'),res=pane.querySelector('#ssres');let tmr=null;
      inp.addEventListener('input',()=>{clearTimeout(tmr);tmr=setTimeout(async()=>{
        const q=inp.value.trim().toLowerCase();
        if(!q){res.innerHTML='Type to search…';return}
        const hits=SECS.filter(x=>x[1].toLowerCase().includes(q)).map(x=>`<div class="setline" data-go="${x[0]}" style="cursor:pointer"><span style="flex:1">${x[1]}</span><span class="dim">settings</span></div>`).join('');
        let deep='';
        if(Bridge.on()){try{const r=await RPC('search','query',q);(r&&r.groups||[]).forEach(g=>{(g.items||[]).slice(0,4).forEach(it=>{deep+=`<div class="setline"><span style="flex:1">${escHtml(it.title||it.name||'')}</span><span class="dim">${escHtml(g.module||g.label||'')}</span></div>`})})}catch(_){}}
        res.innerHTML=(hits+deep)||'<div class="qempty">Nothing found.</div>';
        res.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.go)));
      },250)});
      inp.focus();
    }
    async function secIntegrations(){
      loading();
      let list=[];try{const r=await RPC('integrations','list');list=Array.isArray(r)?r:(r&&r.items)||[]}catch(e){return fail(e)}
      pane.innerHTML='<div class="sethead">INTEGRATIONS</div>'+(list.length?list.map(it=>`<div class="setline"><span style="flex:1"><b style="color:var(--fg);font-size:10.5px">${escHtml(it.name||it.type||'')}</b> <span class="dim" style="font-size:10px">${escHtml(it.type||'')} · ${escHtml(it.transport||'')}</span></span><span class="dim">${it.isDefault?'default':''}</span></div>`).join(''):'<div class="qempty" style="padding:12px">No integrations yet.</div>')+
        '<div class="btnrow" style="margin-top:10px"><button class="btn" id="sint">OPEN INTEGRATIONS</button></div>';
      pane.querySelector('#sint').addEventListener('click',()=>openPanel('integrations'));
    }
    async function secEmail(){
      loading();
      let acc=[];try{const r=await Mail.accounts();acc=Array.isArray(r)?r:(r&&r.accounts)||[]}catch(e){return fail(e)}
      const AUT=[['off','Off','agents never send — you write and send yourself'],['show-first','Show first','the agent composes; you review, then it sends'],['direct','Direct','the agent composes and sends directly (factory default)'],['full-auto','Full-auto','autonomous email — the agent sends on its own, within your rules']];
      const cur=(Store.get().email&&Store.get().email.autonomy)||'direct';
      pane.innerHTML='<div class="sethead">EMAIL ACCOUNTS</div>'+(acc.length?acc.map(a=>`<div class="setline"><span style="flex:1"><b style="color:var(--fg);font-size:10.5px">${escHtml(a.email||a.name||'')}</b>${a.isDefault?' <span class="badge">DEFAULT</span>':''}</span><span class="dim">${escHtml(a.kind||a.type||'imap/smtp')}</span></div>`).join(''):'<div class="qempty" style="padding:12px">No accounts connected.</div>')+
        '<div class="sethead" style="margin-top:14px">AGENT AUTONOMY</div>'+
        '<div class="setline" style="display:block;padding:8px 12px"><div class="dim" style="font-size:10px;margin-bottom:8px">How much can an AI agent do with your email? Factory default is <b style="color:var(--fg)">Direct</b>.</div>'+
        '<div class="emaut" style="display:flex;flex-direction:column;gap:6px">'+AUT.map(a=>`<button class="emautb" data-a="${a[0]}" style="all:unset;cursor:pointer;display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border-radius:9px;border:1px solid ${a[0]===cur?'var(--accent)':'var(--line)'};background:${a[0]===cur?'color-mix(in srgb,var(--accent) 12%,transparent)':'transparent'}"><span style="width:13px;height:13px;flex:none;margin-top:1px;border-radius:50%;border:2px solid ${a[0]===cur?'var(--accent)':'var(--ink-faint)'};background:${a[0]===cur?'var(--accent)':'transparent'}"></span><span><b style="font-size:11px;color:var(--fg)">${a[1]}</b><div class="dim" style="font-size:10px;margin-top:1px">${a[2]}</div></span></button>`).join('')+'</div></div>'+
        '<div class="btnrow" style="margin-top:12px"><button class="btn" id="sem">OPEN EMAIL</button></div>';
      pane.querySelectorAll('.emautb').forEach(b=>b.addEventListener('click',()=>{const s=Store.get();s.email=Object.assign({},s.email,{autonomy:b.dataset.a});Store.save();Toast.show('Email autonomy: '+b.dataset.a);secEmail()}));
      pane.querySelector('#sem').addEventListener('click',()=>{Caps.set('email',1);openPanel('email')});
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
        ['calendar','Calendar','CalDAV · events','#i-calendar'],
        ['compare','Compare','same prompt across N models','#i-compare'],
        ['cookbook','Cookbook','prompt recipes','#i-cookbook'],
        ['research','Browser','browse the web inside CLONE FRAME','#i-globe'],
        ['gallery','Gallery','generate · import images','#i-gallery'],
        ['library','Library','documents · knowledge','#i-library'],
        ['notes','Notes','markdown · search','#i-notes'],
        ['tasks','Tasks','cron · the agent works on its own','#i-tasks'],
        ['__theme','Theme','restyle the interface — pick or create a theme','#i-pal'],
      ];
      const CAP=Store.get().caps;
      const capRow=(k,label,sub)=>`<div class="autotoggle"><div><b>${label}</b><div class="sub">${sub}</div></div><div class="sw3 ${CAP[k]?'on':''}" data-cap="${k}"><i></i></div></div>`;
      pane.innerHTML='<div class="sethead">TOOLS</div>'+TOOLS.map(t=>`<div class="setline"><svg style="width:13px;height:13px;color:var(--accent);flex:none"><use href="${t[3]}"/></svg><span style="flex:1;margin-left:4px"><b style="font-size:10.5px;color:var(--fg)">${t[1]}</b> <span class="dim" style="font-size:10px">${t[2]}</span></span><button class="btn mini" data-open="${t[0]}">OPEN</button></div>`).join('')
        +'<div class="sethead">CAPABILITIES — enable only what you use</div>'
        +capRow('machine','My Machine','real shell + BYOK brain')
        +capRow('agents','My Agents','connect the real iCLONE / VEGETA')
        +capRow('email','Email','connect, write and send email')
        +capRow('automations','Automations','the agent proposes actions (with approval)')
        +'<div style="font-size:10px;color:var(--ink-faint);margin:2px 0 4px">CODE · Harness · LAB are always available. Nothing starts on its own — every action passes Safety + your approval.</div>';
      pane.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{const t=b.dataset.open;openPanel(t==='__theme'?'theme':t)}));
      pane.querySelectorAll('[data-cap]').forEach(sw=>sw.addEventListener('click',()=>{const k=sw.dataset.cap,v=!Caps.on(k);Caps.set(k,v);sw.classList.toggle('on',v);Toast.show((v?'Enabled: ':'Disabled: ')+k)}));
    }
    async function secAgentTools(){
      loading();
      let perms={},tools=[];
      try{perms=await RPC('permissions','get')}catch(e){return fail(e)}
      try{tools=await RPC('admin','tools')}catch(_){}
      const mc=!!perms.machineControl;
      const rows=[['fullAccess','Full app access','the LLM can open any tab and act inside the HUB'],['rootMode','Root mode (sudo)','allows sudo commands in the terminal (asks your password each time)'],['autoAutomations','Automations without approval','the agent runs services/automations on its own'],['fileWrite','Write files','the agent can create and edit files on your machine'],['webAccess','Browse the web','the agent can search and open pages'],['autoEmail','Send email without approval','the agent sends email automatically'],['ssh','Remote servers (SSH)','open SSH sessions to your own saved servers/VMs — kept separate from full machine control (remote reach ≠ local)'],['matrix','MATRIX engine control','start and stop the local cluster engine from the MATRIX tab — its own gate, a resident daemon is a deliberate choice']];
      pane.innerHTML='<div class="sethead">FULL MACHINE CONTROL</div>'+
        `<div class="autotoggle" style="border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:color-mix(in srgb,var(--accent) 7%,transparent)"><div><b style="color:var(--accent)">Full machine control</b><div class="sub">Let your agent do ANYTHING on this computer — open any app or folder, run any command, automate the machine. One prompt in CODE is enough. This is your whole workstation, fully driveable by the AI.</div></div><div class="sw3 ${mc?'on':''}" data-perm="machineControl"><i></i></div></div>`+
        `<div class="secnote" style="${mc?'':'display:none'}" id="mcnote">✓ Full machine control is ON — the agent can open apps, folders and run anything you ask. The catastrophic-command guard (rm -rf /, mkfs, dd to disk) stays active even now, to protect you from mistakes.</div>`+
        '<div class="sethead">GRANULAR POWERS'+(mc?' <span style="color:var(--accent);font-weight:400">· all covered by Full machine control</span>':'')+'</div><div style="font-size:10px;color:var(--ink-faint);line-height:1.5;margin-bottom:8px">Everything is <b>OFF</b> by default. Enable only what you want — or flip the master switch above.</div>'+
        rows.map(r=>{const own=r[0]==='autoEmail'||r[0]==='ssh'||r[0]==='matrix';return `<div class="autotoggle" style="${mc&&!own?'opacity:.55':''}"><div><b>${r[1]}</b><div class="sub">${r[2]}</div></div><div class="sw3 ${(perms[r[0]]||(mc&&!own))?'on':''}" data-perm="${r[0]}"><i></i></div></div>`}).join('')+
        '<div class="secnote">Root mode asks for your password at the moment (never stored). Catastrophic patterns (rm -rf /, mkfs, dd to disk) are ALWAYS blocked, even as root.</div>'+
        '<div class="sethead">AGENT TOOLS — what the agent may use</div>'+(tools.length?tools.map(t=>`<div class="autotoggle"><div><b>${escHtml(t.name)}</b><div class="sub">${escHtml(t.kind||'')} ${escHtml((t.scopes||[]).join(' '))}</div></div><div class="sw3 ${t.enabled?'on':''}" data-tool="${t.id}"><i></i></div></div>`).join(''):'<div style="font-size:10px;color:var(--ink-faint)">No tools.</div>');
      pane.querySelectorAll('[data-perm]').forEach(sw=>sw.addEventListener('click',async()=>{const k=sw.dataset.perm,on=!sw.classList.contains('on');try{await RPC('permissions','set',{[k]:on});if(k==='machineControl'){Toast.show(on?'Full machine control ON — the agent can do anything you ask':'Full machine control off');secAgentTools()}else{sw.classList.toggle('on',on);Toast.show((on?'Enabled: ':'Disabled: ')+k)}}catch(e){Toast.show(e.message)}}));
      pane.querySelectorAll('[data-tool]').forEach(sw=>sw.addEventListener('click',async()=>{const on=!sw.classList.contains('on');await RPC('admin','setToolEnabled',sw.dataset.tool,on);sw.classList.toggle('on',on)}));
    }
    async function secUsers(){
      loading();
      let users=[];try{users=await RPC('admin','users')}catch(e){return fail(e)}
      pane.innerHTML='<div class="sethead">USERS</div>'+(users.length?users.map(u=>`<div class="setline"><span style="flex:1">${escHtml(u.name||'(local)')}</span><span class="dim">${escHtml(u.role||'owner')}</span></div>`).join(''):'<div class="setline"><span style="flex:1">Local profile</span><span class="dim">owner</span></div>')+
        '<div style="font-size:10px;color:var(--ink-faint);margin-top:8px;line-height:1.5">This HUB is local-first: one owner on this machine. Multi-user comes with the OG PASS gate.</div>';
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
        +'<div style="font-size:10.5px;color:var(--ink-faint);line-height:1.6">CLONE FRAME HUB · v0.4 EXTRACTION<br>Own Your AI — Terminal · Harness · LAB. iNFT on Base 8453. BYOK: your key, your model. Integrates Fabric (MIT), AgentView patterns (MIT); behavior inspired by Odysseus, rebuilt clean-room. iT terminal: built on ideas from cmux · tmux · exo, cmux-compatible, clean-room.</div>';
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
        row.querySelector('.fld-rev').addEventListener('click',async e=>{e.stopPropagation();const rr=await RPC('folders','revealPath',it.rel);if(rr&&rr.ok&&Bridge.on())Bridge.shell('open '+JSON.stringify(rr.abs),()=>{})});
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
      pane.querySelector('#foreveal').addEventListener('click',()=>{if(Bridge.on())Bridge.shell('open '+JSON.stringify(s.root),()=>{});Toast.show('Opening '+s.root)});
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
