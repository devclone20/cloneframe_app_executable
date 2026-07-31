  function wireApproval(p){
    const body=p.querySelector('#apbody');
    if(!Bridge.on()){needBridge(body);return}
    async function load(){let items=[];try{items=await RPC('approvals','list',{})}catch(e){showErr(body,e);return}
      if(!items.length){body.innerHTML='<div class="qempty">No emails waiting. When the agent drafts a reply (Auto Reply task), it shows up here.</div>';return}
      body.innerHTML=items.map(a=>`<div class="aprow">
        <div class="apmeta"><b>${escAttr(a.subject||'(no subject)')}</b> <span class="badge ${escAttr(a.status)}">${escAttr(a.status)}</span></div>
        <div class="apto">para ${escHtml(Array.isArray(a.to)?a.to.join(', '):(a.to||''))}${a.generatedBy?' · '+escHtml(a.generatedBy):''}</div>
        <textarea class="apbodytext" data-b="${a.id}" ${a.status==='pending'?'':'readonly'}>${escHtml(a.body||'')}</textarea>
        ${a.status==='pending'?`<div class="compose-actions"><button class="btn mini" data-ap="${a.id}">✓ approve and send</button><button class="btn mini" data-ed="${a.id}">save edit</button><button class="btn mini" data-rj="${a.id}">reject</button></div>`:''}</div>`).join('');
      // b.textContent='sending…' is a LABEL, not a lock. The button stayed live for the whole
      // SMTP round trip (1-3s) and was only replaced when load() re-rendered afterwards, so a
      // second click sent the same mail again. disabled is the lock; the label is the news.
      body.querySelectorAll('[data-ap]').forEach(b=>b.addEventListener('click',async()=>{if(b.disabled)return;b.disabled=true;b.textContent='sending…';let r;try{r=await RPC('approvals','approve',b.dataset.ap)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}finally{b.disabled=false}Toast.show(r.ok?'Email sent ✉':(r.error||'failed'));load()}));
      // act() exists precisely because the daemon reports a refusal as {ok:false,error} and
      // does NOT throw — so a bare RPC + unconditional toast reports success for a failure.
      // (It also said "Rejeitado": the app is English, decided 2026-07-11.)
      body.querySelectorAll('[data-rj]').forEach(b=>b.addEventListener('click',async()=>{if(!await act('approvals','reject',b.dataset.rj))return;Toast.show('Rejected');load()}));
      body.querySelectorAll('[data-ed]').forEach(b=>b.addEventListener('click',async()=>{const ta=body.querySelector('[data-b="'+b.dataset.ed+'"]');if(!await act('approvals','edit',b.dataset.ed,{body:ta.value}))return;Toast.show('Edit saved')}));
    }
    load();
  }
