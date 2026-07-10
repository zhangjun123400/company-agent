import axios from 'axios';import fs from 'fs';import path from 'path';
import dotenv from 'dotenv';dotenv.config({path:'config/config.env'});

async function run() {
  // 1. Load NUDD skill prompt
  const skill = fs.readFileSync(path.resolve('agents/NUDD风险分析/SKILL.md'),'utf-8').split('---').slice(2).join('---').trim();

  // 2. Call AI
  console.log('=== 调用 AI 分析...');
  const aiR = await axios.post(`https://api.deepseek.com/v1/chat/completions`,{
    model:'deepseek-v4-pro',max_tokens:4000,temperature:0.3,
    messages:[
      {role:'system',content:skill},
      {role:'user',content:`PRD: 萝卜蹲游戏——基于视觉识别用户下蹲动作，结合语音交互实现多人在线竞技。
技术可行性结论: 整体可行。运控模块需多传感器融合保证实时性，软件中台需优化调度算法支持10人并发。
风险点: 视觉算法在弱光环境精度不足、语音识别在嘈杂环境准确率下降、多人并发时服务器延迟。
模块: 运控、软件中台、语音交互、视觉识别、服务端。`}
    ]},{headers:{Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`,'Content-Type':'application/json'},timeout:120000});
  const raw = aiR.data.choices[0].message.content;
  console.log('AI输出长度:',raw.length,'前300字:',raw.substring(0,300));

  // 3. Parse JSON
  const json = raw.replace(/```json|```/g,'').replace(/^[^{[]*/,'').trim();
  console.log('\n=== JSON 解析...');
  const items = JSON.parse(json);
  console.log('解析成功, 风险项数:',items.length);
  console.log('第1项:',JSON.stringify(items[0]).substring(0,200));

  if(!Array.isArray(items)||items.length===0){console.log('空数组, 退出');return;}

  // 4. Create spreadsheet (v3)
  console.log('\n=== 创建飞书电子表格...');
  const t=await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET});
  const H={Authorization:'Bearer '+t.data.tenant_access_token,'Content-Type':'application/json'};
  const ssR=await axios.post('https://open.feishu.cn/open-apis/sheets/v3/spreadsheets',{title:'萝卜蹲游戏 · NUDD风险登记表'},{headers:H});
  const ssToken=ssR.data.data?.spreadsheet?.spreadsheet_token;
  console.log('表格token:',ssToken);

  // 5. Get sheetId (v2 metainfo)
  const metaR=await axios.get('https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/'+ssToken+'/metainfo',{headers:H});
  const sheetId:string=metaR.data.data?.sheets?.[0]?.sheetId||'0';
  console.log('sheetId:',sheetId);

  // 6. Write data (v2)
  const headers=['编号','模块','风险项描述','N','U','D(难)','D(异)','总分','等级','影响面','应对方案','解决时间','责任人','状态','备注'];
  const rows=[headers,...items.map((r:any)=>headers.map(h=>String(r[h]||'')))];
  const wr=await axios.put('https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/'+ssToken+'/values',{valueRange:{range:sheetId+'!A1:O'+rows.length,values:rows}},{headers:H});
  console.log('写入:',wr.data.code,wr.data.msg||'成功');

  // 7. Grant
  await axios.post('https://open.feishu.cn/open-apis/drive/v1/permissions/'+ssToken+'/members?type=sheet',{member_type:'openid',member_id:'ou_8de837db0c63b31eaebbb465c18c9ea8',perm:'full_access'},{headers:H}).catch(()=>{});
  console.log('\n✅ https://p1iscu6mj28.feishu.cn/sheets/'+ssToken);
}
run().catch(e=>console.error('失败:',e.response?.data||e.message));
