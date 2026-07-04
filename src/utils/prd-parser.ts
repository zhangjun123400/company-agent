/**
 * PRD 文档解析工具
 * 支持从飞书项目附件下载 PRD（PDF/Word/Markdown），提取文本内容
 */
// Old deprecated code — kept for truncateText export only
// import { feishuProject } from '../feishu-project';
// import type { Attachment } from '../feishu-project';

/** 解析结果 */
export interface PrdContent {
  /** 原始文件名 */
  fileName: string;
  /** 文件类型 */
  fileType: string;
  /** 提取的文本内容 */
  text: string;
  /** 内容长度（字符数） */
  length: number;
}

/**
 * 从工作项的附件中查找并解析 PRD 文档
 * 按优先级：pdf > docx > md > txt
 */
/** Deprecated — use auto-analyzer extractPrdContent instead
export async function extractPrdFromWorkItem(
  workItemId: string
): Promise<PrdContent | null> {
  try {
    const attachments = await feishuProject.getAttachments(workItemId);

    if (!attachments || attachments.length === 0) {
      console.log(`[PRD Parser] 工作项 ${workItemId} 无附件`);
      return null;
    }

    // 按优先级排序
    const priority = ['pdf', 'docx', 'doc', 'md', 'txt'];
    const sorted = [...attachments].sort((a, b) => {
      const aExt = a.file_name.split('.').pop()?.toLowerCase() || '';
      const bExt = b.file_name.split('.').pop()?.toLowerCase() || '';
      return priority.indexOf(aExt) - priority.indexOf(bExt);
    });

    const target = sorted[0];
    console.log(`[PRD Parser] 选中附件: ${target.file_name} (${target.file_type})`);

    // 下载附件内容 (Meegle API 用 id 作为附件标识)
    const attachmentId = target.id || target.file_token || '';
    const buffer = await feishuProject.downloadAttachment(
      workItemId,
      attachmentId
    );

    // 根据文件类型提取文本
    const text = await extractText(buffer, target.file_name);

    if (!text || text.trim().length === 0) {
      console.log('[PRD Parser] 提取文本为空');
      return null;
    }

    return {
      fileName: target.file_name,
      fileType: target.file_type || target.file_name.split('.').pop() || 'unknown',
      text,
      length: text.length,
    };
  } catch (error) {
    console.error(`[PRD Parser] 解析 PRD 失败:`, error);
    return null;
  }
}
*/

/**
 * 根据文件扩展名提取文本
 */
async function extractText(buffer: Buffer, fileName: string): Promise<string> {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'pdf':
      return extractPdfText(buffer);
    case 'txt':
    case 'md':
      return buffer.toString('utf-8');
    case 'docx':
    case 'doc':
      // docx 格式较复杂，先用纯文本方式读取（含 xml 标签）
      // 实际生产环境建议使用 mammoth 或 officeparser
      return extractDocxTextSimple(buffer);
    default:
      // 尝试以 UTF-8 读取
      return buffer.toString('utf-8');
  }
}

/**
 * PDF 文本提取
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // 使用 pdf-parse 库
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    // 如果 pdf-parse 不可用，返回提示
    console.warn('[PRD Parser] pdf-parse 不可用，请安装: npm install pdf-parse');
    return buffer.toString('utf-8');
  }
}

/**
 * 简易 docx 文本提取（从 zip 中提取 document.xml 的纯文本）
 */
function extractDocxTextSimple(buffer: Buffer): string {
  try {
    // docx 本质是 zip 包
    // 使用 AdmZip 或类似库可精确提取
    // 此处给出框架代码
    console.warn('[PRD Parser] docx 解析需要 zip 解压库，返回元信息');
    return `[DOCX 文件需要解压解析，文件大小: ${buffer.length} 字节。建议安装 mammoth 库进行完整解析。]`;
  } catch {
    return '';
  }
}

/**
 * 截断文本到指定长度（用于控制给 Claude 的上下文）
 */
export function truncateText(text: string, maxChars: number = 50000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    '\n\n... [内容过长，已省略中间部分] ...\n\n' +
    text.slice(-half)
  );
}
