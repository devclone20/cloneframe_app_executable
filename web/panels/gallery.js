  function wireGallery(p){
    const view=p.querySelector('#glview'),countEl=p.querySelector('#glcount');
    const S=Store.get();S.gallery=Object.assign({albums:[],favs:[]},S.gallery);const G=S.gallery;
    let items=[],tab='photos',fav=false,src='all',sort='random',q='',sel=null;
    const thumbs={},rnd={},rrank=id=>rnd[id]??(rnd[id]=Math.random());
    const setCount=()=>{countEl.textContent=items.length+(items.length===1?' photo':' photos')};
    async function refresh(){try{items=await RPC('gallery','list');G.favs=G.favs.filter(id=>items.some(i=>i.id===id));Store.save()}catch(e){items=[]}setCount()}
    function thumb(cell){const id=cell.dataset.id;if(thumbs[id]){cell.querySelector('img').src=thumbs[id];return}
      RPC('gallery','get',id).then(d=>{if(d&&d.dataUri){thumbs[id]=d.dataUri;const im=cell.querySelector('img');if(im)im.src=d.dataUri}}).catch(()=>{})}
    function visible(){let v=items.filter(i=>src==='all'||((i.tags||[]).includes('generated')?src==='generated':src==='imported'));
      if(fav)v=v.filter(i=>G.favs.includes(i.id));
      if(q)v=v.filter(i=>((i.prompt||'')+' '+(i.tags||[]).join(' ')).toLowerCase().includes(q));
      if(sort==='newest')v.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      else if(sort==='oldest')v.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
      else if(sort==='name')v.sort((a,b)=>String(a.prompt||'').localeCompare(String(b.prompt||'')));
      else v.sort((a,b)=>rrank(a.id)-rrank(b.id));
      return v}
    function addFiles(fl,done){const files=[...fl].filter(f=>f.type.startsWith('image/'));
      if(!files.length){Toast.show('Images only');return}
      let n=0;files.forEach(f=>{const rd=new FileReader();rd.onload=async()=>{
        const b64=String(rd.result).split(',')[1];
        const r=await RPC('gallery','add',{prompt:f.name,mimeType:f.type,contentBase64:b64});
        if(!r.ok)Toast.show(r.error||'import failed');
        if(++n===files.length){Toast.show('Imported');await refresh();done()}};rd.readAsDataURL(f)})}
    function imgConfig(back){view.innerHTML=`<div class="acctform"><div class="afh">Image provider (BYOK)</div><div class="af-row"><label>Provider</label><select id="ipp"><option value="openai">OpenAI (gpt-image-1)</option><option value="stability">Stability</option></select></div><div class="af-row"><label>API key</label><input id="ipk" type="password"></div><div class="compose-actions"><button class="btn" id="ipsave">SAVE</button><button class="btn" id="ipcancel">← back</button></div></div>`;
      RPC('images','providers').then(ps=>{const s=view.querySelector('#ipp');if(Array.isArray(ps)&&ps.length&&s)s.innerHTML=ps.map(x=>`<option value="${escAttr(x.id)}">${escAttr(x.label)}</option>`).join('')}).catch(()=>{});
      view.querySelector('#ipsave').addEventListener('click',async()=>{const r=await RPC('images','config',{provider:view.querySelector('#ipp').value,apiKey:view.querySelector('#ipk').value});if(r.ok){Toast.show('Provider configured');back()}else Toast.show(r.error||'failed')});
      view.querySelector('#ipcancel').addEventListener('click',back);}
    function renderPhotos(){
      if(!Bridge.on()){needBridge(view);return}
      view.innerHTML=`<div class="glbar"><input id="glq" placeholder="Search photos, tags…"><select id="glsrc"><option value="all">All sources</option><option value="imported">Imported</option><option value="generated">Generated</option></select><select id="glsort"><option value="random">Random</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option></select><button class="btn mini" id="glselect">Select</button></div><div class="glchips"><button class="glchip" id="glall">All</button><button class="glchip" id="glfavc">♥</button></div><div class="glgenrow"><input id="glprompt" placeholder="describe an image to generate…"><button class="btn mini" id="glgen">generate</button></div><div id="glmsg" style="font-size:10px;padding:2px 0"></div><div id="glgw"></div>`;
      const gw=view.querySelector('#glgw'),qEl=view.querySelector('#glq');
      qEl.value=q;view.querySelector('#glsrc').value=src;view.querySelector('#glsort').value=sort;
      const chips=()=>{view.querySelector('#glall').classList.toggle('on',!fav);view.querySelector('#glfavc').classList.toggle('on',fav)};
      function draw(){const v=visible();
        gw.innerHTML=`${sel?`<div class="glselbar"><span class="dim">${sel.size} selected</span><span style="flex:1"></span><button class="btn mini" id="glalb">+ album</button><button class="btn mini" id="gldel">delete</button><button class="btn mini" id="glselx">✕</button></div>`:''}<div class="glgrid"><div class="gldrop" id="gldrop"><svg class="glupico"><use href="#i-frame"/></svg><span>Upload</span></div>${v.map(i=>{const on=sel&&sel.has(i.id),fv=G.favs.includes(i.id);return `<div class="glcell${on?' glon':''}" data-id="${i.id}"><img alt="${escAttr(i.prompt||'')}">${sel?'':`<button class="btn mini" data-rm="${i.id}">✕</button><button class="glfav${fv?' on':''}" data-fav="${i.id}">♥</button>`}</div>`}).join('')}${v.length?'':'<div class="glhint">No photos yet. Click Upload or drag-and-drop to get started!</div>'}</div>`;
        const drop=gw.querySelector('#gldrop');
        drop.addEventListener('click',()=>{const inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.multiple=true;inp.onchange=()=>addFiles(inp.files,draw);inp.click()});
        drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('glover')});
        drop.addEventListener('dragleave',()=>drop.classList.remove('glover'));
        drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('glover');addFiles(e.dataTransfer.files,draw)});
        gw.querySelectorAll('.glcell').forEach(c=>{thumb(c);c.addEventListener('click',()=>{if(!sel)return;const id=c.dataset.id;sel.has(id)?sel.delete(id):sel.add(id);draw()})});
        gw.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();await RPC('gallery','remove',b.dataset.rm);await refresh();draw()}));
        gw.querySelectorAll('[data-fav]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const id=b.dataset.fav,ix=G.favs.indexOf(id);ix<0?G.favs.push(id):G.favs.splice(ix,1);Store.save();draw()}));
        if(!sel)return;
        gw.querySelector('#glselx').addEventListener('click',()=>{sel=null;view.querySelector('#glselect').textContent='Select';draw()});
        gw.querySelector('#gldel').addEventListener('click',async()=>{if(!sel.size){Toast.show('Nothing selected');return}for(const id of sel)await RPC('gallery','remove',id);Toast.show(sel.size+' removed');sel=new Set();await refresh();draw()});
        gw.querySelector('#glalb').addEventListener('click',()=>{if(!sel.size){Toast.show('Nothing selected');return}const bar=gw.querySelector('.glselbar');
          bar.innerHTML=`<select id="glpick">${G.albums.map(a=>`<option value="${a.id}">${escHtml(a.name)}</option>`).join('')}<option value="__new">+ new album…</option></select><input id="glpn" placeholder="album name" style="display:none"><span style="flex:1"></span><button class="btn mini" id="glpok">add</button><button class="btn mini" id="glpx">✕</button>`;
          const pk=bar.querySelector('#glpick'),pn=bar.querySelector('#glpn');
          if(!G.albums.length){pk.value='__new';pn.style.display=''}
          pk.addEventListener('change',()=>{pn.style.display=pk.value==='__new'?'':'none'});
          bar.querySelector('#glpx').addEventListener('click',draw);
          bar.querySelector('#glpok').addEventListener('click',()=>{let al;
            if(pk.value==='__new'){const nm=pn.value.trim();if(!nm){Toast.show('Album name?');return}al={id:'al'+Date.now().toString(36),name:nm,ids:[]};G.albums.push(al)}
            else al=G.albums.find(a=>a.id===pk.value);
            if(!al)return;for(const id of sel)if(!al.ids.includes(id))al.ids.push(id);
            Store.save();Toast.show('Added to '+al.name);sel=null;view.querySelector('#glselect').textContent='Select';draw()});});}
      qEl.addEventListener('input',()=>{q=qEl.value.trim().toLowerCase();draw()});
      view.querySelector('#glsrc').addEventListener('change',e=>{src=e.target.value;draw()});
      view.querySelector('#glsort').addEventListener('change',e=>{sort=e.target.value;draw()});
      view.querySelector('#glselect').addEventListener('click',e=>{sel=sel?null:new Set();e.target.textContent=sel?'Cancel':'Select';draw()});
      view.querySelector('#glall').addEventListener('click',()=>{fav=false;chips();draw()});
      view.querySelector('#glfavc').addEventListener('click',()=>{fav=!fav;chips();draw()});
      const gen=async()=>{const prompt=view.querySelector('#glprompt').value.trim(),msg=view.querySelector('#glmsg');
        if(!prompt){Toast.show('Describe the image');return}
        let st={configured:false};try{st=await RPC('images','status')}catch(e){}
        if(!st.configured)return imgConfig(renderPhotos);
        msg.style.color='var(--ink-faint)';msg.textContent='generating… (may take a while)';
        try{const r=await RPC('images','generate',{prompt});if(r.ok){msg.textContent='';Toast.show('Image generated');await refresh();draw()}else{msg.style.color='var(--accent)';msg.textContent='✗ '+(r.error||'failed')}}catch(e){msg.style.color='var(--accent)';msg.textContent=e.message}};
      view.querySelector('#glgen').addEventListener('click',gen);
      view.querySelector('#glprompt').addEventListener('keydown',e=>{if(e.key==='Enter')gen()});
      chips();draw();
    }
    function renderAlbums(){
      view.innerHTML=`<div class="glbar"><span class="glhd">Albums</span><span style="flex:1"></span><button class="btn mini" id="glnal">+ album</button></div><div id="glalist"></div>`;
      const list=view.querySelector('#glalist');
      function draw(){list.innerHTML=G.albums.length?G.albums.map(a=>`<div class="lprow" data-al="${a.id}"><div style="flex:1;min-width:0"><b>${escHtml(a.name)}</b><div class="dim" style="font-size:9px">${a.ids.length} photo${a.ids.length===1?'':'s'}</div></div><button class="btn mini" data-rm="${a.id}">✕</button></div>`).join(''):'<div class="qempty">No albums yet. Create one to organize your photos.</div>';
        list.querySelectorAll('.lprow').forEach(el=>el.addEventListener('click',e=>{if(e.target.dataset.rm)return;const a=G.albums.find(x=>x.id===el.dataset.al);if(a)renderAlbum(a)}));
        list.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();G.albums=G.albums.filter(a=>a.id!==b.dataset.rm);Store.save();draw()}));}
      view.querySelector('#glnal').addEventListener('click',()=>{const bar=view.querySelector('.glbar');
        bar.innerHTML=`<input id="glnn" placeholder="album name"><button class="btn mini" id="glnok">create</button><button class="btn mini" id="glnx">✕</button>`;
        const nn=bar.querySelector('#glnn');nn.focus();
        const ok=()=>{const nm=nn.value.trim();if(!nm){Toast.show('Album name?');return}G.albums.push({id:'al'+Date.now().toString(36),name:nm,ids:[]});Store.save();renderAlbums()};
        bar.querySelector('#glnok').addEventListener('click',ok);
        nn.addEventListener('keydown',e=>{if(e.key==='Enter')ok()});
        bar.querySelector('#glnx').addEventListener('click',renderAlbums);});
      draw();
    }
    function renderAlbum(a){
      const ids=Bridge.on()?a.ids.filter(id=>items.some(i=>i.id===id)):a.ids.slice();
      view.innerHTML=`<div class="glbar"><button class="btn mini" id="glbk">← albums</button><span class="glhd">${escHtml(a.name)}</span><span class="dim" style="font-size:9px">${ids.length} photo${ids.length===1?'':'s'}</span></div>${ids.length?'<div class="glgrid">'+ids.map(id=>`<div class="glcell" data-id="${id}"><img alt=""><button class="btn mini" data-out="${id}">✕</button></div>`).join('')+'</div>':'<div class="qempty">Empty album. Select photos in the Photos tab, then “+ album”.</div>'}`;
      view.querySelector('#glbk').addEventListener('click',renderAlbums);
      view.querySelectorAll('.glcell').forEach(c=>thumb(c));
      view.querySelectorAll('[data-out]').forEach(b=>b.addEventListener('click',()=>{a.ids=a.ids.filter(x=>x!==b.dataset.out);Store.save();renderAlbum(a)}));
    }
    function renderEdit(){
      view.innerHTML=`<div class="gled"><svg class="gledico"><use href="#i-pal"/></svg><div class="gledh">Image Editor <span class="badge pending">ALPHA</span></div><div class="gledsub">Start a blank canvas, or open a photo from your gallery to edit it.</div><div class="gledbtns"><button class="btn" id="glnc">New canvas…</button><button class="btn" id="glbp">Browse photos</button></div><div class="sethead" style="margin-top:14px">OR PICK A TEMPLATE</div><select id="gltpl" class="gltpl"><option value="">Select a size…</option><option value="1024x1024">1024 × 1024 — square</option><option value="1536x1024">1536 × 1024 — landscape</option><option value="1024x1536">1024 × 1536 — portrait</option><option value="1920x1080">1920 × 1080 — widescreen</option></select><div class="gldiv"></div><div class="sethead" style="align-self:flex-start">SAVED PROJECTS</div><div class="glbar" style="width:100%"><input id="glpq" placeholder="Search projects…"><button class="btn mini" id="glps">Select</button></div><div class="qempty" style="width:100%">No saved projects yet.</div></div>`;
      view.querySelector('#glnc').addEventListener('click',()=>Toast.show('Canvas editor — coming soon'));
      view.querySelector('#glbp').addEventListener('click',()=>setTab('photos'));
      view.querySelector('#gltpl').addEventListener('change',e=>{if(e.target.value){Toast.show('Canvas templates — coming soon');e.target.value=''}});
      view.querySelector('#glps').addEventListener('click',()=>Toast.show('No saved projects yet'));
    }
    async function renderSettings(){
      view.innerHTML=`<div class="glcard"><div class="glcardh">AI Tagging</div><div class="glcardtx">Auto-tag photos by content with your <a id="glvm">vision model</a>. Your own tags are kept.</div><div class="glcardbtns"><button class="btn mini" id="glct">Clear AI tags</button><button class="btn mini" id="glst"><svg class="glbico"><use href="#i-chip"/></svg>Start AI tag</button></div></div><div class="glcard"><div class="glcardh">Image provider (BYOK)</div><div class="glcardtx" id="glpst">checking…</div><div class="glcardbtns"><button class="btn mini" id="glpc">Configure…</button><button class="btn mini" id="glpr" style="display:none">Remove key</button></div></div>`;
      view.querySelector('#glvm').addEventListener('click',()=>openPanel('brain'));
      view.querySelector('#glst').addEventListener('click',()=>Toast.show('AI tagging — coming soon'));
      view.querySelector('#glct').addEventListener('click',()=>Toast.show('AI tagging — coming soon'));
      const st=view.querySelector('#glpst'),rm=view.querySelector('#glpr');
      view.querySelector('#glpc').addEventListener('click',()=>{if(!Bridge.on()){Toast.show('Bridge offline');return}imgConfig(renderSettings)});
      rm.addEventListener('click',async()=>{await RPC('images','removeConfig');Toast.show('Provider removed');renderSettings()});
      if(!Bridge.on()){st.textContent='Bridge offline — connect it to configure image generation.';return}
      try{const r=await RPC('images','status');if(r.configured){st.textContent='Configured: '+r.provider+(r.model?' · '+r.model:'');rm.style.display=''}else st.textContent='No provider configured. Generation asks for a key on first use.'}catch(e){st.textContent='status unavailable'}
    }
    function setTab(t){tab=t;sel=null;p.querySelectorAll('.gltab').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
      if(t==='photos')renderPhotos();else if(t==='albums')renderAlbums();else if(t==='edit')renderEdit();else renderSettings()}
    p.querySelectorAll('.gltab').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.t)));
    setCount();
    if(Bridge.on())refresh().then(()=>setTab(tab));else setTab(tab);
  }
