  function wireSearch(p){
    const q=p.querySelector('#gsq'),body=p.querySelector('#gsbody');
    if(!Bridge.on()){needBridge(body);return}
    async function run(){const s=q.value.trim();if(!s){body.innerHTML='<div class="qempty">Type to search notes · library · contacts · recipes · tasks · reminders · research.</div>';return}
      body.innerHTML='<div class="qempty">searching…</div>';let res;try{res=await RPC('search','query',s,{limit:8})}catch(e){showErr(body,e);return}
      const groups=(res&&res.groups)||[];
      if(!groups.length){body.innerHTML='<div class="qempty">Nothing found.</div>';return}
      const MAP={notes:'notes',library:'library',contacts:'contacts',cookbook:'cookbook',tasks:'tasks',reminders:'reminders',research:'research'};
      body.innerHTML=groups.map(g=>`<div class="flygrp">${escAttr(g.label||g.module)}</div>`+(g.results||[]).map(r=>`<div class="lprow" data-m="${escAttr(g.module)}"><div style="flex:1;min-width:0"><b>${escAttr(r.title||'')}</b><div class="dim" style="font-size:9px">${escAttr(String(r.snippet||'').slice(0,90))}</div></div></div>`).join('')).join('');
      body.querySelectorAll('.lprow').forEach(el=>el.addEventListener('click',()=>{const m=MAP[el.dataset.m];if(m)openPanel(m)}));}
    q.addEventListener('input',()=>{clearTimeout(q._t);q._t=setTimeout(run,300)});
    setTimeout(()=>q.focus(),60);run();
  }
