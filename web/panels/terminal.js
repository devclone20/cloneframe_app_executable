  function wireTerminal(p){
    /* ---------- CODE — Claude Code-style workspace: sessions rail · NL chat · side panes ---------- */
    const $=sel=>p.querySelector(sel);

    /* ----- sessions (persisted) ----- */
    const KEY='cfhub.code.v1';
    const stCell=persisted(KEY,null); let st=stCell.get(); // kernel persisted (T-046)
    if(!st||!Array.isArray(st.sessions))st={sessions:[],active:null};
    const saveSt=()=>stCell.set(st);
    // A gate that outlived its agent run is not a decision the owner can still make. The run
    // died with the window or the reload, and the tool was never executed — but the card came
    // back with live APPROVE/REJECT buttons wired to an empty pendingGates map. Buttons that
    // did nothing, on a request that no longer existed, in the one place in the app that is
    // supposed to be real governance. Retire them on load and say what happened; nothing is
    // ever silently approved.
    (()=>{let n=0;
      for(const s of (st.sessions||[]))for(const m of (s.msgs||[]))if(m&&m.role==='gate'&&!m.resolved){m.resolved='expired';n++}
      if(n)saveSt();
    })();
    const active=()=>st.sessions.find(x=>x.id===st.active)||null;
    function newSession(){
      // default to pi (the app's first-class agent) when installed; otherwise the first
      // AVAILABLE provider model — a new session must answer at the first order (audit
      // BUG-L9-005: born on a dead default); '' (machine brain) stays as manual fallback
      const avail=(typeof models!=='undefined'&&(models.find(m=>m.v==='pi')||models.find(m=>m.v&&m.on!==false)))||null;
      const x={id:'s'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),title:'New session',ts:Date.now(),model:avail?avail.v:'',harness:hDefault,msgs:[]};
      stashDraft();st.sessions.unshift(x);st.active=x.id;saveSt();return x;
    }

    /* ----- layout (resizable panes + collapsible rail, Claude-Code style) — persisted apart from sessions ----- */
    const LK='cfhub.code.layout.v1';
    const layCell=persisted(LK,null); let lay=Object.assign({sideW:158,paneFrac:0.46,railOpen:true},layCell.get()||{}); // kernel persisted (T-046)
    const saveLay=()=>layCell.set(lay);
    function applyLayout(){
      const side=$('#cdside'),pn=$('#cdpane');
      if(side)side.style.width=lay.sideW+'px';
      if(pn)pn.style.width=(lay.paneFrac*100).toFixed(2)+'%';
    }
    function applyRail(){
      const wrap=p.querySelector('.cdwrap'),tog=$('#cdrailtog');
      wrap.classList.toggle('rail-collapsed',!lay.railOpen);
      if(tog){tog.textContent=lay.railOpen?'«':'»';tog.title=lay.railOpen?'Collapse sessions':'Expand sessions';}
    }
    function initSplitter(handle,onMove){
      if(!handle)return;
      handle.addEventListener('pointerdown',e=>{
        e.preventDefault();e.stopPropagation();          // never trigger the window-drag / .rz handlers
        const wrap=p.querySelector('.cdwrap');
        handle.classList.add('drag');wrap.classList.add('dragging');
        const mv=ev=>onMove(ev);
        const up=()=>{handle.classList.remove('drag');wrap.classList.remove('dragging');
          removeEventListener('pointermove',mv);removeEventListener('pointerup',up);saveLay();};
        addEventListener('pointermove',mv);addEventListener('pointerup',up);
      });
    }

    /* ----- shell engine (real zsh via HUB Bridge · Oh-My-Zsh themes · sudo) — side pane ----- */
    const zselW=()=>$('#zsel');
    let theme=localStorage.getItem('cfhub.zsh')||'agnoster',host='clone-frame',cwd='~',branch='main',ssh=false;
    let cwdAbs='';   // raw ABSOLUTE cwd (marks.cwd) — the project tree roots on this; `cwd` above is display-only
    const hist=[];let hi=-1;
    let busy=false,curId=null,curCtl=null,bridgeHome='',sudoPending=null,scroll='',cmdN=0;
    const termSid='code-'+Math.random().toString(36).slice(2,8); // stable per-terminal cwd session (bridge /shell sid) — curId stays per-command for interrupt
    function relCwd(pth){
      if(!pth)return cwd;
      if(!bridgeHome){const m=pth.match(/^(\/(?:Users|home)\/[^/]+)/);bridgeHome=m?m[1]:''}
      let r=(bridgeHome&&pth.startsWith(bridgeHome))?('~'+pth.slice(bridgeHome.length)):pth;r=r||'/';
      const segs=r.split('/').filter(Boolean);
      return (r.length>26&&segs.length>2)?('…/'+segs.slice(-2).join('/')):r;
    }
    async function refreshBranch(){try{let b='';await Bridge.shell('git rev-parse --abbrev-ref HEAD 2>/dev/null||true',t=>{b+=t},null,null,{sid:termSid});b=b.trim();branch=(b&&b!=='HEAD')?b:''}catch(e){}}
    function promptHTML(){
      // cwd and branch come from the MACHINE, not from us: a directory named
      // `<img src=x onerror=…>` or a branch of that shape in a cloned repo used to be
      // interpolated raw into innerHTML and execute inside the app.
      const cw=escHtml(cwd),br=escHtml(branch),hs=escHtml(ssh?'my-server':host);
      const gitseg=branch?`<span class="pl s3"> ⎇ ${br}</span>`:'';
      if(theme==='robby')return `<div class="tprompt robby"><span class="pl s1">➜</span><span class="pl s2">${hs} ${cw}</span>${branch?`<span class="pl s3">git:(${br})</span>`:''}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
      if(theme==='powerlevel')return `<div class="tprompt"><span class="pl s1"> ${hs} </span><span class="pl s2"> ${cw} </span>${gitseg}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
      return `<div class="tprompt"><span class="pl s1"> ${ssh?'ssh':'AR'} </span><span class="pl s2"> ${hs} </span><span class="pl s3"> ${cw} </span>${gitseg}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
    }
    function renderShell(){
      if(pane!=='term')return;
      const pb=$('#cdpanebody');
      const prompt=sudoPending
        ?'<div class="tprompt sudo"><span class="pl s1"> 🔒 </span><span class="pl s2"> root password </span><input type="password" autocomplete="off" spellcheck="false" id="tin"></div>'
        :promptHTML();
      pb.innerHTML=`<div class="tsh" id="tsh">${scroll}</div>${prompt}`;
      const inp=pb.querySelector('#tin');
      inp.focus();
      inp.addEventListener('keydown',sudoPending?onSudoKey:onKey);
      pb.scrollTop=pb.scrollHeight;
    }
    function onSudoKey(e){
      if(e.key==='Enter'){e.preventDefault();const pw=e.target.value,cmd=sudoPending.cmd;sudoPending=null;runReal(cmd,pw);return}
      if(e.key==='Escape'||((e.key==='c'||e.key==='C')&&e.ctrlKey)){e.preventDefault();sudoPending=null;out('<span class="dim">^C — sudo cancelled</span>');renderShell()}
    }
    function out(html){scroll+=html+'\n'}
    function line(cmd){
      const t=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      cmdN++;
      scroll+='<div class="cmdsep"><span>'+cmdN+' · '+t+'</span></div>';
      scroll+='<span class="cmdmark">❯</span> <span class="cmdtext">'+escHtml(cmd)+'</span>\n';
    }
    const NEO=`<span class="kw">      ▒▓█ clone frame █▓▒</span>
<span class="dim">  ────────────────────────</span>
  OS      CLONE FRAME OS · v0.5
  Shell   zsh + Oh-My-Zsh (${theme})
  Agent   iCLONE #55101 · VEGETA #58099
  Chain   Base 8453 · iNFT ERC-721A/2981/6551
  Brain   ${'${brainkind}'}`;
    async function runReal(c,sudoPass){
      busy=true;curId='r'+Math.random().toString(36).slice(2,8);
      if(!sudoPass)line(c); // if this is a re-run after the password prompt, the command was already echoed
      const open='<span class="realout" data-r="'+curId+'">';
      scroll+=open+'</span>';renderShell();
      let acc='';const paint=()=>{const n=$('#cdpanebody').querySelector('[data-r="'+curId+'"]');if(n){n.innerHTML=escHtml(acc);$('#cdpanebody').scrollTop=$('#cdpanebody').scrollHeight}};
      curCtl=new AbortController();let marks={};
      try{marks=(await Bridge.shell(c,txt=>{acc+=txt;paint()},curCtl.signal,curId,sudoPass?{sudoPass,sid:termSid}:{sid:termSid}))||{}}
      catch(e){acc+=(acc?'\n':'')+(e.name==='AbortError'?'^C':('⚠ '+e.message))}
      const prev=cwd,prevAbs=cwdAbs;
      if(marks.needSudo&&!sudoPass){ // the bridge asked for the root password
        scroll=scroll.replace(open+'</span>','');
        busy=false;curId=null;curCtl=null;sudoPending={cmd:c};renderShell();return;
      }
      if(marks.err)acc+=(acc?'\n':'')+'⚠ '+marks.err;
      scroll=scroll.replace(open+'</span>',open+escHtml(acc)+'</span>');
      if(marks.clear)scroll='';
      if(marks.cwd){cwd=relCwd(marks.cwd);cwdAbs=marks.cwd;}
      busy=false;curId=null;curCtl=null;renderShell();
      if(marks.cwd&&cwdAbs!==prevAbs){refreshBranch().then(()=>{if(!busy)renderShell()});Tree.onCwd();}
    }
    async function run(cmd){
      const c=cmd.trim();if(!c){renderShell();return}
      if(busy)return;
      hist.unshift(c);hi=-1;
      const [name,...args]=c.split(/\s+/);
      if(name==='clear'){scroll='';renderShell();return}
      if(name==='theme'){line(c);const t=args[0];if(['agnoster','robby','powerlevel'].includes(t)){theme=t;if(zselW())zselW().value=t;localStorage.setItem('cfhub.zsh',t);out('<span class="ok">zsh theme: '+t+'</span>')}else out('<span class="warn">themes: agnoster · robby · powerlevel</span>');renderShell();return}
      if(Bridge.on()){
        if(name==='help'){line(c);out('<span class="sys">REAL shell on your machine via HUB Bridge.</span> type any zsh command — <span class="kw">ls</span> · <span class="kw">git status</span> · <span class="kw">npm run</span> · <span class="dim">clear clears · Ctrl+C interrupts</span>');renderShell();return}
        if(name==='neofetch'){line(c);out(NEO.replace('${brainkind}',Brain.label()));renderShell();return}
        // sudo goes straight to the bridge — the server refuses unless Root mode is ON in Settings (never auto-enabled)
        if(/^sudo\b/.test(c)){await runReal(c);return}
        await runReal(c);return;
      }
      line(c);
      if(name==='help'){out('<span class="sys">commands:</span> ls · pwd · cd · git status · ssh &lt;host&gt; · agents · harness · soul · neofetch · theme &lt;name&gt; · clear\n<span class="dim">the real shell runs through the local HUB Bridge (BYOK) — never stores secrets on the site.</span>');renderShell();return}
      if(name==='ls'){out('<span class="path">neural_soul.md</span>  <span class="path">monorepo/</span>  <span class="path">skills/</span>  manifest.yml  bundle.lock.json');renderShell();return}
      if(name==='pwd'){out('/agents/'+(ssh?'iclone':'me')+'/'+cwd.replace('~','home'));renderShell();return}
      if(name==='cd'){cwd=args[0]?(args[0]==='..'?'~':'~/'+args[0].replace(/^[~/]+/,'')):'~';renderShell();return}
      if(name==='git'&&args[0]==='status'){out('<span class="ok">On branch '+branch+'</span>\nChanges not staged:\n  <span class="warn">modified:</span>   index.html');renderShell();return}
      if(name==='ssh'){
        const h=args[0]||'';
        if(!h){out('<span class="warn">usage: ssh &lt;host&gt; — connects to your HUB Bridge (BYOK). The site never contains the droplet IP.</span>');renderShell();return}
        out('<span class="sys">connecting to '+escHtml(h)+' via HUB Bridge…</span>');renderShell();
        await new Promise(r=>setTimeout(r,600));
        const bridge=await AgentNet.bridgeProbe();
        if(bridge.on){ssh=true;host=h;branch='main';out('<span class="ok">connected — remote shell via bridge</span>')}
        else out('<span class="warn">bridge not found. Run the local HUB Bridge and set the endpoint in MY AGENTS. (demo: mock shell)</span>');
        renderShell();return;
      }
      if(name==='agents'){out('iCLONE <span class="path">#55101</span> · <span class="ok">REGISTERED</span> (ERC-8004, Base)\nVEGETA <span class="path">#58099</span> · <span class="ok">REGISTERED</span>');renderShell();return}
      if(name==='harness'){out('spine: ORCHESTRATOR + SAFETY(veto) + EVALUATOR + TREASURY + OWNER');renderShell();return}
      if(name==='soul'){out('<span class="path">neural_soul.md</span> → monorepo → Irys (mutable, on-chain pointer). Edit it in the LAB.');renderShell();return}
      if(name==='neofetch'){out(NEO.replace('${brainkind}',Brain.label()));renderShell();return}
      out('<span class="err">zsh: command not found: '+escHtml(name)+'</span> <span class="dim">— \'help\'</span>');renderShell();
    }
    function onKey(e){
      if((e.key==='c'||e.key==='C')&&e.ctrlKey&&busy){e.preventDefault();if(curCtl)curCtl.abort();if(curId)Bridge.interrupt(curId);return}
      if(busy&&e.key==='Enter'){e.preventDefault();return}
      if(e.key==='Enter'){e.preventDefault();run(e.target.value);return}
      if(e.key==='ArrowUp'){e.preventDefault();hi=Math.min(hi+1,hist.length-1);if(hist[hi])e.target.value=hist[hi];return}
      if(e.key==='ArrowDown'){e.preventDefault();hi=Math.max(hi-1,-1);e.target.value=hi<0?'':hist[hi];return}
      if(e.key==='l'&&e.ctrlKey){e.preventDefault();scroll='';renderShell()}
    }

    /* ----- PROJECT pane: live folder-tree of the real project (rooted at the shell's cwd / git top),
             lazy children via files.list, git overlay + git-diff on click. Follows `cd`. ----- */
    const Tree=(()=>{
      const IC_FOLDER='<svg class="ic" viewBox="0 0 16 16" fill="none"><path d="M1.6 4.3a1 1 0 0 1 1-1H6l1.3 1.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.1"/></svg>';
      const IC_OPEN='<svg class="ic" viewBox="0 0 16 16" fill="none"><path d="M1.6 5.4h11.1l-1.2 6.1a1 1 0 0 1-1 .8H2.6a1 1 0 0 1-1-1zm0 0V4a1 1 0 0 1 1-1H6l1.3 1.3H13a1 1 0 0 1 1 1v.7" stroke="currentColor" stroke-width="1.1"/></svg>';
      const IC_FILE='<svg class="ic fic" viewBox="0 0 16 16" fill="none"><path d="M4 1.6h5l3 3V14a.5.5 0 0 1-.5.5H4.5A.5.5 0 0 1 4 14zM9 1.6V4a.5.5 0 0 0 .5.5H12" stroke="currentColor" stroke-width="1.1"/></svg>';
      const q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'"; // POSIX single-quote for git args (paths w/ spaces safe)
      // {sid:termSid} — without it every git command ran in the bridge's AMBIENT cwd session,
      // so the PROJECT pane could root itself on a different directory than the terminal.
      const shell=cmd=>new Promise(res=>{let o='';Bridge.shell(cmd,t=>{o+=t},null,null,{sid:termSid}).then(()=>res(o)).catch(()=>res(o))});

      let root='',repoTop='',isRepo=false,rootedFor='__none__',busyT=false;
      const open=new Set();                 // absolute dir paths currently expanded
      const kids=new Map();                  // absolute dir -> [{name,type,path}]  (files.list cache)
      const git=new Map();                   // absolute file -> {code:'M'|'A'|'D'|'?', add, del}
      const gitDirs=new Set();               // absolute dir paths that contain a change
      let sel='',view='',detail=null;        // view: '' list | 'file' | 'diff'

      async function loadDir(abs){
        if(kids.has(abs))return;
        let r;try{r=await RPC('files','list',abs)}catch(e){r=null}
        const ents=(r&&r.ok&&r.entries)||[];
        kids.set(abs,ents
          .filter(e=>e.name!=='.git'&&e.name!=='.DS_Store')
          .map(e=>({name:e.name,type:e.type==='dir'?'dir':'file',path:abs.replace(/\/$/,'')+'/'+e.name}))
          .sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):(a.type==='dir'?-1:1)));
      }

      async function loadGit(){
        git.clear();gitDirs.clear();isRepo=false;repoTop='';
        if(!Bridge.on())return;
        repoTop=(await shell('git rev-parse --show-toplevel 2>/dev/null||true')).trim().split('\n').pop().trim();
        if(!repoTop)return;
        isRepo=true;
        const stat=await shell('git -c core.quotepath=false status --porcelain 2>/dev/null');
        const num=await shell('git -c core.quotepath=false diff --numstat HEAD 2>/dev/null');
        const nmap=new Map();
        num.split('\n').forEach(l=>{const m=l.match(/^(\S+)\t(\S+)\t(.+)$/);if(m)nmap.set(m[3],{add:m[1]==='-'?0:+m[1],del:m[2]==='-'?0:+m[2]})});
        stat.split('\n').forEach(l=>{
          if(!l.trim())return;
          const code=l.slice(0,2),rest=l.slice(3);
          const rel=(rest.includes(' -> ')?rest.split(' -> ')[1]:rest).replace(/^"|"$/g,'');
          const abs=repoTop.replace(/\/$/,'')+'/'+rel;
          const n=nmap.get(rel)||{add:0,del:0};
          const c=code.includes('?')?'?':code.includes('D')?'D':code.includes('A')?'A':'M';
          git.set(abs,{code:c,add:n.add,del:n.del});
          let d=abs.slice(0,abs.lastIndexOf('/'));
          while(d.length>=repoTop.length){gitDirs.add(d);if(d===repoTop)break;const i=d.lastIndexOf('/');if(i<0)break;d=d.slice(0,i);}
        });
      }

      async function reroot(){
        if(busyT)return;busyT=true;
        rootedFor=cwdAbs;view='';sel='';detail=null;open.clear();kids.clear();
        try{
          await loadGit();
          root=isRepo?repoTop:(cwdAbs||(Bridge.info()&&Bridge.info().cwd)||'');
          if(root){open.add(root);await loadDir(root);}
        }finally{busyT=false}
        if(pane==='diff')paint();
      }

      const badge=g=>!g?'':`<span class="tgit"><span class="tg-dot ${g.code==='?'?'new':g.code==='D'?'del':'mod'}"></span>${g.add>0?`<span class="tg-a">+${g.add}</span>`:''}${g.del>0?`<span class="tg-d">−${g.del}</span>`:''}</span>`;
      function rowHTML(k,depth){
        const isDir=k.type==='dir',isOpen=open.has(k.path),g=git.get(k.path);
        const chev=isDir?`<span class="tchev ${isOpen?'on':''}">▸</span>`:'<span class="tchev sp"></span>';
        const icon=isDir?(isOpen?IC_OPEN:IC_FOLDER):IC_FILE;
        const mark=isDir?(gitDirs.has(k.path)?'<span class="tgit"><span class="tg-dot mod"></span></span>':''):badge(g);
        const gc=g?' g-'+(g.code==='?'?'new':g.code==='D'?'del':'mod'):'';
        return `<div class="trow${k.path===sel?' sel':''}${gc}" data-p="${escAttr(k.path)}" data-d="${isDir?1:0}" style="padding-left:${8+depth*13}px">${chev}${icon}<span class="tname">${escAttr(k.name)}</span>${mark}</div>`;
      }
      function flatten(dir,depth){
        const out=[];
        for(const k of (kids.get(dir)||[])){
          out.push(rowHTML(k,depth));
          if(k.type==='dir'&&open.has(k.path))out.push(...flatten(k.path,depth+1));
        }
        return out;
      }

      function unified(text){
        if(!text||!text.trim())return '<div class="tree-empty">No changes vs HEAD.</div>';
        let out='<div class="diff">';
        for(const ln of text.split('\n')){
          if(/^(diff --git|index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary )/.test(ln))continue;
          if(ln.startsWith('@@')){out+=`<div class="dl hunk"><span class="ln"></span><span class="cd">${escHtml(ln)}</span></div>`;continue}
          const cls=ln[0]==='+'?'add':ln[0]==='-'?'del':'';
          out+=`<div class="dl ${cls}"><span class="ln"></span><span class="cd">${escHtml(ln)}</span></div>`;
        }
        return out+'</div>';
      }
      const numbered=text=>'<div class="diff filebody">'+(text||'').split('\n').map((l,i)=>`<div class="dl"><span class="ln">${i+1}</span><span class="cd">${escHtml(l)}</span></div>`).join('')+'</div>';

      function paintList(){
        const pb=$('#cdpanebody');
        const name=root.split('/').filter(Boolean).pop()||root||'project';
        const nch=git.size;
        pb.innerHTML=`<div class="treewrap"><div class="treehead">${IC_FOLDER}<b>${escHtml(name)}</b>`+
          (isRepo&&branch?`<span class="tbranch">⎇ ${escHtml(branch)}</span>`:'')+
          (nch?`<span class="tchg">${nch} changed</span>`:'')+
          `<button class="treeref" id="treeref" title="Refresh">↻</button></div>`+
          `<div class="treelist" id="treelist">${flatten(root,0).join('')||'<div class="tree-empty">Empty folder.</div>'}</div></div>`;
        const list=$('#treelist');
        list.addEventListener('click',e=>{const r=e.target.closest('.trow');if(!r)return;r.dataset.d==='1'?toggle(r.dataset.p):openFile(r.dataset.p)});
        $('#treeref').addEventListener('click',()=>{rootedFor='__none__';renderDiff()});
      }
      function paintDetail(){
        const pb=$('#cdpanebody');const name=sel.split('/').pop();const g=git.get(sel);const d=detail||{};
        const body=d.kind==='diff'?unified(d.text):d.kind==='file'?numbered(d.text):`<div class="tree-empty">${escHtml(d.text||'…')}</div>`;
        pb.innerHTML=`<div class="treewrap"><div class="treehead"><button class="treeback" id="treeback" title="Back">‹</button><b>${escHtml(name)}</b>${g?badge(g):''}</div><div class="detailbody">${body}</div></div>`;
        $('#treeback').addEventListener('click',()=>{view='';detail=null;paint()});
      }
      function paint(){view?paintDetail():paintList()}

      async function toggle(abs){
        if(open.has(abs))open.delete(abs);
        else{open.add(abs);if(!kids.has(abs))await loadDir(abs)}
        paint();
      }
      async function openFile(abs){
        sel=abs;const g=git.get(abs);
        view=(g&&g.code!=='?')?'diff':'file';detail={kind:'loading',text:'Loading…'};paint();
        if(view==='diff'){
          const t=await shell('git -c core.quotepath=false diff HEAD -- '+q(abs)+' 2>/dev/null');
          detail={kind:'diff',text:t};
        }else{
          let r;try{r=await RPC('files','read',abs,{maxKB:256})}catch(e){r={ok:false,error:String(e&&e.message||e)}}
          detail=r&&r.ok?{kind:'file',text:r.text}:{kind:'err',text:r&&r.error||'cannot read'};
        }
        if(pane==='diff')paint();
      }

      // pane entry point (name kept so syncPane/openPane('diff') stay wired)
      function render(){
        const pb=$('#cdpanebody');
        if(!Bridge.on()){pb.innerHTML='<div class="treewrap"><div class="tree-empty">Connect the HUB Bridge in <b>MY MACHINE</b> to browse the live project files and diffs.</div></div>';return}
        if(rootedFor!==cwdAbs||!root){pb.innerHTML='<div class="treewrap"><div class="tree-empty">Reading project…</div></div>';reroot();return}
        paint();
      }
      return {render, onCwd(){ if(rootedFor!==cwdAbs){ if(pane==='diff')render(); else rootedFor='__none__'; } }};
    })();
    function renderDiff(){Tree.render();}

    /* The CODE-pane browser was RETIRED (2026-07-16): #cdwebbtn now opens the standalone
       BROWSER panel (one implementation, one behavior). */
    /* ----- side-pane control ----- */
    let pane=null; // 'term' | 'diff'
    function openPane(mode){pane=(pane===mode)?null:mode;syncPane()}
    function syncPane(){
      const pn=$('#cdpane');
      $('#cdtermbtn').classList.toggle('on',pane==='term');
      $('#cddiffbtn').classList.toggle('on',pane==='diff');
      const spl=$('#cdsplitpane');
      if(!pane){pn.style.display='none';if(spl)spl.style.display='none';return}
      pn.style.display='';if(spl)spl.style.display='';
      $('#cdpanetitle').textContent=pane==='term'?'TERMINAL':'PROJECT';
      $('#cdzselwrap').style.display=pane==='term'?'':'none';
      $('#cdpanebody').style.display='';
      if(pane==='term')renderShell();else renderDiff();
    }

    /* ----- models + harnesses (Settings ⇄ CODE: adding an API there surfaces its models here) ----- */
    let models=[],harnesses=[],hDefault=null,piOk=false,piProbed=false,provsLoaded=false;
    // Starts false on purpose: before the first successful list, "no crews" is not something
    // this panel knows. harnessGates() turns that into a closed gate rather than an open one.
    let harnessesLoaded=false;
    // Ask again, right now, before routing a turn on a stale answer.
    async function refreshPiOk(){
      try{const ps=await RPC('pi','status');piOk=!!(ps&&ps.installed);piProbed=true}catch(_){}
      return piOk;
    }
    async function loadModels(){
      const inf=Bridge.info&&Bridge.info();
      models=[{v:'',label:'machine'+(inf&&inf.model?' · '+inf.model:''),prov:'HUB Bridge',on:true}];
      if(Bridge.on()){
        // the raw Pi coding agent — its own agentic loop + tools (the app is its body); BYOK
        // through pi's own login, so it only appears when actually installed on this machine.
        // A FAILED probe is not an answer: it used to set piOk=false, and a session pinned to
        // pi then silently streamed from the machine brain under the label "pi".
        try{const ps=await RPC('pi','status');piOk=!!(ps&&ps.installed);piProbed=true;
          // show the LLM pi runs on (its BYOK model) right in the picker
          if(piOk)models.push({v:'pi',label:'pi',prov:(ps&&ps.model)?ps.model:'coding agent',on:true,piModel:ps&&ps.model});
        }catch(_){ if(piOk)models.push({v:'pi',label:'pi',prov:'coding agent',on:true}); }
        try{const provs=await RPC('models','listProviders');provs.forEach(pr=>{if(pr.enabled===false)return;(pr.models||[]).forEach(m=>models.push({v:pr.id+'::'+m,label:m,prov:pr.label||pr.provider,pid:pr.id,on:!(pr.disabledModels||[]).includes(m)}))});provsLoaded=true}catch(_){}
      }
      syncPickers();
    }
    async function loadHarnesses(){
      // harnessesLoaded is the difference between "there are no crews" and "I never found out".
      // Only the first is safe to treat as "no gates" — see harnessGates().
      if(Bridge.on()){try{harnesses=await RPC('harness','list');harnessesLoaded=Array.isArray(harnesses);const a=harnesses.find(h=>h.activeForTerminal);hDefault=a?{id:a.id,name:a.name}:null;const cur=active();if(cur&&!cur.harness&&hDefault){cur.harness=hDefault;saveSt()}}catch(_){harnessesLoaded=false}}
      syncPickers();
    }
    function syncPickers(){
      const cur=active();
      // A session keeps its choice as "providerId::model". When that model goes away —
      // a MATRIX weight deleted, a provider removed — the label silently fell back to
      // "machine" while the request still went to the dead id and came back as
      // "bridge http 404". Drop the selection instead of showing one thing and sending
      // another; models[0] is always the local bridge, so there is a real fallback.
      // Only when the registry actually answered — a failed probe must not wipe a choice.
      if(provsLoaded&&cur&&cur.model&&cur.model.includes('::')&&!models.some(m=>m.v===cur.model)){cur.model='';saveSt()}
      const mv=cur?cur.model||'':'';
      const mm=models.find(m=>m.v===mv)||models[0]||{label:'machine'};
      let mlbl=mm.label;
      if(mv==='pi')mlbl='pi'+(mm.piModel?' · '+String(mm.piModel).split('/').pop():''); // show pi's underlying LLM
      $('#cdmodel').textContent=mlbl+' ▾';
      $('#cdharness').textContent=((cur&&cur.harness&&cur.harness.name)||'No harness')+' ▾';
      $('#cdinft').textContent=((cur&&cur.inft&&cur.inft.name)||'No agent')+' ▾';
    }
    const closePops=()=>{p.querySelectorAll('.cdpop').forEach(x=>x.classList.remove('open'));closeOverflow();};
    function popModels(){
      closePops();
      const pop=$('#cdmodelpop'),cur=active()||newSession();
      const defV=(models[0]&&models[0].v)||'';
      const rows=q=>{
        const list=models.filter(m=>!q||m.label.toLowerCase().includes(q)||String(m.prov).toLowerCase().includes(q));
        return list.map((m,i)=>`
          <div class="cdmrow ${m.on===false?'off':''} ${cur.model===(m.v||'')?'sel':''}" data-v="${escAttr(m.v)}">
            <span class="num${(!q&&i<4)?'':' sp'}">${(!q&&i<4)?i+1:''}</span>
            <b>${escHtml(m.label)}</b>${(m.v||'')===defV?'<span class="def">· Default</span>':''}
            <span class="pv">${escHtml(m.prov||'')}</span>
            ${m.pid?`<span class="dot ${m.on?'on':''}" data-pid="${m.pid}" data-m="${escAttr(m.label)}" data-on="${m.on?1:0}" title="Enable / disable"></span>`:`<span class="dot on lock" title="${m.v==='pi'?'the app’s coding agent':'machine default'}"></span>`}
          </div>`).join('')||'<div class="qempty" style="padding:10px">No models connected — add one in Settings → Add Models.</div>';
      };
      pop.innerHTML=`<div class="cdprow"><input id="cdmq" placeholder="Search models…"><button class="btn mini" id="cdmadd" title="Add models (Settings)">＋</button></div>
        <div class="cdmhd">MODELS</div>
        <div id="cdmlist">${rows('')}</div>
        <div class="dv"></div>
        <button class="cdmmore" id="cdmmore">More models<span>→</span></button>`;
      pop.classList.add('open');
      // The pop element persists, so every open used to add ANOTHER keydown listener holding
      // that open's closures (and the session active at the time). Replace, never accumulate.
      if(pop._keys)pop.removeEventListener('keydown',pop._keys);
      const list=pop.querySelector('#cdmlist');
      function wireRows(){
        list.querySelectorAll('.cdmrow').forEach(r=>r.addEventListener('click',e=>{
          const dot=e.target.closest('.dot');
          if(dot&&dot.dataset.pid){ // per-model activation (Settings-linked)
            RPC('models','setModelEnabled',dot.dataset.pid,dot.dataset.m,dot.dataset.on!=='1').then(()=>loadModels().then(()=>{list.innerHTML=rows(pop.querySelector('#cdmq').value.trim().toLowerCase());wireRows()}));
            return;
          }
          if(r.classList.contains('off')){Toast.show('Model is disabled — click its dot to enable');return}
          cur.model=r.dataset.v||'';saveSt();syncPickers();closePops();
        }));
      }
      wireRows();
      pop.querySelector('#cdmq').addEventListener('input',e=>{list.innerHTML=rows(e.target.value.trim().toLowerCase());wireRows()});
      pop.querySelector('#cdmadd').addEventListener('click',()=>{closePops();openPanel('settings')});
      pop.querySelector('#cdmmore').addEventListener('click',()=>{closePops();openPanel('settings');setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="addmodels"]');if(b)b.click()},80)});
      // The search box takes focus as this opens, so a bare digit typed there is TEXT — it used
      // to both insert the character and click that row. ⌘1…4 stays available as the shortcut.
      pop._keys=e=>{
        const mq=pop.querySelector('#cdmq'),pick=(e.metaKey||e.ctrlKey)&&!e.altKey;
        if(!pick&&(document.activeElement===mq||e.altKey))return;
        const n=+((e.code||'').indexOf('Digit')===0?e.code.slice(5):e.key); // layout-proof
        if(n>=1&&n<=4){e.preventDefault();const r=list.querySelectorAll('.cdmrow')[n-1];if(r)r.click()}
      };
      pop.addEventListener('keydown',pop._keys);
      pop.querySelector('#cdmq').focus();
    }
    function popInft(){
      closePops();
      const pop=$('#cdinftpop'),cur=active()||newSession();
      const pinned=(Store.get().pinnedAgents||[]);
      const artmini=a=>{const anim=a.animation||'';const v=(a.mediaType==='video'||/\.(mp4|webm|mov)(\?|$)/i.test(anim))?safeMediaUrl(anim):'';const i=safeImageUrl((anim&&/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))?anim:(a.image||''));return v?`<video src="${escAttr(v)}" muted></video>`:i?`<img src="${escAttr(i)}">`:'<span></span>'};
      pop.innerHTML='<div class="cdmenu">'+
        `<button data-none="1">No agent · just your model</button>`+
        (pinned.length?pinned.map((a,i)=>`<button data-i="${i}"><span class="cdinftart">${artmini(a)}</span>${escHtml(a.name)}<span class="pv" style="margin-left:auto;font-size:10px;color:var(--ink-faint)">${escHtml(a.collection||'')}</span></button>`).join('')
          :'<div class="qempty" style="padding:9px;font-size:10px;line-height:1.5">No agents pinned yet.<br>Open <b>LAB → Agents</b>, connect your wallet, and ✓ an iNFT to use it here.</div>')+
        '</div>';
      pop.classList.add('open');
      pop.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
        cur.inft=b.dataset.none?null:pinned[+b.dataset.i];saveSt();syncPickers();closePops();
        if(cur.inft)Toast.show('Talking with '+cur.inft.name);
      }));
    }
    function popHarness(){
      closePops();
      const pop=$('#cdharnesspop'),cur=active()||newSession();
      const openEditor=(id,edit)=>{openPanel('harness');setTimeout(()=>Bus.emit('harness:open',{id,edit}),90);closePops()};
      pop.innerHTML='<div class="cdmenu">'+
        `<button data-h="">No harness</button>`+
        harnesses.map(h=>`<button data-h="${escAttr(h.id)}" data-n="${escAttr(h.name)}">${escAttr(h.name)}<span class="pv" style="margin-left:auto;font-size:10.5px;color:var(--ink-faint)">${(h.roles||[]).length} agent${(h.roles||[]).length===1?'':'s'}</span><span class="cdhedit" data-edit="${escAttr(h.id)}" title="Edit this harness' crew">✎</span></button>`).join('')+
        `<div class="dv"></div><button data-new="1" style="color:var(--accent)">＋ New harness…</button>`+
        '</div>';
      pop.classList.add('open');
      pop.querySelectorAll('button').forEach(b=>b.addEventListener('click',e=>{
        if(e.target&&e.target.dataset.edit){openEditor(e.target.dataset.edit,true);return}
        if(b.dataset.new){openEditor('__new__',true);return}
        cur.harness=b.dataset.h?{id:b.dataset.h,name:b.dataset.n}:null;saveSt();syncPickers();closePops();
      }));
    }

    /* ----- composer: attachments — auto-perceptive intake (paste / drop / picker) -----
       No dropzone UI: paste or drop anywhere on the chat column and the intake decides
       what each thing is. Images (max 5/message) ride the pi prompt as native
       ImageContent; small text files are inlined; big/binary files and whole folders
       are saved under the agent workspace (attachments/) and referenced by path so pi
       reads them with its own tools. */
    let draftFiles=[],draftImgs=[],attDir='';
    const IMG_MAX=5,FOLDER_MAX_FILES=40,FOLDER_MAX_BYTES=8*1024*1024;
    const TEXTY=f=>(/text|json|javascript|xml|csv|markdown|html|css/.test(f.type||'')||/\.(txt|md|js|mjs|ts|tsx|json|html|css|sh|py|csv|yml|yaml|toml|log)$/i.test(f.name||''));
    // Attachments live in the OWNER-VISIBLE folder tree (~/CloneFrame/Attachments) —
    // ~/.clone-frame-hub is a protected location (keys/tokens) and files.writeB64
    // rightly refuses to write there. pi reads the absolute paths with its own tools.
    async function ensureAttachDir(){
      if(attDir)return attDir;
      try{const st=await RPC('pi','status');const ws=(st&&st.workspacePath)||'';
        const home=ws.replace(/\/\.clone-frame-hub\/agent\/?$/,'');
        attDir=home?home+'/CloneFrame/Attachments':'';
      }catch(_){attDir=''}
      return attDir;
    }
    function renderChips(){
      const c=$('#cdchips');
      c.innerHTML=
        draftImgs.map((m,i)=>`<span class="chip cimg"><img src="data:${escAttr(m.mime)};base64,${m.data}" alt="">${escHtml(m.name)}<b data-img="${i}">✕</b></span>`).join('')+
        draftFiles.map((f,i)=>`<span class="chip">${escHtml(f.name)}<b data-i="${i}">✕</b></span>`).join('');
      c.style.display=(draftFiles.length||draftImgs.length)?'':'none';
      c.querySelectorAll('b[data-img]').forEach(b=>b.addEventListener('click',()=>{draftImgs.splice(+b.dataset.img,1);renderChips()}));
      c.querySelectorAll('b[data-i]').forEach(b=>b.addEventListener('click',()=>{draftFiles.splice(+b.dataset.i,1);renderChips()}));
    }
    const b64Of=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||'').split(',')[1]||'');r.onerror=rej;r.readAsDataURL(f)});
    async function saveToWorkspace(name,f){
      const dir=await ensureAttachDir();if(!dir){Toast.show('Bridge offline — could not save '+name);return null}
      const safe=String(name).replace(/\.\.+/g,'.').replace(/[^\w./-]+/g,'_');
      const path=dir+'/'+Date.now().toString(36)+'/'+safe;
      const b64=await b64Of(f);
      try{const r=await RPC('files','writeB64',path,b64,{overwrite:true});if(r&&r.ok!==false)return path}catch(_){}
      Toast.show('Could not save '+name);return null;
    }
    // ONE intake for every source: image → message context · small text → inline ·
    // anything else → saved to the workspace and referenced by path.
    async function takeFile(f,relName){
      const name=relName||f.name||'file';
      if(/^image\//.test(f.type||'')){
        if(draftImgs.length>=IMG_MAX){Toast.show('Max '+IMG_MAX+' images per message — "'+name+'" skipped');return}
        const data=await b64Of(f);if(!data)return;
        draftImgs.push({name,mime:f.type,data});renderChips();return;
      }
      if(f.size<=65536&&TEXTY(f)){let text='';try{text=await f.text()}catch(_){}
        draftFiles.push({name,text});renderChips();return}
      const path=await saveToWorkspace(name,f);
      if(path){draftFiles.push({name,text:'',path});renderChips()}
    }
    function pickFiles(dir){
      const inp=document.createElement('input');inp.type='file';inp.multiple=true;if(dir)inp.webkitdirectory=true;
      inp.onchange=async()=>{
        const fs=[...inp.files].slice(0,dir?FOLDER_MAX_FILES:12);
        if(dir&&inp.files.length>FOLDER_MAX_FILES)Toast.show('Folder attach: first '+FOLDER_MAX_FILES+' files taken ('+inp.files.length+' found)');
        let bytes=0;
        for(const f of fs){
          bytes+=f.size;
          if(dir&&bytes>FOLDER_MAX_BYTES){Toast.show('Folder attach: 8MB cap reached — remaining files skipped');break}
          await takeFile(f,f.webkitRelativePath||f.name);
        }
      };
      inp.click();
    }
    async function walkEntry(entry,prefix,acc){
      if(acc.stop)return;
      if(entry.isFile){
        await new Promise(res=>entry.file(async f=>{
          acc.n++;acc.bytes+=f.size;
          if(acc.n>FOLDER_MAX_FILES||acc.bytes>FOLDER_MAX_BYTES){
            if(!acc.stop){acc.stop=true;Toast.show('Folder attach cap reached ('+FOLDER_MAX_FILES+' files / 8MB) — rest skipped')}
            res();return;
          }
          await takeFile(f,prefix+f.name);res();
        },()=>res()));
      }else if(entry.isDirectory){
        const rd=entry.createReader();
        const ents=await new Promise(res=>rd.readEntries(res,()=>res([])));
        for(const e2 of ents){await walkEntry(e2,prefix+entry.name+'/',acc);if(acc.stop)break}
      }
    }
    function wireIntake(){
      const col=p.querySelector('.cdchatcol');if(!col)return;
      // stopPropagation: the Grid's own drop handler arms frame squares for ANY file
      // drop — attachments must never bubble into it.
      ['dragover','dragenter'].forEach(ev=>col.addEventListener(ev,e=>{
        if([...(e.dataTransfer&&e.dataTransfer.types||[])].includes('Files')){e.preventDefault();e.stopPropagation()}
      }));
      col.addEventListener('drop',async e=>{
        const dt=e.dataTransfer;if(!dt)return;
        const items=[...(dt.items||[])];
        const hasFiles=items.some(it=>it.kind==='file')||((dt.files||[]).length>0);
        if(!hasFiles)return;
        e.preventDefault();e.stopPropagation();
        const acc={n:0,bytes:0,stop:false};
        const entries=items.map(it=>it.webkitGetAsEntry&&it.webkitGetAsEntry()).filter(Boolean);
        if(entries.length){for(const en of entries){await walkEntry(en,'',acc);if(acc.stop)break}}
        else{for(const f of [...(dt.files||[])])await takeFile(f)}
      });
      $('#cdin').addEventListener('paste',async e=>{
        const items=[...(e.clipboardData&&e.clipboardData.items||[])].filter(it=>it.kind==='file');
        if(!items.length)return; // plain text pastes stay untouched
        e.preventDefault();
        for(const it of items){const f=it.getAsFile();if(f)await takeFile(f)}
      });
    }
    wireIntake();
    /* Pixel-art icon set for the + menu — 12×12 grid, currentColor rects, crispEdges.
       Each entry is a list of [x,y,w,h] pixel runs. */
    const PXI={
      files:[[1,1,10,1],[1,10,10,1],[1,2,1,8],[10,2,1,8],[7,3,2,2],[3,6,1,1],[2,7,3,1],[6,7,1,1],[2,8,7,1]],
      folder:[[1,2,4,1],[1,3,10,1],[1,4,1,5],[10,4,1,5],[1,9,10,1]],
      slash:[[2,9,2,1],[3,8,2,1],[4,7,2,1],[5,6,2,1],[6,5,2,1],[7,4,2,1],[8,3,2,1],[9,2,1,1]],
      link:[[1,4,4,1],[1,7,4,1],[1,5,1,2],[4,5,1,2],[7,4,4,1],[7,7,4,1],[7,5,1,2],[10,5,1,2],[5,5,2,2]],
      plug:[[5,1,2,1],[4,2,1,1],[7,2,1,1],[3,3,1,1],[8,3,1,1],[2,4,1,2],[9,4,1,2],[3,6,1,1],[8,6,1,1],[4,7,1,1],[7,7,1,1],[5,8,2,1],[5,4,2,2]],
      gear:[[4,2,4,1],[2,4,1,4],[9,4,1,4],[4,9,4,1],[3,3,1,1],[8,3,1,1],[3,8,1,1],[8,8,1,1],[5,0,2,2],[5,10,2,2],[0,5,2,2],[10,5,2,2],[5,5,2,2]],
      bolt:[[6,1,2,1],[5,2,2,1],[4,3,2,1],[3,4,5,1],[6,5,2,1],[5,6,2,1],[4,7,2,1],[3,8,2,1],[2,9,2,1]],
      pen:[[8,1,2,2],[7,3,2,1],[6,4,2,1],[5,5,2,1],[4,6,2,1],[3,7,2,1],[2,8,2,1],[1,9,2,2]],
      mega:[[9,1,1,9],[8,2,1,7],[3,4,5,3],[2,4,1,3],[4,7,2,3]],
      db:[[3,1,6,1],[2,2,1,8],[9,2,1,8],[3,3,6,1],[3,6,6,1],[3,10,6,1]],
      scales:[[5,1,2,1],[2,2,8,1],[2,3,1,2],[9,3,1,2],[1,5,4,1],[7,5,4,1],[5,2,2,7],[3,9,6,1]],
      chart:[[2,8,2,2],[5,6,2,4],[8,3,2,7]],
      mag:[[4,1,4,1],[3,2,1,1],[8,2,1,1],[2,3,1,3],[9,3,1,3],[3,6,1,1],[8,6,1,1],[4,7,3,1],[8,8,1,1],[9,9,2,2]],
      win:[[1,2,10,2],[1,4,1,6],[10,4,1,6],[1,9,10,1],[3,6,4,1],[3,7,2,1]],
      slid:[[2,3,8,1],[6,2,2,3],[2,8,8,1],[3,7,2,3]],
      globe:[[4,1,4,1],[3,2,1,1],[8,2,1,1],[2,3,1,4],[9,3,1,4],[3,7,1,1],[8,7,1,1],[4,8,4,1],[3,4,6,1]]
    };
    const pxi=n=>'<svg class="pxi" viewBox="0 0 12 12" aria-hidden="true">'+(PXI[n]||[]).map(r=>`<rect x="${r[0]}" y="${r[1]}" width="${r[2]||1}" height="${r[3]||1}"/>`).join('')+'</svg>';
    const PLUGIN_CATS=[['Engineering','gear'],['Productivity','bolt'],['Design','pen'],['Marketing','mega'],['Data','db'],['Legal','scales'],['Sales','chart'],['Enterprise Search','mag'],['Frontend design','win']];
    /* Playbooks — each category is a pack of real prompt starters for the agent.
       Clicking one seeds the composer; the owner adds details and sends. */
    const PLUGIN_PACKS={
      'Engineering':[
        {t:'Review this code',p:'Review the code or file I give you next like a world-class engineer — correctness, security, performance, structure. Be specific, cite lines, and be honest about severity.'},
        {t:'Write tests',p:'Write tests for the code or feature I describe next. Cover edge cases and failure modes, then run them and report the real results.'},
        {t:'Debug an error',p:'Help me debug: I will paste an error or describe a bug. Reproduce it, find the root cause with evidence, then propose the smallest correct fix.'}],
      'Productivity':[
        {t:'Plan my day',p:'Turn what I tell you next into a concrete plan: numbered steps, time estimates, and what to do first. Keep it short and actionable.'},
        {t:'Summarize this',p:'Summarize the text, file or page I give you next: 5 bullet points max, then one line with the key takeaway.'},
        {t:'Draft an email',p:'Draft an email from what I describe next. Match the tone I ask for, keep it tight, and show me the draft before anything is sent.'}],
      'Design':[
        {t:'Critique this UI',p:'Critique the screenshot or panel I show you next against Linear/Stripe/Apple-level standards: hierarchy, spacing, typography, color. List concrete fixes.'},
        {t:'Design tokens',p:'Propose a small design-token set (colors, type scale, spacing) for what I describe next, as CSS variables ready to paste.'},
        {t:'Interface copy',p:'Write interface copy for what I describe next: labels, empty states, tooltips. Short, human, no jargon.'}],
      'Marketing':[
        {t:'Landing hero',p:'Write a landing-page hero for what I describe next: headline, subline, 3 benefit bullets, call to action. No hype words.'},
        {t:'Social post ×3',p:'Write 3 variants of a short post announcing what I describe next — one factual, one bold, one playful.'},
        {t:'Launch checklist',p:'Draft a 1-week launch checklist for what I describe next: channels, assets, timing, owner per item.'}],
      'Data':[
        {t:'Query a file',p:'I will point you at a CSV/JSON file next. Load it with your tools, answer my questions about it, and show the numbers behind every answer.'},
        {t:'Chart it',p:'Take the data I give you next and produce a clear chart with your tools, plus 2 sentences on what it shows.'},
        {t:'SQL help',p:'Write the SQL for what I describe next. Explain the query in one line, warn about anything destructive, and never run writes without asking.'}],
      'Legal':[
        {t:'Plain-English review',p:'Explain the document I give you next in plain English: what I am agreeing to, red flags, and what I would push back on. You are not a lawyer — say so.'},
        {t:'Draft (marked DRAFT)',p:'Draft a first-pass document from what I describe next, clearly marked DRAFT — for a real lawyer to review.'},
        {t:'Compare versions',p:'Diff the two texts I give you next and list every meaningful change, grouped by risk.'}],
      'Sales':[
        {t:'Prospect research',p:'Research the company or person I name next with your web tools and give me: what they do, recent news, and 3 talking points.'},
        {t:'Follow-up email',p:'Write a short follow-up email from the context I give you next. One clear ask, no fluff.'},
        {t:'Objection prep',p:'List the 5 most likely objections to what I am selling (I will describe it next) and a crisp answer to each.'}],
      'Enterprise Search':[
        {t:'Find in my files',p:'Search my folders with your tools for what I describe next; show file paths and the matching lines.'},
        {t:'Research the web',p:'Research what I ask next across the web with your browser tools. Cross-check at least 2 sources and cite them.'},
        {t:'Build a brief',p:'Compile what I ask next into a one-page brief: context, key facts with sources, open questions.'}],
      'Frontend design':[
        {t:'Build a component',p:'Build the UI component I describe next as clean HTML/CSS (dark-first, design-token friendly), then show it to me before wiring it anywhere.'},
        {t:'Polish this panel',p:'Take the panel or page I name next, read it on screen, and propose 5 concrete visual improvements — then apply the ones I approve.'},
        {t:'Responsive pass',p:'Check what I show you next at phone/tablet/desktop widths and list what breaks, with fixes.'}]
    };
    function popPlus(){
      closePops();
      const pop=$('#cdpluspop');
      pop.innerHTML=`<div class="cdmenu">
        <button data-a="files">${pxi('files')}Add files or photos<span class="k">⌘U</span></button>
        <button data-a="folder">${pxi('folder')}Add folder</button>
        <button data-a="slash">${pxi('slash')}Slash commands</button>
        <div class="dv"></div>
        <button data-a="connectors">${pxi('link')}Connectors</button>
        <button class="cdsubtrig" data-sub="plugins">${pxi('plug')}Plugins<span class="arw">▸</span></button>
      </div>
      <div class="cdsub" id="cdpluginsub"></div>`;
      pop.classList.add('open');
      const sub=pop.querySelector('#cdpluginsub'),trig=pop.querySelector('.cdsubtrig');
      // Hover-intent: a 260ms linger timer + the .cdsub::before hover bridge — the
      // submenu no longer vanishes while the pointer travels from the trigger to it.
      let subT=null;
      // The "+" lives on the composer, at the bottom of the panel, so a submenu that only
      // grows DOWN runs out of window: 3 of the 9 categories were unreachable, with no
      // scrollbar and no hint (BUG-07). Lift it until it fits, then cap+scroll what's left.
      const placeSub=()=>{
        sub.style.top='0px';sub.style.maxHeight='';
        const pad=10,vh=window.innerHeight,r=sub.getBoundingClientRect();
        if(r.bottom<=vh-pad)return;
        const lift=Math.min(Math.max(0,r.top-pad),r.bottom-(vh-pad));
        if(lift>0)sub.style.top=(-lift)+'px';
        const r2=sub.getBoundingClientRect();
        if(r2.bottom>vh-pad)sub.style.maxHeight=Math.max(160,vh-pad-r2.top)+'px';
      };
      const showSub=()=>{clearTimeout(subT);if(!sub.classList.contains('open')){renderSubHome();sub.classList.add('open');placeSub()}};
      const holdSub=()=>clearTimeout(subT);
      const leaveSub=()=>{clearTimeout(subT);subT=setTimeout(()=>sub.classList.remove('open'),260)};
      trig.addEventListener('mouseenter',showSub);
      trig.addEventListener('mouseleave',leaveSub);
      sub.addEventListener('mouseenter',holdSub);
      sub.addEventListener('mouseleave',leaveSub);
      trig.addEventListener('click',e=>{e.stopPropagation();clearTimeout(subT);sub.classList.contains('open')?sub.classList.remove('open'):showSub()});
      function renderSubHome(){
        sub.innerHTML=`<div class="cdmenu"><div class="hd">PLUGINS</div>
          ${PLUGIN_CATS.map(([c,ic])=>`<button data-cat="${escAttr(c)}">${pxi(ic)}${escHtml(c)}<span class="arw">▸</span></button>`).join('')}
          <div class="dv"></div>
          <button data-mng="manage">${pxi('slid')}Manage plugins</button>
          <button data-mng="browse">${pxi('globe')}Browse pi plugins</button></div>`;
        sub.querySelectorAll('[data-cat]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();renderSubCat(b.dataset.cat)}));
        placeSub();
        sub.querySelectorAll('[data-mng]').forEach(b=>b.addEventListener('click',()=>{
          closePops();
          if(b.dataset.mng==='browse'){Bus.emit('web:open',{url:'https://pi.dev',newTab:true});return}
          openPanel('settings');setTimeout(()=>{const t=document.querySelector('#setnav [data-sec="tools"]');if(t)t.click()},80);
        }));
      }
      function renderSubCat(cat){
        const pack=PLUGIN_PACKS[cat]||[];
        sub.innerHTML=`<div class="cdmenu"><button class="cdsubback" data-back="1">‹ ${escHtml(cat.toUpperCase())}</button>
          ${pack.map((a,i)=>`<button data-pk="${i}">${escHtml(a.t)}</button>`).join('')}</div>`;
        sub.querySelector('[data-back]').addEventListener('click',e=>{e.stopPropagation();renderSubHome()});
        placeSub();
        sub.querySelectorAll('[data-pk]').forEach(b=>b.addEventListener('click',()=>{
          const a=pack[+b.dataset.pk];closePops();
          const i=$('#cdin');i.value=a.p+(i.value?'\n\n'+i.value:'\n\n');i.focus();
          if(typeof autosize==='function')autosize();
          i.setSelectionRange(i.value.length,i.value.length);
          Toast.show('Playbook ready — add your details and send');
        }));
      }
      pop.querySelectorAll('button[data-a]').forEach(b=>b.addEventListener('click',()=>{
        closePops();
        const a=b.dataset.a;
        if(a==='files')pickFiles(false);
        else if(a==='folder')pickFiles(true);
        else if(a==='slash'){const i=$('#cdin');i.value='/'+i.value.replace(/^\//,'');i.focus();i.dispatchEvent(new Event('input',{bubbles:true}))}
      }));
    }
    let micDevs=[],micHold=localStorage.getItem('cfhub.micHold')!=='0',micSel=localStorage.getItem('cfhub.mic')||'',rec=null,recOn=false;
    async function popMicMenu(){
      closePops();
      const pop=$('#cdmicpop');
      pop.innerHTML='<div class="cdmenu"><div class="hd">MICROPHONE</div><div class="qempty" style="padding:8px;font-size:10px">requesting access…</div></div>';
      pop.classList.add('open');
      try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());micDevs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput')}catch(_){micDevs=[]}
      pop.innerHTML='<div class="cdmenu"><div class="hd">MICROPHONE</div>'+
        (micDevs.length?micDevs.map(d=>`<button data-d="${escAttr(d.deviceId)}">${escAttr(d.label||'Microphone')}${(micSel?micSel===d.deviceId:d.deviceId==='default')?' <span style="margin-left:auto;color:var(--ok)">✓</span>':''}</button>`).join(''):'<div class="qempty" style="padding:8px;font-size:10px">No microphone access.</div>')+
        `<div class="dv"></div><button data-hold="1">Hold to record<span class="sw3 ${micHold?'on':''}" style="margin-left:auto;transform:scale(.8)"><i></i></span></button></div>`;
      pop.querySelectorAll('button[data-d]').forEach(b=>b.addEventListener('click',()=>{micSel=b.dataset.d;localStorage.setItem('cfhub.mic',micSel);popMicMenu()}));
      const hb=pop.querySelector('button[data-hold]');
      hb&&hb.addEventListener('click',()=>{micHold=!micHold;localStorage.setItem('cfhub.micHold',micHold?'1':'0');popMicMenu()});
    }
    function startRec(){
      if(recOn)return;
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!SR){Toast.show('Dictation is not available in this browser');return}
      rec=new SR();rec.lang=navigator.language||'en-US';rec.continuous=true;rec.interimResults=false;
      rec.onresult=e=>{let t='';for(let k=e.resultIndex;k<e.results.length;k++)if(e.results[k].isFinal)t+=e.results[k][0].transcript;if(t){const i=$('#cdin');i.value=(i.value?i.value+' ':'')+t.trim();autosize()}};
      rec.onend=()=>{recOn=false;$('#cdmic').classList.remove('rec')};
      try{rec.start();recOn=true;$('#cdmic').classList.add('rec')}catch(_){recOn=false}
    }
    function stopRec(){try{rec&&rec.stop()}catch(_){}recOn=false;$('#cdmic').classList.remove('rec')}

    /* ----- chat (natural language → the model YOU picked; harness rides along) ----- */
    // A turn belongs to a CONVERSATION, not to the panel. One shared `streaming` flag meant the
    // ■/↑ button showed the panel's state instead of the visible conversation's, and Enter was
    // silently dead in every OTHER session while one was streaming — even though the bridge
    // runs one independent agent per session and could have answered them all.
    const runs=new Map();   // sessionId → AbortController
    const runHere=()=>{const c=active();return !!(c&&runs.has(c.id))};
    function syncSend(){const b=$('#cdsend');if(b){b.textContent=runHere()?'■':'↑';b.title=runHere()?'Stop this turn':'Send'}}
    function autosize(){const i=$('#cdin');i.style.height='auto';i.style.height=Math.min(i.scrollHeight,120)+'px'}
    let renamingId=null,showArchived=false,ovfEl=null;
    function closeOverflow(){if(ovfEl){ovfEl.remove();ovfEl=null}}
    function beginRename(id){renamingId=id;renderSessions();const inp=$('#cdsess .cdren');if(inp){inp.focus();inp.select()}}
    function forkSession(sess){
      const c=JSON.parse(JSON.stringify(sess));
      c.id='s'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
      c.ts=Date.now();c.archived=false;
      c.title=sess.title.replace(/\s*\(copy\)$/,'')+' (copy)';
      // A pending gate cannot be duplicated: the copy's buttons carried the ORIGINAL gid, so
      // clicking them resolved the other conversation's gate and ran its tool there.
      (c.msgs||[]).forEach(m=>{if(m&&m.role==='gate'&&!m.resolved)m.resolved='expired'});
      c.draft='';c.draftFiles=[];c.draftImgs=[];delete c._lastEngine;
      const idx=st.sessions.indexOf(sess);st.sessions.splice(idx<0?0:idx,0,c);
      stashDraft();st.active=c.id;saveSt();renderSessions();renderChat();loadDraft();syncSend();Toast.show('Session duplicated');
    }
    function exportSession(sess){
      const lines=['# '+sess.title,'',`_${new Date(sess.ts||Date.now()).toISOString()} · model: ${sess.model||'machine'}_`,''];
      (sess.msgs||[]).forEach(m=>{
        if(m.role==='gate'){lines.push('> **HARNESS GATE** — `'+String(m.tool||'')+' '+String(m.gargs||'')+'` → '+(m.resolved||'pending'));lines.push('')}
        else if(m.role==='sys'){lines.push('> '+String(m.content||'').replace(/\n/g,'\n> '));lines.push('')}
        else{lines.push(m.role==='user'?'### You':'### Assistant');lines.push('');lines.push(String(m.content||''));lines.push('')}
      });
      const blob=new Blob([lines.join('\n')],{type:'text/markdown'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.rel='noopener';
      a.download=(sess.title.replace(/\W+/g,'_')||'session')+'.md';a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    }
    // A conversation IS its agent. Closing one ends that agent for good: the bridge kills
    // the pi process (every byte of context it held dies with it) and erases the scratch
    // that run left behind, so the next conversation always starts a NEW agent instead of
    // resuming a half-remembered one. Fire-and-forget: a closed conversation must leave
    // the screen at once, even with the bridge down (the process dies with the bridge anyway).
    const endAgent=id=>{if(id&&Bridge.on())RPC('pi','end',{id}).catch(()=>{})};
    function closeSession(id){
      const wasActive=st.active===id;
      const ctl=runs.get(id);if(ctl){runs.delete(id);try{ctl.abort()}catch(_){}} // stop its turn before its agent goes
      endAgent(id);
      st.sessions=st.sessions.filter(x=>x.id!==id);
      if(wasActive){st.active=st.sessions[0]?st.sessions[0].id:null;draftFiles=[];draftImgs=[];const i=$('#cdin');if(i)i.value=''}
      if(!st.sessions.length)newSession();
      saveSt();renderSessions();renderChat();
      // the conversation that takes over gets ITS OWN composer back, not the closed one's
      if(wasActive){loadDraft();syncSend()}
    }
    const deleteSession=closeSession;
    function openSessOverflow(sess,anchor){
      closePops();closeOverflow();
      const r=anchor.getBoundingClientRect();
      const el=document.createElement('div');el.className='cdovf';
      el.innerHTML='<div class="cdmenu">'+
        '<button data-a="rename">Rename<span class="k">R</span></button>'+
        '<button data-a="fork">Duplicate<span class="k">F</span></button>'+
        '<button data-a="files">Files</button>'+
        '<button data-a="export">Export transcript</button>'+
        '<div class="dv"></div>'+
        (sess.archived?'<button data-a="unarchive">Unarchive</button>':'<button data-a="archive">Archive<span class="k">A</span></button>')+
        '<button data-a="del" class="danger">Delete<span class="k">D</span></button>'+
      '</div>';
      p.appendChild(el);ovfEl=el;
      const w=190,h=el.offsetHeight;let left=r.right+6,top=r.top;
      if(left+w>innerWidth)left=r.left-w-6;if(left<6)left=6;
      if(top+h>innerHeight-8)top=innerHeight-h-8;if(top<8)top=8;
      el.style.left=left+'px';el.style.top=top+'px';
      el.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
        const a=b.dataset.a;closeOverflow();
        if(a==='rename')beginRename(sess.id);
        else if(a==='fork')forkSession(sess);
        else if(a==='files'){if(pane!=='diff')openPane('diff')}
        else if(a==='export')exportSession(sess);
        else if(a==='archive'){const g=runs.get(sess.id);if(g){runs.delete(sess.id);try{g.abort()}catch(_){}}endAgent(sess.id);sess.archived=true;if(st.active===sess.id){const n=st.sessions.find(x=>!x.archived);st.active=n?n.id:null;if(!st.active){newSession()}saveSt();renderSessions();renderChat();loadDraft();syncSend();return}saveSt();renderSessions();renderChat()}
        else if(a==='unarchive'){sess.archived=false;saveSt();renderSessions()}
        else if(a==='del')deleteSession(sess.id);
      }));
    }
    function sessRow(x){
      const on=x.id===st.active?'on':'';
      if(renamingId===x.id)
        return `<div class="cdsrow ${on}" data-id="${x.id}"><input class="cdren" value="${escAttr(x.title)}" maxlength="60" data-id="${x.id}"></div>`;
      return `<div class="cdsrow ${on}" data-id="${x.id}"><span>${escHtml(x.title)}</span><button class="dots" data-ov="${x.id}" title="Session options">⋮</button><button class="x" data-cl="${x.id}" title="Close conversation (ends its agent)">✕</button></div>`;
    }
    function renderSessions(){
      const live=st.sessions.filter(x=>!x.archived),arch=st.sessions.filter(x=>x.archived);
      let html=live.map(sessRow).join('');
      if(arch.length){
        html+=`<button class="cdarch" id="cdarchtog">${showArchived?'▾':'▸'} ${arch.length} archived</button>`;
        if(showArchived)html+=arch.map(sessRow).join('');
      }
      const box=$('#cdsess');box.innerHTML=html;
      const at=box.querySelector('#cdarchtog');
      if(at)at.addEventListener('click',()=>{showArchived=!showArchived;renderSessions()});
      box.querySelectorAll('.cdren').forEach(inp=>{
        const commit=()=>{const x=st.sessions.find(v=>v.id===inp.dataset.id);const t=inp.value.trim();renamingId=null;if(x&&t)x.title=t.slice(0,60);saveSt();renderSessions();renderChat()};
        inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit()}else if(e.key==='Escape'){renamingId=null;renderSessions()}});
        inp.addEventListener('blur',commit);
      });
      box.querySelectorAll('.dots').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const x=st.sessions.find(v=>v.id===b.dataset.ov);if(x)openSessOverflow(x,b)}));
      box.querySelectorAll('.x[data-cl]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();closeSession(b.dataset.cl)}));
      box.querySelectorAll('.cdsrow').forEach(r=>{
        r.addEventListener('click',e=>{if(e.target.closest('.dots')||e.target.closest('.x')||e.target.closest('.cdren'))return;switchTo(r.dataset.id)});
        r.addEventListener('dblclick',e=>{if(e.target.closest('.cdren'))return;beginRename(r.dataset.id)});
      });
    }
    // ── the composer belongs to the conversation ──────────────────────────────
    // #cdin is ONE textarea and draftFiles/draftImgs were panel-globals, so a half-typed
    // sentence — and any attached file or image — followed the owner into whatever session
    // they opened next, and the next send delivered it there.
    function stashDraft(){
      const c=active();if(!c)return;
      const inp=$('#cdin');
      c.draft=inp?inp.value:'';
      c.draftFiles=draftFiles;c.draftImgs=draftImgs;
    }
    function loadDraft(){
      const c=active();
      const inp=$('#cdin');
      draftFiles=(c&&c.draftFiles)||[];draftImgs=(c&&c.draftImgs)||[];
      if(inp){inp.value=(c&&c.draft)||'';autosize()}
      renderChips();slashList=[];renderSlash();
    }
    function switchTo(id){
      if(st.active===id)return;
      stashDraft();
      st.active=id;saveSt();
      renderSessions();renderChat();loadDraft();syncSend();
    }
    function renderChat(){
      const cur=active();
      $('#cdtitle').textContent=cur?cur.title:'New session';
      const tr=$('#cdtrans');
      // Capture the reader's position BEFORE innerHTML wipes it. A full rebuild resets
      // scrollTop to 0, so during an agent turn every tool step used to fling the view to
      // the TOP — the model's reply (below the ⚙ tool lines) never showed and the scroll
      // "never reached the end". We restore the position after building (below).
      const _sw=_lastRenderSess!==(cur&&cur.id);
      const _dist=tr?(tr.scrollHeight-tr.scrollTop-tr.clientHeight):0;
      const _pin=_pinBottom||_sw||!tr||_dist<120;
      if(!cur||!cur.msgs.length){
        tr.innerHTML=`<div class="cdwelcome"><div class="cwbrand">&lt;/&gt; CODE</div><div class="cwsub">Yours to command.</div><div class="cwtip">Talk to your model in natural language. Pick the model and the harness below — or open the real terminal ( ❯_ ), the diff ( ⧉ ) and the web browser on the right.</div></div>`;
      }else{
        tr.innerHTML=cur.msgs.map(m=>m.role==='gate'
          ?`<div class="cdgate${m.resolved?' done':''}${m.resolved==='expired'?' expired':''}"><div class="cdgate-hd">⛔ HARNESS GATE · ${escHtml((m.gates||[]).join(' · ')||'OWNER')}</div><div class="cdgate-tool">${escHtml(m.tool)} ${escHtml(m.gargs||'')}</div>${m.resolved?`<div class="cdgate-res ${m.resolved}">${m.resolved==='approved'?'✓ approved by owner':m.resolved==='expired'?'⏱ the session ended before you answered — this was never run':'✕ rejected by owner'}</div>`:`<div class="cdgate-btns"><button class="cdgate-ok" data-gateok="${escAttr(m.gid)}">APPROVE</button><button class="cdgate-no" data-gateno="${escAttr(m.gid)}">REJECT</button></div>`}</div>`
          :m.role==='sys'?`<div class="cdmsg sys">${escHtml(m.content)}</div>`:`<div class="cdmsg ${m.role==='user'?'user':'ai'}">${m.role==='user'?escHtml(m.content):MDLite.render(m.content||'…')}</div>`).join('');
      }
      // Restore: a pinned reader (or a session switch / a just-sent turn) rides the bottom
      // so the reply is always in view; a reader who scrolled up to read history keeps their
      // exact spot across the rebuild.
      _lastRenderSess=cur&&cur.id;
      if(_pin)forceBottom(tr);
      else if(tr)tr.scrollTop=Math.max(0,tr.scrollHeight-tr.clientHeight-_dist);
      _pinBottom=false;
      syncPickers();syncSend();
    }
    let _lastRenderSess=null,_pinBottom=false;
    // ── a turn paints only into its OWN conversation ──────────────────────────
    // Both stream loops used to grab "the last .cdmsg.ai in the transcript" and write into it.
    // The transcript on screen is always the ACTIVE session, so switching sessions mid-answer
    // painted session A's reply into session B's last bubble — the reply landed in the wrong
    // conversation and was saved there. Address the bubble by its message index instead, and
    // only when its session is the one being displayed.
    function paintBubble(sess,msg){
      const cur=active();
      if(!cur||cur.id!==sess.id)return;                 // reader is elsewhere: the store still gets it
      const i=sess.msgs.indexOf(msg);if(i<0)return;
      const tr=$('#cdtrans');if(!tr)return;
      const el=tr.children[i];
      if(!el||!el.classList.contains('cdmsg'))return;   // transcript out of step — next renderChat fixes it
      el.innerHTML=MDLite.render(msg.content||'…');
      stickBottom(tr,160);
    }
    /* ---- AGENT MODE in CODE: the model drives the app + machine through tools (permission-gated) ---- */
    let cmode=localStorage.getItem('cfhub.code.mode')||'chat';
    const trunc=(x,n)=>{x=String(x);return x.length>n?x.slice(0,n)+'…':x};
    // Generated from the real panel registry so the prompt lists EXACTLY the openable
    // keys (was a hand-kept list of 24 that missed matrix/agentview/folders/shell).
    const AGENT_PANELS=(typeof DEFS!=='undefined'&&DEFS)?Object.keys(DEFS).join(','):'terminal,shell,harness,lab,matrix,machine,agents,folders,email,notes,research,settings';
    function parseToolCalls(text){const out=[],re=/```tool\s*([\s\S]*?)```/g;let m;while((m=re.exec(text))){try{const o=JSON.parse(m[1].trim());if(o&&o.name)out.push({name:o.name,args:o.args||{}})}catch(_){}}
      // safety net: a tool block whose closing ``` fence never arrived (model closed the JSON but not the fence) — recover a brace-balanced object
      if(!out.length){const i=text.lastIndexOf('```tool');if(i>=0){const seg=text.slice(i+7),s=seg.indexOf('{');if(s>=0){let d=0,end=-1,inStr=false,esc=false;for(let k=s;k<seg.length;k++){const c=seg[k];if(esc){esc=false;continue}if(c==='\\'){esc=true;continue}if(c==='"'){inStr=!inStr;continue}if(inStr)continue;if(c==='{')d++;else if(c==='}'&&--d===0){end=k;break}}if(end>=0){try{const o=JSON.parse(seg.slice(s,end+1));if(o&&o.name)out.push({name:o.name,args:o.args||{}})}catch(_){}}}}}
      return out}
    // ── Context Engine v1 — the agent's eyes on the app ──────────────────────
    // Live screen serializer + panel catalog. Injected into the system prompt and
    // rebuilt on EVERY agent step, so the model always answers from the real screen
    // instead of guessing (audit BUG-L6-001/G2: "agent is blind to the screen").
    function screenPanels(){
      const out=[];
      document.querySelectorAll('#panels .panel').forEach(el=>{
        const key=el.dataset.key||el.dataset.type||'?';
        const t=el.querySelector('header b');
        out.push({key,title:t?t.textContent.trim():key,docked:el.style.display==='none'||el.dataset.docked==='1',el});
      });
      return out;
    }
    function panelCatalog(){
      if(typeof DEFS==='undefined')return '';
      return Object.entries(DEFS).map(([k,d])=>k+' — '+(d.title||k)+(d.sub?' ('+d.sub+')':'')).join('\n');
    }
    // Resolve whatever the model says ("MATRIX", "the notes panel", "my agents", "browser")
    // to a real DEFS key. open_panel used to take the raw string case-sensitively and always
    // report success — so a title/phrase opened nothing yet looked like it worked, and the
    // model kept retrying (owner: "hard to open any tab"). null = no match.
    const PANEL_ALIASES={browser:'research',agent:'terminal',it:'shell',iterm:'shell',code:'terminal','my machine':'machine','my agents':'agents'};
    function resolvePanelKey(name){
      if(typeof DEFS==='undefined')return null;
      let t=String(name||'').trim().toLowerCase().replace(/\b(the|open|please)\b/g,'').replace(/\b(panel|tab|window)\b/g,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
      if(!t)return null;
      if(DEFS[t])return t;
      if(PANEL_ALIASES[t])return PANEL_ALIASES[t];
      const keys=Object.keys(DEFS);
      const titleOf=k=>String((DEFS[k].title||'')).toLowerCase();
      let hit=keys.find(k=>titleOf(k)===t);if(hit)return hit;
      const squished=t.replace(/\s+/g,'');
      hit=keys.find(k=>titleOf(k).replace(/\s+/g,'')===squished);if(hit)return hit;
      hit=keys.find(k=>k.startsWith(t))||keys.find(k=>titleOf(k).startsWith(t));if(hit)return hit;
      hit=keys.find(k=>t.includes(k))||keys.find(k=>titleOf(k)&&t.includes(titleOf(k)));return hit||null;
    }
    function appContextText(cur){
      const ps=screenPanels();
      const top=(typeof topPanel!=='undefined'&&topPanel)?(topPanel.dataset.key||topPanel.dataset.type):null;
      const mm=models.find(m=>m.v===((cur&&cur.model)||''));
      const openLine=ps.length?ps.map(x=>x.key+(x.docked?' [docked]':'')+(x.key===top?' [focused]':'')).join(' · '):'none';
      return 'Open panels: '+openLine+'\n'
        +'This CODE session: model='+((cur&&cur.model)||'(machine brain)')+(mm?' — '+mm.label+' · '+mm.prov:'')
        +' · harness='+((cur&&cur.harness&&cur.harness.name)||'none')
        +' · agent iNFT='+((cur&&cur.inft&&cur.inft.name)||'none')+' · mode='+cmode;
    }
    // Agent-iNFT persona: when an iNFT is bound to the session, the BYOK model speaks AS it.
    // (A separate app-managed persona layer used to live here; it was retired.)
    function inftContext(){
      const cur=active();
      const a=cur&&cur.inft;
      if(a&&a.name)
        return ` You are speaking AS the owner's agent iNFT "${a.name}"${a.collection?' ('+a.collection+')':''} — token #${a.tokenId}. Embody it; hard limits: never move value without the OWNER gate; BYOK, no secrets on the client.`;
      return '';
    }
    async function buildAgentSystem(perms,cur,mode){
      const full=perms.machineControl||perms.fullAccess;
      const can=[],need=[];
      (full?can:need).push('open any macOS app, reveal files/folders in Finder, run shell commands & AppleScript — full control of this machine');
      (perms.webAccess||full?can:need).push('search & browse the web inside the app');
      (perms.fileWrite||full?can:need).push('create & edit files on disk');
      (perms.autoEmail?can:need).push('send email on the owner\'s behalf');
      (full?can:need).push('operate the owner\'s online servers/droplets (run commands, deploy, provision)');
      const capLine=' RIGHT NOW you CAN, with no toggle needed: open any HUB tab/panel and open Settings.'+(can.length?' You can also: '+can.join('; ')+'.':'');
      const needLine=need.length?(' Currently OFF (the owner must flip a toggle in Settings → Agent Tools — use open_settings{section:"agent"} to take them straight there): '+need.join('; ')+'.'):' The owner has granted you full control of the machine.';
      const modeLine=mode==='agent'
        ? ' MODE = AGENT: be proactive. Plan briefly, then chain the tools needed to FULLY complete the goal before giving your final answer.'
        : ' MODE = CHAT: answer conversationally, but the moment the owner asks you to DO something (open an app or tab, run a command, change a setting, create a file, browse, operate a server), actually DO it with your tools — never just explain how.';
      let h='';
      if(cur&&cur.harness&&cur.harness.name){const hd=harnesses.find(x=>x.id===cur.harness.id);const gg=hd&&hd.roles?hd.roles.filter(r=>r.gate).map(r=>r.name):[];h='\nActive HARNESS: '+cur.harness.name+(hd&&hd.roles?' — roles: '+hd.roles.map(r=>r.name).join(', '):'')+'.'+(gg.length?' GATES ARE REAL here: calling run_shell/applescript/write_file/send_email/server_* PAUSES this chat for the OWNER to approve or reject each call ('+gg.join(' · ')+'). Announce what you are about to run and why BEFORE calling a gated tool; if rejected, do not retry — propose an alternative.':'')}
      return `You are the model the owner connected to CLONE FRAME, running INSIDE their app with a REAL body on this machine through the HUB Bridge.${inftContext()} You are NOT a text-only assistant — you have TOOLS and you CAN act on the app, the machine, and the owner's online servers. To act, emit ONE json block per action, exactly like this:\n\`\`\`tool\n{"name":"open_app","args":{"app":"Calculator"}}\n\`\`\`\nTOOLS: open_panel{panel} (open a HUB tab — one of: ${AGENT_PANELS}); read_panel{panel} (YOUR EYES — returns the visible content of an open panel); close_panel{panel} (close an open panel); app_context{} (fresh snapshot of what is open right now); list_capabilities{} (every panel + what it does); open_settings{section} (open Settings at a section: agent · models · appearance · folders · servers · account); open_terminal{cwd?,newWindow?} (open a live terminal in the app; newWindow:true opens a SEPARATE terminal window — e.g. one per agent, side by side); open_app{app} (open ANY macOS app by name); open_path{path} (reveal ANY file/folder in Finder); open_url{url}; applescript{script} (automate macOS & control apps); run_shell{cmd} (REAL zsh — install, build, move files, anything); web_search{q}; browse{url,newTab?,newWindow?} (opens a live rendered web tab AND returns the page text; newTab:true adds a tab, newWindow:true opens a SEPARATE browser window on the canvas — use several newWindow calls to research side-by-side); read_file{path}; write_file{path,content}; send_email{to,subject,body}; server_list{}; server_run{id,cmd} (run a command on an online server/droplet over SSH); server_automation{id,key} (one-click preset: status·start_agent·stop_agent·restart_agent·agent_logs·update·reboot); server_deploy{id,name} (send an agent to the server); server_provision{name,region,size} (create a NEW droplet in the owner's DigitalOcean account); list_harnesses{}; create_harness{name,description,roles:[{name,desc,gate}]} (build a crew of agents); update_harness{id,name,description,roles}; use_harness{id} (activate a harness for this CODE session). HARNESS ENGINE pattern — a harness is a crew: one ORCHESTRATOR that delegates, the non-collapsible GATES (SAFETY/HACKER, EVALUATOR, TREASURY, OWNER — set gate:true) that nothing irreversible passes without, and the specialist agents the task needs (gate:false, e.g. RESEARCH, ANALYST, DELIVERY). When the owner asks you to create/build a harness, design that crew and call create_harness; then tell them it's in the HARNESS tab and the CODE picker.${capLine}${needLine}${modeLine} Your full field guide — every tool, panel, the iT 'it' CLI, how to edit the frame, how to contribute upstream — lives at ~/.clone-frame-hub/AGENTS.md; read_file it (or run 'it context' in an iT shell) when you need depth. Rules: emit the tools you need, then STOP and wait for the RESULTS (I send them back); only then continue or give the final answer WITHOUT tool blocks. NEVER say you can't act or that you're just a text model — you have a body here. If a tool returns REFUSED, name the exact toggle that unlocks it and offer to open_settings for the owner. Never invent results. Owner permissions (raw JSON): ${JSON.stringify(perms)}.${h}
${(cur&&Array.isArray(cur.goals)&&cur.goals.length)?'\nSESSION GOALS (the owner set these with /goals — keep them in mind and work toward them):\n'+cur.goals.map((g,i)=>(i+1)+'. '+g).join('\n')+'\n':''}${brainMemoryBlock()}

<app_context> — REFERENCE ONLY. This block describes the app you are running inside. It is NOT the topic of the conversation and NOT something the owner said. Use it ONLY when the owner asks about the app, the screen, or which panel/model/harness is active — then answer straight from here (do NOT run a shell command for that). When the owner asks about ANYTHING ELSE (a general question, code, an external subject, current events), just answer that on its own — do NOT weave in what panels are open or what this app is.
${appContextText(cur)}
Panels you can open (key — name): ${panelCatalog().replace(/\n/g,' | ')}
</app_context>

ANSWER DISCIPLINE:
- TOOL RESULTS are the ONLY source of truth about this machine and app. If a tool returns empty output or fails, say exactly that — NEVER infer or invent state from silence. "unknown tool" means it does not exist: say so, never claim it ran.
- For external facts, current events, prices, docs, or anything you are not sure of: call web_search / browse FIRST and answer from what you find — do NOT guess or invent. If you cannot verify, say so plainly.
- To open a HUB tab, call open_panel with the KEY (e.g. {"name":"open_panel","args":{"panel":"notes"}}). The panel names above map keys to titles — a title like "My Agents" opens with key "agents".`;
    }
    // Every tool that reaches the machine takes the turn's abort signal AND an interrupt id.
    // Without them ■ stopped only the model's typing: the shell command it had already asked
    // for ran to completion, and its result was still fed back into the conversation.
    let toolSeq=0;
    async function execTool(c,perms,signal){
      const a=c.args||{};
      const full=perms.machineControl||perms.fullAccess; // master switch OR full app access
      const shq=s=>"'"+String(s).replace(/'/g,"'\\''")+"'"; // POSIX single-quote: neutralizes $ ` \ $() etc. so paths/urls can't inject shell
      // A stoppable shell call: the bridge gets an id it can kill, and the fetch gets the signal.
      const sh=async(cmd,onTok)=>{
        const id='t'+(++toolSeq)+Math.random().toString(36).slice(2,6);
        try{return await Bridge.shell(cmd,onTok||(()=>{}),signal,id)}
        catch(e){if(signal&&signal.aborted)Bridge.interrupt(id);throw e}
      };
      if(signal&&signal.aborted)return 'STOPPED — the owner pressed stop before this ran.';
      try{
        if(c.name==='open_panel'){ // opening an in-app tab is harmless — never gated
          const raw=String(a.panel||'').trim();if(!raw)return 'no panel name given';
          const key=resolvePanelKey(raw);
          if(!key)return 'no panel matches "'+raw+'". Valid panels (key — name): '+Object.keys(DEFS).map(k=>k+' ('+(DEFS[k].title||k)+')').join(', ');
          const r=openPanel(key); // openPanel returns the element on success, null if unknown/under-construction
          return r?('opened HUB tab: '+key+' ('+(DEFS[key].title||key)+')'):('could not open "'+key+'" — it may be under construction');
        }
        if(c.name==='open_terminal'){const cwd=String(a.cwd||'').trim();const wasOpen=instancesOf('shell').length>0;if(cwd)pendingShellCwd=cwd;openPanel('shell',{newInstance:!!a.newWindow});if(cwd&&wasOpen&&!a.newWindow)Bus.emit('shell:addcwd',cwd);return 'opened iT — live terminal '+(a.newWindow?'window':'')+(cwd?' at '+cwd:'')}
        if(c.name==='open_settings'){const sec=String(a.section||'').trim().toLowerCase();openPanel('settings');const map={agent:'agenttools',agenttools:'agenttools',permissions:'agenttools',it:'itterm',itterm:'itterm','it terminal':'itterm',tools:'tools',models:'addmodels',addmodels:'addmodels','add models':'addmodels',added:'added',aidefaults:'aidefaults',pi:'piagent',piagent:'piagent','pi agent':'piagent',appearance:'appearance',theme:'appearance',account:'account',folders:'folders',servers:'servers','online server':'servers',system:'system',email:'email',reminders:'reminders',search:'search'};const key=map[sec]||sec||'agenttools';setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="'+key+'"]');if(b)b.click()},80);return 'opened Settings → '+key}
        if(c.name==='open_app'){if(!full)return 'REFUSED — enable "Full machine control" in Settings → Agent Tools';const app=String(a.app||'').trim();if(!app)return 'no app name';let out='';const m=await sh('open -a '+shq(app),tk=>{out+=tk});return (m&&m.exit===0)?('opened app: '+app):('could not open "'+app+'" '+trunc(out,120))}
        if(c.name==='open_path'){if(!full)return 'REFUSED — enable "Full machine control"';const pth=String(a.path||'').trim();if(!pth)return 'no path';let out='';const m=await sh('open '+shq(pth),tk=>{out+=tk});return (m&&m.exit===0)?('opened in Finder: '+pth):('could not open "'+pth+'" '+trunc(out,120))}
        if(c.name==='open_url'){if(!full)return 'REFUSED — enable "Full machine control"';const u=String(a.url||'');if(!/^https?:\/\//i.test(u))return 'url must start with http(s)://';await sh('open '+shq(u));return 'opened: '+u}
        if(c.name==='applescript'){if(!full)return 'REFUSED — enable "Full machine control"';const scr=String(a.script||'');if(!scr)return 'no script';let out='';const m=await sh('osascript '+scr.split('\n').map(l=>'-e '+shq(l)).join(' '),tk=>{out+=tk});return trunc((out||'(done)')+(m&&m.exit!=null&&m.exit!==0?' [exit '+m.exit+']':''),1200)}
        if(c.name==='run_shell'){if(!full)return 'REFUSED — enable "Full machine control"';let out='';const m=await sh(String(a.cmd||''),tk=>{out+=tk});return trunc((out||'(no output — the command printed nothing; do NOT infer any system state from this)')+(m&&m.exit!=null?' [exit '+m.exit+']':''),1500)}
        if(c.name==='web_search'){if(!perms.webAccess&&!full)return 'REFUSED — enable "Browse the web"';const r=await RPC('web','search',String(a.q||''),{limit:5});return r&&r.ok?r.results.map(x=>x.title+' — '+x.url).join('\n'):('no results '+((r&&r.error)||''))}
        if(c.name==='browse'){if(!perms.webAccess&&!full)return 'REFUSED — enable "Browse the web" (or Full machine control)';let u=String(a.url||'').trim();if(!u)return 'no url';if(!/^https?:\/\//i.test(u)){if(/^[\w-]+(\.[\w-]+)+/.test(u))u='https://'+u;else return 'bad url — give an http(s) address'}webOpen(u,{newTab:!!a.newTab,newWindow:!!a.newWindow});let r=null;try{r=await RPC('web','fetchUrl',u)}catch(e){}return 'Opened a live browser '+(a.newWindow?'WINDOW':'tab')+' rendering '+u+' (in the in-app Browser).'+(r&&r.ok?(' Readable text:\n'+String(r.text||'').slice(0,2500)):' (rendered for the owner; text extraction unavailable)')}
        if(c.name==='read_file'){if(!perms.fileWrite&&!full)return 'REFUSED — enable "Write files" or "Full machine control" to let me read files on your machine';const r=await RPC('files','read',String(a.path||''));return r.ok?trunc(r.text,1800):('failed: '+r.error)}
        if(c.name==='write_file'){if(!perms.fileWrite&&!full)return 'REFUSED — enable "Write files" or "Full machine control"';const r=await RPC('files','write',String(a.path||''),String(a.content||''));return r.ok?('written: '+r.path):('failed: '+r.error)}
        if(c.name==='send_email'){if(!perms.autoEmail)return 'REFUSED — enable "Send email without approval"';const accs=await Mail.accounts().catch(()=>[]);if(!accs.length)return 'no email account connected';const r=await Mail.send((accs.find(x=>x.isDefault)||accs[0]).id,{to:a.to,subject:a.subject,text:a.body});return r&&r.ok?'email sent ✉':('failed: '+((r&&r.error)||''))}
        // ── online servers / droplets (SSH + DigitalOcean) ──
        if(c.name==='server_list'){const r=await RPC('servers','list');if(!r||!r.ok)return 'no servers module';if(!r.servers.length)return 'No servers connected yet. The owner adds one in Settings → Servers (or you can server_provision one in their DigitalOcean account).';return r.servers.map(s=>s.id+' · '+s.name+' ('+(s.host||s.provider||'?')+')').join('\n')}
        if(c.name==='server_run'){if(!full)return 'REFUSED — enable "Full machine control" to operate servers';const r=await RPC('servers','run',String(a.id||''),String(a.cmd||''));return r&&r.ok?trunc((r.output||'(no output)')+(r.exit!=null?' [exit '+r.exit+']':''),1500):('failed: '+((r&&r.error)||''))}
        if(c.name==='server_automation'){if(!full)return 'REFUSED — enable "Full machine control"';const r=await RPC('servers','runAutomation',String(a.id||''),String(a.key||''));return r&&r.ok?trunc((r.output||'(done)'),1400):('failed: '+((r&&r.error)||''))}
        if(c.name==='server_deploy'){if(!full)return 'REFUSED — enable "Full machine control"';const r=await RPC('servers','deployAgent',String(a.id||''),{name:String(a.name||'agent')});return r&&r.ok?('deployed: '+(r.steps?r.steps.map(s=>s.step||s).join(' · '):'ok')):('failed: '+((r&&r.error)||''))}
        if(c.name==='server_provision'){if(!full)return 'REFUSED — enable "Full machine control"';const r=await RPC('servers','provision',{name:String(a.name||'clone-droplet'),region:a.region||'nyc1',size:a.size||'s-1vcpu-1gb'});return r&&r.ok?('droplet requested: '+(r.note||'booting')+' — use server_list then server_run to operate it'):('failed: '+((r&&r.error)||'')+' (a DigitalOcean token must be set on a server in Settings → Servers)')}
        // ── harnesses (crews of agents with gates) — in-app config, no permission needed ──
        if(c.name==='list_harnesses'){const r=await RPC('harness','list');return (r&&r.length)?r.map(h=>h.id+' · '+h.name+' — '+((h.roles||[]).length)+' agents'+(h.activeForTerminal?' · ACTIVE in CODE':'')+((h.roles||[]).length?' ['+h.roles.map(x=>x.name+(x.gate?'(gate)':'')).join(', ')+']':'')).join('\n'):'no harnesses yet'}
        if(c.name==='create_harness'){const nm=String(a.name||'').trim();if(!nm)return 'need a name';const roles=(Array.isArray(a.roles)?a.roles:[]).map(r=>({name:String(r.name||'').trim(),desc:String(r.desc||r.description||'').trim(),gate:!!r.gate,collapsible:!r.gate})).filter(r=>r.name);const r=await RPC('harness','add',{name:nm,description:String(a.description||''),kind:String(a.kind||'custom'),roles});if(r&&r.ok){Bus.emit('harness:changed');return 'Created harness "'+nm+'" with '+roles.length+' agents (id '+r.id+'). It is live in the HARNESS tab and the CODE harness picker. Use use_harness to activate it, or open_panel{panel:"harness"} to show the owner.'}return 'failed: '+((r&&r.error)||'')}
        if(c.name==='update_harness'){const id=String(a.id||'');const patch={};if(a.name)patch.name=String(a.name);if(a.description!=null)patch.description=String(a.description);if(Array.isArray(a.roles))patch.roles=a.roles.map(r=>({name:String(r.name||'').trim(),desc:String(r.desc||r.description||'').trim(),gate:!!r.gate,collapsible:!r.gate})).filter(r=>r.name);const r=await RPC('harness','update',id,patch);if(r&&r.ok){Bus.emit('harness:changed');return 'updated harness '+id}return 'failed: '+((r&&r.error)||'')}
        if(c.name==='use_harness'){const id=String(a.id||'');const r=await RPC('harness','setActiveForTerminal',id,true);if(r&&r.ok){Bus.emit('harness:changed');await loadHarnesses();const cur=active(),h=harnesses.find(x=>x.id===id);if(cur&&h){cur.harness={id,name:h.name};saveSt();syncPickers()}return 'harness '+id+' is now active in CODE — this session will reason as its crew'}return 'failed: '+((r&&r.error)||'')}
        // ── Context Engine v1 — eyes and honest self-knowledge (never gated) ──
        if(c.name==='app_context'){return appContextText(active())}
        if(c.name==='list_capabilities'){return 'PANELS (key — name (purpose)):\n'+panelCatalog()+'\n\nTOOLS: every tool in your system prompt TOOLS list is real; anything else does not exist.'}
        if(c.name==='read_panel'){
          const key=resolvePanelKey(a.panel);if(!key)return 'no panel matches "'+String(a.panel||'')+'"';
          const ps=screenPanels();
          const hit=ps.find(x=>x.key.toLowerCase()===key)||ps.find(x=>x.key.toLowerCase().startsWith(key));
          if(!hit)return 'panel "'+key+'" is not open (open now: '+(ps.map(x=>x.key).join(', ')||'none')+') — open_panel it first';
          const body=hit.el.querySelector('.body')||hit.el;
          const txt=(body.innerText||'').replace(/\n{3,}/g,'\n\n').trim();
          return 'PANEL '+hit.key+' — '+hit.title+(hit.docked?' [docked]':'')+' — visible content:\n'+(txt?trunc(txt,2200):'(no visible text)');
        }
        if(c.name==='close_panel'){
          const t=String(a.panel||'').trim().toLowerCase();if(!t)return 'no panel key';
          const ps=screenPanels();
          const hit=ps.find(x=>x.key.toLowerCase()===t)||ps.find(x=>x.key.toLowerCase().startsWith(t));
          if(!hit)return 'panel "'+t+'" is not open (open now: '+(ps.map(x=>x.key).join(', ')||'none')+')';
          if((hit.el.dataset.type||hit.key)==='terminal')return 'refusing to close the CODE panel — it hosts this conversation';
          close(hit.el);return 'closed panel: '+hit.key;
        }
        return 'unknown tool: "'+c.name+'" — this tool does NOT exist and nothing ran. Tell the owner honestly. Real tools are only the ones in your TOOLS list (use list_capabilities to see the panels).';
      }catch(e){return 'error: '+e.message}
    }
    // one streamed turn routed to the session's model (provider / machine)
    async function codeStream(cur,messages,onTok,signal,opts){
      let mv=cur.model||'';
      // dead-default heal: '' routes to the bridge brain; when no brain is loaded,
      // fall to the first available provider model instead of failing the first order
      if(!mv&&!Bridge.brainReady()){
        const alt=models.find(m=>m.v&&m.v!=='pi'&&m.on!==false); // pi routes via piRun, never through here
        if(alt){mv=alt.v;cur.model=mv;saveSt();syncPickers()}
      }
      if(mv.includes('::')){const k=mv.indexOf('::');return Bridge.providerChat(mv.slice(0,k),mv.slice(k+2),messages,onTok,signal,opts)}
      if(Bridge.brainReady()){
        // A bridge stream reports provider failures in its RESULT ({err}), not by throwing —
        // so a dead brain used to reach the owner as a raw error bubble with no way out.
        const attempt=async()=>{const r=await Bridge.chat(messages,onTok,signal,opts);if(r&&r.err)throw new Error(r.err);return r};
        try{return await attempt()}
        catch(e){
          // The bridge brain can be "ready" and still have no usable model behind it (a
          // provider default that isn't a real id, a local cluster with nothing loaded).
          // The owner's FIRST message must not die on that: switch to a model that works,
          // say so, and answer. (BUG-08: every OpenRouter owner met "No instance found".)
          const msg=String(e&&e.message||e);
          const dead=/no (instance|endpoints?|provider).*found|model.*not found|unknown model/i.test(msg);
          const badkey=/401|authentication|invalid.*api key|api key.*invalid|unauthorized/i.test(msg);
          const why=dead?'has no model loaded':'was refused by the provider';
          const tried=(models.find(m=>m.v===mv)||{}).pid;
          const alt=(dead||badkey)&&!mv?models.find(m=>m.v&&m.v.includes('::')&&m.on!==false&&m.pid!==tried&&m.pid!==(Bridge.info()||{}).providerId):null;
          if(!alt){
            if((dead||badkey)&&!mv&&piOk){cur.model='pi';saveSt();syncPickers();throw new Error('The machine brain '+why+'. Switched this session to **pi** — send again.')}
            throw e;
          }
          cur.model=alt.v;saveSt();syncPickers();
          onTok('_(the machine brain '+why+' — switched this session to **'+alt.label+'**)_\n\n');
          const k=alt.v.indexOf('::');
          return Bridge.providerChat(alt.v.slice(0,k),alt.v.slice(k+2),messages,onTok,signal,opts);
        }
      }
      throw new Error('Connect the HUB Bridge (MY MACHINE) and pick a model below.');
    }
    // ── Harness gates — real governance, not a prompt suggestion ─────────────
    // With a gated harness active on the session, irreversible tools PAUSE for an
    // inline OWNER approval card in the chat (audit BUG-L9-003: harness was a no-op).
    // The last three are not actions on the machine — they are actions on the RULES. With a crew
    // active, `use_harness` let the model move itself to a crew with different gates and
    // `update_harness` let it rewrite the one currently constraining it, neither needing
    // approval. c164d22 stopped a crew from having NO gates; this stops the model from choosing
    // which gates apply to it. Widening your own permissions is the most irreversible thing an
    // agent can do, and the OWNER gate exists for exactly that.
    //   With no crew selected there is nothing to widen, and gates===[] means these run freely —
    //   which is correct: an unconstrained conversation is already unconstrained.
    const GATED_TOOLS=new Set(['run_shell','applescript','write_file','send_email','server_run','server_automation','server_deploy','server_provision','create_harness','update_harness','use_harness']);
    const pendingGates=new Map();
    let gatesWired=false;
    function wireGates(){
      if(gatesWired)return;gatesWired=true;
      p.addEventListener('click',e=>{
        const ok=e.target.closest('[data-gateok]'),no=e.target.closest('[data-gateno]');
        if(!ok&&!no)return;
        const gid=ok?ok.dataset.gateok:no.dataset.gateno;
        const done=pendingGates.get(gid);
        if(done){pendingGates.delete(gid);done(!!ok)}
      });
    }
    // [] means "this conversation has no gates". null means "it names a crew and I cannot tell
    // what its gates are". Those were the same value, and the call site read both as "nothing to
    // approve", so a gated tool ran unapproved in two situations that are not rare:
    //
    //   · loadHarnesses() failed — its catch(_){} leaves `harnesses` empty
    //   · the crew was DELETED while a conversation still pointed at it
    //
    // In both, the session still displayed the crew's name, so the owner had every reason to
    // believe the approval gates were live. A safety gate that cannot be evaluated must fail
    // CLOSED; there is no reading of "I don't know" that justifies running the command.
    function harnessGates(cur){
      if(!cur||!cur.harness||!cur.harness.id)return [];        // no crew chosen: nothing to apply
      if(!harnessesLoaded)return null;                          // never loaded — cannot tell
      const hd=harnesses.find(x=>x.id===cur.harness.id);
      if(!hd)return null;                                       // named a crew that is gone
      // `gates[]` is the authoritative list — it is what the daemon floors to ['SAFETY','OWNER']
      // when a crew ends up with no gate roles. Reading roles[].gate instead meant that floor
      // was invisible here: a duplicated crew with every gate role deleted presented as
      // "no gates" and its gated tools ran unapproved. One idea, one representation.
      if(Array.isArray(hd.gates)&&hd.gates.length)return hd.gates.slice();
      return hd.roles?hd.roles.filter(r=>r.gate).map(r=>r.name):[];   // older records
    }
    function gateApprove(cur,c,gates,signal){
      wireGates();
      // A gate opened on an ALREADY-aborted turn used to hang forever: an abort listener added
      // after the abort never fires, so send() never resolved and the composer stayed dead.
      if(signal&&signal.aborted)return Promise.resolve(false);
      return new Promise(resolve=>{
        const gid='g'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
        const msg={role:'gate',gid,tool:c.name,gargs:trunc(JSON.stringify(c.args||{}),220),gates,resolved:null};
        cur.msgs.push(msg);saveSt();renderChat();
        // 'cancelled' is not 'rejected'. Stamping a stopped turn's gate as rejected wrote a
        // governance record the owner never made.
        const done=(ok,how)=>{msg.resolved=how||(ok?'approved':'rejected');saveSt();renderChat();resolve(ok)};
        pendingGates.set(gid,ok=>done(ok));
        if(signal)signal.addEventListener('abort',()=>{if(pendingGates.has(gid)){pendingGates.delete(gid);done(false,'cancelled')}},{once:true});
      });
    }
    const MAX_STEPS=6;
    async function agentRun(cur,sig){
      let perms={};try{perms=await RPC('permissions','get')}catch(_){}
      let convo=cur.msgs.filter(m=>(m.role==='user'||m.role==='ai')&&String(m.raw||m.content||'').trim()).map(m=>({role:m.role==='ai'?'assistant':'user',content:m.raw||m.content})); // drop empties (aborted turns) → no Anthropic 400
      let steps=0,ranOut=false;
      while(steps++<MAX_STEPS&&!sig.aborted){
        ranOut=false;
        // rebuilt EVERY step: after each tool the screen changed — the model must see it
        const sys0=await buildAgentSystem(perms,cur,cmode);
        const bot={role:'ai',content:''};cur.msgs.push(bot);saveSt();
        await renderChat();
        let acc='';
        try{const rr=await codeStream(cur,convo,tk=>{acc+=tk;bot.content=acc.replace(/```tool[\s\S]*?```/g,'').replace(/```tool[\s\S]*$/,'').trim();paintBubble(cur,bot)},sig,{system:sys0,max_tokens:4096});if(rr&&rr.err)acc+=(acc?'\n':'')+'⚠ '+friendlyErr(rr.err)}
        catch(e){if(e.name!=='AbortError'&&!/abort/i.test(e.message||''))acc+='\n⚠ '+friendlyErr(e.message)}
        const calls=parseToolCalls(acc);
        bot.content=acc.replace(/```tool[\s\S]*?```/g,'').replace(/```tool[\s\S]*$/,'').trim()||(calls.length?'*(using tools…)*':acc);
        bot.raw=acc;saveSt();
        convo.push({role:'assistant',content:acc});
        if(!calls.length)break;
        const results=[];
        const gates=harnessGates(cur);
        for(const c of calls){
          // ■ stops here too. The loop used to run every parsed call to completion after the
          // abort — the owner pressed stop and the shell commands still happened.
          if(sig.aborted){cur.msgs.push({role:'sys',content:'⚙ stopped before '+c.name});break}
          let r;
          if(GATED_TOOLS.has(c.name)&&gates===null){
            // A crew is named but its gates cannot be evaluated — it never loaded, or it was
            // deleted while this conversation still pointed at it. The session still SHOWS the
            // crew's name, so the owner believes the gates are live. Fail closed and say which
            // of the two it is; running the tool here is the one outcome nobody chose.
            const nm=(cur.harness&&cur.harness.name)||'the selected crew';
            r='BLOCKED — this conversation is set to the crew "'+nm+'", and its approval gates could not be applied (the crew is unavailable or was deleted). Nothing was run. Pick a crew again in the HARNESS picker, or clear it, then retry.';
            cur.msgs.push({role:'sys',content:'⚠ '+c.name+' blocked — crew "'+nm+'" unavailable, so its gates could not be applied'});
          }else if(gates&&gates.length&&GATED_TOOLS.has(c.name)){
            const ok=await gateApprove(cur,c,gates,sig);
            r=ok?await execTool(c,perms,sig):'BLOCKED — the OWNER gate rejected this action. Do not retry it; explain what you wanted and propose an alternative.';
          }else r=await execTool(c,perms,sig);
          results.push(c.name+' → '+trunc(String(r),900));
          cur.msgs.push({role:'sys',content:'⚙ '+c.name+' '+trunc(JSON.stringify(c.args),70)+' → '+trunc(String(r),140)});
        }
        bot.raw=acc+'\n\n<tool_results>\n'+results.join('\n')+'\n</tool_results>'; // persist results in raw → a follow-up turn sees them and won't re-run the tools
        saveSt();await renderChat();
        if(sig.aborted)break;
        convo.push({role:'user',content:'TOOL RESULTS:\n'+results.join('\n\n')+'\n\nContinue (more tools) or give the final answer without tool blocks.'});
        ranOut=true;   // this step ended holding tools, so another step is needed
      }
      // The cap used to end the turn mid-work in silence: the last tools ran, their results were
      // appended, and nothing ever answered. Say what happened and how to continue.
      if(ranOut&&!sig.aborted)cur.msgs.push({role:'sys',content:'⚙ reached the '+MAX_STEPS+'-step limit for one turn — the work above is done, but the agent had more planned. Send “continue” to carry on.'});
    }
    // ── pi mode — the raw Pi coding agent answers. Pi runs its OWN agentic loop, tools and
    // memory (the bridge keeps one `pi --mode rpc` process per CODE session and the
    // clone-frame extension is its hands on the app), so the app's ```tool protocol and
    // agentRun are bypassed entirely: we send only the new message and render pi's NDJSON
    // stream — prose into the bubble, ⚙ tool activity as sys lines above it.
    // What the agent is handed when its process is new (see bridge/pi.mjs → historyPreamble).
    // Only user/assistant prose: the ⚙ tool lines are this panel's own log, and gate cards are
    // governance records, not conversation.
    function piHistory(cur,upTo){
      const out=[];
      for(const m of cur.msgs){
        if(m===upTo)break;
        if(m.role!=='user'&&m.role!=='ai')continue;
        const body=String(m.raw||m.content||'').trim();
        if(!body||m.err)continue;
        out.push({role:m.role==='ai'?'assistant':'user',content:body});
      }
      return out;
    }
    // /goals promised "the agent keeps them in mind" and the bound iNFT promised a persona —
    // but on the pi path (the default whenever pi is installed) piRun sent the raw message and
    // neither ever reached the agent. pi has its own system prompt from AGENTS.md, so these
    // ride the message as a short standing block instead.
    function standingContext(cur){
      const bits=[];
      const a=cur&&cur.inft;
      if(a&&a.name)bits.push('You are speaking AS the owner\'s agent iNFT "'+a.name+'"'+(a.collection?' ('+a.collection+')':'')+(a.tokenId?' — token #'+a.tokenId:'')+'. Embody it. Hard limit: never move value without asking the owner first.');
      if(cur&&Array.isArray(cur.goals)&&cur.goals.length)bits.push('Standing goals for this conversation, set by the owner — keep them in mind and work toward them:\n'+cur.goals.map((g,i)=>(i+1)+'. '+g).join('\n'));
      if(!bits.length)return '';
      return '<standing_context>\n'+bits.join('\n\n')+'\n</standing_context>\n\n';
    }
    async function piRun(cur,text,imgs,sig){
      const bot={role:'ai',content:''};
      const history=piHistory(cur,bot);
      // The last user turn IS this message — it arrives as the prompt, so it must not also
      // close the replayed history.
      if(history.length&&history[history.length-1].role==='user')history.pop();
      cur.msgs.push(bot);saveSt();await renderChat();
      const paint=()=>paintBubble(cur,bot);
      const pendingTools=[]; // ⚙ sys msgs awaiting their result
      try{
        await Bridge.piChat(cur.id,text,cur.model,ev=>{
          // The engine that actually answered. The picker was the only claim about the model,
          // and nothing could contradict it — now the stream says so, and a fresh agent
          // (process died between turns) is announced instead of appearing as amnesia.
          if(ev.t==='meta'){
            const lbl=ev.model?(ev.provider?ev.model+' · '+ev.provider:ev.model):(ev.own?'pi’s own model':'');
            if(ev.fresh&&history.length)cur.msgs.splice(cur.msgs.indexOf(bot),0,{role:'sys',content:'⚙ new agent process'+(lbl?' on '+lbl:'')+' — the conversation so far was handed back to it'});
            else if(lbl&&lbl!==cur._lastEngine)cur.msgs.splice(cur.msgs.indexOf(bot),0,{role:'sys',content:'⚙ answering on '+lbl});
            cur._lastEngine=lbl;saveSt();renderChat();paint();return;
          }
          if(ev.t==='text'&&ev.d){bot.content+=ev.d;paint();return}
          if(ev.t==='tool'){
            if(ev.phase==='start'){
              const m={role:'sys',content:'⚙ '+ev.name+' '+trunc(JSON.stringify(ev.args||{}),70)+' …'};
              pendingTools.push({id:ev.id||'',name:ev.name,m});
              cur.msgs.splice(cur.msgs.indexOf(bot),0,m); // tool lines sit ABOVE the streaming bubble
              saveSt();renderChat();paint();
            }else{
              // Pair by pi's OWN call id. Pairing by name swapped the results of two concurrent
              // tools with the same name, and a stray end corrupted whatever line sat at slot 0.
              let i=ev.id?pendingTools.findIndex(x=>x.id===ev.id):-1;
              if(i<0)i=pendingTools.findIndex(x=>x.name===ev.name);
              if(i<0){saveSt();return}                    // no owner: never overwrite a stranger
              const hit=pendingTools.splice(i,1)[0];
              hit.m.content='⚙ '+ev.name+' → '+(ev.ok===false?'failed: ':'')+trunc(String(ev.result||'(done)'),140);
              saveSt();renderChat();paint();
            }
            return;
          }
          if(ev.t==='error'&&ev.d){bot.content+=(bot.content?'\n':'')+'⚠ '+friendlyErr(ev.d);bot.err=true;paint()}
        },sig,imgs||[],history);
      }catch(e){
        if(e.name!=='AbortError'&&!/abort/i.test(e.message||'')){bot.content+=(bot.content?'\n':'')+'⚠ '+friendlyErr(e.message);bot.err=true}
      }
      for(const t of pendingTools)t.m.content+=' (interrupted)';
      // "(no reply)" is a claim. An aborted turn produced no reply because the OWNER stopped it,
      // and an empty one with no error is worth saying plainly rather than dressing up.
      if(!bot.content.trim()){bot.content=sig.aborted?'_(stopped)_':'_(the agent returned nothing — check the model and its key)_';bot.err=true}
      else bot.content=bot.content.trim();
      saveSt();await renderChat();
    }
    async function send(){
      const inp=$('#cdin');let text=(inp.value||'').trim();
      if(!text&&!draftFiles.length&&!draftImgs.length)return;
      // Only THIS conversation blocks on its own turn — and it says so instead of doing nothing.
      if(runHere()){Toast.show('This conversation is still answering — press ■ to stop it, or open another session');return}
      slashList=[];renderSlash(); // any pending slash menu is resolved by sending
      let cur=active();if(!cur){cur=newSession();renderSessions()}
      if(text.charAt(0)==='/'){
        const sp=text.indexOf(' '),cmd=(sp<0?text:text.slice(0,sp)).toLowerCase(),arg=sp<0?'':text.slice(sp+1).trim();
        const note=m=>{cur.msgs.push({role:'ai',content:m});saveSt();renderChat();inp.value='';autosize();};
        if(cmd==='/clear'){cur.msgs=[];saveSt();renderChat();inp.value='';autosize();return}
        if(cmd==='/model'){inp.value='';popModels();return}
        if(cmd==='/harness'){inp.value='';popHarness();return}
        if(cmd==='/context'){note('**What I can see right now:**\n```\n'+appContextText(cur)+'\n```');return}
        if(cmd==='/panel'){
          if(!arg){note('Usage: `/panel <name>` — e.g. `/panel notes`');return}
          // Use the SAME resolver the agent's open_panel uses: crude space-stripping made
          // '/panel my agents' → 'myagents', which matches nothing, and it claimed success anyway.
          const k=resolvePanelKey(arg);
          if(!k){note('No panel called **'+escHtml(arg)+'**. Try one of: `'+Object.keys(DEFS).join('` · `')+'`');return}
          note(openPanel(k)?('Opened **'+k+'**.'):('**'+k+'** could not be opened — it may be under construction.'));return;
        }
        if(cmd==='/run'){
          if(!arg){note('Usage: `/run <command>` — e.g. `/run ls ~/Desktop`');return}
          inp.value='';autosize();
          cur.msgs.push({role:'user',content:'/run '+arg});
          const holder={role:'ai',content:'```\n$ '+arg+'\n…\n```'};cur.msgs.push(holder);saveSt();renderChat();
          let perms={};try{perms=await RPC('permissions','get')}catch(_){}
          const out=await execTool({name:'run_shell',args:{cmd:arg}},perms);
          holder.content='```\n$ '+arg+'\n'+String(out)+'\n```';saveSt();renderChat();
          return;
        }
        if(cmd==='/goals'){
          cur.goals=Array.isArray(cur.goals)?cur.goals:[];
          if(arg==='clear'){cur.goals=[];saveSt();note('Goals cleared.');return}
          if(arg){cur.goals.push(arg);saveSt();note('🎯 Goal added. This session now has '+cur.goals.length+' goal(s); the agent keeps them in mind.\n\n'+cur.goals.map((g,i)=>(i+1)+'. '+g).join('\n'));}
          else note(cur.goals.length?('🎯 **Session goals:**\n'+cur.goals.map((g,i)=>(i+1)+'. '+g).join('\n')+'\n\n_Add one with_ `/goals <text>` _· clear with_ `/goals clear`'):'No goals set yet. Add one with `/goals <text>` — the agent will keep it in mind every turn.');
          return;
        }
        if(cmd==='/help'){
          const ext=piSlash.filter(s=>s.src==='extension'),sk=piSlash.filter(s=>s.src==='skill'),pt=piSlash.filter(s=>s.src==='prompt');
          const list=a=>a.slice(0,18).map(s=>'`'+s.c+'`').join(' · ')+(a.length>18?' _+'+(a.length-18)+' more_':'');
          note('**Slash commands**\n\n**This panel**\n`/goals` — goals the agent keeps in mind\n`/context` — what the agent currently sees\n`/model` · `/harness` — pick model / crew\n`/panel <name>` — open a panel\n`/run <cmd>` — run in the terminal\n`/clear` — clear the chat'
            +(ext.length?'\n\n**The agent\'s own** ('+ext.length+')\n'+list(ext):'')
            +(pt.length?'\n\n**Prompt templates** ('+pt.length+')\n'+list(pt):'')
            +(sk.length?'\n\n**Skills** ('+sk.length+')\n'+list(sk):'')
            +'\n\nType `/` to filter any of them. Also: ❯_ real terminal · ⧉ diff · 🌐 web.');return}
        // unknown slash: fall through and send as a normal message
      }
      let imgs=[];
      if(draftImgs.length){
        imgs=draftImgs.map(m=>({data:m.data,mimeType:m.mime}));
        text=(text?text+'\n':'')+'['+imgs.length+' image'+(imgs.length>1?'s':'')+' attached]';
        draftImgs=[];
      }
      if(draftFiles.length){
        const ctx=draftFiles.map(f=>f.text?('```'+f.name+'\n'+f.text+'\n```'):('[attached file: '+(f.path||f.name)+' — read it with your tools]')).join('\n');
        text=(ctx+'\n\n'+text).trim();draftFiles=[];
      }
      renderChips();
      if(cur.title==='New session'&&text){cur.title=text.slice(0,34)+(text.length>34?'…':'');renderSessions()}
      cur.msgs.push({role:'user',content:text});cur.ts=Date.now();
      _pinBottom=true; // the reader just sent — ride the bottom so their turn + the reply show
      // Whenever the bridge is connected the model is tool-capable — in BOTH Chat and
      // Agent modes. Chat acts when you ask it to; Agent is proactive. (Fixes "I'm just a
      // text assistant, I can't open apps".) Plain chat only when there's no bridge/body.
      if(Bridge.on()){
        inp.value='';autosize();cur.draft='';saveSt();
        const ctl=new AbortController(),sig=ctl.signal;
        runs.set(cur.id,ctl);syncSend();
        // pi is the agent when installed: 'pi' = its own default model, a provider model = pi
        // running on that model underneath (routed via the local relay). agentRun is the
        // fallback when pi is absent, and for the bare machine brain ('').
        try{
          const wants=((cur.model||'')==='pi')||String(cur.model||'').includes('::');
          // A session pinned to pi used to fall through to the MACHINE BRAIN whenever the
          // status probe had failed or not answered yet — a different LLM answered under the
          // label "pi". Re-ask instead of guessing, and if pi really is gone, say so.
          if(wants&&!piOk)await refreshPiOk();
          if(wants&&!piOk&&(cur.model||'')==='pi'){
            cur.msgs.push({role:'ai',content:'⚠ **pi is not available on this machine right now**, so nothing was sent. Install it with `npm i -g @earendil-works/pi-coding-agent`, or pick another model below.',err:true});
          }else if(wants&&piOk)await piRun(cur,standingContext(cur)+text,imgs,sig);
          else await agentRun(cur,sig);
        }catch(e){
          // This was `catch(_){}`: a DOM or storage failure anywhere in the turn killed it with
          // no bubble, no toast and no line in the transcript — the app just stopped answering.
          if(!sig.aborted&&e&&e.name!=='AbortError')cur.msgs.push({role:'ai',content:'⚠ '+friendlyErr(e.message||String(e)),err:true});
        }
        if(runs.get(cur.id)===ctl)runs.delete(cur.id);
        syncSend();saveSt();if(active()&&active().id===cur.id)await renderChat();else renderSessions();
        return;
      }
      const bot={role:'ai',content:''};cur.msgs.push(bot);saveSt();
      inp.value='';autosize();cur.draft='';renderChat();
      const ctl=new AbortController();runs.set(cur.id,ctl);syncSend();
      const onTok=t=>{bot.content+=t;paintBubble(cur,bot)};
      let sys='You are inside CLONE FRAME CODE — the owner\'s workspace. Answer helpfully and directly, in the user\'s language. Do not make things up.'+inftContext();
      if(cur.harness&&cur.harness.name){
        const hd=harnesses.find(h=>h.id===cur.harness.id);
        sys+=' Active HARNESS: '+cur.harness.name+'.';
        if(hd&&hd.roles&&hd.roles.length)sys+=' Crew roles: '+hd.roles.map(r=>r.name+(r.gate?' (gate)':'')).join(', ')+'.';
        if(hd&&hd.gates&&hd.gates.length)sys+=' Non-collapsible gates: '+hd.gates.join(' · ')+'.';
        sys+=' Operate as this crew: reason through the relevant roles when planning, and never treat an irreversible action as approved — the OWNER gate is the human.';
      }
      const histM=cur.msgs.filter(m=>m!==bot&&(m.role==='user'||m.role==='ai')&&String(m.content||'').trim()).map(m=>({role:m.role==='ai'?'assistant':'user',content:m.content})); // only user/ai, non-empty → excludes ⚙ tool-log sys msgs (role-alternation 400)
      try{
        const mv=cur.model||'';let rr=null;
        if(mv.includes('::')){const k=mv.indexOf('::');rr=await Bridge.providerChat(mv.slice(0,k),mv.slice(k+2),histM,onTok,ctl.signal,{system:sys})}
        else if(Bridge.brainReady()){rr=await Bridge.chat(histM,onTok,ctl.signal,{system:sys})}
        else bot.content='Connect the HUB Bridge (MY MACHINE) and pick a model below.';
        if(rr&&rr.err){bot.content+=(bot.content?'\n':'')+'⚠ '+friendlyErr(rr.err);bot.err=true} // surface stream errors (bad key / model) instead of a stuck "…"
      }catch(e){if(e.name!=='AbortError'&&!/abort/i.test(e.message||'')){bot.content+=(bot.content?'\n':'')+'⚠ '+friendlyErr(e.message);bot.err=true}}
      if(runs.get(cur.id)===ctl)runs.delete(cur.id);
      syncSend();
      if(!bot.content.trim()){bot.content=ctl.signal.aborted?'_(stopped)_':'_(empty reply)_';bot.err=true}
      saveSt();paintBubble(cur,bot);
    }

    /* ----- wiring ----- */
    if(!st.sessions.length)newSession();
    if(!st.active||!active())st.active=st.sessions[0].id;
    // loadDraft: newSession() stashes the OUTGOING draft, but the new conversation must then
    // get its own (empty) composer — otherwise the half-typed sentence is still sitting there.
    $('#cdnew').addEventListener('click',()=>{newSession();renderSessions();renderChat();loadDraft();syncSend()});
    $('#cdtermbtn').addEventListener('click',()=>openPane('term'));
    $('#cddiffbtn').addEventListener('click',()=>openPane('diff'));
    $('#cdwebbtn').addEventListener('click',()=>openPanel('research')); // the browser is the standalone BROWSER window
    $('#cdpaneclose').addEventListener('click',()=>{pane=null;syncPane()});
    // pop the shell out: CLICK opens a standalone Terminal; DRAG onto a frame square docks a terminal there
    { const pop=$('#cdpanepop'); if(pop){
      const cellAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.cell'):null};
      const disarm=()=>document.querySelectorAll('.cell.armed').forEach(c=>c.classList.remove('armed'));
      // CLICK opens a standalone Terminal; DRAG onto an empty frame square docks a terminal there (T-045)
      dragGesture(pop,{threshold:6,
        ghost:()=>{const g=document.createElement('div');g.className='fitghost';g.innerHTML='<svg><use href="#i-term2"/></svg>iT';return g},
        onMove:(e,d)=>{disarm();const cell=cellAt(d.x,d.y);if(cell&&!cell.classList.contains('occ'))cell.classList.add('armed')},
        onDrop:(e,d)=>{disarm();pop.dataset.dragged='1';setTimeout(()=>{delete pop.dataset.dragged},60);
          const cell=cellAt(d.x,d.y);
          if(cell&&!cell.classList.contains('occ')){Grid.occupy(cell,'shell',{label:(cwdAbs||'').split('/').filter(Boolean).pop()||'terminal',cwd:cwdAbs||''});cell.classList.add('minpulse');setTimeout(()=>cell.classList.remove('minpulse'),1000);Toast.show('iT docked into a frame — click it to open')}
          else Toast.show('Drop it on an empty frame square')}});
      pop.addEventListener('click',()=>{if(pop.dataset.dragged)return;pendingShellCwd=cwdAbs||'';openPanel('shell')});
    } }
    initSplitter($('#cdsplitside'),ev=>{                 // resize sessions rail (px)
      const r=p.querySelector('.cdwrap').getBoundingClientRect();
      let w=ev.clientX-r.left;
      w=Math.max(132,Math.min(w,r.width*0.5,420));
      lay.sideW=Math.round(w);$('#cdside').style.width=lay.sideW+'px';
    });
    initSplitter($('#cdsplitpane'),ev=>{                 // resize side pane (fraction of .cdsplit)
      const r=$('#cdsplit').getBoundingClientRect();
      let px=r.right-ev.clientX;
      px=Math.max(260,Math.min(px,r.width-320));
      lay.paneFrac=px/r.width;$('#cdpane').style.width=(lay.paneFrac*100).toFixed(2)+'%';
    });
    $('#cdrailtog').addEventListener('click',()=>{lay.railOpen=!lay.railOpen;saveLay();applyRail();});
    $('#cdrailtog2').addEventListener('click',()=>{lay.railOpen=true;saveLay();applyRail();});
    applyLayout();applyRail();
    $('#cdmode').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;cmode=b.dataset.m;localStorage.setItem('cfhub.code.mode',cmode);$('#cdmode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));Toast.show(cmode==='agent'?'Agent — proactive: it chains tools to finish the goal':'Chat — it answers, and acts on your app/machine when you ask')});
    (()=>{const b=$('#cdmode').querySelector(`[data-m="${cmode}"]`);if(b){$('#cdmode').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b))}})();
    $('#cdmodel').addEventListener('click',()=>$('#cdmodelpop').classList.contains('open')?closePops():popModels());
    $('#cdinft').addEventListener('click',()=>$('#cdinftpop').classList.contains('open')?closePops():popInft());
    $('#cdharness').addEventListener('click',()=>$('#cdharnesspop').classList.contains('open')?closePops():popHarness());
    $('#cdplus').addEventListener('click',()=>$('#cdpluspop').classList.contains('open')?closePops():popPlus());
    $('#cdmiccfg').addEventListener('click',()=>$('#cdmicpop').classList.contains('open')?closePops():popMicMenu());
    const mic=$('#cdmic');
    mic.addEventListener('pointerdown',()=>{if(micHold)startRec()});
    mic.addEventListener('pointerup',()=>{if(micHold)stopRec()});
    mic.addEventListener('pointerleave',()=>{if(micHold&&recOn)stopRec()});
    mic.addEventListener('click',()=>{if(!micHold)recOn?stopRec():startRec()});
    // ── slash-command menu (Objective 6: "/" with /goals and friends) ─────────
    const SLASH=[
      {c:'/goals',d:'Show or set this session\'s goals (/goals <text> to add)'},
      {c:'/context',d:'Show what the agent currently sees'},
      {c:'/model',d:'Pick the model for this session'},
      {c:'/harness',d:'Pick the harness (crew + gates)'},
      {c:'/panel',d:'Open a panel by name — /panel notes'},
      {c:'/run',d:'Run a shell command — /run ls ~'},
      {c:'/clear',d:'Clear this conversation'},
      {c:'/help',d:'List all commands'},
    ];
    // The agent's OWN commands (extensions like /goal + /subgoal, prompt templates,
    // skills) — asked live, never hand-listed. A written-by-hand list drifts: /goal
    // shipped registered and invisible, and typing it hung with no reply (BUG-09).
    let piSlash=[];
    async function loadPiCommands(){
      if(!Bridge.on())return;
      try{
        const r=await RPC('pi','commands');
        piSlash=((r&&r.commands)||[]).map(c=>({c:'/'+c.name,d:(c.description||'').slice(0,90),src:c.source||'pi'}));
      }catch(_){piSlash=[]}
    }
    const SLASH_SHOWN=14; // the box is a picker, not a catalogue — /help prints the rest
    let slashSel=0,slashList=[],slashMore=0;
    const slashBox=()=>$('#cdslash');
    function slashMatches(v){
      // active only while typing the command word itself: starts with "/", no space yet
      if(!/^\/[a-z][a-z0-9:_-]*$/i.test(v)&&v!=='/')return null;
      const q=v.slice(1).toLowerCase();
      const local=SLASH.filter(s=>s.c.slice(1).toLowerCase().startsWith(q));
      const mine=piSlash.filter(s=>s.c.slice(1).toLowerCase().startsWith(q)&&!local.some(l=>l.c===s.c));
      return local.concat(mine);
    }
    function renderSlash(){
      const box=slashBox();if(!box)return;
      if(!slashList.length){box.style.display='none';box.innerHTML='';return}
      slashSel=Math.min(slashSel,slashList.length-1);
      box.innerHTML=slashList.map((s,i)=>`<div class="si${i===slashSel?' sel':''}" data-c="${escAttr(s.c)}"><b>${escHtml(s.c)}</b><span>${escHtml(s.d)}</span>${s.src&&s.src!=='local'?`<em class="sisrc">${escHtml(s.src)}</em>`:''}</div>`).join('')
        +(slashMore?`<div class="simore">+${slashMore} more — keep typing to narrow</div>`:'');
      box.style.display='block';
    }
    function updateSlash(){
      const m=slashMatches($('#cdin').value.trim())||[];
      slashMore=Math.max(0,m.length-SLASH_SHOWN);slashList=m.slice(0,SLASH_SHOWN);slashSel=0;renderSlash();
    }
    function pickSlash(cmd){const i=$('#cdin');i.value=cmd+' ';slashList=[];renderSlash();i.focus();autosize();}
    const cdin=$('#cdin');
    cdin.addEventListener('input',()=>{autosize();updateSlash()});
    slashBox().addEventListener('click',e=>{const it=e.target.closest('.si');if(it)pickSlash(it.dataset.c)});
    cdin.addEventListener('keydown',e=>{
      if(slashList.length){
        if(e.key==='ArrowDown'){e.preventDefault();slashSel=Math.min(slashSel+1,slashList.length-1);renderSlash();return}
        if(e.key==='ArrowUp'){e.preventDefault();slashSel=Math.max(slashSel-1,0);renderSlash();return}
        if(e.key==='Escape'){slashList=[];renderSlash();return}
        if(e.key==='Tab'){e.preventDefault();pickSlash(slashList[slashSel].c);return}
        // Enter: if the typed word already equals a whole command, SEND it (an arg-less
        // command like /context runs now); otherwise complete the highlighted one.
        if(e.key==='Enter'&&!e.shiftKey){
          e.preventDefault();
          if($('#cdin').value.trim().toLowerCase()===slashList[slashSel].c){slashList=[];renderSlash();send()}
          else pickSlash(slashList[slashSel].c);
          return;
        }
      }
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='u'){e.preventDefault();pickFiles(false);return}
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}
    });
    // ■ stops the turn of the conversation you are LOOKING AT. It used to stop whatever the
    // panel happened to be streaming, which in a second session was somebody else's turn.
    $('#cdsend').addEventListener('click',()=>{
      const c=active(),ctl=c&&runs.get(c.id);
      if(ctl){runs.delete(c.id);try{ctl.abort()}catch(_){}syncSend();Toast.show('Stopped');return}
      send();
    });
    p.addEventListener('pointerdown',e=>{if(!e.target.closest('.cdpop')&&!e.target.closest('.cdovf')&&!e.target.closest('.dots')&&!e.target.closest('#cdmodel')&&!e.target.closest('#cdinft')&&!e.target.closest('#cdharness')&&!e.target.closest('#cdplus')&&!e.target.closest('#cdmic')&&!e.target.closest('#cdmiccfg'))closePops()});
    const zs=zselW();zs.value=theme;
    zs.addEventListener('change',()=>{theme=zs.value;localStorage.setItem('cfhub.zsh',theme);if(pane==='term')renderShell()});
    $('#cdpanebody').addEventListener('click',e=>{if(pane==='term'&&!e.target.closest('input'))$('#cdpanebody').querySelector('#tin')?.focus()});
    function syncBridge(){const inf=Bridge.info();if(inf){host='local';if(inf.cwd){cwd=relCwd(inf.cwd);cwdAbs=inf.cwd;}refreshBranch().then(()=>{if(pane==='term'&&!busy)renderShell()});Tree.onCwd();}}
    panelBus(p).on("bridge:changed",()=>{syncBridge();loadModels();loadHarnesses();loadPiCommands();if(pane==='term'&&!busy)renderShell()});
    // web:open is handled solely by the standalone BROWSER (research panel) now — see webOpen()/wireWebBrowser. Kept single-sink to avoid double-open.
    panelBus(p).on('models:changed',()=>{loadModels()});
    panelBus(p).on('harness:changed',()=>{loadHarnesses().then(()=>{if($('#cdharnesspop')&&$('#cdharnesspop').classList.contains('open'))popHarness()})}); // a new/edited harness shows up in the picker immediately
    if(Bridge.on()){out('<span class="ok">● REAL shell connected — HUB Bridge</span> <span class="dim">'+escHtml(Bridge.info().cwd||'')+' · type any zsh command · Ctrl+C interrupts</span>');syncBridge()}
    else out('<span class="sys">CLONE FRAME OS · zsh (demo)</span> <span class="dim">— connect the HUB Bridge in MY MACHINE for a REAL shell on your machine.</span> type <span class="kw">help</span>');
    // Closing the CODE window closes every conversation it was showing: the agents end,
    // their context and scratch go with them, and the transcripts stay on the rail for
    // next time (reopening starts a fresh agent on the same history — the point of the
    // whole lifecycle). Guarded on being the LAST CODE window: a second ⧉ window still
    // on screen may have a turn in flight, and its agents are the same processes.
    p._dispose=()=>{
      stashDraft();saveSt();
      // Docking is not closing. CODE is not a MULTI type, so docking into a frame square
      // destroys the window — and that used to end every conversation's agent and erase all
      // their context, for a gesture the owner meant as "put this aside for a second".
      if(p.dataset.docking)return;
      if(document.querySelectorAll('.panel[data-type="terminal"]').length>1)return;
      for(const [,c] of runs){try{c.abort()}catch(_){}}
      runs.clear();
      st.sessions.forEach(x=>endAgent(x.id));
    };
    renderSessions();renderChat();loadModels();loadHarnesses();loadPiCommands();
  }
