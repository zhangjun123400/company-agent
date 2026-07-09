import {runHeadcount,publishAsHtml} from './src/tools/version-manager';
import axios from 'axios';import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});
(async()=>{
const h=await runHeadcount();const u=await publishAsHtml('版本管理周报',h);
const t=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});
await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:'ou_8de837db0c63b31eaebbb465c18c9ea8',msg_type:'interactive',content:JSON.stringify({config:{wide_screen_mode:true},header:{title:{content:'📊 周报 v3.1',tag:'plain_text'},template:'blue'},elements:[{tag:'markdown',content:'甘特图放大+CSS时间线\n👉 [查看]('+u+')'}]})},{headers:{Authorization:'Bearer '+t.data.tenant_access_token}});
console.log(u);
})().catch(e=>console.error(e.message));
