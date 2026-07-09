import axios from 'axios';import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});
const T='ou_8de837db0c63b31eaebbb465c18c9ea8';
(async()=>{
const t=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});
const H={Authorization:'Bearer '+t.data.tenant_access_token};
const url='https://p1iscu6mj28.feishu.cn/file/HEI6beV1boNYzlxpmoFcNNH6n4f';
await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:T,msg_type:'interactive',content:JSON.stringify({config:{wide_screen_mode:true},header:{title:{content:'🧪 HTML图表测试',tag:'plain_text'},template:'blue'},elements:[{tag:'markdown',content:'HTML+SVG base64内嵌测试\n\n👉 [点击查看]('+url+')'}]})},{headers:H});
console.log('sent');
})().catch(e=>console.error(e.message));
