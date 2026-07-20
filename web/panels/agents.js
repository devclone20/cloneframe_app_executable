  function wireAgents(p){
    const list=p.querySelector('#agentlist');
    function render(){
      const active=Store.get().activeAgent;
      list.innerHTML=AgentNet.PRESETS.map(a=>`
        <div class="agentitem" data-aid="${a.agentId}">
          <div class="top">
            <div class="av2"><svg><use href="#i-agent"/></svg></div>
            <div><b>${a.name}</b> <span class="aid">#${a.agentId}</span><div class="role">${escHtml(a.role)}</div></div>
            <span class="st2" data-st>on-chain?</span>
          </div>
          <div class="modes">
            <button class="amode on" data-mode="chain">ON-CHAIN (read-only)</button>
            <button class="amode" data-mode="bridge">HUB BRIDGE</button>
            <button class="amode" data-mode="byok">ENDPOINT BYOK</button>
            <button class="ause ${active===a.agentId?'active':''}" data-use>${active===a.agentId?'ACTIVE IN CODE':'USE IN CODE'}</button>
          </div>
          <div class="aoffers" data-offers></div>
          <div class="abridge" data-bridge><input placeholder="http://localhost:8765 (your bridge)" data-bridgeurl><button class="ause" data-bridgetest>TEST</button></div>
        </div>`).join('');
      list.querySelectorAll('.agentitem').forEach(el=>loadCard(el));
    }
    async function loadCard(el){
      const aid=+el.dataset.aid,st=el.querySelector('[data-st]'),off=el.querySelector('[data-offers]');
      st.textContent='reading on-chain…';
      const c=await AgentNet.card(aid);
      if(c){
        st.textContent='REGISTERED';st.classList.add('on');
        const svcs=(c.services||c.offerings||[]);
        off.classList.add('show');
        off.innerHTML=`<div style="font-size:8.5px;letter-spacing:.14em;color:var(--ink-faint);margin:2px 0 6px">${escHtml(c.name||'agent')} · ${svcs.length} service(s)</div>`+
          (svcs.slice(0,6).map(s=>`<div class="aoffer">${escHtml(s.name||s.id||String(s))}<span class="p">${escHtml(s.price||s.priceV2?.value||'')}</span></div>`).join('')||'<div class="aoffer">card lists no services</div>');
      }else{
        st.textContent='no data (RPC/registry)';
      }
    }
    list.addEventListener('click',e=>{
      const item=e.target.closest('.agentitem');if(!item)return;
      const aid=+item.dataset.aid;
      const mode=e.target.closest('.amode');
      if(mode){
        item.querySelectorAll('.amode').forEach(m=>m.classList.toggle('on',m===mode));
        item.querySelector('[data-offers]').classList.toggle('show',mode.dataset.mode==='chain');
        item.querySelector('[data-bridge]').classList.toggle('show',mode.dataset.mode==='bridge');
        return;
      }
      if(e.target.closest('[data-use]')){
        Store.get().activeAgent=aid;Store.save();
        Bus.emit('agent:active',aid);render();
        Toast.show((AgentNet.PRESETS.find(x=>x.agentId===aid)?.name||'agent')+' active in CODE');
        return;
      }
      if(e.target.closest('[data-bridgetest]')){
        const url=item.querySelector('[data-bridgeurl]').value.trim();
        e.target.textContent='…';
        AgentNet.bridgeProbe(url).then(r=>{e.target.textContent='TESTAR';Toast.show(r.msg)});
      }
    });
    render();
  }
