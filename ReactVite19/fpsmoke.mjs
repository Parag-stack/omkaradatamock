import { JSDOM } from 'jsdom';
import fs from 'fs';
const markup = fs.readFileSync('./src/appMarkup.html','utf8');
const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><div id="root">${markup}</div></body></html>`,{url:'http://localhost:5174/',pretendToBeVisual:true});
const {window}=dom;
global.window=window;global.document=window.document;global.location=window.location;global.history=window.history;global.localStorage=window.localStorage;global.CSS=window.CSS||{escape:s=>s};
window.scrollTo=()=>{};const raf=cb=>setTimeout(()=>cb(Date.now()),0);window.requestAnimationFrame=raf;global.requestAnimationFrame=raf;global.cancelAnimationFrame=()=>{};global.getComputedStyle=window.getComputedStyle.bind(window);
window.matchMedia=window.matchMedia||(()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}));
window.Chart=function(){return{destroy(){},update(){},resize(){}}};global.Chart=window.Chart;window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};global.IntersectionObserver=window.IntersectionObserver;
let scrolls=[];window.Element.prototype.scrollIntoView=function(){scrolls.push(this.id||'');};
const testCo={CompanyName:'Sansera Engineering Ltd.',NSESymbol:'SANSERA',BSECode:'543358',CompanyID:'214084',Sector:'Auto',Industry:'Auto Ancillary',ISIONNo:'INE'};
// build a 10-tab forensic payload (con & std differ by a marker value)
const mkCard=(lbl,val)=>({row1:[{column:lbl,bg_color:'#f0f4fb'},{column:val,bg_color:'#f0f4fb'}],row2:[],row3:[],row4:[],row5:[],header:''});
const mkAvgCard=(hdr)=>({row1:[{column:'TTM'},{column:'1%'}],row2:[{column:'Avg 3yr'},{column:'2%'}],row3:[{column:'Avg 5yr'},{column:'3%'}],row4:[{column:'Avg 10yr'},{column:'4%'}],row5:[],header:hdr});
const childTab=(name)=>({tableContent:[],TableCAGR:[],tabName:name,childTable:[
  {description:'Description',Row1:'Revenue,tip',Row2:'PAT',Row3:'',Row4:'',Row5:'',Row6:'',Row7:'',Row8:'',Row9:'',Row10:'',Row11:''},
  {description:'202403',Row1:'100',Row2:'10',Row3:'',Row4:'',Row5:'',Row6:'',Row7:'',Row8:'',Row9:'',Row10:'',Row11:''},
  {description:'3yrs',Row1:'12%,#E9F9F0',Row2:'9%',Row3:'',Row4:'',Row5:'',Row6:'',Row7:'',Row8:'',Row9:'',Row10:'',Row11:''}]});
const mkPayload=(marker)=>({status:1,response_code:200,msg:'success',button_status:{con:true,std:true},Data:[
  {tableContent:[mkCard('Latest Mcap (cr.)',marker),mkCard('Total Debt',458),mkCard('Cash',397),mkCard('EV',19640)],TableCAGR:[],childTable:[],tabName:'Snapshot'},
  {tableContent:[mkAvgCard('Gross Margin(%)'),mkAvgCard('EBIDTA Margin(%)'),mkAvgCard('PAT(%)')],TableCAGR:[],childTable:[],tabName:'Averages'},
  childTab('Earnings quality'),childTab('Fund Flow'),childTab('Working capital analysis'),childTab('Asset efficiency'),
  childTab('Capital structure'),childTab('Expense Analysis'),childTab('Du Pont Analysis'),childTab('ShareHolding Pattern  (In %)')]});
let fdCalls=[];
window.fetch=global.fetch=async(url,opts)=>{const u=String(url||'');
  if(u.includes('Forensic_DetailedTables')){let p={};try{p=JSON.parse(opts.body);}catch{} fdCalls.push(p); return{ok:true,status:200,json:async()=>mkPayload(p.type==='std'?99999:19579),text:async()=>''};}
  if(u.includes('companynote'))return{ok:true,status:200,json:async()=>({status:1,Data:[{CompanyName:'Sansera Engineering Ltd.',NSEcode:'SANSERA',BSEcode:'543358',WebSiteLink:'www.sansera.in'}]}),text:async()=>''};
  if(u.includes('SymbolMaster_WithCode'))return{ok:true,status:200,json:async()=>[testCo],text:async()=>JSON.stringify([testCo])};
  return{ok:true,status:200,json:async()=>({status:1,Data:[]}),text:async()=>'[]'};};
if(!window.document.fonts)window.document.fonts={ready:Promise.resolve()};
const click=el=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
const mod=await import('./src/legacyApp.js?'+Date.now());
mod.initLegacyApp();await new Promise(r=>setTimeout(r,80));
const d=window.document;const $=s=>d.querySelector(s);const $$=s=>[...d.querySelectorAll(s)];
const pass=(k,v)=>console.log((v?'PASS':'FAIL')+' :: '+k);
const sel=async()=>{const gs=$('#globalSearchInput');gs.value='sa';gs.dispatchEvent(new window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,450));const r=$('#globalSearchDropdown .gs-result');if(r)click(r);await new Promise(r=>setTimeout(r,200));};

// FORENSIC FLOW
click(d.querySelector('.sidebar .nav-item[data-view="forensic"]'));await new Promise(r=>setTimeout(r,20));
fdCalls=[];
await sel();
pass('#forensicPage visible', !$('#forensicPage').hidden);
const tabs=$$('#forensicPage .fp-tab');
pass('7 forensic tabs rendered', tabs.length===7);
pass('Single Page tab active', tabs[0].classList.contains('active') && tabs[0].textContent==='Single Page');
pass('other 6 tabs disabled', tabs.slice(1).every(t=>t.disabled));
pass('con fetched once by default', fdCalls.length===1 && fdCalls[0].type==='con' && fdCalls[0].CompanyId==='214084');
const secs=$$('#forensicPage .fp-section');
pass('10 table sections stacked', secs.length===10);
pass('section 0 is Snapshot', /Snapshot/.test(secs[0].querySelector('.fp-sec-title').textContent));
const chips=$$('#forensicPage .fp-chip');
pass('10 jump chips', chips.length===10);
// chips bar sits AFTER snapshot section in DOM order
const sp=$('#forensicPage .fp-singlepage');
const kids=[...sp.children];
const chipsNav=$('#forensicPage .fp-chips');
const sec0=$('#forensicPage #fp-sec-0');
pass('chips bar is after Snapshot section', kids.indexOf(chipsNav) > kids.indexOf(sec0));
// time-series table rendered for childTable tabs
pass('Earning Quality section present (renamed)', secs.some(s=>/Earning Quality/.test(s.querySelector('.fp-sec-title').textContent)));
// chip jump
scrolls=[];click(chips[3]);
pass('chip click scrolls to its section', scrolls.length===1);

// TOGGLE to Standalone -> fetch std once
fdCalls=[];
click($('#forensicPage .fp-mode[data-fpmode="std"]'));
await new Promise(r=>setTimeout(r,60));
pass('std fetched once on toggle', fdCalls.length===1 && fdCalls[0].type==='std');
pass('std active after toggle', $('#forensicPage .fp-mode[data-fpmode="std"]').classList.contains('active'));
pass('std data shown (marker 99999)', /99999/.test($('#forensicPage').textContent));
// toggle back to con -> cached, NO refetch
fdCalls=[];
click($('#forensicPage .fp-mode[data-fpmode="con"]'));
await new Promise(r=>setTimeout(r,60));
pass('con switch is instant (cached, no refetch)', fdCalls.length===0);
pass('con data shown again (19579)', /19579/.test($('#forensicPage').textContent));

// NORMAL PAGE -> forensicPage hidden
click(d.querySelector('.sidebar .nav-item[data-view="daily"]'));await new Promise(r=>setTimeout(r,20));
await sel();
pass('#forensicPage hidden on normal company page', $('#forensicPage').hidden===true);
process.exit(0);
