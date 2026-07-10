import {runHeadcount,runScheduleNotice,checkProgressDeviation,publishAsHtml} from './src/tools/version-manager';
import axios from 'axios';import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});const T='ou_8de837db0c63b31eaebbb465c18c9ea8';
async function nt(u:string,t:string){const tr=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:T,msg_type:'interactive',content:JSON.stringify({config:{wide_screen_mode:true},header:{title:{content:'📄 '+t,tag:'plain_text'},template:'blue'},elements:[{tag:'markdown',content:'👉 [点击查看]('+u+')'}]})},{headers:{Authorization:'Bearer '+tr.data.tenant_access_token}});}
(async()=>{
const h=await runHeadcount();await nt(await publishAsHtml('版本管理周报',h),'版本管理周报');
const s=await runScheduleNotice();await nt(await publishAsHtml('版本排期通知',s),'版本排期通知');
const d=await checkProgressDeviation({开发:10,联调:4,提测:4,测试:6,门禁评审:1,上线:1});
if(d)await nt(await publishAsHtml('版本进度偏离报告',d),'版本进度偏离报告');
console.log('done');
})().catch(e=>console.error(e.message));
