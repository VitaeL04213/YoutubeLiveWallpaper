'use strict';
const koffi = require('koffi');
const { execFileSync } = require('child_process');
const path = require('path');
const user32 = koffi.load('user32.dll');
const EnumWindows = user32.func('int __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)');
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, char16_t *lpString, int nMaxCount)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, char16_t *lpString, int nMaxCount)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hWnd)');
const IsIconic = user32.func('int __stdcall IsIconic(void *hWnd)');
const ShowWindow = user32.func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)');
function textof(h){const b=koffi.alloc('char16_t',512);const n=GetWindowTextW(h,b,512);return n>0?koffi.decode(b,'char16_t',512):'';}
function classof(h){const b=koffi.alloc('char16_t',256);const n=GetClassNameW(h,b,256);return n>0?koffi.decode(b,'char16_t',256):'';}
const targets=[];
const cb=koffi.register((h)=>{try{
  if(!IsWindowVisible(h)) return 1;
  const cls=classof(h), title=textof(h);
  if(cls==='Progman'||cls==='WorkerW'||cls==='Shell_TrayWnd'||cls==='Shell_SecondaryTrayWnd'||cls==='Windows.UI.Core.CoreWindow') return 1;
  if(/^Vellum/.test(title)) return 1;
  const ex=Number(GetWindowLongPtrW(h,-20))>>>0;
  if(ex & 0x80) return 1; // toolwindow
  targets.push({h, cls, title, ex});
}catch(e){} return 1;}, koffi.pointer(EnumWindowsProc));
EnumWindows(cb,0); koffi.unregister(cb);
console.log('minimizing', targets.map(t=>t.title+' ['+t.cls+']').join(' | '));
for(const t of targets){ ShowWindow(t.h, 6 /*SW_MINIMIZE*/); }
setTimeout(()=>{
  for(const t of targets) console.log('iconic?', JSON.stringify(t.title), !!IsIconic(t.h));
  try {
    const out = execFileSync(path.join(process.cwd(),'node_modules','electron','dist','electron.exe'), ['scripts/desktop-capture.js'], {cwd:process.cwd(), env:(()=>{const e={...process.env}; delete e.ELECTRON_RUN_AS_NODE; return e;})(), encoding:'utf8', timeout:60000});
    console.log(out);
  } catch(e) { console.error('capture error', e.stdout, e.stderr); }
  for(const t of targets){ ShowWindow(t.h, 9 /*SW_RESTORE*/); }
  console.log('restored');
}, 2500);
