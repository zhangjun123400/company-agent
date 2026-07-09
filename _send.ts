import {runHeadcount,runScheduleNotice,checkProgressDeviation} from './src/tools/version-manager';
import axios from 'axios';import fs from 'fs';import path from 'path';import FormData from 'form-data';
import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});
const T='ou_8de837db0c63b31eaebbb465c18c9ea8';
async function tk(){const r=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});return r.data.tenant_access_token}

async function uploadFile(fp:string,H:any):Promise<string>{
  try{const fd=new FormData();fd.append('file_name',path.basename(fp));fd.append('parent_type','explorer');fd.append('parent_node','');fd.append('size',String(fs.statSync(fp).size));fd.append('file',fs.createReadStream(fp));
    const u=await axios.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all',fd,{headers:{...H,...fd.getHeaders()},maxContentLength:Infinity,maxBodyLength:Infinity});
    const ft=u.data.data?.file_token;
    if(ft){await axios.post('https://open.feishu.cn/open-apis/drive/v1/permissions/'+ft+'/members?type=file',{member_type:'openid',member_id:T,perm:'full_access'},{headers:H}).catch(()=>{});return'https://p1iscu6mj28.feishu.cn/file/'+ft}
  }catch(e){}
  const cr=await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents',{title:path.basename(fp)},{headers:H});
  const did=cr.data.data.document.document_id;
  await axios.post('https://open.feishu.cn/open-apis/drive/v1/permissions/'+did+'/members?type=docx',{member_type:'openid',member_id:T,perm:'full_access'},{headers:H}).catch(()=>{});
  return'https://p1iscu6mj28.feishu.cn/docx/'+did
}

async function uploadMD(title:string,content:string,H:any):Promise<string>{
  const d=path.resolve('output');if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});
  const fn=title.replace(/[\\/:*?"<>|]/g,'_')+'.md';const fp=path.join(d,fn);fs.writeFileSync(fp,content,'utf8');
  return uploadFile(fp,H);
}

async function notifyCard(url:string,title:string,H:any){await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:T,msg_type:'interactive',content:JSON.stringify({config:{wide_screen_mode:true},header:{title:{content:'📄 '+title,tag:'plain_text'},template:'blue'},elements:[{tag:'markdown',content:'**版本管理报告**已生成。\n\n👉 [点击查看]('+url+')'},{tag:'hr'},{tag:'note',elements:[{tag:'plain_text',content:'🤖 智小协自动生成'}]}]})},{headers:H,timeout:10000})}

(async()=>{
const H={Authorization:'Bearer '+await tk()};
console.log('1/3 人力盘点...');
const h=await runHeadcount();
const hu=await uploadMD('版本人力盘点报告',h,H);
// 上传图表SVG
const charts=[];
for(const f of fs.readdirSync('output')){if(f.startsWith('bar_')&&f.endsWith('.svg'))charts.push(path.join('output',f));}
for(const cf of charts){const cu=await uploadFile(cf,H);console.log('  chart:',cu);}
await notifyCard(hu,'版本人力盘点报告',H);console.log('1/3',hu);

console.log('2/3 排期通知...');
const s=await runScheduleNotice();
const su=await uploadMD('版本排期通知',s,H);
await notifyCard(su,'版本排期通知',H);console.log('2/3',su);

console.log('3/3...');
const d=await checkProgressDeviation({开发:10,联调:4,提测:4,测试:6,门禁评审:1,上线:1});
if(d){const du=await uploadMD('版本进度偏离报告',d,H);await notifyCard(du,'版本进度偏离报告',H);console.log('3/3',du)}else{console.log('3/3 无偏离')}
console.log('done');
})().catch(e=>{console.error(e.message)});
