import axios from 'axios';import fs from 'fs';import FormData from 'form-data';
import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});
const T='ou_8de837db0c63b31eaebbb465c18c9ea8';
(async()=>{
const tr=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});
const H={Authorization:'Bearer '+tr.data.tenant_access_token};
const fd=new FormData();fd.append('image_type','message');fd.append('image',fs.createReadStream('output/bar_mod_load.png'));
const ir=await axios.post('https://open.feishu.cn/open-apis/im/v1/images',fd,{headers:{...H,...fd.getHeaders()}});
const ik=ir.data.data.image_key;
const dr=await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents',{title:'AppToken图表测试'},{headers:H});
const did=dr.data.data.document.document_id;
await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents/'+did+'/blocks/'+did+'/children',{children:[{block_type:27,image:{image_key:ik,width:600,height:350}},{block_type:2,text:{elements:[{text_run:{content:'↑ charted 模块负载柱状图'}}]}}]},{headers:H});
const pr=await axios.post('https://open.feishu.cn/open-apis/drive/v1/permissions/'+did+'/members?type=docx',{member_type:'openid',member_id:T,perm:'full_access'},{headers:H,validateStatus:()=>true});
console.log('perm:',pr.data.code);
console.log('https://p1iscu6mj28.feishu.cn/docx/'+did);
})().catch(e=>console.error(e.message));
