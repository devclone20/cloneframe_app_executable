  function wireAutomations(p){
    const queue=p.querySelector('#queue'),qcount=p.querySelector('#qcount');
    const SAMPLES={
      email:['Follow-up email to the lead','To: partner@example.io\nSubject: CLONE FRAME follow-up\n\nHello — as agreed, here is the proposal summary and the next steps. I remain available.'],
      post:['Post the weekly update','This week on CLONE FRAME: HUB v0.4 with gated autonomy, MY MACHINE and the COUNCIL. #ownyourAI'],
      acp:['Accept ACP job #128 (35 USDC)','Counterparty: 0x…a91b · service: tokenSnapshotQuick · escrow 35 USDC · SLA 30min'],
      tx:['Transfer 10 USDC to treasury','to: 0x…treasury · amount: 10 USDC · network: Base 8453'],
    };
    function render(){
      const ap=Store.get().approvals;
      qcount.textContent=Approvals.pendingCount()?('· '+Approvals.pendingCount()+' pending'):'';
      if(!ap.length){queue.innerHTML='<div class="qempty">no actions — propose one above to see the approval flow</div>';return}
      queue.innerHTML=ap.map(a=>{
        const T=Approvals.TYPES[a.type]||{label:a.type};
        const veto=a.status==='vetoed';
        const stLabel={pending:'PENDING',approved:'APPROVED',executing:'EXECUTING',done:'DONE',rejected:'REJECTED',vetoed:'SAFETY VETO'}[a.status];
        return `<div class="qcard ${veto?'veto':''}" data-id="${a.id}">
          <div class="qh"><span class="type">${T.label}</span><span>${escHtml(a.title)}</span><span class="stt">${stLabel}</span></div>
          <div class="qbody">${escHtml(a.body)}</div>
          <div class="safety ${a.safety.verdict==='VETO'?'veto':'ok'}"><svg width="12" height="12"><use href="#i-shield"/></svg>SAFETY: ${a.safety.verdict} — ${escHtml(a.safety.reason)}</div>
          ${a.status==='pending'?`<div class="qbtns"><button class="btn" data-ap style="padding:6px 13px;font-size:10px">${a.fin?'APPROVE (sign)':'APPROVE'}</button><button class="btn" data-rj style="padding:6px 13px;font-size:10px">REJECT</button></div>`:''}
          ${a.result?`<div style="font-size:10px;color:var(--ink-faint);margin-top:6px">${escHtml(a.result)}</div>`:''}
        </div>`;
      }).join('');
    }
    p.querySelector('#autosw').addEventListener('click',e=>{
      const s=Store.get();s.autonomy.enabled=!s.autonomy.enabled;Store.save();
      e.currentTarget.classList.toggle('on',s.autonomy.enabled);
      Caps.set('automations',1);
    });
    p.querySelector('#apsw').addEventListener('click',e=>{
      const s=Store.get();s.autonomy.requireApproval=!s.autonomy.requireApproval;Store.save();
      e.currentTarget.classList.toggle('on',s.autonomy.requireApproval);
      if(!s.autonomy.requireApproval)Toast.show('⚠ Mandatory approval off — not recommended');
    });
    p.querySelector('.acts').addEventListener('click',e=>{
      const b=e.target.closest('.actbtn');if(!b)return;
      const smp=SAMPLES[b.dataset.act];
      Approvals.propose(b.dataset.act,smp[0],smp[1]);
      render();
    });
    queue.addEventListener('click',async e=>{
      const card=e.target.closest('.qcard');if(!card)return;
      const id=card.dataset.id;
      if(e.target.closest('[data-ap]')){
        const it=Store.get().approvals.find(x=>x.id===id);
        if(it&&it.fin){
          // financial action requires wallet signature (I17)
          if(!WalletAuth.addr()){Toast.show('Connect the wallet to sign financial actions');return}
          Toast.show('Requesting wallet signature…');
        }
        await Approvals.approve(id,it&&it.fin?'wallet-signed':'session');
        render();
        return;
      }
      if(e.target.closest('[data-rj]')){Approvals.reject(id);render()}
    });
    panelBus(p).on('approvals:changed',()=>{render()});
    render();
  }
