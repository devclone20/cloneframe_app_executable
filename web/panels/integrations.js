  function wireIntegrations(p){
    const body=p.querySelector('#igbody');
    if(!Bridge.on()){needBridge(body);return}
    function metaStr(g){const m=g.meta||{};return escHtml(m.email||m.url||m.baseUrl||m.host||m.transport||m.source||'')}
    async function load(){let items=[];try{items=await RPC('integrations','list')}catch(e){showErr(body,e);return}
      body.innerHTML=items.length?items.map(g=>`<div class="igrow"><span class="igdot ${escAttr(g.status)}"></span><div><b>${escAttr(g.name)}</b> <span class="badge">${escAttr(g.type)}</span>${g.isDefault?' <span class="badge">default</span>':''}<div class="dim" style="font-size:10px">${metaStr(g)}${g.lastError?' · '+escAttr(g.lastError):''}</div></div><div style="margin-left:auto;display:flex;gap:6px">${g.readOnly?'':`<button class="btn mini" data-test="${g.id}">test</button><button class="btn mini" data-rm="${g.id}">✕</button>`}</div></div>`).join(''):'<div class="qempty">No integrations.</div>';
      body.querySelectorAll('[data-test]').forEach(b=>b.addEventListener('click',async()=>{b.textContent='…';const r=await RPC('integrations','test',b.dataset.test);Toast.show(r.ok?'connected ✓':(r.error||'failed'));load()}));
      body.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{await RPC('integrations','remove',b.dataset.rm);load()}));
    }
    p.querySelector('#igadd').addEventListener('click',()=>{
      body.innerHTML='<div class="acctform"><div class="afh">Add integration</div><div class="af-row"><label>Type</label><select id="igt"><option value="api">API Service</option><option value="mcp">MCP Tool Server</option><option value="caldav">CalDAV</option><option value="carddav">CardDAV</option></select></div><div class="af-row"><label>Name</label><input id="ign"></div><div id="igfields"></div><div id="igmsg" style="font-size:10px"></div><div class="compose-actions"><button class="btn" id="igsave">ADD</button><button class="btn" id="igcancel">CANCEL</button></div></div>';
      const t=body.querySelector('#igt'),ff=body.querySelector('#igfields');
      function fields(){const v=t.value;
        if(v==='api')ff.innerHTML='<div class="af-row"><label>Base URL</label><input id="igu" placeholder="https://api.example.com"></div><div class="af-row"><label>API key</label><input id="igk" type="password" placeholder="optional"></div>';
        else if(v==='mcp')ff.innerHTML='<div class="af-row"><label>Transport</label><select id="igtr"><option>http</option><option>ws</option><option>stdio</option></select></div><div class="af-row"><label>URL/Command</label><input id="igu"></div>';
        else ff.innerHTML='<div class="af-row"><label>URL</label><input id="igu"></div><div class="af-row"><label>Username</label><input id="igus"></div><div class="af-row"><label>Password</label><input id="igp" type="password"></div>';
      }
      t.addEventListener('change',fields);fields();
      body.querySelector('#igsave').addEventListener('click',async()=>{
        const v=t.value,name=body.querySelector('#ign').value.trim()||v,g=id=>{const el=body.querySelector('#'+id);return el?el.value.trim():''};
        let config={};
        if(v==='api')config={baseUrl:g('igu'),apiKey:g('igk')||undefined};
        else if(v==='mcp')config={transport:g('igtr')||'http',url:g('igu')};
        else config={url:g('igu'),username:g('igus'),password:g('igp')};
        const r=await RPC('integrations','add',{type:v,name,config}),m=body.querySelector('#igmsg');
        if(r.ok){Toast.show('Added');load()}else{m.style.color='var(--accent)';m.textContent=r.error||'failed'}
      });
      body.querySelector('#igcancel').addEventListener('click',load);
    });
    load();
  }
