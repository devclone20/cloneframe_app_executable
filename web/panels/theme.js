  function wireTheme(p){
    const body=p.querySelector('#thpbody');
    const VARS=['bg','fg','panel','border','accent'];
    const cur=()=>{const cs=getComputedStyle(document.documentElement);const o={};VARS.forEach(k=>o[k]=cs.getPropertyValue('--'+k).trim());return o};
    const hexToHsl=hex=>{let r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h=0,sa=0,l=(mx+mn)/2;if(mx!==mn){const d=mx-mn;sa=l>0.5?d/(2-mx-mn):d/(mx+mn);h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4);h*=60}return[h,sa*100,l*100]};
    const hsl=(h,sx,l)=>`hsl(${Math.round((h+360)%360)},${Math.round(sx)}%,${Math.round(l)}%)`;
    function renderThemes(){
      const c=Store.get().theme,ALL=Themes.all(),customs=Object.keys(Store.get().customThemes||{});
      const sw=(n,rm)=>{const t=ALL[n];if(!t)return'';return `<div class="thp-sw ${n===c?'on':''}" data-th="${n}">${rm?`<span class="del" data-rm="${n}">✕</span>`:''}<div class="thp-dots"><i style="background:${t.bg}"></i><i style="background:${t.panel}"></i><i style="background:${t.accent}"></i></div><span>${n}</span></div>`};
      body.innerHTML='<div class="thp-card"><h4>DEFAULT THEMES</h4><div class="thp-grid">'
        +['void','origin','kernel','forge','soul','graphite','neon','synapse','constellation','flux','embers','stardust'].map(n=>sw(n)).join('')+'</div>'
        +(customs.length?'<h4 style="margin-top:12px">YOUR THEMES</h4><div class="thp-grid">'+customs.map(n=>sw(n,true)).join('')+'</div>':'')+'</div>';
      body.querySelectorAll('.thp-sw').forEach(el=>el.addEventListener('click',e=>{
        if(e.target.dataset.rm){Themes.remove(e.target.dataset.rm);renderThemes();return}
        Themes.apply(el.dataset.th);renderThemes();
      }));
    }
    function renderCustomize(){
      const v=cur(),live=['neon','synapse','constellation','flux','embers','stardust'];
      const dens=Store.get().density||'cosy';
      body.innerHTML=`
        <div class="thp-card"><h4>COLORS</h4><div class="thp-cols">
          ${[['bg','Background'],['fg','Text'],['panel','Panel'],['border','Border'],['accent','Accent']].map(x=>`<div class="thp-row"><label>${x[1]}</label><input type="color" data-k="${x[0]}" value="${toHex(v[x[0]])}"></div>`).join('')}
        </div></div>
        <div class="thp-card"><h4>COLOR HARMONY</h4>
          <div class="thp-row"><label>Accent Color</label><input type="color" id="thacc" value="${toHex(v.accent)}"><span class="thp-hex" id="thhex">${toHex(v.accent)}</span></div>
          <div class="thp-row"><label>Harmony</label><select id="thharm"><option>Complementary</option><option>Analogous</option><option>Triadic</option></select></div>
          <div class="thp-row"><label>Mode</label><select id="thmode"><option>Dark</option><option>Light</option></select></div>
          <div class="thp-row"><span style="flex:1"></span><button class="btn" id="thgen">GENERATE</button></div>
        </div>
        <div class="thp-card"><h4>FONT &amp; LAYOUT</h4>
          <div class="thp-row"><label>Font</label><select id="thfont"><option>Monospace</option><option>System</option></select></div>
          <div class="thp-row"><label>Density</label><select id="thdens">${['compact','cosy','comfy'].map(d=>`<option ${d===dens?'selected':''}>${d}</option>`).join('')}</select></div>
          <div class="thp-row"><label>Frosted</label><div class="sw3 ${document.documentElement.classList.contains('frosted')?'on':''}" id="thfrost"><i></i></div></div>
          <div class="thp-row"><label>Background / Effect</label><select id="theff"><option>Solid</option>${live.map(n=>`<option ${Store.get().theme===n?'selected':''}>${n}</option>`).join('')}</select></div>
        </div>
        <div class="thp-card"><h4>SAVE / SHARE</h4>
          <div class="thp-row"><input type="text" id="thname" placeholder="Theme name..." style="flex:1"><button class="btn" id="thsave">SAVE</button></div>
          <div class="thp-row"><button class="btn" id="thimp" style="flex:1">↑ IMPORT</button><button class="btn" id="thexp" style="flex:1">↓ EXPORT</button></div>
        </div>
        <button class="btn" id="threset" style="width:100%;box-sizing:border-box">RESET TO DEFAULT</button>`;
      body.querySelectorAll('input[type=color][data-k]').forEach(i=>i.addEventListener('input',()=>{document.documentElement.style.setProperty('--'+i.dataset.k,i.value);if(i.dataset.k==='accent'){const a=body.querySelector('#thacc');if(a)a.value=i.value;body.querySelector('#thhex').textContent=i.value}}));
      body.querySelector('#thacc').addEventListener('input',e=>{body.querySelector('#thhex').textContent=e.target.value});
      body.querySelector('#thgen').addEventListener('click',()=>{
        const acc=body.querySelector('#thacc').value,[h]=hexToHsl(acc);
        const harm=body.querySelector('#thharm').value,dark=body.querySelector('#thmode').value==='Dark';
        const h2=harm==='Complementary'?h+180:harm==='Analogous'?h+30:h+120;
        const def=dark?{bg:hsl(h2,18,6),panel:hsl(h2,16,10),fg:hsl(h2,10,92),border:hsl(h2,12,22),accent:acc}
                      :{bg:hsl(h2,22,96),panel:hsl(h2,18,90),fg:hsl(h2,16,12),border:hsl(h2,12,72),accent:acc};
        Object.entries(def).forEach(([k,val])=>document.documentElement.style.setProperty('--'+k,val));
        renderCustomize();Toast.show('Palette generated — SAVE to keep it');
      });
      body.querySelector('#thfont').addEventListener('change',e=>{document.body.style.fontFamily=e.target.value==='System'?'-apple-system,BlinkMacSystemFont,sans-serif':''});
      body.querySelector('#thdens').addEventListener('change',e=>Density.apply(e.target.value));
      body.querySelector('#thfrost').addEventListener('click',e=>{const el=e.currentTarget;const on=!el.classList.contains('on');el.classList.toggle('on',on);document.documentElement.classList.toggle('frosted',on)});
      body.querySelector('#theff').addEventListener('change',e=>{if(e.target.value!=='Solid'){Themes.apply(e.target.value)}else{Themes.apply('void')}renderCustomize()});
      body.querySelector('#thsave').addEventListener('click',()=>{
        const name=(body.querySelector('#thname').value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'')||'my-theme');
        const v2=cur(),def={};VARS.forEach(k=>def[k]=toHex(v2[k]));
        if(Themes.register(name,def)){Toast.show('Theme "'+name.toUpperCase()+'" saved')}else Toast.show('Reserved name or 8-custom-theme limit');
      });
      body.querySelector('#thexp').addEventListener('click',()=>{
        const v2=cur(),def={};VARS.forEach(k=>def[k]=toHex(v2[k]));
        const blob=new Blob([JSON.stringify({name:Store.get().theme,def},null,2)],{type:'application/json'});
        const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='clone-frame-theme.json';a.click();
      });
      body.querySelector('#thimp').addEventListener('click',()=>{
        const inp=document.createElement('input');inp.type='file';inp.accept='application/json';
        inp.onchange=()=>{const f=inp.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{try{const o=JSON.parse(rd.result);const nm=(o.name||'imported').toLowerCase().replace(/[^a-z0-9-]/g,'');if(Themes.register(nm,o.def||{})){Themes.apply(nm);Toast.show('Theme imported: '+nm.toUpperCase());renderCustomize()}else Toast.show('Import failed — name reserved or limit reached')}catch(_){Toast.show('Invalid theme file')}};rd.readAsText(f)};
        inp.click();
      });
      body.querySelector('#threset').addEventListener('click',()=>{
        VARS.forEach(k=>document.documentElement.style.removeProperty('--'+k));
        document.body.style.fontFamily='';document.documentElement.classList.remove('frosted');
        Density.apply('cosy');Themes.apply('void');renderCustomize();Toast.show('Reset to default');
      });
    }
    function toHex(c){
      c=(c||'').trim();
      if(c.startsWith('#'))return c.length===4?'#'+[...c.slice(1)].map(x=>x+x).join(''):c.slice(0,7);
      const m=c.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
      if(m)return '#'+[m[1],m[2],m[3]].map(x=>(+x).toString(16).padStart(2,'0')).join('');
      const el=document.createElement('i');el.style.color=c;document.body.appendChild(el);
      const rgb=getComputedStyle(el).color;el.remove();
      const m2=rgb.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
      return m2?'#'+[m2[1],m2[2],m2[3]].map(x=>(+x).toString(16).padStart(2,'0')).join(''):'#000000';
    }
    p.querySelectorAll('.thp-tab').forEach(t=>t.addEventListener('click',()=>{
      p.querySelectorAll('.thp-tab').forEach(x=>x.classList.toggle('on',x===t));
      t.dataset.t==='themes'?renderThemes():renderCustomize();
    }));
    panelBus(p).on('theme',()=>{if(p.querySelector('.thp-tab.on')?.dataset.t==='themes')renderThemes()});
    renderThemes();
  }
