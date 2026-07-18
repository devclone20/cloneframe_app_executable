// Isolated test of the Phase 3.2 canvas math — copied VERBATIM from index.html.
// Proves the zoom/overview/reveal/snap arithmetic (where real bugs would live).
const clampN=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const CZMIN=.25,CZMAX=3;
let ok=0,fail=0;
const near=(a,b,eps=1e-6)=>Math.abs(a-b)<eps;
const t=(name,cond)=>{if(cond){ok++}else{fail++;console.log('  ✗ '+name)}};

// --- canvasZoomBy: keep the point under the cursor fixed while zooming ---
function zoomBy(state,f,cx,cy,g){
  const z0=state.zoom,z=clampN(z0*f,CZMIN,CZMAX),p=state.pan;
  const pan={x:cx-(cx-p.x)*(z/z0),y:cy-(cy-p.y)*(z/z0)};
  return {zoom:z,pan};
}
{
  // world point under cursor must map to the same screen point after zoom
  const g={width:1000,height:600};
  let s={zoom:1,pan:{x:0,y:0}};
  const cx=400,cy=300;
  const worldBefore={x:(cx-s.pan.x)/s.zoom,y:(cy-s.pan.y)/s.zoom};
  s=zoomBy(s,1.2,cx,cy,g);
  const screenAfter={x:worldBefore.x*s.zoom+s.pan.x,y:worldBefore.y*s.zoom+s.pan.y};
  t('zoom keeps cursor point fixed (x)',near(screenAfter.x,cx));
  t('zoom keeps cursor point fixed (y)',near(screenAfter.y,cy));
  t('zoom respects max clamp',zoomBy({zoom:2.9,pan:{x:0,y:0}},2,0,0,g).zoom===CZMAX);
  t('zoom respects min clamp',zoomBy({zoom:.3,pan:{x:0,y:0}},.1,0,0,g).zoom===CZMIN);
}

// --- canvasBBox + canvasOverview: fit all panes centered ---
function bbox(rects){let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;rects.forEach(r=>{x0=Math.min(x0,r.x);y0=Math.min(y0,r.y);x1=Math.max(x1,r.x+r.w);y1=Math.max(y1,r.y+r.h)});return{x0,y0,x1,y1}}
function overview(rects,g){
  const bb=bbox(rects);
  const bw=(bb.x1-bb.x0)*g.width,bh=(bb.y1-bb.y0)*g.height;
  const z=clampN(Math.min(g.width/(bw||1),g.height/(bh||1))*.88,CZMIN,CZMAX);
  const cwx=(bb.x0+bb.x1)/2*g.width,cwy=(bb.y0+bb.y1)/2*g.height;
  return {zoom:z,pan:{x:g.width/2-cwx*z,y:g.height/2-cwy*z}};
}
{
  const g={width:1000,height:600};
  // two panes spread across the space
  const rects=[{x:.05,y:.05,w:.4,h:.5},{x:.55,y:.45,w:.4,h:.5}];
  const o=overview(rects,g);
  // the bbox center must land at the viewport center
  const bb=bbox(rects);
  const cwx=(bb.x0+bb.x1)/2*g.width,cwy=(bb.y0+bb.y1)/2*g.height;
  const sx=cwx*o.zoom+o.pan.x,sy=cwy*o.zoom+o.pan.y;
  t('overview centers bbox horizontally',near(sx,g.width/2));
  t('overview centers bbox vertically',near(sy,g.height/2));
  // everything must fit within the viewport (with the .88 margin)
  const left=bb.x0*g.width*o.zoom+o.pan.x,right=(bb.x1*g.width)*o.zoom+o.pan.x;
  t('overview fits left edge',left>=-1);
  t('overview fits right edge',right<=g.width+1);
  t('overview zoom in range',o.zoom>=CZMIN&&o.zoom<=CZMAX);
}

// --- canvasReveal: focused pane center at viewport center, zoom>=1 ---
function reveal(rect,curZoom,g){
  const z=Math.max(curZoom,1);
  const cwx=(rect.x+rect.w/2)*g.width,cwy=(rect.y+rect.h/2)*g.height;
  return {zoom:z,pan:{x:g.width/2-cwx*z,y:g.height/2-cwy*z}};
}
{
  const g={width:1000,height:600};
  const r={x:.6,y:.1,w:.3,h:.3};
  const rv=reveal(r,.5,g);
  const cwx=(r.x+r.w/2)*g.width,cwy=(r.y+r.h/2)*g.height;
  t('reveal centers pane (x)',near(cwx*rv.zoom+rv.pan.x,g.width/2));
  t('reveal centers pane (y)',near(cwy*rv.zoom+rv.pan.y,g.height/2));
  t('reveal forces zoom>=1',rv.zoom>=1);
}

// --- snapPane: edges snap to a neighbour within threshold ---
function snap(r,others){
  const T=.014,edgesX=[0,1],edgesY=[0,1];
  others.forEach(o=>{edgesX.push(o.x,o.x+o.w);edgesY.push(o.y,o.y+o.h)});
  const nearE=(v,arr)=>{let b=null,bd=T;arr.forEach(e=>{const d=Math.abs(v-e);if(d<bd){bd=d;b=e}});return b};
  const l=nearE(r.x,edgesX),rt=nearE(r.x+r.w,edgesX),tp=nearE(r.y,edgesY),bt=nearE(r.y+r.h,edgesY);
  const out={...r};
  if(l!=null)out.x=l;else if(rt!=null)out.x=rt-r.w;
  if(tp!=null)out.y=tp;else if(bt!=null)out.y=bt-r.h;
  return out;
}
{
  const other={x:.5,y:0,w:.4,h:.5};
  // a pane whose right edge is 0.008 from other's left edge (0.5) → should snap
  const dragged={x:.10,y:.2,w:.392,h:.3}; // right edge = 0.492, 0.008 from 0.5
  const s=snap(dragged,[other]);
  t('snap aligns right edge to neighbour',near(s.x+s.w,.5));
  // a pane far from any edge → unchanged
  const far={x:.2,y:.2,w:.2,h:.2};
  const s2=snap(far,[other]);
  t('snap leaves far pane unchanged',near(s2.x,.2)&&near(s2.y,.2));
  // left edge near space border (0) → snaps to 0
  const border={x:.006,y:.3,w:.3,h:.3};
  t('snap aligns to space border',near(snap(border,[]).x,0));
}

// --- tidyCanvas: N panes into a grid, no overlaps, all in bounds ---
function tidy(n){
  const cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols),gap=.012,out=[];
  for(let i=0;i<n;i++){const c=i%cols,r=Math.floor(i/cols);
    out.push({x:gap+c*(1-gap)/cols,y:gap+r*(1-gap)/rows,w:(1-gap)/cols-gap,h:(1-gap)/rows-gap})}
  return out;
}
{
  for(const n of [1,2,3,4,5,9]){
    const g=tidy(n);
    t('tidy '+n+' produces N rects',g.length===n);
    t('tidy '+n+' all in bounds',g.every(r=>r.x>=0&&r.y>=0&&r.x+r.w<=1.001&&r.y+r.h<=1.001));
    // no two rects overlap
    let overlap=false;
    for(let i=0;i<g.length;i++)for(let j=i+1;j<g.length;j++){const a=g[i],b=g[j];
      if(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h)overlap=true}
    t('tidy '+n+' no overlaps',!overlap);
  }
}

console.log(`\ncanvas math: ${ok} passed, ${fail} failed`);
process.exit(fail?1:0);
