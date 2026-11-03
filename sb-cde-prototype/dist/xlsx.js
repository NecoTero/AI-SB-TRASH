/* XLSX template reader. Browser only. ZIP: JSZip (bundled, MIT). */
window.XlsxReader={async open(file){
if(!/\.xlsx$/i.test(file.name))throw Error('Выберите файл XLSX.');
const zip=await JSZip.loadAsync(await file.arrayBuffer());
const xml=async p=>{const f=zip.file(p);if(!f)throw Error('Не удалось прочитать файл или лист.');const d=new DOMParser().parseFromString(await f.async('text'),'application/xml');if(d.querySelector('parsererror'))throw Error('Некорректная структура XLSX.');return d;};
const workbook=await xml('xl/workbook.xml'),rels=await xml('xl/_rels/workbook.xml.rels');let shared=[];
if(zip.file('xl/sharedStrings.xml'))shared=[...(await xml('xl/sharedStrings.xml')).getElementsByTagName('si')].map(n=>[...n.getElementsByTagName('t')].map(t=>t.textContent).join(''));
const custom={},dateStyles=new Set();if(zip.file('xl/styles.xml')){const styles=await xml('xl/styles.xml');for(const n of styles.getElementsByTagName('numFmt'))custom[n.getAttribute('numFmtId')]=n.getAttribute('formatCode');const xfs=styles.getElementsByTagName('cellXfs')[0];[...(xfs?.children||[])].forEach((n,i)=>{const id=Number(n.getAttribute('numFmtId'));const fmt=(custom[id]||'').replace(/"[^"]*"|\[[^\]]*\]|\\./g,'');if((id>=14&&id<=22)||(id>=27&&id<=36)||(id>=45&&id<=47)||(id>=50&&id<=58)||/[ydгд]/i.test(fmt))dateStyles.add(i);});}
const date1904=workbook.getElementsByTagName('workbookPr')[0]?.getAttribute('date1904')==='1';
const sheets=[...workbook.getElementsByTagName('sheet')].map(s=>{const id=s.getAttribute('r:id');const rel=[...rels.getElementsByTagName('Relationship')].find(n=>n.getAttribute('Id')===id);let path=rel?.getAttribute('Target')||'';path=path.startsWith('/')?path.slice(1):'xl/'+path;return {name:s.getAttribute('name'),path};});
return {names:sheets.map(s=>s.name),async sheet(index){const doc=await xml(sheets[index].path),cells={};for(const c of doc.getElementsByTagName('c')){const v=c.getElementsByTagName('v')[0]?.textContent||'';const t=c.getAttribute('t');cells[c.getAttribute('r')]={value:t==='s'?shared[Number(v)]||'':t==='inlineStr'?[...c.getElementsByTagName('t')].map(t=>t.textContent).join(''):v,type:t,style:Number(c.getAttribute('s')||0)};}
const value=a=>cells[a]?.value||'';
function date(a){const c=cells[a];if(!c||!String(c.value).trim())return null;if(c.type==='d'){const d=c.value.slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(d)&&!isNaN(Date.parse(d))?d:'INVALID';}if(c.type==='s'||c.type==='inlineStr'||!dateStyles.has(c.style)||!Number.isFinite(Number(c.value)))return 'INVALID';const n=Number(c.value);if(n<=0||n>2958465)return 'INVALID';return new Date(Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:30)+Math.floor(n)*86400000).toISOString().slice(0,10);}
let last=3;const cols=['B','K','R','S','T','U','AI','AJ'];for(const a in cells){const m=a.match(/^([A-Z]+)(\d+)$/);if(m&&cols.includes(m[1])&&String(value(a)).trim())last=Math.max(last,Number(m[2]));}
if(last>100000)throw Error('Для локального макета используйте лист до 100 000 строк.');
const rows=[];for(let r=4;r<=last;r++){const raw={name:value('B'+r),kfo:value('K'+r),corpus:value('AI'+r),floor:value('AJ'+r),ps:value('R'+r),pf:value('S'+r),fs:value('T'+r),ff:value('U'+r)};if(Object.values(raw).every(v=>!String(v).trim()))continue;rows.push({row:r,name:raw.name,kfo:raw.kfo,corpus:raw.corpus,floor:raw.floor,ps:date('R'+r),pf:date('S'+r),fs:date('T'+r),ff:date('U'+r),rawDates:{ps:raw.ps,pf:raw.pf,fs:raw.fs,ff:raw.ff}});}
const d=date('B1');return {rows,date:d==='INVALID'?null:d};}};
}};
