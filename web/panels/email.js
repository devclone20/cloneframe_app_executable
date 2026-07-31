  function wireEmail(p){
    const wrap=p.querySelector('.emwrap'),pills=p.querySelector('#empills'),newBtn=p.querySelector('#emnew'),
          foldBtn=p.querySelector('#emfoldbtn'),foldLbl=p.querySelector('#emfoldlbl'),fltBtn=p.querySelector('#emfltbtn'),fltLbl=p.querySelector('#emfltlbl'),
          selBtn=p.querySelector('#emselbtn'),refreshBtn=p.querySelector('#emrefresh'),q=p.querySelector('#emq'),
          bellB=p.querySelector('#emfbell'),readB=p.querySelector('#emfread'),attB=p.querySelector('#emfatt'),
          bulk=p.querySelector('#embulk'),listEl=p.querySelector('#emlist'),paneEl=p.querySelector('#empane'),
          menuEl=p.querySelector('#emmenu'),unreadEl=p.querySelector('#emubadge'),countEl=p.querySelector('#emtotal');
    let accounts=[],acct=null,folders=[],folder=null,msgs=[],filter='All',selMode=false,inList=false,paneMode=null,lastMsg=null;
    const sel=new Set(),drafts=[];let active=null,draftSeq=0;
    const FMAP={'\\Inbox':['Inbox',0],'\\Sent':['Sent',1],'\\Drafts':['Drafts',2],'\\Flagged':['Starred',3],'\\Important':['Important',4],'\\All':['All Mail',5],'\\Archive':['Archive',6],'\\Junk':['Spam',7],'\\Trash':['Trash',8]};
    const SCHED={path:'__scheduled',name:'⏰ Scheduled',__sched:true},APPR={path:'__approval',name:'✓ Email Approval',__appr:true};
    const FILTERS=['All','Unread','Read','Starred','Attachments'];
    const EMO=['🙂','😀','😂','👍','🙏','🔥','✅','🚀','❤️','👀'];
    const SPAL=['#e06c75','#c678dd','#d156a3','var(--ok)','var(--warn)','#61afef','#56b6c2'];
    const fname=f=>{const m=FMAP[f.specialUse];return m?m[0]:(f.name||f.path)};
    const addr=a=>a?((a.name?a.name+' ':'')+(a.address?'<'+a.address+'>':'')).trim():'';
    const short=a=>a?(a.name||a.address||''):'';
    const senderColor=f=>{const k=((f&&(f.address||f.name))||'').split('@').pop().toLowerCase();let h=0;for(let i=0;i<k.length;i++)h=(h*31+k.charCodeAt(i))>>>0;return SPAL[h%SPAL.length]};
    const fmtDate=d=>{if(!d)return'';const t=new Date(d);return isNaN(+t)?'':t.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})+', '+t.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})};
    function setBusy(b){listEl.style.opacity=b?'.6':'1'}
    function note(html){inList=false;listEl.innerHTML='<div class="qempty" style="padding:26px 18px;line-height:1.7">'+html+'</div>'}
    function showPane(mode){paneMode=mode;paneEl.style.display='flex'}
    function hidePane(){paneMode=null;lastMsg=null;paneEl.style.display='none';paneEl.innerHTML=''}

    // ---------- floating menu (folder dropdown / filter dropdown / send menu) ----------
    function closeMenu(){menuEl.style.display='none';if(menuEl._out){document.removeEventListener('click',menuEl._out);menuEl._out=null}}
    function menu(anchor,items,onPick){
      closeMenu();
      menuEl.innerHTML=items.map((it,i)=>it.hr?'<div class="emhr"></div>':`<div class="emmi ${it.on?'on':''}" data-i="${i}"><span class="ck">${it.on?'✓':''}</span>${it.html}${it.ct!=null?`<span class="ct">${it.ct}</span>`:''}</div>`).join('');
      menuEl.style.display='';
      const r=anchor.getBoundingClientRect(),w=wrap.getBoundingClientRect();
      let left=r.left-w.left;const mw=menuEl.offsetWidth;if(left+mw>w.width-8)left=Math.max(8,w.width-mw-8);
      menuEl.style.left=left+'px';menuEl.style.top=(r.bottom-w.top+4)+'px';
      menuEl.querySelectorAll('.emmi').forEach(el=>el.addEventListener('click',()=>{closeMenu();onPick(+el.dataset.i)}));
      const out=ev=>{if(!menuEl.contains(ev.target))closeMenu()};
      setTimeout(()=>{document.addEventListener('click',out);menuEl._out=out},0);
    }

    // ---------- no bridge / no account ----------
    function renderNoBridge(err){
      pills.innerHTML='<span class="emdim">no HUB Bridge</span>';unreadEl.style.display='none';countEl.textContent='';hidePane();
      note('For <b>real</b> email (IMAP/SMTP) connect the <b>HUB Bridge</b> — it runs on your machine and stores credentials locally, never on the site.<br><br><button class="btn" id="mopenmachine">OPEN MY MACHINE</button>'+(err?'<div style="color:var(--accent);margin-top:10px;font-size:10px">'+escHtml(err)+'</div>':''));
      listEl.querySelector('#mopenmachine')?.addEventListener('click',()=>openPanel('machine'));
    }

    // ---------- add account (manual + Google OAuth) ----------
    function renderAddForm(){
      inList=false;hidePane();
      listEl.innerHTML=`<div class="acctform">
        <div class="afh">Add email account</div>
        <div style="border:1px solid var(--line);border-radius:9px;padding:9px;margin-bottom:8px">
          <button class="btn" id="afgoogle" style="width:100%">⟢ Connect Gmail with Google (OAuth)</button>
          <div id="afgmsg" style="font-size:10px;color:var(--ink-faint);margin-top:6px;line-height:1.5">Full inbox + sending, no App Password. Sign-in opens in your system browser (the only place Google allows it); your account then lives here over a secure token. Needs your own OAuth Client (Desktop).</div>
        </div>
        <div class="af-row"><label>Provider</label>
          <select id="afprov"><option value="gmail">Gmail</option><option value="custom">Custom…</option></select></div>
        <div class="af-row"><label>Name</label><input id="afname" placeholder="optional — label"></div>
        <div class="af-row"><label>Email</label><input id="afemail" placeholder="you@example.com" autocomplete="off"></div>
        <div class="af-row"><label>Display name</label><input id="afdisplay" placeholder="Your Name"></div>
        <div class="af-sec">✉ IMAP (receive)</div>
        <div class="af-row"><label>Host</label><input id="afihost" placeholder="imap.gmail.com"></div>
        <div class="af-row"><label>Port</label><input id="afiport" value="993" style="max-width:90px"></div>
        <div class="af-row"><label>Username</label><input id="afuser" placeholder="you@example.com" autocomplete="off"></div>
        <div class="af-row"><label>Password</label><input id="afpass" type="password" placeholder="Gmail: App Password (16 digits)" autocomplete="off"></div>
        <div class="af-sec">➤ SMTP (send)</div>
        <div class="af-row"><label>Host</label><input id="afshost" placeholder="smtp.gmail.com"></div>
        <div class="af-row"><label>Port</label><input id="afsport" value="465" style="max-width:90px"></div>
        <div class="af-row"><label>SSL</label><input type="checkbox" id="afssl" checked style="width:auto"><span style="font-size:10px;color:var(--ink-faint)">465=SSL · 587=STARTTLS (uncheck)</span></div>
        <div class="af-row"><label>Default</label><input type="checkbox" id="afdef" style="width:auto"></div>
        <div id="afmsg" style="font-size:10px;min-height:14px;margin:2px 0"></div>
        <div class="compose-actions"><button class="btn" id="aftest">TEST</button><button class="btn" id="afcreate">CREATE</button>${accounts.length?'<button class="btn" id="afcancel">CANCEL</button>':''}</div>
        <div style="font-size:10px;color:var(--ink-faint);line-height:1.5">Gmail requires an <b>App Password</b> (Google Account → Security → App Passwords, with 2FA). Credentials live in <code>~/.clone-frame-hub/accounts.json</code> on your machine.</div>
      </div>`;
      const g=id=>listEl.querySelector('#'+id),v=id=>g(id).value.trim();
      const prov=g('afprov'),msg=g('afmsg');
      function applyProv(){if(prov.value==='gmail'){g('afihost').value='imap.gmail.com';g('afiport').value='993';g('afshost').value='smtp.gmail.com';g('afsport').value='465';g('afssl').checked=true}}
      prov.addEventListener('change',applyProv);applyProv();
      g('afemail').addEventListener('input',()=>{if(!g('afuser').value)g('afuser').value=g('afemail').value});
      function cfg(){return{email:v('afemail'),display:v('afdisplay')||v('afemail'),provider:prov.value,name:v('afname'),user:v('afuser')||v('afemail'),pass:g('afpass').value,imapHost:v('afihost'),imapPort:+v('afiport')||993,imapSecure:true,smtpHost:v('afshost'),smtpPort:+v('afsport')||465,smtpSecure:g('afssl').checked,isDefault:g('afdef').checked}}
      g('aftest').addEventListener('click',async()=>{msg.style.color='var(--ink-faint)';msg.textContent='testing connection…';try{const r=await Mail.testAccount(cfg());msg.style.color=r.ok?'var(--ok)':'var(--accent)';msg.textContent=r.ok?'✓ IMAP and SMTP ok':('✗ '+(r.error||'failed')+(r.imap?'':' · IMAP')+(r.smtp?'':' · SMTP'))}catch(e){msg.style.color='var(--accent)';msg.textContent='✗ '+e.message}});
      g('afcreate').addEventListener('click',async()=>{
        if(!v('afemail')||!g('afpass').value){msg.style.color='var(--accent)';msg.textContent='email and password are required';return}
        msg.style.color='var(--ink-faint)';msg.textContent='validating and connecting…';
        try{const r=await Mail.addAccount(cfg());if(!r.ok){msg.style.color='var(--accent)';msg.textContent='✗ '+(r.error||'failed');return}
          Caps.set('email',1);Toast.show('Account connected ✉');await boot(r.id)}catch(e){msg.style.color='var(--accent)';msg.textContent='✗ '+e.message}
      });
      g('afcancel')?.addEventListener('click',()=>boot());
      g('afgoogle').addEventListener('click',async()=>{
        const gm=listEl.querySelector('#afgmsg');
        let st={configured:false};try{st=await RPC('oauth','status')}catch(e){}
        if(!st.configured){
          gm.innerHTML='<div style="margin-top:6px"><input id="ogid" placeholder="Google Client ID" style="all:unset;display:block;box-sizing:border-box;width:100%;border:1px solid var(--line);border-radius:7px;padding:6px;font-size:10px;color:var(--fg);caret-color:var(--accent);margin-bottom:4px"><input id="ogsec" type="password" placeholder="Client Secret" style="all:unset;display:block;box-sizing:border-box;width:100%;border:1px solid var(--line);border-radius:7px;padding:6px;font-size:10px;color:var(--fg);caret-color:var(--accent);margin-bottom:5px"><button class="btn mini" id="ogsave">save creds</button> <span style="font-size:10px">Google Console → Desktop-type OAuth client</span></div>';
          gm.querySelector('#ogsave').addEventListener('click',async()=>{const r=await RPC('oauth','config',{clientId:gm.querySelector('#ogid').value.trim(),clientSecret:gm.querySelector('#ogsec').value.trim()});if(r.ok){Toast.show('Creds saved');g('afgoogle').click()}else Toast.show(r.error||'failed')});
          return;
        }
        gm.style.color='var(--ink-faint)';gm.textContent='opening Google sign-in in your browser…';
        let r;try{r=await RPC('oauth','beginAuth')}catch(e){gm.textContent='✗ '+e.message;return}
        if(!r.ok){gm.textContent='✗ '+(r.error||'failed');return}
        // The consent MUST run in the SYSTEM browser: Google blocks account sign-in inside every
        // embedded browser, and the loopback redirect (127.0.0.1) returns to the bridge no matter
        // which browser consented. openExternal → the user's real Chrome (already signed into Google).
        if(window.cfhubNative&&window.cfhubNative.openExternal)window.cfhubNative.openExternal(r.authUrl);
        else window.open(r.authUrl,'_blank','noopener');
        gm.textContent='authorize in your browser, then come back — this updates automatically…';
        const poll=setInterval(async()=>{try{const s=await RPC('oauth','pollAuth');if(s.done){clearInterval(poll);if(s.email){Toast.show('Gmail connected: '+s.email);gm.style.color='var(--ok)';gm.textContent='✓ '+s.email+' connected — opening inbox…';boot('oauth:'+s.email)}else{gm.style.color='var(--accent)';gm.textContent='✗ '+(s.error||'cancelled')}}}catch(e){}},2000);
        setTimeout(()=>clearInterval(poll),185000);
      });
    }

    // ---------- account management (open by clicking the active account pill) ----------
    function renderAccounts(){
      inList=false;hidePane();
      listEl.innerHTML='<div class="acctform"><div class="afh">Accounts</div>'+
        accounts.map(a=>`<div class="acctrow"><div><b>${escHtml(a.display||a.email)}</b>${a.isDefault?' <span class="badge">DEFAULT</span>':''}<div style="font-size:10px;color:var(--ink-faint)">${escHtml(a.email)}</div></div><div style="margin-left:auto;display:flex;gap:6px">${a.isDefault?'':`<button class="btn mini" data-def="${a.id}">make default</button>`}<button class="btn mini" data-rm="${a.id}">remove</button></div></div>`).join('')+
        '<div class="compose-actions"><button class="btn" id="acadd">+ ADD ACCOUNT</button><button class="btn" id="acback">BACK</button></div></div>';
      listEl.querySelector('#acadd').addEventListener('click',()=>renderAddForm());
      listEl.querySelector('#acback').addEventListener('click',()=>folder?openFolder(folder):boot());
      listEl.querySelectorAll('[data-def]').forEach(b=>b.addEventListener('click',async()=>{
        let r;try{r=await Mail.setDefault(b.dataset.def)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        if(!(r&&r.ok)){Toast.show('Could not change the default: '+((r&&r.error)||'unknown'));return}
        await boot(b.dataset.def)}));
      // Removal reports the bridge's own answer. It used to say "Account removed"
      // no matter what came back, which is how a Google account that stayed put
      // still looked gone until the panel redrew it.
      listEl.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',async()=>{
        if(!b.dataset.armed){b.dataset.armed='1';b.textContent='confirm?';setTimeout(()=>{if(b&&b.dataset.armed){b.removeAttribute('data-armed');b.textContent='remove'}},2500);return}
        b.disabled=true;b.textContent='removing…';
        let r;try{r=await Mail.removeAccount(b.dataset.rm)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        if(!(r&&r.ok)){Toast.show('Could not remove it: '+((r&&r.error)||'unknown'));b.disabled=false;b.textContent='remove';b.removeAttribute('data-armed');return}
        Toast.show('Account removed');Bus.emit('email:accounts');await boot()}));
    }

    // ---------- boot ----------
    async function boot(preferId){
      if(!Mail.on()){renderNoBridge();return}
      pills.innerHTML='<span class="emdim">loading accounts…</span>';setBusy(true);
      try{accounts=await Mail.accounts()}catch(e){setBusy(false);renderNoBridge(e.message);return}
      setBusy(false);
      if(!accounts.length){pills.innerHTML='<span class="emdim">no accounts</span>';renderAddForm();return}
      acct=accounts.find(a=>a.id===preferId)||accounts.find(a=>a.isDefault)||accounts[0];
      renderPills();
      await loadFolders();
    }
    function renderPills(){
      pills.innerHTML=accounts.map(a=>`<span class="empill ${acct&&a.id===acct.id?'on':''}" data-id="${escAttr(a.id)}" title="${escAttr(a.email+(a.isDefault?' (default)':''))}"><i></i>${escAttr(a.email)}</span>`).join('');
      pills.querySelectorAll('.empill').forEach(el=>el.addEventListener('click',()=>{
        const a=accounts.find(x=>x.id===el.dataset.id);if(!a)return;
        if(acct&&a.id===acct.id){renderAccounts();return} // active pill → manage accounts
        acct=a;folder=null;sel.clear();selMode=false;selBtn.classList.remove('on');updateBulk();renderPills();loadFolders();
      }));
    }
    async function loadFolders(){
      note('loading…');setBusy(true);
      // An authorisation that has run out is not the same failure as a network hiccup, and
      // the owner can only act on one of them. Google expires and revokes refresh tokens
      // routinely (unverified app, password change, 6 months idle) — the panel used to print
      // the vendor's sentence and stop, which reads as "the email is broken" when the fix is
      // thirty seconds away.
      try{folders=await Mail.folders(acct.id)}catch(e){
        setBusy(false);
        const msg=String((e&&e.message)||'');
        if(/expired|revoked|invalid_grant|unauthor|token unavailable|auth/i.test(msg)){
          note('<b>This account needs to sign in again.</b><br>'
            +escHtml(acct.email||'')+' — its authorisation has expired or was revoked.<br><br>'
            +'<span class="dim">Google retires a refresh token on a password change, a permissions review, or six months idle. Nothing here is lost: reconnect and the inbox comes back.</span><br><br>'
            +'<button class="btn acc" id="emreauth">RECONNECT THIS ACCOUNT</button>'
            +'<div class="dim" style="margin-top:10px;font-size:10px">Or connect it as plain <b>IMAP/SMTP</b> with an app password — same screen, and it does not expire.</div>');
          const b=listEl.querySelector('#emreauth');
          if(b)b.addEventListener('click',()=>{openPanel('settings');setTimeout(()=>{const n=document.querySelector('#setnav [data-sec="email"]');if(n)n.click()},90)});
          return;
        }
        note('Could not list the folders: '+escHtml(msg));return;
      }
      setBusy(false);
      folders=folders.slice().sort((a,b)=>{const oa=FMAP[a.specialUse]?FMAP[a.specialUse][1]:50,ob=FMAP[b.specialUse]?FMAP[b.specialUse][1]:50;return oa-ob||fname(a).localeCompare(fname(b))});
      updateCounts();
      const keep=folder&&((folder.__sched||folder.__appr)?folder:folders.find(f=>f.path===folder.path));
      openFolder(keep||folders.find(f=>f.specialUse==='\\Inbox')||folders[0]);
    }
    function updateCounts(){
      const inbox=folders.find(f=>f.specialUse==='\\Inbox');
      const un=inbox?(inbox.unread||0):0;
      unreadEl.style.display=un?'':'none';if(un)unreadEl.textContent=un+' unread';
      countEl.textContent=(folder&&!folder.__sched&&!folder.__appr&&folder.total)?folder.total+' emails':'';
    }
    async function openFolder(f){
      if(!f)return;folder=f;sel.clear();updateBulk();closeMenu();
      foldLbl.textContent=f.specialUse==='\\Inbox'?'INBOX':fname(f);
      if(paneMode==='read')hidePane();
      updateCounts();
      if(f.__sched)return renderScheduled();
      if(f.__appr)return renderApprovals();
      note('loading…');setBusy(true);
      try{msgs=await Mail.list(acct.id,f.path,{limit:60})}catch(e){setBusy(false);note('Error: '+escHtml(e.message));return}
      setBusy(false);updateCounts();renderList();
    }
    function foldMenu(){
      if(!acct||!folders.length){Toast.show('Connect an account first');return}
      const items=folders.map(f=>({html:escHtml(fname(f)),on:folder&&folder.path===f.path,ct:f.unread||null,f}))
        .concat([{hr:true},{html:'⏰ Scheduled',on:folder&&folder.path===SCHED.path,f:SCHED},{html:'✓ Email Approval',on:folder&&folder.path===APPR.path,f:APPR}]);
      menu(foldBtn,items,i=>{if(items[i]&&items[i].f)openFolder(items[i].f)});
    }

    // ---------- scheduled (synthetic folder) ----------
    async function renderScheduled(){
      note('loading…');let items=[];
      try{items=await RPC('scheduled','list',{status:'all'})}catch(e){note('Error: '+escHtml(e.message));return}
      items=items.filter(x=>x.accountId===acct.id);
      if(!items.length){note('No scheduled emails. Write one and use “Schedule send”.');return}
      listEl.innerHTML=items.map(s=>`<div class="emrow"><div class="l1"><span class="s">${escAttr(s.subject||'(no subject)')}</span><span class="badge ${escAttr(s.status)}">${escAttr(s.status)}</span></div>
        <div class="l2"><span style="color:${SPAL[3]}">to ${escHtml(Array.isArray(s.to)?s.to.join(', '):s.to)}</span><span class="d">${fmtDate(s.sendAt)}</span></div>
        <div style="font-size:10px;color:var(--ink-faint);margin-top:2px">${escHtml(String(s.body||'').slice(0,80))}</div>
        ${s.status==='pending'?`<button class="btn mini" data-cancel="${s.id}" style="margin-top:5px">cancel</button>`:''}</div>`).join('');
      listEl.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',async ev=>{ev.stopPropagation();await RPC('scheduled','cancel',b.dataset.cancel);renderScheduled()}));
    }

    // ---------- Email Approval (synthetic folder → approvals queue) ----------
    async function renderApprovals(){
      note('loading…');let items=[];
      try{items=await RPC('approvals','list',{})}catch(e){note('Error: '+escHtml(e.message));return}
      if(!items.length){note('No emails waiting. When the agent drafts a reply (Auto Reply task), it shows up here.');return}
      listEl.innerHTML='<div class="emappr">'+items.map(a=>`<div class="aprow">
        <div class="apmeta"><b>${escAttr(a.subject||'(no subject)')}</b> <span class="badge ${escAttr(a.status)}">${escAttr(a.status)}</span></div>
        <div class="apto">to ${escHtml(Array.isArray(a.to)?a.to.join(', '):(a.to||''))}${a.generatedBy?' · '+escHtml(a.generatedBy):''}</div>
        <textarea class="apbodytext" data-b="${a.id}" ${a.status==='pending'?'':'readonly'}>${escHtml(a.body||'')}</textarea>
        ${a.status==='pending'?`<div class="compose-actions"><button class="btn mini" data-ap="${a.id}">✓ approve and send</button><button class="btn mini" data-ed="${a.id}">save edit</button><button class="btn mini" data-rj="${a.id}">reject</button></div>`:''}</div>`).join('')+'</div>';
      // Same lock as APPROVAL's own button — this is the identical control in a second place.
      listEl.querySelectorAll('[data-ap]').forEach(b=>b.addEventListener('click',async()=>{if(b.disabled)return;b.disabled=true;b.textContent='sending…';let r;try{r=await RPC('approvals','approve',b.dataset.ap)}catch(e){r={ok:false,error:(e&&e.message)||String(e)}}finally{b.disabled=false}Toast.show(r.ok?'Email sent ✉':(r.error||'failed'));renderApprovals()}));
      // The identical pair in APPROVAL was switched to act() because the daemon reports a
      // refusal as {ok:false,error} and does NOT throw. This twin was left behind — and the
      // refusals it hides got MORE common the same day, when approve/reject started refusing
      // any item not in 'pending'.
      listEl.querySelectorAll('[data-rj]').forEach(b=>b.addEventListener('click',async()=>{if(!await act('approvals','reject',b.dataset.rj))return;Toast.show('Rejected');renderApprovals()}));
      listEl.querySelectorAll('[data-ed]').forEach(b=>b.addEventListener('click',async()=>{const ta=listEl.querySelector('[data-b="'+b.dataset.ed+'"]');if(!await act('approvals','edit',b.dataset.ed,{body:ta.value}))return;Toast.show('Edit saved')}));
    }

    // ---------- list (search + filter + select mode) ----------
    function filtered(){
      const s=q.value.trim().toLowerCase();
      return msgs.filter(m=>{
        if(filter==='Unread'&&!m.unread)return false;
        if(filter==='Read'&&m.unread)return false;
        if(filter==='Starred'&&!m.flagged)return false;
        if(filter==='Attachments'&&!m.hasAttachments)return false;
        if(s){const blob=((m.subject||'')+' '+short(m.from)+' '+(m.snippet||'')).toLowerCase();if(!blob.includes(s))return false}
        return true;
      });
    }
    function renderList(){
      inList=true;
      const list=filtered();
      if(!list.length){listEl.innerHTML='<div class="qempty" style="padding:26px 18px">'+(msgs.length?'Nothing matches the search/filter.':'Empty folder.')+'</div>';return}
      listEl.innerHTML=list.map(m=>{const i=msgs.indexOf(m);return `<div class="emrow ${m.unread?'unread':''} ${sel.has(m.uid)?'sel':''}" data-i="${i}">
        <div class="l1">${selMode?`<input type="checkbox" ${sel.has(m.uid)?'checked':''}>`:''}<span class="s">${escHtml(m.subject||'(no subject)')}</span>${m.hasAttachments?'<span class="ic">📎</span>':''}${m.flagged?'<span class="ic" style="color:var(--warn)">★</span>':''}${m.unread?'':'<span class="ic" style="color:var(--ok)">✓</span>'}${m.unread?`<span class="emdot ${m.flagged?'m':'g'}"></span>`:''}</div>
        <div class="l2"><span style="color:${senderColor(m.from)}">${escHtml(short(m.from)||'(no sender)')}</span><span class="d">${fmtDate(m.date)}</span></div></div>`}).join('');
      listEl.querySelectorAll('.emrow').forEach(el=>el.addEventListener('click',()=>{
        const m=msgs[+el.dataset.i];if(!m)return;
        if(selMode){sel.has(m.uid)?sel.delete(m.uid):sel.add(m.uid);renderList();updateBulk();return}
        read(m);
      }));
    }
    function setFilter(f){filter=f;fltLbl.textContent=f;bellB.classList.toggle('on',f==='Unread');readB.classList.toggle('on',f==='Read');attB.classList.toggle('on',f==='Attachments');if(inList)renderList()}
    function updateBulk(){
      if(!selMode||!sel.size){bulk.style.display='none';bulk.innerHTML='';return}
      bulk.style.display='';
      bulk.innerHTML=`<b>${sel.size} selected</b><button class="btn mini" id="embarch">archive</button><button class="btn mini" id="embread">mark read</button><button class="btn mini" id="embdel">delete</button><button class="btn mini" id="embclear" style="margin-left:auto">clear</button>`;
      bulk.querySelector('#embclear').addEventListener('click',()=>{sel.clear();updateBulk();renderList()});
      bulk.querySelector('#embread').addEventListener('click',()=>bulkOp(uid=>Mail.flag(acct.id,folder.path,uid,{seen:true})));
      bulk.querySelector('#embarch').addEventListener('click',()=>{const arch=folders.find(f=>f.specialUse==='\\Archive'||f.specialUse==='\\All');if(!arch){Toast.show('No archive folder');return}bulkOp(uid=>Mail.move(acct.id,folder.path,uid,arch.path))});
      bulk.querySelector('#embdel').addEventListener('click',()=>bulkOp(uid=>{const tr=folders.find(f=>f.specialUse==='\\Trash');return(tr&&tr.path!==folder.path)?Mail.move(acct.id,folder.path,uid,tr.path):Mail.flag(acct.id,folder.path,uid,{deleted:true})}));
    }
    async function bulkOp(fn){
      setBusy(true);
      try{for(const uid of[...sel])await fn(uid);Toast.show('Done ✓')}catch(e){Toast.show(e.message)}
      sel.clear();setBusy(false);updateBulk();loadFolders();
    }

    // ---------- reader (right pane) ----------
    async function read(sum){
      showPane('read');paneEl.innerHTML='<div class="qempty" style="padding:26px">opening…</div>';
      let m;try{m=await Mail.message(acct.id,folder.path,sum.uid)}catch(e){paneEl.innerHTML='<div class="qempty" style="padding:26px;color:var(--accent)">'+escHtml(e.message)+'</div>';return}
      sum.unread=false;lastMsg={sum,m};renderRead();renderList();
    }
    function renderRead(){
      if(!lastMsg){hidePane();return}
      const{sum,m}=lastMsg,h=m.headers||{};
      const bodyHtml=m.html?`<iframe class="mailhtml" sandbox="" srcdoc="${escAttr(m.html)}"></iframe>`:`<pre class="mailtext">${escAttr(m.text||'(no body)')}</pre>`;
      const atts=(m.attachments||[]).map(a=>`<span class="matt">📎 ${escHtml(a.filename||'file')} <span style="color:var(--ink-faint)">${a.size?Math.round(a.size/1024)+'KB':''}</span></span>`).join('');
      paneEl.innerHTML=`<div class="mread">
        <div class="mrhead"><button class="btn mini" id="mrreply">reply</button>
          <button class="btn mini" id="mrfwd">forward</button>
          <button class="btn mini" id="mrstar">${sum.flagged?'★ unstar':'☆ star'}</button>
          <button class="btn mini" id="mrarch">archive</button>
          <button class="btn mini" id="mrdel">delete</button>
          <button class="btn mini" id="mrclose" style="margin-left:auto">✕</button></div>
        <h4>${escHtml(h.subject||'(no subject)')}</h4>
        <div class="meta">from ${escHtml(addr(h.from&&h.from[0])||short(sum.from))} · ${escHtml(fmtDate(h.date||sum.date))}</div>
        <div class="meta" style="margin-top:2px">to ${escHtml((h.to||[]).map(addr).join(', ')||'—')}</div>
        ${atts?`<div class="matts">${atts}</div>`:''}
        <div class="content">${bodyHtml}</div></div>`;
      paneEl.querySelector('#mrclose').addEventListener('click',()=>hidePane());
      paneEl.querySelector('#mrreply').addEventListener('click',()=>compose({to:(h.from&&h.from[0]&&h.from[0].address)||'',subject:/^re:/i.test(h.subject||'')?h.subject:'Re: '+(h.subject||''),inReplyTo:h.messageId,quote:m.text}));
      paneEl.querySelector('#mrfwd').addEventListener('click',()=>compose({subject:/^fwd:/i.test(h.subject||'')?h.subject:'Fwd: '+(h.subject||''),body:'\n\n--- Forwarded message ---\n'+(m.text||'')}));
      paneEl.querySelector('#mrstar').addEventListener('click',async e=>{const nf=!sum.flagged;await Mail.flag(acct.id,folder.path,sum.uid,{flagged:nf});sum.flagged=nf;e.target.textContent=nf?'★ unstar':'☆ star';Toast.show(nf?'Starred':'Star removed');renderList()});
      paneEl.querySelector('#mrarch').addEventListener('click',async()=>{const arch=folders.find(f=>f.specialUse==='\\Archive'||f.specialUse==='\\All');if(!arch){Toast.show('No archive folder');return}await Mail.move(acct.id,folder.path,sum.uid,arch.path);Toast.show('Archived');hidePane();openFolder(folder)});
      paneEl.querySelector('#mrdel').addEventListener('click',async()=>{const tr=folders.find(f=>f.specialUse==='\\Trash');if(tr&&tr.path!==folder.path){await Mail.move(acct.id,folder.path,sum.uid,tr.path)}else{await Mail.flag(acct.id,folder.path,sum.uid,{deleted:true})}Toast.show('Moved to trash');hidePane();openFolder(folder)});
    }

    // ---------- compose (right pane, tab strip like the spec) ----------
    function compose(pre){
      pre=pre||{};
      const quoted=pre.quote?('\n\n> '+String(pre.quote).split('\n').slice(0,12).join('\n> ')):'';
      const d={id:++draftSeq,to:pre.to||'',cc:'',subject:pre.subject||'',body:(pre.body||'')+quoted,inReplyTo:pre.inReplyTo||null,showCc:false};
      drafts.push(d);active=d;renderCompose();
    }
    function closeDraft(d){
      const i=drafts.indexOf(d);if(i>-1)drafts.splice(i,1);
      if(active===d)active=drafts[drafts.length-1]||null;
      if(active)renderCompose();else if(lastMsg){showPane('read');renderRead()}else hidePane();
    }
    function renderCompose(){
      if(!active)return;
      showPane('compose');
      paneEl.innerHTML=`
        <div class="emtabs">${drafts.map(d=>`<div class="emtab ${d===active?'on':''}" data-t="${d.id}"><span class="v">v${d.id}</span><span>${escHtml(d.subject?d.subject.slice(0,18):'New Email')}</span><i class="x" data-x="${d.id}">✕</i></div>`).join('')}<button class="emtabadd" id="emtadd" title="new draft">＋</button></div>
        <div class="emform">
          <div class="emtorow"><input id="cto" placeholder="recipient@example.com" value="${escAttr(active.to)}" autocomplete="off" spellcheck="false"><span class="emcclink" id="ccl">Cc</span></div>
          <input id="ccc" placeholder="Cc" value="${escAttr(active.cc)}" style="display:${active.showCc||active.cc?'':'none'}" autocomplete="off" spellcheck="false">
          <input id="csub" placeholder="Subject" value="${escAttr(active.subject)}" autocomplete="off">
          <div class="emtb">
            <button class="emtbb" id="tbai" title="AI drafts the email">＋Reply</button><span class="emtbsep"></span>
            <button class="emtbb" id="tbT" title="text size — plain-text compose">T</button>
            <button class="emtbb" data-w="B" style="font-weight:700" title="bold">B</button>
            <button class="emtbb" data-w="I" style="font-style:italic" title="italic">I</button>
            <button class="emtbb" data-w="S" style="text-decoration:line-through" title="strikethrough">S</button>
            <button class="emtbb" data-w="H" title="heading">H▾</button>
            <button class="emtbb" data-w="OL" title="numbered list">1.</button>
            <button class="emtbb" data-w="LNK" title="link">🔗</button>
            <button class="emtbb" id="tbatt" title="attach">📎</button>
            <span class="emtbsep"></span>
            <button class="emtbb" id="tbemo" title="emoji">🙂</button>
          </div>
          <div class="ememo" id="ememo" style="display:none">${EMO.map(e2=>`<button class="ememoji" data-e="${e2}">${e2}</button>`).join('')}</div>
          <textarea id="cbody" placeholder="Write your email...">${escHtml(active.body)}</textarea>
          <div id="cmsg" style="font-size:10px;min-height:13px"></div>
          <div class="emschedrow" id="cschedrow" style="display:none"><span>Send at</span><input id="cwhen" type="datetime-local" style="flex:0 0 auto"><button class="btn mini" id="cschedok">SCHEDULE</button><button class="btn mini" id="cschedno">cancel</button></div>
        </div>
        <div class="emfoot">
          <button class="btn" id="cclose">CLOSE</button>
          <span class="emdim">from ${escHtml(acct?acct.email:'—')}</span>
          <div class="emsendwrap"><button class="emsend" id="csend">➤ SEND</button><button class="emsendcv" id="csendcv" title="send options">▾</button></div>
        </div>`;
      const g=id=>paneEl.querySelector('#'+id);
      const cmsg=(t,err)=>{const el=g('cmsg');if(el){el.style.color=err?'var(--accent)':'var(--ink-faint)';el.textContent=t}};
      // tab strip
      paneEl.querySelectorAll('.emtab').forEach(el=>el.addEventListener('click',ev=>{
        if(ev.target.dataset.x){closeDraft(drafts.find(d=>d.id===+ev.target.dataset.x));return}
        const d=drafts.find(x=>x.id===+el.dataset.t);if(d&&d!==active){active=d;renderCompose()}
      }));
      g('emtadd').addEventListener('click',()=>compose());
      // field ↔ draft sync (tab switching keeps state)
      [['cto','to'],['ccc','cc'],['csub','subject'],['cbody','body']].forEach(([id,k])=>g(id).addEventListener('input',()=>{active[k]=g(id).value}));
      g('ccl').addEventListener('click',()=>{active.showCc=!active.showCc;g('ccc').style.display=active.showCc?'':'none'});
      // formatting toolbar (markdown on plain text)
      const ta=g('cbody');
      function wrapSel(b,a){const s=ta.selectionStart,e2=ta.selectionEnd,v=ta.value;ta.value=v.slice(0,s)+b+v.slice(s,e2)+a+v.slice(e2);active.body=ta.value;ta.focus();ta.setSelectionRange(s+b.length,e2+b.length)}
      function prefixLines(fn){const s=ta.selectionStart,e2=ta.selectionEnd,v=ta.value;const a=v.lastIndexOf('\n',s-1)+1;const seg=v.slice(a,e2);ta.value=v.slice(0,a)+seg.split('\n').map(fn).join('\n')+v.slice(e2);active.body=ta.value;ta.focus()}
      paneEl.querySelectorAll('[data-w]').forEach(b=>b.addEventListener('click',()=>{
        const w=b.dataset.w;
        if(w==='B')wrapSel('**','**');else if(w==='I')wrapSel('*','*');else if(w==='S')wrapSel('~~','~~');
        else if(w==='H')prefixLines(l=>'# '+l);else if(w==='OL')prefixLines((l,i)=>(i+1)+'. '+l);
        else if(w==='LNK')wrapSel('[','](https://)');
      }));
      g('tbT').addEventListener('click',()=>Toast.show('Plain-text compose — markdown supported'));
      g('tbatt').addEventListener('click',()=>Toast.show('Attachments — coming soon'));
      g('tbemo').addEventListener('click',()=>{const r=g('ememo');r.style.display=r.style.display==='none'?'':'none'});
      paneEl.querySelectorAll('.ememoji').forEach(b=>b.addEventListener('click',()=>wrapSel(b.dataset.e,'')));
      // AI draft (kept behavior)
      g('tbai').addEventListener('click',async()=>{
        const topic=(active.subject||'our work on CLONE FRAME').trim();
        ta.value='';ta.placeholder='AI drafting…';
        // Brain.stream throws when a configured provider fails — it no longer hides the
        // failure behind demo prose, so the draft button has to say what went wrong.
        try{
          await Brain.stream([{role:'user',content:'Write a professional, warm email, ~100 words, in English, about: '+topic+'. Sign as iCLONE — CLONE FRAME. Return only the email body.'}],t=>{ta.value+=t;active.body=ta.value;ta.scrollTop=ta.scrollHeight},null);
        }catch(e){
          const msg=friendlyErr((e&&e.message)||'draft failed');
          Toast.show('Draft failed — '+msg);
        }finally{ta.placeholder='Write your message…'}
      });
      // send / via approval / schedule
      // Two entry points reach this — the SEND button and the ⌄ menu's "Send now" — and
      // neither disabled anything, while the compose pane stayed on screen for the whole SMTP
      // round trip. One flag covers both, because a lock on one button is not a lock.
      let sending=false;
      async function doSend(){
        const d=active;
        if(sending)return;
        if(!d.to.trim()){cmsg('Missing recipient',1);return}
        sending=true;const btn=g('csend');if(btn)btn.disabled=true;
        cmsg('sending…');
        try{const r=await Mail.send(acct.id,{to:d.to,cc:d.cc||undefined,subject:d.subject,text:d.body,inReplyTo:d.inReplyTo||undefined});
          if(r.ok){Toast.show('Email sent ✉');closeDraft(d);const sent=folders.find(f=>f.specialUse==='\\Sent');openFolder(sent||folder)}
          else cmsg('✗ '+(r.error||'failed'),1)}
        catch(e){cmsg('✗ '+e.message,1)}
        finally{sending=false;const b2=g('csend');if(b2)b2.disabled=false}
      }
      // Into the REAL queue — the one bridge/approvals.mjs owns and the APPROVAL panel
      // reads. This used to call a browser-only Approvals.propose(), so a message sent
      // "via approval" landed in a store nothing else could see: it never appeared in
      // APPROVAL, and approving it there could never have sent it.
      async function viaApproval(){
        const d=active;
        if(!d.to.trim()){cmsg('Missing recipient',1);return}
        if(!d.body||!d.body.trim()){cmsg('Nothing to approve — the message is empty',1);return}
        let r;
        try{r=await RPC('approvals','add',{type:'ai_email',accountId:acct.id,
          to:d.to.split(',').map(s=>s.trim()).filter(Boolean),
          subject:d.subject||'',body:d.body,generatedBy:'you'})}
        catch(e){r={ok:false,error:(e&&e.message)||String(e)}}
        if(!r||r.ok===false){cmsg('✗ '+((r&&r.error)||'could not queue it'),1);return}
        Caps.set('automations',1);
        Bus.emit('approvals:changed');
        closeDraft(d);
        Toast.show('Waiting for your approval — open APPROVAL to send it');
      }
      g('csend').addEventListener('click',doSend);
      g('csendcv').addEventListener('click',()=>menu(g('csendcv'),[{html:'➤ Send now'},{html:'🛡 Via approval'},{html:'⏰ Schedule send…'}],i=>{
        if(i===0)doSend();else if(i===1)viaApproval();else g('cschedrow').style.display='';
      }));
      g('cschedno').addEventListener('click',()=>{g('cschedrow').style.display='none'});
      g('cschedok').addEventListener('click',async()=>{
        const d=active;
        if(!d.to.trim()){cmsg('Missing recipient',1);return}
        const when=g('cwhen').value;if(!when){cmsg('Choose the date/time',1);return}
        try{const r=await RPC('scheduled','schedule',{accountId:acct.id,to:d.to,cc:d.cc||undefined,subject:d.subject,body:d.body,sendAt:new Date(when).toISOString()});
          if(r.ok){Toast.show('Email scheduled ⏰');closeDraft(d);openFolder(SCHED)}else cmsg('✗ '+(r.error||'failed'),1)}
        catch(e){cmsg('✗ '+e.message,1)}
      });
      g('cclose').addEventListener('click',()=>closeDraft(active));
    }

    // ---------- top controls ----------
    newBtn.addEventListener('click',()=>{
      if(!Mail.on()){openPanel('machine');return}
      if(!acct){Toast.show('Connect an account first');renderAddForm();return}
      compose();
    });
    foldBtn.addEventListener('click',foldMenu);
    fltBtn.addEventListener('click',()=>menu(fltBtn,FILTERS.map(f=>({html:f,on:f===filter})),i=>setFilter(FILTERS[i])));
    bellB.addEventListener('click',()=>setFilter(filter==='Unread'?'All':'Unread'));
    readB.addEventListener('click',()=>setFilter(filter==='Read'?'All':'Read'));
    attB.addEventListener('click',()=>setFilter(filter==='Attachments'?'All':'Attachments'));
    selBtn.addEventListener('click',()=>{
      if(!acct||!folder||folder.__sched||folder.__appr){Toast.show('Open a folder first');return}
      selMode=!selMode;sel.clear();selBtn.classList.toggle('on',selMode);updateBulk();renderList();
    });
    refreshBtn.addEventListener('click',()=>{if(Mail.on()&&acct&&folder)loadFolders();else boot()});
    q.addEventListener('input',()=>{clearTimeout(q._t);q._t=setTimeout(()=>{if(inList)renderList()},200)});
    panelBus(p).on('bridge:changed',()=>{boot()});
    // SETTINGS is the other door onto the same account list. Removing an account there
    // must not leave this panel showing it.
    panelBus(p).on('email:accounts',()=>{boot()});
    boot();
  }
