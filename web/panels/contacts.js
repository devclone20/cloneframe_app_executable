  function wireContacts(p){
    const body=p.querySelector('#ctbody'),search=p.querySelector('#ctsearch');
    if(!Bridge.on()){needBridge(body);return}
    async function load(){let items=[];try{items=await RPC('contacts','list',{search:search.value.trim()})}catch(e){showErr(body,e);return}
      body.innerHTML=items.length?items.map(c=>`<div class="ctrow"><div><b>${escHtml(c.displayName||'(sem nome)')}</b><div class="dim" style="font-size:10px">${escHtml((c.emails||[]).join(', '))}${c.org?' · '+escHtml(c.org):''}</div></div><button class="btn mini" data-rm="${c.id}" style="margin-left:auto">✕</button></div>`).join(''):'<div class="qempty">No contacts. Import vCard/CSV or connect CardDAV.</div>';
      body.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{await RPC('contacts','remove',b.dataset.rm);load()}));
    }
    search.addEventListener('input',()=>{clearTimeout(search._t);search._t=setTimeout(load,250)});
    p.querySelector('#ctadd').addEventListener('click',()=>{
      body.innerHTML='<div class="acctform"><div class="afh">New contact</div><div class="af-row"><label>Name</label><input id="cnn"></div><div class="af-row"><label>Email</label><input id="cne"></div><div class="af-row"><label>Org</label><input id="cno"></div><div class="compose-actions"><button class="btn" id="cnsave">SAVE</button><button class="btn" id="cncancel">CANCEL</button></div></div>';
      body.querySelector('#cnsave').addEventListener('click',async()=>{await RPC('contacts','add',{displayName:body.querySelector('#cnn').value.trim(),emails:[body.querySelector('#cne').value.trim()].filter(Boolean),org:body.querySelector('#cno').value.trim()});Toast.show('Saved');load()});
      body.querySelector('#cncancel').addEventListener('click',load);
    });
    p.querySelector('#ctimp').addEventListener('click',()=>{
      const inp=document.createElement('input');inp.type='file';inp.accept='.vcf,.csv,text/vcard,text/csv';
      inp.onchange=()=>{const f=inp.files[0];if(!f)return;const rd=new FileReader();rd.onload=async()=>{const r=await RPC('contacts',/\.csv$/i.test(f.name)?'importCSV':'importVCard',rd.result);Toast.show('Importados: '+(r.imported||0));load()};rd.readAsText(f)};
      inp.click();
    });
    p.querySelector('#ctdav').addEventListener('click',()=>{
      body.innerHTML='<div class="acctform"><div class="afh">CardDAV</div><div class="af-row"><label>URL</label><input id="cdu" placeholder="https://…/addressbooks/user/default/"></div><div class="af-row"><label>Username</label><input id="cdus"></div><div class="af-row"><label>Password</label><input id="cdp" type="password"></div><div id="cdmsg" style="font-size:10px"></div><div class="compose-actions"><button class="btn" id="cdsync">SYNC</button><button class="btn" id="cdcancel">CANCEL</button></div></div>';
      body.querySelector('#cdsync').addEventListener('click',async()=>{const m=body.querySelector('#cdmsg');m.textContent='syncing…';const r=await RPC('contacts','carddavSync',{url:body.querySelector('#cdu').value.trim(),user:body.querySelector('#cdus').value.trim(),pass:body.querySelector('#cdp').value});m.style.color=r.ok?'var(--ok)':'var(--accent)';m.textContent=r.ok?('✓ imported '+(r.imported||0)):('✗ '+(r.error||'failed'));if(r.ok)setTimeout(load,900)});
      body.querySelector('#cdcancel').addEventListener('click',load);
    });
    load();
  }
