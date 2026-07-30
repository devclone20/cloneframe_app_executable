  function wireReminders(p){
    const body=p.querySelector('#rmbody');
    if(!Bridge.on()){needBridge(body);return}
    async function load(){let items=[];try{items=await RPC('reminders','list',{status:'all'})}catch(e){showErr(body,e);return}
      body.innerHTML=items.length?items.map(r=>`<div class="lprow"><div style="flex:1;min-width:0"><b>${escHtml(r.note||'')}</b><div class="dim" style="font-size:10px">${fmtTS(r.remindAt)} · ${escHtml(r.status||'')}</div></div><div style="display:flex;gap:6px">${r.status==='pending'?`<button class="btn mini" data-done="${r.id}">✓</button>`:''}<button class="btn mini" data-rm="${r.id}">✕</button></div></div>`).join(''):'<div class="qempty">No reminders.</div>';
      // act() instead of RPC(): the daemon refuses with {ok:false,error} and never throws, so
      // these used to reload the list and leave the owner looking at an unchanged row with no
      // idea anything had been declined.
      body.querySelectorAll('[data-done]').forEach(b=>b.addEventListener('click',async()=>{if(!await act('reminders','markDone',b.dataset.done))return;load()}));
      body.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{if(!await act('reminders','remove',b.dataset.rm))return;load()}));}
    p.querySelector('#rmadd').addEventListener('click',async()=>{const note=p.querySelector('#rmnote').value.trim(),when=p.querySelector('#rmwhen').value;if(!note){Toast.show('Write the reminder');return}
      if(!await act('reminders','create',{note,remindAt:when?new Date(when).toISOString():new Date(Date.now()+3600000).toISOString()}))return;
      p.querySelector('#rmnote').value='';Toast.show('Reminder created');load()});
    load();
  }
