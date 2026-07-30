  function wireFolders(p){
    const treeEl=p.querySelector('#fmtree'),barEl=p.querySelector('#fmbar'),areaEl=p.querySelector('#fmarea'),splitEl=p.querySelector('#fmsplit');
    if(!areaEl)return;
    const fmtB=b=>b==null?'':b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(1)+' MB';
    const base=s=>{s=String(s||'').replace(/\/+$/,'');const i=s.lastIndexOf('/');return i>=0?s.slice(i+1):s};
    const parent=s=>{s=String(s||'').replace(/\/+$/,'');const i=s.lastIndexOf('/');return i>0?s.slice(0,i):'/'};
    const join=(a,b)=>String(a).replace(/\/+$/,'')+'/'+b;
    const qp=s=>'"'+String(s).replace(/"/g,'')+'"';
    let homeAbs='~',cfRoot='',cwd='',viewing=null,treeHidden=false,creating=null;
    const tree={open:new Set()};
    // `.catch(()=>null)` used to throw away WHY, and the caller then guessed: every failure —
    // including "there is no daemon" — was reported as "This folder may be protected or
    // unreadable." A permissions story about a folder the app never even asked for. Keep the
    // exception so the caller can tell a transport failure from a real filesystem one.
    async function ls(dir){
      let r;
      try{r=await RPC('files','list',dir)}catch(e){return{ok:false,transport:e,err:(e&&e.message)||'cannot read',entries:[]}}
      if(!r||!r.ok)return{ok:false,err:(r&&r.error)||'cannot read',entries:[]};
      const e=(r.entries||[]).filter(x=>!x.name.startsWith('.'));
      e.sort((a,b)=>((a.type==='dir')===(b.type==='dir'))?a.name.localeCompare(b.name):(a.type==='dir'?-1:1));
      return{ok:true,entries:e};
    }

    // ---------- breadcrumb + toolbar ----------
    function renderBar(){
      const parts=String(cwd).split('/').filter(Boolean);let acc='';
      const segs=[`<span class="seg" data-p="/">/</span>`];
      parts.forEach((seg,i)=>{acc+='/'+seg;segs.push(`<span class="sep">›</span><span class="seg" data-p="${escAttr(acc)}">${escAttr(seg)}</span>`)});
      barEl.innerHTML=`<button class="fm-act" id="fmtog" title="Folders">▤</button><button class="fm-act" id="fmup" title="Up">↑</button>
        <div class="fm-crumb">${segs.join('')}</div>
        <button class="fm-act acc" id="fmnewf"><svg><use href="#i-folder"/></svg>Folder</button>
        <button class="fm-act" id="fmnewfile"><svg><use href="#i-file"/></svg>File</button>
        <button class="fm-act" id="fmup2" title="Upload"><svg><use href="#i-file"/></svg>Upload</button>
        <button class="fm-act" id="fmterm" title="Open in iT"><svg><use href="#i-term2"/></svg></button>
        <button class="fm-act" id="fmrev" title="Reveal in Finder">⤢</button>
        <button class="fm-act" id="fmref" title="Refresh">↻</button>`;
      barEl.querySelectorAll('.seg').forEach(s=>s.addEventListener('click',()=>go(s.dataset.p)));
      barEl.querySelector('#fmtog').addEventListener('click',()=>{treeHidden=!treeHidden;treeEl.classList.toggle('hidden',treeHidden);splitEl.style.display=treeHidden?'none':''});
      barEl.querySelector('#fmup').addEventListener('click',()=>{const pr=parent(cwd);if(pr&&pr!==cwd)go(pr)});
      barEl.querySelector('#fmnewf').addEventListener('click',()=>startCreate('dir'));
      barEl.querySelector('#fmnewfile').addEventListener('click',()=>startCreate('file'));
      barEl.querySelector('#fmup2').addEventListener('click',()=>pickUpload());
      barEl.querySelector('#fmterm').addEventListener('click',()=>{pendingShellCwd=cwd;openPanel('shell')});
      barEl.querySelector('#fmrev').addEventListener('click',()=>{if(Bridge.on())Bridge.shell('open '+qp(cwd),()=>{});Toast.show('Opening '+base(cwd)+' in Finder')});
      barEl.querySelector('#fmref').addEventListener('click',()=>{renderList();renderTree()});
    }

    // ---------- contents list ----------
    async function renderList(){
      viewing=null;renderBar();
      areaEl.innerHTML='<div class="fm-empty">Loading…</div>';
      const r=await ls(cwd);
      // A transport failure is not a folder problem. showErr() already knows how to say
      // "not connected to this machine" and how to route the owner to MY MACHINE; the
      // permissions sentence belongs only to a folder the daemon actually looked at and
      // refused. Guessing the second when it was the first is the app inventing a reason.
      if(!r.ok&&r.transport){showErr(areaEl,r.transport);return}
      if(!r.ok){areaEl.innerHTML=`<div class="fm-empty">${escHtml(r.err)}<br><span class="dim">This folder may be protected or unreadable.</span></div>`;return}
      const rows=r.entries.map(e=>{
        const full=join(cwd,e.name),isDir=e.type==='dir';
        return `<div class="fm-row ${isDir?'dir':'file'}" data-name="${escAttr(e.name)}" data-dir="${isDir?1:0}" draggable="true">
          <svg class="ic"><use href="${isDir?'#i-folder':'#i-file'}"/></svg>
          <span class="nm">${escHtml(e.name)}</span>
          <span class="sz">${isDir?'':fmtB(e.size)}</span>
          <span class="acts">
            <button class="fm-mini" data-act="open" title="${isDir?'Open':'Open file'}">↵</button>
            <button class="fm-mini" data-act="rename" title="Rename">✎</button>
            ${isDir?'':'<button class="fm-mini" data-act="dup" title="Duplicate">⧉</button>'}
            <button class="fm-mini" data-act="reveal" title="Reveal in Finder">⤢</button>
            <button class="fm-mini warn" data-act="del" title="Delete">🗑</button>
          </span>
        </div>`;
      }).join('');
      areaEl.innerHTML=`<div class="fm-list" id="fmlist">${creating?createRowHTML():''}${rows||(creating?'':'<div class="fm-empty">This folder is empty.<br><span class="dim">Use ＋Folder / ＋File above, or drag files here from Finder.</span></div>')}</div>`;
      if(creating)wireCreateRow();
      areaEl.querySelectorAll('.fm-row').forEach(row=>{
        const name=row.dataset.name,isDir=row.dataset.dir==='1',full=join(cwd,name);
        row.querySelector('.nm').addEventListener('click',()=>isDir?go(full):openFile(full));
        row.addEventListener('dblclick',()=>isDir?go(full):openFile(full));
        row.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();rowAction(b.dataset.act,full,name,isDir,row)}));
        // drag to move
        row.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/cfpath',full);e.dataTransfer.effectAllowed='move'});
        if(isDir){
          row.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('text/cfpath')){e.preventDefault();row.classList.add('dragover')}});
          row.addEventListener('dragleave',()=>row.classList.remove('dragover'));
          row.addEventListener('drop',async e=>{e.preventDefault();e.stopPropagation();row.classList.remove('dragover');const src=e.dataTransfer.getData('text/cfpath');if(src&&src!==full)await doMove(src,full)});
        }
      });
    }
    function createRowHTML(){return `<div class="fm-row ${creating==='dir'?'dir':'file'}"><svg class="ic"><use href="${creating==='dir'?'#i-folder':'#i-file'}"/></svg><span class="nm"><input id="fmnewinp" placeholder="${creating==='dir'?'new-folder':'new-file.txt'}" spellcheck="false"></span></div>`}
    function wireCreateRow(){const inp=areaEl.querySelector('#fmnewinp');if(!inp)return;setTimeout(()=>inp.focus(),20);
      const done=async(commit)=>{const nm=inp.value.trim();const kind=creating;creating=null;if(!commit||!nm){renderList();return}
        // noClobber: this row means "make a new file". Without it, typing the name of a file
        // that already exists wrote '' over it — 0 bytes, no confirmation, no undo — under
        // the toast "File created". And the name commits on BLUR, so clicking away was enough.
        const dest=join(cwd,nm);const r=kind==='dir'?await RPC('files','mkdir',dest):await RPC('files','write',dest,'',{noClobber:true});
        if(r&&r.ok){Toast.show((kind==='dir'?'Folder':'File')+' created');renderTree()}else Toast.show('Failed: '+((r&&r.error)||''));renderList()};
      inp.addEventListener('keydown',e=>{if(e.key==='Enter')done(true);else if(e.key==='Escape')done(false)});
      inp.addEventListener('blur',()=>done(true));
    }
    function startCreate(kind){creating=kind;renderList()}
    async function rowAction(act,full,name,isDir,row){
      if(act==='open')return isDir?go(full):openFile(full);
      if(act==='reveal'){if(Bridge.on())Bridge.shell('open '+qp(full),()=>{});return Toast.show('Revealing '+name)}
      if(act==='dup'){const m=name.match(/^(.*?)(\.[^.]+)?$/);const nn=join(cwd,(m[1]||name)+' copy'+(m[2]||''));const r=await RPC('files','copy',full,nn);Toast.show(r&&r.ok?'Duplicated':'Failed: '+((r&&r.error)||''));renderList();return}
      if(act==='rename'){const nmEl=row.querySelector('.nm');nmEl.innerHTML=`<input id="fmren" value="${escAttr(name)}" spellcheck="false">`;const inp=nmEl.querySelector('#fmren');inp.focus();inp.select();
        const commit=async(ok)=>{const nv=inp.value.trim();if(!ok||!nv||nv===name){renderList();return}const r=await RPC('files','move',full,join(cwd,nv));Toast.show(r&&r.ok?'Renamed':'Failed: '+((r&&r.error)||''));renderTree();renderList()};
        inp.addEventListener('keydown',e=>{if(e.key==='Enter')commit(true);else if(e.key==='Escape')commit(false)});inp.addEventListener('blur',()=>commit(true));return}
      if(act==='del'){const btn=row.querySelector('[data-act="del"]');if(btn.dataset.armed){const r=await RPC('files','remove',full);Toast.show(r&&r.ok?'Deleted '+name:'Failed: '+((r&&r.error)||''));renderTree();renderList()}else{btn.dataset.armed='1';btn.textContent='?';btn.title='Click again to delete — this cannot be undone';setTimeout(()=>{if(btn.isConnected){btn.removeAttribute('data-armed');btn.textContent='🗑'}},2500)}return}
    }
    async function doMove(src,destDir){const r=await RPC('files','move',src,destDir);if(r&&r.ok){Toast.show('Moved '+base(src)+' → '+base(destDir))}else Toast.show('Move failed: '+((r&&r.error)||''));renderTree();renderList()}

    function openFile(full){viewing=full;openFileView(areaEl,full,{cwd,onBack:()=>renderList(),onSave:()=>{}})}

    // ---------- OS drag-and-drop upload ----------
    areaEl.addEventListener('dragover',e=>{if(e.dataTransfer&&Array.from(e.dataTransfer.types||[]).includes('Files')){e.preventDefault();areaEl.classList.add('drop')}});
    areaEl.addEventListener('dragleave',e=>{if(e.target===areaEl)areaEl.classList.remove('drop')});
    areaEl.addEventListener('drop',async e=>{const files=e.dataTransfer&&e.dataTransfer.files;if(!files||!files.length)return;e.preventDefault();areaEl.classList.remove('drop');await uploadFiles(files)});
    function pickUpload(){const inp=document.createElement('input');inp.type='file';inp.multiple=true;inp.style.display='none';document.body.appendChild(inp);inp.addEventListener('change',async()=>{if(inp.files&&inp.files.length)await uploadFiles(inp.files);inp.remove()});inp.click()}
    async function uploadFiles(files){
      if(viewing)renderList();
      let ok=0;for(const f of Array.from(files)){
        if(f.size>25*1024*1024){Toast.show('Skipped '+f.name+' (>25MB)');continue}
        const b64=await new Promise(res=>{const rd=new FileReader();rd.onload=()=>res(String(rd.result).split(',')[1]||'');rd.onerror=()=>res(null);rd.readAsDataURL(f)});
        if(b64==null)continue;const r=await RPC('files','writeB64',join(cwd,f.name),b64);if(r&&r.ok)ok++;else Toast.show('Upload failed: '+f.name+' — '+((r&&r.error)||''));
      }
      if(ok)Toast.show('Uploaded '+ok+' file'+(ok===1?'':'s'));renderTree();renderList();
    }

    // ---------- folder tree (dirs only) ----------
    async function renderTree(){
      treeEl.innerHTML=`<div class="sh-thead"><b>${escHtml(base(cfRoot)||'CloneFrame')}</b><span class="sh-thome" id="fmthome" title="CloneFrame">⌂</span><span class="sh-thome" id="fmthomeH" title="Home">~</span></div><div id="fmtl"></div>`;
      treeEl.querySelector('#fmthome').addEventListener('click',()=>go(cfRoot||homeAbs));
      treeEl.querySelector('#fmthomeH').addEventListener('click',()=>go(homeAbs));
      await drawTree(treeEl.querySelector('#fmtl'),cfRoot||homeAbs,0);
    }
    async function drawTree(container,dir,depth){
      const r=await ls(dir);
      for(const e of r.entries){if(e.type!=='dir')continue;const full=join(dir,e.name);
        const row=document.createElement('div');row.className='sh-trow dir'+(cwd===full?' here':'');row.style.paddingLeft=(6+depth*11)+'px';
        row.innerHTML=`<span class="sh-tchev ${tree.open.has(full)?'open':''}">▸</span><svg class="sh-tic"><use href="#i-folder"/></svg><span class="sh-tname">${escHtml(e.name)}</span>`;
        container.appendChild(row);
        row.querySelector('.sh-tchev').addEventListener('click',ev=>{ev.stopPropagation();if(tree.open.has(full))tree.open.delete(full);else tree.open.add(full);renderTree()});
        row.querySelector('.sh-tname').addEventListener('click',()=>go(full));
        // accept drops (move into this tree folder)
        row.addEventListener('dragover',ev=>{if(ev.dataTransfer.types.includes('text/cfpath')){ev.preventDefault();row.classList.add('here')}});
        row.addEventListener('drop',async ev=>{ev.preventDefault();const src=ev.dataTransfer.getData('text/cfpath');if(src&&src!==full)await doMove(src,full)});
        if(tree.open.has(full)){const sub=document.createElement('div');container.appendChild(sub);await drawTree(sub,full,depth+1)}
      }
    }
    function expandTo(dir){const rootA=cfRoot||homeAbs;if(!dir||!(dir===rootA||dir.startsWith(rootA+'/')))return;let cur=rootA;dir.slice(rootA.length).split('/').filter(Boolean).forEach(s=>{cur=join(cur,s);tree.open.add(cur)})}

    function go(dir){cwd=dir;creating=null;expandTo(dir);renderList();renderTree()}

    // ---------- splitter ----------
    (()=>{let w=parseInt(localStorage.getItem('cfhub.fm.treew')||'212',10)||212;treeEl.style.width=w+'px';
      splitEl.addEventListener('pointerdown',e=>{e.preventDefault();splitEl.classList.add('drag');const r=p.querySelector('.fm').getBoundingClientRect();
        const mm=ev=>{let nw=Math.max(150,Math.min(ev.clientX-r.left,r.width-320));treeEl.style.width=nw+'px'};
        const mu=()=>{removeEventListener('pointermove',mm);removeEventListener('pointerup',mu);splitEl.classList.remove('drag');localStorage.setItem('cfhub.fm.treew',String(parseInt(treeEl.style.width,10)||212))};
        addEventListener('pointermove',mm);addEventListener('pointerup',mu)});
    })();

    // ---------- boot ----------
    (async()=>{
      if(Bridge.on()){try{let o='';const m=await Bridge.shell('pwd',x=>{o+=x});homeAbs=(m&&m.cwd)||o.trim()||'~'}catch(_){homeAbs='~'}
        try{const fr=await RPC('folders','root');if(fr&&fr.ok)cfRoot=fr.root}catch(_){}}
      cwd=cfRoot||homeAbs;expandTo(cwd);renderList();renderTree();
    })();
    panelBus(p).on('bridge:changed',()=>{if(Bridge.on()&&(homeAbs==='~'||!cfRoot)){(async()=>{try{let o='';const m=await Bridge.shell('pwd',x=>{o+=x});homeAbs=(m&&m.cwd)||o.trim()||'~';const fr=await RPC('folders','root');if(fr&&fr.ok)cfRoot=fr.root;if(!cwd||cwd==='~')cwd=cfRoot||homeAbs;expandTo(cwd);renderList();renderTree()}catch(_){}})()}});
  }
