const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

test('ручное обновление принудительно пересчитывает SHA при прежнем stamp',async()=>{
  const {fileContentHash,clearFileContentHashMemo}=await import('../file-content-hash.mjs');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sb-cde-hash-'));
  const file=path.join(folder,'model.ifc');
  try{
    fs.writeFileSync(file,'AAAA');
    const originalStat=fs.statSync(file);
    const first=await fileContentHash(file,originalStat);
    fs.writeFileSync(file,'BBBB');
    const memoized=await fileContentHash(file,originalStat);
    const refreshed=await fileContentHash(file,originalStat,{force:true});
    assert.equal(memoized,first);
    assert.notEqual(refreshed,first);
  }finally{
    clearFileContentHashMemo();
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
