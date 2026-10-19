/**
 * cindy_feishu_bot 出站选哪条飞书连接。
 *
 * 顺序:
 *   1. 本轮飞书逐轮作用域(由飞书入站消息触发的轮次);
 *   2. 会话所属伙伴自己的飞书连接(伙伴主任务的后台任务回执 / 心跳 / 桌面输入轮次);
 *   3. 设置页那份个人 bot(hook 会话、桌面任务的「飞书通知我」)。
 *
 * 第 2 步不能省: 伙伴主任务不带专线的 `feishuChatId`, 个人 bot 移交给伙伴后那份又被清空,
 * 少了这一步就会拿设置页的空 owner 去出站, 误报 NO_CHAT_CONTEXT。
 */
export function selectFeishuTransport<T>(
  input: {
    turnScopeIm: T | null;
    companionBotId: string | null;
    companionIm: T | null;
    personalIm: T;
  },
): T {
  if (input.turnScopeIm) return input.turnScopeIm;
  if (input.companionBotId && input.companionIm) return input.companionIm;
  return input.personalIm;
}
