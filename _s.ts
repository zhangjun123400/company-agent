import {runHeadcount,runScheduleNotice,checkProgressDeviation} from './src/tools/version-manager';
import axios from 'axios';import fs from 'fs';import path from 'path';import FormData from 'form-data';
import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});
const T='ou_8de837db0c63b31eaebbb465c18c9ea8';
async function tk(){const r=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});return r.data.tenant_access_token}
async function up(t:string,c:string,H:any){const d=path.resolve('output');if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});const fn=t.replace(/[\\/:*?"<>|]/g,'_')+'.md';const fp=path.join(d,fn);fs.writeFileSync(fp,c,'utf8');const fd=new FormData();fd.append('file_name',fn);fd.append('parent_type','explorer');fd.append('parent_node','');fd.append('size',String(fs.statSync(fp).size));fd.append('file',fs.createReadStream(fp));const u=await axios.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all',fd,{headers:{...H,...fd.getHeaders()},maxContentLength:Infinity,maxBodyLength:Infinity});const ft=u.data.data?.file_token;if(ft){await axios.post('https://open.feishu.cn/open-apis/drive/v1/permissions/'+ft+'/members?type=file',{member_type:'openid',member_id:T,perm:'full_access'},{headers:H}).catch(()=>{});return'https://p1iscu6mj28.feishu.cn/file/'+ft}return'fallback';}
async function nt(u:string,t:string,H:any){await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:T,msg_type:'interactive',content:JSON.stringify({config:{wide_screen_mode:true},header:{title:{content:'📄 '+t,tag:'plain_text'},template:'blue'},elements:[{tag:'markdown',content:'**报告**已生成。\n\n👉 [点击查看]('+u+')'},{tag:'hr'},{tag:'note',elements:[{tag:'plain_text',content:'🤖 智小协'}]}]})},{headers:H,timeout:10000})}
(async()=>{const H={Authorization:'Bearer '+await tk()};
const h=await runHeadcount();console.log('1/3');const hu=await up('版本人力盘点报告',h,H);await nt(hu,'版本人力盘点报告',H);console.log(hu);
const s=await runScheduleNotice();console.log('2/3');const su=await up('版本排期通知',s,H);await nt(su,'版本排期通知',H);console.log(su);
const d=await checkProgressDeviation({开发:10,联调:4,提测:4,测试:6,门禁评审:1,上线:1});
if(d){console.log('3/3');const du=await up('版本进度偏离报告',d,H);await nt(du,'版本进度偏离报告',H);console.log(du)}else{console.log('3/3 无偏离')}
})().catch(e=>console.error(e.message));
