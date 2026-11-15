// SPDX-License-Identifier: CPAL-1.0
/* 可注入的几何探针；保留视觉基线算法与结果结构。 */
(function(){
  var DEFAULT_SELECTORS={
    card:'[data-g5="card"]',container:'[data-g5="card"],[data-g5="float"]',align:'.g5-al',
    railOverflow:'.g5-rail,.g5-ri',internalHost:'.g5-lwc-host',overlay:'.g5-ov',mark:'.g5-ov g',
    graphic:'.g5-venue,.g5-mk,.g5-alogo,.g5-sw,.g5-cb i,.g5-ptag,.g5-readout,.g5-fuse',
    nonLeaf:'.g5-venue,.g5-readout,.g5-ptag',layer:'svg.g5-layer'
  };
  var FS=[11,12,13,14,16,20,36];
  function nm(el){var c=(typeof el.className==='string'&&el.className.trim())?'.'+el.className.trim().split(/\s+/).join('.'):'';return el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+c;}
  function path(el){var p=[];for(var e=el;e&&e!==document.body&&p.length<4;e=e.parentElement)p.unshift(nm(e));return p.join('>');}
  function textNodes(el){return Array.prototype.filter.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim();});}
  function trect(n){var r=document.createRange();r.selectNodeContents(n);return r.getBoundingClientRect();}
  function internal(el,selectors){var h=el.closest(selectors.internalHost);return !!(h&&h!==el&&!el.closest(selectors.overlay));}
  function run(options){
    var selectors=Object.assign({},DEFAULT_SELECTORS,options&&options.selectors||{});
    var out={w:innerWidth,h:innerHeight,docScrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      overflow:[],truncated:[],halfRows:[],escape:[],overlap:[],fontSizes:{},badFont:[],badSpace:[],align:[],numcol:[],numcolOk:0,alignOk:0};
    var els=document.querySelectorAll('body *');
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.closest('svg')||/^(SCRIPT|STYLE|TEMPLATE|CANVAS)$/.test(el.tagName))continue;
      var cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden'||!el.getClientRects().length)continue;
      if(internal(el,selectors))continue;
      // 1 横向溢出
      // 图标栏与其项目的溢出只来自名称提示浮层（绝对定位、浮在内容上），不算版面溢出
      if(cs.display!=='inline'&&el.clientWidth>0&&el.scrollWidth>el.clientWidth+0.5&&!el.matches(selectors.railOverflow))out.overflow.push(path(el)+' '+el.scrollWidth+'>'+el.clientWidth);
      // 4 间距 4 的倍数
      var sm=el.computedStyleMap?el.computedStyleMap():null;
      ['padding-top','padding-right','padding-bottom','padding-left','margin-top','margin-right','margin-bottom','margin-left','row-gap','column-gap'].forEach(function(p){
        var v=sm?String(sm.get(p)):cs.getPropertyValue(p);if(!v||v==='normal'||v==='auto')return;var n=parseFloat(v);if(n&&Math.abs(Math.round(n*100)/100)%4!==0)out.badSpace.push(path(el)+' '+p+'='+v);});
      var tn=textNodes(el);
      if(!tn.length)continue;
      // 3 字号白名单
      var fs=Math.round(parseFloat(cs.fontSize)*100)/100;out.fontSizes[fs]=(out.fontSizes[fs]||0)+1;
      if(FS.indexOf(fs)<0)out.badFont.push(path(el)+' '+fs);
      // 2 文字截断：ellipsis 生效，或文字被任何 overflow 非 visible 的祖先 / 视口横向裁切；纵向被不可滚动容器裁切
      if(cs.textOverflow==='ellipsis'&&el.scrollWidth>el.clientWidth)out.truncated.push('ellipsis '+path(el));
      tn.forEach(function(t){
        var r=trect(t);if(!r.width)return;
        if(r.right>innerWidth+0.5||r.left<-0.5)out.truncated.push('viewport-x '+path(el)+' "'+t.textContent.trim().slice(0,24)+'"');
        for(var a=el.parentElement;a&&a!==document.documentElement;a=a.parentElement){
          var ac=getComputedStyle(a);var ox=ac.overflowX!=='visible',oy=ac.overflowY!=='visible';if(!ox&&!oy)continue;
          var ar=a.getBoundingClientRect();
          var L=ar.left+a.clientLeft,R=L+a.clientWidth,T=ar.top+a.clientTop,B=T+a.clientHeight;
          if(r.bottom<=T||r.top>=B||r.right<=L||r.left>=R)break; // 已被该容器整体裁掉（滚出视野），不再往外查
          if(ox&&(r.left<L-0.5||r.right>R+0.5)&&r.bottom>T&&r.top<B)out.truncated.push('clip-x '+path(el)+' by '+nm(a)+' "'+t.textContent.trim().slice(0,24)+'"');
          if(oy&&r.top<B&&r.bottom>T&&(r.top<T-0.5||r.bottom>B+0.5)){
            if(ac.overflowY==='auto'||ac.overflowY==='scroll')out.halfRows.push(path(el)+' in '+nm(a)+' "'+t.textContent.trim().slice(0,24)+'"');
            else out.truncated.push('clip-y '+path(el)+' by '+nm(a)+' "'+t.textContent.trim().slice(0,24)+'"');
          }
        }
      });
    }
    // 5 卡内左缘共线：.al 标记的元素，取首个文字（或元素本身）左缘距所在 .card 左缘 = 20
    document.querySelectorAll(selectors.align).forEach(function(el){
      var card=el.closest(selectors.container);if(!card||getComputedStyle(el).display==='none'||!el.offsetParent)return;
      var f=Array.prototype.filter.call(el.childNodes,function(n){return (n.nodeType===3&&n.textContent.trim())||(n.nodeType===1&&getComputedStyle(n).display!=='none');})[0];
      var x=(f?(f.nodeType===3?trect(f):f.getBoundingClientRect()):el.getBoundingClientRect()).left-card.getBoundingClientRect().left;
      if(Math.abs(x-20)>0.5)out.align.push(path(el)+' x='+x.toFixed(2));else out.alignOk++;
    });
    // 6 数字列右缘共线：[data-n] 同组（所在 [data-nscope] 或 .card 内同 key）文字右缘一致
    var groups={};
    document.querySelectorAll('[data-n]').forEach(function(el){
      var sc=el.closest('[data-nscope]')||el.closest(selectors.container);if(!sc||!el.offsetParent)return;
      if(!sc.__id)sc.__id='s'+Math.random().toString(36).slice(2,7);
      var t=textNodes(el);var r=t.length?trect(t[t.length-1]):el.getBoundingClientRect();
      var k=sc.__id+':'+el.getAttribute('data-n');(groups[k]=groups[k]||{name:nm(sc)+' / '+el.getAttribute('data-n'),xs:[]}).xs.push(r.right);
    });
    Object.keys(groups).forEach(function(k){var g=groups[k];if(g.xs.length<2)return;var d=Math.max.apply(null,g.xs)-Math.min.apply(null,g.xs);
      if(d>0.5)out.numcol.push(g.name+' spread='+d.toFixed(2));else out.numcolOk++;});
    // 7 越出所在卡片 / 元素重叠（卡片内文字与图形两两不相交；卡片之间不相交，浮层除外）
    function vis(el){var c=getComputedStyle(el);return c.display!=='none'&&c.visibility!=='hidden'&&el.getClientRects().length>0;}
    function clippedWithin(el,sc){for(var a=el.parentElement;a&&a!==sc;a=a.parentElement){var c=getComputedStyle(a);if(c.overflowX!=='visible'||c.overflowY!=='visible')return true;}return false;}
    // 滚动区里滚出可视范围的部分不算重叠（与上面越出的 clippedWithin 同一口径）：按卡内各裁切祖先把矩形裁一遍，裁空的不参与
    function clipTo(el,sc,r){for(var a=el.parentElement;a&&a!==sc;a=a.parentElement){var c=getComputedStyle(a);if(c.overflowX!=='visible'||c.overflowY!=='visible'){var b=a.getBoundingClientRect();r={left:Math.max(r.left,b.left),right:Math.min(r.right,b.right),top:Math.max(r.top,b.top),bottom:Math.min(r.bottom,b.bottom)};}}return r;}
    function inter(a,b){var w=Math.min(a.right,b.right)-Math.max(a.left,b.left),h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);return w>1&&h>1;}
    document.querySelectorAll(selectors.container).forEach(function(sc){
      if(!vis(sc))return;var cr=sc.getBoundingClientRect();var items=[];
      sc.querySelectorAll('*').forEach(function(el){
        var isMark=el.matches(selectors.mark);
        if(((el.closest('svg')&&el.tagName.toLowerCase()!=='svg')&&!isMark)||internal(el,selectors)||!vis(el))return;
        var r=el.getBoundingClientRect();if(!r.width||!r.height)return;
        if(!clippedWithin(el,sc)&&(r.left<cr.left-0.5||r.right>cr.right+0.5||r.top<cr.top-0.5||r.bottom>cr.bottom+0.5))out.escape.push(path(el)+' 越出 '+nm(sc));
        if(isMark||(/^(img|svg|input)$/i.test(el.tagName)&&!el.matches(selectors.layer))||el.matches(selectors.graphic))items.push({el:el,r:clipTo(el,sc,r),leaf:!el.matches(selectors.nonLeaf)});
        textNodes(el).forEach(function(t){var tr=trect(t);if(tr.width)items.push({el:el,r:clipTo(el,sc,tr),txt:t.textContent.trim().slice(0,16)});});
      });
      for(var i=0;i<items.length;i++)for(var j=i+1;j<items.length;j++){var A=items[i],B=items[j];
        if(A.el===B.el||A.el.contains(B.el)||B.el.contains(A.el))continue;
        if(inter(A.r,B.r))out.overlap.push(nm(sc)+': '+(A.txt||nm(A.el))+' × '+(B.txt||nm(B.el)));}
    });
    var cards=[].filter.call(document.querySelectorAll(selectors.card),vis);
    for(var i=0;i<cards.length;i++)for(var j=i+1;j<cards.length;j++){if(cards[i].contains(cards[j])||cards[j].contains(cards[i]))continue;
      if(inter(cards[i].getBoundingClientRect(),cards[j].getBoundingClientRect()))out.overlap.push('卡片相交 '+path(cards[i])+' × '+path(cards[j]));}
    // 8 基线与右缘：[data-bl] 同组文字基线一致；[data-redge] 文字右缘 = 所在卡片内容区右缘（卡片右缘 − 20）
    var tst=document.createElement('div');tst.style.cssText='position:absolute;left:-9999px;top:0;font:400 100px var(--gr-font);line-height:normal;white-space:nowrap';
    tst.innerHTML='<span>Hg</span><span style="display:inline-block;width:1px;height:0;vertical-align:baseline"></span>';document.body.appendChild(tst);
    var dR=(tst.firstChild.getBoundingClientRect().bottom-tst.lastChild.getBoundingClientRect().top)/100;tst.remove();
    out.baselines={};out.redges=[];
    // 精确基线：把首个文字节点临时包进 span，在其后放一个 0 高的行内块，它的顶边就是这段文字的基线
    document.querySelectorAll('[data-bl]').forEach(function(el){if(!el.getClientRects().length)return;var t=textNodes(el)[0];if(!t)return;
      var w=document.createElement('span'),pr=document.createElement('span');pr.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';
      t.parentNode.insertBefore(w,t);w.appendChild(t);w.appendChild(pr);var b=pr.getBoundingClientRect().top;
      w.parentNode.insertBefore(t,w);w.remove();var k=el.getAttribute('data-bl');(out.baselines[k]=out.baselines[k]||[]).push([el.textContent.trim().slice(0,10),Math.round(b*100)/100]);});
    document.querySelectorAll('[data-redge]').forEach(function(el){if(!el.getClientRects().length)return;var card=el.closest(selectors.card);var tn=textNodes(el);var r=tn.length?trect(tn[tn.length-1]):el.getBoundingClientRect();
      out.redges.push([el.getAttribute('data-redge'),Math.round(r.right*100)/100,Math.round((card.getBoundingClientRect().right-20)*100)/100]);});
    return out;
  }
  window.__grGeometry={run:run};
})();
