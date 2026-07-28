  // AUTOMATIONS — what runs without you, what waits for you, what it may do unasked.
  //
  // This panel used to be a demo. Four buttons proposed hardcoded samples — "Transfer 10
  // USDC to treasury", "partner@example.io" — into a SECOND approval queue that lived in
  // the browser, separate from the real one in bridge/approvals.mjs that the APPROVAL
  // panel reads. Above them sat two switches, "Agent autonomy" and "Require approval",
  // written here and read by nothing at all: not the bridge, not any agent path, not the
  // permission gate the daemon actually enforces. The panel told the owner their agent
  // was on a leash it did not hold.
  //
  // Now it reads the three sources that decide, for real, what happens without the owner:
  //   • tasks     — the jobs on a clock (bridge/tasks.mjs, the scheduler in the daemon)
  //   • approvals — the queue the agent's emails land in (bridge/approvals.mjs)
  //   • permissions — the gate every agent action passes (bridge/permissions.mjs)
  // Nothing here is a second copy of anything. The panels that OWN each of those are one
  // click away, and the permission switches are read-only here on purpose: SETTINGS →
  // MACHINE is where they are set, and two writers is how the last bug got in.
  function wireAutomations(p){
    const root=p.querySelector('#autoroot');
    let busy=false;

    const CRON_WORDS={'* * * * *':'every minute','*/5 * * * *':'every 5 minutes','*/15 * * * *':'every 15 minutes',
      '0 * * * *':'hourly','0 9 * * *':'every day at 09:00','0 0 * * *':'every day at midnight','0 9 * * 1':'every Monday at 09:00'};
    // A cron line is not a sentence. Name the common ones; show the rest as they are
    // rather than guessing wrong — a wrong schedule is worse than an unfamiliar one.
    const when=(c)=>CRON_WORDS[String(c||'').trim()]||String(c||'—');
    const soon=(ts)=>{
      if(!ts)return '';
      const d=ts-Date.now();
      if(d<0)return 'due now';
      const m=Math.round(d/60000);
      if(m<60)return 'in '+m+'m';
      const h=Math.round(m/60);
      return h<48?('in '+h+'h'):('in '+Math.round(h/24)+'d');
    };
    // The gates the daemon really enforces, in the order they matter to a person.
    const GATES=[
      ['autoEmail','Send email without asking','the agent may send from your account'],
      ['autoAutomations','Run automations without asking','scheduled jobs may act, not just report'],
      ['fileWrite','Write files','create and change files on this machine'],
      ['webAccess','Reach the web','fetch pages and search'],
      ['fullAccess','Run shell commands','anything you could type in a terminal'],
      ['ssh','Connect to your servers','open SSH sessions you configured'],
    ];

    function card(title,note,rows,action){
      return `<div class="af-sec">${escHtml(title)}</div>`
        +(note?`<div class="brn-desc" style="padding:0 2px 8px;line-height:1.6">${note}</div>`:'')
        +(rows||'')
        +(action||'');
    }

    async function render(){
      if(!Bridge.on()){root.innerHTML='<div id="autoneed"></div>';needBridge(root.querySelector('#autoneed'));return}
      if(busy)return;busy=true;
      root.innerHTML='<div class="qempty" style="padding:14px">reading…</div>';
      let tasks=[],pending={pending:0,total:0},perms={},sched=[];
      try{
        const r=await Promise.all([
          RPC('tasks','list').catch(()=>[]),
          RPC('approvals','count').catch(()=>({pending:0,total:0})),
          RPC('permissions','get').catch(()=>({})),
          RPC('scheduled','list',{status:'pending'}).catch(()=>[]),
        ]);
        tasks=Array.isArray(r[0])?r[0]:[];pending=r[1]||{pending:0,total:0};perms=r[2]||{};sched=Array.isArray(r[3])?r[3]:[];
      }catch(e){busy=false;root.innerHTML='<div class="qempty" style="padding:14px">'+escHtml(friendlyErr(e.message||'could not read'))+'</div>';return}
      busy=false;
      if(!p.isConnected)return;

      const live=tasks.filter(t=>t.state==='on'||t.state==='running');
      const paused=tasks.filter(t=>t.state!=='on'&&t.state!=='running');

      const jobRows=live.length
        ? live.map(t=>`<div class="setline"><span style="flex:1;min-width:0"><b style="color:var(--fg);font-size:10.5px">${escHtml(t.name||t.id)}</b>`
            +`<div class="brn-desc">${escHtml(when(t.cron))}${t.nextRunAt?' · next '+escHtml(soon(t.nextRunAt)):''}${t.description?' — '+escHtml(t.description):''}</div></span>`
            +`<span class="brn-tag project">${escHtml((t.state||'on').toUpperCase())}</span></div>`).join('')
        : `<div class="qempty" style="padding:11px">Nothing is running on a clock.</div>`;

      const waitRows=pending.pending
        ? `<div class="setline"><span style="flex:1"><b style="color:var(--fg);font-size:10.5px">${pending.pending} action${pending.pending===1?'':'s'} waiting for your yes</b>`
          +`<div class="brn-desc">Your agent wrote ${pending.pending===1?'it':'them'} and stopped. Nothing is sent until you approve.</div></span>`
          +`<button class="btn mini" id="autoq">REVIEW</button></div>`
        : `<div class="qempty" style="padding:11px">Nothing is waiting for you.</div>`;

      const schedRows=sched.length
        ? sched.slice(0,5).map(s=>`<div class="setline"><span style="flex:1;min-width:0"><b style="color:var(--fg);font-size:10.5px">${escHtml(s.subject||'(no subject)')}</b>`
            +`<div class="brn-desc">to ${escHtml(Array.isArray(s.to)?s.to.join(', '):(s.to||''))} · ${escHtml(soon(s.sendAt))}</div></span>`
            +`<button class="btn mini" data-unsched="${escAttr(s.id)}">cancel</button></div>`).join('')
          +(sched.length>5?`<div class="brn-desc" style="padding:4px 2px">and ${sched.length-5} more — see EMAIL.</div>`:'')
        : '';

      const gateRows=GATES.map(([k,label,note])=>{
        const on=perms[k]===true;
        return `<div class="setline"><span style="flex:1"><b style="color:var(--fg);font-size:10.5px">${escHtml(label)}</b>`
          +`<div class="brn-desc">${escHtml(note)}</div></span>`
          +`<span class="brn-tag ${on?'project':''}">${on?'ALLOWED':'ASKS FIRST'}</span></div>`;
      }).join('');

      root.innerHTML=
        card('RUNNING ON A CLOCK',
          'Jobs the daemon runs whether or not this window is open. TASKS is where you create and stop them.',
          jobRows,
          `<div class="compose-actions" style="justify-content:flex-start"><button class="btn" id="autotasks">OPEN TASKS</button>`
            +(paused.length?`<span class="brn-desc" style="align-self:center;margin-left:8px">${paused.length} more paused</span>`:'')+`</div>`)
        +card('WAITING FOR YOU',
          'Anything your agent wants to send lands here first. APPROVAL is where you read it in full.',
          waitRows,'')
        +(schedRows?card('EMAIL ALREADY WRITTEN, NOT YET SENT',
          'Messages queued to leave at a set time. Cancelling one here deletes the send, not the draft.',
          schedRows,''):'')
        +card('WHAT IT MAY DO WITHOUT ASKING',
          'The gate every agent action passes on this machine. Change it in <b>SETTINGS → MACHINE</b> — '
          +'this panel shows it rather than setting it, so there is only ever one place that decides.',
          gateRows,
          `<div class="compose-actions" style="justify-content:flex-start"><button class="btn" id="autoperm">OPEN SETTINGS</button></div>`);

      const q=root.querySelector('#autoq');if(q)q.addEventListener('click',()=>openPanel('approval'));
      const t=root.querySelector('#autotasks');if(t)t.addEventListener('click',()=>openPanel('tasks'));
      const g=root.querySelector('#autoperm');if(g)g.addEventListener('click',()=>{openPanel('settings');setTimeout(()=>{const n=document.querySelector('#setnav [data-sec="machine"]');if(n)n.click()},90)});
      root.querySelectorAll('[data-unsched]').forEach(b=>b.addEventListener('click',async()=>{
        b.disabled=true;b.textContent='cancelling…';
        let r;try{r=await RPC('scheduled','cancel',b.dataset.unsched)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        Toast.show(r&&r.ok!==false?'Send cancelled':('Could not cancel: '+((r&&r.error)||'unknown')));render();}));
    }

    // Every source this panel reads announces its own changes. Listening to all of them
    // is what keeps it from being a snapshot of a moment that has passed.
    panelBus(p).on('bridge:changed',render);
    panelBus(p).on('approvals:changed',render);
    panelBus(p).on('tasks:changed',render);
    panelBus(p).on('permissions:changed',render);
    render();
  }
