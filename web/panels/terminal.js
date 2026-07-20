  function wireTerminal(p){
    /* ---------- CODE — Claude Code-style workspace: sessions rail · NL chat · side panes ---------- */
    const $=sel=>p.querySelector(sel);

    /* ----- sessions (persisted) ----- */
    const KEY='cfhub.code.v1';
    const stCell=persisted(KEY,null); let st=stCell.get(); // kernel persisted (T-046)
    if(!st||!Array.isArray(st.sessions))st={sessions:[],active:null};
    const saveSt=()=>stCell.set(st);
    const active=()=>st.sessions.find(x=>x.id===st.active)||null;
    function newSession(){const x={id:'s'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),title:'New session',ts:Date.now(),model:'',harness:hDefault,msgs:[]};st.sessions.unshift(x);st.active=x.id;saveSt();return x}

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
      const gitseg=branch?`<span class="pl s3"> ⎇ ${branch}</span>`:'';
      const hs=ssh?'my-server':host;
      if(theme==='robby')return `<div class="tprompt robby"><span class="pl s1">➜</span><span class="pl s2">${hs} ${cwd}</span>${branch?`<span class="pl s3">git:(${branch})</span>`:''}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
      if(theme==='powerlevel')return `<div class="tprompt"><span class="pl s1"> ${hs} </span><span class="pl s2"> ${cwd} </span>${gitseg}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
      return `<div class="tprompt"><span class="pl s1"> ${ssh?'ssh':'AR'} </span><span class="pl s2"> ${hs} </span><span class="pl s3"> ${cwd} </span>${gitseg}<input autocomplete="off" spellcheck="false" id="tin"></div>`;
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
      const shell=cmd=>new Promise(res=>{let o='';Bridge.shell(cmd,t=>{o+=t}).then(()=>res(o)).catch(()=>res(o))});

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
    let models=[],harnesses=[],hDefault=null;
    async function loadModels(){
      const inf=Bridge.info&&Bridge.info();
      models=[{v:'',label:'machine'+(inf&&inf.model?' · '+inf.model:''),prov:'HUB Bridge',on:true}];
      if(Bridge.on()){try{const provs=await RPC('models','listProviders');provs.forEach(pr=>{if(pr.enabled===false)return;(pr.models||[]).forEach(m=>models.push({v:pr.id+'::'+m,label:m,prov:pr.label||pr.provider,pid:pr.id,on:!(pr.disabledModels||[]).includes(m)}))})}catch(_){}}
      syncPickers();
    }
    async function loadHarnesses(){
      if(Bridge.on()){try{harnesses=await RPC('harness','list');const a=harnesses.find(h=>h.activeForTerminal);hDefault=a?{id:a.id,name:a.name}:null;const cur=active();if(cur&&!cur.harness&&hDefault){cur.harness=hDefault;saveSt()}}catch(_){}}
      syncPickers();
    }
    function syncPickers(){
      const cur=active();
      const mv=cur?cur.model||'':'';
      const mm=models.find(m=>m.v===mv)||models[0]||{label:'machine'};
      $('#cdmodel').textContent=mm.label+' ▾';
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
            ${m.pid?`<span class="dot ${m.on?'on':''}" data-pid="${m.pid}" data-m="${escAttr(m.label)}" data-on="${m.on?1:0}" title="Enable / disable"></span>`:'<span class="dot on lock" title="machine default"></span>'}
          </div>`).join('')||'<div class="qempty" style="padding:10px">No models connected — add one in Settings → Add Models.</div>';
      };
      pop.innerHTML=`<div class="cdprow"><input id="cdmq" placeholder="Search models…"><button class="btn mini" id="cdmadd" title="Add models (Settings)">＋</button></div>
        <div class="cdmhd">MODELS</div>
        <div id="cdmlist">${rows('')}</div>
        <div class="dv"></div>
        <button class="cdmmore" id="cdmmore">More models<span>→</span></button>`;
      pop.classList.add('open');
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
      pop.addEventListener('keydown',e=>{const mq=pop.querySelector('#cdmq');if(document.activeElement===mq&&mq.value)return;const n=+e.key;if(n>=1&&n<=4){const r=list.querySelectorAll('.cdmrow')[n-1];if(r)r.click()}});
      pop.querySelector('#cdmq').focus();
    }
    function popInft(){
      closePops();
      const pop=$('#cdinftpop'),cur=active()||newSession();
      const pinned=(Store.get().pinnedAgents||[]);
      const artmini=a=>{const anim=a.animation||'';const v=(a.mediaType==='video'||/\.(mp4|webm|mov)(\?|$)/i.test(anim))?safeMediaUrl(anim):'';const i=safeImageUrl((anim&&/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(anim))?anim:(a.image||''));return v?`<video src="${escAttr(v)}" muted></video>`:i?`<img src="${escAttr(i)}">`:'<span></span>'};
      pop.innerHTML='<div class="cdmenu">'+
        `<button data-none="1">No agent · just your model</button>`+
        (pinned.length?pinned.map((a,i)=>`<button data-i="${i}"><span class="cdinftart">${artmini(a)}</span>${escHtml(a.name)}<span class="pv" style="margin-left:auto;font-size:8px;color:var(--ink-faint)">${escHtml(a.collection||'')}</span></button>`).join('')
          :'<div class="qempty" style="padding:9px;font-size:9px;line-height:1.5">No agents pinned yet.<br>Open <b>LAB → Agents</b>, connect your wallet, and ✓ an iNFT to use it here.</div>')+
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
        harnesses.map(h=>`<button data-h="${escAttr(h.id)}" data-n="${escAttr(h.name)}">${escAttr(h.name)}<span class="pv" style="margin-left:auto;font-size:8.5px;color:var(--ink-faint)">${(h.roles||[]).length} agent${(h.roles||[]).length===1?'':'s'}</span><span class="cdhedit" data-edit="${escAttr(h.id)}" title="Edit this harness' crew">✎</span></button>`).join('')+
        `<div class="dv"></div><button data-new="1" style="color:var(--accent)">＋ New harness…</button>`+
        '</div>';
      pop.classList.add('open');
      pop.querySelectorAll('button').forEach(b=>b.addEventListener('click',e=>{
        if(e.target&&e.target.dataset.edit){openEditor(e.target.dataset.edit,true);return}
        if(b.dataset.new){openEditor('__new__',true);return}
        cur.harness=b.dataset.h?{id:b.dataset.h,name:b.dataset.n}:null;saveSt();syncPickers();closePops();
      }));
    }

    /* ----- composer: attachments (+ menu) and dictation (mic) ----- */
    let draftFiles=[];
    function renderChips(){
      const c=$('#cdchips');
      c.innerHTML=draftFiles.map((f,i)=>`<span class="chip">${escHtml(f.name)}<b data-i="${i}">✕</b></span>`).join('');
      c.style.display=draftFiles.length?'':'none';
      c.querySelectorAll('b').forEach(b=>b.addEventListener('click',()=>{draftFiles.splice(+b.dataset.i,1);renderChips()}));
    }
    function pickFiles(dir){
      const inp=document.createElement('input');inp.type='file';inp.multiple=true;if(dir)inp.webkitdirectory=true;
      inp.onchange=async()=>{
        const fs=[...inp.files].slice(0,dir?200:12);
        for(const f of fs){
          let text='';
          if(!dir&&f.size<=65536&&(/text|json|javascript|xml|csv|markdown|html|css/.test(f.type||'')||/\.(txt|md|js|mjs|ts|json|html|css|sh|py|csv|yml|yaml)$/i.test(f.name))){try{text=await f.text()}catch(_){}}
          draftFiles.push({name:f.webkitRelativePath||f.name,text});
        }
        renderChips();
      };
      inp.click();
    }
    const PLUGIN_CATS=['Engineering','Productivity','Design','Marketing','Data','Legal','Sales','Enterprise Search','Frontend design'];
    function popPlus(){
      closePops();
      const pop=$('#cdpluspop');
      pop.innerHTML=`<div class="cdmenu">
        <button data-a="files">📎 Add files or photos<span class="k">⌘U</span></button>
        <button data-a="folder">📁 Add folder</button>
        <button data-a="slash">⌘ Slash commands</button>
        <div class="dv"></div>
        <button data-a="connectors">⛓ Connectors</button>
        <button class="cdsubtrig" data-sub="plugins">◇ Plugins<span class="arw">▸</span></button>
      </div>
      <div class="cdsub" id="cdpluginsub"><div class="cdmenu">
        <div class="hd">PLUGINS</div>
        ${PLUGIN_CATS.map(c=>`<button data-cat="${escAttr(c)}">${escAttr(c)}</button>`).join('')}
        <div class="dv"></div>
        <button data-mng="1">Manage plugins</button>
        <button data-mng="1">Browse plugins</button>
      </div></div>`;
      pop.classList.add('open');
      const sub=pop.querySelector('#cdpluginsub'),trig=pop.querySelector('.cdsubtrig');
      trig.addEventListener('mouseenter',()=>sub.classList.add('open'));
      trig.addEventListener('click',e=>{e.stopPropagation();sub.classList.toggle('open')});
      pop.addEventListener('mouseleave',()=>sub.classList.remove('open'));
      sub.querySelectorAll('[data-cat]').forEach(b=>b.addEventListener('click',()=>{closePops();Toast.show(b.dataset.cat+' plugins — coming soon to the HUB')}));
      sub.querySelectorAll('[data-mng]').forEach(b=>b.addEventListener('click',()=>{closePops();openPanel('settings');setTimeout(()=>{const t=document.querySelector('#setnav [data-sec="tools"]');if(t)t.click()},80)}));
      pop.querySelectorAll('button[data-a]').forEach(b=>b.addEventListener('click',()=>{
        closePops();
        const a=b.dataset.a;
        if(a==='files')pickFiles(false);
        else if(a==='folder')pickFiles(true);
        else if(a==='slash'){const i=$('#cdin');i.value='/'+i.value.replace(/^\//,'');i.focus()}
        else if(a==='connectors')openPanel('integrations');
      }));
    }
    let micDevs=[],micHold=localStorage.getItem('cfhub.micHold')!=='0',micSel=localStorage.getItem('cfhub.mic')||'',rec=null,recOn=false;
    async function popMicMenu(){
      closePops();
      const pop=$('#cdmicpop');
      pop.innerHTML='<div class="cdmenu"><div class="hd">MICROPHONE</div><div class="qempty" style="padding:8px;font-size:9px">requesting access…</div></div>';
      pop.classList.add('open');
      try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());micDevs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput')}catch(_){micDevs=[]}
      pop.innerHTML='<div class="cdmenu"><div class="hd">MICROPHONE</div>'+
        (micDevs.length?micDevs.map(d=>`<button data-d="${escAttr(d.deviceId)}">${escAttr(d.label||'Microphone')}${(micSel?micSel===d.deviceId:d.deviceId==='default')?' <span style="margin-left:auto;color:var(--ok)">✓</span>':''}</button>`).join(''):'<div class="qempty" style="padding:8px;font-size:9px">No microphone access.</div>')+
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
    let streaming=false,sCtl=null;
    function autosize(){const i=$('#cdin');i.style.height='auto';i.style.height=Math.min(i.scrollHeight,120)+'px'}
    let renamingId=null,showArchived=false,ovfEl=null;
    function closeOverflow(){if(ovfEl){ovfEl.remove();ovfEl=null}}
    function beginRename(id){renamingId=id;renderSessions();const inp=$('#cdsess .cdren');if(inp){inp.focus();inp.select()}}
    function forkSession(sess){
      const c=JSON.parse(JSON.stringify(sess));
      c.id='s'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
      c.ts=Date.now();c.archived=false;
      c.title=sess.title.replace(/\s*\(copy\)$/,'')+' (copy)';
      const idx=st.sessions.indexOf(sess);st.sessions.splice(idx<0?0:idx,0,c);
      st.active=c.id;saveSt();renderSessions();renderChat();Toast.show('Session duplicated');
    }
    function exportSession(sess){
      const lines=['# '+sess.title,'',`_${new Date(sess.ts||Date.now()).toISOString()} · model: ${sess.model||'machine'}_`,''];
      (sess.msgs||[]).forEach(m=>{
        if(m.role==='sys'){lines.push('> '+String(m.content||'').replace(/\n/g,'\n> '));lines.push('')}
        else{lines.push(m.role==='user'?'### You':'### Assistant');lines.push('');lines.push(String(m.content||''));lines.push('')}
      });
      const blob=new Blob([lines.join('\n')],{type:'text/markdown'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.rel='noopener';
      a.download=(sess.title.replace(/\W+/g,'_')||'session')+'.md';a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    }
    function deleteSession(id){
      st.sessions=st.sessions.filter(x=>x.id!==id);
      if(st.active===id)st.active=st.sessions[0]?st.sessions[0].id:null;
      if(!st.sessions.length)newSession();
      saveSt();renderSessions();renderChat();
    }
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
        else if(a==='archive'){sess.archived=true;if(st.active===sess.id){const n=st.sessions.find(x=>!x.archived);st.active=n?n.id:null;if(!st.active){newSession()}}saveSt();renderSessions();renderChat()}
        else if(a==='unarchive'){sess.archived=false;saveSt();renderSessions()}
        else if(a==='del')deleteSession(sess.id);
      }));
    }
    function sessRow(x){
      const on=x.id===st.active?'on':'';
      if(renamingId===x.id)
        return `<div class="cdsrow ${on}" data-id="${x.id}"><input class="cdren" value="${escAttr(x.title)}" maxlength="60" data-id="${x.id}"></div>`;
      return `<div class="cdsrow ${on}" data-id="${x.id}"><span>${escHtml(x.title)}</span><button class="dots" data-ov="${x.id}" title="Session options">⋮</button></div>`;
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
      box.querySelectorAll('.cdsrow').forEach(r=>{
        r.addEventListener('click',e=>{if(e.target.closest('.dots')||e.target.closest('.cdren'))return;st.active=r.dataset.id;saveSt();renderSessions();renderChat()});
        r.addEventListener('dblclick',e=>{if(e.target.closest('.cdren'))return;beginRename(r.dataset.id)});
      });
    }
    function renderChat(){
      const cur=active();
      $('#cdtitle').textContent=cur?cur.title:'New session';
      const tr=$('#cdtrans');
      if(!cur||!cur.msgs.length){
        tr.innerHTML=`<div class="cdwelcome"><div class="cwbrand">&lt;/&gt; CODE</div><div class="cwsub">Yours to command.</div><div class="cwtip">Talk to your model in natural language. Pick the model and the harness below — or open the real terminal ( ❯_ ), the diff ( ⧉ ) and the web browser on the right.</div></div>`;
      }else{
        tr.innerHTML=cur.msgs.map(m=>m.role==='sys'?`<div class="cdmsg sys">${escHtml(m.content)}</div>`:`<div class="cdmsg ${m.role==='user'?'user':'ai'}">${m.role==='user'?escHtml(m.content):MDLite.render(m.content||'…')}</div>`).join('');
      }
      tr.scrollTop=tr.scrollHeight;
      syncPickers();
    }
    /* ---- AGENT MODE in CODE: the model drives the app + machine through tools (permission-gated) ---- */
    let cmode=localStorage.getItem('cfhub.code.mode')||'chat';
    const trunc=(x,n)=>{x=String(x);return x.length>n?x.slice(0,n)+'…':x};
    const AGENT_PANELS='email,terminal,harness,lab,machine,tasks,approval,contacts,integrations,notes,library,cookbook,research,gallery,compare,calendar,reminders,brain,search,browser,settings,automations,agents,theme';
    function parseToolCalls(text){const out=[],re=/```tool\s*([\s\S]*?)```/g;let m;while((m=re.exec(text))){try{const o=JSON.parse(m[1].trim());if(o&&o.name)out.push({name:o.name,args:o.args||{}})}catch(_){}}
      // safety net: a tool block whose closing ``` fence never arrived (model closed the JSON but not the fence) — recover a brace-balanced object
      if(!out.length){const i=text.lastIndexOf('```tool');if(i>=0){const seg=text.slice(i+7),s=seg.indexOf('{');if(s>=0){let d=0,end=-1,inStr=false,esc=false;for(let k=s;k<seg.length;k++){const c=seg[k];if(esc){esc=false;continue}if(c==='\\'){esc=true;continue}if(c==='"'){inStr=!inStr;continue}if(inStr)continue;if(c==='{')d++;else if(c==='}'&&--d===0){end=k;break}}if(end>=0){try{const o=JSON.parse(seg.slice(s,end+1));if(o&&o.name)out.push({name:o.name,args:o.args||{}})}catch(_){}}}}}
      return out}
    function inftContext(){
      const cur=active();
      const a=cur&&cur.inft;
      if(!a||!a.name)return'';
      return ` You are speaking AS the owner's agent iNFT "${a.name}"${a.collection?' ('+a.collection+')':''} — token #${a.tokenId}. Embody it; hard limits: never move value without the OWNER gate; BYOK, no secrets on the client.`;
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
      if(cur&&cur.harness&&cur.harness.name){const hd=harnesses.find(x=>x.id===cur.harness.id);h='\nActive HARNESS: '+cur.harness.name+(hd&&hd.roles?' — roles: '+hd.roles.map(r=>r.name).join(', '):'')+'. Respect the gates (SAFETY fail-closed veto, OWNER approves the irreversible).'}
      return `You are the model the owner connected to CLONE FRAME, running INSIDE their app with a REAL body on this machine through the HUB Bridge.${inftContext()} You are NOT a text-only assistant — you have TOOLS and you CAN act on the app, the machine, and the owner's online servers. To act, emit ONE json block per action, exactly like this:\n\`\`\`tool\n{"name":"open_app","args":{"app":"Calculator"}}\n\`\`\`\nTOOLS: open_panel{panel} (open a HUB tab — one of: ${AGENT_PANELS}); open_settings{section} (open Settings at a section: agent · models · appearance · folders · servers · account); open_terminal{cwd?,newWindow?} (open a live terminal in the app; newWindow:true opens a SEPARATE terminal window — e.g. one per agent, side by side); open_app{app} (open ANY macOS app by name); open_path{path} (reveal ANY file/folder in Finder); open_url{url}; applescript{script} (automate macOS & control apps); run_shell{cmd} (REAL zsh — install, build, move files, anything); web_search{q}; browse{url,newTab?,newWindow?} (opens a live rendered web tab AND returns the page text; newTab:true adds a tab, newWindow:true opens a SEPARATE browser window on the canvas — use several newWindow calls to research side-by-side); read_file{path}; write_file{path,content}; send_email{to,subject,body}; server_list{}; server_run{id,cmd} (run a command on an online server/droplet over SSH); server_automation{id,key} (one-click preset: status·start_agent·stop_agent·restart_agent·agent_logs·update·reboot); server_deploy{id,name} (send an agent to the server); server_provision{name,region,size} (create a NEW droplet in the owner's DigitalOcean account); list_harnesses{}; create_harness{name,description,roles:[{name,desc,gate}]} (build a crew of agents); update_harness{id,name,description,roles}; use_harness{id} (activate a harness for this CODE session). HARNESS ENGINE pattern — a harness is a crew: one ORCHESTRATOR that delegates, the non-collapsible GATES (SAFETY/HACKER, EVALUATOR, TREASURY, OWNER — set gate:true) that nothing irreversible passes without, and the specialist agents the task needs (gate:false, e.g. RESEARCH, ANALYST, DELIVERY). When the owner asks you to create/build a harness, design that crew and call create_harness; then tell them it's in the HARNESS tab and the CODE picker.${capLine}${needLine}${modeLine} Your full field guide — every tool, panel, the iT 'it' CLI, how to edit the frame, how to contribute upstream — lives at ~/.clone-frame-hub/AGENTS.md; read_file it (or run 'it context' in an iT shell) when you need depth. Rules: emit the tools you need, then STOP and wait for the RESULTS (I send them back); only then continue or give the final answer WITHOUT tool blocks. NEVER say you can't act or that you're just a text model — you have a body here. If a tool returns REFUSED, name the exact toggle that unlocks it and offer to open_settings for the owner. Never invent results. Owner permissions (raw JSON): ${JSON.stringify(perms)}.${h}`;
    }
    async function execTool(c,perms){
      const a=c.args||{};
      const full=perms.machineControl||perms.fullAccess; // master switch OR full app access
      const shq=s=>"'"+String(s).replace(/'/g,"'\\''")+"'"; // POSIX single-quote: neutralizes $ ` \ $() etc. so paths/urls can't inject shell
      try{
        if(c.name==='open_panel'){const t=String(a.panel||'').trim();if(!t)return 'no panel';openPanel(t);return 'opened HUB tab: '+t} // opening an in-app tab is harmless — never gated
        if(c.name==='open_terminal'){const cwd=String(a.cwd||'').trim();const wasOpen=instancesOf('shell').length>0;if(cwd)pendingShellCwd=cwd;openPanel('shell',{newInstance:!!a.newWindow});if(cwd&&wasOpen&&!a.newWindow)Bus.emit('shell:addcwd',cwd);return 'opened iT — live terminal '+(a.newWindow?'window':'')+(cwd?' at '+cwd:'')}
        if(c.name==='open_settings'){const sec=String(a.section||'').trim().toLowerCase();openPanel('settings');const map={agent:'agenttools',agenttools:'agenttools',permissions:'agenttools',it:'itterm',itterm:'itterm','it terminal':'itterm',tools:'tools',models:'addmodels',addmodels:'addmodels','add models':'addmodels',added:'added',aidefaults:'aidefaults',appearance:'appearance',theme:'appearance',account:'account',folders:'folders',servers:'servers','online server':'servers',system:'system',email:'email',integrations:'integrations',reminders:'reminders',search:'search'};const key=map[sec]||sec||'agenttools';setTimeout(()=>{const b=document.querySelector('#setnav [data-sec="'+key+'"]');if(b)b.click()},80);return 'opened Settings → '+key}
        if(c.name==='open_app'){if(!full)return 'REFUSED — enable "Full machine control" in Settings → Agent Tools';const app=String(a.app||'').trim();if(!app)return 'no app name';let out='';const m=await Bridge.shell('open -a '+shq(app),tk=>{out+=tk});return (m&&m.exit===0)?('opened app: '+app):('could not open "'+app+'" '+trunc(out,120))}
        if(c.name==='open_path'){if(!full)return 'REFUSED — enable "Full machine control"';const pth=String(a.path||'').trim();if(!pth)return 'no path';let out='';const m=await Bridge.shell('open '+shq(pth),tk=>{out+=tk});return (m&&m.exit===0)?('opened in Finder: '+pth):('could not open "'+pth+'" '+trunc(out,120))}
        if(c.name==='open_url'){if(!full)return 'REFUSED — enable "Full machine control"';const u=String(a.url||'');if(!/^https?:\/\//i.test(u))return 'url must start with http(s)://';await Bridge.shell('open '+shq(u),()=>{});return 'opened: '+u}
        if(c.name==='applescript'){if(!full)return 'REFUSED — enable "Full machine control"';const scr=String(a.script||'');if(!scr)return 'no script';let out='';const m=await Bridge.shell('osascript '+scr.split('\n').map(l=>'-e '+shq(l)).join(' '),tk=>{out+=tk});return trunc((out||'(done)')+(m&&m.exit!=null&&m.exit!==0?' [exit '+m.exit+']':''),1200)}
        if(c.name==='run_shell'){if(!full)return 'REFUSED — enable "Full machine control"';let out='';const m=await Bridge.shell(String(a.cmd||''),tk=>{out+=tk});return trunc((out||'(no output)')+(m&&m.exit!=null?' [exit '+m.exit+']':''),1500)}
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
        return 'unknown tool: '+c.name;
      }catch(e){return 'error: '+e.message}
    }
    // one streamed turn routed to the session's model (provider / machine)
    async function codeStream(cur,messages,onTok,signal,opts){
      const mv=cur.model||'';
      if(mv.includes('::')){const k=mv.indexOf('::');return Bridge.providerChat(mv.slice(0,k),mv.slice(k+2),messages,onTok,signal,opts)}
      if(Bridge.brainReady())return Bridge.chat(messages,onTok,signal,opts);
      throw new Error('Connect the HUB Bridge (MY MACHINE) and pick a model below.');
    }
    async function agentRun(cur){
      let perms={};try{perms=await RPC('permissions','get')}catch(_){}
      const sys0=await buildAgentSystem(perms,cur,cmode);
      let convo=cur.msgs.filter(m=>(m.role==='user'||m.role==='ai')&&String(m.raw||m.content||'').trim()).map(m=>({role:m.role==='ai'?'assistant':'user',content:m.raw||m.content})); // drop empties (aborted turns) → no Anthropic 400
      let steps=0;
      while(steps++<6&&!sCtl.signal.aborted){
        const bot={role:'ai',content:''};cur.msgs.push(bot);saveSt();
        await renderChat();
        const tr=$('#cdtrans'),els=tr?tr.querySelectorAll('.cdmsg.ai'):[],botEl=els.length?els[els.length-1]:null;
        let acc='';
        try{const rr=await codeStream(cur,convo,tk=>{acc+=tk;bot.content=acc.replace(/```tool[\s\S]*?```/g,'').replace(/```tool[\s\S]*$/,'').trim();if(botEl)botEl.innerHTML=MDLite.render(bot.content||'…');if(tr)tr.scrollTop=tr.scrollHeight},sCtl.signal,{system:sys0,max_tokens:4096});if(rr&&rr.err)acc+=(acc?'\n':'')+'⚠ '+rr.err}
        catch(e){if(e.name!=='AbortError'&&!/abort/i.test(e.message||''))acc+='\n⚠ '+e.message}
        const calls=parseToolCalls(acc);
        bot.content=acc.replace(/```tool[\s\S]*?```/g,'').replace(/```tool[\s\S]*$/,'').trim()||(calls.length?'*(using tools…)*':acc);
        bot.raw=acc;saveSt();
        convo.push({role:'assistant',content:acc});
        if(!calls.length)break;
        const results=[];
        for(const c of calls){
          const r=await execTool(c,perms);
          results.push(c.name+' → '+trunc(String(r),900));
          cur.msgs.push({role:'sys',content:'⚙ '+c.name+' '+trunc(JSON.stringify(c.args),70)+' → '+trunc(String(r),140)});
        }
        bot.raw=acc+'\n\n<tool_results>\n'+results.join('\n')+'\n</tool_results>'; // persist results in raw → a follow-up turn sees them and won't re-run the tools
        saveSt();await renderChat();
        convo.push({role:'user',content:'TOOL RESULTS:\n'+results.join('\n\n')+'\n\nContinue (more tools) or give the final answer without tool blocks.'});
      }
    }
    async function send(){
      const inp=$('#cdin');let text=(inp.value||'').trim();
      if((!text&&!draftFiles.length)||streaming)return;
      let cur=active();if(!cur){cur=newSession();renderSessions()}
      if(text==='/clear'){cur.msgs=[];saveSt();renderChat();inp.value='';autosize();return}
      if(text==='/model'){inp.value='';popModels();return}
      if(text==='/harness'){inp.value='';popHarness();return}
      if(text==='/help'){cur.msgs.push({role:'ai',content:'**Commands:** `/clear` · `/model` · `/harness` · `/help`\n\nUse ❯_ for the real terminal, ⧉ for the diff, and the globe for the web.'});saveSt();renderChat();inp.value='';autosize();return}
      if(draftFiles.length){
        const ctx=draftFiles.map(f=>f.text?('```'+f.name+'\n'+f.text+'\n```'):('[attached: '+f.name+']')).join('\n');
        text=(ctx+'\n\n'+text).trim();draftFiles=[];renderChips();
      }
      if(cur.title==='New session'&&text){cur.title=text.slice(0,34)+(text.length>34?'…':'');renderSessions()}
      cur.msgs.push({role:'user',content:text});cur.ts=Date.now();
      // Whenever the bridge is connected the model is tool-capable — in BOTH Chat and
      // Agent modes. Chat acts when you ask it to; Agent is proactive. (Fixes "I'm just a
      // text assistant, I can't open apps".) Plain chat only when there's no bridge/body.
      if(Bridge.on()){
        inp.value='';autosize();saveSt();
        streaming=true;sCtl=new AbortController();$('#cdsend').textContent='■';
        try{await agentRun(cur)}catch(_){}
        streaming=false;sCtl=null;const sb=$('#cdsend');if(sb)sb.textContent='↑';saveSt();await renderChat();
        return;
      }
      const bot={role:'ai',content:''};cur.msgs.push(bot);saveSt();
      inp.value='';autosize();renderChat();
      const tr=$('#cdtrans'),botEl=tr.lastChild;
      streaming=true;sCtl=new AbortController();$('#cdsend').textContent='■';
      const onTok=t=>{bot.content+=t;if(botEl)botEl.innerHTML=MDLite.render(bot.content);tr.scrollTop=tr.scrollHeight};
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
        if(mv.includes('::')){const k=mv.indexOf('::');rr=await Bridge.providerChat(mv.slice(0,k),mv.slice(k+2),histM,onTok,sCtl.signal,{system:sys})}
        else if(Bridge.brainReady()){rr=await Bridge.chat(histM,onTok,sCtl.signal,{system:sys})}
        else bot.content='Connect the HUB Bridge (MY MACHINE) and pick a model below.';
        if(rr&&rr.err)bot.content+=(bot.content?'\n':'')+'⚠ '+rr.err; // surface stream errors (bad key / model) instead of a stuck "…"
      }catch(e){if(e.name!=='AbortError'&&!/abort/i.test(e.message||''))bot.content+=(bot.content?'\n':'')+'⚠ '+e.message}
      streaming=false;sCtl=null;$('#cdsend').textContent='↑';saveSt();
      if(botEl)botEl.innerHTML=MDLite.render(bot.content||'(empty)');
    }

    /* ----- wiring ----- */
    if(!st.sessions.length)newSession();
    if(!st.active||!active())st.active=st.sessions[0].id;
    $('#cdnew').addEventListener('click',()=>{newSession();renderSessions();renderChat()});
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
    const cdin=$('#cdin');
    cdin.addEventListener('input',autosize);
    cdin.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='u'){e.preventDefault();pickFiles(false);return}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
    $('#cdsend').addEventListener('click',()=>streaming?(sCtl&&sCtl.abort()):send());
    p.addEventListener('pointerdown',e=>{if(!e.target.closest('.cdpop')&&!e.target.closest('.cdovf')&&!e.target.closest('.dots')&&!e.target.closest('#cdmodel')&&!e.target.closest('#cdinft')&&!e.target.closest('#cdharness')&&!e.target.closest('#cdplus')&&!e.target.closest('#cdmic')&&!e.target.closest('#cdmiccfg'))closePops()});
    const zs=zselW();zs.value=theme;
    zs.addEventListener('change',()=>{theme=zs.value;localStorage.setItem('cfhub.zsh',theme);if(pane==='term')renderShell()});
    $('#cdpanebody').addEventListener('click',e=>{if(pane==='term'&&!e.target.closest('input'))$('#cdpanebody').querySelector('#tin')?.focus()});
    function syncBridge(){const inf=Bridge.info();if(inf){host='local';if(inf.cwd){cwd=relCwd(inf.cwd);cwdAbs=inf.cwd;}refreshBranch().then(()=>{if(pane==='term'&&!busy)renderShell()});Tree.onCwd();}}
    panelBus(p).on('bridge:changed',()=>{syncBridge();loadModels();loadHarnesses();if(pane==='term'&&!busy)renderShell()});
    // web:open is handled solely by the standalone BROWSER (research panel) now — see webOpen()/wireWebBrowser. Kept single-sink to avoid double-open.
    panelBus(p).on('models:changed',()=>{loadModels()});
    panelBus(p).on('harness:changed',()=>{loadHarnesses().then(()=>{if($('#cdharnesspop')&&$('#cdharnesspop').classList.contains('open'))popHarness()})}); // a new/edited harness shows up in the picker immediately
    if(Bridge.on()){out('<span class="ok">● REAL shell connected — HUB Bridge</span> <span class="dim">'+escHtml(Bridge.info().cwd||'')+' · type any zsh command · Ctrl+C interrupts</span>');syncBridge()}
    else out('<span class="sys">CLONE FRAME OS · zsh (demo)</span> <span class="dim">— connect the HUB Bridge in MY MACHINE for a REAL shell on your machine.</span> type <span class="kw">help</span>');
    renderSessions();renderChat();loadModels();loadHarnesses();
  }
