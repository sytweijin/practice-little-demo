(function(){'use strict';function apiRaw(path,opts){opts=opts||{};opts.headers=Object.assign({'X-Presence-Profile':encodeURIComponent(profileName())},opts.headers||{});return fetch(path,opts);}function init(){
var si=document.getElementById('searchInput'),sr=document.getElementById('searchResults'),sc=document.getElementById('searchClear');
if(si){var st=null;
si.addEventListener('input',function(){clearTimeout(st);st=setTimeout(function(){var q=si.value.trim();if(!q){sr.style.display='none';if(sc)sc.style.display='none';return;}
api('/api/cards/search?q='+encodeURIComponent(q)).then(function(d){var cards=d.cards||[];
if(!cards.length){sr.innerHTML="<div style='padding:20px;text-align:center;color:var(--ink-faint)'>没找到匹配的卡片</div>";sr.style.display='block';return;}
sr.innerHTML=cards.map(function(c){var sn=(scenarios.find(function(s){return s.key===c.scene_type})||{}).name||c.scene_type;
return"<div class='search-result-item' data-id='"+c.id+"'><span class='search-result-scene scene-"+escAttr(c.scene_type)+"'>"+esc(sn)+"</span><span class='search-result-title'>"+esc(c.title)+"</span></div>";}).join('');
sr.style.display='block';
sr.querySelectorAll('.search-result-item').forEach(function(el){el.onclick=function(){var card=cards.find(function(c){return c.id==el.dataset.id});if(card){sr.style.display='none';openCardModal(card)}}})}).catch(function(){})},300)})
si.addEventListener('focus',function(){if(si.value.trim())sr.style.display='block'})
if(sc)sc.onclick=function(){si.value='';sr.style.display='none';sc.style.display='none';si.focus()}
document.addEventListener('click',function(e){if(si&&!si.contains(e.target)&&sr)sr.style.display='none'})}

var td=new Date();td.setDate(1);
var tp=document.getElementById('timelinePrev'),tn=document.getElementById('timelineNext'),tm=document.getElementById('timelineMonth'),tg=document.getElementById('timelineGrid'),tc=document.getElementById('timelineCards');
function rt(){if(!tg||!tm)return;var y=td.getFullYear(),m=td.getMonth();tm.textContent=y+'年'+(m+1)+'月';
var ms=y+'-'+String(m+1).padStart(2,'0'),mc=(typeof cards!=='undefined'?cards:[]).filter(function(c){return c.source_date&&c.source_date.indexOf(ms)===0});
var cbd={};mc.forEach(function(c){if(!cbd[c.source_date])cbd[c.source_date]=[];cbd[c.source_date].push(c)});
var fd=new Date(y,m,1).getDay(),dim=new Date(y,m+1,0).getDate();
var t=new Date(),ts=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'),h='';
'日一二三四五六'.split('').forEach(function(d){h+="<div class='timeline-weekday'>"+d+'</div>'});
for(var i=0;i<fd;i++)h+="<div class='timeline-day other-month'></div>";
for(var d=1;d<=dim;d++){var ds=ms+'-'+String(d).padStart(2,'0');h+="<div class='timeline-day"+(ds===ts?' today':'')+(cbd[ds]?' has-cards':'')+"' data-date='"+ds+"'><div class='timeline-day-num'>"+d+'</div>'+(cbd[ds]?"<div class='timeline-day-count'>"+cbd[ds].length+'张</div>':'')+'</div>'}
tg.innerHTML=h;
tg.querySelectorAll('.timeline-day[data-date]').forEach(function(el){el.onclick=function(){tg.querySelectorAll('.timeline-day.selected').forEach(function(d){d.classList.remove('selected')});el.classList.add('selected');
var dc=(typeof cards!=='undefined'?cards:[]).filter(function(c){return c.source_date===el.dataset.date&&c.status!=='deleted'});
if(!dc.length){tc.innerHTML="<div style='text-align:center;padding:30px;color:var(--ink-faint)'>"+el.dataset.date+'没有记忆卡片</div>';return}
tc.innerHTML="<h3 style='font-family:var(--serif);font-size:1.1rem;margin-bottom:16px'>"+el.dataset.date+'·'+dc.length+'张卡片</h3><div class=card-grid>'+dc.map(function(c){return cardHtml(c)}).join('')+'</div>';if(typeof bindCardEvents==='function')bindCardEvents(tc)}})}
window.rt=rt;if(tp)tp.onclick=function(){td.setMonth(td.getMonth()-1);rt();loadNarrative()};if(tn)tn.onclick=function(){td.setMonth(td.getMonth()+1);rt();loadNarrative()}

var eb=document.getElementById('exportBtn'),ib=document.getElementById('importBtn'),ii=document.getElementById('importFileInput'),mtb=document.getElementById('manageTagsBtn');
if(eb)eb.onclick=function(){eb.textContent='⏳准备中...';eb.disabled=true;(typeof api==='function'?api('/api/export?full=true',{},true):fetch('/api/export?full=true').then(function(r){return r})).then(function(r){return r.blob()}).then(function(b){var u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='presence_backup_'+new Date().toISOString().slice(0,10)+'.zip';a.click();URL.revokeObjectURL(u)
}).catch(function(e){alert('导出失败：'+e.message)}).finally(function(){eb.textContent='⬇完整备份（含素材）';eb.disabled=false})}
if(ib&&ii){ib.onclick=function(){ii.click()};ii.onchange=function(){var f=ii.files[0];if(!f)return;var isZip=/\.zip$/i.test(f.name)||f.type==='application/zip';if(isZip){var fd=new FormData();fd.append('file',f);(typeof api==='function'?api('/api/import-zip',{method:'POST',body:fd}):fetch('/api/import-zip',{method:'POST',body:fd}).then(function(r){return r.json()})).then(function(res){alert('同步完成！\n新增：'+res.imported+'张 · 更新：'+res.updated+'张 · 跳过：'+res.skipped+'张 · 素材：'+res.media_restored+'个');if(typeof refreshAll==='function')refreshAll();else{if(typeof loadCards==='function')loadCards();if(typeof loadLedger==='function')loadLedger()}}).catch(function(err){alert('导入失败：'+err.message)});ii.value='';return}var r=new FileReader();r.onload=function(e){try{var d=JSON.parse(e.target.result),cl=d.cards||[];if(!cl.length){alert('文件中没有可导入的卡片');return}
var merge=confirm('智能同步：已存在的卡片将保留更新的版本，回忆进度取较高值。\n点确定开始同步，点取消跳过。')
  if(!merge)return
(typeof api==='function'?api('/api/sync/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}):fetch('/api/sync/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()})).then(function(res){alert('同步完成！\n新增：'+res.imported+'张 · 更新：'+res.updated+'张 · 跳过：'+res.skipped+'张');if(typeof refreshAll==='function')refreshAll();else{if(typeof loadCards==='function')loadCards();if(typeof loadLedger==='function')loadLedger()}}).catch(function(err){alert('导入失败：'+err.message)})}catch(err){alert('文件格式错误，请选择有效的JSON备份文件')}};r.readAsText(f);ii.value=''}}

if(mtb)mtb.onclick=function(){api('/api/tags').then(function(d){var tags=d.tags||[];var body=document.getElementById('modalBody');
var h="<div class=modal-body><div class=modal-title>标签管理</div>";if(!tags.length){h+="<div style='text-align:center;padding:30px;color:var(--ink-faint)'>暂无标签</div>"}
else{tags.forEach(function(t){h+="<div class=tag-row><span class=tag-name>"+esc(t.name)+"</span><span class=tag-count>"+t.count+'张</span><span class=tag-actions><button class=tag-btn data-tag="'+escAttr(t.name)+'" data-action=rename>重命名</button><button class=tag-btn danger data-tag="'+escAttr(t.name)+'" data-action=delete>删除</button></span></div>'})}
h+="<div style=margin-top:16px><button class=btn-primary id=tagCloseBtn style='width:auto;padding:10px 20px;margin:0 auto;display:block;background:var(--bg-card);color:var(--ink);border:1px solid var(--line)'>关闭</button></div></div>"
body.innerHTML=h;document.getElementById('cardModal').classList.add('show')
body.querySelectorAll('.tag-btn').forEach(function(btn){btn.onclick=function(){var tag=btn.dataset.tag,action=btn.dataset.action;
if(action==='rename'){var nn=prompt('将标签「'+tag+'」重命名为：',tag);if(nn&&nn.trim()&&nn.trim()!==tag){api('/api/tags/rename',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({old:tag,new:nn.trim()})}).then(function(){if(typeof refreshAll==='function')refreshAll();else if(typeof loadCards==='function')loadCards();mtb.click()})}}
if(action==='delete'){if(confirm('确定删除标签「'+tag+'」？\n该标签将从所有卡片中移除。')){api('/api/tags/rename',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({old:tag,new:''})}).then(function(){if(typeof refreshAll==='function')refreshAll();else if(typeof loadCards==='function')loadCards();mtb.click()})}}}})
document.getElementById('tagCloseBtn').onclick=function(){closeModal()};document.getElementById('cardModal').onclick=function(e){if(e.target.id==='cardModal')closeModal()}})}

var qmt=document.getElementById('quickModeToggle'),qm=false,pmt=document.getElementById('privacyModeToggle'),pm=false,ab=document.getElementById('analyzeBtn');
if(qmt){qmt.onclick=function(){qm=!qm;qmt.classList.toggle('on',qm);qmt.querySelector('span:last-child').textContent=qm?'✅快速模式已开启':'一键记录（跳过筛选）';
var hint=document.getElementById('quickActiveHint');if(qm&&!hint){var dv=document.createElement('div');dv.className='quick-active';dv.id='quickActiveHint'
dv.innerHTML='⚡快速模式 — 一键拍摄+自动生成卡片，跳过筛选步骤';var al=document.querySelector('.capture-left');if(al)al.insertBefore(dv,al.querySelector('.capture-step'))}else if(!qm&&hint)hint.remove()}}
if(pmt){pmt.onclick=function(){pm=!pm;pmt.classList.toggle('on',pm);var hint=document.getElementById('privacyActiveHint');if(pm&&!hint){var dv2=document.createElement('div');dv2.className='privacy-active';dv2.id='privacyActiveHint';dv2.innerHTML='🔒隐私模式 — 素材只在本机处理，不调用云端 AI/ASR';var al2=document.querySelector('.capture-left');if(al2)al2.insertBefore(dv2,al2.querySelector('.capture-step'))}else if(!pm&&hint)hint.remove()}}

function shareCardAsImage(card){if(!card)return;var S=2,W=300*S,PAD=20*S,CW=W-2*PAD,cm={};cm.enterprise=['#CCFBF1','#0F766E'];cm.museum=['#FEF3C7','#B45309'];cm.meeting=['#EDE9FE','#7C3AED'];cm['class']=['#DBEAFE','#2563EB'];cm.travel=['#FCE7F3','#BE185D'];cm.custom=['#E7E5E4','#525252'];var sc=cm[card.scene_type]||cm.custom,sName=(function(){var s=scenarios.find(function(x){return x.key===card.scene_type});return s?s.name:card.scene_type})();
function mLines(ctx,t,mw,lh,mn){if(!t)return[];var r=[],cur='';for(var i=0;i<t.length;i++){var ch=t[i];if(ctx.measureText(cur+ch).width>mw&&cur){r.push(cur);cur=ch;if(r.length>=mn)break}else cur+=ch}if(cur&&r.length<mn)r.push(cur);return r}
function rr(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.arcTo(x+w,y,x+w,y+r,r);ctx.lineTo(x+w,y+h-r);ctx.arcTo(x+w,y+h,x+w-r,y+h,r);ctx.lineTo(x+r,y+h);ctx.arcTo(x,y+h,x,y+h-r,r);ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.closePath()}
function draw(img){var tmpC=document.createElement('canvas').getContext('2d'),pi=16*S,cw=CW-2*pi;tmpC.font='bold '+(17*S)+"px 'Noto Serif SC',serif";var tL=mLines(tmpC,card.title||'',cw,26*S,2);tmpC.font=(13*S)+"px 'Noto Sans SC',sans-serif";var sL=mLines(tmpC,card.summary||'',cw,20*S,4);tmpC.font='italic '+(12*S)+"px 'Noto Sans SC',sans-serif";var pL=(card.personal||'')?mLines(tmpC,card.personal,cw-2*pi,18*S,3):[],imgH=0;if(img)imgH=Math.min(cw/(img.width/Math.max(img.height,1)),170*S);var curY=PAD+(img?imgH+14*S:0)+14*S+26*S+14*S;curY+=tL.length*26*S+10*S+sL.length*20*S+12*S;if(pL.length)curY+=pL.length*18*S+22*S;if(card.tags&&card.tags.length)curY+=22*S;curY+=8*S+1*S+12*S+10*S+PAD;var H=Math.max(curY,250*S);var canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;var ctx=canvas.getContext('2d');ctx.fillStyle='#FAF8F4';ctx.fillRect(0,0,W,H);ctx.shadowColor='rgba(28,25,23,0.08)';ctx.shadowBlur=16*S;ctx.shadowOffsetY=4*S;ctx.fillStyle='#FFFFFF';rr(ctx,PAD,PAD,CW,H-2*PAD,10*S);ctx.fill();ctx.shadowColor='transparent';var cx=PAD+pi;curY=PAD+pi;if(img){var iw=cw,ih=iw/(img.width/Math.max(img.height,1));if(ih>imgH)ih=imgH;ctx.save();rr(ctx,cx,curY,iw,ih,6*S);ctx.clip();ctx.drawImage(img,cx,curY,iw,ih);ctx.restore();curY+=ih+14*S}var bw=tmpC.measureText(sName).width+16*S;ctx.fillStyle=sc[0];rr(ctx,cx,curY,bw,26*S,6*S);ctx.fill();ctx.fillStyle=sc[1];ctx.font='bold '+(11*S)+"px 'Noto Sans SC',sans-serif";ctx.textBaseline='middle';ctx.fillText(sName,cx+8*S,curY+13*S);ctx.fillStyle='#A8A29E';ctx.font=(10*S)+"px 'Noto Sans SC',sans-serif";ctx.textAlign='right';ctx.fillText(card.source_date||'',cx+cw,curY+13*S);ctx.textAlign='left';curY+=26*S+14*S;ctx.fillStyle='#1C1917';ctx.font='bold '+(17*S)+"px 'Noto Serif SC',serif";ctx.textBaseline='top';for(var t=0;t<tL.length;t++){ctx.fillText(tL[t],cx,curY);curY+=26*S}curY+=10*S;ctx.fillStyle='#57534E';ctx.font=(13*S)+"px 'Noto Sans SC',sans-serif";for(var s=0;s<sL.length;s++){ctx.fillText(sL[s],cx,curY);curY+=20*S}curY+=12*S;if(pL.length){var bh=pL.length*18*S+14*S;ctx.fillStyle='#FEF3C7';rr(ctx,cx,curY,cw,bh,5*S);ctx.fill();ctx.fillStyle='#B45309';ctx.font='italic '+(12*S)+"px 'Noto Sans SC',sans-serif";for(var p=0;p<pL.length;p++){ctx.fillText(pL[p],cx+6*S,curY+6*S);curY+=18*S}curY+=22*S}var tags=card.tags||[];if(tags.length){ctx.fillStyle='#57534E';ctx.font=(10*S)+"px 'Noto Sans SC',sans-serif";ctx.textBaseline='top';ctx.fillText(tags.join(' · '),cx,curY);curY+=22*S}curY+=8*S;ctx.fillStyle='#E7E5E4';ctx.fillRect(cx,curY,cw,1*S);curY+=12*S;ctx.fillStyle='#A8A29E';ctx.font=(10*S)+"px 'Noto Sans SC',sans-serif";ctx.textBaseline='top';ctx.fillText('在场 · AI 记忆工坊'+(card.source_date?' · '+card.source_date:''),cx,curY);var a=document.createElement('a');a.download='presence_card_'+card.id+'.png';a.href=canvas.toDataURL('image/png');a.click()}
if(card.image_url&&card.image_url.indexOf('/')===0){fetch(window.location.origin+card.image_url).then(function(r){return r.blob()}).then(function(b){var u=URL.createObjectURL(b),img=new Image();img.onload=function(){draw(img);URL.revokeObjectURL(u)};img.onerror=function(){draw(null)};img.src=u}).catch(function(){draw(null)})}else{draw(null)}}
var of=window.openCardModal;if(of){var oo=openCardModal;openCardModal=function(card){oo(card);setTimeout(function(){var body=document.getElementById('modalBody');if(!body)return;var bc=body.querySelector('.modal-body>div:last-child');if(bc){var btn=document.createElement('button');btn.className='modal-btn modal-btn-share';btn.textContent='\uD83D\uDCF7' + ' \u5206\u4EAB\u4E3A\u56FE\u7247';btn.onclick=function(){shareCardAsImage(card)};bc.appendChild(btn)}},200)}}function cn(){if(!('Notification'in window)||Notification.permission!=='granted')return;if(typeof recallQueue!=='undefined'&&recallQueue&&recallQueue.length>0&&document.hidden)new Notification('\u5728\u573A\u2014\u56DE\u5FC6\u63D0\u9192',{body:'\u4ECA\u5929\u6709 '+recallQueue.length+'\u5F20\u5361\u7247\u7B49\u5F85\u590D\u4E60',icon:'/static/assets/icon-192.png'})}
document.addEventListener('visibilitychange',function(){if(!document.hidden)cn()});var or=window.loadRecall;if(or){var ori=loadRecall;loadRecall=function(){return ori.apply(this,arguments).then(function(){cn()}).catch(function(){})}}
document.querySelectorAll('.tab').forEach(function(tab){tab.addEventListener('click',function(){if(tab.dataset.tab==='calendar')setTimeout(rt,100)})});setTimeout(function(){var at=document.querySelector('.tab.active');if(at&&at.dataset.tab==='calendar')rt()},500);var olc=window.loadCards;if(olc){var ol=loadCards;loadCards=function(){return ol.apply(this,arguments).then(function(){var at=document.querySelector('.tab.active');if(at&&at.dataset.tab==='calendar')rt()}).catch(function(){})}}
if(ab){var ac=ab.onclick;ab.onclick=function(){if(qm){var notes=document.getElementById('notesInput').value;var privacyOn=pm;if(selectedFiles.length===0&&!notes.trim()){alert('请上传至少一个素材，或输入文字备注');return}ab.disabled=true;ab.textContent=privacyOn?'⏳隐私模式记录中...':'⏳快速记录中...';var fd=new FormData();fd.append('scene_type',selectedScenario);fd.append('quick_mode','true');fd.append('privacy_mode',privacyOn?'true':'false');fd.append('personalization',document.getElementById('personalizationInput').value||'');fd.append('notes',notes);var sendFiles=selectedFiles.slice();var frameFiles=[];
var vFiles=privacyOn?[]:selectedFiles.filter(function(f){return f.type.startsWith('video/')});
var proceed=function(){for(var x=0;x<sendFiles.length;x++)fd.append('files',sendFiles[x]);for(var x=0;x<frameFiles.length;x++)fd.append('video_frames',frameFiles[x]);api('/api/analyze',{method:'POST',body:fd}).then(function(d){return Promise.all((d.cards||[]).map(function(c){return api('/api/cards/'+c.id+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})})).then(function(){alert(privacyOn?'隐私模式快速记录完成！已本地生成并自动保存'+(d.cards||[]).length+'张占位卡':'快速记录完成！已自动保存'+(d.cards||[]).length+'张卡片');selectedFiles=[];renderFileList();document.getElementById('notesInput').value='';document.getElementById('personalizationInput').value='';if(typeof refreshAll==='function'){refreshAll()}else{if(typeof loadCards==='function')loadCards();if(typeof loadLedger==='function')loadLedger();if(typeof loadRecall==='function')loadRecall();if(typeof loadGraph==='function')loadGraph()}})}).catch(function(e){alert('记录失败：'+e.message)}).finally(function(){ab.disabled=false;ab.textContent='生成记忆卡片→'})};
if(vFiles.length){Promise.all(vFiles.map(function(vf){return extractVideoFrames(vf,3)})).then(function(all){all.forEach(function(fr){frameFiles=frameFiles.concat(fr)});proceed()}).catch(function(){proceed()})}else{proceed()}}else if(ac)ac()}}
var gnBtn=document.getElementById('genNarrativeBtn'),nrEl=document.getElementById('narrativeResult');
function renderNarrative(res){
  if(!nrEl||!res){if(nrEl)nrEl.innerHTML='';return}
  var ai=res.ai_used?'<span style="font-size:11px;color:var(--amber);margin-left:8px">✨AI生成</span>':'<span style="font-size:11px;color:var(--ink-faint);margin-left:8px">占位</span>';
  nrEl.innerHTML='<div style="font-family:var(--serif);font-size:1.2rem;font-weight:600;margin-bottom:12px">'+esc(res.title)+ai+'</div><div style="white-space:pre-wrap;line-height:1.8;color:var(--ink-soft);font-size:14px">'+esc(res.body)+'</div><div style="margin-top:12px"><button class="btn-primary" id="narrDelBtn" style="width:auto;padding:6px 16px;background:var(--bg-card);color:var(--ink-faint);border:1px solid var(--line);font-size:12px">删除</button></div>';
  var db=document.getElementById('narrDelBtn');if(db)db.onclick=function(){if(!confirm('确认删除这篇回顾？删除后需要重新生成。'))return;api('/api/narratives/'+res.id,{method:'DELETE'}).then(function(){nrEl.innerHTML='';alert('已删除')})}
}
function loadNarrative(){
  if(!nrEl)return;
  var ny=td.getFullYear(),nm=td.getMonth();
  var ms=ny+'-'+String(nm+1).padStart(2,'0');
  api('/api/narratives').then(function(d){
    var found=null;
    (d.narratives||[]).forEach(function(n){
      if(n.date_start&&n.date_start.slice(0,7)===ms)found=n;
    });
    if(found)renderNarrative(found);else nrEl.innerHTML='';
  }).catch(function(){});
}
if(gnBtn){gnBtn.onclick=function(){
  var ny=td.getFullYear(),nm=td.getMonth();
  var ms=ny+'-'+String(nm+1).padStart(2,'0');
  var monthLabel=ny+'年'+(nm+1)+'月';
  if(!confirm('让 AI 将'+monthLabel+'的记忆织成一篇回顾？'))return;
  gnBtn.disabled=true;gnBtn.textContent='✨AI写作中...';
  apiRaw('/api/narrative/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date_start:ms+'-01',date_end:ms+'-31'})}).then(function(r){
  if(!r.ok){return r.json().then(function(e){throw new Error(e.detail||('错误 '+r.status))}).catch(function(){throw new Error(ms+'没有记忆卡片，试试切换到有卡片的月份')})}
  return r.json()}).then(function(res){
    if(nrEl){renderNarrative(res);if(res.used_fallback&&res.date_start){var fy=parseInt(res.date_start.slice(0,4),10),fm=parseInt(res.date_start.slice(5,7),10);td.setFullYear(fy,fm-1,1);if(typeof rt==='function')rt();loadNarrative();}}
  }).catch(function(e){alert('生成失败：'+e.message)}).finally(function(){gnBtn.disabled=false;gnBtn.textContent='✨ 生成本月回顾'})
}};

if(nrEl)loadNarrative();
}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init)}else{init()}})();
